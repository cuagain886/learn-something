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

// parseJson：把 JSON.parse 的“抛异常”接口封装成 Result 风格的“返回值”接口。
// 这样上层 safeParse 链条可以统一处理“JSON 语法错误”和“Schema 校验错误”，不必再 try/catch。
function parseJson(text: string): Result<unknown, SyntaxError> {
  try {
    // JSON.parse 返回 unknown：TS 不会替我们承诺它真的是某种结构，必须再走 Schema。
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (cause: unknown) {
    // cause 可能是任何东西；不是 SyntaxError 时也包装成 SyntaxError，并保留原始 cause 便于排查。
    return {
      ok: false,
      error: cause instanceof SyntaxError
        ? cause
        : new SyntaxError('JSON parser 抛出了非 SyntaxError', { cause }),
    };
  }
}

// 品牌类型 ToolCallId：结构上仍是 string，但带一个 unique symbol 标记，
// 编译期就能阻止“普通 string 冒充已通过校验的 tool call id”。
declare const toolCallIdBrand: unique symbol;
type ToolCallId = string & { readonly [toolCallIdBrand]: true };

// toolCallIdSchema：先用 string() 表达“长度与 description”这类 JSON Schema 能写出的约束，
// 再用 refine 叠加一个“必须匹配 call_[a-z0-9]+”的领域不变量；
// 通过 type predicate 把推断出的 Output 收窄为 ToolCallId 品牌，使静态类型也带上证据。
const toolCallIdSchema = refine(
  string({ minLength: 6, description: '模型生成的 tool call id' }),
  (value): value is ToolCallId => /^call_[a-z0-9]+$/u.test(value),
  'tool call id 必须匹配 call_[a-z0-9]+',
);

// trimmedNonEmpty：transform 先把字符串 trim 成规范化值，再用 refine 校验“非空”。
// 两步组合后，业务侧拿到的字段已 trim 且非空，但 JSON Schema 看不到这层加工。
const trimmedNonEmpty = refine(
  transform(string(), (value) => value.trim()),
  (value) => value.length > 0,
  '去除空白后不能为空',
);

// toolCallSchema：模型返回的 tool call 信封结构。组合多种 schema 构造子：
//   - id：带品牌的 toolCallIdSchema；
//   - type：literal('function')，只接受这一个字面量；
//   - function：嵌套 object，name 先 trim 再校验，arguments 保留为字符串；
//   - unknownKeys: 'strict'：未知字段直接判错（白名单策略）。
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
    // optional：该 key 可以缺失；若存在则继续走内层 schema 校验。
    scores: optional(array(number({ minimum: 0, maximum: 1 }))),
    // union + literal：取值只能是 'model' 或 'replay' 之一。投影到 JSON Schema 会变成 anyOf + enum。
    source: optional(union(literal('model'), literal('replay'))),
  },
  {
    unknownKeys: 'strict',
    description: '模型返回的工具调用 envelope',
  },
);

// ToolCall：从 Schema 反向推断出的静态类型，无需手写 interface，避免与 Schema 实现漂移。
type ToolCall = Infer<typeof toolCallSchema>;

// parseToolCall：把 parseJson + safeParse 串成一个上层入口。
// 返回 Result 风格，错误可能是 SyntaxError（JSON 语法层）或 ValidationIssue[]（结构层）。
function parseToolCall(
  text: string,
): Result<ToolCall, SyntaxError | readonly ValidationIssue[]> {
  const json = parseJson(text);
  // JSON 解析失败直接透传；成功才进入 Schema 校验。
  return json.ok ? toolCallSchema.safeParse(json.value) : json;
}

// ------------------------------------------------------------
// 1. 成功值经过 transform/refine，获得品牌和规范化字段
// ------------------------------------------------------------

// good：构造一个合法的 tool call 输入，name 故意带前后空白以验证 trim 生效。
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
// 把 Result 收窄为成功分支，便于后续直接读取 .value。
if (!good.ok) throw new Error('good fixture 应解析成功');

assert.equal(good.value.id, 'call_a1b2');
// function.name 经过 transform trim，输出已是规范化值。
assert.equal(good.value.function.name, 'search_docs');
assert.deepEqual(good.value.scores, [0.98, 0.76]);
// optional 字段缺失时不会出现在输出对象上（exact optional 语义，不是 source: undefined）。
assert.equal(Object.hasOwn(good.value, 'source'), false);

// 因为 refine 的 type predicate 把 Output 收窄成了 ToolCallId，
// 这里可以直接赋给 ToolCallId 类型变量，无需断言。
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

// bad：在每个字段上都塞入不同类型的错误，验证 schema 能一次解析收集全部问题并定位到精确路径。
const bad = parseToolCall(JSON.stringify({
  id: 'not-an-id',     // 不匹配 call_ 前缀
  type: 'tool',        // 不是 'function' 字面量
  function: {
    name: '   ',       // trim 后为空字符串
    arguments: {},     // 不是字符串
    privileged: true,  // strict 模式下的未知字段
  },
  scores: [1.2, 'high'],  // 第 0 个超出 [0,1] 上界，第 1 个类型错误
  isAdmin: true,           // 顶层未知字段
}));

assert.equal(bad.ok, false);
// 区分两种错误来源：JSON SyntaxError vs 结构化 ValidationIssue[]。
if (bad.ok || bad.error instanceof SyntaxError) {
  throw new Error('bad fixture 应产生结构化 ValidationIssue');
}

// 用 Set 比较实际错误指针集合，验证 schema 把每个问题都定位到了正确路径。
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
// 安全策略：issue 不携带原始 value，只有 received 这种类型摘要，避免把可能含 secret 的外部值塞进日志。
assert.ok(bad.error.every((issue) => !('actual' in issue)));

// ------------------------------------------------------------
// 3. 必填判断只看 own property，不能从原型链“借”字段
// ------------------------------------------------------------

// inheritedInput：用 Object.create 制造一个“原型链上有 id、自身没有 id”的对象，
// 用来验证 schema 是否只承认 own property，防止原型链冒充必填字段。
const inheritedInput = Object.create({ id: 'call_inherited' }) as Record<
  string,
  unknown
>;
inheritedInput['type'] = 'function';
inheritedInput['function'] = { name: 'search', arguments: '{}' };

const inheritedResult = toolCallSchema.safeParse(inheritedInput);
// 因为 id 不在自身属性上，必填校验应失败。
assert.equal(inheritedResult.ok, false);
if (!inheritedResult.ok) {
  // 确认失败原因是 missing_key，且指针指向 /id。
  assert.ok(inheritedResult.error.some(
    (issue) => issue.code === 'missing_key' && issue.pointer === '/id',
  ));
}

// ------------------------------------------------------------
// 4. strict 与 strip 是不同的信任策略
// ------------------------------------------------------------

// publicRequestShape：一个最小可复用的对象形状，后面用来对比 strict 与 strip 的差异。
const publicRequestShape = {
  query: string({ minLength: 1 }),
  limit: optional(number({ integer: true, minimum: 1, maximum: 100 })),
} as const;

// 两个 schema 共用同一个 shape，差异仅在 unknownKeys：
//   strict → 出现未知字段直接报错（白名单，最严格）；
//   strip  → 静默丢弃未知字段，只返回 schema 中声明过的部分。
const strictRequest = object(publicRequestShape, { unknownKeys: 'strict' });
const stripRequest = object(publicRequestShape, { unknownKeys: 'strip' });
// untrustedRequest：模拟外部不可信输入，多出一个不该出现的 isAdmin 字段。
const untrustedRequest: unknown = {
  query: 'typescript',
  limit: 10,
  isAdmin: true,
};

const strictResult = strictRequest.safeParse(untrustedRequest);
// strict 策略：遇到未知字段 isAdmin 直接失败。
assert.equal(strictResult.ok, false);

// strip 策略：parse 成功，isAdmin 被丢弃，不会出现在输出里。
const stripped = parse(stripRequest, untrustedRequest);
assert.deepEqual(stripped, { query: 'typescript', limit: 10 });
assert.equal('isAdmin' in stripped, false);

// 对象输出通过 defineProperty 写入；即使 JSON 出现 __proto__，也不会触发 setter。
// 原型污染测试：故意构造带 __proto__ 的 JSON，验证 schema 不会让它污染原型链。
const pollutionAttempt = strictRequest.safeParse(
  JSON.parse('{"query":"safe","__proto__":{"polluted":true}}') as unknown,
);
// strict 模式下 __proto__ 被当成未知字段，校验失败。
assert.equal(pollutionAttempt.ok, false);
// 关键断言：Object.prototype 上不会出现 polluted，证明 defineProperty 没触发 setter。
assert.equal(Reflect.get(Object.prototype, 'polluted'), undefined);

// Schema 构造参数本身也是运行时配置，不能假设调用者永远传合法范围。
// 这里验证 minimum > maximum 会在构造期直接抛错，而不是等 safeParse 才暴露。
assert.throws(() => number({ minimum: 10, maximum: 1 }), /minimum 不能大于/u);
// JSON Schema 子集不编码 RegExp flags，构造期就拒绝带 flags 的 pattern。
assert.throws(
  () => string({ pattern: /secret/iu }),
  /不编码 RegExp flags/u,
);

// ------------------------------------------------------------
// 5. JSON Schema 是输入协议投影，不等于 Output 类型
// ------------------------------------------------------------

// modelSchema：toolCallSchema 的 JSON Schema 投影，用来给模型/HTTP 边界描述“接受什么输入”。
// 它描述的是 wire input，看不到 transform/refine 把 Output 加工成了什么。
const modelSchema = toolCallSchema.jsonSchema;
assert.equal(modelSchema.type, 'object');
// additionalProperties=false 是 strict 策略在 JSON Schema 上的投影。
assert.equal(modelSchema.additionalProperties, false);
// required 只列出必填字段；optional 字段不会出现在这里。
assert.deepEqual(modelSchema.required, ['id', 'type', 'function']);
// optional + union 的投影：用 anyOf 罗列每个分支，每个分支用 enum 表达字面量候选。
assert.deepEqual(modelSchema.properties?.['source']?.anyOf, [
  { enum: ['model'] },
  { enum: ['replay'] },
]);

// JSON Schema 看不到 ToolCallId 的 unique-symbol brand，也看不到 trim transform；
// 服务端 safeParse 才是最终权威，模型 schema 只是提高生成正确率和互操作性。

// parse 是 safeParse 的 throw 版本：失败时抛 ValidationError，便于在“需要 throw”的调用栈里使用。
// 这里验证错误抛出后，issues 里仍然带精确 pointer，可以同时报告多个问题。
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
