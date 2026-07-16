# Kafka 深度学习笔记

> 目标不是记住一组配置项，而是建立可以解释正确性、性能与故障现象的因果模型。
> 主线采用现代 Kafka 的 KRaft 架构；ZooKeeper 仅作为迁移与历史背景，不作为实验基础。

## 文档地图

| 顺序 | 文档 | 学完后必须能回答 |
|---|---|---|
| 00 | [学习计划](00_学习计划.md) | 学什么、做到什么程度、如何验收 |
| 01 | [核心模型与 KRaft 架构](01_核心模型与KRaft架构.md) | 一条记录经过哪些组件；控制面和数据面如何分工 |
| 02 | [分区日志、索引与副本机制](02_分区日志索引与副本机制.md) | offset、segment、HW、LEO、ISR 如何共同决定持久性 |
| 03 | [Producer 发送链路与可靠性](03_Producer发送链路与可靠性.md) | batching、acks、重试、幂等如何互相约束 |
| 04 | [Consumer Group、位点与再均衡](04_ConsumerGroup位点与再均衡.md) | 消费并行度从何而来；重复与丢失如何产生 |
| 05 | [交付语义、事务与一致性边界](05_交付语义事务与一致性边界.md) | exactly-once 到底保证什么、不保证什么 |
| 06 | [本地实验与故障注入](06_本地实验与故障注入.md) | 如何用证据验证副本、重试、再均衡和位点行为 |
| 07 | [生产设计、容量规划与排障](07_生产设计容量规划与排障.md) | 如何从 SLO 反推分区、副本、磁盘和客户端参数 |

### 底层实现篇

| 顺序 | 文档 | 源码主线 |
|---|---|---|
| 08 | [Broker 网络层与请求处理流水线](08_Broker网络层与请求处理流水线.md) | `SocketServer → RequestChannel → KafkaRequestHandler → KafkaApis` |
| 09 | [日志写入、读取与索引实现](09_日志写入读取与索引实现.md) | `ReplicaManager → Partition → UnifiedLog → LogSegment` |
| 10 | [副本复制、HW 与 Leader 切换](10_副本复制HW与Leader切换.md) | follower fetch、ISR、delayed produce、leader epoch、截断 |
| 11 | [KRaft 元数据日志与控制器](11_KRaft元数据日志与控制器.md) | `KafkaRaftClient → QuorumController → MetadataImage` |
| 12 | [Producer 客户端源码主线](12_Producer客户端源码主线.md) | `KafkaProducer → RecordAccumulator → Sender → NetworkClient` |
| 13 | [Consumer 与 Group Coordinator 源码主线](13_Consumer与GroupCoordinator源码主线.md) | fetch position、coordinator、assignment、offset log |
| 14 | [事务协调器与 Exactly-Once 实现](14_事务协调器与ExactlyOnce实现.md) | PID/epoch、事务状态机、marker、LSO、fencing |

### 面试必考篇

| 顺序 | 文档 | 重点 |
|---|---|---|
| 15 | [基础、架构与底层原理题](15_面试必考基础与原理题.md) | 21 组高频问答：分区、KRaft、副本、水位、存储与性能 |
| 16 | [可靠性、消费语义与一致性题](16_面试必考可靠性与一致性题.md) | 21 组陷阱问答：不丢、重复、幂等、事务、位点与双写 |
| 17 | [生产排障与系统设计题](17_面试必考生产排障与系统设计题.md) | 17 组场景题：Lag、热点、ISR、磁盘、容量与订单平台设计 |

## 建议使用方式

1. 先完成 00 的前置测验和环境准备。
2. 每读一章，手画一次状态/时序图，不看原文复述关键不变量。
3. 所有“可靠”“不丢”“有序”都必须补全作用域和故障假设。
4. 读完 01～05 再做 06；实验结果与预期不同，优先修正心智模型。
5. 用 07 将机制映射到真实业务 SLO，而不是直接抄所谓最佳配置。
6. 完成实验后再进入 08～14；阅读源码时始终区分协议保证、当前实现和可调配置。
7. 面试复习使用 15～17：先遮住答案口述 60 秒，再按追问补充故障窗口和证据。

## 全程使用的案例

以支付事件流为统一案例：

```text
key     = accountId
value   = {eventId, orderId, amount, status, occurredAt, schemaVersion}
topic   = payment-events
目标    = 同一账户内有序；允许重放；不能因重试造成重复扣款
```

这个案例故意区分“Kafka 中记录不重复”和“业务扣款不重复”。后者仍要求业务幂等键、唯一约束或事务性收件箱等机制。

## 版本说明

- 笔记以 Kafka 4.x 的现代架构和 CLI 习惯为基线，具体命令以本机发行包的 `--help` 为准。
- Kafka 版本会改变默认值、协议和再均衡实现；本文更重视跨版本稳定的不变量。
- 学习时优先查阅 [Apache Kafka 官方文档](https://kafka.apache.org/documentation/) 和对应版本的配置参考。

## 源码与实现参考

- [Apache Kafka 官方源码](https://github.com/apache/kafka)：按实际使用版本 checkout tag，不直接以 trunk 细节推导生产行为。
- [Kafka 4.3 Implementation](https://kafka.apache.org/43/implementation/)：网络层、消息格式、日志与分布实现入口。
- [Kafka 4.3 Monitoring](https://kafka.apache.org/43/operations/monitoring/)：把请求流水线阶段映射到可观测指标。
- 阅读原则：协议文档确认保证，源码确认当前实现，实验确认当前版本与环境的真实行为。
