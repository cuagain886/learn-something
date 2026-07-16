# XREAD 阻塞唤醒与事件循环源码

## 1. 问题不是“BLOCK 会不会卡线程”

正确问题是：

- 当前无数据时，客户端状态存在哪里？
- 一个客户端等待多个 key，反向索引如何维护？
- XADD 何时把 key 标记 ready？
- 唤醒时为什么必须重新检查数据而不能直接返回？
- 超时、断连、事务、脚本和 Cluster 对阻塞有什么限制？

## 2. 非阻塞快速路径

`XREAD` 先解析所有 key 与起始 ID。

对每个 Stream 查找严格大于指定 ID 的 entry。

任一 key 有可返回数据时，立即构造响应。

`COUNT` 限制单个/总体返回的具体规则应按版本测试。

这条路径不会把 client 标记为 blocked。

## 3. 进入阻塞的前置条件

只有以下条件同时满足才阻塞：

```text
指定 BLOCK
当前所有目标 Stream 都没有符合条件的数据
执行上下文允许阻塞
客户端仍有合法超时时间
```

在 MULTI/EXEC、Lua/Function 或某些内部执行上下文中，阻塞命令不能真的挂起整个执行栈，通常退化为立即返回空或受限制。

原因是 Redis 不能把一个原子脚本执行暂停后让其他命令插入。

## 4. 客户端侧状态

概念上 blocked client 需要保存：

```text
blocked type = stream
等待的 key 列表
每个 key 对应的 last ID
XREADGROUP 的 group/consumer/noack
COUNT
绝对超时时刻
原始数据库编号
```

只保存 key 不够。

唤醒时必须知道每个 key 的读取下界和 group 语境。

## 5. 服务端反向索引

服务端还需要：

```text
key -> waiting clients
```

否则每次 XADD 都要扫描所有 blocked clients。

一个 client 等待多个 key，会同时出现在多个 key 的等待列表中。

解除阻塞时必须从所有反向列表移除，防止悬空指针和重复唤醒。

## 6. ready key 不是立即递归执行

XADD 修改 Stream 后将 key 放入 ready-key 集合。

随后在安全的事件循环阶段处理 ready keys。

不在 `streamAppendItem()` 深处直接遍历并回复所有阻塞客户端，原因包括：

- 避免写命令调用栈无限膨胀。
- 将数据修改与客户端调度解耦。
- 同一事件循环批次可合并重复 ready 标记。
- 保持命令执行完成后的状态一致性。

## 7. 为什么唤醒后重新执行读取条件

ready 只表示 key 发生了可能相关的变化，不保证每个等待者都能得到数据。

例如：

- 多个组消费者等待同一条新消息。
- 第一个被服务者推进组游标并建立 PEL。
- 后续同组等待者已没有这条 new message。
- 一个 client 等待多个 key，其中只有一个有新数据。
- key 在 ready 与服务之间被删除或类型变化。

所以唤醒处理必须重新查询 Stream，而不是缓存 XADD payload 直接广播。

## 8. 普通 XREAD 与组读取的唤醒差异

独立 `XREAD` 等待者各有自己的 last ID。

同一新条目可能返回给所有满足条件的独立读者。

`XREADGROUP ... >` 在同一 group 内是竞争分发：

- 第一个服务的 consumer 获得若干条。
- group last-delivered 前进。
- 其他 consumer 再检查时读取后续条目或继续阻塞。

不同 group 之间仍各自获得一份。

## 9. 惊群的真实边界

若 1000 个独立 XREAD 等待同一 key，一次 XADD 可能让 1000 个客户端都有可返回数据。

这不是无意义唤醒，因为独立读者语义就是 fan-out。

若 1000 个同组 consumer 等待一条数据，大部分重新检查后会继续阻塞，存在调度成本。

生产应限制每组 consumer 数量，并用批量与合理 worker 数匹配吞吐。

## 10. 超时处理

`BLOCK 5000` 通常转换为绝对超时，进入服务端时间事件/超时检查。

超时发生时：

1. 从所有 key 等待列表注销 client。
2. 清理 Stream-specific blocked state。
3. 回复 nil。
4. 恢复客户端可读状态。

超时和 ready 可能在相邻事件循环发生，但 Redis 主线程串行决定哪个先处理，不会并发修改同一 client。

客户端仍要接受网络层超时早于/晚于服务端 BLOCK 超时。

## 11. 为什么推荐有限 BLOCK

`BLOCK 0` 服务端可永久等待，但客户端应用会遇到：

- 优雅关闭无法及时检查 stopping。
- Cluster 拓扑刷新不及时。
- 中间网络设备空闲连接回收。
- 客户端 socket timeout 与服务端无限阻塞冲突。
- 健康检查无法复用连接。

2—5 秒有限 BLOCK 通常用少量空轮询换取生命周期可控。

## 12. 断开连接清理

blocked client 断开时必须走 unblock 清理：

- 从 key 等待列表删除。
- 从超时结构删除。
- 释放保存的 ID/group 参数。
- 不推进任何普通 XREAD offset。

若是 XREADGROUP 已经在断开前完成投递和 PEL 修改，只是响应丢失，则消息已 pending。

连接清理不能回滚已经完成的命令。

## 13. 响应背压

唤醒后返回大批数据，响应先进入客户端输出缓冲。

慢客户端会导致：

- 输出缓冲增长。
- Redis 内存增加。
- 超过 client-output-buffer-limit 后连接被关闭。
- 组消息已经进入 PEL，但客户端可能没收到完整响应。

因此 PEL 也覆盖“服务端已交付但响应未可靠到达应用”的情况。

## 14. COUNT 的公平性

过大 COUNT：

- 单 client 一次占用更多解码 CPU。
- 单响应字节更大。
- 同组其他等待者拿到更少批次。
- 本地 in-flight/PEL 激增。

过小 COUNT：RTT、命令解析与上下文切换开销高。

选择依据应是：

```text
batch_process_p99 < claim_min_idle 的安全比例
batch_bytes < 输出缓冲与网络可接受上限
prefetch <= 本地有界处理能力
```

## 15. XREADGROUP 阻塞前的状态修改

如果当前已有消息，命令直接投递并修改 PEL。

只有没有消息才注册阻塞。

注册阻塞本身不应推进 group ID 或创建 PEL。

否则每个空轮询都会改变消费进度。

唤醒后才在实际取得消息时写 group 状态。

## 16. Cluster 路由

blocked connection 建在 key 所属主节点。

slot 迁移或主从切换时：

- 旧连接可能关闭或返回重定向。
- client 必须重新发现主节点。
- 普通 XREAD 用实际 last ID 恢复。
- XREADGROUP 用 group 状态恢复并处理 PEL。

绝不能在重连后把普通 reader 的位置重设为 `$`，否则断线期间消息被跳过。

## 17. 源码导航

跨版本搜索以下概念：

```text
xreadCommand
blockForKeys / blockForKeysWithFlags
BLOCKED_STREAM
signalKeyAsReady
handleClientsBlockedOnKeys
serveClientsBlockedOnStreamKey
unblockClient
replyToBlockedClientTimedOut
```

函数名可能变化，调用阶段不变：查询 → 注册 → ready → 重新查询 → 回复/继续阻塞。

## 18. 断点实验

1. 在空 Stream 执行 BLOCK 30s。
2. 断在 block 注册函数，检查 client 保存的 ID。
3. 另一个连接 XADD。
4. 断在 signal ready。
5. 观察写命令完成后才进入 blocked client 服务。
6. 同组启动两个等待者，只写一条。
7. 观察一个得到消息，另一个重新阻塞。
8. 在响应写出前断开客户端，检查 PEL 已存在。

## 19. 常见错误结论

- 错：BLOCK 会让 Redis 主线程 sleep。
- 对：客户端被挂起，主线程继续事件循环。
- 错：XADD 直接把 payload push 给等待者。
- 对：标记 key ready，服务阶段重新按读取条件查询。
- 错：连接断开则本次 group 投递回滚。
- 对：若命令已修改 PEL，断连只造成响应不确定。
- 错：大量 blocked clients 没成本。
- 对：连接、反向索引、超时、唤醒和输出缓冲都有成本。

