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

// 引入 node 内置的严格断言模块，用于运行时验证行为。
import assert from 'node:assert/strict';
// 从第 17 课的 schema 模块引入构造器与类型，构成工具的“单一事实源”：
// - 构造器（array/literal/number/object/optional/string）用于声明输入 schema；
// - 类型（Infer/JsonSchema/Result/Schema/ValidationIssue）用于联动类型推断。
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

// ---------------------------------------------------------------------------
// 工具系统统一的错误判别联合：每个分支都带 code，调用方可以用 switch 精确处理。
// ---------------------------------------------------------------------------
// 所有错误都使用“标签字段 code”区分，对应工具执行的四种典型失败 + 一种取消。
type ToolError =
  // 输入不合法：解析阶段失败，附带从 schema validator 来的字段路径 + 消息列表。
  | {
      readonly code: 'INVALID_ARGUMENTS';
      readonly issues: readonly ValidationIssue[];
    }
  // 工具名不存在：动态路径按字符串查找时落空。
  | {
      readonly code: 'NOT_FOUND';
      readonly toolName: string;
    }
  // 调用方未被授权：缺少工具声明的 requiredPermission。
  | {
      readonly code: 'FORBIDDEN';
      readonly toolName: string;
      readonly requiredPermission: string;
    }
  // 执行过程中被中止：AbortSignal 触发，reason 任意值（通常是 Error 或字符串）。
  | {
      readonly code: 'CANCELLED';
      readonly reason: unknown;
    }
  // 执行抛出非取消类异常：保留原始 cause，便于上层日志/重试决策。
  | {
      readonly code: 'EXECUTION_FAILED';
      readonly cause: unknown;
    };

// ---------------------------------------------------------------------------
// ToolContext：每次调用都共享的运行环境信息。
// ---------------------------------------------------------------------------
// 工具执行需要的三类“执行期元信息”：身份、取消信号、已授予权限集合。
interface ToolContext {
  // 本次 run 的唯一标识，便于日志与追踪。
  readonly runId: string;
  // AbortSignal：调用方可在任意时刻触发取消，工具内部通过 throwIfAborted 协作。
  readonly signal: AbortSignal;
  // 已授权的权限字符串集合；工具的 requiredPermission 必须 inside 这个集合才能调用。
  readonly grantedPermissions: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// ToolManifest：发给给模型的“工具说明书”，对应 LLM tool/function 协议。
// ---------------------------------------------------------------------------
// 这是注册表对外暴露的纯数据视图，由 Schema 的 jsonSchema 派生，没有 JS 函数。
interface ToolManifest {
  // 工具名：模型在 tool_call.name 里返回的字符串。
  readonly name: string;
  // 工具描述：影响模型选择该工具的概率。
  readonly description: string;
  // 输入的 JSON Schema：模型按它生成 arguments，与内部 validator 同源。
  readonly inputSchema: JsonSchema;
  // 可选权限提示：服务端用它做调用授权（一般不暴露给模型，这里仅复用同一字段）。
  readonly requiredPermission?: string;
}

// ---------------------------------------------------------------------------
// ToolDefinition：一个工具的完整定义，类型参数把“名字/输入/输出”三者绑定。
// ---------------------------------------------------------------------------
// 三个类型参数同时出现在 inputSchema/invokeXX 等位置，是工具系统的核心关系约束。
interface ToolDefinition<Name extends string, Input, Output> {
  // Name extends string 且通常是字面量（如 'get_weather'），用于注册表的索引类型推断。
  readonly name: Name;
  // 文本描述，发到模型 manifest。
  readonly description: string;
  // Schema<Input> 既是 TypeScript 输入类型的来源（Infer<typeof inputSchema>），
  // 也是运行时 validator，还能产出 JSON Schema——三者共用一份定义。
  readonly inputSchema: Schema<Input>;
  // 可选权限：未设置表示公开工具，调用前不检查 grantedPermissions。
  readonly requiredPermission?: string;

  // 动态入口：从模型/网络拿到的原始 unknown 数据，内部先 safeParse 再 execute。
  // 返回 Result<Output, ToolError>：成功失败都走显式的 ok 判别字段，不抛异常。
  invokeRaw(
    raw: unknown,
    context: ToolContext,
  ): Promise<Result<Output, ToolError>>;

  // method syntax 的参数在 TS 中保持双变兼容，便于异构工具进入同一个只读容器；
  // 注册表绝不会通过擦除后的 AnyTool 调用它，而会先恢复 name 对应的具体 Tool 类型。
  // 静态入口：调用方已有强类型 Input（可能是 transform 后的 domain 值），直接跳过解析。
  invokeParsed(
    input: Input,
    context: ToolContext,
  ): Promise<Result<Output, ToolError>>;

  // 类型投影槽：__types 不在运行时使用（可选 + 永远不赋值），仅用于让 ToolInput/ToolOutput
  // 这类工具类型能用 NonNullable<Tool['__types']>['input'] 取回 Input/Output。
  readonly __types?: {
    readonly input: Input;
    readonly output: Output;
  };
}

// ---------------------------------------------------------------------------
// 工具类型的“擦除版”与各种辅助别名：用于在只读容器里统一存放异构工具，并按 name 取回。
// ---------------------------------------------------------------------------

// AnyTool：把三个类型参数全部擦除成 string/unknown/unknown，便于放进同一个数组/Map。
// 它放弃了 name↔input↔output 的具体关系，等需要时再用 ToolByName 等工具类型恢复。
type AnyTool = ToolDefinition<string, unknown, unknown>;
// ToolName：从工具元组中抽取所有工具名，得到 keyof 风格的字面量联合（如 'get_weather' | 'sum'）。
type ToolName<Tools extends readonly AnyTool[]> = Tools[number]['name'];
// ToolByName：按字面量名 Name 在元组里定位那个工具类型。
// Extract 利用判别字段 name 的字面量类型，把 Tools[number] 过滤到唯一匹配的一项。
type ToolByName<
  Tools extends readonly AnyTool[],
  Name extends ToolName<Tools>,
> = Extract<Tools[number], { readonly name: Name }>;
// ToolInput：通过 __types 槽取出工具的 Input 类型。
// NonNullable 是因为 __types 是可选的；这里只用它的类型，不关心运行时值。
type ToolInput<Tool extends AnyTool> = NonNullable<Tool['__types']>['input'];
// ToolOutput：同理，取 Output 类型，与 ToolInput 配合实现“name → input/output”三元组联动。
type ToolOutput<Tool extends AnyTool> = NonNullable<Tool['__types']>['output'];

// ---------------------------------------------------------------------------
// 动态调用成功值的构造：把擦除后的 Output 用条件类型重新挂回具体的工具名。
// ---------------------------------------------------------------------------

// ToolSuccess：把 Tool 用 infer 拆出 Name 和 Output，组装成一个带判别字段 ok: true 的成功结果。
// 这样动态路径的成功值也是“按 toolName 可收窄”的判别联合。
type ToolSuccess<Tool extends AnyTool> =
  Tool extends ToolDefinition<infer Name, unknown, infer Output>
    ? {
        readonly ok: true;
        readonly toolName: Name;
        readonly value: Output;
      }
    : never;

// DynamicToolResult：动态路径的整体返回类型。
// 成功：可能是任意一个工具的成功（联合）；失败：附带字符串 toolName 和 ToolError。
type DynamicToolResult<Tools extends readonly AnyTool[]> =
  | ToolSuccess<Tools[number]>
  | {
      readonly ok: false;
      readonly toolName: string;
      readonly error: ToolError;
    };

// ---------------------------------------------------------------------------
// 取消错误工厂：从 AbortSignal 构造统一的 CANCELLED 错误对象。
// ---------------------------------------------------------------------------

// cancelled：把 signal.reason 包装成 ToolError 的 CANCELLED 分支，集中取消语义。
function cancelled(signal: AbortSignal): ToolError {
  return { code: 'CANCELLED', reason: signal.reason };
}

// ---------------------------------------------------------------------------
// defineTool：工具构造器——把开发者写的 execute/Schema/权限封装成统一形状。
// ---------------------------------------------------------------------------
// const Name 让调用点传入的字面量工具名被推断为字面量类型（'get_weather' 而非 string），
// 这是注册表能按 name 索引出精确 Input/Output 的根本前提。
function defineTool<
  const Name extends string,
  Input,
  Output,
>(definition: {
  readonly name: Name;
  readonly description: string;
  // Schema<Input> 同时是运行时 validator 和 Input 类型来源——一次定义三处用。
  readonly inputSchema: Schema<Input>;
  readonly requiredPermission?: string;
  // execute 是工具作者唯一关心的“业务函数”：拿强类型 input + context，返回 Output。
  readonly execute: (
    input: Input,
    context: ToolContext,
  ) => Promise<Output>;
}): ToolDefinition<Name, Input, Output> {
  // checkAccess：把“是否被取消”和“是否被授权”两条前置检查集中到一处。
  // 返回 undefined 表示通过；返回 ToolError 表示失败原因，由调用方包成 Result。
  function checkAccess(context: ToolContext): ToolError | undefined {
    // ① 先看 AbortSignal：任何入口的调用只要已被取消就立即拒绝，避免无意义计算。
    if (context.signal.aborted) return cancelled(context.signal);

    // ② 再看权限：工具声明了 requiredPermission 时，必须出现在 grantedPermissions 中。
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

  // executeParsed：拿到已通过验证的 domain input 后的执行核心，处理 execute 抛错和取消。
  async function executeParsed(
    input: Input,
    context: ToolContext,
  ): Promise<Result<Output, ToolError>> {
    // 进入 execute 前再次鉴权（虽然 invokeRaw 也调过，但 invokeParsed 是公开入口，要自守）。
    const accessError = checkAccess(context);
    if (accessError !== undefined) return { ok: false, error: accessError };

    try {
      // 正常路径：把 Output 包成 Result.ok 返回，不抛异常。
      return {
        ok: true,
        value: await definition.execute(input, context),
      };
    } catch (cause: unknown) {
      // 异常分流：若 signal 在执行中被 abort 了，归为 CANCELLED；否则归 EXECUTION_FAILED。
      return context.signal.aborted
        ? { ok: false, error: cancelled(context.signal) }
        : { ok: false, error: { code: 'EXECUTION_FAILED', cause } };
    }
  }

  // 返回的工具对象：保持与 ToolDefinition 接口一致的形状，闭包持有 definition。
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    // 条件展开：未声明权限时不带 requiredPermission 字段，让 manifest 输出更干净。
    ...(definition.requiredPermission === undefined
      ? {}
      : { requiredPermission: definition.requiredPermission }),

    // 动态入口：先鉴权 → safeParse raw → executeParsed。
    async invokeRaw(raw, context) {
      // 先鉴权再解析，避免未授权调用者通过详细校验错误探测受保护工具协议。
      const accessError = checkAccess(context);
      if (accessError !== undefined) return { ok: false, error: accessError };

      // safeParse 返回 Result：不合法不抛，而是把 ValidationIssue[] 收进 INVALID_ARGUMENTS。
      const parsed = definition.inputSchema.safeParse(raw);
      if (!parsed.ok) {
        return {
          ok: false,
          error: { code: 'INVALID_ARGUMENTS', issues: parsed.error },
        };
      }
      // 解析成功后转交 executeParsed 执行（它的 input 已是 transform 后的强类型值）。
      return executeParsed(parsed.value, context);
    },

    invokeParsed(input, context) {
      // parsed/domain input 可能是 transform 后的品牌或 Date，不能再次当 wire input parse。
      return executeParsed(input, context);
    },
  };
}

// ---------------------------------------------------------------------------
// 编译期“重名工具”探测器：通过类型系统让重复 name 的元组在 createRegistry 时报错。
// ---------------------------------------------------------------------------

// DuplicateNames：递归扫描工具元组，返回所有出现 ≥2 次的 name 联合（没重复时为 never）。
// Seen 是递归累加器，记录已经见过的名字；遇到见过的就把它加入结果联合。
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

// UniqueToolConstraint：把重复名列表转换成“约束类型”。
// 无重复（DuplicateNames 为 never）时约束就是 unknown（兼容一切）；
// 有重复时约束变成带 __duplicateToolNames 字段的对象，与 Tools 做 `&` 后会产生
// 一个无法满足的类型，迫使调用方在编译期就改掉重复。
type UniqueToolConstraint<Tools extends readonly AnyTool[]> =
  [DuplicateNames<Tools>] extends [never]
    ? unknown
    : { readonly __duplicateToolNames: DuplicateNames<Tools> };

// ---------------------------------------------------------------------------
// ToolRegistry：把工具元组包成一个可调用、可生成 manifest 的注册中心。
// ---------------------------------------------------------------------------
// 类型参数 Tools 保留元组里每个工具的精确字面量 name/输入/输出，是 invokeKnown 类型联动的根源。
class ToolRegistry<const Tools extends readonly AnyTool[]> {
  // 私有查找表：按 name → AnyTool。运行时用普通 Map 做动态查找，
  // 类型相关性则在 invokeKnown 里通过 as 恢复（因为 Map 的 value 类型已被擦除成 AnyTool）。
  readonly #byName: ReadonlyMap<string, AnyTool>;

  // 构造器：遍历 tools 建索引；遇重名立即抛错，作为运行时的第二道防线。
  // readonly tools 保留原始元组类型，manifests/invokeKnown 等都基于它做类型推导。
  constructor(readonly tools: Tools) {
    const byName = new Map<string, AnyTool>();
    for (const tool of tools) {
      // 同名工具冲突：直接 throw，避免后续调用点静默走错分支。
      if (byName.has(tool.name)) {
        throw new Error(`重复工具名: ${tool.name}`);
      }
      byName.set(tool.name, tool);
    }
    this.#byName = byName;
  }

  // manifests：生成发往模型的工具列表（深复制快照）。
  manifests(): readonly ToolManifest[] {
    // 返回深复制快照，避免调用方改写 Schema 内部对象后污染后续模型请求。
    // structuredClone 比 JSON 序列化更安全（能克隆循环引用、TypedArray 等）。
    return this.tools.map((tool) => structuredClone({
      name: tool.name,
      description: tool.description,
      // jsonSchema 来自第 17 课的 Schema 值，与内部 validator 完全同源。
      inputSchema: tool.inputSchema.jsonSchema,
      ...(tool.requiredPermission === undefined
        ? {}
        : { requiredPermission: tool.requiredPermission }),
    }));
  }

  // 静态入口：调用方在 TypeScript 侧已经知道是哪个工具、什么 input。
  // Name extends ToolName<Tools> 限定只能传已注册工具名；
  // input 类型 ToolInput<ToolByName<Tools, Name>> 自动等于那个工具的 Input。
  // 返回 Result<ToolOutput<...>, ToolError>：成功值也是强类型 Output。
  async invokeKnown<Name extends ToolName<Tools>>(
    name: Name,
    input: ToolInput<ToolByName<Tools, Name>>,
    context: ToolContext,
  ): Promise<Result<ToolOutput<ToolByName<Tools, Name>>, ToolError>> {
    // Map 的 value 类型是 AnyTool，查找结果被擦除；类型恢复在下面用 as 完成。
    const erased = this.#byName.get(name);
    if (erased === undefined) {
      // 构造器不变量成立时不可达；仍保留运行时诊断，防止代理/反射破坏对象。
      return { ok: false, error: { code: 'NOT_FOUND', toolName: name } };
    }

    // 唯一相关性恢复点：Map 由构造器按 tool.name 建立且拒绝重复，因此 name 命中的
    // 实例正是 ToolByName<Tools, Name>。外部调用方不接触这个断言。
    const tool = erased as ToolByName<Tools, Name>;
    // 用 invokeParsed 跳过重复 safeParse：调用方的 input 已是强类型 domain 值。
    return tool.invokeParsed(input, context);
  }

  // 动态入口：name 是模型/网络拿来的 string，raw 是 unknown。
  // 返回 DynamicToolResult<Tools>：成功值的 toolName/value 共同构成可收窄的判别联合。
  async invokeUnknown(
    name: string,
    raw: unknown,
    context: ToolContext,
  ): Promise<DynamicToolResult<Tools>> {
    // 按 string 查找；找不到返回带名字的 NOT_FOUND，调用方可以据 toolName 决定重试/上报。
    const tool = this.#byName.get(name);
    if (tool === undefined) {
      return {
        ok: false,
        toolName: name,
        error: { code: 'NOT_FOUND', toolName: name },
      };
    }

    // 找到了就用 invokeRaw：它内部会鉴权 + safeParse + execute，统一返回 Result<Output, ToolError>。
    const result = await tool.invokeRaw(raw, context);
    if (!result.ok) return { ok: false, toolName: name, error: result.error };

    // 动态成功值重新附带实际 toolName，形成可收窄的 name/value 判别联合。
    // as ToolSuccess<Tools[number]> 是合法的：运行时 result.value 就是该工具的 Output，
    // 编译期把它升级回带 toolName 的判别联合后，调用方就能按 toolName switch。
    return {
      ok: true,
      toolName: tool.name,
      value: result.value,
    } as ToolSuccess<Tools[number]>;
  }
}

// createRegistry：唯一推荐用来构造注册表的工厂函数。
// 参数类型 `Tools & UniqueToolConstraint<Tools>` 在编译期拒绝重复工具名，
// 把“工具名唯一”这条不变量从运行时 throw 提前到编译期类型错误。
function createRegistry<const Tools extends readonly AnyTool[]>(
  tools: Tools & UniqueToolConstraint<Tools>,
): ToolRegistry<Tools> {
  return new ToolRegistry(tools);
}

// ------------------------------------------------------------
// 工具定义：Schema 同时给 execute 推断 input，并生成 manifest
// ------------------------------------------------------------

// weatherInputSchema：天气工具的输入 schema。
// city 要求 minLength 1（拒绝空串），unit 是可选的字面量枚举（摄氏/华氏）。
const weatherInputSchema = object({
  city: string({ minLength: 1, description: '城市名' }),
  unit: optional(literal('celsius', 'fahrenheit')),
});
// WeatherInput：用 Infer 从 schema 反推类型，避免“接口 + schema”双重维护。
type WeatherInput = Infer<typeof weatherInputSchema>;

// WeatherOutput：工具输出，手工声明显式接口（输出不需要走 schema）。
interface WeatherOutput {
  readonly city: string;
  readonly temperature: number;
  readonly unit: 'celsius' | 'fahrenheit';
}

// weatherExecutions：计数器，用于测试中验证 execute 是否真的被执行（鉴权/解析失败应保持 0）。
let weatherExecutions = 0;
// weatherTool：把天气工具的所有信息打包成 ToolDefinition<'get_weather', WeatherInput, WeatherOutput>。
// const Name 推断把 'get_weather' 保留为字面量类型，供注册表索引使用。
const weatherTool = defineTool({
  name: 'get_weather',
  description: '查询指定城市的确定性示例天气',
  inputSchema: weatherInputSchema,
  // 声明权限：只有 grantedPermissions 含 'weather:read' 的 context 才能执行。
  requiredPermission: 'weather:read',
  // execute 的 input 参数由 inputSchema 自动推断为 WeatherInput，无需手写类型。
  async execute(input, context): Promise<WeatherOutput> {
    weatherExecutions += 1;
    // 协作式取消：在长任务关键点检查 signal，被 abort 时立即抛错。
    context.signal.throwIfAborted();
    // unit 缺省视为摄氏；这里直接返回固定值，避免真实网络依赖。
    const unit = input.unit ?? 'celsius';
    return {
      city: input.city,
      temperature: unit === 'celsius' ? 26 : 78.8,
      unit,
    };
  },
});

// sumInputSchema：求和工具的输入。values 至少一个元素；mode 可选 normal/absolute。
const sumInputSchema = object({
  values: array(number(), { minItems: 1 }),
  mode: optional(literal('normal', 'absolute')),
});

// sumTool：无 requiredPermission，公开工具；execute 不再用 context（这里显式省略其形参）。
const sumTool = defineTool({
  name: 'sum',
  description: '计算有限数字列表之和',
  inputSchema: sumInputSchema,
  // mode === 'absolute' 时先取绝对值再求和，演示 transform 后的 input 类型保留。
  async execute(input): Promise<{ readonly sum: number }> {
    const values = input.mode === 'absolute'
      ? input.values.map(Math.abs)
      : input.values;
    return { sum: values.reduce((total, value) => total + value, 0) };
  },
});

// registry：注册中心。`as const` 让元组保留每个工具的字面量类型，
// 配合 createRegistry 的 UniqueToolConstraint 在编译期拒绝重名。
const registry = createRegistry([weatherTool, sumTool] as const);

// authorizedContext：持有了 weather:read 权限 + 一个未触发的 AbortSignal。
const authorizedContext: ToolContext = {
  runId: 'run_demo_001',
  signal: new AbortController().signal,
  grantedPermissions: new Set(['weather:read']),
};

// deniedContext：复用 authorizedContext 的其余字段，仅清空权限，用来测 FORBIDDEN 分支。
const deniedContext: ToolContext = {
  ...authorizedContext,
  grantedPermissions: new Set(),
};

// ------------------------------------------------------------
// 1. manifest 是深复制的模型协议快照
// ------------------------------------------------------------

// 生成一次 manifest，后续断言它的内容 + 不可变性。
const manifests = registry.manifests();
// 顺序与注册顺序一致：get_weather 在前，sum 在后。
assert.deepEqual(manifests.map((manifest) => manifest.name), [
  'get_weather',
  'sum',
]);
// 第 17 课的 object schema 默认 additionalProperties: false，模型不能塞额外字段。
assert.equal(manifests[0]?.inputSchema.additionalProperties, false);
// 权限字段被原样带到 manifest（这里仅复用同一字段，不一定是给模型看的）。
assert.equal(manifests[0]?.requiredPermission, 'weather:read');

// 故意通过 Reflect 改写拿到的 manifest，验证它是深复制：原 registry 内部数据不受影响。
const mutableManifest = manifests[0] as ToolManifest | undefined;
if (mutableManifest === undefined) throw new Error('缺少 weather manifest');
Reflect.set(mutableManifest.inputSchema, 'description', 'caller mutation');
// 重新拿一次 manifest，description 不应等于被改写的值，证明 structuredClone 隔离了内部状态。
assert.notEqual(
  registry.manifests()[0]?.inputSchema.description,
  'caller mutation',
);

// ------------------------------------------------------------
// 2. known call 保留 name/input/output 相关性
// ------------------------------------------------------------

// 静态调用 sum：name 'sum' + 强类型 input + context，返回值 value 是 { sum: number }。
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
// 这是类型层防御的兜底：当 somebody 绕过 createRegistry 直接 new ToolRegistry 时仍能阻止重名。
assert.throws(
  () => new ToolRegistry([weatherTool, weatherTool] as const),
  /重复工具名: get_weather/,
);

// ------------------------------------------------------------
// 3. unknown call 真正接受 LLM 的 string + unknown
// ------------------------------------------------------------

// 动态调用 sum：name 是 string、raw 是 unknown（模拟从模型拿到的 tool_call）。
const dynamicSum = await registry.invokeUnknown(
  'sum',
  { values: [1, 2, 3] },
  authorizedContext,
);
assert.equal(dynamicSum.ok, true);
// 成功后 switch toolName：TypeScript 根据 toolName 把 value 收窄到对应工具的 Output。
if (dynamicSum.ok) {
  switch (dynamicSum.toolName) {
    case 'sum':
      // 此分支内 value 类型为 { sum: number }。
      assert.equal(dynamicSum.value.sum, 6);
      break;
    case 'get_weather':
      // 此分支内 value 类型为 WeatherOutput，可以安全访问 temperature。
      assert.equal(typeof dynamicSum.value.temperature, 'number');
      break;
  }
}

// 不存在的工具名 → NOT_FOUND，错误信息里也带了原样 toolName 便于上游处理。
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
// 这里 input 是非法的（city 不是 number 该是 string、还多带了 secretProbe），
// 但因为先被权限拦截，调用方拿不到 INVALID_ARGUMENTS，无法用校验细节探测协议。
const forbidden = await registry.invokeUnknown(
  'get_weather',
  { city: 42, secretProbe: true },
  deniedContext,
);
assert.equal(forbidden.ok, false);
if (!forbidden.ok) assert.equal(forbidden.error.code, 'FORBIDDEN');
// 关键不变量：execute 从未被执行，weatherExecutions 仍是 0。
assert.equal(weatherExecutions, 0);

// 非法输入走 INVALID_ARGUMENTS：第 17 课 schema 返回 issues，每条带 pointer 指向问题字段。
const invalid = await registry.invokeUnknown(
  'sum',
  { values: [1, 'two'], isAdmin: true },
  authorizedContext,
);
assert.equal(invalid.ok, false);
// 用 issue.pointer 的集合断言，不依赖顺序。
if (!invalid.ok && invalid.error.code === 'INVALID_ARGUMENTS') {
  assert.deepEqual(
    new Set(invalid.error.issues.map((issue) => issue.pointer)),
    new Set(['/values/1', '/isAdmin']),
  );
} else {
  throw new Error('非法 sum 参数应返回 INVALID_ARGUMENTS');
}

// 正常动态调用天气：授权 OK、输入合法，execute 真正运行一次。
const weather = await registry.invokeUnknown(
  'get_weather',
  { city: '上海' },
  authorizedContext,
);
assert.equal(weather.ok, true);
assert.equal(weatherExecutions, 1);

// 取消语义：调用前先 abort，invokeRaw 的 checkAccess 第一条就会拦截并返回 CANCELLED。
const abortedController = new AbortController();
abortedController.abort(new Error('user cancelled'));
const cancelledResult = await registry.invokeUnknown(
  'get_weather',
  { city: '上海' },
  { ...authorizedContext, signal: abortedController.signal },
);
assert.equal(cancelledResult.ok, false);
if (!cancelledResult.ok) assert.equal(cancelledResult.error.code, 'CANCELLED');
// 被取消时 execute 同样不应被触发，weatherExecutions 维持 1。
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
