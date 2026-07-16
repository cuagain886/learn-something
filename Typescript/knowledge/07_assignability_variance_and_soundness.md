# 07 · 可赋值性、方差与类型系统的边界 ⭐⭐⭐

> “类型相等”在 TS 中不是核心问题；真正频繁发生的是：来源类型能否安全地放进目标位置。

---

## 1. 先区分声明类型、当前类型与可赋值性

```typescript
let value: string | number = "ready";
// 声明类型：string | number
// 当前控制流类型：string

value = 42; // ✅ number 可赋值给声明类型
```

控制流收窄不会永久改写变量的声明类型。之后的赋值始终对声明类型检查，而在某个表达式位置能调用什么成员，则取决于当前控制流类型。

TS 的主要关系包括：

- **可赋值性**：`source` 是否能放到 `target` 中。
- **子类型关系**：更偏理论，和可赋值性高度重合但并非完全等同。
- **类型恒等**：两个类型是否被视为相同，日常较少直接需要。

`any`、数字枚举、泛型约束等规则让“可赋值”不等于严格的数学子类型。

---

## 2. 对象兼容：目标需要什么，来源就必须提供什么

```typescript
type Named = { name: string };
type User = { name: string; age: number };

const user: User = { name: "Ada", age: 36 };
const named: Named = user; // ✅ 来源可以有额外成员
```

但新鲜对象字面量会触发**多余属性检查**：

```typescript
const direct: Named = { name: "Ada", age: 36 }; // ❌ age 不在目标类型中
```

这不是结构类型原则被推翻，而是针对常见拼写错误的额外启发式检查。不要用中间变量或 `as Named` 绕过；如果确实允许额外键，应在模型中表达：

```typescript
type NamedWithMetadata = Named & Record<string, unknown>;
```

---

## 3. 函数兼容：参数和返回值方向相反

```typescript
class Animal { animal = true }
class Dog extends Animal { bark() {} }

type Producer<T> = () => T;
type Consumer<T> = (value: T) => void;

const makeDog: Producer<Dog> = () => new Dog();
const makeAnimal: Producer<Animal> = makeDog; // ✅ 返回值协变

const handleAnimal: Consumer<Animal> = _ => {};
const handleDog: Consumer<Dog> = handleAnimal; // ✅ 参数逆变
```

为什么消费者方向反过来？需要“能处理 Dog 的函数”时，传入一个“任何 Animal 都能处理”的函数是安全的；反方向会把普通 Animal 交给只会处理 Dog 的函数。

在 `strictFunctionTypes` 下，函数类型属性按这个方向检查。方法语法保留了较宽松的双变行为以兼容大量既有层级：

```typescript
interface UnsafeStyle<T> {
    consume(value: T): void; // 方法
}

interface SaferStyle<T> {
    consume: (value: T) => void; // 函数属性
}
```

设计回调接口时优先函数属性；它更能暴露不安全的窄参数实现。

---

## 4. 什么是协变、逆变、不变、双变

假设 `Dog` 可赋值给 `Animal`：

| 泛型关系 | 含义 | 典型位置 |
|---|---|---|
| 协变 | `F<Dog>` → `F<Animal>` | 只读输出、返回值 |
| 逆变 | `F<Animal>` → `F<Dog>` | 函数参数、消费者 |
| 不变 | 两个方向都不允许 | 同时安全地读写 |
| 双变 | 两个方向都允许 | 部分方法/事件兼容规则，存在风险 |

方差不是给类型贴的固定标签，而是类型参数如何被使用产生的结果。一个 `T` 同时出现在输入和输出位置，通常应接近不变。

```typescript
type Box<T> = {
    get: () => T;
    set: (value: T) => void;
};
```

若 `Box<Dog>` 被当成 `Box<Animal>`，调用方就能塞入 `Cat`；若反过来，读取结果又不一定是 Dog。因此两向都危险。

---

## 5. 数组为什么是经典的不健全点

```typescript
const dogs: Dog[] = [new Dog()];
const animals: Animal[] = dogs; // TS 允许
animals.push(new Animal());     // 破坏 dogs 的承诺
dogs[1].bark();                 // 运行时失败
```

这是为了 JavaScript 易用性保留的妥协。只读视图能删除写入能力：

```typescript
function inspect(animals: readonly Animal[]) {
    // animals.push(...) // ❌
}

inspect(dogs); // ✅
```

API 只读取集合时，参数应写 `readonly T[]` 或 `ReadonlyArray<T>`。这不仅表达意图，也扩大安全可接受的输入范围。

---

## 6. 索引访问：类型说“一定有”，运行时可能没有

```typescript
const names: string[] = [];
const first = names[0];
// 默认配置中是 string，运行时其实是 undefined
```

开启 `noUncheckedIndexedAccess` 后，索引签名和数组访问会加入 `undefined`：

```typescript
const first = names[0]; // string | undefined
if (first !== undefined) first.toUpperCase();
```

它会带来额外检查，但能消除一整类越界和未知键错误。对无法开启的旧项目，至少在外部数据表、缓存和字典边界显式使用 `T | undefined`。

---

## 7. 可选属性不是简单的 `T | undefined`

```typescript
type Patch = { nickname?: string };
```

这里有两个不同状态：键不存在，以及键存在但值为 `undefined`。默认情况下 TS 对二者较宽松；开启 `exactOptionalPropertyTypes` 后：

```typescript
const a: Patch = {};                        // ✅ 缺失
const b: Patch = { nickname: undefined };   // ❌ 除非显式写 string | undefined
```

这对 PATCH 请求、配置合并、`in` 判断很重要：

- “缺失”常表示不修改或使用默认值。
- “存在且 undefined”可能表示显式清空，也可能在序列化时被丢弃。

领域模型应决定两者是否真的等价，再选择类型，而不是让默认编译器行为替你决定。

---

## 8. 类型断言、非空断言和 `any` 都在转移责任

```typescript
const user = response as User;
element!.focus();
const data: any = JSON.parse(text);
```

它们不会添加运行时证明，只会把证明义务从编译器转给开发者：

- `as T`：我保证值符合 T。
- `!`：我保证这里不是 null/undefined。
- `any`：这一段不再检查，也会污染后续表达式。

更安全的隔离方式是 `unknown`：

```typescript
const data: unknown = JSON.parse(text);
// 在验证前不能访问属性
```

如果必须断言，把它限制在一个小函数中，并在函数内部做真实检查；不要让断言散落在业务逻辑里。

---

## 9. `Map`、对象和“查找可能失败”

```typescript
const users = new Map<string, User>();
const user = users.get("u1"); // User | undefined，建模正确
```

对比 `Record<string, User>`：

```typescript
const users: Record<string, User> = {};
const user = users["missing"]; // 未开 noUncheckedIndexedAccess 时是 User
```

若键集合不是封闭集合，`Map.get` 或返回 `T | undefined` 的封装比宽泛 `Record<string, T>` 更诚实。`Record` 更适合已知有限键：

```typescript
type Role = "admin" | "member";
const labels: Record<Role, string> = {
    admin: "管理员",
    member: "成员",
};
```

---

## 10. 健全性检查清单

- 回调参数使用函数属性，并开启 `strictFunctionTypes`。
- 只读集合参数写成 `readonly T[]`。
- 外部数据从 `unknown` 开始，不从 `any` 开始。
- 动态索引开启 `noUncheckedIndexedAccess` 或显式返回 `| undefined`。
- 区分可选键与值为 `undefined`，评估 `exactOptionalPropertyTypes`。
- 断言集中在边界适配层，并写测试覆盖其运行时前提。
- 不用中间变量逃避多余属性检查。

---

## 一句话总结

TypeScript 有意在健全性和 JavaScript 易用性之间折中。成熟的工程不是假设“通过类型检查就绝对安全”，而是知道数组写入、动态索引、方法双变和断言这些边界，并主动缩小它们。

