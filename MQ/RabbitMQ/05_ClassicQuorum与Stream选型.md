# 05｜Classic、Quorum 与 Stream 选型：三种数据结构不是性能档位

> 核心结论：Classic Queue 是单副本传统队列；Quorum Queue 是基于 Raft 的复制队列；Stream 是复制的追加日志，支持按 offset 重复读取。选型先看消费模型与数据安全，不是简单地“重要消息用 Quorum，量大用 Classic”。

## 1. 对比表

| 维度 | Classic Queue v2 | Quorum Queue | Stream / Super Stream |
|---|---|---|---|
| 核心模型 | 工作队列 | 复制工作队列 | 追加日志/重复读取 |
| 4.x 数据复制 | 无经典镜像复制 | Raft 多副本 | 复制日志 |
| 消费后数据 | Ack 后移除 | Ack 后由状态机推进 | 按保留策略保存，可重读 |
| 临时/独占 | 支持 | 不适合/有限制 | 不适合临时队列 |
| 长积压 | 可用但需谨慎 | 超长积压通常不优 | 擅长长保留和重放 |
| 顺序 | 会受重投/多 Consumer 影响 | 同样受投递并发影响 | offset 稳定，日志顺序更清晰 |
| 高可用 | 依赖外部恢复/单副本 | 多数派可用 | 多数派复制 |
| 典型用途 | 临时任务、非关键低成本队列 | 订单、支付等关键任务 | 审计流、事件流、超大 Fanout |

## 2. Classic Queue

4.x 中 Classic Queue mirroring 已移除。Classic Queue 仍适合：

- 临时、独占、服务端命名 Queue；
- 数据安全不要求 Broker 内多副本；
- 可由上游重建、短生命周期的任务；
- 简单低成本工作队列。

不要因为 Cluster 有三节点就认为 Classic Queue 数据自动复制到三台。客户端虽可连接任意节点并由 Broker 透明路由操作，数据本身仍由其宿主队列状态决定。

## 3. Quorum Queue

Quorum Queue 使用 Raft，多数成员确认状态。适合长期存在、数据安全优先的关键工作队列。

典型三成员：1 Leader + 2 Followers，可容忍 1 成员不可用；失去多数派后不能继续正常推进。Publisher 应使用 Confirm，Confirm 在消息复制到 quorum 且被认为安全后发出；Consumer 使用 manual Ack。

不适合：高频创建删除临时 Queue、最低可能延迟、不使用 Confirm/Ack 的低安全场景、极长积压和巨大 Fanout。后两者应评估 Stream。

## 4. Stream

Stream 是不可变追加日志，消息有稳定 offset，按保留策略清理而非因某 Consumer Ack 立即删除。多个 Consumer 可从不同 offset 重复读取，适合：

- 大积压与长保留；
- 事件重放；
- 多订阅者 Fanout；
- 高吞吐日志型处理。

Super Stream 将逻辑 Stream 分区以提高并行度，Publisher 用 routing strategy 选择 Partition，Consumer 组协调分片。它更接近分区日志，不应当成支持全部 Queue 语义的“更快 Quorum Queue”。

## 5. 选择决策树

```text
是否需要同一消息被独立 Consumer 从历史位置重复读取？
├─ 是 → Stream/Super Stream
└─ 否，工作队列语义
   ├─ Broker 内必须多副本、高可用？ → Quorum Queue
   └─ 临时/独占/可重建且接受单副本？ → Classic Queue
```

之后再验证延迟、吞吐、积压、消息大小、Fanout、优先级、TTL、DLX 和客户端协议支持。

## 6. 迁移不能只改 x-queue-type

Classic 与 Quorum 的属性不等价，不能对同名现存 Queue 重新声明另一个类型。迁移通常需要：

1. 新建 Quorum Queue；
2. 复制 Binding/Policy；
3. Publisher 双写或切换路由；
4. Consumer 排空旧 Queue 并切换；
5. 对 eventId/数量做对账；
6. 删除旧拓扑前保留回滚窗口。

## 7. 检查题

1. 三节点 Cluster 上 Classic Queue 是否有三份消息？
2. Quorum Queue 为何不适合 RPC 临时回复 Queue？
3. Consumer Ack 后还想一周后重放，应该选什么？
4. Stream 的 Ack 与工作队列删除语义为何不同？
5. 迁移时为什么不能原地修改 Queue 类型？

