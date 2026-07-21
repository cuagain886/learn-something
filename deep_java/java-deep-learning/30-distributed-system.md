# 30. 分布式系统基础：结果未知、复制一致性与故障隔离

> 优先级：S｜难度：★★★★★｜前置：[22 HTTP](22-http-servlet-web.md)、[29 消息队列](29-message-queue.md)

## 1. 本章目标

能把 timeout 表达为“未在期限内获得答复”而非失败；能为副作用设计 operation id/状态查询/幂等；能区分 linearizable、sequential、causal、eventual；能限定 CAP；理解 quorum/term/log 的共识基本思想；能在 Saga/TCC/Outbox 中选择，并组合 deadline、限流、熔断、隔离和背压。

## 2. 两个将军问题从一个 HTTP timeout 开始

client 发请求，server 提交 DB 后 response 在网络丢失：client timeout，但 effect 已发生。若 server 未收到、执行前 crash、执行中 crash、提交后 crash，client 观察都可能相同。

```text
timeout ⇒ no response before deadline
timeout ⇏ operation failed
timeout ⇏ safe to repeat
```

服务“成功返回前可能已完成操作”，也可能 response 成功到 proxy 但 client 已取消。网络协议无法让双方在所有故障下获得共同知识；业务必须保留 UNKNOWN 状态与对账。

## 3. deadline、timeout 与 retry budget

入口设 absolute deadline（monotonic duration + wall-clock timestamp for propagation），每层计算 remaining，涵盖 queue、pool、connect、attempt、backoff。下游 timeout 必须小于 remaining 并留清理/响应余量。

重试策略三问：错误 transient 吗；操作 idempotent/可对账吗；预算够吗。attempt 上限、exponential backoff、full jitter、retry-after；不要每层独立重试，3 层各 3 次可放大 27 attempts。

hedging 对尾延迟可有效，但主动制造重复并占双份容量，只用于幂等 read/有取消，按 percentile 延迟启动第二请求，不对支付/tool side effect 盲用。

## 4. 幂等是持久状态机

请求带 `(tenant, idempotencyKey)` 与 canonical request hash。服务端原子：

```text
ABSENT → IN_PROGRESS(owner,deadline) → SUCCEEDED(resultRef)
                              \→ FAILED_RETRYABLE / FAILED_FINAL / UNKNOWN
```

同 key 同 hash：返回已完成结果或当前状态；同 key 不同 hash：409 conflict；并发首次请求唯一约束只允许一个 owner。记录保留期 ≥ client/broker 最大 retry 窗口，不能过早 TTL。

业务 effect 与 idempotency record 在同 DB transaction 最简单；外部 effect 用 provider idempotency key/查询 API + local state/outbox。只缓存 response 不够：cache evict 后会重复。

[IdempotencyOutboxLab](examples/distributed/IdempotencyOutboxLab.java) 证明 lost response 后 retry effect 仍一次，并把 outbox redelivery 在 inbox 去重。

## 5. 一致性模型要描述允许观察

- linearizability：每操作像在调用与返回间某点原子发生，尊重实时先后；
- sequential consistency：存在保持各 client program order 的总序，但不必尊重跨 client 实时时间；
- causal consistency：因果相关写按因果顺序，独立写可不同序；
- eventual consistency：停止新写后副本最终收敛，没给陈旧时长/冲突语义；
- read-your-writes/monotonic reads：session guarantees，弱于全局 linearizable。

写文档时说“订单状态 eventual，正常 2s/p99 10s 收敛，version LWW/人工冲突，支付确认读 primary”，而不是只写“强/弱一致”。

## 6. CAP 的正确边界

CAP 讨论发生网络 partition 时，系统不能同时对所有请求保持 linearizable consistency 与 availability（每个非故障节点请求都获非错误响应）。没有 partition 时仍有 latency、durability、throughput 的大量权衡；“选 CA 数据库”忽略真实网络分区。

CP 系统在无法证明 quorum/leader 时拒绝部分操作；AP 系统接受并以后解决冲突。选择可按 operation：库存扣减宁拒绝，商品描述可多主合并。CAP 的 A 不等于服务 uptime 指标，C 不等于 ACID 的 C。

PACELC 补充：有 partition 选 A/C；else 正常时也在 latency/consistency 间权衡，但仍需写具体协议。

## 7. 复制与 quorum

leader-replica 异步复制延迟低但 failover 可能丢 acked write/读旧；同步到 quorum 提升 durability/consistency，增加尾延迟并在少数派不可写。`W + R > N` 只是 quorum overlap 的起点，仍需版本、leader/repair 和 failure assumptions，不能凭公式自动 linearizable。

read replica 会有 lag，刚写后读可 sticky primary/LSN wait/session token；无限 sticky 会压主库。failover 后旧 leader 必须 fenced，防 split brain writes。

## 8. 共识的基本不变量

Raft/Paxos 类协议让节点对 log/leader term 达成一致：多数派选 leader；term/ballot 单调；entry 复制到 quorum 后按规则 commit；follower 按 commit order 应用 state machine；旧 leader 在更高 term 退位。

共识不等于业务 transaction：它复制一个服务的 log。client 在 commit 后 response 丢失仍需 request id dedup；跨两个 consensus groups/外部 API 仍要协调。membership change、snapshot、disk fsync、clock/lease read 是实现重点，不能自己用 Redis 心跳拼一个强一致锁。

## 9. 分布式锁、lease 与 fencing

lock service 授予有过期时间的 lease。client pause/GC/network partition 超过 lease，另一 client 获得；旧 client 恢复时并不知道自己已失权。resource 接受单调 fencing token，拒绝 token 小于最高值。

[FencedLockLab](examples/distributed/FencedLockLab.java) 中 token2 owner 先写，迟到 token1 被 resource 拒绝；release 同时 compare owner+token，避免旧 owner 删新 lease。

即便 linearizable lock + fencing，业务 retry 仍可能重复同 token 下的操作，故 idempotency 仍需。能用 DB unique/version/queue partition owner 表达的，不引入额外分布式锁。

## 10. 分布式事务选择

### 2PC/XA

coordinator 让 participants prepare 后 commit；提供强原子但持锁/阻塞、参与者支持和运维复杂。coordinator/participant recovery log 决定 in-doubt，不能只写注解。

### Saga

多个 local transactions + events/commands；失败执行 compensation。compensation 是新的业务动作，不是时间倒流：退款可能失败、已发送邮件无法收回。每步/补偿幂等，state machine 可恢复，支持 forward recovery/人工介入。

### TCC

Try 预留、Confirm 提交、Cancel 释放；业务服务必须实现空回滚、防悬挂、重复 confirm/cancel。适合有明确 reservation 的资源，侵入高。

### Outbox

单 DB 业务+event 原子，跨系统最终一致；不能同时强提交远端，但简单可靠。大多数事件驱动后端优先考虑。

## 11. 服务发现与负载均衡

registry/DNS 返回 endpoint set，有 TTL/watch；client cache、health、zone、draining 决定实际路由。实例从 registry 删除不等于已有连接立即消失；停机先 not-ready/drain，再等 connection/stream/requests，最后关闭。

round robin 只平衡请求数，不平衡 cost；least outstanding/latency-aware 可能受反馈延迟和 slow start。consistent hashing 减少 key remap，但热点 key 仍热点。重试应换实例只对非 sticky/可重试错误，避免向整个集群扩散。

## 12. 过载保护的组合

- rate limit：单位时间 admission，token bucket 允许 burst；维度 tenant/model/tool；
- concurrency limit：同时 in-flight，贴合 Little's Law；
- bounded queue：吸短突发并给 queue deadline；
- circuit breaker：失败/慢比例达到阈值暂时 fail fast，half-open 探测；
- bulkhead：不同依赖/租户独立 pool/semaphore；
- load shedding/degrade：拒低优先、旧 cache、缩短输出；
- backpressure：消费者 demand 传生产者。

circuit breaker 不是重试器，不修永久错误；全局 breaker 可能被一个 tenant 打开影响所有人。窗口、minimum calls、slow threshold、open duration 与 probes 都需指标/测试。

只在应用层限流不足以保护 thread/connection accept 前资源，边缘+服务+下游多层预算，但避免每层重复 queue/retry。

## 13. Agent 状态机与故障矩阵

Agent run 不是一次 transaction：

```text
ACCEPTED → PLANNING → TOOL_PENDING → TOOL_UNKNOWN/SUCCEEDED
 → MODEL_PENDING → COMPLETED
任意非终态 → CANCELLING → CANCELLED（外部 effect 可仍待对账）
```

每 transition 有 expected version、event id、actor、deadline；持久 event/checkpoint。worker lease/fencing 防旧 worker commit；tool invocation id 防重复；UNKNOWN 进入 query/reconcile，不直接 retry。

故障注入：DB commit 后 kill、tool response 前断网、MQ ack 前 kill、lease 过期后恢复、duplicate/out-of-order events、clock skew、下游 429/slow/partition。验收看不变量与恢复时间，不只成功率。

## 14. 可观测与 SLO

分层 metrics：admission/reject、queue age、attempts、deadline remaining、idempotency hit/conflict、unknown age、breaker state、replica lag、outbox lag、compensation pending。trace 每 attempt 链到同 operation id，日志不把重试当新业务。

SLO 分“请求已接受”“最终完成”“状态收敛”；异步 202 响应快不等于任务快。错误预算驱动是否降级/停止发布，而不是 breaker 打开后继续无限排队。

## 15. 常见误区与清单

1. **timeout=失败**：可能已成功，必须 UNKNOWN/查询。
2. **重试提升可靠性**：无预算/幂等会放大故障和副作用。
3. **eventual 就最终一定很快**：需收敛界限和冲突规则。
4. **CAP 可用性就是 99.99% uptime**：定义不同。
5. **共识让业务 exactly once**：client retry 和跨系统仍需 id。
6. **分布式锁替代唯一约束/幂等**：旧 owner/重复调用仍可能。
7. **Saga rollback 像数据库 rollback**：补偿可失败且不可完全逆。

- [ ] 能列出一次 timeout 的全部允许结果。
- [ ] 能设计 key+hash+durable status。
- [ ] 能为 API 写具体一致性模型。
- [ ] 能说明 quorum/term/log 的不变量边界。
- [ ] 能在 XA/Saga/TCC/Outbox 中选型。
- [ ] 能组合 limit/queue/breaker/bulkhead/backpressure。

## 16. 延伸阅读

- [RFC 9110 HTTP Semantics：Idempotent Methods](https://www.rfc-editor.org/rfc/rfc9110#section-9.2.2)
- [Raft paper](https://raft.github.io/raft.pdf)
- [Kafka delivery semantics](https://kafka.apache.org/41/design/design/)
- [Redis locking failure assumptions](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/)

下一阶段：[31 LLM 应用基础](31-llm-application.md)。
