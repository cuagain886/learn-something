# Node.js Worker Threads、共享内存与类型化并发协议 ⭐⭐⭐

> `async` 能让 I/O 等待不阻塞调用链，却不会把 CPU 循环自动搬到其他线程。Worker Thread 让 JavaScript 真正并行执行，但它也引入了新的系统边界：独立 V8 isolate、structured clone、所有权转移、共享内存、数据竞争、线程终止和跨线程协议验证。

本文面向已经熟悉 Java 线程池、`ExecutorService`、Future 和 JVM 内存模型的读者，重点解释 Node/TypeScript 的差异。配套代码：

- [`../code/src/32-worker-protocol.ts`](../code/src/32-worker-protocol.ts)：静态 union 与双向运行时 parser；
- [`../code/src/32-worker-checksum-worker.ts`](../code/src/32-worker-checksum-worker.ts)：Worker 入口与 CPU 循环；
- [`../code/src/32-worker-client.ts`](../code/src/32-worker-client.ts)：transfer、取消、事件与所有权包装；
- [`../code/src/32-worker-threads.test.ts`](../code/src/32-worker-threads.test.ts)：源码/编译产物双路径契约测试。

---

## 1. Worker 解决的不是“异步”，而是 CPU 并行

### 1.1 `await` 不会创建线程

```typescript
async function calculate(): Promise<number> {
  let result = 0;
  for (let i = 0; i < 1_000_000_000; i += 1) {
    result += i;
  }
  return result;
}
```

调用 `calculate()` 后，循环在当前 JavaScript 线程同步执行。函数只有遇到真正的 `await` 才把后续 continuation 排入任务队列；在这之前，timer、socket callback、流式 token 和其他 Agent run 都得不到调度。

把同步计算包成 Promise 也没有帮助：

```typescript
const result = await Promise.resolve().then(cpuHeavyFunction);
```

它只是把计算移到 microtask，仍在同一线程，而且可能让 timer 更晚执行。

### 1.2 Node 官方的使用边界

Node 官方把 Worker 定位为 CPU-intensive JavaScript。普通网络、文件等异步 I/O 通常已经由 Node/libuv/操作系统高效处理，为每个 I/O 再创建 Worker 往往只增加启动和消息传输成本。

适合 Worker 的候选：

- 大型纯 JS 解析、转换、压缩算法；
- CPU 密集文本预处理、tokenization 或本地检索计算；
- 图片/音频处理的纯 JS/WASM 部分；
- 大型 AST 分析、代码索引、静态规则执行；
- 能明确切成任务、输入输出可序列化的计算。

不应机械下放：

- 普通 HTTP/数据库等待；
- Node API 已经使用 libuv worker pool 的操作，却没有测量瓶颈；
- 极小任务，启动/排队/clone 成本大于计算；
- 需要强进程隔离或执行不可信代码的“沙箱”。

---

## 2. 一个 Worker 是什么

每个 Worker 在独立线程执行 JavaScript，并拥有独立 V8 isolate：

```text
同一个 Node 进程
├─ Main thread
│  ├─ V8 isolate / heap / event loop
│  └─ Worker 对象 + MessagePort
├─ Worker A
│  ├─ 独立 V8 isolate / heap / event loop
│  └─ parentPort
└─ Worker B
   ├─ 独立 V8 isolate / heap / event loop
   └─ parentPort

可显式共享：SharedArrayBuffer 等
进程级共同命运：崩溃、RSS、部分原生资源
```

这意味着：

- 普通 JS 对象不能直接共享引用；消息要 clone 或 transfer；
- 每个 isolate 单独加载模块、维护 globals、执行 JIT 和 GC；
- 一个 Worker 的同步 CPU 循环不会阻塞主线程事件循环；
- 但它会阻塞这个 Worker 自己处理后续 message/timer；
- Worker 仍处于同一 OS 进程，不是权限或安全隔离边界。

### 2.1 与 Java Thread 的关键差异

Java 线程通常直接共享同一 JVM heap 中的对象；正确性依赖锁、volatile、并发集合和 Java Memory Model。Worker 默认更像 actor/message-passing：普通对象跨边界时复制，只有显式 SharedArrayBuffer 才共享字节。

默认不共享降低了大量数据竞争，但代价是：

- 序列化/反序列化和复制成本；
- 对象身份、原型、getter 等语义变化；
- 无法把任意 service/function 直接传给 Worker；
- 需要设计稳定消息协议。

---

## 3. 四类并发手段不要混淆

| 手段 | 主要用途 | 是否并行执行 JS | 数据/故障边界 |
|---|---|---:|---|
| `async` + Node I/O | 网络、数据库、文件等待 | 否 | 同 isolate，共享对象 |
| libuv worker pool | 部分 fs/DNS/crypto/zlib 原生工作 | 不直接执行你的 JS 循环 | Node 内部调度 |
| `worker_threads` | CPU 密集 JS/WASM | 是 | 同进程、独立 isolate，可 transfer/share memory |
| `child_process`/容器 | 故障、权限、资源隔离 | 是 | 独立进程/更强 OS 边界，IPC 成本更高 |

### 3.1 Worker 不是沙箱

Worker 通常能使用大多数 Node API，与父线程共享同一进程权限。给不可信 Agent 生成代码一个 Worker 并设置超时，不等于安全执行：

- 代码仍可能读环境变量、文件或网络；
- 原生 addon 或进程级资源仍可能受影响；
- 大量 external/ArrayBuffer 内存可能拖垮整个进程；
- `resourceLimits` 不是 OS cgroup、seccomp 或权限隔离。

不可信执行应使用权限受限的进程、容器、VM/WASM sandbox 或外部执行服务，并建立网络、文件、CPU、内存和时间多层限制。

---

## 4. structured clone：传的是值图，不是原对象

`postMessage(value)` 使用与 HTML structured clone 兼容的算法。它能处理许多 JSON 不支持的结构，如循环引用、Map、Set、BigInt、TypedArray 等，但不等于“任意 JS 对象都原样复制”。

### 4.1 类实例会失去行为

```typescript
class ToolMessage {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  get normalized() {
    return this.text.trim();
  }

  execute() {}
}

port.postMessage(new ToolMessage(' search '));
```

接收端通常得到类似 `{ text: ' search ' }` 的普通对象：

- 自定义 prototype 不保留；
- prototype method 不保留；
- getter/setter 描述符不保留；
- 非可枚举属性、symbol 属性和私有字段不会按类实例语义重建；
- `instanceof ToolMessage` 为 false。

因此跨线程协议应使用 plain data + discriminator，再由接收端验证并调用自己的领域逻辑。不要把“传类实例”当远程方法调用。

### 4.2 函数不能 clone

```typescript
worker.postMessage({ callback: () => 42 }); // DataCloneError
```

依赖注入要转换为 capability ID、操作名或配置，而不是发送闭包。Worker 内部根据白名单解析操作：

```typescript
type Operation =
  | { readonly kind: 'tokenize'; readonly text: string }
  | { readonly kind: 'checksum'; readonly bytes: ArrayBuffer };
```

这与 Agent 工具协议相同：发送“请求做什么”，不是把主线程函数引用交给另一端。

### 4.3 clone 发生在发送时

不在 transferList 中的可 clone 数据会在消息发送语义中复制。发送后再修改原对象，不会修改已经发送的那份值图。大对象 clone 可能同时带来：

- 主线程序列化工作；
- 接收端分配；
- 一段时间内两份内存共存；
- 更高 GC 压力和消息延迟。

所以“把 CPU 任务放进 Worker”不代表主线程零成本；必须把消息传输成本纳入基准。

---

## 5. Transferable：移动所有权，而不是共享

`ArrayBuffer` 放入 transferList 时，底层 backing store 被移动到接收端，发送端 ArrayBuffer 变成 detached：

```typescript
const values = new Uint32Array([1, 2, 3]);
const alias = new Uint8Array(values.buffer);

worker.postMessage(
  { values: values.buffer },
  [values.buffer],
);

console.log(values.length); // 0
console.log(alias.length);  // 0
```

### 5.1 所有 view 一起失效

TypedArray/Buffer 是对底层 ArrayBuffer 的 view。transfer 的是 backing store，不是某一个变量；凡是共享该 buffer 的 view 都会失效。

这是一种运行时所有权转移，TypeScript 目前不会自动把发送后的变量类型变成“不可使用”：

```typescript
worker.postMessage(payload, [buffer]);
use(buffer); // checker 通常仍允许，但运行时已 detached
```

因此 API 设计应让所有权变化明显：

- 参数命名使用 `ownedBuffer`/`transferInput`；
- 文档和类型说明调用后发送方失去所有权；
- transfer 前完成取消/参数校验；
- transfer 后禁止在发送方继续读取；
- 测试所有 alias view 都 detached。

### 5.2 Buffer pool 的危险边界

Node `Buffer` 是否独占自己的 ArrayBuffer 取决于创建方式。`Buffer.from()`/`allocUnsafe()` 可能使用内部 pool；盲目传它的 `.buffer` 可能无法 transfer，或者 clone 整个 pool，造成额外内存与潜在数据暴露风险。

Node 提供 `markAsUntransferable()` 阻止某个 ArrayBuffer 被转移。若底层内存仍被其他 view/组件使用，应明确禁止 transfer，而不是依赖调用方记忆。

### 5.3 Transfer 与 clone 的选择

| 需求 | 更适合 |
|---|---|
| 发送后父线程不再需要大型二进制输入 | transfer ArrayBuffer |
| 两边都需要独立修改且数据较小 | clone |
| 两边同时观察同一内存 | SharedArrayBuffer + Atomics/协议 |
| 数据属于 Buffer pool、所有权不清 | clone 或先复制到独占 buffer |
| 需要传递独立通信通道 | transfer MessagePort |

---

## 6. SharedArrayBuffer：共享字节，也共享竞态

SharedArrayBuffer 发送后，父子线程获得不同 wrapper，但访问同一块底层内存。它不能放入 transferList，因为所有权没有移动。

```typescript
const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
const flag = new Int32Array(shared);
worker.postMessage({ cancelFlag: shared });

Atomics.store(flag, 0, 1);
Atomics.notify(flag, 0);
```

### 6.1 为什么普通读写不够

多个线程同时访问共享内存时，普通 TypedArray 读写会面对可见性和竞态问题。Atomics API 提供原子 load/store/add/compareExchange/wait/notify 等操作，并定义跨线程内存顺序。

正确设计仍需回答：

- 一个槽位由谁写、谁读？
- 0/1/2 分别表示什么状态？
- 状态能否从 terminal 回到 running？
- payload 写完与 ready flag 之间如何建立发布顺序？
- 多个写者冲突时用 compareExchange 还是锁/队列？
- 溢出、ABA、false sharing 怎样处理？

Atomics 只保证单次原子操作和规定的内存语义，不会自动把多个字段组合成事务。

### 6.2 单向取消标志

配套案例只共享一个 `Int32`：

```text
0 = running
1 = cancellation requested（单调，永不回到 0）
```

父线程：

```typescript
Atomics.store(cancelView, 0, 1);
Atomics.notify(cancelView, 0);
```

Worker CPU 循环：

```typescript
if (Atomics.load(cancelView, 0) === 1) {
  postMessage({ kind: 'cancelled', taskId });
  return;
}
```

这是简单且可证明的单写/单向协议。若共享 ring buffer、多个 producer 或复杂状态机，设计难度会显著上升，应先考虑 MessagePort + 有界队列是否已经足够。

### 6.3 检查频率是延迟/吞吐权衡

每次循环都 Atomics.load 可增加开销；间隔太大则取消延迟上升。配套 Worker 每 16384 次操作检查一次：

```typescript
if ((processedOperations & 0x3fff) === 0) {
  // check flag
}
```

生产值应按“每个迭代成本、取消 SLO、CPU 架构和真实基准”决定，不能照抄固定数字。

---

## 7. 为什么发一条 cancel message 可能完全没用

考虑 Worker：

```typescript
parentPort.on('message', (message) => {
  if (message.kind === 'work') {
    while (true) {
      cpuStep();
    }
  }
  if (message.kind === 'cancel') {
    cancelled = true;
  }
});
```

处理 `work` 的 callback 没有返回，Worker 自己的事件循环无法调用第二个 `cancel` callback。主线程成功 `postMessage(cancel)` 只代表消息进入通道，不代表 Worker 已处理。

可选策略：

1. **SharedArrayBuffer 原子标志**：CPU 循环主动轮询；配套案例使用；
2. **分块 + yield**：每个 chunk 后 `setImmediate`/事件循环，让 cancel message 有机会处理；
3. **`worker.terminate()`**：异步请求尽快停止线程，适合作为 deadline 后的强制 fallback；
4. **原生/WASM 可中断接口**：由底层库提供取消检查。

协作取消能执行清理并发送结构化结果；terminate 可能在任意执行点停止 JS。生产策略常是：先设置共享取消位并等待短 grace period，仍不退出再 terminate/替换 Worker。

---

## 8. Worker 生命周期是资源所有权

Worker 继承 EventEmitter，关键事件包括：

- `online`：线程开始执行；
- `message`：收到 Worker 发来的值；
- `messageerror`：消息反序列化失败；
- `error`：Worker 未捕获异常，线程会终止；
- `exit`：最终事件；非零 code 表示异常/terminate 等终止。

### 8.1 不能只监听 message

```typescript
return new Promise((resolve) => {
  worker.once('message', resolve);
});
```

若 Worker 启动失败或抛异常，这个 Promise 可能永远 pending。包装器至少需要：

- 解析每条 message；
- `error` → reject；
- `messageerror` → reject；
- terminal response 前 `exit` → reject；
- settle 后移除 listener/Abort subscription；
- scope 结束 terminate/join。

### 8.2 Node 24 的 AsyncDisposable

Node Worker 实现 `Symbol.asyncDispose`，语义是 terminate Worker：

```typescript
await using worker = new Worker(url);
```

配套 client 用这个词法所有权保证正常、取消、协议错误和 throw 后不会遗留活跃线程。它不替代协议级 graceful shutdown；只是最终资源安全网。

### 8.3 `unref()` 不是 shutdown

`worker.unref()` 只允许进程在它是唯一活跃 handle 时退出，不会停止 Worker，也不会释放它占用的 CPU/内存。后台任务需要明确生命周期时仍要 cancel/close/terminate。

---

## 9. TypeScript 类型不会跨线程执行

下面的静态类型不会验证实际 message：

```typescript
type Response =
  | { kind: 'completed'; taskId: string; checksum: number }
  | { kind: 'cancelled'; taskId: string };

worker.on('message', (message: Response) => {
  // 这里只是开发者给 callback 参数写了一个未经证明的类型。
});
```

Worker、旧版本代码、测试桩或依赖都可能发出非法值。安全写法从 unknown 开始：

```typescript
worker.on('message', (raw: unknown) => {
  const result = parseWorkerResponse(raw);
  if (!result.ok) {
    failProtocol(result.issues);
    return;
  }
  handle(result.value);
});
```

### 9.1 一个可靠协议至少包含

- `kind` 判别字段；
- 唯一 `taskId`，响应必须匹配；
- 明确的 request/started/completed/cancelled/rejected 状态；
- 所有数字的整数、范围和单位验证；
- ArrayBuffer/SAB 的品牌与 byteLength 验证；
- 每个 task 恰好一个 terminal outcome；
- 未知 kind 的前向兼容策略；
- 需要长期演进时的 `protocolVersion`/capabilities；
- 错误信息脱敏与大小上限。

### 9.2 两端都应验证

主线程验证 Worker response；Worker 也验证主线程 request。不要因为两端在同一仓库就省略：

- 发布/部署可能出现版本错配；
- 测试桩和插件可能绕过静态类型；
- structured clone 会改变类/Buffer 形态；
- 类型断言和 `any` 可轻易伪造消息；
- Worker 是一个真实运行时边界。

---

## 10. 源码 `.ts`、Node type stripping 与编译产物

第 32 课故意同时验证两条路径：

```bash
# Node 24 直接读取 .ts，只剥离可擦除类型
node --test src/32-worker-threads.test.ts

# tsc 生成 .js 后再执行
npm run build
node --test dist/32-worker-threads.test.js
```

### 10.1 Node 不读取 tsconfig

直接执行 `.ts` 时，Node 不做完整 typecheck，也不读取 path alias、target、downlevel 等配置。代码必须避免需要转换的语法，如传统 enum、parameter property、namespace/部分 import alias，并显式区分 type import。

这就是为什么仍必须执行：

```bash
npm run typecheck
```

“Node 能跑”只证明语法可剥离和当前路径可加载，不证明 TypeScript 契约正确。

### 10.2 为什么 import 写 `.ts`

原生运行源码时，本地 specifier 必须指向真实源文件：

```typescript
import { parser } from './32-worker-protocol.ts';
```

但编译后文件叫 `.js`。TypeScript 的 `rewriteRelativeImportExtensions` 会把相对 import 中的 `.ts` 改写为 `.js`，从而让 dist 可运行。

### 10.3 Worker URL 还要单独处理

TypeScript 只重写 import specifier，不会分析任意字符串：

```typescript
new URL('./worker.ts', import.meta.url); // emit 后通常仍是 worker.ts 字符串
```

配套 client 按当前模块后缀选择：

```typescript
const entry = import.meta.url.endsWith('.ts')
  ? './worker.ts'
  : './worker.js';
```

库/打包项目还需确保 Worker entry 真正被复制或打包到发布产物；编辑器能解析类型不代表 npm tarball 里存在该文件。

---

## 11. 为什么生产中通常需要 Worker Pool

Node 官方明确建议重复 CPU 任务使用 pool，而不是每个任务创建 Worker。每次 spawn 包含：

- OS thread/isolate 初始化；
- Node/模块启动；
- JIT warmup；
- heap 和通信端口创建；
- 任务完成后的 terminate/回收。

对小任务，启动成本可能比计算更大。

### 11.1 Pool 的核心组件

```text
submit(task)
  → 有界等待队列
  → 调度到 idle Worker
  → pending Map<taskId, owner>
  → response runtime validation
  → resolve/reject + 清 pending
  → Worker 回 idle / 判坏替换
```

生产 pool 至少定义：

- worker 数量及与 CPU quota 的关系；
- queue capacity 和满载策略（拒绝、等待、降级）；
- 每租户公平性/优先级，防止单个 Agent 占满；
- task deadline、取消 grace period、terminate fallback；
- Worker crash 后当前任务是否重试，是否满足幂等；
- 最大连续任务数/内存阈值后的 Worker recycle；
- shutdown 时停止接单、取消队列、join active Worker；
- taskId、traceId、tenantId 的显式传播；
- metrics：queue wait、run time、clone/transfer bytes、crash/restart。

### 11.2 AsyncResource 与诊断关联

Worker 自己的异步上下文不会自动成为提交者上下文的一部分。Node 官方建议 pool 使用 AsyncResource，让异步栈和诊断工具能关联“提交任务”与“收到结果”。

这与 AsyncLocalStorage 不矛盾：

- 主线程用 AsyncResource/ALS 关联 callback；
- 跨 Worker 的 trace/tenant/auth 字段仍要作为消息数据显式传递并验证；
- Worker 内部再建立自己的 ALS scope。

---

## 12. AsyncLocalStorage、模块状态和环境不会自动共享

以下内容不要假设自动跨 Worker：

- 当前 AsyncLocalStorage store；
- 模块级 singleton 的对象状态；
- 已打开的普通 JS client 实例；
- closure 中的依赖；
- 自定义 class prototype；
- 主线程的全局变量变更。

Worker 会独立加载模块。需要的上下文应最小化为可 clone 的 plain data：

```typescript
type WorkerContext = {
  readonly traceId: string;
  readonly tenantId: string;
  readonly deadlineEpochMs: number;
  readonly capabilityIds: readonly string[];
};
```

接收端重新验证 deadline、租户与 capability，不要把“来自父线程”当作天然可信。

---

## 13. 内存与资源限制的真实边界

### 13.1 每个 isolate 有自己的 V8 heap

主线程的 `heapUsed` 不是所有 Worker heap 总和；进程 RSS 是整体口径。Node 24 可从父线程查询 Worker heap statistics/snapshot，但监控仍需区分 thread 与 process。

### 13.2 `resourceLimits` 不等于进程内存上限

Worker 构造器的 `resourceLimits` 可限制部分 V8 engine heap/code range。Node 官方明确说明这些限制不覆盖 external data，包括 ArrayBuffer。即使每个 Worker 设置 old generation 上限，仍可能通过大 Buffer/SAB 把整个进程推向 OOM。

因此还需要：

- 输入/输出 byte budget；
- transfer/clone/SAB 总量指标；
- pool queue 与 inflight 上限；
- OS/container memory limit；
- Worker crash/OOM 隔离策略；
- 大 payload 外置/流式处理。

### 13.3 transfer 降低复制，不等于降低峰值到零

发送前输入已经存在；Worker 处理时可能创建中间数组、输出和 native buffer；结果返回又可能 clone。应测量完整任务峰值，而不是只看到“使用 transfer”就断言零拷贝/零额外内存。

---

## 14. 线程安全与原生依赖

Worker 可以加载许多 Node API和 addon，但原生模块必须支持多线程/多 isolate。使用本地模型、向量库、图像库或数据库 native client 时要核查：

- addon 是否声明 worker_threads safe；
- 全局 native singleton 是否线程安全；
- 每个 Worker 是否需要独立 client/session；
- 底层库是否自己创建线程，避免 CPU oversubscription；
- terminate 时 native 操作能否安全中断；
- WASM memory 是普通、transfer 还是 shared。

如果 8 个 Worker 每个底层库再开 8 个线程，容器只有 4 CPU，吞吐可能下降而延迟剧增。并行度必须按整体线程拓扑测量。

---

## 15. Agent 场景的决策示例

### 15.1 大型工具输出解析

若 JSON.parse 本身造成明显主线程暂停，可考虑 Worker，但先问：

- 能否改成流式 parser/更小响应；
- clone 原始 string 的成本；
- parser 结果再 clone 回来的成本；
- 是否能 transfer UTF-8 ArrayBuffer；
- 输入是否含敏感信息，Worker 日志/快照如何治理。

### 15.2 代码分析工具

TypeScript Compiler API/AST 分析很适合固定 Worker pool：任务输入是文件文本/路径快照，输出是 plain diagnostics。要注意 compiler Program/cache 很大，可让每个 Worker 复用项目实例，并设置项目数量/内存上限与 recycle 策略。

### 15.3 本地 embedding/推理

瓶颈可能位于 native/WASM 库，库本身也可能多线程。先 profile，再决定 Worker 数；不要把每个 Agent run 都直接映射为一个 Worker。

### 15.4 Agent 生成代码执行

Worker 只适合受信任代码的 CPU 隔离/主线程保护。对不可信生成代码，需要独立安全边界，而不是把 `worker.terminate()` 当 sandbox。

### 15.5 压缩、crypto、文件操作

许多 Node API 已使用 libuv/native 异步实现。若再套 Worker，可能发生双重排队、线程超卖和额外 clone。只有 profiler 证明 JS glue/纯 JS 算法是瓶颈时才下放。

---

## 16. 配套案例逐层阅读

### 16.1 `32-worker-protocol.ts`

观察：

- request/response 判别联合；
- request 和 response 都从 unknown 解码；
- `ArrayBuffer` byteLength、rounds、总操作数范围验证；
- `SharedArrayBuffer` 至少容纳一个 Int32；
- taskId 关联与 structured rejection。

### 16.2 `32-worker-checksum-worker.ts`

观察：

- 代码只使用可擦除 TypeScript 语法；
- parentPort 不存在时立即失败；
- request 未验证前绝不构造 TypedArray/执行计算；
- started 之后进入同步 CPU 循环；
- 循环通过 Atomics 轮询取消，而非等待 message；
- 只有 completed/cancelled/rejected terminal response。

### 16.3 `32-worker-client.ts`

观察：

- 已取消 signal 在 transfer 前失败；
- AbortSignal 映射为共享原子位；
- `postMessage(request, [input])` 明确转移所有权；
- message/error/messageerror/exit 全部处理；
- response taskId 必须匹配；
- Abort listener 在 finally 移除；
- `await using Worker` 最终 terminate/join。

### 16.4 `32-worker-threads.test.ts`

六项测试分别证明：

1. 非法跨线程输入不会因共享 TS 类型而混入；
2. transfer 会让所有 alias view 同时 detached；
3. Worker CPU 循环可通过共享原子位取消；
4. transfer 前取消不破坏调用方输入；
5. structured clone 不保留 class 行为；
6. `markAsUntransferable` 能保护共享 backing store。

源码和 dist 都执行同一套测试，额外证明 import extension 与 Worker entry 发布路径正确。

---

## 17. 测试 Worker 的正确方法

### 必测协议

- 正常 request → exactly one completed；
- 非法 request → rejected 且不执行计算；
- response taskId 错配 → 主线程拒绝；
- 未知 kind → 协议错误而非默认分支；
- class/Buffer 等结构化 clone 形态已明确；
- transfer 后所有 alias view detached。

### 必测生命周期

- Worker 启动错误/未捕获异常会 reject；
- terminal response 前 exit 会 reject；
- 正常/异常/取消后没有活跃 Worker handle；
- Abort listener 和 pending Map 回基线；
- shutdown 会停止接单、清队列并 join；
- terminate 后不会把同一任务错误地标 completed。

### 必测并发

- queue 满时策略确定；
- 任务完成乱序仍按 taskId 关联；
- 一个 Worker crash 只影响它拥有的任务；
- 取消 queued 与 running task 的语义不同且明确；
- 多租户不能互相饥饿；
- retry 只用于可重放/幂等任务。

不要以固定 `sleep(100)` 判断 Worker“应该完成”。使用 started/ready message、共享 gate、taskId 和事件握手建立确定顺序。

---

## 18. 性能基准怎样做

Worker 是否值得使用必须测量端到端成本：

```text
submit
→ queue wait
→ clone/transfer
→ Worker scheduling/startup
→ compute
→ response clone/transfer
→ callback dispatch
```

至少比较：

- 主线程直接算；
- 每任务新 Worker；
- 预热固定 pool；
- clone ArrayBuffer；
- transfer ArrayBuffer；
- SharedArrayBuffer；
- 不同 payload 大小与计算/传输比；
- 不同 pool size 与容器 CPU quota。

记录吞吐、p50/p95/p99、主线程 event-loop delay、Worker CPU utilization、queue wait、RSS/各 isolate heap、clone/transfer byte。只比较“计算函数内部耗时”会遗漏大量真实成本。

---

## 19. 常见错误

### “Promise 很慢，换 Worker”

Promise 是调度/组合抽象，不是 CPU 执行器。先 profile 是 I/O 等待、JS CPU、native CPU、GC 还是队列拥塞。

### “有 TS interface，所以 message 安全”

interface 被擦除。callback 参数注解只是未经验证的承诺；必须从 unknown parse。

### “transfer 只是提高性能，发送方还能读”

transfer 是所有权移动，所有共享该 ArrayBuffer 的 view 都 detached。

### “给 Worker 发 cancel 就会停”

同步 CPU callback 不返回时，Worker 处理不到后续 message。使用共享原子位、分块 yield 或 terminate。

### “SharedArrayBuffer 没有复制，所以最好”

它引入共享可变状态、数据竞争和复杂内存协议。能用 transfer 的单向所有权场景通常更易证明。

### “一个请求一个 Worker 最隔离”

启动/JIT/内存成本可能远高于任务。固定 pool + 有界队列通常更合理；真正安全隔离要用进程/容器。

### “resourceLimits 防止 Worker 拖垮进程”

它主要限制 V8 engine 资源，不覆盖所有 external/ArrayBuffer，也不是 OS 安全边界。

### “unref 后就不用清理”

unref 只影响进程退出条件，线程仍在执行和占资源。

---

## 20. Java 到 Node Worker 对照

| Java 概念 | Node/TypeScript 对应与差异 |
|---|---|
| `ExecutorService` | 固定 Worker pool + 有界 task queue；需自行构建协议/关联 |
| `Future.cancel(true)` | AbortSignal + 协作标志；JS 无通用 thread interrupt 语义 |
| 共享 heap 对象 | 默认 structured clone；显式 SAB 才共享字节 |
| `volatile boolean cancelled` | SAB 中的 Int32 + `Atomics.load/store` |
| `ThreadLocal` | Worker 内部 ALS；上下文必须通过消息显式跨线程 |
| Serializable DTO | structured clone 支持的 plain data + runtime parser |
| 线程池 rejected policy | queue full 的拒绝/等待/降级策略 |
| synchronized/Lock | Atomics/共享协议；更常优先 message passing |
| JVM `-Xmx` | 每 isolate heap/resourceLimits + 进程/container 总限制；external 另算 |
| SecurityManager/进程沙箱 | Worker 不提供等价安全隔离，需 OS/容器/VM 边界 |

---

## 21. 生产检查表

### 任务选择

- profiler 是否证明是 CPU 密集 JS/WASM？
- 计算成本是否显著大于 queue/clone/transfer？
- Node/native API 是否已经并行化？
- 任务能否纯数据输入输出、可安全重放？

### 协议

- request/response 是否从 unknown 运行时验证？
- 是否有 taskId、kind、version、范围和 terminal 状态？
- clone 后 class/Buffer/Error 形态是否有契约测试？
- payload、错误和日志是否有 byte 上限与脱敏？

### 所有权

- 哪些 ArrayBuffer clone、transfer、share？
- transfer 前是否完成取消/参数验证？
- 是否审计所有 alias view 和 Buffer pool？
- Worker、MessagePort、Abort listener 是否确定性关闭？

### 并发与取消

- pool/queue 是否有界且与 CPU quota 匹配？
- running CPU task 如何看到取消？
- grace period 后是否 terminate/recycle？
- crash、退出、错配 response 是否只 settle 一次？
- shutdown 是否 join 所有 Worker？

### 观测与安全

- 是否记录 queue/compute/transfer 时间和 byte 数？
- 是否关联 traceId/tenantId，而不依赖 ALS 自动跨线程？
- 是否同时监控各 Worker heap 与进程 RSS/external？
- 是否误把 Worker 当不可信代码沙箱？
- native addon 与底层线程池是否支持多 Worker、避免超卖？

---

## 22. 建议动手实验

1. 运行 `npm run lesson:workers`，观察源码 `.ts` 的 6 项测试。
2. 运行 build 后的测试，确认 `.ts` import 已改写且 Worker URL 指向 `.js`。
3. 删除 transferList，观察发送方 view 不再 detached，并比较大输入内存/延迟。
4. 删除 Atomics 检查，只发送 cancel message，观察同步循环无法及时取消。
5. 把取消检查从每 16384 次改为每次/每百万次，测吞吐与取消延迟。
6. 故意让 Worker 发错 taskId，验证 client 协议错误而非接受结果。
7. 让 Worker throw，验证 error/exit 只 reject 一次且线程被回收。
8. 构造 2 个 view 共享一个 ArrayBuffer，transfer 一个后验证二者都 detached。
9. 比较 `Buffer.from()`、`Buffer.alloc()` 与独立 ArrayBuffer 的 transfer 行为。
10. 实现 2 Worker 的有界 pool，用可控 gate 测试乱序完成、queue full 和 crash replacement。
11. 给 pool task 加 traceId，在 Worker 内建立新的 AsyncLocalStorage scope。
12. 对 1 KB、1 MB、100 MB 输入分别比较 clone/transfer，画出传输成本曲线。

---

## 延伸阅读

- [Node.js：Worker threads](https://nodejs.org/api/worker_threads.html)
- [Node.js：AsyncResource for a Worker thread pool](https://nodejs.org/api/async_context.html#using-asyncresource-for-a-worker-thread-pool)
- [Node.js：TypeScript type stripping](https://nodejs.org/api/typescript.html)
- [TypeScript：rewriteRelativeImportExtensions](https://www.typescriptlang.org/tsconfig/rewriteRelativeImportExtensions.html)
- [ECMAScript：Shared Memory / Atomics](https://tc39.es/ecma262/multipage/structured-data.html#sec-sharedarraybuffer-objects)
- [本目录：异步运行时与结构化并发](12_async_runtime_and_structured_concurrency.md)
- [本目录：异步上下文传播](18_async_context_propagation.md)
- [本目录：事件循环与调度](21_event_loop_and_scheduling.md)
- [本目录：内存模型与泄漏诊断](24_memory_gc_and_leak_diagnostics.md)

## 一句话总结

Worker Thread 把 CPU 执行移到独立 isolate，却不会替你设计数据所有权、取消、协议或安全边界：普通数据要理解 structured clone，ArrayBuffer transfer 后发送方失去所有权，共享内存必须用 Atomics 建立可证明协议，所有消息必须从 unknown 验证，生产任务还需要有界 pool、完整生命周期和进程级资源治理。
