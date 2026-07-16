# Redis Stream、Kafka、RabbitMQ 的机制对比

## 不按“谁性能高”选型

三者的核心抽象不同：Redis Stream 是内存有序日志 + 消费组状态；Kafka 是分区追加日志 + broker 磁盘保留 + offset；RabbitMQ 以 exchange/queue 路由和 broker 投递/确认见长。吞吐数字离开消息大小、持久化、复制、批量和硬件没有意义。

| 维度 | Redis Stream | Kafka | RabbitMQ |
|---|---|---|---|
| 主存储 | 内存数据结构，RDB/AOF | 分区磁盘日志/页缓存 | 队列类型决定，磁盘与内存协作 |
| 顺序范围 | 单 Stream key | 单 partition | 单 queue 投递顺序，重投/并发可改变完成顺序 |
| 消费状态 | group last-delivered + PEL | consumer group offset | queue 中 ready/unacked 与 ack |
| 回放 | ID 范围，受内存保留 | offset/time，适合长保留 | 队列消费为主，Stream queue另论 |
| 路由 | 应用选 key | topic/partition | exchange binding 丰富 |
| 重试/DLQ | 多需应用构建 | 多需应用/topic 设计 | TTL/DLX等 broker 能力成熟 |
| 横向扩展 | 应用拆多个 key/slot | partition 原生 | queue/cluster 类型与拓扑设计 |
| 复制一致性 | 默认异步，WAIT 收窄窗口 | ISR/acks配置决定 | quorum queue等类型决定 |

## Redis Stream 适合

- 延迟敏感、中等数据量、保留窗口较短且内存预算明确。
- 应用已深度使用 Redis，运维团队理解持久化/复制边界。
- 需要范围读取、简单 fan-out group 与任务分发。
- 业务已有 event_id 幂等、外部事实库和故障演练。

## Kafka 更合适

- 每秒高吞吐、数天/月历史、反复回放和多个分析消费者。
- 需要原生 partition 扩展、日志压缩、流处理生态。
- 希望存储成本主要落在磁盘而非 Redis 内存。
- 能接受按分区顺序并承担 Kafka 集群复杂度。

Kafka 也不是自动 exactly-once 到任意外部数据库；事务语义有明确范围，外部副作用仍需幂等/连接器协议。

## RabbitMQ 更合适

- exchange routing、topic/direct/fanout、优先级、TTL/DLX 等消息代理能力重要。
- 工作队列和复杂路由多于历史回放。
- 希望 broker 对 ready/unacked、prefetch 和队列拓扑提供成熟治理。
- quorum queue 的一致性与可用性取舍符合业务。

## 迁移信号

从 Redis Stream 迁 Kafka：内存成本失控、保留不断延长、单 key 达瓶颈、分片/回放工具自行建设过多。迁 RabbitMQ：重试/延迟/DLQ/路由脚本越来越复杂，队列级隔离和投递策略成为主要需求。

## 选型问题清单

1. 峰值/平均 TPS、消息 P99 字节、保留时间、回放次数？
2. 顺序是全局、实体、分片还是不需要？
3. 一个消息是组内竞争还是多订阅 fan-out？
4. 可接受 RPO/RTO，已确认消息允许什么故障窗口？
5. 外部副作用怎样幂等，毒消息怎样治理？
6. 团队更擅长 Redis、Kafka 还是 RabbitMQ 运维？
7. 三年总成本包括内存、磁盘、网络、开发补偿机制和 on-call 吗？

## 最终判断

Redis Stream 的优势是把日志、阻塞读取和消费组直接放在 Redis 低延迟数据面；风险是团队容易把“命令简单”误认为“消息系统简单”。当你已经自行实现长保留、复杂重试、跨分片协调、完善可观测性和灾难恢复时，通常应重新评估专用消息平台。

