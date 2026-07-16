# Stream 的 RDB、AOF 序列化与命令传播

## 1. 三种恢复思路

Redis 恢复 Stream 状态有三类路径：

```text
RDB：序列化对象当前状态
AOF 增量：重放产生状态的命令
AOF rewrite / RDB preamble：将当前状态重写为紧凑可恢复表示
```

三者最终必须重建同样的不变量，但记录方式不同。

## 2. 必须恢复的状态全集

Stream 主体：

- 所有有效 entry 与 ID。
- 删除/历史边界相关元数据。
- `length`。
- `last_id`。
- `first_id`。
- `entries_added`。
- `max_deleted_entry_id`。

Consumer Group：

- group name。
- last-delivered-id。
- entries-read/lag 辅助状态。
- consumers 与活动时间。
- group PEL。
- 每个 pending 的 owner、delivery time/count。
- 新版引用跟踪状态。

只验证 `XRANGE` 远远不够。

## 3. 为什么 RDB 不应只 dump 原始指针

rax、listpack、NACK 指针只在当前进程地址空间有效。

RDB 写逻辑值和必要元数据。

加载时重新分配：

- Stream object。
- rax/listpack。
- streamCG。
- streamConsumer。
- streamNACK。

然后恢复双索引共享关系。

不能让 group.pel 和 consumer.pel 各自加载两份 NACK。

## 4. 加载顺序约束

一种合理顺序：

1. 加载 Stream 主体与元数据。
2. 创建 group。
3. 创建 group.pel NACK。
4. 创建 consumers。
5. 根据 owner 把同一 NACK 插入 consumer.pel。
6. 重建 entry-group 引用。
7. 校验计数和 ID 边界。

若 consumer 尚未创建就加载 owner，需要暂存名字或调整序列化顺序。

## 5. AOF 增量的确定性问题

以下原始命令含非确定因素：

```text
XADD key * ...
XCLAIM ... IDLE ...
基于当前时间的 delivery_time
近似裁剪的实际删除集合
```

主节点必须传播确定结果，或保证重放算法在给定参数与前序状态下得到相同结果。

尤其自动 ID 必须改写为最终 ID。

否则 AOF 重放会生成新时间 ID，消费游标与 PEL 全部错位。

## 6. XREADGROUP 如何进入 AOF

它返回数据但同时修改：

- group last-delivered。
- PEL。
- consumer 元数据。
- delivery time/count。

不能简单把“读命令文本”按未来时间重放。

实现可传播内部确定命令或改写成能重建交付状态的形式。

源码阅读重点是 `alsoPropagate` 和内部恢复命令，而不是假定 AOF 里只有客户端原始命令。

## 7. AOF everysec 的两个时钟

区分：

```text
命令已写入 Redis 内存
命令已追加到 AOF 用户态/页缓存
后台 fsync 已提交到存储设备
```

客户端收到回复通常不等于最后一步完成。

进程崩溃与整机掉电的结果不同。

`everysec` 的“一秒”是工程近似，还受 fsync 延迟、OS 和硬件缓存影响。

## 8. fsync 延迟如何反向影响主线程

磁盘卡顿时后台 fsync 可能延迟。

Redis 为控制 AOF 缓冲与一致性可能在特定策略下推迟写入或报告延迟。

观察：

- `aof_delayed_fsync`。
- 持久化 INFO。
- 磁盘 await/util。
- 命令延迟尖刺。
- AOF buffer 大小。

MQ 工作负载持续写入，磁盘能力必须按峰值字节而非 XADD QPS 规划。

## 9. AOF rewrite 的状态压缩

旧 AOF 可能包含：

```text
XADD 100 万次
XDEL 80 万次
XGROUP/XREADGROUP/XACK/CLAIM 大量变化
```

rewrite 只需重建当前 20 万消息和当前 group/PEL 状态。

因此重写文件可显著变小。

但为表达当前 PEL，rewrite 必须生成相应 group、consumer 和 pending 恢复操作。

## 10. rewrite 并发窗口

流程概念化：

1. fork 子进程。
2. 子进程遍历 fork 时快照写新 AOF。
3. 父进程继续 XADD/XACK。
4. 增量写入 rewrite buffer/新机制日志。
5. 子进程完成。
6. 合并增量。
7. 原子切换 AOF 文件。

故障发生在每一步都应保留旧文件或可判定的新文件，不能留下半切换作为唯一恢复源。

具体机制随 Redis 多部件 AOF 版本变化，应阅读目标 tag。

## 11. fork Copy-on-Write

fork 时子进程共享内存页。

父进程随后修改 Stream listpack、rax、PEL 页会复制物理页。

高写入率和大节点使 COW 增长。

容量预算：

```text
peak_rss ≈ base_rss + COW_during_fork + buffers + allocator_fragmentation
```

不能把 maxmemory 配到机器内存 95% 后期待 rewrite 安全。

## 12. RDB 快照窗口

若每 5 分钟快照，机器故障可能丢快照后所有：

- 新消息。
- ACK。
- claim。
- group 创建/SETID。

丢 ACK 会导致重复。

丢 XADD 会导致业务事件消失。

丢 group 创建会在恢复后 NOGROUP。

所以 RDB-only 的 RPO 不能只描述“丢几分钟缓存”。

## 13. 恢复后的四种不一致表象

| 恢复状态 | 外部 DB | 结果 |
|---|---|---|
| 消息与 PEL 恢复，ACK 丢 | 已提交 | 重复投递，幂等拦截 |
| ACK 恢复 | 未提交 | 先 ACK 设计导致永久丢业务 |
| XADD 未恢复 | outbox 已提交 | relay 应检测并补发 |
| claim 未恢复 | 新 owner 已处理 | owner 回退，可能再次执行 |

持久化不能替代端到端幂等。

## 14. 冷恢复验收

恢复前保存基线：

```text
XLEN / first-entry / last-entry
entries-added / max-deleted-entry-id
每组 last-delivered / entries-read / lag
每组 PEL count/min/max
每 consumer pending/inactive
抽样 pending delivery count/owner
业务幂等表计数
```

恢复后逐项比较。

仅启动成功和 XLEN 相等不算通过。

## 15. AOF 修复工具的风险

AOF 尾部截断修复可能删除最后若干命令。

如果截掉的是：

- XADD：事件缺失。
- XACK：重复。
- group 创建：NOGROUP。
- claim：owner 回退。

修复后必须按业务 outbox/审计源对账，不能只确认 Redis 能启动。

## 16. 备份的一致时间点

Redis 与 MySQL 分别备份于不同时间，会产生跨系统不一致：

```text
Redis 备份较新、DB 较旧 -> 已 ACK但业务结果未恢复
DB 备份较新、Redis 较旧 -> 已提交事件重新投递
```

后者可由幂等处理。

前者如果原设计先业务后 ACK，理论上 ACK 不应早于 DB commit；但备份时间错位仍需恢复编排和审计。

## 17. 灾备设计

- Redis Stream 不作为唯一业务事实源。
- producer 关键事件来自数据库 outbox。
- consumer 结果有持久幂等记录。
- 备份文件跨故障域保存并校验。
- 定期从真实文件冷启动。
- 演练后用 event_id 对账缺失与重复。
- 明确 RPO/RTO，不写“开启 AOF 保证不丢”。

## 18. 源码阅读清单

在目标 tag 搜索：

```text
rdbSaveObject / rdbLoadObject 的 OBJ_STREAM 分支
rewriteStreamObject
feedAppendOnlyFile
XADD 命令改写
stream consumer group restore/internal commands
multi-part AOF manifest
backgroundRewriteDoneHandler
```

对每个字段回答：由 RDB 直接保存、由 AOF 命令重建，还是可从其他字段推导。

## 19. 面试追问

问：AOF 保存的是 listpack 原始字节吗？

答：增量 AOF 主要记录可重放命令；RDB/重写按当前状态序列化或生成重建命令。不能把 AOF 理解为内存 dump。

问：为什么 PEL 也必须持久化？

答：否则重启后已投递未确认消息失去 owner/重试状态，组游标又可能已经越过它，造成不可恢复处理缺口。

问：everysec 是否严格最多丢一秒？

答：这是正常硬件和调度下的近似目标，不是所有机器故障、磁盘缓存和 fsync 卡顿下的绝对上界。

