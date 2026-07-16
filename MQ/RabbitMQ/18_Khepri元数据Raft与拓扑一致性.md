# 18｜Khepri 元数据 Raft 与拓扑一致性：Queue 声明为什么需要多数派

> RabbitMQ 4.2 新部署默认使用 Khepri 作为元数据存储。Khepri 保存的是拓扑和集群控制状态，不保存业务 Queue Message Body；它与 Quorum Queue、Stream 的数据 Raft Group 相互独立。

## 1. 元数据有哪些

典型 Cluster metadata：

- vhost；
- Exchange 定义与类型/arguments；
- Queue resource 定义、类型、durable/arguments；
- Binding；
- Policy/operator policy；
- user、permission、runtime parameters 的相应状态；
- feature/cluster component 所需的控制记录。

Queue 数据如 Ready Message、Unacked、Stream Segment 不在 Khepri 中。恢复 Khepri backup 只能恢复“Queue 应该存在”，不能恢复该 Queue 的消息。

## 2. 路径树与状态机

Khepri 把 metadata 表示为路径化树/节点数据，更新被编码为确定性命令交给 Raft Group：

```text
/vhosts/<vhost>/exchanges/<name>
/vhosts/<vhost>/queues/<name>
/vhosts/<vhost>/bindings/...
```

具体路径属于实现，不应由业务依赖。重要的是：所有 voter 按同一已提交命令序列得到同一 metadata state。

## 3. 写入事务

以 Queue declare + Binding 为例，业务看到两个协议调用，但每次 metadata 更新都需要：

1. 在当前 image/state 校验名称、等价属性、权限；
2. 生成 Khepri transaction/command；
3. Active Ra Leader 追加日志；
4. 多数 voter 复制并推进 commit index；
5. 状态机 apply；
6. projection/cache/subscriber 获得更新；
7. 协议调用返回。

若 Queue declare 成功而 Binding 调用失败，Queue 会存在但未绑定。应用应使用幂等 topology reconciliation，而不是假设跨多个 AMQP 方法原子。

## 4. Read Consistency

本地 cache/projection 可以提供低延迟读取，但 Leader 变化或异步更新时要明确读一致性。需要线性化/最新状态的操作可能要求 quorum/Leader 协调；只读本地过期快照虽快，却不能用于决定冲突写。

协议层的 Queue declare 等价性检查必须与权威 metadata 状态协调，不能两个节点各自凭陈旧 cache 同时创建不等价定义。

## 5. Projection

RabbitMQ 大量现有代码需要按 Exchange、Queue、Binding 快速查询。Khepri projection 把路径树变化投影到适合查找的结构/ETS 表，并通过变更事件保持同步。

正确性关注：

- snapshot/replay 后 projection 可重建；
- event 重复/重放必须幂等；
- projection lag 不应让已删除 Queue 被继续当权威目标；
- 切换 metadata backend/升级时 projection schema 兼容。

## 6. Leader Election 与不可用窗口

Khepri 三 voter：Leader 故障后其余两票选新 Leader。Election 窗口内 topology writes 失败/等待；已有 Connection 上对已存在 Queue 的数据操作是否继续，取决于对应 Queue 类型和所需 metadata 路径。

失去 Khepri 多数派后，创建/删除/更新 metadata 无法安全进行。已有 Quorum Queue 即使自身有多数派，也不代表所有控制操作正常；反过来 Khepri 健康但 Queue 丢多数派，业务数据仍不可用。

## 7. 两套故障矩阵

| Khepri quorum | 目标 Quorum Queue quorum | 结果方向 |
|---|---|---|
| healthy | healthy | topology 与数据正常 |
| lost | healthy | metadata 变更受阻；既有数据路径视操作而定 |
| healthy | lost | 能看到 Queue 定义，但 Queue 无法安全推进 |
| lost | lost | 控制面和目标数据面同时不可用 |

因此告警应分别覆盖 metadata store 和每类 replicated data structure。

## 8. Snapshot 与 Log Truncation

Khepri/Ra 同样不能永久从第一个 metadata command 重放。Snapshot 保存某 committed index 的完整状态树；旧 log segment 可在安全边界截断。新 voter 安装 snapshot 后追增量。

Topology churn（每秒大量临时 Queue/Binding）会产生 metadata log、projection 更新、snapshot 和 Erlang Process 开销。Quorum Queue 不适合临时 Queue，Khepri 也不让无限拓扑 churn 免费。

## 9. Cluster Join/Leave

节点加入 Khepri Cluster 涉及 voter/member 配置、snapshot/日志同步与 cluster identity。4.1+ CLI 加入流程简化，不代表可以跳过 peer discovery、cookie/TLS、node name 和持久 volume 规划。

移除节点前要同时检查：

- Khepri 是否仍有多数派；
- 该节点承载哪些 Quorum Queue/Stream members；
- Queue membership 是否先 shrink/grow；
- Leader 是否迁移；
- 节点永久身份/volume 是否会被错误复用。

## 10. Definitions Import 的边界

Definitions 可导入拓扑/权限等 metadata，但不携带 Queue messages。大规模 import 会产生大量 metadata writes，应在升级/启动阶段评估顺序、等价冲突和依赖（先 Exchange/Queue 再 Binding）。

不要把 definitions export 称为 RabbitMQ 数据备份。完整 RPO 需要应用源数据/Outbox、Queue 类型复制、Stream retention 和灾难恢复策略。

## 11. 源码阅读路线

1. RabbitMQ metadata store abstraction 如何选择 Khepri；
2. Queue/Exchange/Binding CRUD 到 Khepri path/transaction；
3. Khepri Ra machine apply；
4. projection 到 ETS/cache；
5. subscription/event 如何通知 RabbitMQ components；
6. snapshot、leader change、cluster join；
7. 对照旧 Mnesia 调用，识别兼容 adapter 而非混用两套权威源。

## 12. 深度检查题

1. Definitions 导入成功为何不能恢复消息？
2. Khepri 丢多数派、Queue Raft 有多数派时哪些操作可能仍受阻？
3. Queue declare 与 Binding 是否天然一个原子事务？
4. Projection 为什么可以缓存但不能成为独立权威？
5. 大量临时 Queue churn 为什么会压力集中到 metadata quorum？

