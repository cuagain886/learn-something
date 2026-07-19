# 12 · 异步运行时、取消传播与结构化并发 ⭐⭐⭐

> Agent 的控制面几乎全是异步 I/O。可靠性问题通常不在 `Promise<T>` 的 T，而在任务何时开始、谁负责取消、失败如何传播、资源何时释放。

配套代码：[第 18 课生产级异步控制](../code/src/18-async-control.ts)。

---

## 1. `async/await` 没有把 JavaScript 变成多线程

JavaScript 代码通常在一个事件循环线程上执行。网络、定时器、文件系统等操作由宿主环境管理，完成后安排回调或 Promise continuation。

```typescript
async function run() {
  const response = await fetch(url);
  return response.json();
}
```

`await` 的关键语义是：

1. 计算右侧值并转成 Promise 语义。
2. 当前 async 函数暂停，把控制权还给调用方。
3. Promise 落定后，把函数后半段安排为后续任务继续执行。
4. 返回值包装为 Promise；抛错转成 rejection。

暂停的是这个函数，不是整个线程。若在 `await` 之前执行 CPU 密集循环，事件循环仍会被阻塞。向量计算、压缩、大 JSON 同步解析等 CPU 工作需要 Worker、子进程或原生实现，而不是多加一个 `async`。

---

## 2. Task 与 Microtask：为什么 Promise 回调“更早”

概念上，宿主从任务队列取一个任务执行；当前调用栈清空后，会排空 microtask 队列，再进入后续任务。Promise reaction、`queueMicrotask` 通常进入 microtask；定时器回调属于后续任务阶段。

```typescript
console.log('A');
setTimeout(() => console.log('B'), 0);
Promise.resolve().then(() => console.log('C'));
console.log('D');
// 常见输出：A D C B
```

不要把这个简化成“Promise 永远比定时器快”。实际顺序还取决于当前阶段、Node 事件循环和 I/O；可靠代码应靠显式依赖关系，而不是利用微妙调度顺序。

### Microtask 饥饿

如果一个 microtask 不断安排新的 microtask，宿主可能迟迟无法处理计时器和 I/O。大量同步 `.then` 链、无界递归 Promise 调度同样会造成响应延迟。

---

## 3. Promise 表示结果，不表示任务所有权

创建 Promise 往往意味着操作已经启动：

```typescript
const request = fetch(url);
```

丢弃 `request` 不会停止网络请求。Promise 没有统一的 `.cancel()`，因为不同资源的取消语义不同：HTTP 可以中断连接，数据库查询可能只能请求取消，某些远端操作已经提交就无法撤回。

因此取消采用协作协议：调用方向下传 `AbortSignal`，每层在合适位置检查或转交给底层 API。

---

### 3.1 resolved 不等于 fulfilled

Promise 有 `pending / fulfilled / rejected` 三种可观察状态，但规范中的 **resolved** 是更宽的内部概念：一个 Promise 可以已经 resolve 到另一个仍 pending 的 Promise/thenable，此时自己的最终结果被锁定，却还没有 fulfilled。

```typescript
let finish!: (value: number) => void;
const inner = new Promise<number>((resolve) => {
    finish = resolve;
});

const outer = Promise.resolve(inner);
// outer 已采纳 inner；inner 仍 pending，所以 outer 也尚未 fulfilled
finish(42);
console.log(await outer); // 42
```

Promise Resolution Procedure 会递归采纳 thenable：读取 `then` 后，通过 Promise Job 调用它，并把首次 resolve/reject 作为有效结果。恶意 thenable 同时调用两者、重复调用或调用后抛错时，CreateResolvingFunctions 的 already-resolved 标记保证只有第一次落定生效。

这解释了两个看似奇怪的事实：

- `resolve(x)` 后 executor 仍继续同步执行，它不是 `return`；
- `async function` 返回另一个 Promise 时，结果会展平，而不会得到可观察的嵌套 `Promise<Promise<T>>`。

### 3.2 executor 与 reaction 位于不同调度层

```typescript
const order: string[] = [];

const promise = new Promise<number>((resolve) => {
    order.push("executor");
    resolve(1);
});

promise.then(() => order.push("then"));
order.push("sync");

// 当前同步 job 结束前：executor, sync
// Promise reaction 运行后：executor, sync, then
```

executor 由构造器同步调用；`then/catch/finally` reaction 即使面对已经 fulfilled 的 Promise，也不会同步插入当前调用栈。这是防止 Zalgo（有时同步、有时异步）的核心保证。

### 3.3 TypeScript 只编码 fulfillment，不编码 rejection

`Promise<T>` 的 `T` 只描述 fulfilled value。JavaScript 允许 `throw "offline"`、`Promise.reject({ code: 503 })` 等任意 reason，因此：

- `catch` 回调和 `PromiseRejectedResult.reason` 在标准库声明里仍有历史性的 `any` 边界；
- 进入业务错误模型时应立刻收口成 `unknown` 并验证；
- 若调用者需要穷尽处理失败种类，应在 fulfilled 通道返回 `Result<T, E>`，而不是假设 Promise 有隐藏的第二个泛型参数。

### 3.4 组合器对照表：结果策略不等于生命周期策略

| 组合器 | 何时落定 | fulfilled 结果顺序 | 会取消未完成输入吗 |
|---|---|---|---|
| `Promise.all` | 首次 reject，或全部 fulfill | 输入顺序 | 不会 |
| `Promise.allSettled` | 全部落定 | 输入顺序 | 不会 |
| `Promise.race` | 第一个输入落定 | 单个胜者 | 不会 |
| `Promise.any` | 首次 fulfill，或全部 reject | 单个胜者 / `AggregateError` | 不会 |

`Promise.all` 的输出按输入位置排列，不按完成先后排列。它 fail-fast 后，其它任务仍可能继续占用连接、扣费并写数据库。`race` 的“超时 Promise”获胜也只会让调用方停止等待；没有 AbortSignal 等协议，底层请求仍然活着。

组合器通常会立即给所有输入安装 reaction，因此组合器已观察到的晚到 rejection 不等同于完全无人处理；但晚到的**副作用和资源消耗**仍然存在。不要用“没有 unhandledRejection”误判为生命周期已经正确收束。

### 3.5 `finally` 是结算观察器，不是值映射器

`finally(callback)` 的普通返回值会被忽略，原 fulfillment/rejection 继续传播；只有 callback 自己抛错或返回 rejected Promise 时，才用新的失败替换原结果。这使它适合无条件清理，但也带来错误遮蔽问题：清理失败可能覆盖真正的业务失败。

需要同时保留两者时，应使用显式资源管理的 `SuppressedError` 语义或自行聚合，而不是假设 Promise 链会保存双重原因。

对应可运行实验：[第 12 课：Promise 解析与组合器边界](../code/src/12-async.ts)。

---

## 4. `AbortController` 是单向广播，不是异常魔法

```typescript
const controller = new AbortController();
await fetch(url, { signal: controller.signal });
controller.abort(new Error('用户停止运行'));
```

- Controller 持有写能力：`abort(reason)`。
- Signal 是只读通知：`aborted`、`reason`、`abort` 事件。
- abort 只触发一次。
- 底层操作必须主动监听 signal；不支持 signal 的函数不会自动停止。

自己监听时应：

1. 注册前检查 `signal.aborted`，避免错过已发生的取消。
2. 使用 `{ once: true }` 或在完成时移除监听器，避免泄漏。
3. 清理定时器、socket、流 reader 等资源。
4. 尽量保留 `signal.reason`，让上层区分超时、用户取消和父任务失败。

Node 提供 `AbortSignal.timeout()` 和 `AbortSignal.any()` 等组合能力，但公共库仍应接受外部 signal，而不是只在内部偷偷创建不可控的 Controller。

---

## 5. `Promise.race` 不是超时取消

```typescript
await Promise.race([
  callModel(),
  delay(5_000).then(() => { throw new Error('timeout'); }),
]);
```

5 秒后调用方得到超时错误，但 `callModel()` 仍可能继续：

- 消耗 token 和费用。
- 占用连接池。
- 写入缓存或数据库。
- 最终 rejection 若无人处理，产生额外错误。

正确的超时抽象应创建/组合 signal，超时时 abort 底层操作，并在 `finally` 清理 timer 与监听器。若底层无法取消，要在接口文档明确“超时仅停止等待，不停止副作用”。

---

## 6. 结构化并发：子任务生命周期属于一个明确作用域

JavaScript 本身允许随手启动“悬空 Promise”：

```typescript
void doWork();
return response;
```

调用者不知道后台任务何时结束、失败去哪里、请求取消时是否停止。结构化并发的工程原则是：

- 父作用域创建子任务。
- 父作用域退出前等待或明确移交所有子任务。
- 父取消向下传播。
- 子任务失败按策略取消兄弟任务或被聚合。
- 资源清理集中在 `finally`/作用域边界。

```typescript
async function agentStep(signal: AbortSignal) {
  const [memory, documents] = await Promise.all([
    loadMemory(signal),
    retrieveDocuments(signal),
  ]);
  return { memory, documents };
}
```

`Promise.all` 只聚合结果，并不会自动 abort 其他失败中的任务。若需要 fail-fast + cancel-siblings，需要共享 Controller 或任务组抽象主动实现。

---

## 7. 并发、并行、批处理和限流不是一回事

- **并发**：多个任务的等待时间重叠。
- **并行**：多个 CPU 执行单元同时计算。
- **批处理**：把多个输入合成一次远端请求。
- **限流**：限制同时在途任务数或单位时间请求量。

```typescript
await Promise.all(items.map(process));
```

对 10 个输入很好，对 10 万个输入会一次创建所有 Promise、占用内存并打爆远端配额。并发池应只维持固定数量 worker，并考虑：

- 保持输入顺序还是完成顺序？
- 一个失败是否立即停止？
- 已开始任务如何取消？
- 重试是否占用并发名额？
- 不同工具是否共享额度？

限流解决“同时多少个”，rate limit 解决“时间窗口多少个”；生产 Agent 往往两者都需要。

---

## 8. 重试必须建立在错误分类与幂等性上

不是所有失败都可重试：

| 失败 | 通常策略 |
|---|---|
| 参数验证失败 | 不重试，修复调用 |
| 认证/权限失败 | 不盲目重试，刷新凭据或人工处理 |
| 429/临时过载 | 尊重 Retry-After，退避后重试 |
| 网络瞬断/部分 5xx | 有上限地重试 |
| 用户取消 | 立即停止 |
| 超时 | 取决于操作是否幂等、远端是否仍执行 |

指数退避常写为：

```text
delay = min(cap, base × 2^(attempt-1)) + jitter
```

jitter 防止大量客户端在同一时间再次请求。还要设置：

- 最大尝试次数。
- 总时间预算，而不只是单次超时。
- 可重试错误谓词。
- 幂等键，避免重复创建订单、发送消息或执行有副作用工具。

重试层不应吞掉最后错误；保留 cause、attempt、elapsed time 和远端 request id 才能诊断。

---

## 9. AsyncIterable 与背压

`AsyncIterable<T>` 表示消费者异步地逐项拉取值：

```typescript
for await (const token of modelStream) {
  await sendToClient(token);
}
```

异步生成器每次 `yield` 后暂停，直到消费者请求下一项。这形成基本背压：消费者慢，生产者不会无界向当前生成器推进。

但背压不会自动贯穿所有层：底层 HTTP socket 可能仍在缓冲，SDK 可能先把事件读入内部队列。需要理解每层 buffer、高水位和取消方式。

### 流的三个终止路径

1. 正常完成：迭代器返回 `done: true`。
2. 失败：`next()` rejection，`for await` 抛错。
3. 消费者提前停止：应触发迭代器 `return()`，生成器 `finally` 中释放资源。

因此打开连接、文件或 reader 的异步生成器必须用 `try/finally` 清理。

---

## 10. Agent 运行的时间预算应分层

一次 Agent Run 常有：

```text
Run 总预算
  ├─ 第 1 次模型调用
  ├─ 并行工具组
  │    ├─ 搜索工具单次预算
  │    └─ 数据库工具单次预算
  ├─ 第 2 次模型调用
  └─ 输出流发送预算
```

若每步各自拥有 30 秒超时，但总流程只有 60 秒，后续步骤必须继承**剩余 deadline**，而不是每次重新获得完整 30 秒。比单独传 `timeoutMs` 更强的模型是绝对 deadline + signal：

```typescript
type RunContext = {
  readonly signal: AbortSignal;
  readonly deadline: number; // 单调时钟语义更理想
};
```

子步骤取 `min(自身上限, 父级剩余预算)`。取消原因应包含 run id/step/tool 等上下文，但不要泄漏 prompt 或敏感参数。

---

## 11. 错误类型：业务失败、基础设施失败与取消

不要把所有 rejection 都变成 `Error('failed')`。上层策略需要区分：

```typescript
type StepFailure =
  | { kind: 'invalid_tool_arguments'; issues: readonly Issue[] }
  | { kind: 'tool_timeout'; tool: string; timeoutMs: number }
  | { kind: 'rate_limited'; retryAfterMs?: number }
  | { kind: 'cancelled'; reason: unknown }
  | { kind: 'unexpected'; cause: unknown };
```

预期失败适合可辨识联合；底层未知异常放在 `cause: unknown`，不要断言成特定 SDK 错误。跨进程传输时 Error 的原型和不可枚举字段不会自动保留，应显式序列化安全字段。

---

## 12. 常见异步反模式

### `forEach(async () => ...)`

`forEach` 不等待回调 Promise，错误也不会由外层捕获。串行用 `for...of + await`；并发用显式 `Promise.all` 或并发池。

### `new Promise(async (resolve) => ...)`

Promise executor 期望同步执行；async executor 的 rejection 容易形成第二条未观察 Promise。能直接写 async 函数就不要手动包 Promise。

### 无条件重试

会把参数错误、权限错误和非幂等副作用放大成事故。

### 吞掉 rejection

`.catch(() => undefined)` 会让上层误以为成功。若降级是契约，应返回显式 `Result` 或记录带上下文的诊断。

### 只设置超时，不传取消

调用方停止等待，底层仍消耗资源。至少把 signal 传到 fetch/SDK/工具层。

---

## 13. 测试异步控制的正确方式

- 用假时钟验证退避和超时，避免测试真实等待。
- 注入可控 operation：第 N 次成功、永远 pending、收到 abort 后记录。
- 验证 timer/监听器在成功、失败、取消三条路径都清理。
- 验证并发峰值，而不只验证最终数组。
- 验证结果顺序契约。
- 验证父取消能到达嵌套工具调用。
- 对重试副作用使用幂等键并验证只产生一次业务结果。

---

## 14. 并发池只有“等待所有 worker 收束”才算结构化

一个常见实现把 N 个 worker 直接交给 `Promise.all`。首个 worker reject 后，`Promise.all` 立即 reject；其它 worker 仍可能继续取任务、写结果和持有连接。仅限制 active count 并没有建立失败生命周期。

结构化并发池需要：

1. 为本次 map 创建子 AbortController，并转发 parent signal；
2. 首个 mapper 失败时原子记录 first failure，并 abort sibling；
3. 每个 worker 在循环和底层 I/O 中检查同一个子 signal；
4. worker 内部捕获失败并停止取新任务；
5. group 等待所有 worker 的 finally 完成后，再向调用方抛出 first failure；
6. 成功时验证每个输入索引都写入结果，避免稀疏数组伪装成完整输出。

注意 abort 是协作协议。若 mapper 无视 signal 并永不结束，group 无法同时做到“立即返回”和“保证没有后台任务”；JavaScript 没有通用的 Promise 强杀操作。CPU 任务需要 Worker/Atomics 等另一层机制。

### 用握手测试，不用时间猜测

并发上限测试可以为每个 mapper 提供 Deferred gate：先断言只启动前 N 项，再按 `1 → 2 → 0 → 3` 人工 resolve，最后证明 completion order 与 result order 不同但结果仍按输入索引排列。失败测试让一个 sibling 等待可取消操作、另一个主动 throw，随后断言返回前 active 已归零。

这种测试既快又确定，失败时能指出具体协议破坏；`await sleep(50)` 只能证明机器这一次大概按预期调度。

可运行证明见 [第 18 课：结构化异步控制](../code/src/18-async-control.ts)。Node 的 `AbortSignal.any/timeout/throwIfAborted` 语义见 [Node 全局 API](https://nodejs.org/api/globals.html#class-abortsignal)。

---

## 一句话总结

生产级异步的核心不是 Promise 语法，而是任务所有权：每个子任务都应有父作用域、取消信号、时间预算、错误策略和清理路径。Agent 越能并行调用工具，这套结构越不能省略。
