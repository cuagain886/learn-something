# 04 · 泛型与类型编程 ⭐⭐⭐

> TS 的类型系统是**图灵完备**的——你可以在类型层面做计算。泛型是这门"类型编程语言"的基石。

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
// 无约束：T 可以是任何类型
function first<T>(arr: T[]): T { return arr[0]; }

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
type ToArray<T> = T extends any ? T[] : never;

type Result = ToArray<string | number>;
// 不是 (string | number)[]
// 而是 string[] | number[]
// 因为分发：(string extends any ? string[] : never) | (number extends any ? number[] : never)
```

**阻止分发**：用方括号包裹 T：

```typescript
type ToArrayNoDistribute<T> = [T] extends [any] ? T[] : never;
type Result2 = ToArrayNoDistribute<string | number>;  // (string | number)[]
```

---

## 6. infer —— 从类型中"提取"信息

`infer` 是 TS 类型编程的"解构赋值"：

```typescript
// 提取数组的元素类型
type ElementType<T> = T extends (infer U)[] ? U : never;

// 提取函数返回值类型（内置 ReturnType 的原理）
type MyReturnType<T> = T extends (...args: any[]) => infer R ? R : never;

// 提取 Promise 的值类型（递归版，处理嵌套 Promise）
type Awaited<T> = T extends Promise<infer V> ? Awaited<V> : T;
type R1 = Awaited<Promise<string>>;       // string
type R2 = Awaited<Promise<Promise<number>>>; // number

// 提取函数第一个参数
type FirstArg<T> = T extends (first: infer F, ...rest: any[]) => any ? F : never;
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

class EventEmitter<T extends Record<string, any>> {
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
| 数组/对象属性 | 协变 | `Dog[]` 可赋给 `Animal[]` |

**实用结论**：在 `strictFunctionTypes: true` 下（推荐开启），TS 对函数参数做正确的逆变检查。这防止了一类罕见的运行时错误。

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

**原则**：类型是**工具**，不是**目的**。如果一段类型代码让你头疼，那就简化它（哪怕用 `any` 做逃生舱）。

---

## 一句话总结

泛型让类型"动"起来——从固定的类型定义变成可复用的类型函数。映射类型（Mapped Types）、条件类型（Conditional Types）、`infer` 和模板字面量类型组成了 TS 的"类型编程四件套"。掌握它们，你就能用类型表达任意约束。
