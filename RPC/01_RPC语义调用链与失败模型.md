# 01｜RPC 语义、调用链与失败模型：一次调用究竟执行了几次

> 本章不讨论某个框架的 API，而是建立所有 RPC 协议都绕不开的语义底座：调用、尝试、执行和副作用不是同一个对象；客户端失败也不等于服务端失败。

## 1. 先定义问题：RPC 把什么伪装成了本地调用

本地调用：

```text
result = createOrder(command)
```

调用者通常隐含了以下认知：

1. 控制流已经进入或没有进入函数；
2. 函数返回成功时，本次执行完成；
3. 函数抛出异常时，调用者至少能根据语言和事务边界判断发生了什么；
4. 一条语句只触发一次函数执行；
5. 参数和返回值共享同一套类型、内存与运行时规则。

远程调用无法保留这些隐含条件。表面上一行调用，运行时至少要做：

```text
生成逻辑调用
  → 选择服务端地址
  → 建立/选择连接
  → 创建一次物理 attempt
  → 编码请求
  → 发送请求帧
  → 服务端接收、解码、排队
  → 执行 handler
  → 提交本地或外部副作用
  → 编码响应
  → 发送状态
  → 客户端接收并结束逻辑调用
```

任何箭头之间都可能超时、崩溃或断网。RPC 抽象隐藏了这些步骤，但不能消除它们。

### 1.1 RPC 的透明性有明确上限

stub 可以隐藏序列化和发包样板代码，却无法透明处理以下差异：

| 维度 | 本地调用 | 远程调用 |
|---|---|---|
| 失败 | 进程内异常、崩溃 | 调用方、服务端、代理、网络可分别失败 |
| 延迟 | 通常纳秒到微秒，方差较小 | 跨机 RTT、排队、重传、下游调用，尾延迟显著 |
| 参数 | 指针/引用可共享对象 | 必须复制并编码；对象身份通常丢失 |
| 取消 | 语言运行时可能协作中断 | 取消信号有传播延迟，且不能撤销已提交副作用 |
| 调用次数 | 一次语句通常对应一次执行 | 重试/hedging 使一次逻辑调用对应多次 attempt |
| 结果认知 | 返回点通常是清晰边界 | 响应丢失会造成服务端成功、客户端失败 |

因此 RPC API 应显式暴露远程性：deadline、可取消 context、结构化错误、幂等要求和观测信息不应被“像本地函数”完全藏掉。

---

## 2. 四个对象：Call、Attempt、Execution、Effect

后续所有语义讨论都基于四个严格区分的对象。

### 2.1 Logical Call：业务看到的一次逻辑调用

应用执行一次：

```text
CreateOrder(request_id="req-42", ...)
```

从应用视角这是一个 call。它有总 deadline、最终返回值和统一 trace，但内部可能经历多个地址和多个 attempt。

### 2.2 Attempt：运行时发起的一次物理尝试

retry 或 hedging 会创建新 attempt：

```text
logical call req-42
├── attempt 0 → server A → UNAVAILABLE
├── attempt 1 → server B → timeout
└── attempt 2 → server C → OK
```

attempt 有自己的连接、HTTP/2 stream、开始时间和状态。**总调用耗时不能只看最后一次 attempt。**

### 2.3 Execution：服务端业务代码的一次执行

attempt 到达服务端 runtime，不代表已经执行 handler：

```text
网络已收到
  → 协议校验
  → 认证/限流/interceptor
  → 请求队列
  → handler execution
```

透明重试可能发生在服务端 library 收到请求、但应用 handler 尚未看到请求的情况下。因此 attempt 数与 execution 数仍可能不同。

### 2.4 Effect：对可观察状态的一次副作用

一次 handler execution 可能产生零个、一个或多个 effect：

- 插入订单；
- 扣减库存；
- 发布消息；
- 调用支付服务；
- 发送邮件。

handler 只执行一次，也不等于所有 effect 原子地只发生一次。数据库提交成功、消息发送失败，已经是跨系统一致性问题，超出了 RPC 传输语义。

### 2.5 四者的基数关系

```text
1 logical call
  ├── 1..N attempts
  │     └── 0..1 server executions（对每个 attempt）
  │            └── 0..N external effects
  └── 1 client-visible final outcome
```

理想情况是 `1 call = 1 attempt = 1 execution = 1 effect`。生产故障分析必须证明这个等式在哪一层成立，不能把它当默认事实。

---

## 3. 客户端与服务端各自维护什么状态

### 3.1 客户端调用状态机

```text
CREATED
  │ 解析地址、等待连接/stream 配额
  ▼
PENDING
  │ 创建 attempt 并提交请求
  ▼
ACTIVE ────────────────┐
  │                    │ retryable failure 且预算允许
  │ 收到最终状态        ▼
  │               BACKOFF → 新 attempt → ACTIVE
  ▼
COMPLETED

任意非终态 ── deadline/cancel ──> CANCELLED/DEADLINE_EXCEEDED
```

这个模型有两个容易忽略的等待区：

- **发送前排队**：名称解析、连接建立、连接流控、并发 stream 上限都可能消耗 deadline；
- **重试退避**：backoff 期间没有 active attempt，但逻辑 call 的时间仍在流逝。

### 3.2 服务端调用状态机

```text
RECEIVING
  → VALIDATING
  → QUEUED
  → HANDLING
  → EFFECT_COMMITTED
  → RESPONSE_READY
  → STATUS_SENT
  → CLOSED
```

客户端只能通过收到的协议事件间接推测服务端走到了哪一步。连接断开或 deadline 只会切断证据链，不会让服务端状态自动回退。

### 3.3 两端终态不要求一致

下面的组合完全可能发生：

```text
server: EFFECT_COMMITTED → STATUS_SENT(OK)
client: deadline 到期 → DEADLINE_EXCEEDED → 丢弃迟到的响应
```

服务端认为成功，客户端认为失败，两者都没有违反各自的本地状态机。这不是 gRPC 独有问题，而是分布式系统无法通过一次不可靠往返获得共同认知的基本现象。

---

## 4. 标识符不是一回事

生产系统经常把 stream ID、trace ID、request ID 和幂等键混用，导致去重错误或观测断链。

| 标识 | 作用域 | 谁生成 | 主要用途 | 能否作为业务幂等键 |
|---|---|---|---|---|
| logical call ID | 一次客户端 API 调用 | 客户端 RPC runtime/观测层 | 关联多个 attempt | 通常不能，SDK 可能不稳定或不暴露 |
| attempt number/ID | 一次物理尝试 | 客户端 runtime | 重试和 hedging 观测 | 不能，每次重试恰好不同 |
| HTTP/2 stream ID | 单条 HTTP/2 连接 | HTTP/2 endpoint | 在连接内复用 frame | 不能；换连接会重置，且不是全局唯一 |
| ONC RPC XID | 客户端未完成调用集合，具体规则依协议 | RPC client | 回复关联，也可辅助检测重传 | 不能直接等同；规范明确它不是服务端序列号 |
| trace ID | 一条分布式调用链 | tracing SDK/入口 | 跨服务观测 | 不建议；采样、重放和业务生命周期不同 |
| business idempotency key | 某业务操作的去重域 | 业务客户端/入口 | 识别“同一业务意图” | 是，但必须定义租户、操作类型、有效期和参数摘要 |

幂等键必须跨 attempt 保持不变：

```text
call: CreateOrder(idempotency_key=K)
├── attempt 0, stream 3, trace T, K
├── attempt 1, stream 7, trace T, K
└── attempt 2, new connection stream 1, trace T, K
```

trace 通常保持同一 trace 并为每次 attempt 创建不同 span；幂等键 K 则表达业务意图，而不是网络尝试。

---

## 5. 用时间线枚举失败窗口

考虑一个会写数据库的 unary RPC：

```text
T0  client 创建 logical call
T1  client 创建 attempt
T2  request bytes 开始写入连接
T3  server runtime 收到完整 request
T4  server handler 开始执行
T5  database COMMIT 成功
T6  server runtime 接收 handler 的 OK/result
T7  response/status 写入连接
T8  client 收到最终 status
T9  client 返回给业务代码
```

### 5.1 故障矩阵

| 故障窗口 | 服务端可能执行？ | 副作用可能提交？ | 客户端能否安全断言“未执行”？ | 典型处理 |
|---|---:|---:|---:|---|
| T0～T1：本地参数校验/排队失败 | 否 | 否 | 能，前提是运行时证明请求未离开客户端 | 可透明重试或直接失败 |
| T1～T2：尚未写出任何请求数据 | 否 | 否 | 通常能，但依赖 runtime 的精确证据 | 可透明重试 |
| T2～T3：部分/全部请求在途时断开 | 未知 | 未知 | 不能 | 仅幂等调用可重试 |
| T3～T4：runtime 收到，handler 前失败 | 通常否 | 否 | 客户端未必能知道 | 某些 runtime 可做一次透明重试 |
| T4～T5：handler 执行中失败 | 是 | 可能 | 不能 | 检查事务与幂等记录 |
| T5～T7：已提交但响应未发完 | 是 | 是 | 不能 | 结果未知；用幂等键查询/重试 |
| T7～T8：响应在途丢失或客户端 deadline | 是 | 是 | 不能 | 服务端成功、客户端失败的经典窗口 |
| T8～T9：客户端收到后本地进程崩溃 | 是 | 是 | 重启后的上层可能不知道 | 上层工作流同样需要持久化进度 |

### 5.2 三类结果必须分开

客户端 API 不应只有模糊的“成功/失败”心智模型：

```text
SUCCESS
  已收到可验证的最终成功状态和结果

DEFINITE_FAILURE
  已收到明确业务拒绝，或有证据证明请求没有进入执行

UNKNOWN_OUTCOME
  请求可能执行且可能提交，但客户端缺少最终证据
```

许多框架把后两者都映射为异常；调用者仍需依据方法语义、错误阶段和幂等机制做二次分类。

---

## 6. “至少一次、至多一次、恰好一次”到底描述什么

这些术语如果不带对象，几乎没有意义。必须补全：描述 attempt、handler execution，还是业务 effect？时间范围是单进程、跨重启，还是跨灾难恢复？

### 6.1 Maybe：零次或多次

无重试时，handler 可能执行零次或一次，但客户端超时后不知道是哪种；启用不受控重试后，可能执行多次。对调用者而言，这是最弱的“可能执行”语义。

### 6.2 At-least-once execution：至少执行一次

客户端持续重试直到收到成功，可以提高“至少有一次执行”的概率，但前提包括：

- 服务最终恢复；
- 请求没有永久不可达；
- 客户端或代理没有在完成前永久丢失任务；
- 服务端确实接受并执行重试。

代价是 handler 可能执行多次，因此 effect 必须天然幂等或去重。

### 6.3 At-most-once execution：最多执行一次

典型协议机制：

```text
client 发送 (client_session, request_id, payload)
server:
  if request_id 已完成:
      返回缓存结果
  else:
      执行并记录结果
```

但“记住 request ID”还不够，必须回答：

1. 去重表是否持久化？服务端重启后是否丢失？
2. 检查 ID 与提交副作用是否在同一原子事务？
3. 并发到达的两个重复请求如何互斥？
4. 返回值是否缓存？若只丢弃重复请求，客户端如何结束等待？
5. ID 保存多久？过期后旧请求重放会怎样？
6. 客户端 ID 是否会在进程重启后复用？如何区分 client incarnation/session？
7. 多副本服务的去重状态由谁共享？故障切换后还有效吗？

如果去重只存在单实例内存中，最多只能声称：**在该实例本次进程生命周期且缓存未淘汰的范围内，对同一标识尽力做到 at-most-once execution。**

### 6.4 Exactly-once effect：不是通用 RPC 协议属性

端到端恰好一次副作用要求：

```text
至少一次到达/重试
  + 跨重试稳定的业务操作 ID
  + 持久化去重
  + 去重状态与目标副作用原子提交
  + 重复请求可恢复原结果
```

若写订单和发邮件属于两个无法参与同一事务的系统，即使订单表对幂等键有唯一约束，也不能由此推出邮件恰好发送一次。RPC 只能承载业务标识；effect 的正确性取决于事务、outbox/inbox、条件写或下游幂等。

---

## 7. At-most-once 的实现为什么比一个 Set 复杂

### 7.1 错误实现：内存 Set

```text
if id in seen:
    return ALREADY_PROCESSED
seen.add(id)
do_business_write()
```

至少有四个漏洞：

- `seen.add` 后、业务写前崩溃：永久误判已处理；
- 业务写后、返回前崩溃：重启丢失 Set，重复执行；
- 两个线程同时检查，都看不到 ID：并发重复执行；
- 只返回“处理过”而不保存原结果：客户端无法获得第一次调用的 order ID。

### 7.2 单数据库事务内原子提交

若业务状态与幂等记录位于同一数据库，可以让唯一约束和业务写处于一个事务：

```sql
BEGIN;

INSERT INTO rpc_idempotency(
    tenant_id, operation, idem_key, request_hash, status
) VALUES (
    :tenant, 'CreateOrder', :key, :hash, 'PROCESSING'
);

INSERT INTO orders(order_id, tenant_id, ...)
VALUES (:order_id, :tenant, ...);

UPDATE rpc_idempotency
SET status = 'SUCCEEDED',
    response_payload = :serialized_response
WHERE tenant_id = :tenant
  AND operation = 'CreateOrder'
  AND idem_key = :key;

COMMIT;
```

唯一键建议覆盖：

```text
(tenant_id, operation, idempotency_key)
```

重复请求遇到唯一键冲突后读取记录：

- `request_hash` 不同：拒绝，防止同一个 key 被用于不同参数；
- `SUCCEEDED`：返回第一次保存的逻辑结果；
- `FAILED_FINAL`：返回相同的确定性业务失败；
- `PROCESSING`：等待、返回冲突/稍后重试，或进行租约接管；不能直接再执行。

事务回滚时幂等记录和订单一起消失，允许后续 attempt 重新执行；事务提交时两者一起可见，重复 attempt 只能恢复结果。

### 7.3 长任务不能一直持有数据库事务

如果 handler 要调用多个慢下游，把数据库事务从入口一直持有到结束会造成长锁和连接池耗尽。此时应使用显式状态机：

```text
NEW → RUNNING(owner, lease_until) → SUCCEEDED(result)
                           └──────→ FAILED_RETRYABLE
                           └──────→ FAILED_FINAL(error)
```

难点转为：

- lease 过期后的接管者如何确认旧 owner 已停止？
- 两个 owner 短暂并存时，如何用 fencing token 阻止旧 owner 提交？
- 每个外部 effect 是否支持相同幂等键？
- 状态机写入和消息发布如何通过 transactional outbox 衔接？

这说明幂等不是“加个 Redis 锁”。锁过期、主从切换和 GC pause 都可能让两个执行者同时工作；真正保护状态的是目标存储上的唯一约束、版本号或 fencing 条件。

---

## 8. 重试：新的 attempt，不是时间倒流

重试的语义是重新发送调用历史，创建新的物理 attempt。它不会撤销旧 attempt，也不能保证旧 attempt 已经停止。

### 8.1 串行重试

```text
attempt 0 ── fail ── backoff ── attempt 1 ── fail ── backoff ── attempt 2
```

优点是同一时刻通常只有一个 attempt；但网络分区时旧 attempt 可能仍在服务端执行，所以服务端层面依旧可能重叠。

### 8.2 Hedging

```text
attempt 0 ───────────────────────────────>
        hedge delay
             attempt 1 ──────────────────>
```

hedging 不等待第一个 attempt 失败就发送第二个，能压低尾延迟，但主动制造并行执行。它只适合只读、天然幂等或有严格去重的操作，并需要全局限额防止负载翻倍。

### 8.3 gRPC 的 retry commit point

在 gRPC 内建重试模型中，客户端收到 response headers 后，该 RPC 对重试机制而言已经 committed，运行时不再创建新 retry attempt，并把控制权交给应用。这里的 committed 是**客户端重试状态机术语**，不是数据库提交，也不证明业务成功。

透明重试只利用运行时能够证明的狭窄窗口：

- RPC 从未离开客户端时，可以重新尝试；
- 请求到达服务端 gRPC library、但未被应用逻辑看到时，可以进行有限透明重试；
- 一旦无法证明未处理，就不能把非幂等调用的重试安全性交给传输层猜测。

### 8.4 重试条件是四个集合的交集

```text
should_retry =
    method_is_idempotent
    AND failure_is_retryable
    AND remaining_deadline > next_backoff + minimum_attempt_budget
    AND retry_budget_allows
```

只判断 `UNAVAILABLE` 不够。它表示暂时不可用的可能性较高，但 gRPC 官方状态定义也明确：非幂等操作并不总能安全重试。

---

## 9. Deadline：限制等待预算，不证明执行终止

### 9.1 Timeout 与 deadline

- timeout：从当前时刻还能等待多久，是 duration；
- deadline：绝对截止时间点。

跨机器传播绝对时间会受到时钟偏差影响。gRPC 的做法是把 deadline 转换为剩余 timeout，并扣除已经消耗的时间，再传给下游。

### 9.2 端到端预算必须递减

假设入口总预算 500 ms：

```text
0ms    Gateway 收到请求，deadline = 500ms
40ms   完成认证与排队，调用 Order，remaining ≈ 460ms
110ms  Order 调用 Inventory，remaining ≈ 390ms
260ms  第一次 Inventory 失败，remaining ≈ 240ms
```

此时不能给第二次 Inventory attempt 重新设置 500 ms，否则调用链总耗时会突破入口 SLO。更实用的分配是：

```text
child_budget = min(
    parent_remaining - response_reserve,
    child_method_cap
)
```

`response_reserve` 给编码、回传和清理预留时间。预算不能只按下游数量平均分，还要结合串行/并行拓扑和延迟分位数。

### 9.3 Deadline 到期后的真实状态

客户端到期：

1. 停止等待；
2. 将本地调用结束为 `DEADLINE_EXCEEDED`；
3. 尝试向服务端传播取消；
4. 丢弃以后到达的成功响应。

服务端可能已经：

- 尚未收到取消；
- 正在不可中断的阻塞调用中；
- 提交数据库事务；
- 把任务交给不继承 context 的后台线程；
- 成功发出响应，但响应晚于客户端 deadline。

因此 gRPC 对 `DEADLINE_EXCEEDED` 的官方定义明确允许“改变系统状态的操作实际上已经成功完成”。

---

## 10. Cancellation：撤销兴趣，不是撤销历史

取消表达的是：调用方不再需要后续结果，请尽快释放资源。它不表达：此前执行的所有动作必须回滚。

### 10.1 协作式取消

多数 RPC runtime 无法安全强杀任意 handler 线程。handler 必须在适当位置检查：

```text
decode complete
  → check cancelled
  → before expensive CPU work: check
  → before downstream call: derive child context
  → while waiting/looping: check periodically
  → before optional side effect: check
```

但在数据库 COMMIT 已成功后检查取消，只能停止后续工作，不能回滚已提交事务。

### 10.2 脱离请求生命周期的后台任务

错误模式：

```text
handler 启动 background task
handler 因 client cancel 返回
background task 继续写数据库/调用下游
```

若任务必须独立完成，应把它显式持久化到任务表/队列，并返回任务 ID；不要通过丢失 context 的线程把同步 RPC 偷偷变成长任务。此时 RPC 的成功语义应是“任务已可靠接收”，而不是“任务已执行完成”。

### 10.3 取消传播也会失败

取消帧可能因连接已经断开而无法到达；中间代理也可能已经把完整请求缓冲并转发。服务端仍需以自身 deadline、租约和资源上限作为兜底，不能只依赖客户端取消。

---

## 11. 错误码只能描述观察结果，不能替代执行证据

建议把错误分成四层：

| 层 | 示例 | 是否说明 handler 执行过 |
|---|---|---|
| 业务层 | 库存不足、订单已存在 | 通常说明请求进入业务，但由 API 契约定义 |
| RPC 运行时 | UNIMPLEMENTED、RESOURCE_EXHAUSTED | 可能在 handler 前被 runtime/interceptor 拒绝 |
| 传输层 | connection reset、GOAWAY、TLS alert | 通常无法判断 handler 是否执行 |
| 本地层 | 序列化失败、无可用地址、调用前取消 | 某些情况可证明请求未离开客户端 |

### 11.1 gRPC 中几个容易误用的状态

- `INVALID_ARGUMENT`：请求本身无效，与系统当前状态无关；原样重试通常无意义。
- `FAILED_PRECONDITION`：系统状态不满足条件，需先修复状态再重试。
- `ABORTED`：并发冲突等导致操作中止，通常应从更高层 read-modify-write 流程重做。
- `UNAVAILABLE`：大概率是暂态故障，但不自动意味着非幂等调用可安全重试。
- `DEADLINE_EXCEEDED`：等待预算耗尽，写操作可能已经成功。
- `CANCELLED`：调用被取消，不说明取消前的副作用已回滚。
- `ALREADY_EXISTS`：可以是业务终态，也可以被 API 设计为幂等恢复线索；需要契约说明。

### 11.2 状态码必须附带方法语义

客户端策略应来自：

```text
RPC status
  + method idempotency classification
  + attempt phase evidence
  + remaining deadline
  + business operation state
```

不能建立一个全局规则：“所有 UNAVAILABLE 重试三次”“所有 DEADLINE_EXCEEDED 告诉用户失败”。

---

## 12. 调用链中的放大效应

若调用链有 4 层，每层在失败时最多尝试 3 次，最坏情况下叶子服务可能承受：

```text
3 × 3 × 3 × 3 = 81 attempts
```

这还没计算 hedging。超载时成功率下降，各层同时重试，新增流量进一步降低成功率，形成正反馈：

```text
过载 → 延迟/错误上升 → 重试增加 → 入站流量增加 → 更严重过载
```

### 12.1 重试责任应集中

常见策略：

- 只允许最靠近原始请求、最了解业务幂等性的层做应用级重试；
- 中间服务只做能证明未执行的透明重试；
- 用 retry budget 将额外 attempts 限制为正常请求量的一小部分；
- 服务端过载时尽早拒绝并提供 pushback，而不是排队到所有请求超时；
- 观测 logical call 与 attempt 两套指标。

### 12.2 并发预算也要传播

deadline 限制时间，不限制同一时间在系统中的工作数量。即使每个请求都有 100 ms deadline，入口无限接收仍能耗尽：

- HTTP/2 active streams；
- handler 线程/goroutine；
- 数据库连接；
- 下游并发；
- retry buffer 和响应队列内存。

所以可靠 RPC 需要 deadline、并发限制、队列上限和负载拒绝共同工作。

---

## 13. 一套可落地的写 RPC 契约

以 `CreateOrder` 为例，建议在 IDL 之外明确以下契约：

```text
Method: CreateOrder
Side effect: 创建一个订单
Idempotency scope: (tenant_id, idempotency_key, method)
Key retention: 至少 24h，长于客户端最大重试/离线恢复窗口
Same key + same request hash: 返回第一次的 order_id 和终态
Same key + different request hash: INVALID_ARGUMENT / conflict
Retryable transport statuses: UNAVAILABLE（仍受总 deadline 和 retry budget 限制）
Business retry: FAILED_PRECONDITION 不自动重试；ABORTED 重做上层流程
Cancellation boundary: DB commit 前尽力停止；commit 后不回滚
Unknown outcome recovery: 以 idempotency key 查询 GetOperation/CreateOrder 重放
```

### 13.1 同步写接口的返回语义

```text
OK(order_id)
  → 订单已提交，可按 order_id 读取

确定性业务错误
  → 本次业务意图未提交；修正输入/状态后再发新 key

传输错误或 deadline
  → 结果未知；不得直接换新 key 创建
  → 使用原 key 重试或查询操作状态
```

### 13.2 长任务改为 Operation 资源

对于无法在常规 deadline 内完成的操作：

```text
StartExport(idempotency_key) → Operation{id, state=PENDING}
GetOperation(id)             → PENDING/RUNNING/SUCCEEDED/FAILED
CancelOperation(id)          → 请求停止，是否可撤销由状态定义
```

这把“请求是否被可靠接收”和“长任务是否完成”拆成两个可持久化状态，避免客户端靠保持一条长连接猜测服务端进度。

---

## 14. 观测：必须同时看 Call、Attempt 与业务提交

### 14.1 三层指标

```text
Call 层
  logical calls、最终状态、端到端 duration、用户可见成功率

Attempt 层
  attempts/call、retry delay、选中地址、连接状态、每次 attempt duration

Server/Effect 层
  handler started/completed、queue time、DB commit、dedup hit、in-progress conflict
```

若只统计客户端最终成功率，可能看不到平均每个 call 已从 1.0 次 attempt 上升到 2.8 次；系统在表面成功时已经接近重试风暴。

### 14.2 Trace 结构

```text
Client logical-call span
├── attempt-0 span → Server A span → DB transaction span
├── retry-backoff event
└── attempt-1 span → Server B span → dedup-hit event
```

需要记录但控制基数：method、target service、status、attempt number、retry reason、deadline remaining。业务幂等键可能含敏感信息或高基数，不应无处理地作为 metrics label；可在受控日志/trace 中记录哈希或内部 operation ID。

### 14.3 判断“客户端失败、服务端成功”的证据链

1. client trace：call 以 deadline exceeded 结束；
2. attempt span：请求已发送，未收到最终 status；
3. server trace：同一 trace/业务 key 进入 handler；
4. DB：事务提交时间早于 client deadline 或略晚；
5. server log：响应写出失败或写出时间晚于 deadline；
6. dedup 表：后续原 key 重试命中并恢复相同结果。

---

## 15. 故障注入实验

不要只测试“服务端返回错误”。真正有区分度的实验要把故障插在不同时间点。

### 实验 1：请求发送前失败

- 让 resolver 返回无地址，或在序列化阶段制造错误；
- 验证 handler invocation count 为 0；
- 观察客户端错误能否与已发送请求区分。

### 实验 2：handler 前断开

- 服务端 runtime 收到 request 后，在 dispatch 前关闭连接；
- 观察客户端是否透明重试；
- 确认 server application 指标仍为 0 次 execution。

### 实验 3：提交后响应前断开

- handler 提交数据库后阻塞；
- 由代理断开连接或等待客户端 deadline；
- 确认客户端失败但数据库已有记录；
- 用相同幂等键重试，验证返回原 order ID；用新 key 重试，验证会产生重复业务操作。

### 实验 4：并发重复请求

- 同时发送 50 个相同 key 和 payload 的请求；
- 验证只有一个业务行、所有成功调用得到同一结果；
- 再使用相同 key、不同 payload，验证被拒绝而非静默复用旧结果。

### 实验 5：进程重启与去重持久性

- 第一次调用成功后重启所有服务实例；
- 用相同 key 重放；
- 若重复 effect，说明所谓 at-most-once 只存在于进程内存范围。

### 实验 6：重试放大

- 构造三层调用链，每层配置 3 attempts；
- 让叶子服务持续 UNAVAILABLE；
- 统计每个入口 call 触发的叶子 attempts；
- 改为仅入口重试并配置 retry budget，对比负载。

---

## 16. 高频追问与深度回答

### Q1：RPC 超时后，服务端还会执行吗？

可能已经执行、正在执行或尚未执行。超时只表示客户端等待预算耗尽。若请求可能已离开客户端，就必须按结果未知处理；是否继续执行取决于取消传播、handler 是否协作检查，以及副作用是否已经提交。

### Q2：TCP 可靠，为什么 RPC 结果还会未知？

TCP 只保证一条存活连接上的有序可靠字节流，不保证连接永不在任意时刻断开。服务端可以已提交后连接才断，客户端便收不到响应；TCP 无法替业务状态提供原子确认。

### Q3：请求 ID 能否保证 at-most-once？

不能单独保证。还需要持久化去重、并发互斥、ID 生命周期和 client incarnation、结果缓存，以及去重状态与业务副作用的原子提交。否则 ID 只是关联字段。

### Q4：幂等与 at-most-once 有什么区别？

- at-most-once 试图限制 execution 次数；
- 幂等允许 execution 多次，但要求可观察 effect 与执行一次等价。

工程上常用“至少一次重试 + 幂等 effect”，因为跨故障永久证明最多执行一次成本很高。

### Q5：GET 一定可安全重试吗？

HTTP 语义上 GET 应安全且幂等，但具体 RPC 方法是否只读取决于服务契约和实现。若 GET 偷偷记审计、扣配额或触发异步任务，这些副作用仍要单独考虑。

### Q6：收到 `UNAVAILABLE` 就能重试吗？

它通常表示暂态不可用，但不证明服务端没执行。只有方法幂等、错误策略允许、总 deadline 有预算且 retry budget 未耗尽时才适合重试。

### Q7：为什么相同幂等键要校验 request hash？

否则客户端 bug 可能用同一个 key 提交两组不同参数，服务端会悄悄返回第一次结果，让调用者误以为第二组参数已生效。key 必须唯一标识同一业务意图。

### Q8：服务端收到取消后应该回滚事务吗？

未提交事务可按业务需要回滚；已提交事务不能因迟到取消而假装未发生。取消点和提交点必须在 API 契约中说明。

### Q9：exactly-once 为什么常被说“不可能”？

不可能的是仅靠不可靠网络上的一次请求/响应，让双方在所有故障下自动获得“副作用恰好一次”的共同事实。限定到单一事务存储、稳定操作 ID 和持久化去重后，可以实现业务层恰好一次 effect；它是额外状态与事务机制的结果，不是 RPC 天然属性。

### Q10：怎样判断一次重试是否真正安全？

写出旧 attempt 与新 attempt 并存的时间线。如果两者都进入 handler，目标存储仍只能产生一个正确 effect，且两者能恢复相同结果，才具备安全重试基础。

---

## 17. 本章验收清单

- [ ] 能区分 logical call、attempt、execution、effect。
- [ ] 能画出 T0～T9，并说明每个失败窗口的客户端认知。
- [ ] 不把 deadline exceeded 解释为“服务端没执行”。
- [ ] 能严格补全 at-most-once 的作用域、持久性和故障假设。
- [ ] 能解释为什么 stream ID、trace ID 和幂等键不能互相替代。
- [ ] 能设计同一事务内的去重记录、业务写和结果缓存。
- [ ] 能说明 retry commit 与数据库 commit 完全不是一个概念。
- [ ] 能从总 deadline 推导下游剩余预算，而不是逐层重置 timeout。
- [ ] 能计算多层重试的最坏放大倍数。
- [ ] 能用 call/attempt/server/effect 四组证据定位结果未知。

---

## 18. 官方规范与经典资料

- [Birrell & Nelson, Implementing Remote Procedure Calls](https://www.cl.cam.ac.uk/teaching/0708/DigiCommI/birrell1984rpc.pdf)：stub、binding、传输、异常语义与 RPC 透明性的经典论文。
- [RFC 5531 — Remote Procedure Call Protocol Version 2](https://www.rfc-editor.org/rfc/rfc5531.html)：ONC RPC 模型、transport independence、XID、重传和“某种程度的 at-most-once”边界。
- [gRPC Core Concepts](https://grpc.io/docs/what-is-grpc/core-concepts/)：调用生命周期、两端独立判断终态，以及取消不会回滚既有修改。
- [gRPC Deadlines](https://grpc.io/docs/guides/deadlines/)：deadline、服务端取消、剩余 timeout 传播与时钟偏差处理。
- [gRPC Cancellation](https://grpc.io/docs/guides/cancellation/)：协作式取消及 handler/下游调用的停止责任。
- [gRPC Retry](https://grpc.io/docs/guides/retry/)：logical call、attempt、transparent retry、response-header commit、退避与 retry throttling。
- [gRPC Status Codes](https://grpc.io/docs/guides/status-codes/)：标准状态码及其重试语义边界。
- [gRFC A6 — Client Retries](https://github.com/grpc/proposal/blob/master/A6-client-retries.md)：gRPC 客户端重试状态机的原始设计。

## 一句话总结

> 一次 RPC 只有在客户端收到结果时才结束等待，却可能早已在服务端留下副作用；正确设计不是假设网络会告诉你“执行了几次”，而是让每次 attempt 携带同一业务意图标识，并由持久化状态、原子提交和可恢复结果把未知变成可查询、可重放的确定性。

> 下一篇：[02｜IDL、代码生成与 Schema 演进](02_IDL代码生成与Schema演进.md)。
