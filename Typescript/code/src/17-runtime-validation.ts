/**
 * ============================================================
 * 第 17 课：从 unknown 建立可审计的运行时证据
 * ============================================================
 *
 * 运行：npm run lesson:validation
 *
 * 本课使用 `17-schema.ts` 的透明实现验证成熟 schema 库背后的关键机制：
 *
 * - 静态类型由 Schema 值推导，而不是再维护一份可能漂移的 interface；
 * - 对象字段用 Object.hasOwn 判定，原型链属性不能冒充输入；
 * - strict/strip/passthrough 是安全策略，不只是序列化偏好；
 * - optional 表示键可以缺失，与“键存在且值为 undefined”不同；
 * - refine/transform 能建立领域不变量，但 JSON Schema 描述的仍是 wire input；
 * - 错误路径使用 JSON Pointer，且不把完整外部值泄漏进日志；
 * - Agent 的模型侧 JSON Schema 不能替代服务端再次校验。
 */

import assert from 'node:assert/strict';
import {
  ValidationError,
  array,
  type Infer,
  literal,
  number,
  object,
  optional,
  parse,
  refine,
  type Result,
  string,
  transform,
  union,
  type ValidationIssue,
} from './17-schema.js';

function parseJson(text: string): Result<unknown, SyntaxError> {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (cause: unknown) {
    return {
      ok: false,
      error: cause instanceof SyntaxError
        ? cause
        : new SyntaxError('JSON parser 抛出了非 SyntaxError', { cause }),
    };
  }
}

declare const toolCallIdBrand: unique symbol;
type ToolCallId = string & { readonly [toolCallIdBrand]: true };

const toolCallIdSchema = refine(
  string({ minLength: 6, description: '模型生成的 tool call id' }),
  (value): value is ToolCallId => /^call_[a-z0-9]+$/u.test(value),
  'tool call id 必须匹配 call_[a-z0-9]+',
);

const trimmedNonEmpty = refine(
  transform(string(), (value) => value.trim()),
  (value) => value.length > 0,
  '去除空白后不能为空',
);

const toolCallSchema = object(
  {
    id: toolCallIdSchema,
    type: literal('function'),
    function: object(
      {
        name: trimmedNonEmpty,
        arguments: string({ description: 'JSON 编码的工具参数' }),
      },
      { unknownKeys: 'strict' },
    ),
    scores: optional(array(number({ minimum: 0, maximum: 1 }))),
    source: optional(union(literal('model'), literal('replay'))),
  },
  {
    unknownKeys: 'strict',
    description: '模型返回的工具调用 envelope',
  },
);

type ToolCall = Infer<typeof toolCallSchema>;

function parseToolCall(
  text: string,
): Result<ToolCall, SyntaxError | readonly ValidationIssue[]> {
  const json = parseJson(text);
  return json.ok ? toolCallSchema.safeParse(json.value) : json;
}

// ------------------------------------------------------------
// 1. 成功值经过 transform/refine，获得品牌和规范化字段
// ------------------------------------------------------------

const good = parseToolCall(JSON.stringify({
  id: 'call_a1b2',
  type: 'function',
  function: {
    name: '  search_docs  ',
    arguments: '{"query":"TypeScript"}',
  },
  scores: [0.98, 0.76],
}));

assert.equal(good.ok, true);
if (!good.ok) throw new Error('good fixture 应解析成功');

assert.equal(good.value.id, 'call_a1b2');
assert.equal(good.value.function.name, 'search_docs');
assert.deepEqual(good.value.scores, [0.98, 0.76]);
assert.equal(Object.hasOwn(good.value, 'source'), false);

const brandedId: ToolCallId = good.value.id;
assert.equal(brandedId, 'call_a1b2');

if (false) {
  // @ts-expect-error 未验证的普通 string 不能伪装成 ToolCallId。
  const unsafeId: ToolCallId = 'call_raw';

  // @ts-expect-error exact optional 语义下，缺失与显式 undefined 不等价。
  const wrongOptional: ToolCall = { ...good.value, source: undefined };

  console.log(unsafeId, wrongOptional);
}

// ------------------------------------------------------------
// 2. 一次解析累计所有独立错误，并输出精确路径
// ------------------------------------------------------------

const bad = parseToolCall(JSON.stringify({
  id: 'not-an-id',
  type: 'tool',
  function: {
    name: '   ',
    arguments: {},
    privileged: true,
  },
  scores: [1.2, 'high'],
  isAdmin: true,
}));

assert.equal(bad.ok, false);
if (bad.ok || bad.error instanceof SyntaxError) {
  throw new Error('bad fixture 应产生结构化 ValidationIssue');
}

const badPointers = new Set(bad.error.map((issue) => issue.pointer));
assert.deepEqual(badPointers, new Set([
  '/id',
  '/type',
  '/function/name',
  '/function/arguments',
  '/function/privileged',
  '/scores/0',
  '/scores/1',
  '/isAdmin',
]));
assert.ok(bad.error.every((issue) => !('actual' in issue)));

// ------------------------------------------------------------
// 3. 必填判断只看 own property，不能从原型链“借”字段
// ------------------------------------------------------------

const inheritedInput = Object.create({ id: 'call_inherited' }) as Record<
  string,
  unknown
>;
inheritedInput['type'] = 'function';
inheritedInput['function'] = { name: 'search', arguments: '{}' };

const inheritedResult = toolCallSchema.safeParse(inheritedInput);
assert.equal(inheritedResult.ok, false);
if (!inheritedResult.ok) {
  assert.ok(inheritedResult.error.some(
    (issue) => issue.code === 'missing_key' && issue.pointer === '/id',
  ));
}

// ------------------------------------------------------------
// 4. strict 与 strip 是不同的信任策略
// ------------------------------------------------------------

const publicRequestShape = {
  query: string({ minLength: 1 }),
  limit: optional(number({ integer: true, minimum: 1, maximum: 100 })),
} as const;

const strictRequest = object(publicRequestShape, { unknownKeys: 'strict' });
const stripRequest = object(publicRequestShape, { unknownKeys: 'strip' });
const untrustedRequest: unknown = {
  query: 'typescript',
  limit: 10,
  isAdmin: true,
};

const strictResult = strictRequest.safeParse(untrustedRequest);
assert.equal(strictResult.ok, false);

const stripped = parse(stripRequest, untrustedRequest);
assert.deepEqual(stripped, { query: 'typescript', limit: 10 });
assert.equal('isAdmin' in stripped, false);

// 对象输出通过 defineProperty 写入；即使 JSON 出现 __proto__，也不会触发 setter。
const pollutionAttempt = strictRequest.safeParse(
  JSON.parse('{"query":"safe","__proto__":{"polluted":true}}') as unknown,
);
assert.equal(pollutionAttempt.ok, false);
assert.equal(Reflect.get(Object.prototype, 'polluted'), undefined);

// Schema 构造参数本身也是运行时配置，不能假设调用者永远传合法范围。
assert.throws(() => number({ minimum: 10, maximum: 1 }), /minimum 不能大于/u);
assert.throws(
  () => string({ pattern: /secret/iu }),
  /不编码 RegExp flags/u,
);

// ------------------------------------------------------------
// 5. JSON Schema 是输入协议投影，不等于 Output 类型
// ------------------------------------------------------------

const modelSchema = toolCallSchema.jsonSchema;
assert.equal(modelSchema.type, 'object');
assert.equal(modelSchema.additionalProperties, false);
assert.deepEqual(modelSchema.required, ['id', 'type', 'function']);
assert.deepEqual(modelSchema.properties?.['source']?.anyOf, [
  { enum: ['model'] },
  { enum: ['replay'] },
]);

// JSON Schema 看不到 ToolCallId 的 unique-symbol brand，也看不到 trim transform；
// 服务端 safeParse 才是最终权威，模型 schema 只是提高生成正确率和互操作性。

assert.throws(
  () => parse(strictRequest, { query: '', extra: true }),
  (error: unknown) => {
    assert.ok(error instanceof ValidationError);
    assert.deepEqual(
      new Set(error.issues.map((issue) => issue.pointer)),
      new Set(['/query', '/extra']),
    );
    return true;
  },
);

console.log('=== 第 17 课：Schema 三层契约 ===');
console.log({
  parsedTool: good.value,
  badIssueCount: bad.error.length,
  badPointers: [...badPointers],
  stripped,
  modelRequired: modelSchema.required,
});
