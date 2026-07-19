# 01 · TypeScript 类型系统全景 ⭐⭐⭐

> TypeScript 是用于描述 JavaScript 程序的渐进式静态类型系统，并附带一组编译期语法。理解“静态证明到哪里结束、运行时事实从哪里开始”，比背语法重要得多。

---

## 1. TS 类型系统的定位

| 特性 | JavaScript | TypeScript | Java |
|------|-----------|------------|------|
| 类型检查时机 | 运行时 | 编译时 | 编译时 |
| 类型标注 | 无 | 可选（渐进式） | 强制 |
| 类型擦除 | - | `interface`、`type`、类型注解等被擦除；少数 TS 语法会生成 JS | 泛型通常擦除，但 class/annotation 等运行时结构仍在 |
| 类型推导 | - | 有（比 Java 的 var 强大得多） | 有（var，局部变量） |
| 运行时行为 | 动态 | = 编译后的 JS（和 JS 完全一样） | JVM 执行 |

**核心认知**：TypeScript 的**类型空间**主要存在于编译期；`type`、`interface`、泛型实参和多数类型注解不会成为运行时反射信息。但不能笼统说“所有 TypeScript 语法都消失”：普通 `enum`、参数属性、带运行时代码的 `namespace`、装饰器等可能需要编译器生成 JavaScript。类型擦除不等于源码逐字符删除。

类型正确也不等于输入真实：`fetch()` 返回的 JSON、环境变量、数据库内容和 LLM 工具参数不会因为写了接口就自动通过验证。

---

## 2. 类型推断（Type Inference）—— TS 最被低估的能力

写 TS 不一定非要写类型注解。TS 编译器能从**值**推导出**类型**：

```typescript
let x = 3;           // TS 推断 x: number
let y = "hello";     // TS 推断 y: string
let arr = [1, 2, 3]; // TS 推断 arr: number[]

// 复杂推断
const config = {     // TS 推断整个结构
    host: "localhost",
    port: 8080,
    retry: { count: 3, delay: 1000 },
};
// config 的类型是 { host: string; port: number; retry: { count: number; delay: number; } }
```

**什么时候应写类型注解？**

1. 没有上下文签名的函数参数；回调参数则经常能从调用位置获得上下文类型。
2. 需要固定公共 API、递归函数或模块导出边界时。
3. 需要防止实现细节被推断成意外公共契约时。
4. 初始化值不足以表达预期状态空间时，例如 `let state: "idle" | "running" = "idle"`。
5. 需要在实现位置尽早验证契约，而不是让错误传播到使用位置时。

`let value;` 的行为也不能简单概括为“永久 any”。在不同控制流赋值下，TypeScript 会演进它的当前类型；但未受约束的值很容易形成隐式 `any` 或过宽 API，因此公共代码不应依赖这种特殊推断。

**一个好的经验法则**：让 TS 尽可能推断，只在边界（函数签名、模块导出）写显式类型。

---

## 3. 类型兼容性：结构化类型

这是 TS 和 Java **最根本的差异**。TS 是**结构化类型**（Structural Typing）：

```typescript
interface Point2D {
    x: number;
    y: number;
}

interface Point3D {
    x: number;
    y: number;
    z: number;
}

// 在 Java 中：Point2D 和 Point3D 是完全不相关的类型（即使有相同字段）
// 在 TS 中：Point3D 可以赋值给 Point2D！（因为它至少有 x 和 y）

const p3d: Point3D = { x: 1, y: 2, z: 3 };
const p2d: Point2D = p3d;  // ✅ 合法！结构兼容即可

// 函数参数同理
function draw(point: Point2D) { /* ... */ }
draw(p3d);  // ✅ Point3D 满足 Point2D 的结构要求
```

这叫"鸭子类型"：如果它走起来像鸭子、叫起来像鸭子，那它就是鸭子。TS 只看**形状**，不看**名字**。

不同类型系统对比详见 [02 · 结构化类型 vs 名义类型](02_structural_vs_nominal.md)。

---

## 4. any / unknown / never —— 类型的边界

这是 TS 类型系统的三个"边界情况"，各有语义：

### 4.1 any：退出类型检查

```typescript
let x: any = "hello";
x = 42;          // ✅ 可以
x.foo.bar();     // ✅ 不报错（但在运行时会炸！）
x();              // ✅ 也不报错
```

`any` 是**逃生舱**——放弃类型安全换取灵活性。它是 JS 迁移到 TS 的过渡工具，但应尽量少用。

### 4.2 unknown：类型安全的 any

```typescript
let x: unknown = "hello";
// x.toUpperCase();  // ❌ 不能直接用！
if (typeof x === "string") {
    x.toUpperCase();  // ✅ 收窄后才能用
}
```

规则：`unknown` 能接收任何值，但**必须收窄类型后才能使用**。这是比 `any` 更好的选择。

### 4.3 never：永远不会出现的值

```typescript
// 抛错的函数
function fail(msg: string): never { throw new Error(msg); }

// 穷尽检查：确保 switch 覆盖了所有联合成员
function assertNever(x: never): never {
    throw new Error(`Unexpected value: ${x}`);
}
```

在普通严格类型关系中，`never` 是底类型：它可以赋给其他类型，而一个真实可达的值不能被赋给 `never`。这也是为什么未处理的联合成员无法传给 `assertNever`。

### 它们不是一棵简单继承树

把 `any` 画进普通类型层级会产生误解：`any` 会同时绕过许多输入和输出检查，更像关闭局部证明的逃生通道。`unknown` 可近似理解为安全顶类型，`never` 可近似理解为底类型。

| 类型 | 赋值给其他类型 | 接受其他类型赋值 | 安全访问属性 |
|------|:---:|:---:|:---:|
| `any` | ✅ | ✅ | ✅（运行时可炸）|
| `unknown` | ❌ | ✅ | ❌（必须先收窄）|
| `never` | ✅ | ❌ | ❌（可达代码中不存在这种值）|

还要注意：联合与交叉在这个格上有代数直觉，但不能完全按集合论机械推导，因为 `any`、条件类型分发、对象可变性和 TypeScript 的可赋值规则包含工程化妥协。

---

## 5. const 断言与字面量类型

`as const` 是 TS 最实用的特性之一——它把"宽类型"收窄为"最精确的字面量类型"：

```typescript
// 没有 as const：类型较宽
const config1 = {
    host: "localhost",  // string
    port: 8080,         // number
    mode: "dev",        // string
};
// config1.mode 的类型是 string（太宽了！）

// 使用 as const：类型精确到字面量
const config2 = {
    host: "localhost",  // "localhost"（字面量）
    port: 8080,         // 8080（字面量）
    mode: "dev",        // "dev"（字面量）
} as const;
// config2.mode 的类型是 "dev"（精确！）

// 数组也适用
const roles = ["admin", "user"] as const;
// roles 的类型是 readonly ["admin", "user"]（元组，不是 string[]！）
```

**原理**：`as const` 做了三件事：
1. 所有属性变为 `readonly`
2. 数组变为 `readonly` 元组
3. 所有字面量类型不被"拓宽"（widening）

更准确地说，这些效果作用于当前**字面量表达式的类型**。它不会调用 `Object.freeze`，不会生成任何运行时代码，也不会递归冻结先前创建再被引用的对象：

```typescript
const mutable = { retries: 3 };
const config = { nested: mutable } as const;

// config.nested 这个引用不能被重新指向别处，但被引用对象仍可修改。
mutable.retries = 4;
config.nested.retries = 5;
```

---

## 6. 类型拓宽（Type Widening）与收窄（Narrowing）

TS 会自动"拓宽"某些类型——这是方便，也是坑：

```typescript
// 拓宽：变量可以重新赋值
let x = "hello";      // x: string（被拓宽了，不是 "hello"）
x = "world";          // ✅

// 不拓宽：常量不能改变
const y = "hello";    // y: "hello"（字面量类型，没被拓宽）

// 控制拓宽
let z = "hello" as const;  // z: "hello"（手动阻止拓宽）
let arr = [1, 2] as const; // arr: readonly [1, 2]
```

| 声明 | 推断结果 | 能否重新赋值 |
|------|---------|-------------|
| `let x = "hi"` | `string` | ✅ |
| `const x = "hi"` | `"hi"` | ❌ |
| `let x = "hi" as const` | `"hi"` | 只能重新赋值为 `"hi"` |
| `let x: "hi" = "hi"` | `"hi"` | 只能重新赋值为 `"hi"` |

对象属性的拓宽还与可变性、上下文类型和 generic inference 有关，不是只看 `let`/`const`。完整机制见 [06 · 推断、上下文类型与 satisfies](06_inference_context_and_satisfies.md)。

---

## 7. 严格模式（strict）—— 你应该全部打开

```json
{
    "compilerOptions": {
        "strict": true  // 开启所有严格检查
    }
}
```

`strict: true` 控制一组会随 TypeScript 版本演进的选项，不能把某个版本的列表当成永久规范。本项目 TypeScript 6.0.3 下的核心成员包括：

| 子选项 | 作用 | 不开会怎样 |
|--------|------|-----------|
| `strictNullChecks` | null/undefined 不能随意赋值 | 所有类型自动包含 null/undefined（亿万美金的错误） |
| `noImplicitAny` | 推断不出类型时报错 | TS 悄悄用 any，失去类型保护 |
| `strictFunctionTypes` | 函数参数类型正确逆变检查 | 函数赋值可能类型不安全 |
| `strictBindCallApply` | bind/call/apply 的类型检查 | 这些函数的参数可能不检查 |
| `strictPropertyInitialization` | 类属性必须初始化 | 未初始化的属性编译通过 |
| `noImplicitThis` | this 不能隐式 any | this 的拼写错误不会报错 |
| `strictBuiltinIteratorReturn` | 内置迭代器返回值使用精确类型 | `.next().value` 可能泄漏 any |
| `useUnknownInCatchVariables` | catch 原因默认为 unknown | 假定所有 throw 值都是 Error |

此外，`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`、`noImplicitReturns` 等不等同于 `strict`，但对生产项目非常有价值。

---

## 8. 类型空间和值空间必须分开思考

同一个标识符有时只存在于类型空间，有时同时存在于值空间：

| 声明 | 类型空间 | 值空间 | 常见用途 |
|---|---:|---:|---|
| `type` / `interface` | ✅ | ❌ | 静态结构 |
| `class` | ✅ 实例类型 | ✅ 构造器值 | `new`、`instanceof` |
| 普通 `enum` | ✅ | ✅ 对象 | 运行时成员访问 |
| `const` / `function` | 可用 `typeof` 取得类型 | ✅ | 运行时值 |
| `declare` | ✅ 描述 | 通常不生成 | 告诉 checker 外部值存在 |

```typescript
interface User { id: string }

// ❌ User 运行时不存在，不能做 instanceof User
// if (value instanceof User) {}

class Account {
  constructor(readonly id: string) {}
}

const account = new Account("a1");
account instanceof Account; // 运行时检查构造器原型链
```

Agent 工具 schema 需要运行时对象；只有 `type ToolInput = ...` 不够。要么显式维护 schema 并从它推导类型，要么在构建期使用 Compiler API 生成运行时产物。

---

## 9. `object`、`{}`、`Object` 与 `Record` 不等价

```typescript
function acceptsObject(value: object) {}
acceptsObject({});
acceptsObject([]);
acceptsObject(() => {});
// acceptsObject("text"); // ❌ primitive
```

- `object`：排除 primitive，但包含数组和函数。
- `{}`：在 strict null 检查下表示任何非 null/undefined 值，连字符串和数字也能赋入。
- `Object`：JavaScript 包装对象接口，几乎不应作为“任意普通对象”使用。
- `Record<PropertyKey, unknown>`：要求可按所有 PropertyKey 索引，通常比“普通 JSON 对象”更强，不能随意代替 object。

验证 JSON object 常用运行时判断：

```typescript
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

是否排除特殊原型、Date、Map 或 class 实例取决于边界协议，不能只靠一个通用别名。

---

## 10. `void` 不等于“值严格为 undefined”

函数返回位置的 `void` 主要表达“调用方不应使用返回值”：

```typescript
const callback: () => void = () => 123;
// 合法：实现可以返回值，但通过 callback 调用时，结果按 void 丢弃。
```

这使 `array.forEach(item => output.push(item))` 等 JS 模式可用。它不意味着实现必须在运行时返回 undefined。

若协议要求 Promise 明确不携带结果，可使用 `Promise<void>`；若需要检查一个值确实是 undefined，则类型应直接写 `undefined`。回调 `() => void` 也不代表 fire-and-forget 异步函数的 rejection 会被自动处理。

---

## 11. TypeScript 不是健全证明器

为了兼容 JavaScript，TypeScript 有意允许一些无法完全证明安全的行为：

- 可变数组协变；
- 方法参数双变；
- 未开启额外严格选项时的索引访问；
- 类型断言和非空断言；
- `any` 污染；
- 外部 `.d.ts` 对运行时实现的声明可能错误。

成熟心智模型不是“tsc 通过就绝对安全”，而是知道静态证据在哪里变弱，并在 `unknown` 边界、schema、只读接口和测试中补足。详见 [07 · 可赋值性、方差与健全性](07_assignability_variance_and_soundness.md)。

---

## 12. TS 编译器工作流

```
.ts 源文件
    ↓
[Scanner]   词法分析 → Token 流
    ↓
[Parser]    语法分析 → AST（抽象语法树）
    ↓
[Binder]    符号绑定 → 建立符号表（变量/类型的作用域关系）
    ↓
[Checker]   类型检查 → 报告类型错误（核心！）
    ↓
[Emitter]   代码生成 → .js + .d.ts + .map
```

**关键理解**：类型检查和代码生成是**分离**的。即使类型检查有错误，TS 默认仍然会生成 JS 代码（可通过 `noEmitOnError: true` 禁止）。

还应区分三种常见执行链：

```text
tsc：parse → bind → check → emit
tsx/esbuild：主要做语法转换，另跑 tsc 才有完整类型检查
Node type stripping：擦除可擦除语法，不读取 tsconfig，也不做类型检查
```

“能运行 `.ts`”从来不等于“已经通过 TypeScript checker”。

---

## 一句话总结

TS 的类型系统 = **结构化类型 + 类型推断 + 控制流收窄**。理解这三个核心机制（而非死记语法），你就能写出优雅而非"和编译器打架"的 TS 代码。
