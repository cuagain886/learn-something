# 18 · AsyncLocalStorage：异步因果链与上下文传播 ⭐⭐⭐

> Agent 的日志、trace、租户和预算上下文必须跟随异步调用链，但不应污染每个业务函数签名。AsyncLocalStorage 提供进程内的异步局部存储。

配套实验：[第 25 课异步上下文](../code/src/25-async-context.ts)。

---

## 1. 为什么普通全局变量必然串线

```typescript
let currentRunId: string | undefined;

async function handle(runId: string) {
  currentRunId = runId;
  await callModel();
  log(currentRunId);
}

await Promise.all([handle('A'), handle('B')]);
```

两个调用在 await 处交错，共享变量最终取决于调度顺序。Java 里的 ThreadLocal 直觉也不能直接搬过来：多个 JS 请求通常运行在同一个事件循环线程上，异步 continuation 不是固定占用一个 OS 线程。

AsyncLocalStorage 不是按线程隔离，而是沿 Node 追踪的异步资源/执行上下文传播 store。

---

## 2. 心智模型：异步资源形成因果树

```text
runContext.run(storeA)
  ├─ Promise continuation
  ├─ timer callback
  ├─ fetch/socket callback
  └─ nested tool context

runContext.run(storeB)
  ├─ another Promise continuation
  └─ another timer callback
```

当 Promise、timer、I/O 等资源在某个上下文内创建时，Node 的 async_hooks 基础设施能把当前 store 与后续回调关联。执行回调时，`getStore()` 返回对应上下文；回调结束后恢复先前上下文。

这是一种动态作用域效果，但传播依据是异步因果关系，不是源码词法嵌套本身。

---

## 3. `run(store, callback)` 是首选作用域

```typescript
const storage = new AsyncLocalStorage<RunContext>();

await storage.run({ runId: 'run_1' }, async () => {
  await callModel();
  storage.getStore(); // run_1
});

storage.getStore(); // 恢复外层值，通常 undefined
```

run 的关键语义：

1. 同步进入 store。
2. 调用 callback。
3. callback 创建的异步资源继承上下文。
4. 同步 callback 返回后立即恢复调用前上下文；异步 continuation 仍保留自己的关联。

因此顶层 HTTP/queue handler 应在最外层用 run 建立 context，而不是在深层函数发现缺失时临时补。

---

## 4. `enterWith` 为什么更危险

`enterWith(store)` 会替换当前同步执行剩余部分的上下文，并让后续异步操作继承。它没有 callback 边界自动恢复：

```typescript
emitter.on('event', () => storage.enterWith(store));
emitter.on('event', () => {
  // 同一次 emit 的后续 listener 也可能看到 store
});
```

官方建议通常优先 run。enterWith 适合确实需要改变当前执行上下文、并能严格控制边界的底层框架。业务代码随意使用会产生难以定位的上下文泄漏。

---

## 5. Store 是对象引用，不是不可变快照

```typescript
type Context = { runId: string; step: number };
```

AsyncLocalStorage 保存的仍是普通对象引用。若两个并发子任务共享 store 并原地修改 `step`，它们会互相影响：

```typescript
const store = storage.getStore()!;
store.step += 1; // 危险共享突变
```

推荐把 store 设计成只读小对象，嵌套上下文创建新值：

```typescript
const parent = requireContext();
return storage.run(
  { ...parent, step: parent.step + 1, toolCallId },
  executeTool,
);
```

这不是深不可变保证；不要把可变 Map、完整 transcript 或巨型请求对象塞进 context。

---

## 6. `getStore()` 返回 undefined 是正常边界

调用可能发生在：

- 应用启动阶段。
- Run 作用域外。
- 第三方库丢失上下文。
- Worker/子进程。
- 保存后在别处裸调用的回调。

底层日志函数可以选择：

```typescript
function requireContext(): RunContext {
  const value = storage.getStore();
  if (!value) throw new Error('missing run context');
  return value;
}
```

或降级为无上下文日志。安全关键操作不应把缺失 tenant/principal 静默解释为默认租户；应显式失败。

---

## 7. 创建函数对象不会自动绑定当前上下文

```typescript
let callback: () => void;

storage.run(context, () => {
  callback = () => log(storage.getStore());
});

callback(); // 在调用点上下文执行，可能 undefined
```

函数闭包捕获词法变量，但 AsyncLocalStorage store 不是普通词法变量。调用者以后在哪个执行上下文调用，`getStore()` 就观察哪个上下文。

这一区别解释了为什么“回调在 run 内创建”不等于“回调永远属于该 run”。

---

## 8. `AsyncLocalStorage.bind`

```typescript
const bound = storage.run(context, () =>
  AsyncLocalStorage.bind(() => storage.getStore()),
);

bound(); // 恢复创建 bind 时捕获的执行上下文
```

bind 适合：

- 把 callback 交给不理解 async context 的旧 API。
- EventEmitter listener 需要使用注册时上下文。
- 插件稍后同步回调宿主。

不要对所有函数无脑 bind：捕获错误上下文会让回调永久冒充旧 Run，并延长上下文中对象的生命周期。

---

## 9. `AsyncLocalStorage.snapshot`

snapshot 返回一个“在捕获上下文中运行任意函数”的恢复器：

```typescript
const runCaptured = storage.run(context, () => AsyncLocalStorage.snapshot());

runCaptured(() => storage.getStore());
```

它适合类实例在构造时捕获环境，之后多个方法都需要恢复，而不想逐个 bind。snapshot 捕获的是当前整体异步执行上下文，可覆盖多个 AsyncLocalStorage 实例；这也意味着要谨慎控制捕获时机。

简单上下文恢复可用 bind/snapshot；需要自定义异步资源生命周期、before/after hooks 或与原生回调桥接时，才考虑 AsyncResource。

---

## 10. EventEmitter 使用 emit 时上下文

EventEmitter 普通 listener 是同步调用：

```typescript
storage.run(registrationContext, () => {
  emitter.on('event', listener);
});

emitter.emit('event');
```

listener 默认运行在 emit 调用点当前上下文，不是 on 注册时上下文。若业务要求订阅者永久属于注册 Run，要 bind listener；若事件代表 emit 所在请求，默认行为可能正合适。

先定义事件的所有权语义，再决定是否绑定。错误绑定会导致一个全局 listener 永远携带首次请求的用户身份。

---

## 11. 哪些异步操作通常能传播

Node 内建 Promise、timer、网络和多数基于 async_hooks 的 API 一般能传播。仍可能丢失的场景：

- 自定义 callback 池在上下文外调用。
- 原生扩展没有正确使用 AsyncResource。
- 某些 thenable/任务调度器自己管理队列。
- EventEmitter 如上使用 emit 时上下文。
- 回调被序列化或跨线程传输。

出现丢失时先构造最小复现；可用 AsyncResource、bind/snapshot 修补明确边界。不要在业务深层到处 `enterWith` 掩盖根因。

---

## 12. 不跨越 Worker、进程和网络

AsyncLocalStorage 是当前 Node isolate/进程中的机制。以下边界必须显式序列化：

```text
Worker message
child_process IPC
HTTP/gRPC/queue
数据库 job
持久化后恢复的 Agent Run
```

只传播允许跨信任边界的字段：trace id、run id、tenant id 等。不要把整个 store JSON.stringify；里面可能包含 principal 对象、AbortSignal、logger 和秘密。

接收端验证 header/message 后，用自己的 storage.run 建立新本地上下文。

---

## 13. AsyncLocalStorage 与 OpenTelemetry

Tracing SDK 常使用异步上下文管理 active span。业务自己的 RunContext 与 trace context 可以：

- 合并在一个 store。
- 使用不同 AsyncLocalStorage，由 snapshot 同时捕获。
- 让日志函数分别读取业务 context 与 tracing API。

不要自己重新实现 W3C trace propagation。进程内上下文与跨服务 trace header 是两层：ALS 负责本地 continuation，propagator 负责网络边界。

---

## 14. Agent 场景的 Context 设计

```typescript
type AgentContext = {
  readonly runId: string;
  readonly step: number;
  readonly toolCallId?: string;
  readonly tenantId: string;
  readonly deadline: number;
};
```

适合放：

- 小型稳定标识。
- 观测关联字段。
- 可信租户/主体引用或 ID。
- deadline 等只读策略。

不适合放：

- 可变 transcript。
- 大模型响应。
- 数据库连接等需要显式所有权的资源。
- 作为取消唯一来源的 Controller 写能力。
- 用于业务逻辑的隐式可变参数。

依赖 context 过多会让函数签名看似纯净但实际有隐藏输入。领域核心函数仍应显式接收影响结果的业务参数；ALS 更适合横切关注点。

---

## 15. 安全陷阱

- 上下文缺失时使用“默认管理员”。
- 把模型生成的 userId 写进可信 store。
- 复用可变 store 导致租户字段被子任务修改。
- bind 长期全局回调，永久捕获请求 principal。
- 日志自动展开整个 store，泄漏 token/提示词。
- 把 ALS 当授权机制；真正授权仍需在工具执行点校验。

Context 只是数据传播机制，不提供真实性、权限或隔离沙箱。

---

## 16. 生命周期与性能

每个异步资源都可能关联上下文；store 引用的对象至少会活到相关异步链结束。实践建议：

- store 保持小而只读。
- 长生命周期 timer/listener 不捕获请求上下文，或结束时清理。
- 不在热路径创建不必要的嵌套 run。
- 用压测测量，而不是因为担心开销就退回全局变量。
- 只有确定不再使用某个 AsyncLocalStorage 实例时才考虑 disable；不要在活跃 Run 中全局禁用。

日志关联带来的诊断收益通常远大于少量上下文跟踪开销，但高吞吐系统仍应实测。

---

## 17. 测试清单

- 两个并发 Run 的 runId 不串线。
- 嵌套 tool context 结束后恢复父 step。
- timer、Promise、I/O callback 保留上下文。
- 上下文外 getStore 为 undefined。
- 普通保存回调与 bind 回调行为符合预期。
- EventEmitter 注册/emit 上下文语义明确。
- parent Run 结束后 listener/timer 不继续持有 store。
- Worker/IPC 边界显式传递最小字段并重新验证。
- 缺失 principal 时安全失败。

---

## 一句话总结

AsyncLocalStorage 让上下文沿进程内异步因果链传播，而不是绑定 OS 线程或函数创建位置。正确使用 run 建立边界、只读小 store 表达嵌套、bind/snapshot 修补明确回调边界，并在 Worker/网络处显式序列化，才能避免并发串线和隐式安全漏洞。

