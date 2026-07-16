# 06｜Deadline、取消、重试与幂等：超时之后，操作究竟执行了几次

> Deadline 只规定调用方何时停止等待，取消只表达调用方不再需要结果，重试会创建新的 attempt；三者都不能自动撤销服务端已经发生的副作用。要把“结果未知”收敛成确定结果，必须让 operation identity、幂等记录和业务事务进入同一个一致性边界。

## 1. 本章不是参数说明，而是三套状态机

这一章要同时追踪三个彼此相关、但绝不能混为一谈的状态机：

```text
Call 生命周期
  pending → attempt 1 → backoff → attempt 2 → final result

单次 Attempt 生命周期
  未离开客户端 → server transport → handler → side effect → response

业务 Operation 生命周期
  absent → executing → committed / failed
```

最危险的错误是拿其中一套状态推断另一套状态：

```text
client 收到 DEADLINE_EXCEEDED
≠ server handler 没运行
≠ 数据库事务没提交
≠ cancel 已被 server 处理
≠ 下一次 retry 一定安全
```

本章最终要建立的判断式是：

```text
可安全自动重试
  = failure 被策略允许
  ∧ call deadline 仍有预算
  ∧ attempt 未越过 gRPC retry commit point
  ∧ 请求可被完整重放
  ∧ 业务操作允许重复执行或具备可靠去重
  ∧ retry budget / server pushback 允许
```

少任意一项，都不能只凭一个 `UNAVAILABLE` 就决定重试。

---

## 2. Call、Attempt 与 Operation

### 2.1 Call

Call 是应用看到的一次逻辑 RPC：

```text
result = client.CreateOrder(request)
```

它有一个总体 deadline，最终只向应用返回一次结果。

### 2.2 Attempt

Attempt 是该 call 在 transport 上的一次具体尝试：

```text
attempt 1 → HTTP/2 stream 1 → backend A
attempt 2 → HTTP/2 stream 3 → backend B
attempt 3 → HTTP/2 stream 5 → backend A
```

retry 是前一次结束后创建新 attempt；hedging 可以让多个 attempt 同时存在。

### 2.3 Operation

Operation 是业务系统要完成的状态变更，例如：

```text
创建订单 order_id=O1001
从账户 A 扣款 100 元
发送事件 payment_succeeded
```

多个 attempt 可能指向同一个 operation，也可能因为没有稳定 identity 而错误地创建多个 operation。

### 2.4 三种 ID 不应混用

| 标识 | 生命周期 | 用途 |
|---|---|---|
| trace ID | 一条分布式追踪 | 关联整条调用链 |
| call/attempt ID | 一次 call 或 transport attempt | 可观测、诊断重试 |
| idempotency key / operation ID | 一个业务操作 | 去重、查询最终结果 |

trace ID 可能因采样或跨系统传播而变化；attempt ID 每次重试本来就应不同。它们通常不能替代稳定的业务幂等键。

---

## 3. Deadline 与 Timeout 的数学关系

Timeout 是一段持续时间：

```text
timeout = 800 ms
```

Deadline 是绝对时间点：

```text
deadline = start_time + timeout
```

客户端本地通常维护绝对 deadline，以便所有排队、解析、连接、attempt 和 backoff 共用同一个终点：

```text
remaining(t) = deadline - now(t)
```

每次要做新动作时先判断：

```text
if remaining <= 0:
    fail DEADLINE_EXCEEDED
```

为什么内部更适合用单调时钟计算 elapsed time：系统墙上时钟可能因 NTP 校正或人工修改跳变；单调时钟更适合测持续时间。线上 wire protocol 传递的则是相对 timeout，而不是要求两台机器共享同一个绝对时钟。

---

## 4. `grpc-timeout` 如何编码剩余预算

gRPC over HTTP/2 使用 request header：

```text
grpc-timeout: TimeoutValue TimeoutUnit
```

`TimeoutValue` 是最多 8 位正整数，unit 为：

| unit | 含义 |
|---|---|
| `H` | hour |
| `M` | minute |
| `S` | second |
| `m` | millisecond |
| `u` | microsecond |
| `n` | nanosecond |

例如：

```text
grpc-timeout: 1500m
```

表示该 hop 收到的相对 timeout 大致为 1500 ms。

当 A 调 B，再由 B 调 C 时，不应把原始 1500 ms 原样复制：

```text
A→B: 1500 ms
B 本地排队和计算: 430 ms
B→C: 约 1070 ms，而不是重新获得 1500 ms
```

gRPC 实现传播 deadline 时，会换算为扣除已消耗时间后的相对 timeout，从而减少跨机器 wall clock skew 的影响。

### 4.1 精度与取整

wire value 只有整数和有限 unit。将剩余预算编码时需要取整。实现通常必须避免因向下取整让远端比本地更早超时，因此可能选择能表示该 duration 的单位并向上取整。

重要的不变量是：

```text
child budget 不应比 parent 的真实剩余预算更宽松
```

即使编码取整带来极小误差，本地 parent deadline 仍会在最终边界取消整条工作。

---

## 5. Deadline 预算必须覆盖完整路径

一次 call 的预算不只属于 server handler：

```text
T_total =
  T_client_queue
  + T_name_resolution
  + T_load_balancer_pick
  + T_connect_or_wait_ready
  + Σ(T_attempt_send + T_server_queue + T_handler + T_response)
  + Σ(T_backoff)
```

因此看到：

```text
server handler p99 = 80 ms
client deadline = 100 ms
```

不能断言预算合理。连接排队、网络、代理和反序列化可能已经消耗 40 ms。

### 5.1 分层预算

假设入口剩余 1000 ms，服务 A 需要并行调用 B、C：

```text
保留响应序列化与网络余量: 100 ms
A 自身逻辑:              150 ms
下游预算池:              750 ms
```

并行分支不一定要把 750 ms 相加切分，因为它们同时运行；但每个 child deadline 都不得晚于 parent deadline：

```text
child_deadline = min(parent_deadline, local_cap)
```

串行链路则必须显式考虑前序步骤消耗。

### 5.2 最小可用预算

如果下游历史上至少需要 40 ms，而剩余只有 5 ms，发出请求通常只会浪费资源：

```text
if remaining < min_useful_budget:
    fail fast
```

但 `min_useful_budget` 应来自测量，并区分缓存命中、连接复用和降级路径，不能凭感觉写死。

---

## 6. Deadline 到期的客户端与服务端视角不同

假设 t=0 发起调用，deadline=100 ms：

```text
t=0    client send request
t=20   server handler starts
t=90   database COMMIT succeeds
t=100  client deadline expires
t=110  server sends OK response
t=120  response would reach client
```

客户端结果：

```text
DEADLINE_EXCEEDED
```

业务事实：

```text
database 已提交
```

这不是实现 bug，而是分布式通信中“结果与结果通知”分离的必然情况。

gRPC 对 `DEADLINE_EXCEEDED` 的定义也明确允许：改变系统状态的操作可能已经成功，只是响应未及时到达。

因此超时后的正确问题不是：

```text
“调用失败了吗？”
```

而是：

```text
“客户端没有在预算内得到确定结果；operation 当前状态是什么？”
```

---

## 7. 结果未知的五个时间窗口

考虑一次有副作用的 unary RPC：

```text
client → proxy → server → database
```

### 窗口 A：请求未离开客户端

例如 load balancer 尚未选出 transport。此时安全重试，因为 server 不可能执行。

### 窗口 B：请求在网络或 server transport

server application 尚未看到请求。若 transport 能证明这一点，例如 `REFUSED_STREAM` 或 GOAWAY 的 `last-stream-id` 排除该 stream，可透明重试。

### 窗口 C：handler 已开始，副作用前失败

服务端知道尚未提交，但客户端通常无法仅凭连接断开证明。若 server 返回明确、可信的可重试状态，可以按契约重试。

### 窗口 D：副作用已提交，响应未发送或丢失

这是最典型的结果未知：客户端重试可能重复扣款、发券或创建订单。

### 窗口 E：客户端已收到成功，但本地处理失败

例如 client 收到 OK 后进程崩溃，业务上可能再次发起同一操作。幂等能力不能只服务 transport retry，还要覆盖上层工作流重放。

这五个窗口说明：安全性不是由错误码单独决定，而是由“是否执行过”和“是否能证明”决定。

---

## 8. Cancellation 是协作信号，不是强制中断

客户端取消通常表达：

```text
“我不再需要这次 RPC 的结果，请停止无用工作。”
```

在 HTTP/2 上，取消单条调用通常通过 `RST_STREAM(CANCEL)` 终止 stream。server transport 收到后会标记 call cancelled，并通知上层 context/cancellation token。

但 gRPC runtime 一般无法安全地异步杀死任意 application handler：

- handler 可能正持有锁；
- 可能正执行数据库调用；
- 可能在不可中断的外部 API 中；
- 强杀可能破坏进程内不变量。

所以 handler 必须协作检查取消：

```text
loop:
  if context.cancelled():
      cleanup()
      return
  do_bounded_piece_of_work()
```

### 8.1 取消延迟

从 client 决定取消到 handler 停止，存在：

```text
transport propagation
+ event-loop scheduling
+ handler check interval
+ downstream cancellation propagation
+ cleanup latency
```

如果 handler 每 30 秒才检查一次 token，那么 100 ms deadline 仍可能产生接近 30 秒的无用计算。

---

## 9. Cancellation 不等于事务回滚

考虑：

```text
BEGIN
UPDATE accounts SET balance = balance - 100
COMMIT
check cancellation
```

如果 cancel 在 COMMIT 后到达：

```text
客户端不再等结果
数据库修改仍然成立
```

即使 cancel 在 COMMIT 前到达，handler 也可能没及时观察到。

正确设计需要明确不可逆点：

```text
before commit:
  cancellation 可以阻止副作用

at/after commit:
  cancellation 只能停止后续无用工作
  不能假装 operation 未发生
```

若业务需要撤销，必须实现业务补偿：

```text
扣款 committed
→ 发起 refund operation
```

补偿本身也是新的分布式操作，需要自己的幂等键和状态机。

---

## 10. 取消传播必须沿调用树向下

服务 A 处理入口 RPC 时调用 B 和 C：

```text
client
  └─ A
      ├─ B
      └─ C
          └─ D
```

入口取消后，理想传播：

```text
client cancel
→ A context cancelled
→ A cancels B/C
→ C cancels D
```

如果 A 为下游调用创建了脱离 parent 的新 context：

```text
background_context + fresh timeout
```

那么入口早已超时，B/C/D 仍可能继续消耗资源并提交副作用。

规则应是：

```text
child context 继承 parent cancellation
child deadline = min(parent remaining, local policy cap)
```

只有明确的异步工作才应脱离请求生命周期；这时需要持久化 job identity、队列和独立状态查询，而不是偷偷忽略 cancellation。

---

## 11. Retry 是创建新 Attempt，不是恢复旧 Stream

第一次 attempt 失败后，gRPC retry 会：

1. 保留可重放的调用历史；
2. 等待 backoff 或 server pushback；
3. 再次经过 load balancing；
4. 在某条 transport 上创建新的 HTTP/2 stream；
5. 重放 request metadata 和 message；
6. 让多个 attempt 汇聚成一个 call 结果。

```text
logical call
  ├─ attempt 1 → backend A → UNAVAILABLE
  └─ attempt 2 → backend B → OK
```

这意味着 server B 默认不知道 A 是否已经产生副作用，除非请求携带同一个 operation identity，并且所有 backend 共享一致的去重存储。

---

## 12. gRPC Retry 的 Commit Point

这里的 committed 是 gRPC 客户端重试状态，不是数据库事务提交。

根据 gRPC retry design，RPC 在两类情况下进入 committed：

1. client 收到 response headers；
2. outbound message history 超出客户端 retry buffer，无法完整重放。

进入 committed 后：

```text
选择当前 attempt 继续
不再创建后续 retry attempt
即使随后收到 retryable status，也不再自动重试
```

### 12.1 为什么 response headers 会 commit

initial metadata 可能已经交给 client application，应用可据此改变状态。再偷偷换 attempt 可能造成 metadata 和 response 来自不同 server，破坏单次调用语义。

server 若想让错误保持可重试，通常应在还未发送 response headers/message 时用 trailers-only 返回错误。

这里的 `Response-Headers` 是 gRPC 语法中的初始响应 metadata，不是泛指任何 HTTP/2 `HEADERS` frame。Trailers-only 在线路上同样由带 `END_STREAM` 的 HEADERS 承载，但在 gRPC 语义上它直接携带最终 status，没有先向应用交付一组初始 metadata；因此一个 retryable trailers-only status 仍可触发策略重试。

### 12.2 为什么 buffer overflow 会 commit

client-streaming 或 bidi-streaming 的完整 outbound history 可能很大。一旦旧 message 不再可重放，新 attempt 就无法构造与旧 attempt 等价的输入序列。

所以：

```text
streaming RPC 理论上配置了 retry
≠ 任意时刻都能 retry
```

### 12.3 两种 commit 不能互相推导

```text
gRPC retry committed
≠ server business committed

server business committed
≠ client 已看到 response headers
```

这是本章最重要的术语隔离。

---

## 13. Transparent Retry 的证明边界

即使没有显式 retry policy，gRPC 也可能做透明重试。

典型分类：

1. RPC 未离开客户端：可重复尝试直到成功或 deadline 到期；
2. 到达 server library，但 application handler 未看到：立即透明重试一次；
3. handler 已看到：需要显式 retry policy，且业务必须允许。

HTTP/2 提供两类有价值的证明：

```text
RST_STREAM(REFUSED_STREAM)
→ server 拒绝该 stream，application 未处理

GOAWAY last-stream-id < current stream-id
→ 该 stream 未被 server 接受处理
```

这类 transport 证据比“连接断了”强得多。

普通 TCP reset 只说明连接终止，不能告诉 client handler 是否已经执行到 COMMIT。

透明 retry 不计入 configured `maxAttempts`，因为它被设计为只覆盖 server application 未执行的场景；具体语言实现仍应以版本文档和测试为准。

---

## 14. Retry Policy 的字段与精确语义

典型 Service Config：

```json
{
  "methodConfig": [{
    "name": [{
      "service": "payment.v1.PaymentService",
      "method": "Charge"
    }],
    "timeout": "2s",
    "retryPolicy": {
      "maxAttempts": 4,
      "initialBackoff": "0.1s",
      "maxBackoff": "1s",
      "backoffMultiplier": 2,
      "retryableStatusCodes": ["UNAVAILABLE"]
    }
  }]
}
```

字段含义：

```text
maxAttempts
  原始 attempt + retry attempts 的总上限
  4 表示最多 1 次原始 + 3 次重试

initialBackoff
  第一次 configured retry 前的基础等待

maxBackoff
  backoff 上限

backoffMultiplier
  每轮指数增长因子

retryableStatusCodes
  哪些最终 status 允许触发 configured retry
```

设计规范要求 `maxAttempts >= 2`，默认客户端上限为 5；上限可由实现的 channel 参数调整。不要假设所有语言和版本都开放相同配置入口。

整个 call 共享同一个 deadline，`maxAttempts=4` 不会获得四份 timeout。

---

## 15. 指数退避与 Jitter 的手算

基础公式：

```text
base_n = min(
  initialBackoff × backoffMultiplier^(n-1),
  maxBackoff
)
```

gRPC retry design 对 delay 使用约 ±20% jitter：

```text
delay_n = base_n × random(0.8, 1.2)
```

配置：

```text
initial = 100 ms
multiplier = 2
max = 1000 ms
```

则各次 retry 前：

| retry | base | jitter range |
|---|---:|---:|
| 1 | 100 ms | 80–120 ms |
| 2 | 200 ms | 160–240 ms |
| 3 | 400 ms | 320–480 ms |
| 4 | 800 ms | 640–960 ms |
| 5 | 1000 ms | 800–1200 ms |

Jitter 的目的不是让单请求更快，而是打散大量 client 同时失败后的同步重试波峰。

没有 jitter：

```text
t=0 outage
t=100ms  全部 retry
t=300ms  全部 retry
t=700ms  全部 retry
```

有 jitter：请求分散在时间窗口中，降低恢复期再次压垮 server 的概率。

---

## 16. Deadline 如何截断 Retry

假设：

```text
call deadline = 500 ms
attempt 1     = 180 ms → UNAVAILABLE
backoff 1     = 100 ms
attempt 2     = 170 ms → UNAVAILABLE
```

此时累计：

```text
180 + 100 + 170 = 450 ms
remaining = 50 ms
```

即使 `maxAttempts` 还允许 attempt 3，若下一次 backoff 或最小可用 attempt 时间超过 50 ms，client 不应假装还有完整机会。

最终可能得到：

```text
DEADLINE_EXCEEDED
```

而不是最后一个 `UNAVAILABLE`。不同语言在边界竞态中呈现的最终 status 细节可能不同，诊断时必须查看 attempt timeline，而不是只看 call final code。

### 16.1 错误的 per-attempt timeout

```text
for attempt in 1..4:
    call(timeout=500ms)
```

这会把用户 500 ms 的等待意图扩张到接近 2 秒加 backoff。

正确模式：

```text
overall_deadline = now + 500ms
each attempt uses remaining(overall_deadline)
```

可以设置更短的 per-attempt cap，但必须：

```text
attempt_deadline = min(overall_deadline, now + per_attempt_cap)
```

---

## 17. 哪些 Status 可以重试

错误码提供策略信号，但不能独自证明业务安全。

### `UNAVAILABLE`

通常表示瞬时不可用，适合配合 backoff 重试；官方同时明确提醒：非幂等操作不一定安全。

### `RESOURCE_EXHAUSTED`

可能是暂时过载，也可能是永久 quota/磁盘限制。没有 server pushback 或明确错误细节时，盲目重试可能加剧过载。

### `ABORTED`

常用于并发冲突。通常应在更高层重新执行整个 read-modify-write，而不是只重放最后一次写 RPC。

### `FAILED_PRECONDITION`

系统状态改变前不应重试。例如目录非空；重复同一请求不会改变条件。

### `DEADLINE_EXCEEDED`

表示结果可能已发生但未及时返回。有副作用方法不能仅因该 code 自动重试。

### `INTERNAL` / `UNKNOWN`

范围太宽，可能代表服务端 bug、协议损坏或未知异常。把它们全局列为 retryable 容易隐藏故障并重复副作用。

### `INVALID_ARGUMENT` / `UNAUTHENTICATED` / `PERMISSION_DENIED` / `UNIMPLEMENTED`

原请求不变时通常不会因重试恢复；应修正输入、凭证、授权或版本。

结论：

```text
retryable transport/application status
AND idempotent operation contract
AND remaining budget
```

三者必须同时成立。

---

## 18. Server Pushback 与 Retry Throttling

### 18.1 Pushback

server 可返回 metadata：

```text
grpc-retry-pushback-ms: 750
```

表示下一次 retry 精确等待 750 ms。负数或无法解析的值表示不要再 retry。

pushback 的作用是让 server 把当前恢复能力反馈给 client，而不是让所有 client 只依据本地指数退避猜测。

收到正 pushback 后，后续没有新 pushback 的 retry backoff 会从 `initialBackoff` 重新开始计数。

### 18.2 Retry throttling token

Service Config 可定义：

```json
"retryThrottling": {
  "maxTokens": 10,
  "tokenRatio": 0.1
}
```

client 对 server name 维护 token count：

```text
初始: 10
qualified failure: -1
success: +0.1，最多恢复到 10
```

当 token 低于或等于阈值 `maxTokens/2`，configured retries/后续 hedge 会被抑制。

它是 client 侧基于近期成功率的熔断式反馈，目标是避免 server 越失败、client 越加压。

它不能替代全局 retry budget，因为每个 client 看到的局部样本和实例数量不同。

---

## 19. Retry Amplification：一层重试如何变成指数负载

调用链：

```text
A → B → C → D
```

每层最多 3 attempts。最坏情况下，D 看到：

```text
3 × 3 × 3 = 27 attempts
```

若 A 自己也被上游重试，可能进一步放大。

设每层 fan-out/retry multiplier 为 `r_i`：

```text
downstream_attempts <= ∏ r_i
```

这还没计算 hedging、消息队列重投和人工重放。

### 19.1 Retry budget

可把额外 attempts 限制为正常请求量的一小部分：

```text
allowed_extra_attempts
  <= base_requests × retry_ratio + burst_credit
```

例如每分钟 10,000 个原始 call，retry ratio=5%，额外 attempts 预算约 500，加有限 burst。

预算耗尽时宁可快速失败或降级，也不要在故障中制造无限自激负载。

### 19.2 重试应尽量集中在一层

底层 gRPC retry 擅长处理明确 transport failure；上层工作流 retry 擅长重建完整业务上下文。不要两层都在未知情况下自动重试同一个非幂等 operation。

---

## 20. Hedging：失败发生前就启动副本

Retry 通常等待 attempt 失败后再发下一次；hedging 在首个 attempt 仍运行时，延迟一段时间启动副本：

```text
t=0ms    attempt 1 → backend A
t=80ms   attempt 2 → backend B
t=120ms  attempt 2 returns OK
t=121ms  cancel attempt 1
```

它用额外负载交换更低尾延迟。

配置示例：

```json
"hedgingPolicy": {
  "maxAttempts": 3,
  "hedgingDelay": "0.08s",
  "nonFatalStatusCodes": ["UNAVAILABLE"]
}
```

`maxAttempts` 同样包含原始 attempt。整个 hedge chain 共用 call deadline。

### 20.1 为什么 cancel loser 不足以保证安全

winner 返回后 client 会 cancel 其他 attempt，但 loser 可能已经：

- 进入 handler；
- 写入数据库；
- 提交事务；
- 发布消息。

因此 hedging 对有副作用方法的要求比串行 retry 更严格：多个 attempt 被设计为并发执行，不能依赖“第二个开始前第一个一定没提交”。

### 20.2 适合 hedging 的操作

- 纯读取；
- 强幂等查询；
- 使用全局 operation ID 且所有 backend 共享线性一致去重；
- 可以安全取消或接受重复计算；
- 尾延迟高且 backend 有余量。

### 20.3 不适合

- 扣款、发券、发送不可撤回通知；
- backend 去重只存在单机内存；
- 请求本身很大；
- server 已过载；
- 多副本会竞争同一锁或数据库热点。

---

## 21. 幂等的四个层次

### 21.1 数学幂等

操作 `f` 满足：

```text
f(f(x)) = f(x)
```

例如设置状态：

```text
SET order.status = 'CANCELLED'
```

但真实系统还会写审计、发事件、计费；主表最终值相同不代表所有副作用幂等。

### 21.2 API 语义幂等

同一逻辑请求重复提交，服务保证得到等价业务结果：

```text
CreateOrder(operation_id=K, payload=P)
```

### 21.3 实现幂等

server 使用 durable record、unique constraint 或事务把重复 attempt 收敛到同一个 operation。

### 21.4 端到端幂等

数据库、事件发布、下游调用和外部支付都不会因 replay 产生额外副作用。

很多系统只做到了主表 unique，却在 outbox、短信或支付网关处重复，这不算端到端幂等。

---

## 22. Idempotency Key 的契约

请求：

```protobuf
message ChargeRequest {
  string operation_id = 1;
  string account_id = 2;
  int64 amount_minor = 3;
  string currency = 4;
}
```

可靠契约至少包含：

1. key 由谁生成；
2. key 的作用域，例如 tenant + method + operation_id；
3. 相同 key 是否必须携带相同 payload；
4. 记录保存多久；
5. executing 状态的重复请求如何响应；
6. completed 状态是否重放原始 response；
7. 失败分为可重试失败还是永久失败；
8. key 过期后再来如何处理。

### 22.1 Payload fingerprint

必须防止同一个 key 被用于不同业务参数：

```text
fingerprint = H(canonical(method, tenant, account, amount, currency))
```

若记录中的 fingerprint 不同：

```text
ALREADY_EXISTS / INVALID_ARGUMENT / FAILED_PRECONDITION
```

具体 code 由 API 契约决定，但绝不能静默返回旧结果或执行新 payload。

canonicalization 必须稳定：不能直接 hash 含不稳定字段顺序、时间戳或随机默认值的表示。

---

## 23. 错误的“先查再写”去重

反例：

```text
if not exists(operation_id):
    execute_side_effect()
    insert(operation_id)
```

两个并发 attempt：

```text
A: SELECT → not found
B: SELECT → not found
A: side effect
B: side effect
A: INSERT
B: INSERT conflict
```

unique constraint 只阻止第二条记录，不会撤销 B 已经发生的副作用。

正确边界需要在副作用前原子占有 operation：

```text
INSERT idempotency(operation_id, fingerprint, state='EXECUTING')
ON CONFLICT ...
```

并让业务写和状态完成处于同一事务，或使用能覆盖外部副作用的状态机/协议。

---

## 24. 单数据库事务中的可靠模式

表：

```sql
CREATE TABLE rpc_operation (
  scope            text   NOT NULL,
  operation_id     text   NOT NULL,
  request_hash     bytea  NOT NULL,
  state            text   NOT NULL,
  response_bytes   bytea,
  grpc_code        int,
  lease_until      timestamptz,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  PRIMARY KEY (scope, operation_id)
);
```

事务伪代码：

```text
BEGIN

record = INSERT operation(EXECUTING)
         ON CONFLICT DO NOTHING

if inserted:
    mutate_business_tables()
    response = build_response()
    UPDATE operation
      SET state=COMPLETED,
          response_bytes=response
    COMMIT
    return response

record = SELECT existing

if request_hash differs:
    ROLLBACK
    reject key reuse

if state == COMPLETED:
    ROLLBACK
    return stored response

if state == EXECUTING:
    ROLLBACK
    wait / return in-progress / retry later
```

关键点：业务修改和 operation 完成记录在同一数据库事务中。不存在“业务提交了，但幂等记录没写”的缝隙。

### 24.1 是否必须缓存完整 response

不一定。可以存：

- 完整序列化 response；
- 稳定资源 ID，重复时重新读取；
- operation status 和 result reference。

但必须保证重复请求得到契约允许的等价结果。若响应包含“当时余额”等快照，重新读取当前值可能不等价。

---

## 25. EXECUTING、Lease 与崩溃恢复

如果 process 在占有 operation 后崩溃，会遗留 `EXECUTING`。

不能简单看到超时记录就再次执行，因为原 worker 可能仍在运行，只是暂停或网络隔离。

常见状态：

```text
ABSENT
  → EXECUTING(owner, fencing_token, lease_until)
  → COMPLETED(result)
  → FAILED_PERMANENT(error)
```

接管需要 fencing token：

```text
attempt A gets token 41
lease expires
attempt B gets token 42

downstream writes accept only latest token
```

否则旧 attempt A 恢复后可能在 B 之后再次写入，形成 zombie writer。

仅靠本地定时器和内存 mutex 无法跨进程、跨副本、跨重启提供可靠幂等。

---

## 26. 数据库之外的副作用：Transactional Outbox

业务事务同时要更新数据库并发布事件：

```text
UPDATE orders
publish OrderCreated
```

直接双写有两个失败缝隙：

```text
DB commit，publish 失败 → 状态有了，事件丢了
publish 成功，DB rollback → 事件声称不存在的状态
```

outbox 模式：

```text
BEGIN
  mutate business tables
  mark operation COMPLETED
  INSERT outbox(event_id=operation_id + event_type, payload)
COMMIT

publisher 异步发送 outbox
consumer 按 event_id 去重
```

publisher 可能重复发送，所以 outbox 通常提供 at-least-once；consumer 必须幂等。

RPC 层的 exactly-once 幻觉最终会在消息系统和外部副作用处破裂。真正可实现的是：稳定 identity + durable dedupe + 原子状态转移 + 可恢复重放。

---

## 27. 外部支付或第三方 API

如果第三方支持 idempotency key，应把本 operation ID 稳定传递：

```text
our operation_id K
→ payment provider idempotency key K
```

如果第三方不支持，无法仅靠本地记录证明一次 timeout 后对方是否执行。常见补救：

- 先创建可查询的 provider-side reference；
- timeout 后按 reference 查询；
- 对账和人工修复；
- 使用 authorize/capture 两阶段业务流程；
- 将不确定状态显式建模为 `UNKNOWN`，禁止盲目再次扣款。

不要把第三方 timeout 直接映射成“本地事务回滚，所以外部没发生”。本地事务无法回滚远端世界。

---

## 28. 查询 Operation 状态比盲目 Retry 更强

对高价值操作，API 可提供：

```protobuf
rpc Charge(ChargeRequest) returns (ChargeResponse);
rpc GetOperation(GetOperationRequest) returns (Operation);
```

client 超时后：

```text
1. 用相同 operation_id 查询
2. COMPLETED → 获取确定结果
3. EXECUTING → 等待/轮询/订阅
4. NOT_FOUND → 根据契约决定是否重新提交
5. UNKNOWN/RECONCILING → 不自动重复副作用
```

注意 `NOT_FOUND` 只有在幂等记录存储可靠且 retention 未过期时，才可能证明 operation 不存在。

状态查询把通信结果未知转化为显式业务状态机，是比“再试一次看看”更可审计的方案。

---

## 29. 幂等记录的 Retention

幂等键不能无限保存，但过早删除会重新打开重复执行窗口。

下界应覆盖：

```text
max client retry horizon
+ queue redelivery horizon
+ offline replay horizon
+ clock/processing margin
+ audit/reconciliation need
```

若 client 可能 24 小时后重放，而 server 1 小时删除 key：

```text
t=0 operation committed
t=1h dedupe record expired
t=24h same key replayed
→ server 当作新操作
```

可选策略：

- key 永久绑定业务资源 ID；
- active retention + 冷归档索引；
- key 中嵌入不可重复业务 ID；
- 过期后拒绝旧 key，而不是当新请求；
- 让 API 文档公开 retry window。

---

## 30. Streaming RPC 的 Retry 与恢复

### 30.1 Server streaming

client 一旦收到 response headers，gRPC retry 已 committed。即使只收到前 10 条中的 3 条，transport retry 通常不能透明重开并假装无事发生。

应用级恢复应携带 cursor：

```text
ListEvents(after_sequence=1032)
```

并定义 sequence 是否连续、是否允许重复、快照如何处理。

### 30.2 Client streaming

client 必须缓存完整 outbound message history 才能重放。超过 retry buffer 后，call committed，不再自动 retry。

更可靠的上传协议：

```text
UploadChunk(upload_id, sequence, checksum, data)
Ack(committed_sequence)
ResumeUpload(upload_id)
```

### 30.3 Bidirectional streaming

双方消息相互影响时，简单重放输入可能重复触发已经产生的输出或副作用。

需要：

- 每方向 sequence；
- application ACK；
- durable session state；
- replay boundary；
- duplicate suppression；
- 明确 reconnect/resume handshake。

HTTP/2 stream ID 不能作为 session ID，因为新连接和新 attempt 会改变它。

---

## 31. `grpc-previous-rpc-attempts` 的可观测价值

retry design 定义初始 metadata：

```text
grpc-previous-rpc-attempts: N
```

第一 attempt 不携带；第二 attempt 为 1，依次递增。

server 可以用它：

- 标记日志和 trace；
- 识别 retry traffic；
- 比较首次与重试成功率；
- 做诊断或保护。

但不要用它替代 idempotency key：

- transparent retry 的计数语义不同；
- 非 gRPC 上层重试可能重建整个 call；
- client 可重启；
- metadata 不是业务唯一性证明。

---

## 32. Retry 与负载均衡的交互

retry 位于 channel 与 load-balancing policy 之间，因此新 attempt 有机会重新 pick backend：

```text
attempt 1 → backend A
attempt 2 → backend B
```

这有助于绕过单实例故障，但带来幂等一致性要求：

```text
dedupe record 若只存在 A 的内存
→ B 看不到
→ 同一 operation 可执行两次
```

可靠去重存储必须覆盖所有可能被 pick 的 backend，或 operation 必须按 key 路由到同一一致性分区。

即便使用 consistent hashing，也要处理扩缩容、failover 和 shard migration；“通常路由到同一台”不是 correctness guarantee。

---

## 33. Retry 与认证、配额、限流

### 33.1 认证

`UNAUTHENTICATED` 通常需要刷新 credential，而不是原样 retry。刷新动作也应共享 overall deadline，防止无限等待。

### 33.2 配额

`RESOURCE_EXHAUSTED` 若表示日配额耗尽，backoff 没意义；若表示瞬时并发限流，可结合 pushback/RetryInfo 再试。

### 33.3 限流计数

必须定义配额按 call、attempt 还是 operation 计数：

```text
按 attempt 计费
→ retry 会重复消耗 quota

按 operation_id 计费
→ 需要幂等计数
```

攻击者可能滥用 idempotency key 占据大量 dedupe storage，因此 key 需要认证作用域、长度限制、速率限制和 retention policy。

---

## 34. 一个完整的客户端决策算法

简化伪代码：

```text
deadline = monotonic_now() + configured_timeout
attempt = 0

while true:
    remaining = deadline - monotonic_now()
    if remaining <= 0:
        return DEADLINE_EXCEEDED

    if attempt >= max_attempts:
        return last_error

    if retry_budget_exhausted():
        return last_error

    attempt += 1
    result = start_attempt(
        request=same_request,
        operation_id=same_operation_id,
        timeout=remaining
    )

    if result.ok:
        return result

    if result.call_committed:
        return result.error

    if not result.request_replayable:
        return result.error

    if result.proven_not_processed:
        continue  # transparent path

    if result.status not in retryable_codes:
        return result.error

    if not operation_is_idempotent:
        return RESULT_UNKNOWN

    delay = pushback_or_exponential_backoff()
    if delay < 0 or delay >= remaining_time():
        return result.error_or_deadline

    wait_cancellable(delay)
```

真实 gRPC library 管理 transport commit、buffer 和 policy；应用仍必须提供业务幂等与正确 status 契约。

---

## 35. 一个完整的服务端幂等算法

```text
handle(request, context):
    validate operation_id and payload
    scope = tenant + method
    hash = canonical_request_hash(request)

    record = atomic_get_or_create(scope, operation_id, hash)

    if record.hash != hash:
        return KEY_REUSE_CONFLICT

    if record.state == COMPLETED:
        return replay(record.result)

    if record.state == FAILED_PERMANENT:
        return replay(record.error)

    if record.owned_by_other_live_attempt:
        return IN_PROGRESS_WITH_RETRY_HINT

    token = acquire_or_takeover_with_fencing(record)

    while doing_precommit_work:
        if context.cancelled():
            release_if_safe(token)
            return CANCELLED

    transaction:
        verify_fencing_token(token)
        apply_business_mutation()
        write_outbox()
        store_completed_result()

    return stored_result
```

不可逆事务提交之后，即使 context 已 cancel，也必须让 operation record 保持可查询。可以停止构造昂贵响应，但不能删除成功事实。

---

## 36. 故障注入：验证而不是相信

### 实验 A：COMMIT 后丢响应

1. server 在数据库 COMMIT 后、发送 trailers 前断开连接；
2. client 观察 `UNAVAILABLE` 或 deadline；
3. 使用相同 operation ID 重试；
4. 验证只存在一条业务修改；
5. 验证重放结果一致。

### 实验 B：取消传播

1. A 调 B，B 调 C；
2. client 在 100 ms 取消；
3. 记录每层收到 cancel 的时间；
4. 检查后台 task、DB query 和 goroutine/thread 是否停止；
5. 测量 cancellation lag。

### 实验 C：retry storm

1. 让 10% backend 返回 `UNAVAILABLE`；
2. 对比无 jitter、带 jitter、带 throttling；
3. 观察 attempt amplification、p99 和 server queue；
4. 验证故障扩大时 retry rate 被预算压住。

### 实验 D：hedge loser 已提交

1. 两个 backend 都在提交后延迟响应；
2. 启用短 hedging delay；
3. 让第二个先返回；
4. 验证第一个收到 cancel 前可能已提交；
5. 验证共享幂等层只产生一次副作用。

### 实验 E：幂等记录 crash gap

在每个边界 kill process：

```text
占有 key 前
占有 key 后
业务写前
业务 COMMIT 后
response 前
```

重启并重放，验证状态机没有重复或永久悬挂。

---

## 37. 必须观测的指标与 Trace

### Call 级

- `grpc.client.call.duration`；
- final status；
- configured deadline；
- deadline budget consumed；
- attempts per call；
- calls exhausted by deadline / maxAttempts / retry budget。

### Attempt 级

- `grpc.client.attempt.started`；
- `grpc.client.attempt.duration`；
- sent/received compressed message size；
- selected backend；
- transparent/configured/hedged 类型；
- retry delay、pushback；
- commit reason：headers / buffer overflow；
- `grpc-previous-rpc-attempts`。

### Server/Operation 级

- handler started/completed/cancelled；
- cancel observed lag；
- operation_id 和 fingerprint；
- idempotency hit/miss/conflict/in-progress；
- operation state transition；
- duplicate attempts collapsed；
- outbox publish/retry；
- result replay latency。

Trace 应表现为：

```text
logical client call span
  ├─ attempt 1 span → backend A
  ├─ backoff event
  └─ attempt 2 span → backend B

server spans link to same operation_id
```

若只记录最终成功 call，会掩盖 attempt 1 的错误和额外负载。

---

## 38. 常见误区

### 误区 1：超时等于服务端没执行

超时只说明 client 没在 deadline 内获得最终状态。

### 误区 2：取消等于回滚

取消是协作停止信号；已提交事务和外部副作用不会自动撤销。

### 误区 3：`UNAVAILABLE` 一定安全重试

它表示可能瞬时恢复，不证明非幂等 operation 未执行。

### 误区 4：`maxAttempts=4` 是重试四次

它包含原始 attempt，即最多三次 configured retry。

### 误区 5：每个 attempt 都有完整 timeout

gRPC call deadline 覆盖全部 attempts 和 backoff。

### 误区 6：收到 response headers 表示业务提交

它只意味着 gRPC retry 状态 committed，不再自动切换 attempt。

### 误区 7：数据库 unique constraint 放最后就能去重

若副作用先执行，constraint conflict 无法撤销重复副作用。

### 误区 8：trace ID 可以当幂等键

trace 和 operation 生命周期不同；重放、采样和跨系统会破坏假设。

### 误区 9：hedge winner 返回后 cancel loser 就安全

loser 可能已经越过不可逆点。

### 误区 10：exactly-once 是 RPC transport 属性

transport 无法原子覆盖远端数据库、消息系统和第三方副作用；需要业务 identity 和一致性协议。

---

## 39. 高频追问

### Q1：读请求是否都可无限重试？

不。读也可能昂贵、触发缓存填充、审计或限额；还受 deadline、retry budget 和 overload 约束。

### Q2：为什么 server 看到 `CANCELLED`，client 看到 `DEADLINE_EXCEEDED`？

client 本地 deadline 到期后返回 `DEADLINE_EXCEEDED` 并取消 stream；server 观察到的是调用被取消。两端处于不同观察位置。

### Q3：服务端应在什么时候检查 cancel？

长循环每个有界工作单元、昂贵 I/O 前后、下游调用前，以及不可逆提交前。检查频率要让取消延迟满足资源目标。

### Q4：幂等键由 client 还是 server 生成？

需要跨 client retry 保持稳定时，通常由能定义业务 operation 的调用方生成。server 可校验格式和作用域，不能每个 attempt 重新生成。

### Q5：返回 `ALREADY_EXISTS` 是否等于幂等成功？

不一定。若相同 key 和相同 payload 已成功，应按契约重放原结果；若只是自然资源冲突，可能是真错误。要区分 operation duplicate 与 domain conflict。

### Q6：多久删除幂等记录？

至少覆盖所有合法重放渠道的最长 horizon；高价值操作还需审计和对账。过期语义必须公开。

### Q7：server 已过载时还应返回 retryable code 吗？

可返回明确的瞬时状态并携带 pushback，但还要做 admission control；仅返回 `UNAVAILABLE` 而没有 client throttling 可能形成重试风暴。

### Q8：重试成功率高是不是好事？

不一定。它可能掩盖首 attempt 故障并增加成本。应同时看 first-attempt success、attempt amplification 和 retry recovery rate。

### Q9：为什么 streaming 需要应用级 resume？

收到 headers 或超出 replay buffer 后，transport 无法无痕重建完整消息历史；应用才知道可靠 sequence 和提交点。

### Q10：如何处理真正的 UNKNOWN？

持久化 operation 为 `UNKNOWN/RECONCILING`，查询下游、执行对账或人工处理；不要把未知伪装成失败并自动重复不可逆操作。

---

## 40. 本章验收清单

- [ ] 能区分 call、attempt 与 business operation。
- [ ] 能写出 `remaining = deadline - now`。
- [ ] 知道 `grpc-timeout` 传相对剩余预算，而非跨机器绝对时间。
- [ ] 能解释 client `DEADLINE_EXCEEDED` 时 server 可能已经 COMMIT。
- [ ] 能画出请求执行的五个失败窗口。
- [ ] 知道 cancellation 是协作信号，不是强制中断或事务回滚。
- [ ] 能沿调用树传播 cancellation 和递减 deadline。
- [ ] 能解释 retry 创建新 HTTP/2 stream 和新 backend attempt。
- [ ] 能区分 gRPC retry committed 与 business committed。
- [ ] 知道 response headers 和 retry buffer overflow 两个 commit point。
- [ ] 能说明 transparent retry 的“未进入 handler”证明边界。
- [ ] 知道 `maxAttempts` 包含原始 attempt。
- [ ] 能手算 exponential backoff 与 ±20% jitter。
- [ ] 能解释整个 retry chain 共用一个 deadline。
- [ ] 不会仅凭 status code 判断非幂等操作安全。
- [ ] 能解释 pushback、retry throttling 与全局 retry budget 的区别。
- [ ] 能计算多层 retry amplification。
- [ ] 能说明 hedging loser 为什么仍可能提交。
- [ ] 能设计 operation ID、fingerprint、durable record 和 retention。
- [ ] 能指出“先副作用、后插 unique key”的竞态。
- [ ] 能把业务写、operation 完成和 outbox 放入一致性边界。
- [ ] 能为 streaming 设计 sequence、ACK 和 resume。
- [ ] 能用故障注入验证 COMMIT 后丢响应和并发 hedge。

---

## 41. 官方资料

- [gRPC Deadlines](https://grpc.io/docs/guides/deadlines/)：deadline/timeout、服务端取消与跨服务剩余预算传播。
- [gRPC Cancellation](https://grpc.io/docs/guides/cancellation/)：取消语义、handler 协作停止和下游传播。
- [gRPC Retry](https://grpc.io/docs/guides/retry/)：transparent retry、Service Config、backoff、throttling 与可观测指标。
- [gRFC A6 — Client Retries](https://github.com/grpc/proposal/blob/master/A6-client-retries.md)：commit point、retry buffer、transparent retry、pushback、hedging 和 metadata 的设计细节。
- [gRPC Request Hedging](https://grpc.io/docs/guides/request-hedging/)：hedging policy、non-fatal status、throttling 与 server pushback。
- [gRPC Status Codes](https://grpc.io/docs/guides/status-codes/)：`DEADLINE_EXCEEDED` 的结果未知语义，以及 `UNAVAILABLE`、`ABORTED`、`FAILED_PRECONDITION` 的选择。
- [gRPC over HTTP/2 Protocol](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md)：`grpc-timeout` 编码、RST_STREAM 映射和 GOAWAY retry 边界。
- [gRPC Service Config](https://grpc.io/docs/guides/service-config/)：per-method timeout、retry/hedging policy 的分发边界。

## 一句话总结

> Deadline 终止等待，cancellation 请求停止，retry 复制 attempt；它们管理的是调用生命周期，不是业务事实。只有把稳定 operation ID、请求指纹、原子去重记录、业务事务、outbox 和状态查询连成一个可恢复状态机，才能在 COMMIT 后响应丢失、并发 hedge 和进程崩溃时把“可能执行多次”收敛成一个确定的业务结果。

> 下一篇：07｜名称解析、负载均衡与连接管理（待生成）。
