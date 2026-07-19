# 06 · 类型推断、上下文类型与 `satisfies` ⭐⭐⭐

> 写好 TypeScript 的关键不是多写注解，而是控制信息流：哪些类型信息由值向外推，哪些由上下文向表达式内部传。

---

## 1. 推断不是一次性的“猜类型”

TypeScript 同时使用两条信息流：

1. **自下而上推断**：从初始化值推导变量、返回值和泛型参数。
2. **自上而下的上下文类型**：从赋值目标、参数位置、返回位置约束表达式。

```typescript
const standalone = event => event.id;
// strict 下：event 隐式 any，因为右侧没有上下文

type Handler = (event: { id: string }) => string;
const contextual: Handler = event => event.id;
// event 从赋值目标得到 { id: string }
```

上下文类型不仅检查最终结果，还会进入对象字面量、数组元素、回调参数和返回表达式内部。因此“先存变量再传入”经常会改变推断结果。

---

## 2. 字面量拓宽：为什么 `"GET"` 变成了 `string`

```typescript
const method = "GET";               // "GET"
let mutableMethod = "GET";          // string：未来允许改成 "POST"

const request = { method: "GET" };  // { method: string }
// 对象本身虽是 const，但 request.method 仍可被修改
```

变量是否可重新赋值、属性是否只读，决定字面量是否需要拓宽。常见的三种控制方式有不同语义：

```typescript
type Method = "GET" | "POST";

const a: { method: Method } = { method: "GET" };
// a.method: Method；显式注解保留的是目标类型，不是具体字面量

const b = { method: "GET" } as const;
// b: { readonly method: "GET" }；深层字面量也变窄并 readonly

const c = { method: "GET" } satisfies { method: Method };
// c.method: "GET"；校验结构，同时保留表达式自己的精确类型
```

选择原则：

- 变量以后应按契约使用：写显式注解。
- 值本身是常量数据、元组或配置表：用 `as const`。
- 想校验契约，但不想牺牲键名和字面量推断：用 `satisfies`。

---

## 3. `satisfies` 不是类型断言

```typescript
type Route = {
    path: `/${string}`;
    auth: boolean;
};

const routes = {
    home: { path: "/", auth: false },
    admin: { path: "/admin", auth: true },
} satisfies Record<string, Route>;

type RouteName = keyof typeof routes; // "home" | "admin"
routes.admin.auth;                     // true，而不是 boolean
```

对比危险的断言：

```typescript
const broken = {
    path: "admin", // 缺少前导 /
    auth: true,
} as Route;
// 断言可能掩盖错误；satisfies 会在定义处报告错误
```

三者的本质区别：

| 写法 | 校验表达式 | 改变观察到的类型 | 典型用途 |
|---|---:|---:|---|
| `const x: T = expr` | 是 | 结果按 `T` 使用 | 明确公共边界 |
| `expr satisfies T` | 是 | 否 | 配置表、路由表、映射表 |
| `expr as T` | 弱，允许重叠类型强转 | 是 | 已由外部事实保证但编译器不知道 |

`satisfies` 仍然只存在于编译期；它不会验证网络返回的 JSON。

---

## 4. 泛型推断的目标是“求解关系”

```typescript
function pair<T>(left: T, right: T): [T, T] {
    return [left, right];
}

pair(1, 2);       // [number, number]
pair(1, "two");  // ❌ 不要假设 T 会自动变成 number | string
```

同一个类型参数出现在多个位置时，编译器需要找到同时满足所有约束的候选类型。若业务上确实允许两种类型，应把关系写出来：

```typescript
function pair<A, B>(left: A, right: B): [A, B] {
    return [left, right];
}

function homogeneous<T>(...values: T[]): T[] {
    return values;
}
```

不要为了“复用”强行让无关参数共享 `T`。泛型参数应该表示真实关系：输入与输出相同、键属于对象、返回值依赖某个判别字段。

---

## 5. 约束负责可用能力，不负责固定结果

```typescript
function getId<T extends { id: string }>(value: T): string {
    return value.id;
}

const user = { id: "u1", name: "Ada" };
getId(user); // T 保留完整的 { id: string; name: string }
```

`extends` 的意思是“候选类型至少满足该结构”，而不是“把 T 变成约束类型”。错误设计通常直接返回约束，丢掉调用方信息：

```typescript
function identityBad(value: { id: string }): { id: string } {
    return value;
}

function identityGood<T extends { id: string }>(value: T): T {
    return value;
}
```

但若实现会删除或重建字段，就不该谎称返回 `T`。泛型签名必须描述实现真正保证的关系。

---

## 6. `NoInfer`：阻止某个位置参与候选推断

当一个参数应当**验证**已经推断出的 `T`，而不应反过来扩大 `T` 时，可以使用内置 `NoInfer<T>`：

```typescript
function createState<C extends string>(
    choices: readonly C[],
    initial: NoInfer<C>,
) {
    return { choices, initial };
}

createState(["open", "closed"] as const, "open");    // ✅
createState(["open", "closed"] as const, "pending"); // ❌
```

没有 `NoInfer` 时，`initial` 也可能贡献候选，使 `C` 被扩大到包含 `"pending"`。设计默认值、状态机初始态、配置键时尤其有用。

---

## 7. 回调中的上下文推断与“相关性丢失”

```typescript
type EventMap = {
    connected: { at: Date };
    message: { text: string };
};

function on<K extends keyof EventMap>(
    name: K,
    handler: (payload: EventMap[K]) => void,
) {}

on("message", payload => payload.text); // payload 精确为 { text: string }
```

如果把相关参数拆成两个互不相关的联合，关系就丢失：

```typescript
function onBad(
    name: keyof EventMap,
    handler: (payload: EventMap[keyof EventMap]) => void,
) {}
```

类型设计的重点不是“包含所有可能类型”，而是保存变量之间的对应关系。泛型、可辨识联合、映射类型都是保存相关性的工具。

---

## 8. 条件类型推断为什么有时得到联合

```typescript
type ElementOf<T> = T extends readonly (infer U)[] ? U : never;
type A = ElementOf<string[] | number[]>; // string | number
```

当裸类型参数位于条件类型左侧时，联合会逐项分发：

```typescript
// ElementOf<string[]> | ElementOf<number[]>
```

若要把联合整体判断，用元组包住两侧：

```typescript
type IsString<T> = [T] extends [string] ? true : false;
type B = IsString<"a" | 1>; // false
```

这不是技巧记忆题，而是要先问：我的运算针对联合的每个成员，还是针对联合整体？

---

## 9. 推断失败时的排查顺序

1. **信息是否存在**：参数和返回值之间真的有可表达关系吗？
2. **信息是否被拓宽**：对象属性是否从字面量变成了 `string`？
3. **上下文是否被切断**：是否先赋给了无注解变量，再传入 API？
4. **相关性是否丢失**：是否把键和值分别写成两个联合？
5. **候选是否互相污染**：某个默认值是否不该参与泛型推断？
6. **断言是否掩盖问题**：`as` 是否让错误延迟到更远处？

推荐先尝试：调整 API 关系 → 使用显式返回类型或 `satisfies` → 使用 `as const` → 最后才是断言。

---

## 10. 推断操作符不会冻结、清洗或验证运行时值

三个常见误解来自把 checker 操作当成 runtime 操作：

- `as const` 递归保留 literal/readonly 类型，但不调用 `Object.freeze`；Reflect、外部 JS 和别名仍可修改对象。
- fresh object 的 excess-property check 只发生在特定目标位置；先保存到变量再赋值时，额外字段仍真实存在。
- `satisfies` 在编译期验证可赋值性并提供上下文类型，emit 后没有 validator 函数。

```typescript
const value = { method: "GET", debug: true } as const;
const endpoint: { readonly method: "GET" } = value;

"debug" in endpoint; // true，赋值没有清洗字段
Object.isFrozen(value); // false
```

`NoInfer<T>` 也只改变候选收集：它告诉 checker 某个位置负责“验证已有 T”，不负责“扩大 T”；运行时参数传递完全不变。

完整的编译期/运行时对照见 [第 16 课：推断信息流](../code/src/16-inference-satisfies.ts)。官方语义参考：[satisfies](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html) 与 [NoInfer](https://www.typescriptlang.org/docs/handbook/utility-types.html#noinfertype)。

---

## 一句话总结

TypeScript 推断是双向约束求解。优秀的类型设计会保存字面量精度和参数相关性，并用 `satisfies` 做校验；糟糕的类型设计则靠宽泛联合与断言把信息主动抹掉。
