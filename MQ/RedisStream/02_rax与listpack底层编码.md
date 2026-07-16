# rax 与 listpack 底层编码

## 两级结构而不是“一条消息一个对象”

Redis 为避免每条小消息都承担大量指针和对象头开销，将 Stream 主体组织为近似两级结构：

```text
stream
└── rax（按宏节点首 ID 索引）
    ├── master-id A -> listpack [entry A, entry A+1, ...]
    ├── master-id B -> listpack [entry B, entry B+1, ...]
    └── master-id C -> listpack [entry C, entry C+1, ...]
```

rax 是压缩 radix tree，键是编码后的 ID；叶子值指向包含一批相邻条目的 listpack。这样既能按 ID 定位宏节点，又能把小字段紧凑连续存储。

## 为什么需要 rax

纯链表从任意 ID 范围起点查找需要线性扫描；纯平衡树若每条记录一个节点，会有指针、分配器和缓存未命中开销。rax 利用 ID 前缀共享，适合有序二进制键；定位到宏节点后再在连续 listpack 中解码。

复杂度不能只背 `O(log N)`：实际成本包括 rax 路径长度、宏节点内扫描、返回 M 条记录的解码和网络输出。因此范围读取总体至少包含 `O(M)`，超大 `COUNT` 会长时间占用事件循环。

## master entry 与差值编码

一个 listpack 通常以 master entry 保存宏节点公共信息，后续条目相对 master ID 编码毫秒和序列差值，降低重复。字段布局也会针对“字段名集合相同”的常见事件进行压缩：后续条目可以复用 master 字段名，只保存值；字段集合不同则需要携带自己的字段名和值。

这解释了两个生产建议：

1. 同一 Stream 尽量保持 schema 稳定，字段名集合频繁变化会削弱压缩。
2. payload 不应塞入巨大 JSON；大值不仅占内存，还会增加复制、AOF、网络和解析开销。

具体标志位和布局随 Redis 版本演进，应以目标版本 `src/t_stream.c` 的 listpack 编解码逻辑为准。

## listpack 的物理特征

listpack 是紧凑连续字节序列，元素以长度编码相邻排列，避免 ziplist 的级联更新问题。优势是空间局部性和较小元数据；代价是：

- 中间插入/删除可能移动内存；Stream 主要追加以规避插入成本。
- 解码第 M 个元素通常需要遍历前序元素，故宏节点不能无限大。
- 删除条目可能先形成逻辑删除，只有达到条件才重写或移除宏节点。
- 大 listpack 修改会产生复制字节和 fork 期间 Copy-on-Write 页。

## 宏节点大小的权衡

Redis 使用配置控制每个 Stream 节点的近似字节或条目限制（常见配置项为 `stream-node-max-bytes`、`stream-node-max-entries`）。

| 节点更小 | 节点更大 |
|---|---|
| rax 节点更多、元数据高 | 压缩率和局部性通常更好 |
| 单次重写/删除成本较小 | 节点内扫描和复制成本增大 |
| 裁剪粒度更细 | 近似裁剪更高效但超限幅度可能更大 |

不要脱离消息大小盲调。应用真实 schema 做基准：记录 `MEMORY USAGE`、写入吞吐、范围读 P99、裁剪耗时和 RSS 碎片率。

## 删除为何未必立即等比例释放内存

`XDEL` 面对 listpack 中间条目时，立即重建整个宏节点可能比保留删除标记更贵。实现可记录已删除数，在删除比例达到阈值时压缩宏节点；若整个宏节点可淘汰，裁剪则能直接从 rax 移除它。因此：

```text
删除 1 万条 != RSS 立刻下降对应字节
```

还存在 allocator arena、碎片和 RSS 不归还操作系统等因素。判断要同时看 `XLEN`、`MEMORY USAGE key`、`used_memory`、`used_memory_rss` 和 `mem_fragmentation_ratio`。

## PEL 是另一套索引

Consumer Group 的 PEL 不嵌在消息 listpack 中。组级 PEL 和消费者级 PEL 需要按消息 ID 找到投递元数据，包括 owner、最后投递时间、投递次数。因此消息主体被裁剪时，PEL 引用不一定自然消失。这种状态分离是理解“pending 还在但 payload 为空”的关键。

## 源码验证路径

在官方源码中按以下顺序阅读：

1. `src/t_stream.c`：`stream`、`streamID`、宏节点编解码、迭代器。
2. `src/rax.h` / `src/rax.c`：rax API、迭代和删除。
3. `src/listpack.h` / `src/listpack.c`：紧凑元素编码与遍历。
4. 搜索配置名，定位节点拆分阈值如何进入写入路径。

不要从类型声明看到 rax 就推断“一条 entry 一个 rax node”；应在调试器中观察 rax size、listpack 元素和 `XLEN` 的数量差异。

## 可复现实验

写入两批各 10 万条：A 固定字段名，B 随机增加字段名。分别比较：

```redis
MEMORY USAGE stream:a SAMPLES 0
MEMORY USAGE stream:b SAMPLES 0
XINFO STREAM stream:a FULL COUNT 1
```

再逐条 `XDEL` 一半与使用 `XTRIM` 删除头部作比较。预期头部整宏节点裁剪更容易回收，随机中间删除的内存下降不线性。实验结论必须绑定 Redis 版本、配置和 allocator。

