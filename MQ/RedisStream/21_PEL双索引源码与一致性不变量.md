# PEL 双索引源码与一致性不变量

本文解释为什么 PEL 既能按组扫描，又能按消费者读取；claim 如何在不复制 NACK 对象的情况下转移 owner；删除消息主体为何可能保留 pending 引用。

## 1. 四个核心对象

以 Redis 8.2 源码概念化：

```c
stream {
    rax *rax;       // 消息宏节点
    rax *cgroups;   // group name -> streamCG
}

streamCG {
    streamID last_id;
    long long entries_read;
    rax *pel;       // message ID -> streamNACK
    rax *consumers; // consumer name -> streamConsumer
}

streamConsumer {
    sds name;
    rax *pel;       // message ID -> same streamNACK
    mstime_t seen_time;
    mstime_t active_time;
}

streamNACK {
    mstime_t delivery_time;
    uint64_t delivery_count;
    streamConsumer *consumer;
    ...
}
```

实际字段随版本变化，关系比字段名更重要。

## 2. 同一个 NACK 被两个 rax 引用

一条 pending 记录：

```text
group.pel[id] --------┐
                      ├──> streamNACK(owner=C1,time,count)
C1.pel[id] -----------┘
```

组级索引用于：

- XPENDING 全组范围扫描。
- XCLAIM/XAUTOCLAIM 按 ID 查找。
- group 销毁时清理全部 pending。

消费者级索引用于：

- XREADGROUP 显式 ID 读取自己的历史。
- XPENDING 按 consumer 过滤。
- 删除 consumer/统计 pending。

如果复制两份 NACK 元数据，claim 时必须同步两份时间和次数，容易不一致。

共享对象减少重复，但要求生命周期管理严格。

## 3. 新投递如何创建 PEL

`XREADGROUP ... >` 对每条新消息大致执行：

1. 推进 group `last_id`。
2. 更新 entries-read/lag 辅助信息。
3. 创建或取得 consumer。
4. 分配 streamNACK。
5. 设置 delivery_time 为当前命令时间。
6. 设置 delivery_count 初值。
7. 设置 owner consumer。
8. 插入 group.pel。
9. 插入 consumer.pel。
10. 返回 payload。

只有在 `NOACK` 时跳过 PEL。

这解释 XREADGROUP 为什么是写命令。

## 4. ID key 仍需大端编码

PEL 需要按消息 ID 范围扫描。

因此 rax key 同样使用可按字节序排序的 Stream ID 编码。

XPENDING `start/end/count` 可以从 start seek，而不是遍历整个 PEL 后排序。

复杂度仍包含返回项数量和 consumer 过滤成本。

## 5. XACK 删除路径

对每个 ID：

1. 在 group.pel 查 streamNACK。
2. 不存在则该 ID 返回未确认计数 0。
3. 从 `nack->consumer->pel` 删除 ID。
4. 从 group.pel 删除 ID。
5. 释放 NACK 及引用元数据。

删除顺序必须保证释放 NACK 前没有第二个索引继续引用。

XACK 不访问或删除 Stream 主体 entry。

所以 payload 已被裁剪时，XACK 仍可能只依据 PEL ID 完成清理。

## 6. XCLAIM 所有权转移

找到 group.pel[id] 后检查：

- ID 是否仍在 PEL。
- 当前 idle 是否达到 min-idle。
- FORCE 等选项是否允许创建缺失 pending。
- RETRYCOUNT/TIME/IDLE 等参数是否合法。

转移 owner：

```text
remove id from oldConsumer.pel
nack.consumer = newConsumer
insert same nack into newConsumer.pel
update delivery_time
update delivery_count（受选项影响）
```

group.pel 的 ID 到 NACK 映射不需要换对象。

Redis 内部 owner 唯一，但外部执行者可能有两个。

## 7. 为什么 claim 后旧消费者仍能 XACK

XACK 的身份由 key、group、ID 决定，不要求调用者声明 consumer。

旧消费者持有 ID，恢复后可以向同一 group XACK。

即使 owner 已转移，XACK 仍可能删除新 owner 的 PEL 项。

这再次说明 PEL owner 不是 fencing token。

如果业务必须拒绝旧执行者提交，需要外部状态机版本或租约 epoch。

## 8. XAUTOCLAIM 的扫描游标

XAUTOCLAIM 接收起始 ID，沿 group.pel rax 扫描。

它需要跳过 idle 未达阈值的项。

因此：

```text
扫描数量 >= 返回数量
```

COUNT 限制希望返回的量，并不意味着只检查 COUNT 个节点。

调用方必须使用返回的 next-start-id 继续，而不是用最后一个消息 ID 自行加一。

到 `0-0` 代表本轮扫描完成；下一轮定时任务可重新从头检查后来变老的项。

## 9. deleted IDs 的特殊返回

在支持的版本中，XAUTOCLAIM 可返回 PEL 中存在但 Stream entry 已删除的 ID，并清理相应 dangling PEL。

客户端返回类型常包含：

```text
next cursor
claimed messages
deleted IDs
```

如果客户端库只暴露前两项或版本协议解析错误，悬空清理会不可观测。

升级 Redis 与客户端时要做兼容测试。

## 10. Consumer 创建不是注册会话

consumer 是组内持久元数据，不与 TCP 连接绑定。

连接断开：

- consumer 对象仍在。
- 其 PEL 仍在。
- seen/active 时间不会等价为进程存活证明。

同名 consumer 可由另一连接继续读取其 pending。

随机 consumer 名会制造元数据垃圾。

## 11. seen-time 与 active-time

不同 Redis 版本对“看到 consumer”和“成功交互”的时间字段有所扩展。

运维不能仅凭 inactive 时间删除 consumer：

- 它可能有 pending。
- 它可能在处理长任务而没有发 Redis 命令。
- 网络分区后进程仍可能执行外部副作用。

安全删除条件至少是：实例确认退出、PEL 已转移/清空、超过观察窗口。

## 12. group 销毁为什么是 O(PEL)

`XGROUP DESTROY` 不只是删除一个名字。

它要释放：

- group.pel 中的 NACK。
- 每个 consumer 及 consumer.pel。
- Redis 8.2 引用跟踪结构中的 group-entry 关联。

PEL 百万级时销毁可能阻塞主线程明显时间。

生产不能把 destroy/recreate 当日常“清 offset”操作。

## 13. Stream 8.2 的 group 引用跟踪

为支持 `KEEPREF/DELREF/ACKED`，Stream 需要知道 entry 被哪些 group pending 引用。

源码中可见 `cgroups_ref`、`streamLinkCGroupToEntry()`、`streamCleanupEntryCGroupRefs()` 等概念。

这使删除策略能够：

- KEEPREF：删 payload，保留 PEL。
- DELREF：删 payload并清所有组引用。
- ACKED：只有所有组已确认时才删。

代价是新增引用元数据与更新路径。

阅读旧版本源码时看不到同样结构，不能倒推旧版本行为。

## 14. ACKED 的语义陷阱

“所有组已确认”依赖当前存在的 group 和引用状态。

需要明确：

- 从未读取该条目的落后 group 是否阻止删除。
- 新建 group 的起点如何影响历史。
- 已销毁 group 是否仍参与判断。
- SETID 跳过数据是否等同确认。

不要用口号替代目标版本实验。

## 15. PEL 内存模型

每条 pending 不只一个 ID：

```text
group rax 节点/路径
consumer rax 节点/路径
streamNACK allocation
owner pointer
delivery time/count
8.2 group reference metadata
allocator overhead
```

领取百万消息不 ACK，即使 payload 很小，PEL 也可能消耗大量内存。

容量压测必须包含真实 in-flight 上限。

## 16. 不变量清单

任意时刻应满足：

1. group.pel 的每个 NACK owner 非空或处于版本定义的 NACK zone。
2. 正常 owner 的 consumer.pel 存在同 ID。
3. consumer.pel 指向 group.pel 同一个 NACK。
4. ACK 后两处都不存在该 ID。
5. claim 后旧 consumer.pel 不再有 ID，新 consumer.pel 有。
6. PEL 存在不推出 payload 存在。
7. payload 存在不推出任何 group PEL 存在。

## 17. 故障窗口推演

Redis 命令内部修改是原子的，客户端不会看到“只插 group.pel 未插 consumer.pel”。

但复制切换可能回退整个命令状态：

- 新主没收到 XREADGROUP：组位置和 PEL 都回退，消息再次成为 new。
- 新主收到投递但没收到 XACK：消息再次 pending。
- claim 未复制：owner 回到旧 consumer。

应用幂等必须覆盖这些状态回退。

## 18. 源码断点

搜索并按目标版本确认：

```text
streamCreateCG
streamLookupCG
streamCreateConsumer
streamCreateNACK
streamDelConsumer
xackCommand
xclaimCommand
xautoclaimCommand
streamReplyWithRangeFromConsumerPEL
```

每次命令前后打印 group.pel、两个 consumer.pel 和 NACK 地址。

如果两个索引指针相同，便验证了共享 NACK 模型。

## 19. 实验矩阵

| 操作 | group PEL | old consumer PEL | new consumer PEL | payload |
|---|---:|---:|---:|---:|
| 新投递给 C1 | 有 | 有 | 无 | 有 |
| claim 给 C2 | 有 | 无 | 有 | 有 |
| XACK | 无 | 无 | 无 | 有 |
| XDEL KEEPREF | 有 | 有 | 无 | 无 |
| XDELEX DELREF | 无 | 无 | 无 | 无 |

最后两行仅在对应版本和策略下验证。

## 20. 面试追问

问：为什么每个 consumer 都有 PEL，group 又有 PEL？

答：前者支持按 owner 快速读取和统计，后者支持全组按 ID 范围、claim 与整体管理；两者通常索引同一 NACK 元数据。

问：claim 能否保证旧消费者不再提交？

答：不能。它只改变 Redis 元数据 owner，无法中断旧进程；业务存储需要幂等或 fencing。

问：PEL 数量为什么要有硬上限？

答：它代表本地/业务处理中数量，也对应双索引内存和恢复扫描成本；无限预取会同时恶化内存、误 claim 和恢复时间。

