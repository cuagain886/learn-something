# 03 · 控制流分析与类型收窄实战 ⭐⭐⭐

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

// TypeScript 5.5+ 对满足特定条件的简单函数还能推断类型谓词：
const inferredStrings = values.filter(value => typeof value === "string");
// inferredStrings: string[]
```

谓词推断不是“任意 boolean 函数都能收窄”。函数需要有单一布尔返回、没有参数修改，并且判断能形成 `value is T` 的双向含义。复杂判断应显式写 predicate，并为其运行时逻辑写测试。

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

### 场景 1：被捕获变量可能在闭包执行前改变

```typescript
function schedule(value: string | null) {
    let current = value;
    if (current !== null) {
        const task = () => {
            // current 在闭包创建后仍可能被重新赋值，因此不能依赖旧收窄。
            // console.log(current.length); // ❌ current 可能是 null
        };
        current = null;
        setTimeout(task, 1000);
    }
}

// 解决：在已经证明的分支中捕获不可重新赋值的快照
function scheduleSafe(value: string | null) {
    if (value === null) return;
    const captured = value;
    setTimeout(() => console.log(captured.length), 1000);
}
```

现代 TypeScript 能在一些“最后一次赋值之后创建的闭包”中保留收窄，但前提必须可证明。不要把某个版本的优化当作并发不变量；共享对象仍可能被其他代码修改。

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

## 8. Checker 维护的是路径事实，不是改写原类型

```typescript
function parse(value: string | number | null): string {
    if (value === null) return "missing";

    if (typeof value === "number") {
        return value.toFixed(2);
    }

    return value.toUpperCase();
}
```

控制流图中的每条路径积累不同事实：

```text
入口：string | number | null
  ├─ value === null → null → return
  └─ 非 null：string | number
       ├─ typeof number → number → return
       └─ 剩余路径 → string
```

提前 return 能让后续路径排除已处理成员，这叫基于可达性的控制流分析。变量的**声明类型**仍然没有改变；以后赋值仍按原声明类型检查。

赋值会生成新事实：

```typescript
let value: string | number = "ready";
value; // 当前类型 string
value = 42;
value; // 当前类型 number
```

理解“声明类型”和“当前流类型”能解释为什么一次收窄不会永久锁死变量。

---

## 9. 自定义谓词是证明声明，不是证明实现

```typescript
function isUser(value: unknown): value is { id: string } {
    return true; // 编译器无法证明这个实现是谎言
}
```

TypeScript 只检查返回表达式是 boolean，不会验证它与谓词类型逻辑等价。谓词作者承担和类型断言类似的证明义务，而且错误会污染所有调用方。

稳健谓词应：

- 参数从 `unknown` 开始；
- 检查 null、数组与对象边界；
- 检查每个以后会使用的字段；
- 不执行隐藏副作用；
- 对合法、缺字段、错类型、极端输入写测试；
- 不把“能读取一个字段”夸大成完整领域类型。

如果需要错误列表、默认值、转换和跨字段不变量，返回 parse `Result` 比 boolean predicate 更合适。

---

## 10. Assertion Function 改变后续控制流

断言函数失败时必须中断，因此成功返回后 checker 可以增加事实：

```typescript
function assertString(value: unknown): asserts value is string {
    if (typeof value !== "string") {
        throw new TypeError("expected string");
    }
}

function normalize(value: unknown): string {
    assertString(value);
    return value.trim(); // value 已收窄为 string
}
```

只证明条件成立也可以：

```typescript
function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}
```

Assertion function 适合“失败即终止”的内部边界；HTTP 参数解析通常需要结构化错误结果，不能只抛第一条字符串异常。

---

## 11. 属性收窄可能被别名和写入破坏

```typescript
type Config = { token?: string };

function use(config: Config, mutate: (value: Config) => void): void {
    if (config.token !== undefined) {
        const token = config.token; // 捕获 primitive 快照
        mutate(config);             // 可能删除或修改 config.token
        token.toUpperCase();        // 安全：本地 const 不受对象写入影响
    }
}
```

TypeScript 不做完整的跨函数副作用分析。它可能在某些调用后仍保留属性收窄，但这不等于调用函数不会突变对象。涉及插件、回调和共享对象时，应复制需要的值、传 readonly 视图或建立不可变协议。

这也是“类型检查通过但运行时仍可能失败”的一个健全性边界。

---

## 12. `in` 检查的是属性存在，不是值一定可用

```typescript
type Fish = { swim: () => void };
type Human = { swim?: () => void; walk: () => void };

function move(value: Fish | Human): void {
    if ("swim" in value) {
        // Human 仍可能在这个分支，因为它允许拥有 swim 属性。
        value.swim?.();
    }
}
```

原型链上的属性也会让 `in` 为 true。解析 JSON DTO 时若协议要求自有属性，可使用 `Object.hasOwn(value, "key")`，并继续检查字段值类型。

在 `exactOptionalPropertyTypes` 下，“属性缺失”和“属性存在且 undefined”更明确，但运行时判断仍要匹配你的序列化协议。

---

## 13. `instanceof` 检查运行时构造器身份

```typescript
if (error instanceof CustomError) {
    // 检查原型链，而不是接口结构
}
```

它不能用于 interface/type，因为它们已擦除；跨 iframe/VM、Worker 序列化、不同包副本时，自定义构造器身份也可能不同。进程内受控对象适合 `instanceof`，跨网络协议应使用经过验证的判别字段。

---

## 14. 解构与判别字段的相关性

现代 TypeScript 能在受支持的 const 解构中保留判别关系：

```typescript
type Action =
    | { kind: "text"; payload: string }
    | { kind: "count"; payload: number };

function handle(action: Action): void {
    const { kind, payload } = action;
    if (kind === "text") payload.toUpperCase();
}
```

但把相关字段分别存入可变变量、跨函数返回不相关元组、或将回调参数写成两个独立联合，仍可能丢失关联。最稳定的设计是尽可能让判别字段和载荷共同留在一个可辨识联合值中。

---

## 15. 收窄调试顺序

1. 声明类型和当前流类型分别是什么？
2. 判断是否真的排除了目标成员，还是只做 truthiness？
3. 属性是必填、可选，还是值含 undefined？
4. 是否发生重新赋值、别名写入或闭包延迟执行？
5. 谓词是否正确声明为 `value is T`，实现是否真的证明 T？
6. 相关字段是否被拆成互不相关的联合？
7. 跨运行时边界是否错误使用了 instanceof？
8. 应该继续用 guard，还是建立 parse/Result 边界？

---

## 一句话总结

类型收窄让 TypeScript 的类型系统"活"了——它不只是检查注解，而是**跟随控制流实时更新类型信息**。可辨识联合 + 穷尽检查是生产级 TS 代码中最常用的模式组合。
