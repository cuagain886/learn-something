# 16 · 显式资源管理：`using`、所有权与异常语义 ⭐⭐⭐

> 垃圾回收能回收不可达内存，却不知道什么时候归还数据库连接、释放锁、关闭流或结束 trace span。资源生命周期必须由程序显式建模。

这里解决“何时、由谁关闭资源”；若要进一步理解对象为何仍可达、Buffer 为何不完全体现在 V8 heap、怎样沿 retainer 查泄漏，请结合[内存模型、GC 与 Agent 泄漏诊断](24_memory_gc_and_leak_diagnostics.md)。

配套实验：[第 23 课显式资源管理](../code/src/23-explicit-resource-management.ts)。

---

## 1. GC 解决内存可达性，不解决业务资源所有权

以下对象即使最终会被垃圾回收，也可能已经造成事故：

- 未归还连接池的数据库连接。
- 未关闭的文件描述符和 socket。
- 未释放的分布式锁/租约。
- 未取消的定时器和事件监听器。
- 未 flush 的日志/遥测 buffer。
- 未结束的模型 stream 与计费请求。

GC 运行时间不可预测，某些资源还存在远端状态，单靠 finalizer 无法提供确定性。核心问题是：**哪个作用域拥有资源，控制流离开时由谁清理？**

---

## 2. 基于 Symbol 的结构协议

同步协议：

```typescript
interface Disposable {
  [Symbol.dispose](): void;
}
```

异步协议：

```typescript
interface AsyncDisposable {
  [Symbol.asyncDispose](): PromiseLike<void>;
}
```

这不是名义基类。任何对象只要具有对应 symbol 方法，就满足协议：

```typescript
const resource: Disposable = {
  [Symbol.dispose]() {
    console.log('cleanup');
  },
};
```

Symbol 键降低与业务属性碰撞的风险，也让 `using` 能调用统一内部协议。近期 Node 版本原生提供这些 Symbol 和 Stack；较老运行时需要兼容实现，TypeScript 只负责语法转换和类型，不会凭空给宿主添加全局 Symbol。

---

## 3. `using` 的词法作用域语义

```typescript
function work() {
  using connection = openConnection();
  return query(connection);
}
```

离开当前 block 时调用 `connection[Symbol.dispose]()`，包括：

- 正常执行到 block 结尾。
- `return`。
- `throw`。
- `break`/`continue` 离开对应作用域。

可以用 mental model 理解为编译器生成一个资源栈和 `try/finally`，但真实转换还要正确处理多个资源、异步释放和双重异常，不应手写简化版本冒充完全等价实现。

### 变量仍是 const-like 绑定

`using resource = ...` 不能重新赋值。资源对象自身是否可变由其类型决定；using 只绑定清理责任，不等于把对象冻结。

### null/undefined

规范允许 using 初始化为 null/undefined，此时不注册清理。API 若逻辑上必须拿到资源，仍应在返回类型中排除空值或主动失败。

---

## 4. LIFO：释放顺序是获取顺序的逆序

```typescript
using transaction = beginTransaction();
using statement = transaction.prepare(sql);
using cursor = statement.execute();
```

退出时：

```text
cursor → statement → transaction
```

后创建的资源往往依赖先创建的资源；逆序确保子资源先释放。它与栈展开、Java try-with-resources 的逆序关闭直觉一致。

如果资源之间没有依赖，LIFO 仍提供确定、可测试的顺序。不要依赖垃圾回收偶然顺序。

---

## 5. `await using`：Promise 在清理完成后才落定

```typescript
async function work() {
  await using stream = await openStream();
  return consume(stream);
}
```

作用域离开时会查找并等待 `[Symbol.asyncDispose]()`。适合：

- 等待 socket close handshake。
- flush 缓冲区。
- 提交/回滚事务。
- 归还异步连接池。
- 结束需要 export 的 trace span。

重要时序：async 函数的返回 Promise 要等 disposal 完成后才 settle。调用方看到完成时，资源清理也已经完成或清理错误已经参与最终异常。

`await using` 可以管理 AsyncDisposable，也能接受同步 Disposable；统一的异步作用域在组合资源时更方便。

---

## 6. 获取资源与注册清理必须紧邻

危险模式：

```typescript
const resource = acquire();
await somethingThatMayThrow();
registerCleanup(resource);
```

中间失败会泄漏。using declaration 或 Stack `use/adopt` 应尽快接管所有权：

```typescript
using resource = acquire();
await somethingThatMayThrow();
```

对多步构造同样适用：每成功获取一个子资源，立即注册清理；不要等整个初始化完成后才统一登记。

---

## 7. `DisposableStack`：动态组合异构清理

固定数量资源可以直接写多个 using；动态数量或不同协议适合 Stack：

```typescript
using stack = new DisposableStack();

const file = stack.use(openFile());
stack.adopt(lockToken, token => releaseLock(token));
stack.defer(() => removeListener());
```

### `use(resource)`

接管一个 Disposable，并返回原资源方便继续使用。

### `adopt(value, onDispose)`

值本身不实现 Disposable，但调用方知道如何释放，例如租约 token、临时目录路径、订阅 ID。

### `defer(callback)`

注册一个不需要值的清理动作，例如恢复全局状态、移除监听器或记录 scope 结束。

### `move()`

把当前栈中的资源转移给新 Stack，原 Stack 变为 disposed 且不再拥有资源。它可以显式表达所有权转移：

```typescript
function createBundle(): DisposableStack {
  const stack = new DisposableStack();
  // acquire and register...
  return stack.move();
}
```

调用方必须接管返回栈。忽略返回值仍可能泄漏；类型系统没有线性类型，无法保证资源恰好消费一次。

---

## 8. `AsyncDisposableStack`

异步版本对应：

```typescript
await using stack = new AsyncDisposableStack();
stack.use(asyncResource);
stack.adopt(value, async value => { /* cleanup */ });
stack.defer(async () => { /* cleanup */ });
```

释放按 LIFO 串行 await。这通常是正确默认，因为后一个资源可能依赖前一个；如果清理真正独立且需要并行，应该建立专门聚合资源，并明确定义错误聚合语义，而不是悄悄改变通用栈顺序。

---

## 9. 业务错误与清理错误同时发生

```typescript
try {
  using resource = acquire();
  throw new Error('body failed');
} // dispose 又抛出 'cleanup failed'
```

不能简单让后一个错误覆盖前一个。显式资源管理使用 `SuppressedError` 保存两个错误：

- `error`：后续清理阶段发生的错误。
- `suppressed`：此前正在传播、现在被压制但仍保留的错误。

多个清理连续失败时可能形成嵌套 SuppressedError 链。日志系统应递归展开或保留 cause-like 结构，不能只打印顶层 message。

### 清理函数应不抛错吗？

理想清理应幂等、可靠，但真实 close/flush/rollback 会失败。不能一律吞掉：

- 事务 rollback 失败可能意味着状态未知。
- 日志 flush 失败可能丢审计数据。
- 释放锁失败可能影响后续任务。

策略应由资源抽象明确；using 确保错误不会静默抹掉原始失败。

---

## 10. 所有权 API 设计

返回资源的 API 必须说明谁释放：

```typescript
function openOwned(): DisposableResource;
function borrow(resource: Resource): void;
function withResource<T>(fn: (resource: Resource) => T): T;
```

常见语义：

- **owned**：调用者负责 using/dispose。
- **borrowed**：调用者不能释放，只在指定范围使用。
- **shared/ref-counted**：通过引用计数或容器管理。
- **transferred**：move 后原所有者不再使用。

TypeScript 没有 Rust 式借用检查或线性类型。命名、封装、不可暴露 Controller/Stack 写能力和测试共同承担所有权约束。

### 不要让同一资源被两个 owner 接管

两个 Stack 都注册同一非幂等资源会 double-close。资源的 dispose 最好幂等，但这不能替代清晰所有权；某些事务第二次 close 可能掩盖逻辑错误。

---

## 11. 与 `try/finally` 的关系

`try/finally` 仍然重要：

- 资源没有 Symbol 协议且不值得包装。
- 清理依赖复杂条件。
- 需要在清理前后做额外错误策略。
- 目标环境无法支持/转换 using。

using 的优势不是“finally 做不到”，而是：

- 所有权在声明处可见。
- 多资源 LIFO 自动化。
- 双重错误语义标准化。
- 动态资源可由 Stack 组合。
- 重构时不容易忘记新 return/throw 分支。

可以写小适配器把旧 `close()` API 转成 Disposable：

```typescript
function disposable<T>(value: T, close: (value: T) => void): T & Disposable {
  return Object.assign(value as object, {
    [Symbol.dispose]: () => close(value),
  }) as T & Disposable;
}
```

生产中要考虑是否允许修改原对象；`DisposableStack.adopt` 往往更安全。

---

## 12. Agent Runtime 中的典型资源

### 模型响应流

消费者提前结束时需要 cancel reader/HTTP body，否则远端仍生成 token 并计费。

### 工具连接

数据库连接、浏览器 page、SSH session 应在单个 tool invocation 作用域释放，而不是等整个进程结束。

### 分布式租约

Agent worker 获取 run lease 后要在成功、失败、取消所有路径释放或停止续约。

### Trace Span

span 应与 step/tool scope 绑定，结束时记录 status/error。AsyncDisposable 可以等待 exporter buffer。

### 临时文件

模型上传、代码沙箱和文档转换产生的临时目录应由 Stack adopt，并在失败路径清除。

```typescript
async function executeTool() {
  await using stack = new AsyncDisposableStack();
  const span = stack.use(startSpan());
  const lease = stack.adopt(await acquireLease(), releaseLease);
  const connection = stack.use(await pool.connect());
  // ...
}
```

所有依赖应在同一所有权树中，而不是散落多个不相关 finally。

---

## 13. 迭代器与资源清理

`for...of`/`for await...of` 提前 break 时会尝试调用迭代器 `return()`。生成器中的 `finally` 因此可以释放 reader：

```typescript
async function* read(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}
```

using 可以进一步封装 reader/订阅资源，但必须理解底层取消与 releaseLock 不等价：释放锁允许别的 reader 接手；cancel 表示不再需要数据，并向 source 传播取消。

---

## 14. 兼容性与 emit

使用 using 需要两层支持：

1. TypeScript 理解语法和类型，`lib` 包含 Disposable 声明。
2. 运行时提供 Symbol.dispose/Symbol.asyncDispose 与相关全局，或加载兼容实现。

TypeScript 可以向较旧 ECMAScript target 转换 using 语法，但转换后的 helper 仍需要 disposal symbols。`DisposableStack`/`AsyncDisposableStack` 是独立运行时全局，也需要宿主支持或 polyfill。

库作者不能只因为自己 Node 版本可运行就假设消费者环境也支持；应在 `engines`、构建目标和文档中明确。

---

## 15. 测试清单

- 正常 block 结束会释放。
- return/throw/break 都会释放。
- 多资源严格 LIFO。
- 异步清理完成后外层 Promise 才 settle。
- dispose 幂等性符合契约。
- body 和 cleanup 同时失败时两个错误都保留。
- 构造到一半失败时已获取资源会清理。
- move 后只有新 owner 清理。
- parent 取消时资源仍进入 disposal。
- 旧运行时兼容测试实际加载 polyfill，而不只让 tsc 通过。

---

## 一句话总结

显式资源管理把“谁负责清理”从隐含约定提升为词法结构：using 声明所有权，Stack 组合动态清理，LIFO 保持依赖顺序，SuppressedError 保留双重失败。对长链路 Agent 而言，它是取消之外另一半生命周期纪律。
