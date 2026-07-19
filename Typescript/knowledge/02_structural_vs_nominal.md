# 02 · 结构化类型 vs 名义类型 ⭐⭐⭐

> 这是 Java/C# 程序员学习 TypeScript 时最容易产生困惑的核心概念。
> Java 是**名义类型**（Nominal Typing），TypeScript 是**结构化类型**（Structural Typing）。
> 这不仅是语法差异，而是两种完全不同的类型哲学。

---

## 1. 两种类型系统的本质差异

### 名义类型（Nominal Typing）—— Java

```java
// Java：两个 interface 名字不同 → 就是不同类型
interface Point2D { int getX(); int getY(); }
interface Coordinate { int getX(); int getY(); }

Point2D p1 = new Point2DImpl(1, 2);
Coordinate c1 = p1;  // ❌ 编译错误！类型名不匹配

// 即使结构完全一样也不行
class Foo { int x; int y; }
class Bar { int x; int y; }
Foo f = new Bar();  // ❌ 编译错误！
```

**名义类型的判断规则**：两个类型相同 ⇔ 它们的**名字**相同（或在继承链上）。

### 结构化类型（Structural Typing）—— TypeScript

```typescript
// TS：两个类型结构相同 → 可以互相赋值
interface Point2D { x: number; y: number; }
interface Coordinate { x: number; y: number; }

const p: Point2D = { x: 1, y: 2 };
const c: Coordinate = p;  // ✅ 合法！结构相同即可
```

**结构化类型的判断规则**：类型 A 可以赋值给类型 B ⇔ A 的**结构**包含了 B 要求的所有成员。

---

## 2. 结构化类型的实际影响

### 2.1 "多余的属性"是可以的

```typescript
interface Person {
    name: string;
    age: number;
}

const employee = {
    name: "Alice",
    age: 30,
    salary: 100000,  // 多余的属性
};

const p: Person = employee;  // ✅ 合法！employee 至少有 name 和 age
```

这叫做"**最小契约**"：只要你有我要的属性，其他的我不管。

### 2.2 但"直接字面量"会触发额外检查

```typescript
// ❌ 直接传对象字面量：触发"额外属性检查"
const p: Person = {
    name: "Bob",
    age: 25,
    salary: 50000,  // ❌ 编译错误！字面量有额外属性
};

// ✅ 绕过方式：先赋值给变量
const temp = { name: "Bob", age: 25, salary: 50000 };
const p2: Person = temp;  // ✅ 合法（不检查额外属性）

// ✅ 绕过方式 2：类型断言
const p3: Person = {
    name: "Bob",
    age: 25,
    salary: 50000,
} as Person;  // ✅ 合法（手动断言）
```

**为什么要这样设计？** 直接写对象字面量时，多出来的属性很可能是拼写错误。但通过变量传递时，多余属性通常是有意为之（如携带额外元数据）。

### 2.3 函数参数兼容性

```typescript
type Handler = (event: { x: number; y: number }) => void;

// ❌ 实现要求额外的 z，但调用 Handler 的代码只承诺传 x/y
// const unsafe: Handler = (event: { x: number; y: number; z: number }) => {};

// ✅ 实现只读取 x，因此任何满足 Handler 的 x/y 对象都能安全处理
const safe: Handler = (event: { x: number }) => {
    console.log(event.x);
};
```

在 `strictFunctionTypes` 下，函数属性的参数按逆变方向检查；方法语法为了兼容常见 JS/DOM 模式仍保留双变例外。完整讨论见 [07 · 可赋值性、方差与健全性](07_assignability_variance_and_soundness.md)。

---

## 3. 用名义类型模拟"品牌"（Branding）

有时你也需要"两个结构相同但语义不同"的类型——比如 `UserId` 和 `ProductId` 都是 `number`，但不应混用：

```typescript
// 方案 1：品牌类型（Brand Type）—— 最轻量
type UserId = number & { readonly __brand: "UserId" };
type ProductId = number & { readonly __brand: "ProductId" };

function getUser(id: UserId) { /* ... */ }
function getProduct(id: ProductId) { /* ... */ }

function userId(value: number): UserId {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError("invalid user id");
    }
    return value as UserId;
}

function productId(value: number): ProductId {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError("invalid product id");
    }
    return value as ProductId;
}

const currentUserId = userId(1);
const currentProductId = productId(2);

getUser(currentUserId);          // ✅
// getUser(currentProductId);    // ❌ 类型不兼容！
// getProduct(currentUserId);    // ❌ 类型不兼容！
```

品牌的断言只能集中在已经完成运行时校验的构造边界。如果调用方到处 `as UserId`，它只是把普通 number 伪装成已验证 ID。

```typescript
// 方案 2：使用 unique symbol 做品牌（更严格）
declare const userIdBrand: unique symbol;
declare const productIdBrand: unique symbol;

type UserId = number & { [userIdBrand]: true };
type ProductId = number & { [productIdBrand]: true };

// 这样就直接赋值普通 number 都不行了，必须显式转换
```

---

## 4. Java Lambda 不是结构化子类型

Java Lambda 会根据**目标函数式接口**做 target typing，两个签名相同的函数式接口仍然是不同的名义类型：

```java
interface ParserA { String parse(String input); }
interface ParserB { String parse(String input); }

ParserA a = input -> input.trim();
ParserB b = input -> input.trim();
// b = a; // 编译错误：ParserA 不是 ParserB
```

Lambda 语法能分别转换到两个目标接口，不代表接口实例之间形成结构化子类型关系。

| 场景 | Java 行为 | 结构化程度 |
|------|---------|-----------|
| 类继承/接口 | 名义类型（必须 extends/implements） | 纯名义 |
| Lambda 表达式 | 根据目标名义函数式接口进行转换 | target typing，不是结构化子类型 |
| 方法引用 | 根据目标函数式接口进行转换 | target typing，不是结构化子类型 |
| 泛型通配符 | `List<? extends Number>` | 部分结构化 |
| 数组协变 | `String[]` 是 `Object[]` 的子类型 | 运行时名义（有坑） |

因此更准确的类比是：Java Lambda 与 TypeScript **上下文类型**都能从使用位置获得参数签名，但 Java 的接口赋值关系仍然是名义的。

---

## 5. 结构化类型的优缺点

### 优点

1. **灵活性**：不需要预见到所有可能的接口组合。可以让完全不相关的类型互相协作
2. **可组合性**：函数只声明"我需要什么"，调用方无须知道你的类型名
3. **测试友好**：Mock 对象不需要 `implements` 原接口，只要结构匹配即可
4. **JSON/API 数据**自然兼容：后端返回的 JSON 不需要手动声明它"实现"了你的接口

### 缺点

1. **类型安全降低**：两个语义不同的类型可能意外兼容（这时候需要品牌类型）
2. **错误信息难读**：不匹配时报"缺少属性 xxx"而非"类型 A 不能赋值给类型 B"
3. **重构风险**：改一个类型的结构，可能意外影响不相关的赋值点

---

## 6. TypeScript 的"名义化"手段

当你确实需要名义类型的行为时，TS 提供了几种方式：

```typescript
// 方式 1：class + private 字段（有名义成分）
class UserId {
    private __brand!: "UserId";
    constructor(public value: number) {}
}
class ProductId {
    private __brand!: "ProductId";
    constructor(public value: number) {}
}
// UserId 和 ProductId 不兼容（因为它们有不同名的 private 字段）

// 方式 2：unique symbol（最严格的品牌类型）
declare const brand: unique symbol;
type Branded<T, B> = T & { [brand]: B };

// 方式 3：封装对象/类，在构造器里同时建立运行时不变量
```

普通 enum 有运行时对象和特殊兼容规则，但不是通用品牌机制；跨 JSON 边界时字符串字面量联合通常更透明。

---

## 7. 新鲜对象字面量检查不是“精确对象类型”

TypeScript 的对象类型通常是开放的最小契约：

```typescript
type Named = { name: string };

const source = { name: "Ada", internal: true };
const named: Named = source; // 合法
```

直接对象字面量触发的 excess property check 是一项启发式错误检查，不会把 `Named` 变成“只能有 name 的精确类型”。以下操作的含义各不相同：

```typescript
const annotated: Named = { name: "Ada" };
// 变量的观察类型就是 Named

const checked = { name: "Ada", internal: true } satisfies Named;
// 检查满足 Named，同时保留 internal 的推断

const asserted = { name: "Ada", typo: true } as Named;
// 断言可能跳过你真正希望得到的拼写检查
```

若运行时协议必须拒绝额外字段，必须由 schema/parser 明确执行；TypeScript 的结构兼容不会在 JSON 上删除或拒绝字段。

---

## 8. 类只有实例侧参与普通结构比较

```typescript
class A {
    static version = 1;
    value = "a";
}

class B {
    static version = 2;
    value = "b";
}

let instance: A = new B(); // 实例结构兼容
```

`A` 作为类型名通常指实例侧；`typeof A` 才是包含构造签名和静态成员的值侧类型：

```typescript
type AConstructor = typeof A;
```

这解释了为什么 generic factory 约束要写 `new (...args) => T`，以及为什么静态成员不会自动参与实例兼容判断。

### private/protected 引入名义成分

如果目标实例类型含 TypeScript `private`/`protected` 成员，来源必须包含源自同一声明的成员。两个类即使写了同名 private，也不兼容。这个规则发生在 checker 中；TS `private` 通常会被擦除，不等于运行时 `#private` 品牌检查。

---

## 9. 泛型参数只有进入结构才影响兼容性

```typescript
interface Phantom<T> {}

let numberTag!: Phantom<number>;
let stringTag!: Phantom<string>;
numberTag = stringTag; // 合法：T 没有改变任何成员结构
```

加入成员后才产生差异：

```typescript
interface Box<T> {
    readonly value: T;
}

// Box<number> 与 Box<string> 的 value 不兼容
```

仅仅声明 `<T>` 不会自动创造名义身份。若类型参数用于品牌，必须让它出现在不可伪造的 `unique symbol` 属性等结构位置。

---

## 10. Agent 架构为什么受益于结构类型

模型、存储和工具适配器可以只声明最小端口：

```typescript
interface ModelPort {
    complete(request: ModelRequest, signal: AbortSignal): Promise<ModelTurn>;
}
```

生产 SDK adapter、测试 fake、本地模型都无需继承共同基类，只要满足结构即可。这使六边形架构和依赖注入非常自然。

风险是“碰巧同形”的对象可能被误接线。解决方式不是给所有东西加 class，而是：

- 让领域端口包含有语义的判别字段或方法；
- 对 ID、权限等同形 primitive 使用受控品牌；
- 在 composition root 显式装配依赖；
- 外部数据仍从 unknown 验证；
- 对关键端口写 contract tests。

---

## 11. 常见问题

**Q：TS 的类型兼容性是基于什么？和 Java 有什么不同？**

A：TS 基于**结构化类型**（结构兼容即可），Java 基于**名义类型**（显式声明继承/实现关系）。TS 只看"有没有需要的属性"，不看"类型叫什么名字"。

**Q：如何防止两个结构相同但语义不同的类型被混用？**

A：使用**品牌类型**（brand type），给类型附加一个独特的标记（如 `& { __brand: "UserId" }`），让它们在结构上不同。

**Q：为什么 TS 选择结构化类型？**

A：因为 TS 要描述的是**任意 JavaScript 代码**——那些代码没有显式的继承关系，但它们的形状（shape）是确定的。结构化类型让 TS 能为已有 JS 库添加类型，而不需要修改源码。

---

## 一句话总结

Java 说"你是你，因为你的名字是你"（名义类型）。TypeScript 说"你是你，因为你的形状是你"（结构化类型）。理解这个差异，就理解了 TS 80% 的"为什么"。
