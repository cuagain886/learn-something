# RabbitMQ 深度学习笔记

> 主线采用 RabbitMQ 4.x：AMQP 0-9-1、Quorum Queue、Stream/Super Stream、Khepri 元数据存储。经典镜像队列只作为历史迁移背景。

## 文档地图

| 顺序 | 文档 | 核心问题 |
|---|---|---|
| 00 | [学习计划](00_学习计划.md) | 如何从 API 使用进阶到可靠性、底层与排障 |
| 01 | [AMQP 模型、Exchange 与路由](01_AMQP模型Exchange与路由.md) | 消息如何从 Publisher 经 Exchange/Binding 进入 Queue |
| 02 | [Connection、Channel 与协议帧](02_ConnectionChannel与协议帧.md) | 为什么复用连接、隔离 Channel；协议如何复用 TCP |
| 03 | [Publisher Confirm、Return 与可靠发布](03_PublisherConfirmReturn与可靠发布.md) | 如何区分到达 Broker、成功路由和安全进入队列 |
| 04 | [Consumer Ack、Prefetch 与投递语义](04_ConsumerAckPrefetch与投递语义.md) | 重复、丢失、背压和顺序如何产生 |
| 05 | [Classic、Quorum 与 Stream 选型](05_ClassicQuorum与Stream选型.md) | 三类数据结构的正确使用边界 |
| 06 | [集群、Khepri 与 Quorum Queue 原理](06_集群Khepri与QuorumQueue原理.md) | 元数据一致性和队列数据复制分别如何工作 |
| 07 | [存储、内存、流控与资源告警](07_存储内存流控与资源告警.md) | 积压如何落盘，Publisher 为何被阻塞 |
| 08 | [TTL、DLX、重试与毒消息](08_TTLDLX重试与毒消息.md) | 如何设计有界重试且不制造死循环 |
| 09 | [本地实验与故障注入](09_本地实验与故障注入.md) | 用 Confirm、Ack、节点故障验证语义 |
| 10 | [生产设计、监控与排障](10_生产设计监控与排障.md) | 从 SLO 选择队列类型、容量和证据链 |
| 11 | [面试必考原理与可靠性题](11_面试必考原理与可靠性题.md) | 高频概念、确认、消费、集群与陷阱 |
| 12 | [面试必考场景与系统设计题](12_面试必考场景与系统设计题.md) | 堆积、重复、Unacked、流控、重试和订单系统 |

### 底层实现与源码篇

| 顺序 | 文档 | 实现主线 |
|---|---|---|
| 13 | [BEAM 进程模型与消息流水线](13_BEAM进程模型与消息处理流水线.md) | `rabbit_reader → rabbit_channel → exchange route → queue type` |
| 14 | [Quorum Queue 的 Raft 日志与 FIFO 状态机](14_QuorumQueue的Raft日志与FIFO状态机.md) | Ra WAL/commit/snapshot + `rabbit_fifo` enqueue/checkout/settle |
| 15 | [Classic Queue v2 存储、索引与恢复](15_ClassicQueueV2存储索引与恢复.md) | Queue Process、index v2、Message Store、compaction/recovery |
| 16 | [Stream 与 Osiris 日志存储](16_Stream与Osiris日志存储原理.md) | offset、chunk、segment/index、retention、dedup、Super Stream |
| 17 | [Confirm、Return、Ack 与 Credit 状态机](17_ConfirmReturnAck与Credit状态机.md) | Publisher Pending 竞态、Delivery Tag、连续 Ack、Prefetch Credit |
| 18 | [Khepri 元数据 Raft 与拓扑一致性](18_Khepri元数据Raft与拓扑一致性.md) | metadata tree、Raft commit、projection、snapshot、cluster membership |
| 19 | [Java 客户端源码与自动恢复](19_Java客户端源码与自动恢复机制.md) | `AMQConnection/ChannelN/ConsumerDispatcher/AutorecoveringConnection` |
| 20 | [性能模型、基准测试与容量规划](20_性能模型基准测试与容量规划.md) | 字节放大、Confirm Window、Little's Law、N-1 容量 |
| 21 | [BEAM 内存、调度与故障取证](21_BEAM内存调度与故障取证.md) | RSS/allocator/process/binary/ETS、mailbox、scheduler、IO 证据链 |
| 22 | [官方源码模块阅读地图](22_官方源码模块阅读地图.md) | 按 Connection/路由/Queue/Raft/Stream/Khepri 问题定位源码 |

## 全程案例

```text
Exchange: order.events (topic)
Routing Key: order.created / order.paid / order.cancelled
Queue: payment.order.paid (quorum)
Message: {eventId, orderId, accountId, type, version, occurredAt}
要求: 可靠发布、至少一次消费、数据库不得重复扣款、有界重试
```

## 学习原则

1. Exchange 负责路由，不存储消息；Queue/Stream 才是数据承载结构。
2. Publisher Confirm、mandatory/Return、Consumer Ack 解决不同方向的问题，不能互相替代。
3. “持久化”必须同时检查 durable topology、消息持久属性、队列类型与 Confirm。
4. Ack 只证明 Consumer 对某次 Delivery 的处理结论，不证明外部系统天然幂等。
5. 所有重试都要有次数、时间预算、退避、毒消息出口与幂等策略。
6. 优先用 Policy 管理可变运维参数，避免把不可修改的 x-arguments 散落在代码中。
7. 读完 01～10 并完成故障实验后再读 13～20；源码类名用于定位当前实现，不能替代协议与官方保证。

## 版本与官方资料

- 以 [RabbitMQ 4.2 官方文档](https://www.rabbitmq.com/docs/4.2/)为实现基线。
- [Queues](https://www.rabbitmq.com/docs/4.2/queues)、[Quorum Queues](https://www.rabbitmq.com/docs/4.2/quorum-queues)、[Streams](https://www.rabbitmq.com/docs/4.2/streams)用于数据结构边界。
- [Publisher Confirms](https://www.rabbitmq.com/docs/4.2/confirms)、[Consumers](https://www.rabbitmq.com/docs/4.2/consumers)用于可靠性语义。
- [RabbitMQ Server 官方源码](https://github.com/rabbitmq/rabbitmq-server)用于实现层阅读；生产排查必须 checkout 与部署一致的 release tag。
- 版本会改变默认值、Feature Flag 和限制；生产配置始终查对应版本文档。
