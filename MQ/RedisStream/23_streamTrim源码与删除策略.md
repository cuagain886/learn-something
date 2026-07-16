# streamTrim 源码与删除策略

## 1. 四个维度必须一起看

一次裁剪由四个正交维度决定：

```text
边界：MAXLEN / MINID
精度：= / ~
预算：LIMIT / unlimited
引用：KEEPREF / DELREF / ACKED（Redis 8.2+）
```

只说“近似裁剪删除整个 listpack，所以快”只覆盖 KEEPREF 的主要快速路径。

## 2. 从头部 rax 开始

Stream 只从旧端裁剪。

`streamTrim()`：

1. rax iterator seek `^` 到第一个宏节点。
2. 读取节点 listpack 的有效 `entries`。
3. 检查 MAXLEN 是否已经满足。
4. 检查 LIMIT 预算。
5. 判断整个节点是否越过删除边界。
6. 能整节点删除则 free listpack + remove rax node。
7. 否则视精度/引用策略决定停止或逐 entry 处理。

它不从尾部扫描，因为删除目标是最老数据。

## 3. MAXLEN 的整节点判定

设 Stream 当前有效长度 `L`，头节点有效条目 `E`，目标 `M`。

只有：

```text
L - E >= M
```

才能整节点删除而不低于目标长度。

若 `L=1050`、`E=100`、`M=1000`：

```text
1050 - 100 = 950 < 1000
```

近似裁剪不会删该节点，因此最终仍是 1050。

这正是 `~` 超限的来源之一。

## 4. MINID 的整节点判定

需要取得宏节点最后一条物理/有效边界 ID。

若节点最后 ID `< minid`，整个节点符合删除条件。

若 minid 落在节点中间：

- 精确模式逐 entry 删除小于 minid 的条目。
- 近似 KEEPREF 模式停止，保留整个节点。

所以实际最老 ID 可早于 MINID。

## 5. LIMIT 是工作预算，不是最终长度

删除前检查：

```text
deleted + current_node_entries > limit
```

可能直接停止，不处理该节点。

因此一次 XTRIM 后：

- XLEN 可能仍大于 MAXLEN。
- 仍可能有 ID 小于 MINID。
- 后续 XADD/XTRIM 再继续偿还裁剪债务。

监控要测超限幅度和持续时间。

## 6. KEEPREF 快速路径

Redis 8.2 的默认 KEEPREF 保留所有组 PEL 引用。

节点符合边界时可：

```text
lpFree(lp)
raxRemove(node)
s->length -= entries
deleted += entries
```

无需访问每条消息和每个 group。

这是整节点裁剪吞吐高的原因，也是 dangling PEL 产生的原因。

## 7. DELREF 为什么不能总走整节点

DELREF 要删除所有 group 中对被删 entry 的 PEL 引用。

即使整个 listpack 可删，仍需知道其中哪些 ID 被哪些组引用。

Redis 8.2 引用跟踪结构可以帮助定位，但工作量不再只是一个 raxRemove。

删除成本与 entry/reference 数量相关。

## 8. ACKED 为什么必须逐条判断

ACKED 只删除已被所有相关组确认的 entry。

同一宏节点中可能：

```text
entry A: 所有组已确认
entry B: group-2 pending
entry C: group-3 尚未读取
```

无法因为节点整体早于 MINID 就无条件 free。

必须逐 entry 判断是否满足策略。

近似参数不能绕过正确性检查。

## 9. 节点内精确裁剪

迭代 listpack entry：

- 解码 flags 与 ID delta。
- 跳过已有墓碑。
- 判断 MAXLEN剩余数量或 ID 边界。
- 根据引用策略决定是否允许删除。
- 标记 DELETED。
- 更新 master count/deleted。
- 更新 Stream length。
- 必要时清理 group refs。

此时 listpack 字节通常仍存在，物理回收要等节点重写或整体移除。

## 10. first_id 更新

裁剪后 `first_id` 必须指向新的第一条有效 entry。

不能简单取第一个 rax key：

- rax key 是 master ID。
- master entry 不是消息。
- 节点前部可能有墓碑。

需要迭代并跳过 tombstone。

空 Stream 时 first_id/last_id 的语义也要按实现维护；历史 last_id 通常不能回退，以保证新 ID 单调。

## 11. max_deleted_entry_id 与 entries_added

Redis 用历史累计和最大删除 ID 帮助推导组 lag。

任意删除会破坏“ID 区间内每条都存在”的简单假设。

因此 lag 在某些 SETID、删除/裁剪组合下可能 unknown。

监控系统必须保留 unknown，而不是写成 0。

## 12. 随机 XDEL 与头部 XTRIM

随机 XDEL：

- 定位宏节点。
- 标记某一 entry。
- 节点仍留在 rax。
- 墓碑散布导致扫描浪费。

头部 XTRIM：

- 常能删除连续完整宏节点。
- rax 与 listpack 一起释放。
- 内存回收更直接。

隐私删除必须用 XDEL/XDELEX 时，应接受与保留裁剪不同的成本模型。

## 13. 内存为什么不线性下降

四层原因：

1. 逻辑层：entry 只打墓碑。
2. 宏节点层：listpack 尚未压缩。
3. allocator 层：释放块留在 arena。
4. OS 层：RSS 页面未归还。

观测：

```text
XLEN
MEMORY USAGE key
used_memory
used_memory_rss
allocator_frag_ratio
mem_fragmentation_ratio
```

不要用单一 RSS 判断 XDEL 是否生效。

## 14. fork 期间裁剪的 COW

RDB/AOF rewrite 子进程共享父进程内存页。

父进程精确修改大 listpack 会复制相关页。

大量逐 entry 裁剪可能造成：

- COW bytes 增长。
- RSS 峰值。
- 内存压力下 fork 失败/OOM。

整节点移除也会修改 allocator/rax 页面，但通常少于重写大量节点的字节放大。

应错开大规模治理任务与持久化重写，并用真实实验验证。

## 15. 裁剪与 PEL 安全下界

安全 cutoff 不能只看 group last-delivered：

```text
group 已交付到 1000-0
但 100-0 仍 pending
```

不能只看最小 pending：

```text
group last-delivered=100-0
101-0..1000-0 尚未交付
PEL 为空
```

需要同时考虑：

- 每组 last-delivered/lag。
- 每组最小 pending。
- 尚未交付的历史。
- 恢复窗口和组 SLA。
- 目标版本引用策略。

## 16. 多组 ACKED 的治理问题

一个废弃 group 会让 ACKED 长期无法删除。

运维流程必须管理 group 生命周期：

1. 标记 group 停用。
2. 停止其消费者。
3. 决定 pending 是处理、转移、审计放弃还是重建。
4. 明确销毁 group 的业务含义。
5. 再让 ACKED retention 前进。

自动删除“inactive group”可能误删长任务组，不能只凭时间。

## 17. 性能基准矩阵

至少测试：

| 变量 | 取值 |
|---|---|
| 节点大小 | 4KB / 16KB / 64KB |
| entry 大小 | 100B / 1KB / 16KB |
| 模式 | MAXLEN / MINID |
| 精度 | `=` / `~` |
| 引用 | KEEPREF / DELREF / ACKED |
| PEL 占比 | 0 / 10% / 90% |
| fork | 无 / RDB / AOF rewrite |

输出 P50/P99、主线程 CPU、删除条数、命令耗时、COW、MEMORY USAGE 和最终超限。

## 18. 事故推演

生产 50k/s，MAXLEN 设 1,000,000，近似裁剪。

正常只保留约 20 秒。

数据库故障 3 分钟时：

- 消费者快速领取导致 PEL 扩大。
- Stream 主体继续裁剪。
- 早期 pending payload 被 KEEPREF 删除。
- DB 恢复后 claim 只得到 dangling ID。

根因不是“Redis 丢消息”，而是保留窗口按正常容量而非故障恢复时间设计。

## 19. 面试回答模板

回答近似裁剪时至少包含：

1. rax 宏节点 + listpack。
2. 整节点符合边界才快速删除。
3. 边界落节点内部时允许超限。
4. LIMIT 进一步限制工作。
5. Redis 8.2 引用策略会改变是否可整节点快速删除。
6. PEL 与 payload 生命周期可能分离。

