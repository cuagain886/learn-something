# 20 · 类型级算法与编译性能：控制联合分发、递归深度和实例化规模 ⭐⭐⭐

TypeScript 类型系统可以做条件分支、模式匹配、递归和数据结构变换，但它不是为通用计算设计的虚拟机。类型级程序的“输出”是开发体验，而它的运行成本由 `tsc`、编辑器语言服务和所有下游使用者共同承担。

配套实验：[`../code/src/27-type-level-algorithms.ts`](../code/src/27-type-level-algorithms.ts)。独立执行：

```bash
npm run lesson:type-performance
```

脚本使用 `--extendedDiagnostics` 打印 `Types`、`Instantiations`、内存和检查时间，避免只靠“编辑器好像有点卡”判断。

---

## 1. 类型检查器到底在计算什么

看到：

```ts
type Result<T> = T extends PromiseLike<infer U> ? U : T;
```

可以把检查器的工作粗略理解为：

1. 为语法中的声明建立 symbol；
2. 按需构造 type；
3. 用具体类型参数实例化泛型别名；
4. 归约条件类型、映射类型、索引访问和模板字面量；
5. 比较源类型与目标类型是否相关、可赋值或相同；
6. 缓存部分结果，供相同关系再次使用。

“按需”和“缓存”很重要：复杂类型不是都在文件打开时一次性完全展开，同一个有名字、可缓存的关系也可能复用结果。因此源码字符数与检查成本并不成正比。

一个 5 行递归条件类型可能比 100 行普通接口更贵。

---

## 2. 先认识可观测指标

`tsc --extendedDiagnostics` 常见输出：

| 指标 | 它大致反映什么 |
|---|---|
| `Files` | 当前 program 纳入了多少源码和声明文件 |
| `Lines of Library` | 标准库声明规模 |
| `Lines of Definitions` | 第三方 `.d.ts` 规模 |
| `Lines of TypeScript` | 项目 TS 源码规模 |
| `Identifiers` | 标识符节点数量 |
| `Symbols` | binder/checker 建立的符号规模 |
| `Types` | 创建的类型对象数量 |
| `Instantiations` | 泛型类型实例化数量 |
| `Memory used` | 编译进程占用内存 |
| `Parse/Bind/Check time` | 各阶段耗时 |

它们是诊断信号，不是单一 KPI。

- `Files` 或定义行数暴涨：先查错误的 include、重复 `@types` 和巨型声明依赖。
- `Instantiations` 很高：重点查递归泛型、分发条件类型、模板字符串组合。
- `Check time` 高但实例化不突出：可能是大型联合之间的关系比较、交叉类型、重载或复杂推断。
- 内存很高：可能是 program 太大，也可能是大量中间类型无法有效复用。

不同机器、TypeScript 版本和冷/热缓存不能直接横比。应在固定环境重复运行，比较同一基线的变化趋势。

---

## 3. 分发条件类型：一个裸类型参数就是隐式循环

```ts
type ToArray<T> = T extends unknown ? T[] : never;
type R = ToArray<string | number>; // string[] | number[]
```

当条件左侧是裸类型参数 `T` 时，联合会分发：

```text
ToArray<A | B | C>
≈ ToArray<A> | ToArray<B> | ToArray<C>
```

这非常有用，但也意味着联合大小是工作量的乘数。如果内部又嵌套另一个分发条件，组合数量可能继续增长。

### 关闭分发

```ts
type IsString<T> = T extends string ? true : false;
type IsEntirelyString<T> = [T] extends [string] ? true : false;
```

元组包装让左侧不再是裸类型参数：

```ts
type A = IsString<string | number>;          // true | false
type B = IsEntirelyString<string | number>;  // false
```

这不只是优化技巧，首先是语义选择：你要逐成员判断，还是判断整个联合？只有语义是“整体判断”时才应该关闭分发。

### 联合的笛卡尔积

模板字面量会组合插值位置的联合：

```ts
type Verb = "GET" | "POST" | "DELETE";
type Resource = "users" | "orders" | "files";
type Route = `${Verb} /${Resource}`; // 3 × 3 = 9 个成员
```

再加入版本、区域、动作后，规模是各维度基数之积。看似短小的类型表达式可能生成数千个字符串字面量。

若这些值本来来自运行时配置，未必应该穷举成一个巨大联合。可以保留品牌字符串或由代码生成阶段产出声明。

---

## 4. 递归条件类型是在建立实例化链

路由参数解析器：

```ts
type RouteParams<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? { [K in Param | keyof RouteParams<Rest>]: string }
    : Path extends `${string}:${infer Param}`
      ? { [K in Param]: string }
      : {};
```

检查器每匹配一段路径，都要用新的 `Rest` 实例化 `RouteParams`。递归深度随路径段数量增长。

TypeScript 会限制可能无限或过深的类型实例化，并报类似：

```text
Type instantiation is excessively deep and possibly infinite.
```

这不是固定“递归 N 次必报错”的语言契约。检查器包含启发式优化，TypeScript 版本、递归形状和中间类型规模都会影响边界。不要让公开 API 依赖刚好低于某个内部阈值。

---

## 5. 尾递归累加器为什么通常更稳

非尾递归形式：

```ts
type Chars<S extends string> =
  S extends `${infer Head}${infer Tail}`
    ? Head | Chars<Tail>
    : never;
```

递归返回后还要构造 `Head | ...`，所以每层都保留一个待完成的外层结构。

累加器形式：

```ts
type CharsTail<
  S extends string,
  Acc extends string = never,
> = S extends `${infer Head}${infer Tail}`
  ? CharsTail<Tail, Acc | Head>
  : Acc;
```

递归分支直接返回另一次条件类型调用，已经得到的结果放入 `Acc`。TypeScript 对部分尾递归条件类型可以避免建立大量中间实例化结构。

### 但尾递归不是无限许可证

- `Acc` 自身可能越来越复杂；
- 分支中出现联合分发后，仍会形成多条递归路径；
- 模板字面量可能产生大规模组合；
- 尾递归优化是检查器实现能力，不是让类型系统承担任意解析器的理由。

优化前先问：这个计算是否真的必须发生在每个使用者的类型检查阶段？

---

## 6. 给递归 API 显式深度预算

无限递归的 `DeepReadonly<T>` 对自引用结构尤其危险：

```ts
interface TreeNode {
  value: string;
  children: TreeNode[];
}
```

更可控的设计把深度变成显式参数：

```ts
type BuildTuple<N extends number, Acc extends unknown[] = []> =
  Acc["length"] extends N ? Acc : BuildTuple<N, [...Acc, unknown]>;

type Decrement<N extends number> =
  BuildTuple<N> extends [unknown, ...infer Rest] ? Rest["length"] : 0;

type DeepReadonly<T, Depth extends number = 4> =
  Depth extends 0
    ? T
    : T extends (...args: never[]) => unknown
      ? T
      : T extends readonly unknown[]
        ? { readonly [K in keyof T]: DeepReadonly<T[K], Decrement<Depth>> }
        : T extends object
          ? { readonly [K in keyof T]: DeepReadonly<T[K], Decrement<Depth>> }
          : T;
```

这建立了清晰契约：前 4 层深只读，更深处保持原类型。它可能不如“无限深”听起来漂亮，但对性能和可解释性更诚实。

### 深度归零后返回什么

常见选择：

- 返回原 `T`：保留信息，但更深层不再变换；
- 返回 `unknown`：阻止继续依赖深层结构；
- 返回近似宽类型：例如 `Record<string, unknown>`；
- 产生品牌化截断标记：便于调试，但增加类型复杂度。

这是 API 语义，应该记录在文档和类型测试中。

### 数字元组也有成本

`BuildTuple<1000>` 自己就是长递归。若只支持少量固定深度，手写查询表更便宜：

```ts
type Previous = [never, 0, 1, 2, 3, 4, 5];
type Prev<N extends keyof Previous> = Previous[N];
```

类型级算术不是免费的基础设施。

---

## 7. 交叉类型会把关系比较推迟到以后

```ts
type Combined = A & B & C;
```

交叉类型并不总会立即“拍平”为一个普通对象。检查器在后续关系比较、属性查找和声明展示中可能反复处理组成部分。层层 `&` 组合大型对象，会让错误信息和性能一起恶化。

对于稳定的对象形状，命名接口及 `extends` 往往更容易缓存：

```ts
interface Combined extends A, B, C {
  own: string;
}
```

但不能机械替换：接口扩展要求可静态确定的对象成员，对联合和某些映射结果不适用；同名属性冲突的语义也与交叉不同。

性能建议必须服从正确语义。

---

## 8. 给复杂类型命名，帮助检查器也帮助人

内联一个巨大条件类型：

```ts
function load<T>(input: T):
  T extends A ? X : T extends B ? Y : T extends C ? Z : Fallback {
  // ...
}
```

如果它在许多签名中重复，检查器更难复用，人也更难读错误。提取名字：

```ts
type LoadResult<T> =
  T extends A ? X :
  T extends B ? Y :
  T extends C ? Z :
  Fallback;

function load<T>(input: T): LoadResult<T> {
  // ...
}
```

显式返回类型还有两个收益：

- 避免跨模块反复推断庞大实现细节；
- 生成的 `.d.ts` 更稳定，不会把内部类型传播到公共 API。

命名不是保证优化的魔法，但它给缓存和诊断提供了稳定边界。

---

## 9. 推断越多不一定越好

局部变量推断通常简洁且便宜，但大型导出值可能把实现中的联合、闭包和泛型全部带进公共类型：

```ts
export const registry = buildRegistry(/* 大量链式调用 */);
```

为导出边界提供有意设计的注解：

```ts
export const registry: ToolRegistry = buildRegistry(/* ... */);
```

好处不是“让编译器不用检查实现”。实现仍须可赋值给 `ToolRegistry`。真正收益是：

- 下游只依赖稳定表面；
- 声明 emit 不复制巨型推断结果；
- 错误更靠近构造处；
- 小改实现不导致大面积类型失效。

但若注解过宽，会丢失调用方需要的字面量关联。可用 `satisfies` 检查形状，同时保留值自身更具体的推断，再在真正的公共边界收窄表面。

---

## 10. 重载、大型联合和相关性比较

大量函数重载可能让每次调用都尝试多个候选：

```ts
declare function invoke(name: "a", input: A): RA;
declare function invoke(name: "b", input: B): RB;
// 数十个重载……
```

工具注册表常见更好的表达是键到协议的映射：

```ts
interface ToolMap {
  search: { input: SearchInput; output: SearchOutput };
  summarize: { input: SummaryInput; output: SummaryOutput };
}

function invoke<K extends keyof ToolMap>(
  name: K,
  input: ToolMap[K]["input"],
): Promise<ToolMap[K]["output"]> {
  // 动态边界内部仍需局部实现
}
```

不过如果 `K` 在实现内仍是联合，`name` 和 `input` 的相关性可能丢失，不能指望泛型自动完成运行时分派证明。注册表实现处通常需要：

- 判别联合；
- 每工具闭包封装；
- 或一个经过审计的局部不安全桥接。

不要为了消灭一处断言，构造指数级复杂的公共条件类型。

---

## 11. Agent 项目中最常见的类型爆炸来源

### 把全部工具转成巨大联合

```ts
type AllCalls = {
  [K in keyof Tools]: {
    name: K;
    input: InputOf<Tools[K]>;
  }
}[keyof Tools];
```

几十个工具时很实用；几百个工具、每个 schema 又包含复杂联合时，任何二次映射和分发都可能放大成本。

可以按工具域拆注册表，运行时再组合；模型每轮通常也不需要看到全部工具。

### 从 schema 反复深度推导

一套深递归 schema inference 被嵌入每个中间构造器，会产生大量近似实例化。应把推导结果命名，并让内部层依赖已命名的输入/输出边界。

### 给 JSON Schema 做完整类型级解释器

JSON Schema 包含引用、组合、条件和递归。试图在 TS 类型系统里 100% 解释它，往往既不完全正确又昂贵。可靠路径通常是：

- 使用受控 schema DSL，并从 DSL 推导 TS；或
- 把外部 JSON Schema 当运行时数据，通过代码生成产出 `.d.ts`；或
- 对动态 schema 返回 `unknown`，边界验证后再进入领域类型。

### 用模板字面量穷举每个事件路径

Agent 事件若把 run、step、tool、phase 的所有组合都做成字符串联合，规模是乘法增长。判别对象通常更清晰：

```ts
type AgentEvent =
  | { type: "run.started"; runId: string }
  | { type: "tool.finished"; runId: string; toolCallId: string };
```

---

## 12. 建立可重复的性能测量

本项目为类型性能实验单独建立 `tsconfig.type-performance.json`。这样指标只覆盖目标文件，不会被整个教程和 Compiler API 示例淹没。

一个可靠对比流程：

1. 固定 Node、TypeScript 版本和同一台机器；
2. 独立配置只纳入要测的文件；
3. 运行多次，区分冷启动波动；
4. 记录 `Types`、`Instantiations`、`Check time` 和内存；
5. 每次只修改一个类型策略；
6. 同时运行类型契约测试，防止“优化”实际是丢失语义；
7. 在接近真实规模的数据上复测。

不要把几十毫秒差异当成稳定结论，也不要只复制别人项目里的绝对阈值。

### 建立相对预算

CI 可以保存一个代表性类型压力项目。若某次改动令实例化量或检查时间显著跃升，就要求解释。时间易受机器噪声影响，`Instantiations` 等结构指标通常更适合辅助定位，但也会随 TS 版本变化。

升级 TypeScript 时应重新建立基线，而不是把旧基线当永久标准。

---

## 13. `--generateTrace`：从“慢”走到具体类型

当 `--extendedDiagnostics` 只能证明 checker 慢，却不能指出来源时，可生成 trace：

```bash
npx tsc -p tsconfig.json --generateTrace .trace
```

trace 可用于定位：

- 哪些文件检查耗时高；
- 哪些类型关系反复比较；
- 哪些泛型实例化形成热点；
- 大型联合或交叉从哪里出现。

官方性能追踪文档还提供分析工具和工作流。注意 trace 可能很大，并包含文件路径、源码中的类型名称等项目结构信息，不应随意上传公开 issue 或提交仓库。

分析完成后删除临时 trace，除非项目明确需要保存去敏后的基准产物。

---

## 14. 项目结构常比微调类型体操更重要

若整个 monorepo 每次都纳入一个 program，再漂亮的单个类型优化也救不了错误边界。工程层面检查：

- `include` 是否误包含 `dist`、生成目录、测试快照和临时文件；
- 是否同时加载多个不兼容版本的 `@types`；
- 测试、构建脚本和服务端是否可拆为 project references；
- 各子项目是否输出声明并使用 `composite`；
- 是否因为 barrel file 引入了不需要的巨型类型图；
- `skipLibCheck` 是在有意跳过第三方声明检查，还是掩盖了重复类型版本。

`skipLibCheck` 可以降低声明检查成本，但也会跳过 `.d.ts` 内部一致性检查。它不是类型级算法低效的修复方案。

### 编辑器与命令行不是两个世界

VS Code 的 tsserver 使用同一个核心 checker 思想。命令行全量构建很快，但编辑器 hover 或自动补全慢，可能是某个表达式触发了巨大推断结果。反过来，编辑器看似正常，也不代表全量声明 emit 和跨项目检查便宜。

两条路径都应测。

---

## 15. 发布库时，成本会转嫁给每个用户

应用内部复杂类型只影响本团队；库导出的复杂类型会在所有使用者的不同 TypeScript 版本中实例化。

发布前检查：

- 生成的 `.d.ts` 是否泄漏私有条件类型；
- hover 是否展示数百行展开结果；
- 最低支持 TS 版本能否处理递归策略；
- 是否在典型下游项目中测过 completions 和 check time；
- 公共类型是否有稳定名字；
- 错误输入产生的是可读诊断还是“实例化过深”；
- 新版本是否意外把线性计算变成联合笛卡尔积。

类型设计也是性能 API 设计。

---

## 16. 类型性能反模式与替代策略

| 反模式 | 问题 | 更可控的策略 |
|---|---|---|
| 对任意输入无限 `Deep*` | 自引用和深对象导致递归压力 | 设置深度预算，或只处理业务需要的层级 |
| 所有条件类型都让联合分发 | 隐式循环叠加 | 先明确整体/逐成员语义，必要时元组包装 |
| 多维模板联合生成完整字符串空间 | 笛卡尔积 | 品牌字符串、对象判别或代码生成 |
| 大量匿名交叉反复内联 | 关系难缓存、诊断难读 | 命名接口/别名，稳定导出边界 |
| 用类型系统完整解释动态外部协议 | 不完备且昂贵 | 运行时验证、受控 DSL 或构建期代码生成 |
| 为零断言构造极端泛型 | 公共 API 复杂度转嫁下游 | 把不安全性局部封装并用测试证明契约 |
| 只看源码行数判断成本 | 看不到实例化和关系规模 | extended diagnostics + trace |
| 只优化单个别名 | 忽略 include 和项目边界 | 同时审计 program 规模与 project references |

---

## 17. 类型契约测试与性能测试必须一起存在

类型优化最危险的方式是“变宽”：把复杂类型换成 `any`，指标当然变好，但契约已经消失。

配套实验使用：

```ts
type Equal<A, B> = /* 双向条件比较 */;
type Expect<T extends true> = T;
```

以及 `@ts-expect-error` 同时验证正向和负向行为。每次重写算法，都应先保证：

- 合法输入仍得到预期类型；
- 非法输入仍被拒绝；
- `any`、`never`、`unknown`、联合和可选属性等边界没有改变；
- 运行时验证与静态推导仍一致。

然后才比较指标。正确性和性能不是二选一。

---

## 18. 建议动手做的压力实验

1. 把 `RouteParams` 的路径从 5 段逐步扩到 50 段，记录实例化量增长。
2. 写 5 个各含 10 个成员的模板字面量维度，先计算理论组合数，再观察 checker 行为；不要把爆炸版本提交到主配置。
3. 对比非尾递归 `Chars` 与累加器版本，保持输入相同。
4. 把 `DeepReadonly` 深度从 4 提到 8、16，观察 tuple 算术成本。
5. 将重复内联的条件返回类型提取为命名别名，比较诊断指标和 hover 可读性。
6. 构造 100 个 Agent 工具的映射，比较“单一全局联合”和“按域分区”的检查成本。
7. 生成 trace，找到一次真实热点；记录原因，而不是只保存一份巨大 trace 文件。

压力实验最好放在独立 tsconfig 中。否则一次有意制造的类型爆炸会拖慢日常开发的每一次检查。

---

## 19. 最终决策顺序

遇到复杂类型需求时，按以下顺序决策：

```text
它是运行时事实吗？
  是 → 先做运行时验证或代码生成
  否
  ↓
调用方真的需要精确到这个粒度吗？
  否 → 暴露更小、更稳定的命名接口
  是
  ↓
是否存在联合分发、笛卡尔积或无界递归？
  是 → 改整体判断、分区、尾递归或深度预算
  否
  ↓
用类型契约测试锁定语义
  ↓
用 extendedDiagnostics 建基线
  ↓
热点不清楚时生成 trace
```

高级 TypeScript 不是把所有逻辑都搬进类型系统，而是知道哪些关系值得在编译期证明、证明到什么深度，以及何时把问题交还给运行时 schema 或构建工具。

## 延伸阅读

- [TypeScript Wiki：Performance](https://github.com/microsoft/TypeScript/wiki/Performance)
- [TypeScript Wiki：Performance Tracing](https://github.com/microsoft/TypeScript/wiki/Performance-Tracing)
- [TypeScript 4.5：尾递归条件类型消除](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-5.html#tail-recursion-elimination-on-conditional-types)
- [TypeScript 4.1：递归条件类型](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-1.html#recursive-conditional-types)
