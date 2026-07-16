# 21｜BEAM 内存、调度与故障取证：从 Alarm 追到 Process Mailbox

> 管理 UI 的 Queue 曲线只是结果。底层诊断要把 OS RSS/page cache、BEAM allocator、Process heap/mailbox、binary、ETS、scheduler run queue、Ra/Queue IO 串成时间线。

## 1. 五个内存口径

### OS RSS

操作系统观察到 RabbitMQ VM 的常驻物理内存。它包含 BEAM allocator 已申请但尚未归还 OS 的空闲块，因此业务对象释放后 RSS 不一定立即下降。

### BEAM Allocated/Used

Allocator 从 OS 获取 carrier，再切分给 Process heap、binary、ETS 等。`allocated - used` 是 allocator 内部空闲/碎片，不等于内存泄漏，也不等于可立即归还 OS。

### Erlang Process Heap

每个 Connection、Channel、Queue、Consumer coordination 等 Process 有私有 heap/stack。单 Process GC，不需要扫描其他 Process heap；但大状态/大 mailbox 会让该 Process GC 成本变高。

### Binary Memory

大消息 body 常为 reference-counted off-heap binary。多个 Process 可持有 sub-binary/reference；只要最后一个引用未释放，整块 binary 仍存活。Fanout、Unacked、Publisher Pending、DLX worker、长 mailbox 都可能保留引用。

### ETS

Exchange/Binding/metadata projection、metrics、runtime cache 等可能使用 ETS。ETS 不在某普通 Process heap 中，需单独观察 `ets`/`other_ets`。

## 2. Page Cache 不在 BEAM Breakdown

Stream/Queue 磁盘读取依赖 Linux page cache。Container memory 统计可能把 page cache 计入 cgroup usage，而 RabbitMQ memory breakdown 主要解释 BEAM/RSS 口径。若只给 Pod limit=Broker watermark 没留 page cache，历史重放或 Replica catch-up 会触发 reclaim/swap/OOM。

容量至少分：

```text
container/host memory
= BEAM RSS target
+ filesystem page cache working set
+ kernel/socket/TLS buffers
+ monitoring/sidecar
+ safety margin
```

## 3. Memory Alarm 不是硬上限

高水位是开始阻塞 Publisher 的阈值，不会瞬间停止所有内存增长。在途 frame、已接受消息、Consumer Delivery、Ra replication 和 GC/allocator 都可能继续使用内存。因此 watermark 必须低于 OOM limit 留足制动距离。

容器中优先配置绝对 watermark，避免 VM 错误识别宿主机总内存。

## 4. Mailbox 堆积

Erlang mailbox 是发给 Process 但尚未处理的内部消息队列。Queue Process mailbox 高可能来自 Publish/Ack/Consumer events 速率超过其单核热路径。

诊断对照：

| 指标 | 解释方向 |
|---|---|
| Queue Ready 高、mailbox 低 | 业务积压，Queue 状态已处理 |
| Ready 低、mailbox 高 | 内部操作尚未应用，Queue Process 饱和 |
| reductions 高、mailbox 增长 | Process 有 CPU 工作但追不上 |
| reductions 低、mailbox 高 | 可能 blocked IO/call、scheduler 饥饿或 process suspended |
| scheduler run queue 高 | 全 VM runnable Process 竞争 CPU |

不要在高负载节点频繁全量扫描所有 Process mailbox，诊断本身会制造负载。

## 5. Reduction 与 Scheduler

BEAM 用 reduction 近似衡量函数调用/工作量，Process 用完时间片后被抢占。Scheduler run queue 长表示 runnable Process 多于 scheduler 可及时执行。

CPU 100% 时区分：

- 少数 Queue Process reductions 极高：热点 Queue/priority/路由；
- 全局 scheduler run queue 高：Connection/Channel churn、过多 Queue、加密/协议或普遍负载；
- CPU 不高但 run queue/latency 异常：虚拟机 steal、CPU quota/throttling、NUMA/调度限制；
- IO wait 高：磁盘/存储，不应靠增加 scheduler 修复。

## 6. Process GC

每个 Process 独立 GC，短命 Frame/Command 在年轻 heap 回收。大 mailbox 中消息本身是 Process root；即使逻辑已过期，未处理前不能 GC。Consumer callback 在客户端，但 Broker Channel/Queue Process 仍持有 delivery/ref 状态。

高 GC 检查：

- Queue/Channel Process heap；
- Message properties headers 是否巨大；
- management statistics/metrics collection；
- Connection churn 创建短命 Process；
- large binary reference 是否被小 sub-binary 长期持有。

## 7. Erlang Distribution

Cluster 节点通过 Erlang distribution/专用数据路径通信。Inter-node buffer 满、网络丢包、net tick timeout 会影响 Khepri、Raft、Queue operation forwarding 和节点成员判断。

网络分区证据：

- node logs 的 distribution disconnect/tick timeout；
- inter-node bytes/queue；
- Ra election/term change；
- Quorum Queue member/leader churn；
- Khepri operation timeout；
- OS retransmit/drop/conntrack。

只看客户端 5672 端口延迟不能证明集群复制网络健康。

## 8. IO 证据链

官方 detailed metrics 可拆：read/write/sync/seek ops 与 time、Message Store、Queue Index。结合 OS：

```text
Confirm p99 ↑
→ quorum WAL sync time ↑
→ block device await/p99 ↑
→ no ISR/leader-like churn? CPU normal?
=> storage latency likely root cause
```

若 `io_write_time` 低但 Confirm remote/queue mailbox 高，根因可能是 Follower/network/CPU 而非磁盘。

## 9. Prometheus Cardinality

默认 aggregated `/metrics` 成本低。`/metrics/per-object` 在数万 Queue/Connection 下会产生巨大响应和采集开销。使用 `/metrics/detailed` 选择 family/vhost，或低频抓 memory breakdown。

监控自身反模式：每 5 秒抓全部 per-object metrics → management/Prometheus Process CPU/内存升高 → Broker 延迟 → 误以为业务负载变高。

## 10. 取证顺序

```text
1. 保存时间线与报警，不先重启
2. node/queue/connection coarse metrics
3. 对比正常节点和异常节点
4. 定位 Queue/Process/IO/Network 层
5. 必要时低频 detailed/per-object/rabbitmq-top
6. 保存 effective config、feature flags、logs
7. 明确止血代价后操作
8. 恢复后 eventId/Confirm/Ack 对账
```

重启会清空 mailbox、连接与大量运行态证据；如果容量允许，应先采证。

## 11. `erl_crash.dump`

BEAM 异常退出可生成 `erl_crash.dump`，包含 Process、memory、scheduler 等快照。文件可能巨大且含业务/环境信息，需安全保存，用 Crashdump Viewer 分析：

- slogan/exception；
- memory categories；
- top Process heap/mailbox；
- scheduler state；
- ETS/binary；
- registered processes 和 stack。

Crash dump 是退出时快照，不是持续 profile；需与退出前 metrics/logs 对齐。

## 12. 深度检查题

1. 消息被 Ack 后 BEAM used 下降，RSS 为什么可能不降？
2. Ready 很低但 binary memory 很高有哪些引用来源？
3. Queue mailbox 与业务 Ready Queue 有何本质区别？
4. Stream 节点 Pod OOM 为什么可能看不出 BEAM heap 暴涨？
5. 全量 per-object metrics 为什么会成为故障放大器？

