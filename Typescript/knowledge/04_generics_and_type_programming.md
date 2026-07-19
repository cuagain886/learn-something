# 04 · 泛型与类型编程 ⭐⭐⭐

> TypeScript 的条件类型和递归类型能够表达非常复杂的计算，有研究和实验将其视为具备图灵完备能力。但这不是面向业务的执行环境，也不是稳定的语言性能承诺。泛型的首要用途是保存输入、输出和键之间的关系。

---

## 1. 泛型思维：类型即参数

从 Java 泛型到 TS 泛型的思维映射：

```typescript
// Java:  <T> T identity(T value) { return value; }
// TS:   完全一样的思想！
function identity<T>(value: T): T {
    return value;
}

// 但是 TS 的泛型可以作用在更多地方
type Container<T> = { value: T; timestamp: Date };  // 泛型类型别名
interface Repository<T> { get(id: string): T; }      // 泛型接口
class Stack<T> { /* ... */ }                          // 泛型类
```

**与 Java 泛型的关键差异**：TS 的泛型在**编译后消失**（和 Java 的类型擦除类似），但 TS 的泛型可以做更多"类型运算"（映射类型、条件类型等），这些在 Java 中需要反射或注解处理器才能实现。

---

## 2. 泛型约束（extends）—— 限制类型参数的"形状"

```typescript
// 普通数组可能为空；在 noUncheckedIndexedAccess 下必须诚实返回 T | undefined。
function first<T>(arr: readonly T[]): T | undefined { return arr[0]; }

// 若调用契约明确要求非空元组，才可以保证 T。
function firstRequired<T>(arr: readonly [T, ...T[]]): T { return arr[0]; }

// 有约束：T 必须至少满足某个结构
function logLength<T extends { length: number }>(value: T): T {
    console.log(value.length);
    return value;
}

logLength("hello");    // ✅ string 有 length
logLength([1, 2, 3]); // ✅ 数组有 length
logLength(123);        // ❌ number 没有 length
```

**泛型约束的继承是结构化继承**——`T extends HasLength` 意味着"T 的结构至少包含 HasLength 的所有属性"，不是"T 名义上继承自 HasLength"。

---

## 3. keyof + 泛型——类型安全的对象操作

这是 TS 最常用的泛型组合之一：

```typescript
// 最基本的 keyof + 泛型
function getProperty<T, K extends keyof T>(obj: T, key: K): T[K] {
    return obj[key];
}

const user = { name: "Alice", age: 30 };
getProperty(user, "name");  // 返回类型: string
getProperty(user, "age");   // 返回类型: number
getProperty(user, "email"); // ❌ 编译错误
```

拆解：
- `K extends keyof T` — K 只能是 T 的某个键
- `T[K]` — 返回值类型 = T 中键 K 对应的值的类型
- 结果：调用时 IDE 自动补全 `key` 参数，返回值类型精确匹配

---

## 4. 映射类型（Mapped Types）—— 批量创造类型

映射类型是 TS 类型编程的"循环语句"：

```typescript
// 语法：[K in 键的联合]: 值类型

// 把每个属性变成可选的
type MyPartial<T> = {
    [K in keyof T]?: T[K];
};

// 把每个属性变成只读的
type MyReadonly<T> = {
    readonly [K in keyof T]: T[K];
};

// 把每个属性变成可空的
type Nullable<T> = {
    [K in keyof T]: T[K] | null;
};

// 效果
interface Person { name: string; age: number; }
type PartialPerson = MyPartial<Person>;
// { name?: string; age?: number }
```

**修饰符操作**：

```typescript
// 去除可选（-?）
type Required<T> = { [K in keyof T]-?: T[K]; };

// 去除只读（-readonly）
type Mutable<T> = { -readonly [K in keyof T]: T[K]; };
```

**键重映射（Key Remapping）**—— TS 4.1+：

```typescript
// 给每个属性名加上 get 前缀
type Getters<T> = {
    [K in keyof T as `get${Capitalize<string & K>}`]: () => T[K];
};
// Person → { getName: () => string; getAge: () => number }

// 过滤掉某些属性
type OnlyStrings<T> = {
    [K in keyof T as T[K] extends string ? K : never]: T[K];
};
// { name: string; age: number; email: string } → { name: string; email: string }
```

---

## 5. 条件类型（Conditional Types）—— 类型层面的 if/else

```typescript
// 基本语法：T extends U ? X : Y
type IsString<T> = T extends string ? "yes" : "no";

// 提取联合中的特定类型
type ExtractString<T> = T extends string ? T : never;

// 排除 null/undefined
type NonNullable<T> = T extends null | undefined ? never : T;
```

### 分布式条件类型（Distributive Conditional Types）

这是条件类型最强大也最容易误解的特性：

```typescript
// 当 T 是联合类型时，条件类型会自动"分发"到每个成员
type ToArray<T> = T extends unknown ? T[] : never;

type Result = ToArray<string | number>;
// 不是 (string | number)[]
// 而是 string[] | number[]
// 因为分发：(string extends unknown ? string[] : never) | (number extends unknown ? number[] : never)
```

**阻止分发**：用方括号包裹 T：

```typescript
type ToArrayNoDistribute<T> = [T] extends [unknown] ? T[] : never;
type Result2 = ToArrayNoDistribute<string | number>;  // (string | number)[]
```

---

## 6. infer —— 从类型中"提取"信息

`infer` 是 TS 类型编程的"解构赋值"：

```typescript
// 提取数组的元素类型
type ElementType<T> = T extends readonly (infer U)[] ? U : never;

// 提取函数返回值类型（内置 ReturnType 的原理）
type MyReturnType<T> = T extends (...args: never[]) => infer R ? R : never;

// 提取 Promise 的值类型（递归版，处理嵌套 Promise）
type MyAwaited<T> = T extends PromiseLike<infer V> ? MyAwaited<V> : T;
type R1 = MyAwaited<Promise<string>>; // string

// 提取函数第一个参数
type FirstArg<T> = T extends (first: infer F, ...rest: never[]) => unknown ? F : never;
type Arg = FirstArg<(x: number, y: string) => void>;  // number
```

**infer 实战——类型安全的 EventEmitter**：

```typescript
type EventMap = {
    click: { x: number; y: number };
    keydown: { key: string };
    focus: undefined;
};

// 用 infer 提取回调参数类型
type Listener<E> = E extends undefined
    ? () => void
    : (event: E) => void;

class EventEmitter<T extends Record<string, unknown>> {
    on<K extends keyof T>(event: K, listener: Listener<T[K]>): void { /* ... */ }
    emit<K extends keyof T>(event: K, ...args: T[K] extends undefined ? [] : [T[K]]): void { /* ... */ }
}

const emitter = new EventEmitter<EventMap>();
emitter.on("click", (e) => { console.log(e.x, e.y); });  // e 自动推断为 { x: number; y: number }
emitter.on("focus", () => { console.log("focused"); });   // 不需要参数
// emitter.on("click", (e) => { console.log(e.key); });  // ❌ 没有 key！
```

---

## 7. 协变（Covariance）与逆变（Contravariance）

这是类型理论中最重要的概念之一，TS 的行为和 Java 类似但更灵活：

```typescript
// 协变（Covariance）：子类型可以赋值给父类型
interface Animal { name: string; }
interface Dog extends Animal { breed: string; }

let animals: Animal[] = [];
let dogs: Dog[] = [];

animals = dogs;  // ✅ Dog[] 是 Animal[] 的子类型（协变）

// 逆变（Contravariance）：函数参数反过来
type AnimalHandler = (a: Animal) => void;
type DogHandler = (d: Dog) => void;

let h1: AnimalHandler = (a: Animal) => {};
let h2: DogHandler = (d: Dog) => {};

// h2 = h1;  // ✅ DogHandler = (d: Dog) => void 可以接收 (a: Animal) => void
//            // 因为只要参数是 Dog（可调用 h1），h1 期望 Animal，Dog 是 Animal 的子类型

h1 = h2;      // ❌ strictFunctionTypes 下报错！
// 为什么？h1 定义为 (a: Animal) => void，调用时可能传入 Cat
// 但 h2 的实际实现只处理 Dog → 运行时炸！
```

| 位置 | 方向 | 规则 |
|------|------|------|
| 返回值 | 协变 | 子类型的返回值可以更窄 |
| 参数 | 逆变 | 子类型的参数可以更宽 |
| `readonly` 数组/只读输出 | 协变 | `readonly Dog[]` 可安全作为 `readonly Animal[]` 读取 |

**实用结论**：在 `strictFunctionTypes: true` 下，函数类型属性的参数按逆变方向检查；方法/构造签名仍有兼容性例外。可变 `Dog[] → Animal[]` 虽被允许，却能通过 `push(new Animal())` 破坏原数组，是刻意保留的不健全点。详见 [07 · 可赋值性、方差与健全性](07_assignability_variance_and_soundness.md)。

---

## 8. 模板字面量类型（Template Literal Types）

这是 TS 4.1 引入的"类型层面的字符串拼接"：

```typescript
type Lang = "zh" | "en";
type Page = "home" | "about";
type Route = `/${Lang}/${Page}`;
// 自动展开为："/zh/home" | "/zh/about" | "/en/home" | "/en/about"

// 配合内置的字符串工具类型
type EventName<T extends string> = `on${Capitalize<T>}`;
type ClickHandler = EventName<"click">;  // "onClick"

// 实战：类型安全的路由系统
type RouteParams<T extends string> =
    T extends `${string}:${infer P}/${infer Rest}` ? { [K in P | keyof RouteParams<Rest>]: string } :
    T extends `${string}:${infer P}` ? { [K in P]: string } :
    {};

type UserRoute = RouteParams<"/user/:id/post/:postId">;
// { id: string; postId: string }
```

---

## 9. 类型体操的边界——什么时候该停

TS 的类型编程能力很强，但有代价：

**✅ 值得做的类型体操**：
- 从已有类型推导出新类型（`Partial<T>`、`Pick<T, K>`）
- 函数参数的自动推断（泛型 + keyof）
- 可辨识联合 + 穷尽检查

**❌ 不值得做的类型体操**：
- 在类型层面做复杂数值计算
- 用模板字面量类型解析 SQL/GraphQL 字符串
- 让类型推导比业务逻辑还复杂
- 写出来自己下周看不懂的类型

**原则**：类型是证明工具，不是目的。复杂度超过收益时，缩小公共契约、把动态部分收敛为 `unknown` 并在一个经过验证的边界解析；不要用传播性的 `any` 把 checker 整段关闭。

完整的实例化量、递归深度和 trace 分析见 [20 · 类型级算法与编译性能](20_type_level_performance.md)。

---

## 10. 泛型与联合表达的承诺完全不同

```typescript
function generic<T extends string | number>(value: T): T {
    return value;
}

function union(value: string | number): string | number {
    return value;
}
```

泛型签名对**每一次具体调用**承诺输入输出保持同一个 T；联合签名只承诺返回联合中的某一项，调用方无法知道与输入相同。

更形式化地理解：

```text
generic: 对所有满足约束的 T，(T) → T
union:   (string | number) → (string | number)
```

因此，如果类型参数只出现一次，通常并没有表达关系：

```typescript
function parseBad<T>(text: string): T {
    return JSON.parse(text) as T;
}
```

这里 T 完全由调用方指定，实现在运行时没有任何证据，等价于可定制断言。正确 API 应返回 unknown，或接收能在运行时验证 T 的 schema/parser。

---

## 11. 推断是在候选、约束和上下文之间求解

```typescript
function choose<T>(left: T, right: T): T {
    return Math.random() > 0.5 ? left : right;
}

choose(1, 2);      // T 通常推断为 number
// choose(1, "x"); // 不要假设总会自动得到 number | string
```

推断会从参数位置收集候选，也可能受到目标返回位置的上下文影响。多个位置共享 T 意味着它们必须建立真实关系，不是“让函数接受任何东西”的快捷语法。

常见诊断：

- T 只出现于返回值：调用方可凭空指定，没有运行时证据。
- 两个无关参数共享 T：产生难懂推断冲突。
- 约束写得过宽：实现几乎不能使用 T。
- 约束写成 `Record<string, unknown>`：无意拒绝没有字符串索引签名的具体接口。
- 回调参数和返回值互相推断：可能出现循环上下文，需要显式边界注解。

完整推断信息流见 [06 · 推断、上下文类型与 satisfies](06_inference_context_and_satisfies.md)。

---

## 12. `const` 类型参数保留调用点字面量

```typescript
function defineRoutes<const Routes extends readonly string[]>(routes: Routes): Routes {
    return routes;
}

const routes = defineRoutes(["/users", "/orders"]);
// readonly ["/users", "/orders"]
```

`const` generic 修改的是推断策略，不会让运行时参数冻结，也不会把已经拓宽的变量重新恢复成字面量：

```typescript
const widened: string[] = ["/users", "/orders"];
defineRoutes(widened); // 信息已经丢失，仍是 string[]
```

它适合配置表、事件名、工具定义等调用点 literal；若 API 只需要普通数组，不应为了更炫的 hover 无条件使用。

---

## 13. `NoInfer` 区分“推断来源”和“校验位置”

```typescript
function stateMachine<State extends string>(
    states: readonly State[],
    initial: NoInfer<State>,
): { readonly states: readonly State[]; readonly initial: State } {
    return { states, initial };
}

stateMachine(["idle", "running"] as const, "idle");
// stateMachine(["idle", "running"] as const, "missing"); // ❌
```

若 initial 也参与候选收集，编译器可能扩大 State 来容纳它。`NoInfer` 不改变最终类型，只阻止某个位置贡献推断候选，使它仅用于验证已经从其他位置得到的 T。

---

## 14. 泛型方差由 T 的使用位置涌现

```typescript
type Producer<T> = { produce: () => T };       // T 在输出位置，协变
type Consumer<T> = { consume: (value: T) => void }; // 输入位置，逆变
type Cell<T> = {
    get: () => T;
    set: (value: T) => void;
}; // 同时输入/输出，应接近不变
```

TypeScript 通常自动推断方差。`in`/`out` 方差注解是用于极少数实例化比较/性能问题的高级工具：

- 不能改变匿名结构比较的实际行为；
- 不能用来强迫一个本来不安全的类型变安全；
- 必须与结构中 T 的真实使用方向一致；
- 只有 profiling 证明方差推断是热点时才可能作为性能优化。

日常设计应通过 readonly 输出、函数属性输入和避免可变暴露自然得到正确方差。

---

## 15. TypeScript 没有通用高阶类型参数

在某些函数式语言中可以抽象“接收类型构造器 F，再操作 F<A>”。TypeScript 没有原生 higher-kinded types：

```text
想表达：F<_> 作为类型参数
实际 TS：通常需要 URI 映射、接口编码或具体重载模拟
```

复杂 HKT 模拟会增加声明、错误信息和 checker 成本。Agent 业务代码通常用具体 `Promise<T>`、`Result<T,E>`、`AsyncIterable<T>` 更清楚；只有库确实需要跨容器抽象时才承担编码复杂度。

---

## 16. 类型级计算不会生成运行时实现

```typescript
type ToolInput<Tool> = Tool extends { input: infer Input } ? Input : never;
```

这个类型可以让调用方得到精确补全，但不能：

- 验证 LLM 传来的 JSON；
- 在运行时枚举 Input 的字段；
- 生成供应商需要的 JSON Schema；
- 检查 number 是 finite integer；
- 保留品牌不变量。

可靠工具系统需要一个运行时事实源：

```text
schema DSL → 运行时 parse
           → 静态 Infer<Schema>
           → 模型工具 descriptor
```

另一条路径是构建期 Compiler API/codegen，但要明确支持的 TypeScript 子集并对生成物做 snapshot/contract test。

---

## 一句话总结

泛型让类型"动"起来——从固定的类型定义变成可复用的类型函数。映射类型（Mapped Types）、条件类型（Conditional Types）、`infer` 和模板字面量类型组成了 TS 的"类型编程四件套"。掌握它们，你就能用类型表达任意约束。
