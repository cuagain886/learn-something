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

// ✅ 参数类型更宽 → 兼容（这是协变/逆变，见下文）
const handler1: Handler = (event: { x: number; y: number; z: number }) => {};
const handler2: Handler = (event: { x: number }) => {};  // ❌ 严格模式不兼容！
```

函数参数兼容性是 TS 类型系统中最微妙的点之一，详见 [[04_generics_and_type_programming|泛型与类型编程]] 中的协变/逆变讨论。

---

## 3. 用名义类型模拟"品牌"（Branding）

有时你也需要"两个结构相同但语义不同"的类型——比如 `UserId` 和 `ProductId` 都是 `number`，但不应混用：

```typescript
// 方案 1：品牌类型（Brand Type）—— 最轻量
type UserId = number & { readonly __brand: "UserId" };
type ProductId = number & { readonly __brand: "ProductId" };

function getUser(id: UserId) { /* ... */ }
function getProduct(id: ProductId) { /* ... */ }

const userId = 1 as UserId;
const productId = 2 as ProductId;

getUser(userId);       // ✅
getUser(productId);    // ❌ 类型不兼容！
// getProduct(userId); // ❌ 类型不兼容！
```

```typescript
// 方案 2：使用 unique symbol 做品牌（更严格）
declare const userIdBrand: unique symbol;
declare const productIdBrand: unique symbol;

type UserId = number & { [userIdBrand]: true };
type ProductId = number & { [productIdBrand]: true };

// 这样就直接赋值普通 number 都不行了，必须显式转换
```

---

## 4. Java 中的"结构化"例外

有趣的是，Java 在某些场景也表现出类似结构化类型的行为：

| 场景 | Java 行为 | 结构化程度 |
|------|---------|-----------|
| 类继承/接口 | 名义类型（必须 extends/implements） | 纯名义 |
| Lambda 表达式 | `(x) -> x.length()` 可赋给任何匹配签名的函数式接口 | ⭐ 结构化！ |
| 方法引用 | `String::length` 同上 | ⭐ 结构化！ |
| 泛型通配符 | `List<? extends Number>` | 部分结构化 |
| 数组协变 | `String[]` 是 `Object[]` 的子类型 | 运行时名义（有坑） |

Java 的 Lambda / 方法引用本质上是结构化类型——编译器只看签名是否匹配，不要求显式 `implements`。这也是为什么它的泛型系统 + Lambda 组合如此强大。

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

// 方式 3：enum（数字枚举的特殊行为）
```

---

## 7. 面试常见问题

**Q：TS 的类型兼容性是基于什么？和 Java 有什么不同？**

A：TS 基于**结构化类型**（结构兼容即可），Java 基于**名义类型**（显式声明继承/实现关系）。TS 只看"有没有需要的属性"，不看"类型叫什么名字"。

**Q：如何防止两个结构相同但语义不同的类型被混用？**

A：使用**品牌类型**（brand type），给类型附加一个独特的标记（如 `& { __brand: "UserId" }`），让它们在结构上不同。

**Q：为什么 TS 选择结构化类型？**

A：因为 TS 要描述的是**任意 JavaScript 代码**——那些代码没有显式的继承关系，但它们的形状（shape）是确定的。结构化类型让 TS 能为已有 JS 库添加类型，而不需要修改源码。

---

## 一句话总结

Java 说"你是你，因为你的名字是你"（名义类型）。TypeScript 说"你是你，因为你的形状是你"（结构化类型）。理解这个差异，就理解了 TS 80% 的"为什么"。
