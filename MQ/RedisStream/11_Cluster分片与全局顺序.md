# Cluster 分片与全局顺序

## Stream key 属于一个 hash slot

Redis Cluster 将 key 映射到 16384 个 slot；一个 Stream 的全部主体、组和 PEL 随 key 位于同一主分片。它不会像 Kafka topic 那样自动把一个超大 Stream 拆成多个分区。单 Stream 吞吐受一个主节点的 CPU、网络和内存限制。

扩展方式是应用定义多个 Stream key：

```text
orders:{00} ... orders:{63}
shard = hash(order_id) mod 64
```

每个分片内有序，跨分片没有全局顺序。消费者需为每个 key 建组或管理相应读取，运维对象数随分片数×组数增长。

## hash tag 的精确含义

key 中 `{...}` 内容参与 slot 计算：`orders:{tenant42}` 与 `retry:{tenant42}` 同 slot，可执行要求同 slot 的多 key 操作/Lua。但所有 tenant42 流量也集中到一个分片。hash tag 是共址工具，不是越多越好。

## 多 key 命令限制

Cluster 中一次涉及多个 key 的命令通常要求 key 同 slot。多 Stream `XREAD/XREADGROUP`、Lua/Function、原子转移主流到 DLQ 等设计，要在目标版本/客户端实测 cluster 路由限制。跨 slot 只能拆成多次操作，于是失去 Redis 内部原子性。

将主流和 DLQ 强行同 slot便于原子脚本，却可能造成热点；分开 slot 可扩展，但“写 DLQ 后 ACK 原消息”存在双写窗口，需要幂等恢复。应明确选择哪种取舍。

## 重分片和 MOVED/ASK

slot 迁移期间客户端可能收到 MOVED/ASK，需要 cluster-aware 客户端更新拓扑并重试。对阻塞读取尤其要测试：长连接绑定旧节点后，迁移/切换是否及时断开重连；重试时不得把上次位置错误重置为 `$`。

Consumer Group 命令必须发到 key 当前主节点，因为读取新消息会修改 PEL。只读副本路由不适用于 XREADGROUP 的新消息路径。

## 分片策略

| 策略 | 顺序 | 负载 | 风险 |
|---|---|---|---|
| 按 order_id hash | 单订单稳定顺序 | 通常均匀 | 热订单仍热点，扩分片需迁移规则 |
| 按 tenant | 租户内单流顺序 | 大租户倾斜 | 单租户受单分片上限 |
| 随机/轮询 | 无实体顺序 | 最均匀 | 业务需版本栅栏 |
| 时间分桶 | 桶内顺序 | 易过期 | 跨桶消费、迟到事件复杂 |

分片数改变会让同一实体映射变化。使用一致性 hash、版本化路由或迁移期间双读；否则同一订单可能在旧/新分片并行处理。

## 全局顺序为什么昂贵

多个主节点没有共同 Stream ID 分配器。按客户端时间归并受时钟偏差和网络延迟影响；集中序列器又成为吞吐瓶颈与可用性依赖。多数业务真正需要的是“同一聚合有序”，应按 aggregate key 分片并用版本检查，而非追求虚假的全局顺序。

## 容量与故障域

分片不只为 TPS，还隔离内存、fork、AOF rewrite 和热点。规划需包含：

- 每分片峰值 XADD/读取/ACK/claim 命令量。
- 消息字节与保留窗口。
- 每组 PEL、消费者元数据。
- 副本与故障迁移后节点是否能承接双倍负载。
- slot 迁移的网络和内存峰值。

## Cluster 仍是异步复制

Cluster 提供分片与自动 failover，不把数据复制改造成强一致。少数分区中的已确认写仍可能在故障切换时丢失。设计详见 [10_复制Sentinel与故障切换窗口.md](10_复制Sentinel与故障切换窗口.md)。

