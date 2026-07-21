# 29. 消息队列与异步系统：offset、重复投递与业务效果

> 优先级：A｜难度：★★★★☆｜参考基线：Apache Kafka 4.1 语义；具体 broker 按产品版本复验｜前置：[24 事务](24-spring-aop-transaction.md)

## 1. 本章目标

能区分发布 durability、broker 存储、consumer delivery 与外部业务效果；能从 partition/group/offset 推导顺序和扩缩容；能实现 at-least-once 下的 inbox 幂等与 outbox；能设计堆积恢复、DLQ、重试和 Agent 长任务，而不把“exactly once”口号外推到任意 HTTP/DB。

## 2. 异步增加了持久时间轴

同步调用把等待放调用栈；队列把 request 变 durable record，producer 成功仅表示达到 broker 定义的确认点，consumer 以后处理。它解耦速率/故障，但增加：重复、延迟、顺序、schema、回放、保留和运维状态。

```text
producer → client buffer/batch → broker leader/log/replicas → ack
consumer poll → process → external effect → offset/ack
```

两端任一响应丢失都产生“不知道是否完成”。设计从允许结果和去重开始，不从 SDK send 方法开始。

## 3. Topic、Partition 与 Consumer Group

以 Kafka 为具体模型：topic 分 partitions，每 partition 是按 offset 有序 append log；key partitioning 让同 key 通常到同 partition。总局部顺序不等于全 topic 顺序。加 partitions 会改变 key→partition 映射/ordering assumptions，需稳定 partitioner/version。

同 consumer group 内 partition 在某时刻分配给一个 consumer member；consumer 数超过 partitions 没有更多并行度。不同 groups 各自消费全 topic，适合索引/通知/审计独立视图。

rebalance 会撤销/重新分配，旧 consumer 正在处理的工作可能与新 owner 重叠；需要 revoke 时停取、完成/取消、提交安全 offset，外部写仍用 fencing/idempotency。

## 4. offset 是“下次从哪读”

consumer position 随 poll 前进，committed offset 用于重启/rebalance 恢复；提交值通常是 next record offset。自动提交可能在业务效果完成前推进，崩溃后丢处理；效果后提交则崩溃窗口会重放。

at-most-once：先提交/ack 再处理，失败可能丢但少重复。at-least-once：处理成功后提交，可能重复但不丢已确认处理机会。多数业务选择后者 + 幂等。

offset commit 自己也可 timeout/失败；consumer 不能继续无限处理后假设 ownership 仍在。`max.poll.interval` 超过会触发成员失效/rebalance，长任务不应在 poll thread 无界执行。

## 5. Producer durability 与重复

producer batch/compress 提吞吐，linger 增延迟；acks/replication/min in-sync replicas 决定 broker failure 窗口。client retry 在 ack 丢失后可能重发；Kafka idempotent producer 用 producer id/sequence 在 broker session 范围去重并保持受支持 ordering，但不覆盖业务重新创建不同 key 的请求或外部 DB。

消息 id 要来自业务 operation，不在每次 retry 重新 UUID。broker 返回成功前 leader 已 commit 但 response lost，查询/幂等重发，而不是标失败制造第二笔。

## 6. Consumer 幂等 inbox

消息含 eventId/aggregateId/version/type/schema/occurredAt/payload。consumer 在同一数据库事务：

```sql
insert into inbox(consumer,event_id) values (?, ?) -- unique
if inserted: apply business change
commit
then ack/commit offset
```

重复 insert unique conflict 就跳过效果再 ack。若业务效果是外部 HTTP，DB inbox 与 HTTP 不原子：需把待调用写本地 task/outbox，以幂等 key 调远端并保存状态。

只在 Redis SETNX 去重受 TTL/eviction/failover 影响；保留期必须 ≥ broker 最大重放/恢复窗口，关键效果用持久数据库唯一约束。

## 7. Transactional Outbox

业务 transaction 同时写 aggregate 与 outbox event；relay 轮询/CDC 发布，发布成功标记或由 log position 推进。崩溃窗口导致重复发布而非事件丢失，consumer inbox 去重。

[IdempotencyOutboxLab](examples/distributed/IdempotencyOutboxLab.java) 模拟：业务与 outbox 已提交但响应丢失；同 key retry 返回同 result且 effect=1；relay 在 ack 前崩溃重投同 event，consumer inbox applied=1。same key/different payload 被拒绝。

真实 outbox 需索引 pending、分区/claim、保留/归档、poison event、schema 演进、relay lag/attempts。发布顺序若按 aggregate 重要，claim/partition key 必须保序。

## 8. “Exactly once”的边界

Kafka 4.1 文档的 EOS 适用于 read-process-write Kafka：transactional producer 把 output records 与 consumed offsets 原子提交，consumer `read_committed` 只读 committed。它不自动把 MySQL、邮件、支付、Tool HTTP 纳入 Kafka transaction。

写外部系统时，要么把 offset 与 result 存同一外部事务（可行时），要么幂等/outbox/inbox/对账。所谓 exactly-once 最终是“每个业务 operation id 的效果状态机只允许一次合法提交”，不是网络只传一次。

## 9. 顺序消息

单 partition 保证 log order，不保证 completion order：consumer 把同 key 任务并发到线程池，后一个可能先完成。按 key 串行 mailbox、version CAS 或仅有限跨 key 并行。

失败消息若原地无限 retry 会阻塞后续同 partition；移 retry topic/DLQ 会打破相对顺序。选择依业务：账户状态必须停/补偿；通知可越过并标 gap。事件带 aggregate version，consumer 拒绝/缓存乱序并有重建路径。

## 10. retry、DLQ 与延迟

分类：validation/schema/authorization 是 permanent，直接 quarantine；rate-limit/network/leader change 是 transient，指数退避+jitter；unknown external effect 先对账；bug 进入 DLQ/告警而非热循环。

retry message 包 original event id、attempt、firstSeen、nextAt、lastErrorCode，不把巨大 stack/payload 无限复制。DLQ 不是垃圾桶：需 owner、SLO、查看权限、redrive 工具；修复后 redrive 仍使用原 id。

延迟可由 broker 特性、分级 retry topics 或调度表实现。超长 TTL message 大量堆积影响 broker，按产品评估。

## 11. 堆积与背压

lag = log end - committed/processed position；但真正风险是 oldest message age 与 deadline。高吞吐 topic offset lag 大不一定超 SLO，低吞吐 1 条 poison 可卡数小时。

处理能力 `consumers × per-consumer rate` 长期小于 ingress 必然增长。恢复：先阻止新放大/降级 producer，再确认 bottleneck（DB pool、API quota、CPU、partition skew），按资源上限扩 consumer，不把 DB 打死。

计算清空时间 `backlog / (serviceRate - arrivalRate)` 仅在 service>arrival 且稳定；加入 retry 回流、坏消息和扩容 warmup。

## 12. 消息丢失的分层检查

producer future 是否等待/处理错误；acks/replication；broker retention/compaction；consumer offset 是否提前提交；异常是否吞；DLQ 是否写失败；external effect 是否 rollback；观察系统是否仅漏日志。

日志 compact topic 只保每 key 最新记录（以及 tombstone 规则），不能当永久审计事件流；retention 到期也会删旧 segment。备份/回放期限与业务恢复目标对齐。

## 13. Agent 异步架构

- run queue：key=runId/tenant shard，payload 是 immutable command/reference，不放全 prompt 大对象；
- tool queue：仅对可远程 worker 化的 tool，invocation id 幂等；
- sandbox scheduling：资源 class/priority/tenant quota，claim lease + fencing；
- event topic：append sequence，SSE gateway 消费并持 cursor；
- completion notification：从 durable final state 派生，可重复发送。

worker claim 后 checkpoint states：QUEUED→RUNNING(attempt,leaseToken)→SUCCEEDED/FAILED/UNKNOWN。消费 ack 只在状态持久化后；进程 crash 由 redelivery/resume，模型上下文从 checkpoint 重建而非内存 Future。

## 14. 外部实验与观测

本机 Docker daemon 不可用，未宣称 Kafka/RabbitMQ 实测。Kafka 4.1 环境应验证：producer ack 丢失/幂等；consumer effect 后 commit 前 crash；rebalance during slow processing；partition key ordering；transactional read-process-write+read_committed；outbox relay duplicate；lag recovery且 DB pool 有界。

指标：produce error/retry/record queue time、broker ISR/under-replicated/offline、consumer lag/oldest age/poll/processing/commit/rebalance、duplicate/inbox conflict、retry/DLQ age、outbox lag。按 tenant/key 查 partition skew。

## 15. 常见误区与清单

1. **用了 MQ 就不会丢**：producer/broker/consumer/external effect 各有窗口。
2. **partition 有序等于并发完成有序**：worker 调度会重排。
3. **offset 提交等于效果提交**：不同系统的状态。
4. **broker EOS 覆盖外部 API**：通常不覆盖。
5. **DLQ 解决失败**：只是隔离，仍需修复/redrive。
6. **扩 consumer 一定消 lag**：partition/DB/API 才是上限。

- [ ] 能画 publish 与 consume 两个不确定窗口。
- [ ] 能把 next offset 与业务事务绑定。
- [ ] 能实现 outbox/inbox unique id。
- [ ] 能定义按 key 顺序与失败阻塞策略。
- [ ] 能按 oldest age 规划恢复。
- [ ] 能限定 Kafka EOS 的系统边界。

## 16. 延伸阅读

- [Kafka 4.1 Design：Delivery Semantics](https://kafka.apache.org/41/design/design/)
- [Kafka Consumer offsets/rebalance API](https://kafka.apache.org/41/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html)
- [Kafka Producer transactions API](https://kafka.apache.org/41/javadoc/org/apache/kafka/clients/producer/KafkaProducer.html)

下一章：[30 分布式系统基础](30-distributed-system.md)。
