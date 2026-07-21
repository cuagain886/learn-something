// tool.ts：工具系统的核心——把“Schema、权限、JSON 安全、并发调度约束”封装成统一抽象。
//
// 与其它文件的关系：
//   - 输入侧依赖 17-schema.ts 的 Schema<Input> 做“运行时收窄 + 静态类型推断”；
//   - 输出侧用 validateJsonValue 兜底，把 TypeScript 的 JsonValue 在运行时真正校验；
//   - defineTool 是工具作者的入口；ToolRegistry 是 Runner/测试使用的注册表；
//   - ToolContext 在每次调用时由 Runner 注入，携带 signal/grantedPermissions，把权限/取消下沉到工具层。
import {
  type Schema,
  type ValidationIssue,
  toJsonPointer,
} from '../17-schema.js';
import type {
  JsonValue,
  ToolDescriptor,
  ToolExecutionResult,
  ToolFailure,
} from './domain.js';

/**
 * ToolContext：每次工具调用时由 Runner 注入的运行时环境。
 *
 *   - runId/step/callId：用于日志、追踪、计费把“这一次调用”关联回“哪条 Run 的哪一步”；
 *   - signal：把 AgentRun 的取消链路一路传到工具内部（如 fetch），让取消可端到端生效；
 *   - grantedPermissions：Runner 启动时根据 options.grantedPermissions 生成的只读集合，
 *     工具用 requiredPermission 字段声明需求，checkAccess 据此判定是否放行。
 */
export interface ToolContext {
  readonly runId: string;
  readonly step: number;
  readonly callId: string;
  readonly signal: AbortSignal;
  readonly grantedPermissions: ReadonlySet<string>;
}

/**
 * ToolDefinition：一个被定义好的工具的完整形态。
 *
 * 类型参数：
 *   - Name：字面量类型，让 ToolRegistry 能用 'sum' / 'search_docs' 这样的精确名字做推断；
 *   - Input：inputSchema 解析成功后的领域类型（可能是 transform 后的品牌类型）；
 *   - Output：execute 返回值的精确实例类型（JsonValue 的子类型），用于 invokeKnown 的强相关返回。
 *
 * 双入口设计：
 *   - invokeRaw 接受 unknown（模型/HTTP 等不可信来源），先做 inputSchema.safeParse 再执行；
 *   - invokeParsed 接受已 transform 后的 Input（内部/测试调用），跳过 parse 直跑 execute。
 *
 * __types 是类型推断的“影子字段”，运行时永远是 undefined，只在类型层提取 Input/Output。
 */
export interface ToolDefinition<Name extends string, Input, Output extends JsonValue> {
  readonly descriptor: ToolDescriptor & { readonly name: Name };
  readonly inputSchema: Schema<Input>;

  invokeRaw(
    raw: unknown,
    context: ToolContext,
  ): Promise<ToolExecutionResult<Output>>;

  invokeParsed(
    input: Input,
    context: ToolContext,
  ): Promise<ToolExecutionResult<Output>>;

  readonly __types?: {
    readonly input: Input;
    readonly output: Output;
  };
}

// AnyTool：把 ToolDefinition 的三个类型参数都擦除到最宽形态（string/unknown/JsonValue）。
// 用于“一篮子工具”的容器类型（如数组、Map）；具体类型在 ToolRegistry 里按 name 精确恢复。
export type AnyTool = ToolDefinition<string, unknown, JsonValue>;
// ToolName：从一个“工具元组”类型里抽出所有工具名的字面量联合，例如 'sum' | 'search_docs'。
// 这是 ToolRegistry.invokeKnown 的“精确 name 参数”的来源。
type ToolName<Tools extends readonly AnyTool[]> =
  Tools[number]['descriptor']['name'];
// ToolByName：根据名字精确取出对应工具的原始 ToolDefinition 类型。
// 关键机制是 Extract：在 union 中筛出 descriptor.name === Name 的那一支，保留完整 Input/Output 信息。
type ToolByName<
  Tools extends readonly AnyTool[],
  Name extends ToolName<Tools>,
> = Extract<
  Tools[number],
  { readonly descriptor: { readonly name: Name } }
>;
// InputOf / OutputOf：从 AnyTool 的影子字段 __types 里取出 Input/Output。
// NonNullable<...>['input'] 的写法既剥掉了 undefined，又拿到了精确字段类型。
type InputOf<Tool extends AnyTool> = NonNullable<Tool['__types']>['input'];
type OutputOf<Tool extends AnyTool> = NonNullable<Tool['__types']>['output'];

/**
 * issue：构造一条 ValidationIssue 的小工厂。
 *
 * 把 code/path/message/received 组装好，并把 path 转成 JSON Pointer（pointer 字段）。
 * 集中在这里做，让 validateJsonValue 各分支可以专注于“判定与定位”，保持简洁。
 */
function issue(
  code: ValidationIssue['code'],
  path: readonly (string | number)[],
  message: string,
  received: string,
): ValidationIssue {
  return {
    code,
    path,
    pointer: toJsonPointer(path),
    message,
    received,
  };
}

/**
 * JsonValidation：validateJsonValue 的内部结果。
 *
 * ok=true 时携带已克隆并清洗过的 JsonValue；ok=false 时携带一组 ValidationIssue。
 * 不复用 Schema 的 Result 是因为这里走的是“JSON 兼容性”而非“shape 校验”，issue code 也不同。
 */
type JsonValidation =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/**
 * 工具输出在进入模型消息前做 JSON 安全复制：
 *
 * - number 必须 finite；NaN/Infinity 虽满足 TS number，却不是 JSON number；
 * - 只接受 array 和 plain/null-prototype object；
 * - 拒绝循环引用、symbol key、accessor/getter 和稀疏数组；
 * - 通过 defineProperty 写白名单 clone，避免 __proto__ setter。
 */
// validateJsonValue：把“静态类型是 JsonValue”的值，在运行时真正校验+克隆。
//
// 为什么不能直接 JSON.stringify 或 structuredClone：
//   - JSON.stringify 会把 NaN 变 null、忽略 symbol key、把 getter 当普通值调用（会执行不可信代码）；
//   - structuredClone 会保留 Date/Map 等非 JSON 类型，反而把“协议不合法的值”当成合法。
//
// 因此这里手写一遍“白名单遍历”，每访问一个节点都做安全检查，并复制成纯 JSON 结构。
function validateJsonValue(input: unknown): JsonValidation {
  // active：WeakSet 记录“当前递归栈中的对象”。遇到已存在对象即循环引用，直接拒绝。
  // 用 WeakSet 而非 Set：访问结束后允许 GC，且不阻止外部继续持有原对象。
  const active = new WeakSet<object>();

  // visit：内层递归函数。返回 JsonValidation，让调用者负责“合并 issues”，而非抛错。
  // path 参数把“当前节点在整棵树中的位置”一路传下去，错误时生成精确 JSON Pointer。
  function visit(
    value: unknown,
    path: readonly (string | number)[],
  ): JsonValidation {
    // 标量优先放行：null / string / boolean 都是 JSON 安全的。
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean'
    ) {
      return { ok: true, value };
    }

    // number：TS 的 number 包含 NaN 和 ±Infinity，但 JSON 规范不接受，必须显式拒绝。
    if (typeof value === 'number') {
      return Number.isFinite(value)
        ? { ok: true, value }
        : {
            ok: false,
            issues: [issue(
              'not_json_value',
              path,
              'JSON number 必须是有限数字',
              String(value),
            )],
          };
    }

    // 函数、symbol、undefined 等“非对象且非标量”的值，JSON 无法表达，直接拒绝。
    if (typeof value !== 'object' || value === null) {
      return {
        ok: false,
        issues: [issue(
          'not_json_value',
          path,
          '值不是 JSON 可表达类型',
          typeof value,
        )],
      };
    }

    // 循环引用检测：上面已确保 value 是 object，可以放进 WeakSet 比对。
    if (active.has(value)) {
      return {
        ok: false,
        issues: [issue(
          'cyclic_value',
          path,
          'JSON 输出不能包含循环引用',
          'object',
        )],
      };
    }
    active.add(value);

    try {
      // 分支 A：数组——额外校验“稀疏槽位 / 额外属性 / accessor / symbol key”。
      if (Array.isArray(value)) {
        const output: JsonValue[] = [];
        const issues: ValidationIssue[] = [];

        for (let index = 0; index < value.length; index += 1) {
          // 用 getOwnPropertyDescriptor 判断“这个下标是不是真的有值”：
          //   - 稀疏数组里访问缺失下标会得到 undefined，但 JSON.stringify 会把它变 null，误导模型；
          //   - 同时还能识别 accessor（get/set），防止执行不可信 getter。
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (descriptor === undefined) {
            issues.push(issue(
              'not_json_value',
              [...path, index],
              '拒绝会被 JSON.stringify 隐式变成 null 的稀疏数组槽位',
              'missing',
            ));
            continue;
          }
          if (!('value' in descriptor)) {
            issues.push(issue(
              'accessor_property',
              [...path, index],
              '输出数组不能包含 accessor/getter',
              'accessor',
            ));
            continue;
          }

          // 子节点递归：把 index 追加进 path，让深层错误也能定位到具体下标。
          const parsed = visit(descriptor.value, [...path, index]);
          if (parsed.ok) output[index] = parsed.value;
          else issues.push(...parsed.issues);
        }

        // 数组还可能带“非下标”属性：length（忽略）、symbol key、越界数字 key、任意字符串 key。
        // JSON.stringify 会静默丢弃这些，但工具作者通常不是有意为之——这里把它当错误报出来。
        const extraKeys = Reflect.ownKeys(value).filter((key) => {
          if (key === 'length') return false;
          if (typeof key === 'symbol') return true;
          return !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length;
        });
        for (const key of extraKeys) {
          issues.push(issue(
            'not_json_value',
            [...path, String(key)],
            '数组包含 JSON 会忽略的额外属性或 symbol key',
            typeof key,
          ));
        }

        return issues.length === 0
          ? { ok: true, value: output }
          : { ok: false, issues };
      }

      // 分支 B：对象——先确认 prototype 是 Object.prototype 或 null，杜绝类实例/Map 等伪装成 plain object。
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        return {
          ok: false,
          issues: [issue(
            'not_json_value',
            path,
            '只接受 plain object 或 null-prototype object',
            'custom prototype',
          )],
        };
      }

      const output: Record<string, JsonValue> = {};
      const issues: ValidationIssue[] = [];
      // Reflect.ownKeys 同时返回字符串和 symbol key，便于把 symbol 单独报错。
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') {
          issues.push(issue(
            'not_json_value',
            [...path, String(key)],
            'JSON object 不支持 symbol key',
            'symbol',
          ));
          continue;
        }

        // 跳过 non-enumerable 属性：JSON.stringify 本来也只序列化可枚举字段，
        // 这里保持相同语义，但 accessor 属性要单独报错（避免静默执行 getter）。
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !descriptor.enumerable) continue;
        if (!('value' in descriptor)) {
          issues.push(issue(
            'accessor_property',
            [...path, key],
            '输出对象不能包含 accessor/getter',
            'accessor',
          ));
          continue;
        }

        const parsed = visit(descriptor.value, [...path, key]);
        if (!parsed.ok) {
          issues.push(...parsed.issues);
          continue;
        }
        // 用 defineProperty + 显式 descriptor 写入，绕开 __proto__ setter 攻击：
        // 直接 output[key] = ... 在 key === '__proto__' 时会改原型链，导致整个 clone 被污染。
        Object.defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: parsed.value,
        });
      }

      return issues.length === 0
        ? { ok: true, value: output }
        : { ok: false, issues };
    } finally {
      // finally 而不是普通 return：即使中途抛错也要把 active 里的引用清掉，避免内存停留。
      active.delete(value);
    }
  }

  // 入口：从根节点（空 path）开始遍历，path 会被逐步拼成 /values/1 这样的 pointer。
  return visit(input, []);
}

/**
 * cancelled：把 AbortSignal 的 reason 包成 CANCELLED 失败。
 * 工具层在多处都需要“信号已取消”这个失败分支，抽出小工厂保持代码一致。
 */
function cancelled(signal: AbortSignal): ToolFailure {
  return { code: 'CANCELLED', reason: signal.reason };
}

/**
 * defineTool：工具作者使用的工厂函数。
 *
 * 设计意图：
 *   - 把 Name/Input/Output 三个类型参数一次性“钉死”在闭包里，避免 AnyTool 擦除后丢失精度；
 *   - 把“权限检查 / 取消检查 / parse / JSON 输出校验 / 异常分类”统一封装，
 *     作者只需要写纯粹的 execute(input, context) -> Output；
 *   - const Name 让调用点的字面量（'sum'）原样保留，是 ToolRegistry 精确推断的基石。
 *
 * 返回值同时实现 invokeRaw（unknown 入口）和 invokeParsed（已 parse 入口），
 * 分别服务于“模型不可信调用”和“测试/内部可信调用”两种场景。
 */
export function defineTool<
  const Name extends string,
  Input,
  Output extends JsonValue,
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
  /**
   * checkAccess：执行前的“前置闸门”——取消 + 权限。
   * 故意返回 undefined 表示放行、返回 ToolFailure 表示拒绝，让调用点用一行 if 处理。
   * 顺序很重要：先看 signal（取消最优先），再看权限（避免被取消的请求还做权限判断）。
   */
  function checkAccess(context: ToolContext): ToolFailure | undefined {
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

  /**
   * executeParsed：从“已 parse 的 Input”走到底。
   *
   * 它是 invokeParsed 的实现，也是 invokeRaw parse 成功后的下半段，避免重复逻辑。
   * 异常分类策略：
   *   - accessError 不空 -> 直接返回结构化失败（FORBIDDEN / CANCELLED）；
   *   - execute 抛错 + 信号已取消 -> CANCELLED（把取消视作一等公民）；
   *   - execute 抛错 + 信号未取消 -> EXECUTION_FAILED（保留 cause 供日志）；
   *   - 输出未通过 validateJsonValue -> INVALID_OUTPUT（静态类型不能当运行时证据）。
   */
  async function executeParsed(
    input: Input,
    context: ToolContext,
  ): Promise<ToolExecutionResult<Output>> {
    const accessError = checkAccess(context);
    if (accessError !== undefined) return { ok: false, error: accessError };

    try {
      const rawOutput: unknown = await definition.execute(input, context);
      // execute 签名要求返回 Output（静态层面是 JsonValue 的子类型），
      // 但 TS 无法在运行时证明这一点，必须再走 validateJsonValue 做真实克隆+校验。
      const validated = validateJsonValue(rawOutput);
      if (!validated.ok) {
        return {
          ok: false,
          error: { code: 'INVALID_OUTPUT', issues: validated.issues },
        };
      }
      // Output 的静态契约由 defineTool execute 签名检查；运行时 clone 已证明 JsonValue。
      return { ok: true, value: validated.value as Output };
    } catch (cause: unknown) {
      // 二次检查 signal：很多异步原语在被取消时也会抛错，应归为 CANCELLED 而非 EXECUTION_FAILED。
      return context.signal.aborted
        ? { ok: false, error: cancelled(context.signal) }
        : { ok: false, error: { code: 'EXECUTION_FAILED', cause } };
    }
  }

  // 返回的对象：descriptor（对外协议层）+ inputSchema（运行时 schema）+ 两个入口方法。
  return {
    // descriptor：剥掉 inputSchema 的运行时部分，只暴露 JsonSchema 子集给模型。
    // 条件展开 ...(requiredPermission === undefined ? {} : {...}) 让“无权限要求”时 descriptor 完全不带这个 key，
    // 而不是带一个 undefined，便于 JSON Schema 序列化时干净。
    descriptor: {
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema.jsonSchema,
      ...(definition.requiredPermission === undefined
        ? {}
        : { requiredPermission: definition.requiredPermission }),
    },
    inputSchema: definition.inputSchema,

    /**
     * invokeRaw：从“不可信 unknown”入口。
     *
     * 安全顺序（很重要）：
     *   1) access 检查在 parse 之前——未授权就不返回字段级 issue，防止协议探测；
     *   2) parse 失败 -> INVALID_ARGUMENTS（带 JSON Pointer，便于模型自我修正）；
     *   3) parse 成功 -> 复用 executeParsed 完成执行+输出校验。
     */
    async invokeRaw(raw, context) {
      // 未授权调用不返回字段级解析错误，避免协议探测。
      const accessError = checkAccess(context);
      if (accessError !== undefined) return { ok: false, error: accessError };

      let parsed: ReturnType<Schema<Input>['safeParse']>;
      try {
        // safeParse 内部不应抛——但自定义 transform/refine 仍可能抛异常，
        // 这里包一层 try，把它归类成 EXECUTION_FAILED（工具作者/Schema 的实现缺陷，不是用户错）。
        parsed = definition.inputSchema.safeParse(raw);
      } catch (cause: unknown) {
        // Schema 抛异常表示工具实现缺陷，不是用户参数错误。
        return { ok: false, error: { code: 'EXECUTION_FAILED', cause } };
      }
      if (!parsed.ok) {
        return {
          ok: false,
          error: { code: 'INVALID_ARGUMENTS', issues: parsed.error },
        };
      }
      return executeParsed(parsed.value, context);
    },

    invokeParsed(input, context) {
      // transform 后领域值不能再次被当作 wire input parse。
      // 这条路径假定 input 已经是 Input（如测试/内部调用），跳过 parse 直跑 execute。
      return executeParsed(input, context);
    },
  };
}

/**
 * DuplicateNames：编译期检测“同一组工具里是否有重名”。
 *
 * 工作方式（递归类型）：
 *   - 拆出元组首元素 Head 和剩余 Tail；
 *   - 如果 Head 的名字已经在累计集合 Seen 中，它就是“重名”，加入结果联合；
 *   - 否则把它的名字并入 Seen 继续看 Tail；
 *   - 全部走完返回 never 表示“没有重名”。
 *
 * 这是类型层的“集合成员判定”，结果会被 UniqueConstraint 用来在 createToolRegistry 调用点报错。
 */
type DuplicateNames<
  Tools extends readonly AnyTool[],
  Seen extends string = never,
> = Tools extends readonly [
  infer Head extends AnyTool,
  ...infer Tail extends readonly AnyTool[],
]
  ? Head['descriptor']['name'] extends Seen
    ? Head['descriptor']['name'] | DuplicateNames<Tail, Seen>
    : DuplicateNames<Tail, Seen | Head['descriptor']['name']>
  : never;

/**
 * UniqueConstraint：把“有重名”变成“类型不匹配”。
 *
 *   - 无重名时 DuplicateNames = never，[never] extends [never] 成立 -> unknown，参数类型正常；
 *   - 有重名时返回一个带 __duplicateToolNames 字段的对象，与实参 tools 的真实类型不匹配，
 *     tsc 直接在调用点报错，列出重名的字面量。
 *
 * 注意 [DuplicateNames<Tools>] extends [never] 外面那对方括号：这是为了“阻止分布性”，
 * 让 union 类型不会被拆开判断，整体当作一个类型看待。
 */
type UniqueConstraint<Tools extends readonly AnyTool[]> =
  [DuplicateNames<Tools>] extends [never]
    ? unknown
    : { readonly __duplicateToolNames: DuplicateNames<Tools> };

/**
 * ToolRegistry：把一篮子工具按 name 建立查询的容器。
 *
 * 类型参数 Tools 保留元组顺序，因此：
 *   - descriptors() 返回的数组顺序就是注册顺序；
 *   - invokeKnown 可以按字面量 name 精确恢复 Input/Output 类型。
 *
 * const Tools 让调用点 `as const` 的字面量元组（如 readonly [sumTool, searchDocsTool]）
 * 原样进入类型参数，每个工具的名字仍是字面量而不是被拓宽成 string。
 */
export class ToolRegistry<const Tools extends readonly AnyTool[]> {
  // #byName：私有 Map，把工具名映射回工具实例。private field (#) 防止外部直接绕过方法。
  readonly #byName: ReadonlyMap<string, AnyTool>;

  /**
   * 构造函数：拷贝入参数组，并按 name 建索引。
   *
   * 这里再做一次运行时重名检查（即使 type-contracts.ts 已做编译期检查）：
   *   - 编译期检查依赖 `as const`；动态拼出的 tools 数组没有字面量信息，无法触发；
   *   - 运行时检查兜底，让动态构造也不会得到一个会“互相覆盖”的注册表。
   */
  constructor(readonly tools: Tools) {
    const byName = new Map<string, AnyTool>();
    for (const tool of tools) {
      const name = tool.descriptor.name;
      if (byName.has(name)) throw new Error(`工具名重复: ${name}`);
      byName.set(name, tool);
    }
    this.#byName = byName;
  }

  /**
   * descriptors：返回所有工具的 ToolDescriptor 列表，传给 ModelRequest.tools。
   *
   * 用 structuredClone 做深拷贝：调用方（尤其是模型适配器）可能修改 descriptor，
   * 深拷贝保护注册表内部状态不被外部改动污染。
   */
  descriptors(): readonly ToolDescriptor[] {
    return structuredClone(this.tools.map((tool) => tool.descriptor));
  }

  /**
   * invokeDynamic：按字符串 name 调用工具，输入是 unknown。
   *
   * 用于“模型运行时决定调哪个工具”的场景：
   *   - 静态类型上 Output 退化为 JsonValue（具体哪个工具未知）；
   *   - 未注册的 name 直接返回 UNKNOWN_TOOL，不抛错；
   *   - 调用 tool.invokeRaw，安全链路（access -> parse -> execute -> 输出校验）完整生效。
   */
  invokeDynamic(
    name: string,
    raw: unknown,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const tool = this.#byName.get(name);
    if (tool === undefined) {
      // 用 Promise.resolve 而不是 async，让“未注册”这条快路径同步 resolve，减少微任务跳数。
      return Promise.resolve({
        ok: false,
        error: { code: 'UNKNOWN_TOOL', toolName: name },
      });
    }
    return tool.invokeRaw(raw, context);
  }

  /**
   * invokeKnown：按字面量 name 调用，输入/输出类型精确恢复。
   *
   * 类型层的魔法：
   *   - Name extends ToolName<Tools> 限定只能传真实存在的工具名（typo 直接报错）；
   *   - InputOf<ToolByName<Tools, Name>> 推断出该工具的 Input，input 参数必须匹配；
   *   - 返回值 Promise<ToolExecutionResult<OutputOf<...>>> 让调用方拿到精确 Output。
   *
   * 与 invokeDynamic 的区别：用 invokeParsed 跳过 parse，假定 input 已是领域类型。
   * 适合“内部直接调用 / 单元测试”等可信场景。
   */
  invokeKnown<Name extends ToolName<Tools>>(
    name: Name,
    input: InputOf<ToolByName<Tools, Name>>,
    context: ToolContext,
  ): Promise<ToolExecutionResult<OutputOf<ToolByName<Tools, Name>>>> {
    // 内部 #byName 是按 string 索引的（运行时只能是 string），这里要把它转回精确类型。
    const erased = this.#byName.get(name);
    if (erased === undefined) {
      return Promise.resolve({
        ok: false,
        error: { code: 'UNKNOWN_TOOL', toolName: name },
      });
    }

    // Map 只按 descriptor.name 建立并拒绝重复，故此处可恢复具体 name/input/output。
    // as 断言是安全的：name 是 ToolName<Tools> 的字面量，ToolByName 一定能从 union 里挑出唯一对应分支。
    const tool = erased as ToolByName<Tools, Name>;
    return tool.invokeParsed(input, context);
  }
}

/**
 * createToolRegistry：ToolRegistry 的推荐入口。
 *
 * 唯一作用：在调用点把 UniqueConstraint<Tools> 写进参数类型，
 * 让“tools 数组里出现重名”在编译期就被 tsc 标红，而不用等到运行时抛 Error。
 *
 * 配合 `as const` 使用，能把整套静态契约发挥到极致（见 type-contracts.ts）。
 */
export function createToolRegistry<const Tools extends readonly AnyTool[]>(
  tools: Tools & UniqueConstraint<Tools>,
): ToolRegistry<Tools> {
  return new ToolRegistry(tools);
}
