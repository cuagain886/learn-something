# 复制偏移、WAIT 与 Failover 状态回退

## 1. 三种位置不要混淆

```text
Stream ID：某个 Stream key 内的消息位置
Group last-delivered-id：某组已交付到的消息位置
Replication offset：整个 Redis 主节点复制字节流位置
```

replication offset 覆盖所有 key 和写命令。

不能用它换算某个 Stream 消息数。

## 2. 主节点写入路径

概念顺序：

1. 主线程执行 XADD。
2. 修改 Stream 内存。
3. 将确定命令写入复制输出/backlog。
4. 向在线副本连接发送。
5. 向客户端回复。
6. 副本接收并执行。
7. 副本周期性 ACK 自己处理到的 offset。

具体 3—5 的缓冲写时序不代表副本已经收到。

默认异步的本质是客户端成功不等待第 6/7 步。

## 3. replication backlog

backlog 是主节点保存最近复制字节的环形缓冲。

副本短暂断线后携带：

- replication ID。
- 已处理 offset。

若身份匹配且缺口仍在 backlog，PSYNC 部分同步。

否则全量同步。

backlog 大小应覆盖：

```text
peak_replication_bytes_per_sec × expected_disconnect_seconds × safety_factor
```

不是按消息条数估算。

## 4. replication ID 为什么会变化

主从拓扑切换后，新主有新的复制历史身份，同时可能保留第二历史 ID/切换 offset 以支持部分重同步。

身份用于判断两节点历史是否属于同一条复制时间线。

仅 offset 相同但 replication ID 不同，内容可能完全不同。

## 5. WAIT 的连接语义

```redis
XADD orders * event_id e1 payload x
WAIT 1 1000
```

WAIT 针对当前客户端连接此前写入所达到的复制 offset。

它等待至少一个副本报告已处理到该位置。

若写和 WAIT 经过不同连接，第二个连接没有相同“此前写”的上下文，语义可能不符合预期。

连接池封装必须保证二者在同一物理连接顺序执行。

## 6. WAIT 返回值怎么解释

返回 N 表示超时前 N 个副本确认达到目标 offset。

`N < requested`：

- XADD 不会被回滚。
- 主内存中写仍存在。
- 客户端必须决定继续、告警或把结果视为 durability uncertain。
- 盲目用新 event_id 重试会重复。

WAIT 不是事务 abort/commit。

## 7. WAIT 不保证 fsync

副本确认通常表示复制流已处理到内存状态。

它不等价于：

- 副本 AOF 已 fsync。
- 副本 RDB 已快照。
- 存储控制器已持久化。

主与副本同时掉电时，仍受各自持久化策略影响。

## 8. WAIT 不控制选主

假设三个副本：

```text
R1 收到 e1 并 ACK
R2/R3 未收到 e1
WAIT 1 成功
主故障
故障管理器选择 R2 晋升
```

若选主算法没有保证选择含目标 offset 的 R1，e1 仍可能丢。

实际 Sentinel/Cluster 会考虑复制进度等因素，但网络可见性、优先级、故障时序使 WAIT 不成为形式化多数提交。

## 9. ACK 状态回退比消息丢失更隐蔽

场景：

1. 消息已在所有节点。
2. consumer 业务成功。
3. 主执行 XACK。
4. ACK 尚未复制，主故障。
5. 新主仍有旧 PEL。

结果是重复投递，不是消息丢失。

业务幂等处理后再次 ACK即可收敛。

如果监控只对比 XLEN，会漏掉这种状态回退。

## 10. Group 投递状态回退

XREADGROUP 已在旧主：

- 推进 last-delivered。
- 建 PEL owner=C1。

若未复制便 failover，新主把消息视为未交付。

C2 用 `>` 可再次取得。

C1 也可能已经收到响应并执行。

两者并发副作用，仍靠幂等/fencing。

## 11. claim 状态回退

C1 pending 被 claim 给 C2。

claim 未复制时切换：

- 新主 owner 仍是 C1。
- C2 已开始业务。
- 恢复器稍后又可能 claim。

owner 只是可恢复调度元数据，不是外部执行排他证明。

## 12. `min-replicas-to-write`

主节点可在健康副本数不足或延迟过大时拒绝写。

它防止孤立主长时间接受无法复制的写。

代价：网络抖动时主动降低可用性。

它仍不等价于每条写同步落多数磁盘，因为健康判断有时间窗口，复制仍异步。

## 13. Sentinel 判定阶段

概念阶段：

```text
主观下线 SDOWN
多个 Sentinel 协商客观下线 ODOWN
选 leader
选择副本
晋升
重配置其他副本
通知客户端
```

从主实际不可用到客户端连接新主之间存在 RTO。

阻塞 XREADGROUP 连接通常需要断开、重连和恢复 pending。

## 14. 旧主写窗口

网络分区时旧主可能仍可被一部分客户端访问。

另一侧完成晋升。

旧主恢复后作为副本同步新主，会丢弃分叉写。

降低风险的方法：

- 最少副本写限制。
- 客户端快速刷新拓扑。
- WAIT。
- 缩短故障判定但控制误切换。
- outbox 对账补发。

这些是收窄窗口，不是消除分区不一致。

## 15. Cluster 的少数派窗口

Cluster 节点以 gossip 和多数主节点可见性做故障切换。

少数分区中的旧主可能有短写窗口。

Cluster 解决自动分片与可用性，不把 Stream 变为共识日志。

跨 slot 的多个 Stream 更没有共同提交点。

## 16. Producer 恢复协议

对关键事件：

1. 数据库事务写业务 + outbox(event_id)。
2. relay XADD，event_id 固定。
3. 可选同连接 WAIT。
4. 超时/WAIT 不足标记发布不确定，不生成新 event_id。
5. relay 重试。
6. consumer 以 event_id 幂等。
7. 对账任务比较 outbox 与消费结果。

即使 Stream entry 重复，也不会重复业务效果。

若 failover 丢 XADD，outbox relay 会补发。

## 17. Consumer 恢复协议

启动后：

1. 校验 group 是否存在且起点正确。
2. 恢复自己 pending 或由集中 recovery claim。
3. 业务幂等表判断已完成事件。
4. 已完成则只补 ACK。
5. 未完成则处理并提交后 ACK。
6. 再进入 `>` 新消息循环。

不要只连上新主后直接读 `>`，否则旧 PEL 永久遗留。

## 18. 故障实验必须记录什么

每个事件记录：

```text
event_id / stream_id
旧主 replid/offset
每副本 offset
WAIT 返回值
XADD 客户端结果
组 last-delivered
PEL owner/count/idle
DB 幂等结果
被晋升节点
切换精确时间线
```

没有这些数据，看到重复时无法判断是客户端重试、ACK 回退还是 group 投递回退。

## 19. RPO 分类

分别定义：

- payload RPO：最近 XADD 可能丢多少。
- delivery-state RPO：组游标/PEL 可能回退多少。
- business-effect RPO：外部 DB 最终是否缺事件。

outbox 可让业务效果 RPO 优于 Redis payload RPO，因为丢失 entry 可补发。

幂等让 delivery-state 回退只造成重复。

这是端到端设计，而非单组件参数。

## 20. 面试回答模板

问 WAIT 是否保证不丢：

1. 解释同连接此前写的 replication offset。
2. 解释等待副本内存处理确认。
3. 明确不保证 fsync。
4. 明确不保证选择该副本晋升。
5. 明确不是共识事务。
6. 给出 outbox + event_id 幂等的端到端补偿。

