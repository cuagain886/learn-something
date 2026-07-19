# 15 · TypeScript 之下的 JavaScript 运行时对象模型 ⭐⭐⭐

> TypeScript Checker 只在开发阶段存在。程序启动后，决定属性查找、`this`、继承、私有性和复制语义的是 JavaScript 对象模型。

配套实验：[第 22 课 JavaScript 运行时模型](../code/src/22-javascript-runtime-model.ts)。

---

## 1. 对 Java 开发者最重要的前提：类型不是运行时元数据

```typescript
interface User { id: string }
type UserId = string & { readonly __brand: 'UserId' };

function load(user: User): UserId {
  return user.id as UserId;
}
```

默认 emit 后，interface、type、类型注解和断言都消失。运行时只剩普通对象和字符串：

```javascript
function load(user) {
  return user.id;
}
```

因此：

- 不能对 interface 使用 `instanceof`。
- 泛型参数不能在运行时反射。
- 品牌类型不会自动验证字符串。
- `readonly` 不会自动冻结对象。
- `private` 不一定产生运行时私有槽。
- `as T` 不会转换或校验值。

若框架提供运行时类型信息，通常来自装饰器 metadata、schema、class 构造器或代码生成，不是 TypeScript 类型系统自动保留。

---

## 2. 对象不是“类实例字段表”，而是属性集合加原型链接

从概念上看，普通对象包含：

```text
Object
  ├─ own properties
  │    ├─ string-keyed properties
  │    └─ symbol-keyed properties
  └─ [[Prototype]] ──> another object or null
```

读取 `object.key` 时，运行时大致执行：

1. 查找 object 自有属性 `key`。
2. 没找到则取 object 的 `[[Prototype]]`。
3. 沿链继续查找。
4. 直到找到属性或原型为 null。

```typescript
const base = { kind: 'agent' };
const child = Object.create(base);

child.kind;                       // 从 base 找到
Object.hasOwn(child, 'kind');     // false
```

赋值 `child.kind = 'worker'` 通常在 child 创建自有属性，遮蔽原型属性。删除该自有属性后，读取又会落回原型。它不是修改了“继承来的字段槽”。

### 为什么优先 `Object.hasOwn`

`'key' in object` 会检查整条原型链；`Object.hasOwn(object, 'key')` 只检查自有属性。解析不可信字典时，这一区别能避免原型上的成员被误当成输入字段。

---

## 3. `[[Prototype]]` 与函数的 `.prototype` 不是同一个东西

这两个名字非常容易混淆：

- 每个普通对象有内部 `[[Prototype]]` 链接，可由 `Object.getPrototypeOf` 查看。
- 可构造函数通常有公开 `.prototype` 属性；`new Constructor()` 会把新实例的 `[[Prototype]]` 指向它。

```typescript
class Agent {}
const agent = new Agent();

Object.getPrototypeOf(agent) === Agent.prototype; // true
```

`Agent.prototype` 本身也是对象，它的原型通常继续指向 `Object.prototype`。静态方法则在构造器对象 `Agent` 上或其构造器原型链上，不在实例原型上。

---

## 4. class 没有引入第二套继承机制

JavaScript class 提供了更严格、清晰的构造和继承语法，但实例方法仍通过 prototype 共享：

```typescript
class Service {
  method() {}
  field = 1;
  arrow = () => this.field;
}
```

典型运行时布局：

```text
Service constructor object
  └─ .prototype
       ├─ constructor
       └─ method()            ← 所有实例共享

service instance
  ├─ field                    ← 每个实例自有
  ├─ arrow                    ← 每个实例一个函数/闭包
  └─ [[Prototype]] → Service.prototype
```

箭头字段作为回调时不会丢失 `this`，但每个实例都会分配新函数。普通 prototype 方法共享函数对象，内存更省，却需要由调用点提供正确 receiver。不能简单规定“所有方法都写箭头”或“永远不用箭头”，要根据回调语义和实例数量权衡。

---

## 5. `this` 是调用语义，不是变量声明位置的固定实例

普通函数的 `this` 主要由调用形式决定：

```typescript
object.method();        // this = object
method.call(object);    // this = object
method.apply(object, []);
const bound = method.bind(object);
new Constructor();      // this = 新实例
```

提取方法后裸调用：

```typescript
const detached = object.method;
detached();
```

在模块/严格模式下 `this` 通常为 undefined。TypeScript 的 `this` 参数可以检查调用约束：

```typescript
function render(this: { id: string }, value: string) {
  return `${this.id}:${value}`;
}
```

这个 `this` 参数不会出现在运行时参数列表；它只是 Checker 的调用契约。

### 箭头函数

箭头函数没有自己的 `this`、`arguments` 和可构造能力。它从创建位置捕获词法 `this`：

```typescript
class Handler {
  onEvent = () => this.handle();
  handle() {}
}
```

因此 `onEvent` 可直接传给回调系统，但也会为每个 Handler 实例创建闭包。

---

## 6. 属性描述符：属性远不只是 key/value

数据属性具有：

- `value`
- `writable`
- `enumerable`
- `configurable`

访问器属性具有：

- `get`
- `set`
- `enumerable`
- `configurable`

```typescript
Object.defineProperty(target, 'id', {
  value: 'run_1',
  writable: false,
  enumerable: false,
  configurable: false,
});
```

三个标志分别影响：

- writable：能否通过赋值改变数据属性值。
- enumerable：是否出现在 Object.keys、对象展开等枚举操作中。
- configurable：能否删除、重定义描述符类型或改变多数标志。

对象字面量/普通赋值创建的属性默认通常是 writable、enumerable、configurable；`Object.defineProperty` 未写出的布尔标志默认是 false。这是代理、ORM、响应式系统和装饰器底层常用机制。

---

## 7. 不同遍历/复制 API 看到的属性集合不同

| 操作 | 自有 | 原型链 | 不可枚举 | Symbol 键 |
|---|---:|---:|---:|---:|
| `Object.keys` | 是 | 否 | 否 | 否 |
| `Object.getOwnPropertyNames` | 是 | 否 | 是 | 否 |
| `Object.getOwnPropertySymbols` | 是 | 否 | 是 | 是 |
| `Reflect.ownKeys` | 是 | 否 | 是 | 是 |
| `for...in` | 是 | 是 | 否 | 否 |
| `{ ...object }` | 是 | 否 | 否 | 是 |

对象展开还会读取属性值，因此 getter 可能在复制时执行；复制后通常变成普通数据属性，原访问器描述符不会原样保留。需要保留描述符时，可以结合 `Object.getOwnPropertyDescriptors` 与 `Object.defineProperties`。

`JSON.stringify` 又有独立规则：忽略 symbol 键、函数、对象属性中的 undefined，并调用 `toJSON`。不要把它当通用深拷贝。

---

## 8. `readonly`、freeze 和运行时不可变不是一回事

```typescript
const config: Readonly<{ nested: { timeout: number } }> = {
  nested: { timeout: 1000 },
};
```

`Readonly<T>` 默认只把第一层属性标为 readonly，且只限制通过当前静态引用写入。其他别名仍可能修改同一个对象。

`Object.freeze` 在运行时把第一层自有属性设为不可写/不可配置，但也是浅层：

```typescript
const frozen = Object.freeze({ nested: { value: 1 } });
frozen.nested.value = 2; // nested 对象仍可变
```

真正的深不可变需要：

- 递归冻结或不可变数据结构。
- 避免泄漏可变别名。
- 在 API 中返回快照/只读视图。
- 明确复制成本和对象身份语义。

---

## 9. TypeScript `private` 与 `#private`

```typescript
class Store {
  private softSecret = 'soft';
  #hardSecret = 'hard';
}
```

`private`：

- Checker 限制源码访问。
- 在当前 target 下通常 emit 为普通属性。
- 可能被 Reflect、序列化规则、调试器或普通属性操作观察。
- 参与 TS 类兼容性的名义化检查。

`#hardSecret`：

- ECMAScript 运行时私有元素。
- 不是字符串/Symbol 属性键。
- 只能在声明它的 class body 中使用私有语法访问。
- 子类不能直接访问父类私有元素。
- 具有 brand check，错误 receiver 会在运行时失败。

两者都不是日志脱敏方案。对象方法仍可能主动返回秘密，调试环境也可能观察内部状态；安全边界依赖权限、进程隔离和数据生命周期。

---

## 10. 结构类型兼容不产生运行时继承关系

```typescript
interface Runnable { run(): void }
const value = { run() {} };
```

value 可赋值给 Runnable，因为结构满足，但：

- 没有 Runnable 构造器。
- 原型链没有改变。
- 没有自动安装方法。
- 运行时无法询问 “value instanceof Runnable”。

若需要运行时区分：

- 使用判别字段。
- 用 schema/类型守卫验证结构。
- 使用 class 构造器和 `instanceof`，前提是值确实来自相同 realm/构造器。
- 使用品牌 Symbol 作为运行时标记，但仍要控制构造路径。

### `instanceof` 的本质

普通情况下，`value instanceof Constructor` 检查 `Constructor.prototype` 是否出现在 value 原型链上。跨 iframe/VM realm 时，即使对象语义相同，构造器身份不同也可能失败。内建类型边界校验常优先 `Array.isArray` 而不是 `instanceof Array`。

---

## 11. 对象变量保存引用值，展开只是浅复制

```typescript
const original = { nested: { count: 1 } };
const alias = original;
const copy = { ...original };
```

- alias 与 original 是同一个顶层对象。
- copy 是新顶层对象。
- copy.nested 与 original.nested 仍是同一个对象。

比较对象使用身份：

```typescript
{} === {}; // false
copy.nested === original.nested; // true
```

这会影响缓存键、React 状态更新、Map/Set、memoization 和事件去重。TypeScript 的结构类型相等与运行时对象身份是两套完全不同的关系。

`structuredClone` 可复制大量结构化数据并处理循环引用，但函数、WeakMap、某些宿主对象、私有槽等不能按普通对象无损复制。跨线程传输还涉及 transferable 所有权转移。

---

## 12. 闭包：函数对象携带对词法环境的引用

```typescript
function counter() {
  let value = 0;
  return () => ++value;
}
```

返回函数在外层函数结束后仍能访问 value，因为闭包保存词法环境。每次调用 counter 创建独立环境。

闭包是模块、回调、依赖注入、私有状态和函数式组合的基础，也可能造成资源存活时间延长：

- 事件监听器闭包引用大对象。
- 定时器闭包引用请求上下文。
- 缓存函数捕获永不清理的 Map。
- Agent 事件订阅捕获完整 transcript。

垃圾回收只关心是否可达，不知道“业务上已经不用”。移除监听器、清空缓存和取消任务仍是工程责任。

关于 root、retaining path、V8 分代 GC、WeakMap/WeakRef 和 heap snapshot 的完整诊断方法，继续阅读[内存模型、GC 与 Agent 泄漏诊断](24_memory_gc_and_leak_diagnostics.md)。

---

## 13. Proxy 与运行时元编程

Proxy 能拦截属性读取、写入、枚举、构造等内部操作：

```typescript
const proxy = new Proxy(target, {
  get(target, key, receiver) {
    return Reflect.get(target, key, receiver);
  },
});
```

响应式系统、RPC client、Mock 和访问控制可能使用 Proxy。但静态类型不会自动知道 handler 的真实行为：

- Proxy 可以为任意键动态返回值。
- `ownKeys`、`getOwnPropertyDescriptor` 等 trap 必须满足语言不变量。
- 私有元素访问依赖真实 receiver brand，透明代理也可能失败。
- 大量动态 trap 会降低可预测性和调试体验。

`Reflect` 方法通常与 Proxy trap 一一对应，能显式调用默认对象内部操作并正确传递 receiver。

---

## 14. 性能：原型与对象形状的工程直觉

现代 JS 引擎会为相似对象优化属性布局和访问路径，常被非正式称为 hidden class/shape 与 inline cache。具体实现不是 ECMAScript 规范，不能依赖某个引擎细节，但有几个稳健经验：

- 构造相同类型实例时尽量以稳定顺序初始化字段。
- 不要在热路径反复增删大量不同属性。
- prototype 方法适合大量实例共享。
- 不要为了微优化牺牲清晰模型；先用 profiler 测量。
- Proxy 和高度多态调用点可能影响优化，但是否重要必须实测。

TypeScript 类型不会改变运行时对象布局。一个复杂 interface 不产生额外字段；一个映射类型也没有运行时成本，除非对应代码真的创建/复制对象。

---

## 15. Java 与 TypeScript/JavaScript 对照

| Java 直觉 | JavaScript/TypeScript 实际情况 |
|---|---|
| 类定义实例字段布局 | 对象可动态增删属性，class 方法经原型共享 |
| 方法天然绑定实例 | 普通方法 this 取决于调用点 |
| private 是 JVM 访问控制 | TS private 多为编译期；#private 才是 JS 私有元素 |
| interface 可用于反射/名义关系 | TS interface 擦除且结构兼容 |
| 泛型参数受 JVM/反射规则影响 | TS 泛型在 emit 后消失 |
| 对象复制需要显式 clone | 展开创建浅复制，嵌套引用仍共享 |
| try-with-resources 调 AutoCloseable | JS `using` 调 Symbol.dispose 结构协议 |
| 字段通常直接存值 | JS 属性可能是 getter/setter 与特殊描述符 |

---

## 16. 排查运行时/静态模型错位

1. 编译后的 JS 中这个类型还存在吗？
2. 属性是自有的还是来自原型？
3. 它是否可枚举，展开/JSON 是否会包含？
4. 当前函数的 `this` 由哪个调用点提供？
5. 两个变量是否引用同一对象？
6. `readonly` 是静态视图还是对象真的冻结？
7. `private` 是 TS 关键字还是 `#` 私有元素？
8. 外部值是否做了运行时验证？
9. 闭包/监听器是否让对象保持可达？
10. Proxy/装饰器是否改变了普通属性语义？

---

## 一句话总结

TypeScript 负责在编译期描述和约束 JavaScript；JavaScript 运行时仍以属性描述符、原型链、调用点 `this`、对象身份和词法闭包工作。只有同时掌握两层模型，才能解释“类型通过但运行时失败”的根因。
