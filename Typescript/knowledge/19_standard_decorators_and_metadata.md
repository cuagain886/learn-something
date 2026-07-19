# 19 · 标准装饰器与元数据：从类定义时求值到实例初始化 ⭐⭐⭐

TypeScript 5.0 起支持的标准装饰器，不是“更漂亮的注解”，而是一套在 **JavaScript 运行时**改写类定义的协议。理解它的关键不在 `@decorator` 语法，而在以下三个问题：

1. 装饰器何时求值、何时应用？
2. 它拿到的 `value` 和 `context` 分别是什么？
3. 返回值和 `addInitializer` 会改变哪一个初始化阶段？

配套实验：[`../code/src/26-standard-decorators-internals.ts`](../code/src/26-standard-decorators-internals.ts)。实验刻意同时覆盖方法、字段、自动访问器、实例初始化器、绑定和元数据。

---

## 1. 先区分两套完全不同的装饰器模型

很多旧项目仍在使用 `experimentalDecorators`。它实现的是较早的 Stage 2 提案，不能把旧教程中的签名直接搬到标准装饰器中。

| 维度 | 标准装饰器 | 旧版实验性装饰器 |
|---|---|---|
| 启用方式 | TypeScript 5+ 默认语法，无需 `experimentalDecorators` | 必须开启 `experimentalDecorators` |
| 方法签名 | `(value, context) => replacement | void` | `(target, propertyKey, descriptor)` |
| 参数装饰器 | 不支持 | 支持 |
| `emitDecoratorMetadata` | 不兼容，不自动生成设计类型元数据 | 可配合使用 |
| 字段语义 | 得到 `undefined`，可返回字段初始化函数 | 通常接收原型或构造器与属性名 |
| 初始化钩子 | `context.addInitializer(...)` | 没有同等的统一协议 |
| 标准化状态 | ECMAScript 装饰器语义 | 历史 TypeScript 扩展 |

因此，看到 `(target, key, descriptor)` 就应先判断：这是旧版教程还是旧代码，而不是标准装饰器的底层签名。

### 配置上的实际结论

本项目没有开启 `experimentalDecorators`，并在 `lib` 中加入了 `ESNext.Decorators`。这使编译器使用标准装饰器的上下文类型，例如：

```ts
ClassMethodDecoratorContext<This, Value>
ClassFieldDecoratorContext<This, Value>
ClassAccessorDecoratorContext<This, Value>
```

`ESNext.Decorators` 只提供类型声明，不会替运行环境实现 `Symbol.metadata`。如果 Node 或浏览器还没有该符号，需要显式 polyfill；配套实验已经演示这一点。

---

## 2. 装饰器不是调用方法时才运行

考虑：

```ts
class Service {
  @trace("query")
  query() {}
}
```

这里至少存在三个不同时间点：

1. **模块求值时**：JavaScript 执行类定义；`trace("query")` 这个工厂函数此时就运行。
2. **类定义完成过程中**：装饰器函数接收原方法和上下文，并决定是否返回替代方法。
3. **以后调用 `query` 时**：如果方法被包装，执行的是包装后的函数。

所以装饰器工厂不能偷偷依赖“当前请求”“当前用户”之类的请求态数据。工厂执行时通常还没有任何请求，甚至一个实例都没有。

### 一个容易遗漏的副作用

模块只要被导入，类定义就可能触发装饰器工厂、元数据写入和注册逻辑。装饰器因此会影响：

- 模块是否仍然是无副作用模块；
- tree shaking 是否安全；
- 测试之间是否共享全局注册表；
- 热重载时是否重复注册；
- 循环依赖是否因定义顺序而暴露。

用于 Agent 工具发现时，优先把装饰器限制为“记录声明信息”，把真正注册、鉴权和资源创建放到显式的 bootstrap 阶段。

---

## 3. 求值顺序和应用顺序为什么相反

```ts
class Example {
  @outer()
  @inner()
  run() {}
}
```

发生顺序是：

```text
求值 outer 工厂
求值 inner 工厂
应用 inner 装饰器
应用 outer 装饰器
```

最终得到的效果近似函数组合：

```ts
const decorated = outerDecorator(innerDecorator(original));
```

运行方法时，如果两个装饰器都返回包装函数，典型调用顺序是：

```text
enter outer
enter inner
method body
exit inner
exit outer
```

这不是语法细节，而是契约设计问题。例如：

- `@authorize` 在 `@cache` 外层：即使命中缓存，也先鉴权；
- `@cache` 在 `@authorize` 外层：若缓存键没有包含主体身份，可能绕过鉴权；
- `@retry` 在 `@transaction` 外层：每次重试可建立新事务；
- `@transaction` 在 `@retry` 外层：多个尝试可能共享一个已经失败的事务。

因此装饰器顺序必须进入测试和代码评审，不能只靠“读起来顺眼”。

---

## 4. `value` 是被装饰的运行时值

对于方法装饰器，`value` 就是原函数。装饰器可以：

- 返回 `undefined`，保留原函数；
- 返回兼容的替代函数；
- 在替代函数中调用原函数。

```ts
function timed<This, Args extends unknown[], Result>(
  original: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, typeof original>,
) {
  return function (this: This, ...args: Args): Result {
    const startedAt = performance.now();
    try {
      return original.call(this, ...args);
    } finally {
      console.log(String(context.name), performance.now() - startedAt);
    }
  };
}
```

这里的泛型不是装饰：它保留了 `this`、参数元组和返回值之间的关系。如果偷懒写成 `Function`、`any[]` 和 `any`，装饰器会把原本准确的方法类型变成不受约束的洞。

### `async` 包装器的一个细节

若包装器写成 `async function`，即使原函数同步返回，替代函数也会总是返回 `Promise`。因此通用日志装饰器不能无条件加 `async`。要保留同步/异步契约，可直接返回原结果；只有需要等待异步完成时间时，才应限制装饰器只接受返回 `PromiseLike` 的方法。

### 不要用箭头函数替代需要动态 `this` 的方法

装饰器返回的包装方法一般使用普通 `function`，再通过 `original.call(this, ...)` 转发。箭头函数捕获的是装饰器执行时的词法 `this`，不是未来实例。

---

## 5. `context` 描述的是“定义位置”，不是反射对象

成员上下文常见字段：

| 字段 | 含义 |
|---|---|
| `kind` | `class`、`method`、`getter`、`setter`、`field` 或 `accessor` |
| `name` | 字符串、symbol，某些场景也可能是私有名描述 |
| `static` | 是否为静态成员 |
| `private` | 是否为 `#private` 成员 |
| `access` | 受控的 `has/get/set` 访问能力，具体成员类型决定可用项 |
| `addInitializer` | 注册额外初始化逻辑 |
| `metadata` | 当前类的装饰器元数据对象 |

`context` 不是 Java 的 `Method` 或 `Field` 对象。它不保证能枚举参数类型、返回类型、泛型实参，也不会自动提供运行时类型描述。

### `context.name` 不一定是字符串

成员可以使用 symbol 键，所以日志和错误中应写：

```ts
String(context.name)
```

如果协议要求 JSON 可序列化工具名，就应在装饰器里拒绝非字符串名称，而不是事后强制断言。

### 私有成员需要显式决策

某些装饰器依赖在外部访问成员，遇到 `context.private === true` 时通常应抛出定义期错误：

```ts
if (context.private) {
  throw new Error("@tool 不能用于私有成员");
}
```

这比记录一份以后永远无法调用的工具元数据更早暴露问题。

---

## 6. `addInitializer` 插入的是哪个阶段

`context.addInitializer(fn)` 不会立即调用 `fn`。它把函数放进对应的初始化队列。

对实例成员装饰器，初始化器会在构造实例期间、以实例为 `this` 运行；对静态成员和类装饰器，时间点不同，发生在类定义初始化阶段。

典型用途是把方法绑定到当前实例：

```ts
function bound<This, Args extends unknown[], Result>(
  _method: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This>,
) {
  if (context.private) throw new Error("不支持私有方法");

  context.addInitializer(function (this: This) {
    const method = context.access.get(this);
    Object.defineProperty(this, context.name, {
      configurable: true,
      writable: true,
      value: method.bind(this),
    });
  });
}
```

这样：

```ts
const detached = instance.method;
detached(); // this 仍指向 instance
```

### 绑定不是免费的

原型方法通常由所有实例共享一个函数。绑定以后，每个实例都会得到一个新的函数对象和一个自有属性。对于海量短生命周期对象，这会增加分配和 GC 压力。

所以 `@bound` 适用于确实要把方法作为回调传递的边界，不应成为所有方法的默认装饰器。

### 初始化顺序会影响可观察状态

初始化器和字段初始化之间存在规定好的先后关系。不要凭 Java 构造器经验猜测。若初始化器读取另一个字段，必须用实验或编译后代码确认目标 TypeScript 版本和 `target` 下的顺序，并为该依赖写测试。

---

## 7. 字段装饰器为什么拿不到字段值

类的字段不是类定义时已经存在的共享值，而是在每个实例初始化时才计算。因此标准字段装饰器收到的第一个参数是 `undefined`，它可以返回一个**字段初始化函数**：

```ts
function normalized(
  _unused: undefined,
  _context: ClassFieldDecoratorContext<object, string>,
) {
  return function (_initialValue: string): string {
    return _initialValue.trim().toLowerCase();
  };
}

class User {
  @normalized
  email = "  A@EXAMPLE.COM  ";
}
```

每构造一个 `User`，初始化函数都会收到这一次实例的初始值。它不是在类定义时读取 `email`。

### 字段装饰器不等于 setter

初始化函数只处理初始化。如果以后执行 `user.email = "  B@X.COM  "`，普通字段不会再次经过它。若要求每次赋值都归一化，应使用 accessor、显式 setter，或领域值对象。

---

## 8. 自动访问器允许同时改写 `get`、`set` 和 `init`

```ts
class Gauge {
  @clamp(0, 100)
  accessor progress = 0;
}
```

访问器装饰器接收 `{ get, set }`，可以返回：

```ts
{
  get?(): Value;
  set?(value: Value): void;
  init?(initialValue: Value): Value;
}
```

这使它能同时约束初始值和后续赋值。一个截断装饰器可以在 `init` 和 `set` 两个入口都调用同一套 `clamp` 逻辑。

但必须明确语义：静默截断、抛错、记录告警是三种不同领域契约。不要为了展示装饰器而隐藏业务错误。

---

## 9. 类装饰器替换构造器的风险

类装饰器可以返回一个新类，但“返回子类”不是无害操作：

- 构造器签名可能被泛化或丢失；
- 静态成员的类型关系可能难以保留；
- `instanceof`、类名、堆栈和序列化行为可能变化；
- 私有字段具有品牌检查，粗暴代理或复制对象会失败；
- 依赖类身份作为 Map 键的框架会观察到不同对象。

如果目的只是登记元数据，通常不需要替换类。返回 `void` 并写入 `context.metadata` 更容易保持语义。

若确实替换，至少保持构造参数：

```ts
type Constructor<Args extends unknown[] = unknown[], Instance = object> =
  new (...args: Args) => Instance;
```

还要针对静态成员、私有字段、继承和 `instanceof` 写运行时测试。

---

## 10. `context.metadata` 是共享容器，不是自动类型反射

标准装饰器元数据通过 `context.metadata` 写入，类定义完成后可从：

```ts
SomeClass[Symbol.metadata]
```

读取。运行环境若未定义 `Symbol.metadata`，TypeScript 的类型库和编译输出不会自动替你创建它。本项目的实验在类定义前安装：

```ts
if (!("metadata" in Symbol)) {
  Object.defineProperty(Symbol, "metadata", {
    configurable: true,
    value: Symbol("Symbol.metadata"),
  });
}
```

### 用 symbol 作为元数据键

多个库都可能写同一元数据对象。字符串键容易冲突：

```ts
const TOOL_METADATA = Symbol("agent.tool.metadata");
```

然后把自己的记录放在 `context.metadata[TOOL_METADATA]` 下。

### 元数据对象内仍然是动态数据

类型断言不会验证元数据。读取后仍应检查：

- 是否是数组或预期对象；
- 每项是否有合法名称和描述；
- 是否重复；
- 方法是否真的存在且可调用；
- schema 是否可序列化并符合模型供应商限制。

元数据适合做“发现索引”，不应被当作可信输入。

### 继承需要专门测试

基类和子类的元数据存在原型关系语义。若直接取出基类数组后 `push`，可能让子类修改到继承来的同一数组。稳妥做法是在首次写入当前类时复制：

```ts
const inherited = metadata[TOOL_METADATA];
const ownEntries = Array.isArray(inherited) ? [...inherited] : [];
ownEntries.push(entry);
metadata[TOOL_METADATA] = ownEntries;
```

还要明确“子类覆盖同名方法”是替换工具、报重复错误，还是保留两项。

---

## 11. 为什么它不像 Java Annotation

Java 开发者最容易产生的误判是：`@tool` 看起来像 Java 注解，所以框架应该能反射完整方法签名。

两者本质不同：

| Java 注解/反射 | JavaScript 标准装饰器 |
|---|---|
| 注解信息进入 class 文件，可由反射读取 | 装饰器是类定义求值时执行的函数 |
| 运行时有 `Class`、`Method`、参数类型等名义类型信息 | TypeScript 类型通常在 emit 后被擦除 |
| 注解自身通常不直接替换方法实现 | 装饰器可以返回替代方法或初始化器 |
| 框架可扫描 classpath | JS 模块必须先被加载，类定义才存在 |
| 泛型虽擦除但保留一定签名结构 | TS 的联合、条件、映射类型没有通用运行时表示 |

标准装饰器不会自动把下面的静态类型变成 JSON Schema：

```ts
type SearchInput = {
  query: string;
  limit?: number;
};
```

Agent 工具仍需要显式运行时 schema，或者使用可靠的构建期代码生成。仅靠 `context.metadata` 无法从已擦除的类型中恢复约束。

---

## 12. Agent 工具装饰器应怎样分层

推荐把职责拆成四层：

```text
装饰器声明层
  只记录：工具名、描述、方法键、策略标识
          ↓
启动期注册层
  枚举元数据，检查重复、方法存在性、schema 与策略
          ↓
运行时边界层
  unknown 输入 → schema 校验 → 授权/限流/超时
          ↓
方法实现层
  接收已经验证的领域输入，返回显式结果
```

装饰器不应偷偷完成：

- 网络连接和数据库连接；
- 当前用户授权；
- 将未经验证的 LLM 参数断言成业务类型；
- 把异常统一吞掉；
- 注册到不可重置的全局可变单例。

### 为什么 schema 最好显式传入

```ts
@tool({
  name: "search",
  input: searchInputSchema,
  permission: "documents:read",
})
search(input: SearchInput) {}
```

这里 schema 是运行时真相，`SearchInput` 可以从 schema 推导。这样避免维护“装饰器字符串描述一份、TS 类型一份、验证逻辑再一份”的三份漂移定义。

---

## 13. 装饰器的性能成本在哪里

装饰器的成本分为两类：

### 定义期成本

- 装饰器工厂求值；
- 元数据对象写入；
- 包装函数创建；
- 静态初始化器执行。

它影响模块冷启动，尤其是 serverless 或加载大量工具模块时。

### 实例与调用期成本

- `addInitializer` 每实例执行；
- `bind` 每实例分配函数；
- 包装器每调用增加函数层、计时、日志或 try/finally；
- 多个装饰器会叠加包装层。

不要先凭感觉微优化，但应把关键路径放进 benchmark，并避免装饰器做隐式 I/O。

---

## 14. 测试装饰器要验证“协议”，不能只测结果

至少覆盖：

1. 工厂求值顺序和装饰器应用顺序；
2. 替代方法是否保留参数、返回值、`this` 和异常；
3. 同步方法有没有被意外 Promise 化；
4. 初始化器每个实例执行几次、何时执行；
5. 字段初始值和后续赋值是否走同一路径；
6. 继承、覆盖、静态成员、symbol 成员和私有成员；
7. 元数据重复、污染和跨测试清理；
8. Node/browser 是否提供 `Symbol.metadata`；
9. 编译目标变化后的 emit 是否仍符合假设。

配套实验使用断言锁定了顺序、绑定行为、字段/访问器变换和元数据内容。阅读输出只是观察，断言才是可回归的契约。

---

## 15. 从旧版装饰器迁移时的检查表

不能只删除 `experimentalDecorators`。逐项检查：

- 是否还使用 `(target, key, descriptor)` 签名；
- 是否使用参数装饰器；
- 是否依赖 `emitDecoratorMetadata` 和 `Reflect.getMetadata`；
- 字段装饰器是否假定能读到实例初值；
- 方法装饰器是否直接改 `descriptor.value`；
- 是否把元数据挂在构造器或原型的字符串键上；
- 依赖注入框架是否明确支持标准装饰器；
- Babel、SWC、tsc 和运行测试是否采用同一套语义；
- 发布库的最低 TypeScript 版本是否支持你导出的上下文类型。

迁移通常需要改框架集成，不只是改函数签名。

---

## 16. 建议动手修改实验

完成以下练习，比再看一遍语法更有效：

1. 给 `timed` 增加仅支持异步方法的 `timedAsync`，要求计时包含 Promise settle 时间且不改变 reject 原因。
2. 给 `@tool` 加重复名称检查，观察是在定义期、启动期还是第一次调用时报错更合理。
3. 建立基类和子类工具，验证元数据继承；故意不复制数组，复现共享污染。
4. 交换两个方法装饰器顺序，用断言证明授权与缓存组合的语义变化。
5. 给 `@bound` 建 10 万个实例，比较原型共享方法和实例绑定方法的内存/构造耗时。
6. 删除 `Symbol.metadata` polyfill，观察当前 Node 版本的行为；再说明为什么类型检查通过不代表运行时存在。

---

## 17. 最终心智模型

标准装饰器可以概括为：

```text
类定义期间：
  求值装饰器表达式
  → 由内向外应用装饰器
  → 记录替代值、字段 init、额外 initializer、metadata
  → 完成类定义

实例创建期间：
  按规范顺序运行实例 initializer 与字段初始化

成员调用期间：
  调用最终替代后的方法/getter/setter
```

它是一套运行时元编程协议，而 TypeScript 泛型只是用来约束这套协议。两者配合得好，可以得到可组合、可测试的横切逻辑；把它误当成 Java 注解和自动反射，则很容易制造隐式副作用、类型擦除误判和脆弱的框架魔法。

## 延伸阅读

- [TypeScript 5.0：标准装饰器](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-0.html#decorators)
- [TypeScript 5.2：装饰器元数据](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-2.html)
- [TypeScript Handbook：旧版实验性装饰器](https://www.typescriptlang.org/docs/handbook/decorators)
