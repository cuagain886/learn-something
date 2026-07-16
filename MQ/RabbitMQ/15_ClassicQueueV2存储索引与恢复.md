# 15｜Classic Queue v2 存储、索引与恢复：单副本队列如何管理磁盘状态

> Classic Queue 4.x 不再提供镜像复制，但它仍是复杂的持久队列实现。核心问题是：Queue 顺序/投递状态如何索引，Message Body 如何落盘，Ack 后如何回收，以及崩溃后如何重建一致状态。

## 1. Queue Process 与 Backing Queue

典型实现主线：

```text
rabbit_amqqueue_process
  → rabbit_priority_queue (若启用)
    → rabbit_variable_queue
      → rabbit_classic_queue_index_v2
      → rabbit_msg_store / per-queue stores
```

Queue Process 串行处理逻辑操作，Backing Queue 管理 Ready/Unacked、内存/磁盘位置和索引。实现模块会随版本变化，协议不承诺文件格式；禁止依赖内部文件做应用读取。

## 2. 为什么需要 Queue Index 与 Message Store

逻辑队列项至少需要：

- sequence/position；
- message id 或 body reference；
- persistent/transient；
- delivery/ack 状态；
- expiry、priority 等元数据。

消息 body 可能嵌入 per-queue store 或由共享 message store 保存，Queue index 记录队列顺序和引用。这样同一消息 Fanout 到多个 Classic Queue 时可在适用情况下复用 body 引用，但每个 Queue 仍有独立顺序/状态索引。

## 3. v2 Index 的 Segment 思想

Classic Queue Index v2 将顺序条目组织为 segment 文件。固定/紧凑条目让恢复和查找不必为每条消息创建大量 Erlang 对象。活跃 segment 接收新状态，旧 segment 可在消息全部 Ack/过期后删除或压缩。

要区分：

- Queue index：某 Queue 中消息顺序与状态；
- Message store：body bytes；
- Journal/恢复标记：非正常关闭后确定哪些操作需要重放/扫描。

## 4. 内存与磁盘状态

现代 Classic Queue v2 会积极把消息移到磁盘，只在内存保留较小工作集。消息并非只有“在 RAM”或“在 disk”两个互斥状态：

- 内存中可能只有 index/metadata；
- body 在 page cache，看似磁盘读但物理 IO 未发生；
- Unacked body 可能由 Consumer 和 Broker 同时引用；
- transient message 也可能为内存控制暂写磁盘，但重启时不承诺保留。

管理 UI 的 messages_ram 只是一个观察维度，不能直接等于 OS RSS 或 page cache。

## 5. Publish 路径

```text
Queue Process receives delivery
→ assign queue sequence
→ decide persistence/body location
→ append body and/or index entry
→ update in-memory ready structure
→ maybe deliver immediately to consumer
→ notify channel for publisher confirm when durable condition met
```

无 Consumer 时进入 Ready；有 credit Consumer 时可能 publish-delivered，直接变为 Unacked，避免先完整进入 Ready 再取出的额外操作。即便消息立即投递，persistent 恢复语义仍要求对应持久状态正确记录。

## 6. Ack 与垃圾回收

Ack 后 Queue index 标记条目完成。Body 不能总立即物理删除：

- segment 中还有其他 live entries；
- shared store body 可能被其他 Queue 引用；
- 当前 reader 可能持有文件引用；
- 批量回收比每 Ack 一次 truncate 更高效。

后台 compaction/GC 根据引用计数和 live ratio 移动仍存活数据、删除旧文件。于是“消息 Ack”是逻辑删除边界，不等于磁盘字节瞬间下降。

## 7. Crash Recovery

正常关闭可写入干净恢复状态；非正常崩溃后需要扫描 index/store 尾部、校验 entry、重建内存结构和引用关系。恢复时间受：

- Queue/segment 数；
- 未完成写入和未清理数据量；
- 磁盘随机/顺序 IO；
- 大量小 Queue 与拓扑 churn；
- Message Store compaction 状态；
- 是否发生文件损坏/权限错误。

单副本 Classic Queue 的文件永久损坏没有其他 Queue Replica 自动补齐，这是与 Quorum 的根本区别。

## 8. Ready/Unacked 与磁盘回收

Unacked 仍是 live message，不能回收。Consumer prefetch 很大时，Ready 下降但 Unacked 上升，磁盘不一定释放；Consumer 断开后这些消息重新 Ready。

TTL 到期、max-length drop 和 DLX 也要经过逻辑删除/转移，物理空间回收滞后。容量监控应看文件系统趋势而不是期望计数下降即时回收。

## 9. Priority Queue 的成本

Classic Priority Queue 在内部为优先级维护多个逻辑子队列/状态结构（具体实现随版本），优先级级数越多，CPU/内存和调度成本越高。`x-max-priority=255` 通常不是好设计；少数等级配合 Consumer priority/业务隔离更可控。

优先投递会破坏全局 FIFO；如果业务同时声称严格顺序和优先级，必须定义冲突时哪个优先。

## 10. 为什么 Classic 不等于“纯内存更快”

现代实现主动落盘，durable 与 non-durable 的吞吐差异不能用旧版经验推断。真正影响包括：

- persistent 属性和 Confirm；
- Consumer 是否跟得上；
- message size/Fanout；
- page cache 与磁盘；
- Queue 数、Priority、TTL/DLX；
- fsync/batching 和节点资源。

必须用目标版本和真实 workload 基准测试。

## 11. 源码阅读路线

1. `rabbit_amqqueue_process` publish/deliver/ack handler；
2. `rabbit_variable_queue` 状态字段和 in/out queues；
3. `rabbit_classic_queue_index_v2` segment entry layout；
4. `rabbit_msg_store` client write/read/refcount；
5. publish-delivered 快路径；
6. ack/purge/TTL/max-length 如何更新 index；
7. compaction 与旧文件切换；
8. recovery scan 与 corruption handling。

## 12. 深度检查题

1. Ack 后为什么磁盘空间不立即下降？
2. Ready=0、Unacked=100万时 body 是否可回收？
3. Classic Queue Process 重启如何找回 Ready 顺序？
4. shared message store 的引用计数为什么与 Fanout 有关？
5. 为什么不能用文件备份单个 `.rdq`/index 文件来获得一致 Queue 快照？

