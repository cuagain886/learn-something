# 21 · Node.js 事件循环、任务队列与协作式调度 ⭐⭐⭐

`async/await` 让异步代码看起来像顺序代码，却也隐藏了最重要的运行时事实：**普通 JavaScript 回调仍在一条事件循环线程上执行**。Promise 不会自动创建线程，`AbortSignal` 也不会强行中断正在运行的同步函数。

对 Agent 服务来说，这不是理论细节。模型流式响应、工具并发、超时、心跳、取消和日志上报都共享事件循环；一次大 JSON 转换或无界微任务链，就可能让所有请求同时增加延迟。

配套实验：[`../code/src/28-event-loop-scheduling.ts`](../code/src/28-event-loop-scheduling.ts)。

---

## 1. 不要把 Node.js 简化成“单线程”

更准确的分层是：

```text
┌──────────────────────────────────────────────────────┐
│ V8 JavaScript                                       │
│ 调用栈、对象堆、Promise jobs、GC                    │
└──────────────────────┬───────────────────────────────┘
                       │ Node 绑定
┌──────────────────────▼───────────────────────────────┐
│ Node.js                                              │
│ process.nextTick、EventEmitter、streams、timers API │
└──────────────────────┬───────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────┐
│ libuv                                                │
│ 事件循环、操作系统 I/O 通知、固定大小 Worker Pool   │
└──────────────────────┬───────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────┐
│ 操作系统                                             │
│ sockets、files、timers、processes                    │
└──────────────────────────────────────────────────────┘
```

几个看似矛盾的说法可以同时为真：

- JavaScript 回调通常在一个事件循环线程上执行；
- Node 进程内部不只有一条线程；
- 网络 I/O 通常依赖操作系统异步通知，不一定占用 libuv Worker Pool；
- 文件系统、部分 DNS、crypto、zlib 等操作可能使用 Worker Pool；
- `worker_threads` 可以显式创建运行 JavaScript 的其他线程；
- V8 自身也可能使用后台线程做 GC、编译等内部工作。

“单线程”只适合提醒你不要阻塞 JavaScript 回调，不能作为完整架构模型。

---

## 2. 一次事件循环迭代有哪些阶段

Node 官方文档把事件循环阶段概括为：

```text
timers
  ↓
pending callbacks
  ↓
idle, prepare       （内部使用）
  ↓
poll
  ↓
check               （setImmediate）
  ↓
close callbacks
  ↺
```

### timers

执行已经达到阈值的 `setTimeout` / `setInterval` 回调。`setTimeout(fn, 100)` 表示**至少**等待约 100ms 后才有资格执行，不是 100ms 时刻精确抢占 CPU。

如果事件循环正在执行一个 500ms 的同步函数，100ms timer 只能等它结束。

### pending callbacks

执行某些系统操作延迟到下一轮的回调，例如部分 TCP 错误。

### poll

取得新的 I/O 事件并执行相应回调。poll 是否等待、等待多久，会受 timer、immediate 和已有 I/O 影响。

### check

执行 `setImmediate` 回调。它名字里的 immediate 不是“同步立即执行”，而是进入 check 阶段后执行。

### close callbacks

执行某些资源的 close 事件，例如 socket 被突然关闭。

这些阶段是理解工具，不应被用来预测所有跨平台纳秒级顺序。Node/libuv 的实现会演进；业务协议应依赖明确的同步点，而不是偶然阶段顺序。

---

## 3. 回调、`nextTick` 与 Promise 微任务不是同一个队列

一个回调执行完后，Node 还会处理高优先级队列，才进入后续事件循环阶段。

配套实验在一个 `setImmediate` 回调中注册：

```ts
process.nextTick(() => trace.push("nextTick"));
queueMicrotask(() => trace.push("queueMicrotask"));
Promise.resolve().then(() => trace.push("promise.then"));
```

观察到的局部顺序：

```text
当前回调同步代码结束
→ nextTick queue
→ V8 microtask queue（queueMicrotask / Promise reaction）
→ 以后阶段的 timer / immediate
```

### 为什么强调“局部顺序”

顶层 CommonJS、顶层 ESM、I/O 回调内部和 timer 回调内部，当前代码本身可能处于不同调度上下文。尤其 ESM 求值涉及 Promise job，直接复制一段顶层排序示例可能得到和旧 CommonJS 教程不同的现象。

稳健测试应把要比较的注册操作放在一个明确回调内，并只断言平台保证的关系。

### 微任务检查点

Promise continuation 并不是只在完整事件循环迭代末尾执行。Node 会在合适的回调边界清空相关队列，所以一个回调创建的 Promise job 通常会在进入下一个阶段回调前运行。

这解释了为什么大量 `Promise.resolve().then(...)` 递归也能饿死 I/O：每次清空队列时又加入新的微任务，事件循环就很难回到 poll。

---

## 4. `process.nextTick` 为什么危险

`nextTick` 最初用于在当前操作完成后、事件循环继续前执行逻辑，例如把构造期错误改为异步通知。它的优先级比常规事件循环阶段高。

```ts
function pump(): void {
  process.nextTick(pump);
}
pump();
```

如果没有终止条件，timer 和 I/O 可能一直没有机会运行。配套实验用 5000 次有限递归证明 timer 只能在 nextTick 链清空后执行。

一般业务调度优先考虑：

- `queueMicrotask`：需要在当前任务后尽快执行少量逻辑；
- `setImmediate` / `scheduler.yield()`：需要把机会交还事件循环；
- 明确队列和消费者：需要背压、并发限制或可观测状态；
- Worker Thread：真正 CPU 密集计算。

不要把 `nextTick` 当成“更快的 setTimeout”。

---

## 5. `await` 会把函数切成多个 continuation

```ts
async function load(): Promise<void> {
  console.log("A");
  await Promise.resolve();
  console.log("B");
}

console.log("1");
const pending = load();
console.log("2");
await pending;
console.log("3");
```

顺序是：

```text
1
A
2
B
3
```

`load()` 会同步执行到第一个 `await`。`await` 后面的部分成为 Promise continuation，在以后微任务中继续。

即使 await 的 Promise 已经 fulfilled，也不会在同一个同步调用栈中直接运行后半段。这建立了一个异步边界：

- 当前 `try/finally` 仍能跨 await 工作；
- 其他微任务可能在中间运行；
- 共享可变状态可能在中间改变；
- AsyncLocalStorage 通常能沿因果链传播上下文；
- 当前函数返回的是 pending Promise。

### `await` 不是释放锁的 Java 等价物

JavaScript 没有自动保护 await 前后的共享对象。下面存在逻辑竞态：

```ts
const current = account.balance;
await verify();
account.balance = current - amount;
```

另一个请求可能在 `verify` 期间修改余额。单线程只防止同一个同步片段被打断，不保证多个异步片段组成事务。

应使用数据库事务、串行队列、版本号/CAS 或显式锁协议。

---

## 6. Promise 并发不等于 CPU 并行

```ts
await Promise.all([
  fetchModelA(),
  fetchModelB(),
]);
```

两个网络请求可以同时等待 I/O，因此总耗时接近较慢者。这是**并发**。

```ts
await Promise.all([
  Promise.resolve().then(() => hugeSynchronousParse(a)),
  Promise.resolve().then(() => hugeSynchronousParse(b)),
]);
```

两个 parse 回调仍会依次占用事件循环线程，不会自动使用两个 CPU 核心。Promise 只安排回调，没有提供并行执行环境。

真正的 CPU 并行需要：

- `worker_threads`；
- 子进程；
- 外部服务；
- 原生库内部并行。

把同步 CPU 工作包进 `async` 函数不会使它异步。

---

## 7. 阻塞事件循环为什么会放大尾延迟

设一个同步工具后处理占用事件循环 80ms。在这 80ms 中：

- 所有 SSE token 无法被 JavaScript 消费和转发；
- 超时 timer 不能触发；
- 取消回调不能运行；
- 健康检查无法响应；
- 其他用户的 Promise continuation 也在等待。

如果服务同时处理 100 个 Agent run，这不是“当前请求慢 80ms”，而是所有 run 的调度机会都推迟。

常见阻塞来源：

- 大数组排序或去重；
- 巨型 JSON 的同步 parse/stringify；
- 易发生灾难回溯的正则；
- 同步文件系统和 child process API；
- 大型模板渲染；
- 纯 JS tokenization / embedding 后处理；
- 一次性消费不受限的数据流。

Node 官方的原则是：每个客户端相关回调都应完成有限、较小的工作。

---

## 8. 协作式分块与 `scheduler.yield()`

不能立即迁移到 Worker 时，可以把大任务拆成有限 chunk：

```ts
while (hasMoreWork()) {
  processOneChunk();
  await scheduler.yield();
}
```

`yield` 允许 timer 和 I/O 回调获得运行机会，从而改善响应性。但它有明确局限：

- 总 CPU 工作量没有减少；
- 每个 chunk 仍会阻塞事件循环；
- 频繁 yield 会增加调度开销；
- 算法状态必须能安全跨 await 保存；
- 这不是多核并行。

chunk 大小是吞吐与响应性的权衡，应通过 event-loop delay 和请求延迟测量，不要拍脑袋。

### 什么时候应直接用 Worker

如果单个不可分割计算已经超出延迟预算，或者持续 CPU 占用很高，yield 只能缓解不能解决。Worker Thread 更合适，但需考虑：

- structured clone / transferable 的数据传输成本；
- Worker 创建成本，通常应建池；
- 取消协议；
- 错误序列化；
- AsyncLocalStorage 不会自动跨线程传播；
- 线程安全与共享内存。

完整的 isolate、structured clone、ArrayBuffer transfer、SharedArrayBuffer/Atomics 取消和类型化消息协议见[Worker Threads 与类型化并发协议](25_worker_threads_and_typed_protocols.md)。

---

## 9. `AbortSignal` 是协作，不是抢占

```ts
setTimeout(() => controller.abort(), 0);
hugeSynchronousLoop();
```

timer 回调必须等同步循环结束，才能把 signal 标记为 aborted。因此同步循环中不断读取 `signal.aborted` 也不会看到变化，因为触发 abort 的回调根本还没运行。

可取消操作需要同时满足：

1. 控制权周期性返回事件循环；
2. 各层接收并传播同一 signal；
3. I/O API 真正使用 signal 取消底层工作；
4. chunk 边界调用 `signal.throwIfAborted()`；
5. finally 清理已获得资源。

“Promise 已经因超时 reject”不等于后台 fetch、stream 或工具已经停止。详见 [12 · 结构化并发](12_async_runtime_and_structured_concurrency.md)。

---

## 10. timer 是阈值，不是调度保证

```ts
setTimeout(task, 0);
```

它表示达到最小阈值后，把回调交给 timers 阶段处理。实际执行时间还受：

- 当前回调何时结束；
- 微任务和 nextTick 是否持续产生；
- poll 阶段是否繁忙；
- 操作系统 timer 精度；
- 进程和机器负载；
- Node/libuv 版本行为。

所以：

- 不要用 timer 精确测量持续时间，使用单调时钟如 `performance.now()`；
- 不要用 `setTimeout(10)` 作为异步测试同步手段；
- deadline 判断应比较绝对时间，而不是假设每次 timer 准时；
- interval 回调执行慢时要明确是跳过、排队还是重叠。

### `setImmediate` 与 `setTimeout(0)` 谁先

答案取决于从哪里注册。尤其顶层注册的相对先后不应被当作稳定契约。从 I/O 回调内部注册时，`setImmediate` 通常能在下一 check 阶段先于新 timer，但仍应把业务顺序建立在 Promise、队列或状态机上。

配套实验只断言二者都在微任务之后，不断言二者彼此顺序。

---

## 11. `ref` / `unref` 决定进程是否为它存活

Node 的 timer、socket 等 handle 可能保持事件循环存活。长时间重试 timer 如果仍然 refed，会让本应退出的 CLI 或 Worker 一直挂着。

```ts
const timer = setTimeout(flush, 30_000);
timer.unref();
```

`unref` 的含义不是取消 timer，而是：如果它是唯一剩余工作，不要仅为它保持进程存活。

使用前必须问：

- 这是必须完成的数据持久化，还是尽力而为的遥测？
- 进程退出会不会丢关键状态？
- shutdown 流程是否有显式 flush deadline？

生命周期语义不能由一个随手的 `unref` 决定。

---

## 12. Agent 流式链路中的调度与背压

典型路径：

```text
供应商 socket
→ SDK 解析字节/SSE
→ Agent 事件转换
→ WebSocket/SSE 输出
→ 慢客户端
```

如果每收到 token 都用 `process.nextTick` 递归转发，可能饿死 socket poll；如果无视下游背压不断入队，内存会增长；如果每个 token 都做昂贵同步 Markdown 渲染，事件循环延迟会升高。

更稳健的策略：

- 保留字节、协议消息和领域事件边界；
- 使用 AsyncIterable/Web Stream 的 pull/backpressure 语义；
- 批量合并小 token，但设置最大等待时间；
- 传播取消；
- 限制队列长度并定义溢出策略；
- 将 CPU 密集后处理分块或下放 Worker。

详见 [17 · 流式协议与背压](17_streaming_protocols_and_backpressure.md)。

---

## 13. 如何观测事件循环健康度

Node `node:perf_hooks` 提供两类重要信号：

### event loop delay

`monitorEventLoopDelay()` 用直方图观察事件循环无法及时获得执行机会的延迟。应关注 p95/p99，而不是只看平均值。

### event loop utilization

`performance.eventLoopUtilization()` 估算事件循环活跃时间占比。高利用率不一定是故障，但持续接近饱和通常意味着排队延迟增加。

需要把它们与以下指标关联：

- Agent 首 token 时间和 token 间隔；
- 工具执行延迟；
- 队列长度；
- CPU、GC pause、heap；
- Worker Pool 饱和；
- 上游模型延迟。

事件循环 delay 高可能来自 CPU/GC，模型网络慢则不一定增加 event loop utilization。单个指标不能直接给出根因。

---

## 14. 与 Java 后端调度模型对照

| Java 常见模型 | Node.js 常见模型 |
|---|---|
| 一请求一线程或虚拟线程 | 多请求共享事件循环回调 |
| 阻塞等待只占住当前线程/虚拟线程 | 同步阻塞占住所有 JS 回调机会 |
| `Thread.interrupt` 协作中断阻塞操作 | `AbortSignal` 协作传播取消 |
| `ExecutorService` 分派 CPU/阻塞任务 | Worker Thread/Pool 或外部服务 |
| `ThreadLocal` | `AsyncLocalStorage` 沿异步因果链 |
| synchronized/Lock | 队列、事务、版本控制或异步锁协议 |
| checked/unchecked exception | Promise rejection、throw、Result 等多通道 |

Java 虚拟线程也不等于可以无限阻塞底层 carrier；Node 事件循环则把公平性要求直接暴露给每一个回调作者。

---

## 15. 测试调度时最常见的错误

### 用 sleep 等待状态

```ts
startAsyncWork();
await delay(20);
expect(done).toBe(true);
```

20ms 在本机可能够，在 CI 不够；改成 200ms 又让套件变慢。应暴露 Promise、事件或测试握手，让测试等待“状态已到达”的事实。

### 断言 timer 与 immediate 的偶然顺序

如果业务真的需要先后，就用显式队列/await 表达；测试运行时实现的偶然顺序只会制造脆弱用例。

### 使用 fake timer 后忘记 Promise 微任务

timer 时钟和 microtask queue 是不同机制。推进 fake timer 不必然清空所有 Promise continuation。应了解所用测试框架具体语义，并分别等待微任务或状态 Promise。

### 测试结束后仍有异步活动

未 await 的 subtest、未关闭 server、未清除 interval 或未消费 stream，会在测试完成后抛异常或让进程不退出。资源所有权必须进入测试契约。

---

## 16. 生产 Agent 调度检查表

- 同步回调的最大工作量是否有上界？
- 大 JSON、排序、token 处理是否测过 event loop delay？
- Promise.all 中究竟是 I/O 并发还是 CPU 串行？
- 是否存在递归 `nextTick` / microtask 链？
- timer 被当作阈值还是精确时钟？
- timeout reject 后，底层操作是否真正收到取消？
- CPU 长任务是分块 yield，还是应进入 Worker Pool？
- stream 是否有背压和队列上限？
- interval、socket、timer 是否影响进程退出？
- AsyncLocalStorage 上下文是否跨自定义回调正确传播？
- 测试是否使用握手而非 sleep？

---

## 17. 建议动手实验

1. 把配套实验的 `nextTick` 上限从 5000 提高，观察 timer 延迟，但不要改成无限递归。
2. 删除 `scheduler.yield()`，观察 heartbeat 只能在所有 CPU chunk 完成后运行。
3. 把 chunk 大小分别设为 1 千、10 万、100 万，记录总吞吐与 event-loop delay。
4. 从顶层 ESM 和 `setImmediate` 回调内分别注册 nextTick/Promise，解释差异。
5. 写一个可取消的 CPU 分块函数，每个 chunk 后 yield 并 `throwIfAborted()`。
6. 用 Worker Thread 执行相同 checksum，测量小输入时的消息传输成本和大输入时的收益。
7. 给 Agent 流式实验增加慢消费者，观察队列上限和取消行为。

## 延伸阅读

- [Node.js：The Node.js Event Loop](https://nodejs.org/learn/asynchronous-work/event-loop-timers-and-nexttick)
- [Node.js：Don't Block the Event Loop](https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop)
- [Node.js：Timers API](https://nodejs.org/api/timers.html)
- [Node.js：Performance measurement APIs](https://nodejs.org/api/perf_hooks.html)
