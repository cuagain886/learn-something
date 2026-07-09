# 01 · TypeScript 类型系统全景 ⭐⭐⭐

> TypeScript = JavaScript + 类型系统。理解这个类型系统的设计哲学，比记住具体语法重要十倍。

---

## 1. TS 类型系统的定位

| 特性 | JavaScript | TypeScript | Java |
|------|-----------|------------|------|
| 类型检查时机 | 运行时 | 编译时 | 编译时 |
| 类型标注 | 无 | 可选（渐进式） | 强制 |
| 类型擦除 | - | 运行时无类型信息 | 泛型擦除 |
| 类型推导 | - | 有（比 Java 的 var 强大得多） | 有（var，局部变量） |
| 运行时行为 | 动态 | = 编译后的 JS（和 JS 完全一样） | JVM 执行 |

**核心认知**：TypeScript 的类型系统是"编译时"的，一旦编译成 JS，所有类型信息消失。这不影响运行时——这意味着"类型正确"不等于"逻辑正确"，但它能防止大量低级错误。

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

**什么时候必须写类型注解？**
1. 函数参数（TS 不会推断参数类型）
2. 没有初始值的变量（`let x;` → 变成 `any`）
3. 你想让类型比推断结果更宽/更窄时
4. 对外暴露的 API（函数返回值、导出的接口）—— 做文档用

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

不同类型系统对比详见 [[02_structural_vs_nominal]]。

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

`never` 是**所有类型的子类型**（可以赋给任何类型），但**没有类型是 never 的子类型**（除了 never 本身）。

### 他们之间的关系

```
        unknown ←── 任何类型都可以赋值给 unknown
           ↑
         any    ←── 可以赋给任何 / 接受任何（类型检查的开关）
           ↑
        object
        /  |  \
    string number boolean ...
        \  |  /
         never  ←── 可以赋值给任何类型 / 没有任何值
```

| 类型 | 赋值给其他类型 | 接受其他类型赋值 | 安全访问属性 |
|------|:---:|:---:|:---:|
| `any` | ✅ | ✅ | ✅（运行时可炸）|
| `unknown` | ❌ | ✅ | ❌（必须先收窄）|
| `never` | ✅ | ❌ | ❌（不存在值）|

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
| `let x = "hi" as const` | `"hi"` | ❌ |
| `let x: "hi" = "hi"` | `"hi"` | ❌（只能赋 "hi"） |

---

## 7. 严格模式（strict）—— 你应该全部打开

```json
{
    "compilerOptions": {
        "strict": true  // 开启所有严格检查
    }
}
```

`strict: true` 会打开以下所有子选项：

| 子选项 | 作用 | 不开会怎样 |
|--------|------|-----------|
| `strictNullChecks` | null/undefined 不能随意赋值 | 所有类型自动包含 null/undefined（亿万美金的错误） |
| `noImplicitAny` | 推断不出类型时报错 | TS 悄悄用 any，失去类型保护 |
| `strictFunctionTypes` | 函数参数类型正确逆变检查 | 函数赋值可能类型不安全 |
| `strictBindCallApply` | bind/call/apply 的类型检查 | 这些函数的参数可能不检查 |
| `strictPropertyInitialization` | 类属性必须初始化 | 未初始化的属性编译通过 |
| `noImplicitThis` | this 不能隐式 any | this 的拼写错误不会报错 |
| `alwaysStrict` | 输出 "use strict" | 非严格模式的语义差异 |

---

## 8. TS 编译器工作流

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

---

## 一句话总结

TS 的类型系统 = **结构化类型 + 类型推断 + 控制流收窄**。理解这三个核心机制（而非死记语法），你就能写出优雅而非"和编译器打架"的 TS 代码。
