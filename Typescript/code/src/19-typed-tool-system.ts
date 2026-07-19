/**
 * ============================================================
 * 第 19 课：Agent 工具系统的静态/动态双入口
 * ============================================================
 *
 * 运行：npm run lesson:tools
 *
 * LLM 返回的 name 和 arguments 都是动态数据，不能调用一个只接受 keyof 注册表的
 * “伪动态 API”。本课把工具系统拆成两条明确路径：
 *
 * - invokeKnown：内部可信 TypeScript 调用，name 决定 input/output；
 * - invokeUnknown：模型/网络调用，接受 string + unknown，运行时查找并验证；
 *
 * 两条路径共享授权、取消与执行错误语义；动态路径额外经过第 17 课 Schema。
 * 工具定义还生成模型可见 manifest，使静态输入、服务端 validator 与 JSON Schema
 * 来自同一个 Schema 值。
 */

import assert from 'node:assert/strict';
import {
  array,
  type Infer,
  type JsonSchema,
  literal,
  number,
  object,
  optional,
  type Result,
  type Schema,
  string,
  type ValidationIssue,
} from './17-schema.js';

type ToolError =
  | {
      readonly code: 'INVALID_ARGUMENTS';
      readonly issues: readonly ValidationIssue[];
    }
  | {
      readonly code: 'NOT_FOUND';
      readonly toolName: string;
    }
  | {
      readonly code: 'FORBIDDEN';
      readonly toolName: string;
      readonly requiredPermission: string;
    }
  | {
      readonly code: 'CANCELLED';
      readonly reason: unknown;
    }
  | {
      readonly code: 'EXECUTION_FAILED';
      readonly cause: unknown;
    };

interface ToolContext {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly grantedPermissions: ReadonlySet<string>;
}

interface ToolManifest {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly requiredPermission?: string;
}

interface ToolDefinition<Name extends string, Input, Output> {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: Schema<Input>;
  readonly requiredPermission?: string;

  invokeRaw(
    raw: unknown,
    context: ToolContext,
  ): Promise<Result<Output, ToolError>>;

  // method syntax 的参数在 TS 中保持双变兼容，便于异构工具进入同一个只读容器；
  // 注册表绝不会通过擦除后的 AnyTool 调用它，而会先恢复 name 对应的具体 Tool 类型。
  invokeParsed(
    input: Input,
    context: ToolContext,
  ): Promise<Result<Output, ToolError>>;

  readonly __types?: {
    readonly input: Input;
    readonly output: Output;
  };
}

type AnyTool = ToolDefinition<string, unknown, unknown>;
type ToolName<Tools extends readonly AnyTool[]> = Tools[number]['name'];
type ToolByName<
  Tools extends readonly AnyTool[],
  Name extends ToolName<Tools>,
> = Extract<Tools[number], { readonly name: Name }>;
type ToolInput<Tool extends AnyTool> = NonNullable<Tool['__types']>['input'];
type ToolOutput<Tool extends AnyTool> = NonNullable<Tool['__types']>['output'];

type ToolSuccess<Tool extends AnyTool> =
  Tool extends ToolDefinition<infer Name, unknown, infer Output>
    ? {
        readonly ok: true;
        readonly toolName: Name;
        readonly value: Output;
      }
    : never;

type DynamicToolResult<Tools extends readonly AnyTool[]> =
  | ToolSuccess<Tools[number]>
  | {
      readonly ok: false;
      readonly toolName: string;
      readonly error: ToolError;
    };

function cancelled(signal: AbortSignal): ToolError {
  return { code: 'CANCELLED', reason: signal.reason };
}

function defineTool<
  const Name extends string,
  Input,
  Output,
>(definition: {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: Schema<Input>;
  readonly requiredPermission?: string;
  readonly execute: (
    input: Input,
    context: ToolContext,
  ) => Promise<Output>;
}): ToolDefinition<Name, Input, Output> {
  function checkAccess(context: ToolContext): ToolError | undefined {
    if (context.signal.aborted) return cancelled(context.signal);

    const permission = definition.requiredPermission;
    if (
      permission !== undefined &&
      !context.grantedPermissions.has(permission)
    ) {
      return {
        code: 'FORBIDDEN',
        toolName: definition.name,
        requiredPermission: permission,
      };
    }
    return undefined;
  }

  async function executeParsed(
    input: Input,
    context: ToolContext,
  ): Promise<Result<Output, ToolError>> {
    const accessError = checkAccess(context);
    if (accessError !== undefined) return { ok: false, error: accessError };

    try {
      return {
        ok: true,
        value: await definition.execute(input, context),
      };
    } catch (cause: unknown) {
      return context.signal.aborted
        ? { ok: false, error: cancelled(context.signal) }
        : { ok: false, error: { code: 'EXECUTION_FAILED', cause } };
    }
  }

  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    ...(definition.requiredPermission === undefined
      ? {}
      : { requiredPermission: definition.requiredPermission }),

    async invokeRaw(raw, context) {
      // 先鉴权再解析，避免未授权调用者通过详细校验错误探测受保护工具协议。
      const accessError = checkAccess(context);
      if (accessError !== undefined) return { ok: false, error: accessError };

      const parsed = definition.inputSchema.safeParse(raw);
      if (!parsed.ok) {
        return {
          ok: false,
          error: { code: 'INVALID_ARGUMENTS', issues: parsed.error },
        };
      }
      return executeParsed(parsed.value, context);
    },

    invokeParsed(input, context) {
      // parsed/domain input 可能是 transform 后的品牌或 Date，不能再次当 wire input parse。
      return executeParsed(input, context);
    },
  };
}

type DuplicateNames<
  Tools extends readonly AnyTool[],
  Seen extends string = never,
> = Tools extends readonly [
  infer Head extends AnyTool,
  ...infer Tail extends readonly AnyTool[],
]
  ? Head['name'] extends Seen
    ? Head['name'] | DuplicateNames<Tail, Seen>
    : DuplicateNames<Tail, Seen | Head['name']>
  : never;

type UniqueToolConstraint<Tools extends readonly AnyTool[]> =
  [DuplicateNames<Tools>] extends [never]
    ? unknown
    : { readonly __duplicateToolNames: DuplicateNames<Tools> };

class ToolRegistry<const Tools extends readonly AnyTool[]> {
  readonly #byName: ReadonlyMap<string, AnyTool>;

  constructor(readonly tools: Tools) {
    const byName = new Map<string, AnyTool>();
    for (const tool of tools) {
      if (byName.has(tool.name)) {
        throw new Error(`重复工具名: ${tool.name}`);
      }
      byName.set(tool.name, tool);
    }
    this.#byName = byName;
  }

  manifests(): readonly ToolManifest[] {
    // 返回深复制快照，避免调用方改写 Schema 内部对象后污染后续模型请求。
    return this.tools.map((tool) => structuredClone({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema.jsonSchema,
      ...(tool.requiredPermission === undefined
        ? {}
        : { requiredPermission: tool.requiredPermission }),
    }));
  }

  async invokeKnown<Name extends ToolName<Tools>>(
    name: Name,
    input: ToolInput<ToolByName<Tools, Name>>,
    context: ToolContext,
  ): Promise<Result<ToolOutput<ToolByName<Tools, Name>>, ToolError>> {
    const erased = this.#byName.get(name);
    if (erased === undefined) {
      // 构造器不变量成立时不可达；仍保留运行时诊断，防止代理/反射破坏对象。
      return { ok: false, error: { code: 'NOT_FOUND', toolName: name } };
    }

    // 唯一相关性恢复点：Map 由构造器按 tool.name 建立且拒绝重复，因此 name 命中的
    // 实例正是 ToolByName<Tools, Name>。外部调用方不接触这个断言。
    const tool = erased as ToolByName<Tools, Name>;
    return tool.invokeParsed(input, context);
  }

  async invokeUnknown(
    name: string,
    raw: unknown,
    context: ToolContext,
  ): Promise<DynamicToolResult<Tools>> {
    const tool = this.#byName.get(name);
    if (tool === undefined) {
      return {
        ok: false,
        toolName: name,
        error: { code: 'NOT_FOUND', toolName: name },
      };
    }

    const result = await tool.invokeRaw(raw, context);
    if (!result.ok) return { ok: false, toolName: name, error: result.error };

    // 动态成功值重新附带实际 toolName，形成可收窄的 name/value 判别联合。
    return {
      ok: true,
      toolName: tool.name,
      value: result.value,
    } as ToolSuccess<Tools[number]>;
  }
}

function createRegistry<const Tools extends readonly AnyTool[]>(
  tools: Tools & UniqueToolConstraint<Tools>,
): ToolRegistry<Tools> {
  return new ToolRegistry(tools);
}

// ------------------------------------------------------------
// 工具定义：Schema 同时给 execute 推断 input，并生成 manifest
// ------------------------------------------------------------

const weatherInputSchema = object({
  city: string({ minLength: 1, description: '城市名' }),
  unit: optional(literal('celsius', 'fahrenheit')),
});
type WeatherInput = Infer<typeof weatherInputSchema>;

interface WeatherOutput {
  readonly city: string;
  readonly temperature: number;
  readonly unit: 'celsius' | 'fahrenheit';
}

let weatherExecutions = 0;
const weatherTool = defineTool({
  name: 'get_weather',
  description: '查询指定城市的确定性示例天气',
  inputSchema: weatherInputSchema,
  requiredPermission: 'weather:read',
  async execute(input, context): Promise<WeatherOutput> {
    weatherExecutions += 1;
    context.signal.throwIfAborted();
    const unit = input.unit ?? 'celsius';
    return {
      city: input.city,
      temperature: unit === 'celsius' ? 26 : 78.8,
      unit,
    };
  },
});

const sumInputSchema = object({
  values: array(number(), { minItems: 1 }),
  mode: optional(literal('normal', 'absolute')),
});

const sumTool = defineTool({
  name: 'sum',
  description: '计算有限数字列表之和',
  inputSchema: sumInputSchema,
  async execute(input): Promise<{ readonly sum: number }> {
    const values = input.mode === 'absolute'
      ? input.values.map(Math.abs)
      : input.values;
    return { sum: values.reduce((total, value) => total + value, 0) };
  },
});

const registry = createRegistry([weatherTool, sumTool] as const);

const authorizedContext: ToolContext = {
  runId: 'run_demo_001',
  signal: new AbortController().signal,
  grantedPermissions: new Set(['weather:read']),
};

const deniedContext: ToolContext = {
  ...authorizedContext,
  grantedPermissions: new Set(),
};

// ------------------------------------------------------------
// 1. manifest 是深复制的模型协议快照
// ------------------------------------------------------------

const manifests = registry.manifests();
assert.deepEqual(manifests.map((manifest) => manifest.name), [
  'get_weather',
  'sum',
]);
assert.equal(manifests[0]?.inputSchema.additionalProperties, false);
assert.equal(manifests[0]?.requiredPermission, 'weather:read');

const mutableManifest = manifests[0] as ToolManifest | undefined;
if (mutableManifest === undefined) throw new Error('缺少 weather manifest');
Reflect.set(mutableManifest.inputSchema, 'description', 'caller mutation');
assert.notEqual(
  registry.manifests()[0]?.inputSchema.description,
  'caller mutation',
);

// ------------------------------------------------------------
// 2. known call 保留 name/input/output 相关性
// ------------------------------------------------------------

const knownSum = await registry.invokeKnown(
  'sum',
  { values: [1, -2, 3], mode: 'absolute' },
  authorizedContext,
);
assert.deepEqual(knownSum, { ok: true, value: { sum: 6 } });

if (false) {
  // @ts-expect-error sum 输入没有 city。
  void registry.invokeKnown('sum', { city: '上海' }, authorizedContext);

  // @ts-expect-error 注册表不存在 send_email。
  void registry.invokeKnown('send_email', {}, authorizedContext);

  // @ts-expect-error 重复字面量工具名在建表时即被类型契约拒绝。
  createRegistry([weatherTool, weatherTool] as const);
}

// 动态数组或被断言污染的数据仍必须有运行时重复名门禁。
assert.throws(
  () => new ToolRegistry([weatherTool, weatherTool] as const),
  /重复工具名: get_weather/,
);

// ------------------------------------------------------------
// 3. unknown call 真正接受 LLM 的 string + unknown
// ------------------------------------------------------------

const dynamicSum = await registry.invokeUnknown(
  'sum',
  { values: [1, 2, 3] },
  authorizedContext,
);
assert.equal(dynamicSum.ok, true);
if (dynamicSum.ok) {
  switch (dynamicSum.toolName) {
    case 'sum':
      assert.equal(dynamicSum.value.sum, 6);
      break;
    case 'get_weather':
      assert.equal(typeof dynamicSum.value.temperature, 'number');
      break;
  }
}

const missing = await registry.invokeUnknown(
  'send_email',
  {},
  authorizedContext,
);
assert.deepEqual(missing, {
  ok: false,
  toolName: 'send_email',
  error: { code: 'NOT_FOUND', toolName: 'send_email' },
});

// 未授权请求先返回 FORBIDDEN，不泄漏输入到底哪里不合法，且 execute 没有运行。
const forbidden = await registry.invokeUnknown(
  'get_weather',
  { city: 42, secretProbe: true },
  deniedContext,
);
assert.equal(forbidden.ok, false);
if (!forbidden.ok) assert.equal(forbidden.error.code, 'FORBIDDEN');
assert.equal(weatherExecutions, 0);

const invalid = await registry.invokeUnknown(
  'sum',
  { values: [1, 'two'], isAdmin: true },
  authorizedContext,
);
assert.equal(invalid.ok, false);
if (!invalid.ok && invalid.error.code === 'INVALID_ARGUMENTS') {
  assert.deepEqual(
    new Set(invalid.error.issues.map((issue) => issue.pointer)),
    new Set(['/values/1', '/isAdmin']),
  );
} else {
  throw new Error('非法 sum 参数应返回 INVALID_ARGUMENTS');
}

const weather = await registry.invokeUnknown(
  'get_weather',
  { city: '上海' },
  authorizedContext,
);
assert.equal(weather.ok, true);
assert.equal(weatherExecutions, 1);

const abortedController = new AbortController();
abortedController.abort(new Error('user cancelled'));
const cancelledResult = await registry.invokeUnknown(
  'get_weather',
  { city: '上海' },
  { ...authorizedContext, signal: abortedController.signal },
);
assert.equal(cancelledResult.ok, false);
if (!cancelledResult.ok) assert.equal(cancelledResult.error.code, 'CANCELLED');
assert.equal(weatherExecutions, 1);

console.log('=== 第 19 课：工具系统双入口 ===');
console.log({
  manifests: manifests.map((manifest) => manifest.name),
  knownSum,
  dynamicSum,
  missing,
  forbidden,
  invalidIssueCount:
    !invalid.ok && invalid.error.code === 'INVALID_ARGUMENTS'
      ? invalid.error.issues.length
      : 0,
  weatherExecutions,
});

export {};
