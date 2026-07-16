# 03 · 类型收窄实战模式 ⭐⭐

> 类型收窄（Type Narrowing）= 在一个代码分支中，让 TypeScript 自动把"宽类型"缩小为"窄类型"。这是 TS 类型系统最有实用价值的能力。

---

## 1. 什么是类型收窄？

```typescript
function process(value: string | number) {
    // 此时 value 是 string | number（宽类型）
    console.log(value.length);  // ❌ number 没有 .length

    if (typeof value === "string") {
        // 在这个分支里，TS 自动将 value 收窄为 string（窄类型）
        console.log(value.length);  // ✅ string 有 .length
    } else {
        // 在这里，value 是 number（被排除法收窄）
        console.log(value.toFixed(2));  // ✅ number 有 .toFixed
    }
}
```

这看起来简单，但它背后的原理非常强大——TS 在**编译时**模拟了**运行时**的控制流。

---

## 2. 收窄手段全览

### 2.1 typeof 守卫

```typescript
function padLeft(value: string | number) {
    if (typeof value === "string") {
        return value.padStart(10);
    }
    return value.toFixed(2);  // TS 知道这是 number
}

// 能判断的类型：string | number | bigint | boolean | symbol | undefined | object | function
```

**⚠️ 陷阱**：`typeof null === "object"`，所以 `typeof` 无法区分 `null` 和普通对象。

### 2.2 instanceof 守卫

```typescript
class ApiError extends Error { statusCode: number = 500; }
class NetworkError extends Error { retryAfter: number = 0; }

function handleError(err: Error) {
    if (err instanceof ApiError) { err.statusCode; }     // ApiError
    else if (err instanceof NetworkError) { err.retryAfter; }  // NetworkError
    else { err.message; }  // Error
}
```

### 2.3 in 操作符守卫

```typescript
type Fish = { swim: () => void };
type Bird = { fly: () => void };

function move(animal: Fish | Bird) {
    if ("swim" in animal) { animal.swim(); }
    else { animal.fly(); }
}
```

### 2.4 真值收窄

```typescript
function print(name: string | null | undefined) {
    if (name) {
        // name 被收窄为 string（排除了 null、undefined 和 ""）
        console.log(name.toUpperCase());
    }
}
```

**⚠️ 小心**：空字符串 `""` 和数字 `0` 也是 falsy，会被一起排除。如果你只想排除 `null`/`undefined`，用 `name != null`。

### 2.5 相等收窄

```typescript
function check(x: string | number, y: string | boolean) {
    if (x === y) {
        // TS 推断出 x 和 y 必然都是 string（唯一可能相等的类型）
        x.toUpperCase();
    }
}
```

### 2.6 赋值收窄

```typescript
let x: string | number = "hello";
x = 42;
// TS 跟踪 x 的最新赋值，知道此时 x 是 number
x.toFixed(2);
```

---

## 3. 模式一：可辨识联合（Discriminated Union）⭐

这是 TS 中最优雅、最推荐的建模方式：

```typescript
// ❌ 不好的设计：用可选属性区分类型
type Shape = {
    kind: string;               // 宽泛的标识
    radius?: number;            // 只有圆有
    width?: number;             // 只有矩形有
    height?: number;            // 只有矩形有
};

// ✅ 好的设计：可辨识联合
interface Circle {
    kind: "circle";             // 字面量类型作为"标签"
    radius: number;
}
interface Rectangle {
    kind: "rectangle";
    width: number;
    height: number;
}
interface Triangle {
    kind: "triangle";
    base: number;
    height: number;
}
type Shape = Circle | Rectangle | Triangle;

// TS 根据 kind 自动收窄
function area(shape: Shape): number {
    switch (shape.kind) {
        case "circle":    return Math.PI * shape.radius ** 2;
        case "rectangle": return shape.width * shape.height;
        case "triangle":  return (shape.base * shape.height) / 2;
    }
}
```

**优点**：
1. 类型安全——每个分支 TS 都知道确切类型
2. IDE 自动补全——输入 `shape.` 时，IDE 显示该分支合法的属性
3. 重构友好——新增联合成员时，编译器可在所有 switch 处报错

**可辨识联合的设计原则**：
- 每个成员有一个共同的**字面量类型**属性（"标签"）
- 标签类型通常是 `string` 字面量，也可以是 `number` 字面量
- 标签应区分语义（`kind: "circle"`），而非区分实现细节

---

## 4. 模式二：自定义类型谓词（Type Predicate）

当你需要封装"判断类型"的逻辑时：

```typescript
// 类型谓词：返回值写成 `参数 is 类型`
function isString(value: unknown): value is string {
    return typeof value === "string";
}

// 数组的 filter 使用类型谓词自动收窄
const values: (string | number)[] = ["a", 1, "b", 2];
const strings: string[] = values.filter(isString);  // ✅ 自动得到 string[]
// 对比：values.filter(v => typeof v === "string") 返回 (string | number)[]
//      因为箭头函数的返回类型不是类型谓词，TS 不会自动收窄！
```

**实战模式**：

```typescript
// 判断对象是否有某个属性（运行时）
function hasProperty<K extends string>(
    obj: unknown,
    key: K
): obj is Record<K, unknown> {
    return typeof obj === "object" && obj !== null && key in obj;
}

// 使用
const data: unknown = await fetch("/api/data").then(r => r.json());
if (hasProperty(data, "users") && Array.isArray(data.users)) {
    data.users.forEach(user => { /* ... */ });
}
```

**自定义谓词 vs 普通 boolean**：

| 写法 | 调用后收窄 | 适用场景 |
|------|:---:|------|
| `(x): x is T => boolean` | ✅ 自动收窄 | 判断函数、filter 回调 |
| `(x): boolean` | ❌ 不收窄 | 普通布尔逻辑 |

---

## 5. 模式三：穷尽检查（Exhaustiveness Check）

利用 `never` 类型确保**所有可能的联合成员都被处理**：

```typescript
function assertNever(x: never): never {
    throw new Error(`Unexpected: ${x}`);
}

function area(shape: Shape): number {
    switch (shape.kind) {
        case "circle":    return Math.PI * shape.radius ** 2;
        case "rectangle": return shape.width * shape.height;
        // 如果忘记处理 triangle：
        default:
            // shape 的类型是 Triangle（未被前面的 case 收窄）
            // assertNever 期望 never → ❌ 编译错误！
            return assertNever(shape);
    }
}
```

**为什么这样做？**
- 当你新增一个 `Square` 到 `Shape` 联合时，`default` 分支的 `shape` 变成 `Square`（不再是 `never`）
- `assertNever(shape)` 编译报错 → 提醒你"这里还没处理 Square！"

**没有穷尽检查的风险**：
- 代码默默走到 `default`，可能返回 `undefined`，在别处引发难以追踪的 bug
- 新人加入团队，看到 `Shape` 有 5 种类型，不知道某个 switch 只处理了 3 种

---

## 6. 模式四：const 断言 + 模式匹配

```typescript
// 定义状态机
type State =
    | { status: "idle" }
    | { status: "loading"; progress: number }
    | { status: "success"; data: string }
    | { status: "error"; error: Error };

// 用 switch 做模式匹配
function renderState(state: State): string {
    switch (state.status) {
        case "idle":    return "等待中...";
        case "loading": return `加载中 ${state.progress}%`;
        case "success": return `数据：${state.data}`;
        case "error":   return `错误：${state.error.message}`;
    }
}
```

这个模式在前端开发中极其常见——React 的 `useReducer`、Vue 的 computed 状态、API 请求的状态管理都适合用可辨识联合。

---

## 7. 收窄失效场景 & 解决方案

### 场景 1：收窄在闭包中失效

```typescript
function foo(x: string | null) {
    if (x) {
        setTimeout(() => {
            console.log(x.length);  // ❌ TS 报错！x 可能变成 null 了
        }, 1000);
    }
}
// 原因：TS 不知道 setTimeout 执行时 x 是否还是非 null
// 解决：用 const 捕获当前值
//   const captured = x;
//   setTimeout(() => console.log(captured.length), 1000);
```

### 场景 2：在条件外部收窄丢失

```typescript
function bar(x: string | number) {
    const isStr = typeof x === "string";
    if (isStr) {
        x.toUpperCase();  // ✅ TS 会跟踪未被重新赋值的别名条件
    }
}
// 若 isStr 使用 let 且后来被改写，或判断被封装进返回 boolean（而非类型谓词）
// 的普通函数，编译器才可能失去 value 与判断结果之间的关联。
```

---

## 一句话总结

类型收窄让 TypeScript 的类型系统"活"了——它不只是检查注解，而是**跟随控制流实时更新类型信息**。可辨识联合 + 穷尽检查是生产级 TS 代码中最常用的模式组合。
