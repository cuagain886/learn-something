# 22 · 异常语义、Result 与生产级失败建模 ⭐⭐⭐

JavaScript 的错误机制比 Java 更开放：任何值都能被 `throw`，异步 API 还可能通过 Promise rejection、callback 首参数、EventEmitter 的 `error` 事件或 stream 错误传播失败。TypeScript 只能帮助你约束自己设计的通道，不能改变外部运行时事实。

生产级 Agent 必须回答的不只是“失败了吗”，还包括：

- 是用户取消、参数错误、限流、上游故障还是代码 bug？
- 是否安全重试？重试会不会重复扣费或重复写入？
- 哪些信息能回填给模型，哪些只能进入内部日志？
- 多个并发工具同时失败时保留哪些原因？
- 错误跨线程、进程和网络后还剩下什么类型信息？

配套实验：[`../code/src/29-error-modeling.ts`](../code/src/29-error-modeling.ts)。

---

## 1. JavaScript 可以抛出任意值

```ts
throw new Error("failed");
throw "failed";
throw { code: "FAILED" };
throw null;
```

因此在 `strict` 下，catch 变量是 `unknown`：

```ts
try {
  await legacySdk();
} catch (cause: unknown) {
  if (cause instanceof Error) {
    console.error(cause.message);
  }
}
```

`useUnknownInCatchVariables` 属于 strict 选项族。它不是麻烦人的限制，而是诚实表达边界：调用的 JS、旧库甚至自己的一段代码都可能抛非 Error。

### 归一化不能丢掉原始原因

```ts
function normalizeThrown(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(`捕获到非 Error 异常: ${safeRender(value)}`, {
    cause: value,
  });
}
```

新 Error 提供稳定的 `name/message/stack` 表面，`cause` 保留原值以便内部诊断。但 `cause` 自身仍是任意值，不能直接假定为 Error。

---

## 2. Node.js 有多种失败通道

### 同步 throw

```ts
try {
  JSON.parse(input);
} catch (cause: unknown) {
  // 当前同步调用栈内可捕获
}
```

### Promise rejection

```ts
try {
  await readFile(path);
} catch (cause: unknown) {
  // await 把 rejection 重新表现为当前 async continuation 的 throw
}
```

只写 `try { startPromise(); } catch {}` 捕获不到以后发生的 rejection，因为 Promise 没有被 await。

### error-first callback

```ts
legacyApi((error, value) => {
  if (error) return handle(error);
  use(value);
});
```

### EventEmitter 的 `error`

stream/socket 等长生命周期对象常通过 `error` 事件报告失败。没有监听器时，Node 通常会把它作为未处理错误并终止进程。

外层 `try/catch` 不能捕获以后另一个回调中 emit 的错误：调用栈早已退出。

### 为什么统一 Promise 仍不够

将 callback API promisify 可以统一“一次操作的单一成功/失败”，但 stream 表达的是一段时间内多个事件，仍需同时处理：

- data/message；
- end/close；
- error；
- abort；
- partial result。

协议形态决定错误通道，不能只靠一个通用 catch。

---

## 3. Error 对象真正提供什么

标准 Error 常见字段：

- `name`：错误类别展示名；
- `message`：面向开发者的文本；
- `cause`：原始原因，可为任意值；
- `stack`：V8/Node 提供的堆栈文本，格式不是跨运行时业务协议。

自定义错误：

```ts
class UpstreamHttpError extends Error {
  readonly code = "UPSTREAM_HTTP_ERROR";

  constructor(
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UpstreamHttpError";
  }
}
```

现代 ES target 下继承 Error 能正确工作；若发布到非常旧的 JS 目标，需要测试原型链和 `instanceof`。

### Error 属性大多不可枚举

```ts
JSON.stringify(new Error("boom")); // 常见结果："{}"
```

不要直接 JSON.stringify Error 并以为日志已经完整。应显式选择 `name/message/code/cause`，内部日志再按安全策略决定是否记录 stack。

---

## 4. `instanceof` 只适合受控进程内边界

`error instanceof CustomError` 依赖构造器对象身份。在以下场景可能失败：

- iframe/VM 等不同 realm；
- Worker/进程消息序列化；
- 网络 JSON；
- monorepo 打包出同一库的两个副本；
- SDK 返回结构化普通对象。

进程内、依赖版本受控时，`instanceof` 很方便。跨边界协议应使用验证过的判别字段：

```ts
type PublicFailure =
  | { code: "RATE_LIMITED"; retryAfterMs: number }
  | { code: "INVALID_INPUT"; issues: readonly string[] };
```

收到 JSON 后仍要验证 `code` 和字段，不能直接断言。

---

## 5. 先建立失败分类，再决定控制流

一个实用分类：

| 类别 | 示例 | 通常是否重试 | 对外暴露 |
|---|---|---|---|
| 取消 | 用户停止、deadline | 否 | 稳定取消状态 |
| 领域拒绝 | 参数非法、权限不足、余额不足 | 否，除非输入变化 | 可操作的安全说明 |
| 暂时性上游故障 | 429、503、连接重置 | 有条件 | 通用错误码/等待建议 |
| 永久上游失败 | 401、模型不存在、schema 不支持 | 通常否 | 配置类错误 |
| 资源耗尽 | 队列满、内存预算、token 预算 | 取决于策略 | 限额说明 |
| 程序缺陷 | 不变量破坏、不可达分支 | 不应盲目重试 | 通用内部错误 ID |

分类必须结合操作语义。HTTP 500 常是暂时性，但若请求会创建不可幂等资源，直接重试可能重复副作用。

### 取消优先分类

同一时刻 signal abort 和 socket error 可能竞态发生。若操作的父作用域已明确取消，通常应把结果建模为 cancelled，而不是把底层连接关闭误报为 upstream failure。

```ts
if (signal.aborted) {
  return { kind: "cancelled", reason: signal.reason };
}
```

不同 API 对 abort 可能抛 `DOMException`、signal.reason 或自己的错误。检查 signal 状态比只比较错误名字更可靠。

---

## 6. Exception 与 Result 解决不同问题

### 适合 exception 的情况

- 当前层无法恢复，必须立即中断多层调用；
- 不变量破坏或程序缺陷；
- 构造/配置错误；
- 与原生 Promise API 对接；
- 调用方自然使用 try/catch/finally。

### 适合 Result 的情况

- 失败是预期业务分支；
- 调用方必须穷尽处理不同失败；
- 批量操作需要同时保留多个结果；
- API 希望在类型上显式声明失败集合；
- Agent 工具结果要安全序列化回模型。

```ts
type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };
```

### 不要在每一层反复 Error ↔ Result

如果每个函数都 catch、包装、下一层再抛，会产生：

- 重复日志；
- 丢失堆栈；
- 错误分类漂移；
- 代码噪声；
- cause 链过深。

更好的边界：

```text
外部 SDK throw/reject
  ↓ 适配器分类一次
领域层 Result<T, DomainFailure>
  ↓ HTTP/Agent tool 边界序列化一次
公开错误协议
```

程序 bug 可以继续 throw，由最外层故障边界记录和终止当前 run。

---

## 7. 判别联合让失败处理可穷尽

```ts
type AgentFailure =
  | { kind: "cancelled"; reason: unknown }
  | { kind: "invalid_input"; issues: readonly string[] }
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "upstream_unavailable"; status: number }
  | { kind: "bug"; cause: Error };
```

```ts
function canRetry(failure: AgentFailure): boolean {
  switch (failure.kind) {
    case "rate_limited":
    case "upstream_unavailable":
      return true;
    case "cancelled":
    case "invalid_input":
    case "bug":
      return false;
  }
}
```

新增分支后，`noImplicitReturns` 或 `assertNever` 可以迫使调用方重新决策。

### 可选属性不如分支精确

```ts
// 较弱：什么组合才合法不清楚
type Failure = {
  code: string;
  retryAfterMs?: number;
  issues?: string[];
};
```

判别联合使 `retryAfterMs` 只存在于限流分支。配合 `exactOptionalPropertyTypes`，还能区分属性缺失与显式 undefined。

---

## 8. 重试是完整策略，不是 catch 后再调用一次

安全重试至少需要：

1. **错误分类**：只重试暂时性失败；
2. **幂等性**：重复调用不会造成重复副作用，或使用 idempotency key；
3. **最大尝试数**：不能无限循环；
4. **总时间预算**：单次超时与整体 deadline 都要限制；
5. **指数退避**：避免持续打击故障上游；
6. **jitter**：防止大量客户端同步重试形成惊群；
7. **Retry-After**：尊重供应商明确反馈；
8. **取消传播**：等待退避时也能取消；
9. **可观测性**：记录 attempt、原因和累计耗时；
10. **资源清理**：每次失败的 response body/stream/lease 都要释放。

### Agent 特有的幂等问题

- 模型调用可能已经计费但客户端没收到响应；
- 工具可能已经发送邮件，连接却在确认前断开；
- 数据库写入可能成功，响应序列化失败；
- 支付/工单/消息类工具具有外部副作用。

“网络失败”不等于“服务端没有执行”。对有副作用工具，必须使用业务幂等键、操作查询接口或补偿协议。

### 不重试 bug

把所有异常都重试三次，会让确定性 bug 多执行三次、污染日志并延迟真正告警。类型断言错误、`undefined` 访问、不变量破坏应快速失败。

---

## 9. `Error.cause` 保留抽象层次

```ts
try {
  await vectorStore.load(id);
} catch (cause: unknown) {
  throw new Error("读取会话记忆失败", { cause });
}
```

外层 message 回答“哪个领域操作失败”，cause 回答“底层为什么失败”。这比字符串拼接好：

- 原 Error 身份和 code 可保留；
- 内部日志可遍历链；
- 公开层可以只展示外层安全消息；
- 不必把 socket URL/凭证混入用户消息。

### cause 链也可能失控

- cause 可以是非 Error；
- 自定义对象可以构造循环引用；
- 层层无意义包装会重复同一信息；
- 深链序列化会放大日志；
- cause 中可能含 token、prompt、PII。

序列化时要做深度限制、环检测和字段白名单。

---

## 10. `AggregateError` 表达多个并列原因

顺序清理多个资源、并发执行多个工具或 `Promise.any` 全部失败时，一个 cause 链无法表达“这些失败是并列的”。

```ts
const settled = await Promise.allSettled(tasks);
const reasons = settled
  .filter((x): x is PromiseRejectedResult => x.status === "rejected")
  .map(x => x.reason);

if (reasons.length > 0) {
  throw new AggregateError(reasons, "多个工具失败");
}
```

需要先决定业务语义：

- 任一失败则整个 step 失败；
- 部分结果仍有价值；
- 取消是否覆盖其他失败；
- 对模型返回全部错误还是摘要；
- 是否允许重试其中一部分。

`AggregateError` 只是容器，不替你做策略。

---

## 11. 错误序列化是安全边界

内部错误可能包含：

- stack 中的服务器路径；
- 请求 URL 和查询参数；
- API key、Authorization header；
- 原始 prompt、用户文档；
- 数据库语句；
- SDK response body；
- Worker/系统错误细节。

不要把 `String(error)`、`stack` 或整个 SDK 对象直接回填给 LLM。模型输出可能被用户看到，也可能在下一轮 prompt 中扩大泄漏。

建议分三份表示：

```text
内部诊断事件
  errorId、完整受控 stack/cause、traceId、供应商信息

领域失败
  kind、retryable、safe details、原始 cause（仅内存）

公开/模型错误
  稳定 code、脱敏 message、必要的可操作字段
```

### 序列化函数本身也不能抛

错误路径最忌讳日志器因循环引用或 getter 抛错再次失败。序列化应：

- 只读白名单字段；
- catch 自定义属性读取错误；
- 限制字符串长度和递归深度；
- 处理循环；
- 对非 Error 安全 stringify；
- 最终有最低保真 fallback。

---

## 12. 不能把 `uncaughtException` 当恢复机制

未捕获异常意味着当前执行路径突破了预期故障边界，进程状态可能已经不可靠。全局 handler 适合：

- 最后记录同步诊断；
- 触发受控退出；
- 让进程管理器重启。

不适合 catch 后继续长期服务。资源或内存状态可能已经部分修改。

同样，未处理 Promise rejection 说明某个异步工作没有建立所有权。应找到并 await/return/显式消费 Promise，而不是只加全局监听器吞掉告警。

### fire-and-forget 需要所有者

```ts
void sendTelemetry().catch(error => telemetryFailureSink(error));
```

这里至少显式决定了失败去向。但关键业务写入不应 fire-and-forget；shutdown、重试和一致性都需要 Promise 所有权。

---

## 13. 跨 Worker、进程和网络后的 Error

Error 对象跨边界后不能依赖原构造器身份。设计 DTO：

```ts
type FailureDto = {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: unknown;
};
```

但 `details` 仍需 schema 验证和大小限制。接收端应重建自己的领域失败，而不是假装恢复了原来的 Error 实例。

需要保留诊断关联时传：

- error ID；
- trace/span ID；
- run ID / tool call ID；
- 供应商 request ID；
- 时间戳与 attempt。

不要依赖跨服务完整 stack；分布式追踪才是跨边界调用链。

---

## 14. Agent Runtime 中的两条错误通道

建议区分：

### 可回填给模型的工具失败

例如参数验证错误：

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_ARGUMENTS",
    "issues": ["values[1] 必须是 number"]
  }
}
```

模型可修正参数后再次调用。

### 终止当前 run 的基础设施失败

例如模型适配器配置无效、事件队列不变量破坏、持久化系统不可用且无法降级。它们不应伪装成某个普通工具输出让模型“自由发挥”。

边界需要明确：

- parser 抛异常是工具实现 bug，不是用户参数错误；
- execute 正常拒绝应返回领域 Result；
- signal abort 映射成 cancelled；
- 未分类异常进入内部失败，公开层只返回 error ID。

---

## 15. 与 Java 异常模型对照

| Java | TypeScript / JavaScript |
|---|---|
| 只能 throw `Throwable` | 可 throw 任意值 |
| checked exception 可进入方法签名 | 原生函数类型不跟踪 throws 集合 |
| `Throwable#getCause` | `Error.cause: unknown` |
| suppressed exceptions | 显式资源管理可产生 `SuppressedError` |
| 多异常可自定义容器 | `AggregateError` |
| classloader 边界影响类型身份 | realm、包副本、序列化都会影响 instanceof |
| Future/CompletionStage 异常 | Promise rejection |
| Thread interrupt | AbortSignal 协作取消 |

TypeScript 的 `Result<T, E>` 可以在类型层表达失败集合，类似函数式 Java 库的 Either，但调用方可以忽略返回值，所以仍需代码规范和测试。

---

## 16. 测试失败模型的最小集合

每种操作至少验证：

1. 成功；
2. 非法输入不进入副作用函数；
3. 暂时性失败按策略重试；
4. 永久失败不重试；
5. bug 不重试；
6. 退避期间取消立即停止；
7. 最后一次失败保留正确 cause；
8. 多并发失败不会丢失关键信息；
9. 错误序列化不会泄密或因循环引用崩溃；
10. 对外 code 稳定，内部错误实现可演进；
11. 幂等键在所有 retry attempt 中保持一致；
12. 部分成功策略符合领域契约。

测试应注入 fake sleep，不要真的等待退避时间。

---

## 17. 生产检查表

- catch 变量是否按 unknown 处理？
- 外部 SDK 的多种失败通道是否都被适配？
- 是否区分取消、领域拒绝、暂时失败和 bug？
- Result 与 exception 的转换边界是否清晰？
- 重试是否验证幂等性、deadline、jitter 和 Retry-After？
- 取消是否绝不被重试？
- Error cause 是否保留，又是否限制深度和敏感信息？
- AggregateError/部分成功是否有明确策略？
- 公开错误是否为稳定判别协议？
- 是否避免把 stack、prompt、token 回填模型？
- fire-and-forget Promise 是否有明确失败 sink？
- uncaughtException 是否用于受控退出而非继续服务？

---

## 18. 建议动手实验

1. 给配套 retry 加指数退避、full jitter 和总 deadline，并使用 fake clock 测试。
2. 构造一个 Error 的 cause 指向自己，验证序列化输出 `cycle`。
3. 让 sleep 期间 abort，证明 operation 不会开始下一 attempt。
4. 给写操作加入 idempotency key，断言多次 attempt 使用同一 key。
5. 模拟两个工具一成功一失败，实现 fail-fast 与 partial-success 两种策略。
6. 把自定义 Error 通过 Worker MessagePort 发送，观察 `instanceof` 与自定义字段。
7. 为模型可见错误建立 schema，故意把 stack 加进去，让测试阻止泄漏。

## 延伸阅读

- [Node.js：Errors](https://nodejs.org/api/errors.html)
- [TypeScript 4.4：`useUnknownInCatchVariables`](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-4.html#defaulting-to-the-unknown-type-in-catch-variables)
- [ECMAScript：Error Objects](https://tc39.es/ecma262/multipage/fundamental-objects.html#error-objects)
- [Node.js：Process events](https://nodejs.org/api/process.html#process_event_uncaughtexception)

