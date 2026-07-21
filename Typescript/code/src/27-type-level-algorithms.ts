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

// 编译期断言工具：Equal / Expect。本身不出现在运行时，只用于在文件里写
//   type _X = Expect<Equal<Actual, Expected>>
// 来约束“实际推断出的类型必须等于期望”。若不等，tsc 在该行直接报错。
// Equal 利用“函数类型在比较时更高阶等价判定”，比 A extends B 更严格。
type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2)
    ? true
    : false;
// Expect：把“必须为 true”这个约束编码进类型 —— 任何非 true 都无法 extends true。
type Expect<Condition extends true> = Condition;

// ------------------------------------------------------------
// 1. 分布式条件类型：裸类型参数会逐个处理联合成员
// ------------------------------------------------------------
// 关键规则：当条件类型写成 `T extends U ? X : Y` 且 T 是“裸类型参数”，
// TS 会把 T 是联合时拆开，对每个成员单独求值，再把结果联合起来。
type ToArray<Member> = Member extends unknown ? Member[] : never;
// 用 [Value] 把 T 包进元组，T 就不再是“裸类型参数”，不再分布 —— 整体判断一次。
type ToArrayAsWhole<Value> = [Value] extends [unknown] ? Value[] : never;

type Distributed = ToArray<string | number>;       // string[] | number[]
type NonDistributed = ToArrayAsWhole<string | number>; // (string | number)[]

// 编译期断言：分布版得到 string[] | number[]；非分布版得到 (string | number)[]。
type _Distributed = Expect<Equal<Distributed, string[] | number[]>>;
type _NonDistributed = Expect<Equal<NonDistributed, (string | number)[]>>;

// ------------------------------------------------------------
// 2. infer + 模板字面量：从路由字符串提取参数键
// ------------------------------------------------------------
// SegmentParameter：用模板字面量模式匹配。
// 如果 Segment 形如 `:${Name}`，则通过 infer 把 Name 捕获出来；否则返回 never。
type SegmentParameter<Segment extends string> =
  Segment extends `:${infer Name}` ? Name : never;

// RouteParameterNames：递归扫描“以 / 分隔的路径”，把所有形如 :xxx 的段名收集成联合。
// Accumulator 是“当前已收集的键”，初始为 never（联合的零元）。
type RouteParameterNames<
  Path extends string,
  Accumulator extends string = never,
> = Path extends `${infer Head}/${infer Tail}`
  // 还能拆出 Head/Tail：把 Head 的参数键并入 Accumulator，对 Tail 继续递归。
  ? RouteParameterNames<Tail, Accumulator | SegmentParameter<Head>>
  // 没有更多 / 了：把最后一段 Path 本身也丢进 SegmentParameter 处理后并入。
  : Accumulator | SegmentParameter<Path>;

// Simplify：用映射类型“重新构造”一个对象类型，把内部复杂的交叉/映射压平显示。
// `& {}` 让结果在 IDE hover 里展示为展开的对象字面量，而不是别名形式。
type Simplify<ObjectType> = {
  [Key in keyof ObjectType]: ObjectType[Key];
} & {};

// RouteParameters：把路径里所有参数键名映射成 `{ 键: string }` 的对象类型。
// 特例：如果调用方传的就是宽 string（不是字面量），无法在编译期枚举键 —— 此时
// 退化成 Record<string, string>，避免给出一个“假装没有参数”的过度精确类型。
type RouteParameters<Path extends string> = string extends Path
  ? Record<string, string>
  : Simplify<{
      [Name in RouteParameterNames<Path>]: string;
    }>;

// 对字面量路径：精确推断出 { runId: string; toolName: string }。
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
// 递归返回后还要做一次 | 操作，TS Checker 必须为每层保留中间实例。
type CharactersNonTail<Text extends string> =
  Text extends `${infer Character}${infer Rest}`
    ? Character | CharactersNonTail<Rest>
    : never;

// accumulator 版本的递归分支直接返回下一次条件类型调用，更容易被 Checker 优化：
// 每一层不需要“等子结果再合并”，结果沿 Accumulator 一路传递，相当于尾递归形式。
type Characters<
  Text extends string,
  Accumulator extends string = never,
> = Text extends `${infer Character}${infer Rest}`
  ? Characters<Rest, Accumulator | Character>
  : Accumulator;

// 拆出 'agent' 每一个字符作为联合成员。
type AgentCharacters = Characters<'agent'>;
type _AgentCharacters = Expect<Equal<AgentCharacters, 'a' | 'g' | 'e' | 'n' | 't'>>;

// 小输入的非尾递归结果相同；大输入时 accumulator 通常产生更少中间实例。
// 这是一个回归断言：两种算法语义等价（在没触发深度/复杂度限制的输入范围内）。
type _BothAlgorithmsAgree = Expect<Equal<
  CharactersNonTail<'tool'>,
  Characters<'tool'>
>>;

// ------------------------------------------------------------
// 4. 用 tuple 长度做小规模自然数运算
// ------------------------------------------------------------
// TS 没有类型层整数算术，但 tuple 的 length 是一个编译期已知数字，
// 可以用它“以结构换计算”：构造一个长度为 Length 的元组。
type BuildTuple<
  Length extends number,
  Accumulator extends unknown[] = [],
> = Accumulator['length'] extends Length
  // 长度已达到：返回当前 tuple。length 是 tuple 的字面量长度属性（编译期常量）。
  ? Accumulator
  // 否则继续追加一个元素，直到长度匹配。
  : BuildTuple<Length, [...Accumulator, unknown]>;

// Decrement：用模式匹配剥掉 tuple 第一个元素，剩下的 length 就是 Value - 1。
// 若 tuple 为空（理论上 Value=0），结果退化为 0，避免越界。
type Decrement<Value extends number> =
  BuildTuple<Value> extends [unknown, ...infer Rest]
    ? Rest['length']
    : 0;

// 编译期断言：BuildTuple<5> 长度恰好是 5；Decrement<5> 等于 4。
type _TupleLength = Expect<Equal<BuildTuple<5>['length'], 5>>;
type _Decrement = Expect<Equal<Decrement<5>, 4>>;

// 这种算法适合很小的配置深度，不适合在类型层做大整数计算。

// ------------------------------------------------------------
// 5. DeepReadonly 带显式递归预算，避免对任意输入无限展开
// ------------------------------------------------------------
// DeepReadonly：递归给每一层套上 readonly。
// 关键设计：Depth 参数作为“递归预算”，每深入一层 Decrement<Depth>，
// 到 Depth=0 时停止递归、保留原类型。这样无论输入多深，展开都有上界。
type DeepReadonly<
  Value,
  Depth extends number = 5,
> = Depth extends 0
  // 预算耗尽：原样返回，不再加 readonly —— 这是有意的精度/性能边界。
  ? Value
  : Value extends (...args: never[]) => unknown
    // 函数类型：不能给函数套 readonly，原样返回。
    ? Value
    : Value extends readonly (infer Item)[]
      // 数组：把元素类型递归 readonly，整体包成 ReadonlyArray。
      ? ReadonlyArray<DeepReadonly<Item, Decrement<Depth>>>
      : Value extends object
        // 普通对象：每个属性都递归 readonly。
        ? {
            readonly [Key in keyof Value]: DeepReadonly<
              Value[Key],
              Decrement<Depth>
            >;
          }
        // 基础类型（string/number/...）：原样返回。
        : Value;

// NestedConfig：三层嵌套对象，用来验证 Depth 预算的边界行为。
type NestedConfig = {
  level1: {
    level2: {
      level3: {
        value: string;
      };
    };
  };
};

// Depth=2：前两层被 readonly，第三层（level3.value）超出预算、保留可写。
type LimitedReadonly = DeepReadonly<NestedConfig, 2>;

// declare：仅声明变量类型，不真正创建运行时值。这里只为写赋值兼容性的负向断言。
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
// 经典技巧：先让联合的每个成员变成“一个接收它自己的函数”，
// 于是得到 `((a)=>void) | ((b)=>void)` 形式的联合。
// 再用 infer 反推“什么函数能同时被这些函数的并集赋值” ——
// 由于函数参数是逆变位置，TS 必须取它们的交集，于是得到 a & b。
type UnionToIntersection<Union> = (
  Union extends unknown ? (value: Union) => void : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never;

// 把两个 handler 接口的联合转成交叉，得到同时具备 onStart 和 onFinish 的对象类型。
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
// ToolProtocol：把“每个工具的 input/output 类型”集中声明。
// 后续泛型可以从这里取出某个工具的精确类型，避免在调用点写一大段条件类型。
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

// ToolResult：从协议里取出指定工具的 output 类型。
// 命名后，调用点写 ToolResult<...> 即可，错误信息也会以 ToolResult 出现，
// 而不是把整段条件类型展开在错误里。
type ToolResult<
  Protocol,
  Name extends keyof Protocol,
> = Protocol[Name] extends { output: infer Output }
  ? Output
  : never;

// 对外 API 复用命名别名；Checker 更容易缓存，错误信息也显示 ToolResult 而非整段展开。
// 这里用 invoke 模拟“根据工具名拿对应结果类型”的强类型入口。
declare function invoke<Name extends keyof ToolProtocol>(
  name: Name,
): Promise<ToolResult<ToolProtocol, Name>>;

if (false) {
  // invoke('search') 返回 Promise<{ hits: readonly string[] }>，
  // 因此 search.hits[0] 的类型是 string | undefined（数组可能为空）。
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
