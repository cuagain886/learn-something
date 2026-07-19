/**
 * ============================================================
 * 第 27 课：类型级算法、递归预算与 Checker 性能
 * ============================================================
 *
 * TypeScript 类型系统可以做字符串拆分、联合分发、递归映射等计算，但 Checker
 * 必须在编辑器每次悬停/补全时求值。类型级算法的正确性和计算成本同样重要。
 *
 * 运行（实际是独立类型检查 + 性能统计）：npm run lesson:type-performance
 *
 * 本文件没有运行时输出，因为下面所有 type 都会被擦除。学习重点是：
 *   1. 条件类型如何对联合分发
 *   2. infer 如何做模式匹配
 *   3. accumulator 如何把递归改成更接近尾递归
 *   4. 显式 Depth 参数如何限制递归展开
 *   5. 命名中间类型为何有助于缓存和可读错误
 *   6. @ts-expect-error 如何锁定负向类型契约
 */

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Condition extends true> = Condition;

// ------------------------------------------------------------
// 1. 分布式条件类型：裸类型参数会逐个处理联合成员
// ------------------------------------------------------------
type ToArray<Member> = Member extends unknown ? Member[] : never;
type ToArrayAsWhole<Value> = [Value] extends [unknown] ? Value[] : never;

type Distributed = ToArray<string | number>;       // string[] | number[]
type NonDistributed = ToArrayAsWhole<string | number>; // (string | number)[]

type _Distributed = Expect<Equal<Distributed, string[] | number[]>>;
type _NonDistributed = Expect<Equal<NonDistributed, (string | number)[]>>;

// ------------------------------------------------------------
// 2. infer + 模板字面量：从路由字符串提取参数键
// ------------------------------------------------------------
type SegmentParameter<Segment extends string> =
  Segment extends `:${infer Name}` ? Name : never;

type RouteParameterNames<
  Path extends string,
  Accumulator extends string = never,
> = Path extends `${infer Head}/${infer Tail}`
  ? RouteParameterNames<Tail, Accumulator | SegmentParameter<Head>>
  : Accumulator | SegmentParameter<Path>;

type Simplify<ObjectType> = {
  [Key in keyof ObjectType]: ObjectType[Key];
} & {};

type RouteParameters<Path extends string> = string extends Path
  ? Record<string, string>
  : Simplify<{
      [Name in RouteParameterNames<Path>]: string;
    }>;

type ToolRoute = RouteParameters<'/runs/:runId/tools/:toolName'>;
type _ToolRoute = Expect<Equal<
  ToolRoute,
  { runId: string; toolName: string }
>>;

// 宽 string 无法在编译期枚举键，因此退化成 Record，而不是假装没有参数。
type DynamicRoute = RouteParameters<string>;
type _DynamicRoute = Expect<Equal<DynamicRoute, Record<string, string>>>;

// ------------------------------------------------------------
// 3. 尾递归 accumulator：减少中间类型构造
// ------------------------------------------------------------
// 非尾递归版本每层都要等待递归结果，再构造 `Character | Result`：
type CharactersNonTail<Text extends string> =
  Text extends `${infer Character}${infer Rest}`
    ? Character | CharactersNonTail<Rest>
    : never;

// accumulator 版本的递归分支直接返回下一次条件类型调用，更容易被 Checker 优化：
type Characters<
  Text extends string,
  Accumulator extends string = never,
> = Text extends `${infer Character}${infer Rest}`
  ? Characters<Rest, Accumulator | Character>
  : Accumulator;

type AgentCharacters = Characters<'agent'>;
type _AgentCharacters = Expect<Equal<AgentCharacters, 'a' | 'g' | 'e' | 'n' | 't'>>;

// 小输入的非尾递归结果相同；大输入时 accumulator 通常产生更少中间实例。
type _BothAlgorithmsAgree = Expect<Equal<
  CharactersNonTail<'tool'>,
  Characters<'tool'>
>>;

// ------------------------------------------------------------
// 4. 用 tuple 长度做小规模自然数运算
// ------------------------------------------------------------
type BuildTuple<
  Length extends number,
  Accumulator extends unknown[] = [],
> = Accumulator['length'] extends Length
  ? Accumulator
  : BuildTuple<Length, [...Accumulator, unknown]>;

type Decrement<Value extends number> =
  BuildTuple<Value> extends [unknown, ...infer Rest]
    ? Rest['length']
    : 0;

type _TupleLength = Expect<Equal<BuildTuple<5>['length'], 5>>;
type _Decrement = Expect<Equal<Decrement<5>, 4>>;

// 这种算法适合很小的配置深度，不适合在类型层做大整数计算。

// ------------------------------------------------------------
// 5. DeepReadonly 带显式递归预算，避免对任意输入无限展开
// ------------------------------------------------------------
type DeepReadonly<
  Value,
  Depth extends number = 5,
> = Depth extends 0
  ? Value
  : Value extends (...args: never[]) => unknown
    ? Value
    : Value extends readonly (infer Item)[]
      ? ReadonlyArray<DeepReadonly<Item, Decrement<Depth>>>
      : Value extends object
        ? {
            readonly [Key in keyof Value]: DeepReadonly<
              Value[Key],
              Decrement<Depth>
            >;
          }
        : Value;

type NestedConfig = {
  level1: {
    level2: {
      level3: {
        value: string;
      };
    };
  };
};

type LimitedReadonly = DeepReadonly<NestedConfig, 2>;

declare let limited: LimitedReadonly;
if (false) {
  // @ts-expect-error 第 1 层在预算内，因此 readonly
  limited.level1 = { level2: { level3: { value: 'x' } } };

  // @ts-expect-error 第 2 层在预算内，因此 readonly
  limited.level1.level2 = { level3: { value: 'x' } };

  // 深度预算耗尽后保留原类型；这是有意的性能/精度边界。
  limited.level1.level2.level3.value = 'allowed beyond depth budget';
}

// ------------------------------------------------------------
// 6. 联合转交叉：依赖函数参数逆变位置
// ------------------------------------------------------------
type UnionToIntersection<Union> = (
  Union extends unknown ? (value: Union) => void : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never;

type Handlers = UnionToIntersection<
  | { onStart(): void }
  | { onFinish(): void }
>;

type _Handlers = Expect<Equal<
  Handlers,
  { onStart(): void } & { onFinish(): void }
>>;

// 这类技巧可封装在库内部，但不应成为业务代码的日常阅读负担。

// ------------------------------------------------------------
// 7. 命名复杂类型，避免调用点反复实例化匿名条件表达式
// ------------------------------------------------------------
type ToolProtocol = {
  search: {
    input: { query: string };
    output: { hits: readonly string[] };
  };
  sum: {
    input: { values: readonly number[] };
    output: { sum: number };
  };
};

type ToolResult<
  Protocol,
  Name extends keyof Protocol,
> = Protocol[Name] extends { output: infer Output }
  ? Output
  : never;

// 对外 API 复用命名别名；Checker 更容易缓存，错误信息也显示 ToolResult 而非整段展开。
declare function invoke<Name extends keyof ToolProtocol>(
  name: Name,
): Promise<ToolResult<ToolProtocol, Name>>;

if (false) {
  const search = await invoke('search');
  const first: string | undefined = search.hits[0];
  void first;

  // @ts-expect-error search 输出没有 sum
  void search.sum;
}

// ------------------------------------------------------------
// 8. 类型复杂度守则
// ------------------------------------------------------------
// - 能用普通属性/联合表达的，不写递归条件类型。
// - 递归泛型接收 Depth/Seen 预算。
// - 明确要逐成员处理还是整体判断，控制分布。
// - 为公共复杂类型命名，避免巨大匿名推断泄漏到 .d.ts。
// - 对超大联合、模板字面量笛卡尔积保持警惕。
// - 用 --extendedDiagnostics / --generateTrace 测量，不凭肉眼猜性能。
// - 类型算法必须有正向、负向和边界类型测试。

export {};

