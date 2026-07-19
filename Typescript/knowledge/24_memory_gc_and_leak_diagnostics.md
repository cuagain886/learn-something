# TypeScript / Node.js 内存模型、V8 GC 与 Agent 泄漏诊断 ⭐⭐⭐

> TypeScript 可以证明一个变量是否可能为 `undefined`，却不能证明一段会话历史最终会被释放。长时间运行的 Agent 同时持有 transcript、工具输出、流式缓冲区、监听器和异步任务；只要其中存在一条意外的强引用路径，垃圾回收器就会把“业务上已经结束”的对象视为仍然存活。

本文不把“少用全局变量”当作内存治理。目标是建立一套能解释、测量、复现和验证的模型：

1. ECMAScript 的可达性语义与 TypeScript 静态类型有什么边界；
2. V8 为什么分代、为什么需要写屏障、GC 为什么会影响尾延迟；
3. `heapUsed`、`external`、`arrayBuffers`、RSS 分别代表什么；
4. `WeakMap`、`WeakRef`、`FinalizationRegistry` 能解决什么，不能解决什么；
5. 如何为 Agent run 建立可测试的所有权和内存预算；
6. 如何用 heap snapshot、allocation profile 和 GC trace 找到真实 retainer。

配套实验见 [`../code/src/31-memory-lifecycle.test.ts`](../code/src/31-memory-lifecycle.test.ts)。

---

## 1. 先分清三种“生命周期”

### 1.1 静态类型生命周期

interface、type alias、泛型参数和绝大多数类型断言在 emit 后消失：

```typescript
type RunId = string & { readonly __brand: 'RunId' };
const id = 'run_1' as RunId;
```

运行时通常只剩普通字符串。品牌类型能阻止编译期误传，不能让 V8 以不同方式管理它，也不能自动清理与该 ID 关联的对象。

### 1.2 JavaScript 对象可达性

垃圾回收器关心的是对象图中是否还存在从 root 到对象的强引用路径：

```text
GC root
  └─ global runRegistry: Map
       └─ RunState
            └─ transcript
                 └─ 大型 tool result
```

只要 `runRegistry` 没有删除这一项，后面的整棵对象图就仍然可达。对象“逻辑上结束”、局部变量离开源码作用域、类型被标成 `readonly`，都不会改变这条路径。

### 1.3 外部资源和业务所有权

数据库连接、文件描述符、定时器、锁、Worker、订阅和 trace span 需要确定性结束。GC 即使最终回收了包装对象，也不保证何时执行，更不知道业务协议要求何时释放租约。

因此应分别使用：

| 问题 | 主要机制 |
|---|---|
| 值是否满足静态契约 | TypeScript 类型系统 |
| 对象是否仍可从 root 到达 | GC 可达性与引用图 |
| 谁必须在何时结束资源 | `using`、`finally`、取消与所有权协议 |
| 一个 run 最多占用多少内存 | 显式 byte/item/token budget 与背压 |

把四者混为一谈，会产生“用了 GC 就不需要清理”“用了 `WeakMap` 就不需要容量限制”之类错误结论。

---

## 2. Root、retainer、shallow size 与 retained size

常见 GC roots 包括当前执行栈、模块/全局可达对象、宿主运行时持有的活跃回调与 handle 等。具体 root 集合属于引擎和宿主实现，不应把某份快照中的内部节点名称当成语言规范。

需要掌握四个术语：

- **shallow size**：对象自身直接占用的空间；
- **retainer**：持有到该对象引用的上游对象；
- **retaining path**：从 root 到目标对象的一条引用路径；
- **retained size**：如果移除某个对象，随之变为不可达的对象总量。

一个监听器函数自身可能只有很小的 shallow size，但它的闭包捕获完整 transcript；EventEmitter 又持有该函数，于是它的 retained size 可以很大。排查泄漏时只按 shallow size 排序，经常会错过真正的 owner。

### 2.1 Dominator 的工程含义

如果从 roots 到对象 B 的每条路径都必须经过对象 A，可把 A 理解为支配 B。Heap snapshot 的 dominator/retainer 视图能回答：

> 删除哪一个上游引用，才能释放最大的一组对象？

这比“哪种对象数量最多”更接近修复点。十万个小字符串可能只是症状，真正的根因可能是一个从未删除的 `Map<RunId, RunState>`。

---

## 3. Node 进程的内存不等于 V8 JavaScript 堆

`process.memoryUsage()` 暴露多个维度：

```typescript
const sample = process.memoryUsage();
console.log({
  rss: sample.rss,
  heapTotal: sample.heapTotal,
  heapUsed: sample.heapUsed,
  external: sample.external,
  arrayBuffers: sample.arrayBuffers,
});
```

| 指标 | 应怎样理解 |
|---|---|
| `heapUsed` | 当前线程 V8 堆已使用量，不等于整个进程内存 |
| `heapTotal` | V8 当前为堆申请的总容量，不等于 heap limit |
| `external` | 与 JS 对象关联、但位于 V8 堆外的 C++/宿主内存 |
| `arrayBuffers` | `ArrayBuffer`/`SharedArrayBuffer` 内存，Node `Buffer` 也在其中；它包含在 `external` 内 |
| `rss` | 进程驻留物理内存，包含 JS 堆、原生对象、代码、栈等 |

### 3.1 为什么只看 heapUsed 会漏诊

Agent 可能持续保留上传文件、图片、音频或 SSE 字节块。这些 `Buffer` 的少量 JS wrapper 在堆内，而大块 backing store 主要体现在 `arrayBuffers/external`。此时：

- `heapUsed` 可能较稳定；
- `arrayBuffers` 和 RSS 却持续上升；
- 只拍 JS 对象数量仍能看到 Buffer wrapper 的 retaining path，但不能用 shallow size代表实际字节成本。

反过来，RSS 增长而 V8 heap 和 external 都稳定，也不必立刻断言“JS 泄漏”。分配器碎片、原生 addon、线程栈、JIT code 等都可能影响 RSS，需要继续分层归因。

### 3.2 Worker Thread 的口径

Node 官方说明中，Worker 场景的 RSS 是整个进程口径，`heapUsed` 等其他字段是当前线程口径。因此监控 Worker 池时，不能把主线程的一次 `memoryUsage()` 当成所有 isolate 的堆总和。

---

## 4. V8 为什么使用分代 GC

下面描述的是 V8 当前公开的总体设计，不是 ECMAScript 对实现的强制要求。空间名称、阈值和具体并发策略会随 V8 版本变化。

### 4.1 世代假说

典型程序中，大量对象创建后很快死亡，少量对象存活很久。Agent 每个 token/event 创建的临时对象通常属于前者，模型配置、注册表和缓存属于后者。

如果每次都扫描整个堆，成本很高，因此 V8 把对象大体分成年轻代和老年代，并对它们采用不同策略。

### 4.2 年轻代：半空间复制与 evacuation

V8 公布的 Scavenger 使用 semi-space 思路：年轻代的一部分作为 From-Space，另一部分作为 To-Space。Minor GC 时从 roots 和 remembered set 出发，把仍存活的对象复制/evacuate 到新空间，并更新引用。

结果是：

- 死对象无需逐个回收；没有被复制的区域整体丢弃；
- 存活对象被紧凑排列，减少碎片；
- 复制成本与存活对象更相关，而非所有已分配对象；
- 多次存活的对象会晋升到老年代。

所以“创建很多短命小对象”并非必然泄漏，但会增加分配率和 minor GC 压力；如果这些对象被某个长寿命容器意外引用，它们会存活、晋升，问题会放大。

### 4.3 老年代：标记、清扫与整理

老年代收集需要识别整张存活对象图。V8 的 Orinoco 架构会组合标记、清扫/整理、增量和并发工作，尽量减少主线程暂停；但某些阶段仍需要 stop-the-world 协调。

工程上应理解：

- “GC 是并发的”不等于完全没有暂停；
- 大量长期存活对象会增加 major GC 的跟踪成本；
- 接近 heap limit 时，GC 可能更频繁，吞吐下降、尾延迟恶化，最后才 OOM；
- 把 heap limit 调大只会延后失败，也可能使一次 major GC 或快照更昂贵。

### 4.4 为什么需要写屏障

Minor GC 不希望每次扫描整个老年代。但老对象可能新写入一个年轻对象引用：

```typescript
longLivedRegistry.latest = newlyAllocatedRun;
```

V8 使用 write barrier 记录 old→young 引用，形成 remembered set。收集年轻代时，把这些记录和栈/全局 roots 一起作为入口，就不必遍历全部老年代。

写屏障说明了一个重要事实：对象代际不是应用代码可观察的业务状态。不要基于“它大概还在 young generation”设计逻辑；只应把它作为理解 GC 成本的模型。

### 4.5 与 Java 的类比和差异

| Java 后端直觉 | Node/V8 需要调整的地方 |
|---|---|
| JVM heap 指标通常是主要入口 | Node 还要单独看 Buffer/external/RSS |
| 对象字段由 class layout 强约束 | JS 对象形状动态，TypeScript interface 已擦除 |
| try-with-resources 管资源 | `using`/`await using` 或 `try/finally` 管资源；GC 都不能替代它 |
| ThreadLocal 跟随线程 | AsyncLocalStorage 跟随异步因果链，不绑定 OS 线程 |
| WeakHashMap 可做弱键关联 | `WeakMap` 同样不可枚举，不能用来回答缓存容量 |
| 调大堆可能缓解瞬时压力 | 对无界 retainer 只是在推迟 OOM |

---

## 5. 强引用是路径，不是变量名

### 5.1 `const`、`readonly` 与冻结都不影响保活

```typescript
const state: Readonly<{ transcript: readonly string[] }> = loadState();
```

这些约束解决重新赋值/写入问题，不会把引用变弱。`Object.freeze` 也只是阻止部分变更，不会允许对象在仍可达时被回收。

### 5.2 闭包捕获的是词法环境

```typescript
function attach(emitter: NodeJS.EventEmitter, transcript: string[]) {
  emitter.on('token', () => {
    console.log(transcript.length);
  });
}
```

只要 emitter 持有 listener，listener 的环境就可能持有 transcript。源码里 `attach` 已返回不代表环境已释放。

还要警惕“共享词法环境”而非只看函数体。V8 的 WeakRef 官方示例特别提醒：若 wrapper 与被包装 listener 共享捕获环境，wrapper 可能通过环境反向保活本想弱引用的对象。

### 5.3 Promise 不是天然泄漏，也不是自动清理边界

“pending Promise 永远泄漏”过于绝对。一个没有任何 root、也没有宿主异步操作保活的 Promise 可以变为不可达。真正需要问的是：

- 谁持有 Promise 或它的 reaction callback？
- timer/socket/队列是否仍持有完成回调？
- callback 闭包捕获了什么？
- 取消后底层操作是否真正停止，还是只让外层 `race` 先返回？

`Promise.race([work, timeout])` 不会自动取消输掉的 work。若 work 仍读取流、保留 Buffer 或等待永不发生的事件，资源和闭包仍可能存活。

### 5.4 EventEmitter 的警告不是容量控制

`MaxListenersExceededWarning` 是启发式预警，不是 GC 证明。提高 `setMaxListeners` 只能隐藏警告，不能删除 listener。正确不变量通常是：

```text
run 结束后 listenerCount 回到注册前基线
```

这个不变量可以确定性测试，不需要等待 GC。

---

## 6. WeakMap、WeakRef 与 FinalizationRegistry

### 6.1 WeakMap：把附属数据生命周期绑定到 key

```typescript
type RunObject = { readonly id: string };
type DebugMetadata = { readonly createdAt: number };

const metadata = new WeakMap<RunObject, DebugMetadata>();
```

WeakMap 不会仅因为 key 出现在映射里就阻止 key 被回收。适合：

- 给 SDK/框架对象附加不可见 metadata；
- memoize“结果只在输入对象活着时有意义”的计算；
- 避免修改外部对象本身。

它故意没有 `size`、keys 和迭代能力，因为枚举结果会被不可预测的 GC 时机影响。因此它不适合：

- 需要列出所有 active run 的注册表；
- 必须按数量或字节淘汰的缓存；
- 需要审计、持久化或主动关闭所有条目的资源 owner。

弱键也不是万能药：若另一个强 `Map`、listener 或 closure 仍持有 key，WeakMap 不会改变结果。

### 6.2 WeakRef：一次 `deref()` 不是生命周期锁

```typescript
const weak = new WeakRef(expensiveObject);
const current = weak.deref();
if (current !== undefined) {
  use(current);
}
```

`deref()` 可能返回对象或 `undefined`。不要把它用作关键业务状态：

- GC 是否发生、何时发生不可预测；
- 命中率会随内存压力和引擎策略变化；
- 弱引用对象消失不能等价为 run 已完成或租约已释放；
- 若代码又把结果放入长寿命强容器，仍会重新保活。

适用场景通常是可丢失的优化层，而不是 correctness 所依赖的数据。

### 6.3 FinalizationRegistry：最多做非关键兜底/观测

Finalization callback 的执行时间没有保证，进程退出前也可能完全不运行。V8 官方明确指出，合规实现甚至可以一直不触发 GC。因此禁止用 finalizer 完成：

- 数据库事务提交/回滚；
- 锁、租约、文件描述符的及时释放；
- 账单、审计、指标准确计数；
- Agent run 的 terminal event。

注册时还要避免 held value 或 cleanup closure 强引用 target，否则会自己制造 retaining path。资源正确性仍由 `using`/`finally` 保证；finalizer 最多报告“某对象未显式关闭”的诊断信号，而且该信号也不能视为完整统计。

---

## 7. Agent 中最常见的 retaining path

| 症状来源 | 常见强路径 | 正确约束 |
|---|---|---|
| active run 注册表 | global `Map` → RunState → transcript | 所有 terminal path 在 `finally` 删除；重复 ID 明确拒绝 |
| 会话历史 | session cache → messages → tool payload | token/byte 双预算；摘要后删除原始大对象 |
| 工具结果 | transcript → JSON/Buffer/base64 | 只保留引用/摘要；大 payload 外置且有 TTL |
| 流式队列 | producer → unbounded array → chunks | 有界队列、背压、取消时 drain/release |
| EventEmitter | emitter → listener → closure → run | 订阅返回 Disposable；结束后 listener 数回基线 |
| AbortSignal | signal → abort listener → operation | 使用 `addAbortListener`/`{ once: true }` 并可显式移除 |
| timer/retry | timer handle → callback → request | deadline/abort 清 timer；长 timer 必要时 `unref()` |
| inflight 去重 | `Map<Key, Promise>` → reaction closures | Promise settle 的 `finally` 删除，失败也不能残留 |
| AsyncLocalStorage | async resource → store →大对象 | store 只放小型 ID/权限；结束真正的异步资源 |
| trace/metrics | exporter buffer → spans/events | batch 大小、队列上限、丢弃策略和 flush deadline |
| Worker 消息 | MessagePort/queue → cloned payload | transfer 大 Buffer 所有权，限制 inflight 消息 |

### 7.1 Transcript 的“类型安全”不等于“容量安全”

```typescript
type Message =
  | { readonly role: 'user'; readonly text: string }
  | { readonly role: 'tool'; readonly name: string; readonly output: unknown };

const history: Message[] = [];
```

这个联合可以阻止非法角色组合，却没有表达：

- 最多多少条；
- 最多多少 token/UTF-8 byte；
- tool output 是否允许 Buffer；
- 哪些消息可以摘要或外置；
- 并发 run 是否共享同一 history。

容量是运行时不变量，必须由代码测量和执行。

### 7.2 base64 会放大内存和瞬时峰值

把 Buffer 转为 base64 再嵌入 JSON，常同时保留原 Buffer、编码字符串和序列化结果。即使最终对象都会回收，峰值也可能超过容器限制。大媒体应流式处理或外置，不要仅通过增大 old-space 解决。

---

## 8. 把所有权写成可测试协议

### 8.1 注册与删除必须在同一抽象中

```typescript
class RunRegistry<T> {
  readonly #active = new Map<string, T>();

  async withRun<R>(id: string, value: T, work: () => Promise<R>): Promise<R> {
    if (this.#active.has(id)) throw new Error(`duplicate run: ${id}`);
    this.#active.set(id, value);
    try {
      return await work();
    } finally {
      this.#active.delete(id);
    }
  }
}
```

不要让调用方分别记住 `register()` 和 `unregister()`。把它们组合后，正常、异常和取消路径共享一个清理点。

### 8.2 订阅应返回 Disposable

```typescript
function subscribe(
  emitter: import('node:events').EventEmitter,
  listener: (token: string) => void,
): Disposable {
  emitter.on('token', listener);
  return {
    [Symbol.dispose]() {
      emitter.off('token', listener);
    },
  };
}
```

调用方可以使用 `using`，并在测试中验证 block 退出后 listenerCount 回到基线。相比依赖 WeakRef，这个协议确定、可观察、可移植。

### 8.3 Abort listener 也是资源

Node 的 `events.addAbortListener(signal, listener)` 返回 Disposable，并处理第三方调用 `stopImmediatePropagation()` 的边界。即使 signal 最终会 abort，操作提前完成时也应移除 listener：

```typescript
using abortSubscription = addAbortListener(signal, onAbort);
return await operation;
```

这会把“操作完成”和“取消监听生命周期”绑定在同一个词法 scope。

### 8.4 缓存按真实成本设预算

只设 entry count 可能不足：一个 tool result 可能是 100 B，也可能是 100 MB。生产缓存至少要明确：

```typescript
type CacheBudget = {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly ttlMs: number;
};
```

还要定义 size estimator、覆盖同 key 时如何记账、单条超预算是否拒绝、淘汰顺序是否在读取时刷新。第 31 课用确定性 byte-budget LRU 展示这些不变量。

### 8.5 后台任务必须能 join

“fire-and-forget”任务如果捕获 run state，会把整个 run 的生命周期延长到任务 settle。结构化做法是：

- parent 持有 child task 集合；
- parent 取消时向 child 传播 signal；
- scope 结束前 await/join；
- 超过 deadline 时记录明确失败，而不是静默遗留。

这与[异步运行时与结构化并发](12_async_runtime_and_structured_concurrency.md)和[显式资源管理](16_explicit_resource_management.md)是同一套所有权思想。

---

## 9. 什么样的测试能证明“没有所有权泄漏”

### 9.1 优先测试确定性计数器

比起断言某次 GC 后 `heapUsed` 精确下降，更可靠的契约是：

- active run Map 在成功、异常、取消后都是 0；
- listenerCount 回到基线；
- inflight Promise registry 在 settle 后删除；
- cache `usedBytes <= maxBytes` 始终成立；
- 有界队列长度不会超过 capacity；
- Disposable 多次释放不重复执行副作用；
- 测试结束没有未 join 的任务。

这些断言直接覆盖业务 owner，不受 GC 调度和并行测试噪声影响。

### 9.2 不要把 `global.gc()` 当成单元测试证明

使用 `node --expose-gc` 可以在受控诊断实验中请求 GC，但：

- “请求”不等于规范保证某个对象立即 finalise；
- JIT、测试框架、控制台和临时变量可能改变可达性；
- `heapUsed` 会受其他测试和引擎内部缓存影响；
- 不同 Node/V8 版本可能有不同结果。

弱引用/heap 趋势实验适合作为独立诊断脚本或性能基准，不适合成为日常 CI 的精确布尔门禁。

### 9.3 稳态负载测试看斜率，不看单点

合理流程是：

1. 预热模块、JIT 和连接池；
2. 执行固定一批 run；
3. 等待明确的业务清理点，而非任意 sleep；
4. 记录多维 memory sample、active runs/listeners/cache bytes；
5. 重复多个 cycle，比较每轮清理后的 baseline；
6. 若 baseline 持续上升，再进入 snapshot/profiler 归因。

正常堆通常呈锯齿，不要求每个采样点单调下降。真正可疑的是多个等价 cycle 之后的低点仍持续增长。

---

## 10. 观测指标怎样读

### 10.1 推荐同时记录

```typescript
import { getHeapStatistics } from 'node:v8';

function sampleMemory() {
  const processMemory = process.memoryUsage();
  const heap = getHeapStatistics();
  return {
    ...processMemory,
    heapSizeLimit: heap.heap_size_limit,
    totalAvailableSize: heap.total_available_size,
    activeRuns: runRegistry.size,
    cacheBytes: cache.usedBytes,
    streamQueueItems: streamQueue.size,
  };
}
```

业务计数器非常关键。只有内存曲线而没有 active run/cache/listener 等基数，很难区分“流量增加导致合理存活”与“每个已结束 run 都残留一个对象”。

### 10.2 指标组合的初步判断

| 现象 | 首先怀疑 | 还需什么证据 |
|---|---|---|
| `heapUsed` 锯齿且低点稳定 | 正常分配/GC | 延迟和 GC CPU 是否可接受 |
| `heapUsed` 每轮低点上升 | JS 对象被强引用 | snapshot comparison、retaining path |
| `arrayBuffers` 与 RSS 上升 | Buffer/流式字节保留 | Buffer wrapper retainer、队列/上传计数 |
| RSS 上升、heap/external 稳定 | 原生内存或分配器碎片 | native profile、线程/addon/平台数据 |
| heap 稳定但 GC CPU 很高 | 高 allocation rate/短命对象抖动 | allocation sampling、GC trace |
| listener warning 增加 | 重复订阅或未退订 | 按 emitter/event 统计 listenerCount |
| active runs 为 0 但对象仍增长 | 全局缓存、exporter、timer、闭包 | 从对象反查 root path |

### 10.3 `getHeapSpaceStatistics()` 不应成为稳定业务契约

Node 明确说明 heap space 的顺序和可用空间名称可能随 V8 变化。它适合诊断/版本固定的监控，不应让业务逻辑依赖 `new_space` 等字符串必然存在。

---

## 11. 从复现到 retainer 的诊断流程

### 11.1 第一步：定义泄漏假设

不要从“RSS 高”直接跳到“某段代码泄漏”。先写出可反驳假设：

```text
每完成 1000 个 run，RunState 数量增加约 1000；
它们通过 tokenEmitter 的 listener 被保活；
移除订阅后，同样负载下第二轮 snapshot 不再增长。
```

假设包含对象类型、增长率、retainer 和修复后的预期，才便于验证。

### 11.2 第二步：隔离负载并预热

- 固定模型/工具 adapter，避免远端变化；
- 使用相同 transcript 大小和并发度；
- 完成启动/JIT/连接池预热；
- 一次只触发可疑路径；
- 记录 run created/finished、listener、cache 和 Buffer byte 数。

### 11.3 第三步：选择工具

```bash
# 本地连接 Chrome DevTools；Memory 面板可拍 snapshot/做 allocation sampling
node --inspect dist/server.js

# 查看 GC 事件，适合判断分配压力和 major GC 频率
node --trace-gc dist/server.js

# 进程退出时生成 sampling heap profile
node --heap-prof dist/server.js

# Unix-like 系统可配置收到信号时拍 snapshot
node --heapsnapshot-signal=SIGUSR2 dist/server.js

# 接近 heap limit 时尽力保留诊断快照；不要把它当防止 OOM 的机制
node --max-old-space-size=1024 --heapsnapshot-near-heap-limit=2 dist/server.js
```

也可以用 `node:v8` 的 `writeHeapSnapshot()`/`getHeapSnapshot()`，但触发入口必须鉴权，快照文件必须按敏感数据处理。

### 11.4 Heap snapshot 的生产风险

Node 官方提醒：生成快照会同步阻塞主线程，并可能需要大约当前堆大小两倍的内存，甚至让本来就接近 OOM 的进程被杀。因此：

- 只在可被替换/摘流的实例上操作；
- 预留磁盘和内存；
- 不把公开 HTTP endpoint 暴露为拍快照入口；
- 快照可能包含 prompt、token、密钥片段和用户数据，必须加密、限权、限时保留；
- Windows 环境不要照搬 Unix signal 流程，可使用 inspector 或受控 `writeHeapSnapshot()`。

### 11.5 两份快照怎样比较

Node 官方建议的核心流程是：预热并执行一次可疑功能 → 拍基线 → 重复同一功能且不混入无关操作 → 拍第二份 → 在 Comparison 中查看正增量并沿 retainer 向 root 回溯。

阅读时重点问：

1. 增长的是业务对象本身，还是字符串/数组等下游对象？
2. 哪个 dominator 的 retained size 最大？
3. retaining path 是否经过 Map、listener、timer、Promise reaction、AsyncLocalStorage 或 native wrapper？
4. 该 owner 为什么在 run terminal 后仍存在？
5. 修复后同样负载与快照差分是否消失？

快照只证明“拍摄瞬间的可达性”。它不能单独证明分配速率、历史峰值或哪条调用栈创建了对象；这时要结合 allocation sampling/timeline。

---

## 12. 常见错误修复为什么无效

### 12.1 “把 `Map` 换成 WeakMap”

如果系统需要按 run ID 查找、列举、取消所有 run，key 通常是 string，WeakMap 也不能使用普通 string key；即使改为对象 key，其他注册表仍可能强持有它。正确修复是明确 owner 和 terminal 删除路径。

### 12.2 “提高 max listeners”

它只改变预警阈值，不清理闭包。应先证明并发订阅数确实合理；否则让订阅返回 Disposable，并测试基线恢复。

### 12.3 “加一个 TTL”

TTL 没有容量上限时，在到期前仍可能装入海量数据；定时清理器本身也可能被阻塞或失效。缓存通常需要 max entries、max bytes、TTL 三者组合，并暴露淘汰/拒绝指标。

### 12.4 “在 finally 里把局部变量设为 null”

若真正 retainer 是全局 Map 或 emitter listener，清空另一个局部引用没有作用。应从 snapshot retaining path 找到最上游的错误 owner。

### 12.5 “手动 GC 后下降，所以没泄漏”

下降只能说明存在可回收垃圾；不能证明业务上已结束的对象没有仍被保活。继续观察多个 cycle 的 baseline，并检查确定性所有权计数器。

### 12.6 “调大 `--max-old-space-size`”

这对合理工作集过大可能有帮助，对无界增长不会改变斜率。它还可能让 OOM 更晚、更难复现，并提高快照和 major GC 成本。

---

## 13. 一个 Agent 泄漏案例的推理链

假设每个 run 都订阅全局 token bus：

```typescript
class RunObserver {
  constructor(
    bus: import('node:events').EventEmitter,
    readonly transcript: readonly string[],
  ) {
    bus.on('token', () => this.record());
  }

  record() {
    // 使用 transcript
  }
}
```

run 完成后外部不再保存 `RunObserver`，但引用图仍是：

```text
global bus
  → listeners['token'][]
    → arrow function
      → this (RunObserver)
        → transcript
```

修复不是等待 GC，而是让订阅有明确 owner：

```typescript
class RunObserver implements Disposable {
  readonly #listener = () => this.record();

  constructor(
    private readonly bus: import('node:events').EventEmitter,
    readonly transcript: readonly string[],
  ) {
    bus.on('token', this.#listener);
  }

  [Symbol.dispose]() {
    this.bus.off('token', this.#listener);
  }

  record() {}
}

{
  using observer = new RunObserver(bus, transcript);
  await runAgent(observer);
}
```

对应测试不需要测 GC：block 前基线为 0，内部为 1，正常/throw/cancel 后都恢复 0。这直接证明 retaining edge 已移除。

---

## 14. 内存治理也是类型和 API 设计问题

TypeScript 不能静态计算真实 heap byte，但可以让“预算是否传入、单位是否混淆、清理能力是否暴露”成为 API 契约：

```typescript
declare const byteBrand: unique symbol;
type Bytes = number & { readonly [byteBrand]: true };

type MemoryBudget = {
  readonly transcript: Bytes;
  readonly toolOutput: Bytes;
  readonly streamQueue: Bytes;
};

type Subscription = Disposable;

interface RunHost {
  start(input: unknown, budget: MemoryBudget): Promise<Disposable>;
}
```

品牌防止把毫秒/条数误当 byte，但 `number as Bytes` 仍可撒谎，所以构造函数必须运行时验证非负、安全整数和上限。类型负责传播单位关系，运行时代码负责测量和执行预算。

公共 API 还应避免：

- 返回内部可变数组，让调用方永久持有整个历史；
- 隐式注册 listener 却不返回 unsubscribe/Disposable；
- 接受无限 AsyncIterable 却没有 signal/capacity；
- 用 `unknown` 工具结果直接进入长期缓存；
- 隐藏后台任务，使调用方无法 join/close。

---

## 15. 生产检查表

### 对象与容器

- 每个长期 Map/Set/Array 的 owner、删除条件和容量上限是什么？
- entry count 能否代表成本，还是必须按 byte/token 记账？
- 覆盖同 key、失败、取消时是否正确回滚计数？
- transcript/tool payload 是否保留了重复编码或原始 Buffer？
- WeakMap 是否只用于附属 metadata，而非可审计注册表？

### 异步与订阅

- 每次 `on`/`addEventListener` 是否对应 `off`/Disposable？
- retry timer、deadline timer 和 Abort listener 是否在提前完成时清理？
- `Promise.race` 输掉的操作是否真正取消和 join？
- AsyncGenerator 提前 break 是否触发 `return()`/finally？
- AsyncLocalStorage store 是否只包含小型、不可变上下文？
- Worker/MessagePort/stream reader 是否有 close/release/cancel 路径？
- Worker 输入是 clone、transfer 还是 SharedArrayBuffer，进程 RSS 与各 isolate heap 是否分别设预算？详见[Worker Threads 与类型化并发协议](25_worker_threads_and_typed_protocols.md)。

### 观测与诊断

- 是否同时监控 heap、external、arrayBuffers、RSS 和业务基数？
- 是否比较稳态 cycle 的 baseline，而不是单点？
- 快照触发是否鉴权、摘流并预留双倍堆风险？
- heap snapshot/profile 是否按敏感数据管理？
- 是否能从 run ID 关联到 listener/cache/queue 指标？
- 修复是否由同负载、同快照流程和确定性契约测试共同验证？

---

## 16. 建议动手实验

1. 运行 `npm run lesson:memory`，把订阅的 dispose 删除，观察 listener 基线测试失败。
2. 把 byte-budget cache 改成只限制 entry count，插入一个超大 Buffer payload，解释为什么测试模型不足。
3. 构造 `Map<string, Promise>` 去重器，分别让 Promise resolve/reject，验证两条路径都删除。
4. 用固定负载反复创建/结束 1000 个假 run，同时记录 `heapUsed`、`arrayBuffers` 和 active run 数。
5. 故意让全局 listener 捕获 1 MB transcript，拍两份 heap snapshot，沿 retaining path 找到 emitter。
6. 用 allocation sampling 比较“每 token 创建完整消息副本”和“只追加 delta”两种实现。
7. 用 `--trace-gc` 观察大量短命对象与长期保活对象对 minor/major GC 的不同影响。
8. 把大 Buffer 同时转 base64 和 JSON，记录瞬时 RSS/external/heapUsed，解释每份副本位于哪里。
9. 创建 FinalizationRegistry 实验，验证你无法为 callback 写一个可靠的固定超时断言。
10. 为真实 Agent Runtime 增加 activeRuns、listenerCount、queueSize、cacheBytes 指标，并在取消测试后断言全部回基线。

---

## 延伸阅读

- [V8：Orinoco garbage collector](https://v8.dev/blog/trash-talk)
- [V8：Weak references and finalizers](https://v8.dev/features/weak-references)
- [Node.js：`process.memoryUsage()`](https://nodejs.org/api/process.html#processmemoryusage)
- [Node.js：V8 heap statistics 与 snapshot API](https://nodejs.org/api/v8.html)
- [Node.js：Using Heap Snapshot](https://nodejs.org/learn/diagnostics/memory/using-heap-snapshot)
- [Node.js：Using Heap Profiler](https://nodejs.org/learn/diagnostics/memory/using-heap-profiler)
- [Node.js：`events.addAbortListener`](https://nodejs.org/api/events.html#eventsaddabortlistenersignal-listener)
- [ECMAScript：Managing Memory / WeakRef / FinalizationRegistry](https://tc39.es/ecma262/multipage/managing-memory.html)
- [本目录：JavaScript 运行时对象模型](15_javascript_runtime_object_model.md)
- [本目录：显式资源管理](16_explicit_resource_management.md)
- [本目录：流式协议与背压](17_streaming_protocols_and_backpressure.md)
- [本目录：异步上下文传播](18_async_context_propagation.md)
- [本目录：事件循环与调度](21_event_loop_and_scheduling.md)
- [本目录：Agent 契约测试](23_testing_type_and_agent_contracts.md)

## 一句话总结

GC 只能回收不可达对象，不能识别“业务已结束”；生产级 Agent 必须用显式所有权移除 retaining edge，用 byte/token/capacity 预算限制仍然合法存活的工作集，再用多维指标、快照 retainer 和确定性契约测试分别证明容量、归因与清理。
