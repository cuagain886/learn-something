# listpack 字节布局逐字段拆解

本文固定以 Redis 8.2 `src/t_stream.c` 为源码基线，目标不是背结构图，而是能拿到一段 Stream listpack 后解释每个元素为什么存在、正向和反向迭代如何完成、删除标记为什么不会立刻回收节点。

## 1. 从对象入口开始

`streamNew()` 初始化的 `stream` 至少包含：

```c
stream *s;
s->rax;                  // Stream 主体：master ID -> listpack
s->length;               // 当前未删除条目数
s->first_id;             // 第一个有效条目 ID
s->last_id;              // 历史最大追加 ID
s->max_deleted_entry_id; // 删除过的最大 ID
s->entries_added;        // 历史累计追加数，不因删除回退
s->cgroups;              // 按需创建的消费组索引
```

`length`、`entries_added` 和 listpack 中的 `count/deleted` 不是同一个概念：

- `length` 是整个 Stream 当前有效记录数。
- `entries_added` 是累计加入数，用于组 lag 等元数据推导。
- 宏节点的 `count` 是该节点有效条目数。
- 宏节点的 `deleted` 是仍占据该 listpack 的墓碑条目数。
- `count + deleted` 才是节点中物理 entry 数。

删除后只看 `XLEN` 无法推断 listpack 物理大小。

## 2. rax key 为什么是 16 字节大端 ID

Stream ID 有两个 `uint64_t`：毫秒和序列号。

```c
void streamEncodeID(void *buf, streamID *id) {
    uint64_t e[2];
    e[0] = htonu64(id->ms);
    e[1] = htonu64(id->seq);
    memcpy(buf, e, sizeof(e));
}
```

rax 做字节字典序比较。

若直接使用小端机器内存布局，低有效字节排在前面，字典序不等于整数序。

转成 128 位大端后：

```text
(ms=1, seq=255) < (ms=2, seq=0)
```

字节序比较与 Stream ID 数值比较一致。

rax key 是宏节点 master ID，不是每条消息 ID。

## 3. master entry 的完整布局

新宏节点由以下元素开头：

```text
┌──────────────┬─────────────────────────────┐
│ 元素         │ 含义                        │
├──────────────┼─────────────────────────────┤
│ count        │ 当前有效 entry 数           │
│ deleted      │ 已打墓碑的 entry 数         │
│ num-fields   │ master 字段名数量           │
│ field-1      │ 公共字段名 1                │
│ ...          │ ...                         │
│ field-N      │ 公共字段名 N                │
│ 0            │ master 终止/反向迭代哨兵    │
└──────────────┴─────────────────────────────┘
```

假设第一条事件字段是：

```text
event_id=e1, type=created, payload={...}
```

master entry 保存 `event_id/type/payload` 三个字段名。

注意：master entry 不是第一条消息。

第一条消息仍会作为普通 entry 再编码一次，只是设置 `SAMEFIELDS`，因此只保存三个值。

## 4. SAMEFIELDS entry

源码中的两个标志：

```c
STREAM_ITEM_FLAG_DELETED
STREAM_ITEM_FLAG_SAMEFIELDS
```

字段集合与 master 完全相同且顺序相同时，entry 编码为：

```text
flags
ms-diff
seq-diff
value-1
value-2
...
value-N
lp-count
```

字段名不会重复出现。

`ms-diff/seq-diff` 都相对 master ID，而不是相对上一条 ID。

例如 master ID `1000-0`：

```text
1000-0 -> diff 0,0
1000-1 -> diff 0,1
1002-0 -> diff 2,0
```

因此在一个宏节点内随机定位后，只需 master ID 就能还原完整 ID，不必从节点第一条逐项累加。

## 5. 非 SAMEFIELDS entry

只要字段数量、名称或顺序不同，就不能复用 master：

```text
flags
ms-diff
seq-diff
num-fields
field-1
value-1
...
field-N
value-N
lp-count
```

这会同时多存：

- 一个 `num-fields`。
- N 个字段名。
- 更大的 `lp-count`。

所以“schema 相同但字段顺序随机”也会降低压缩率。

客户端应固定字段顺序，而不只是固定字段集合。

## 6. lp-count 为什么放在尾部

正向读取从 flags 开始，根据标志和字段数跳到下一项。

反向读取从 listpack 尾部开始时，首先遇到 `lp-count`。

它表示当前 entry 在 listpack 中占多少个元素。

迭代器向前跳 `lp-count` 次即可回到 flags。

若 SAMEFIELDS：

```text
lp_count = numfields + 3
```

其中 3 是 flags、ms-diff、seq-diff。

若字段不相同：

```text
lp_count = numfields        // values
         + 3                // flags + two ID deltas
         + numfields + 1    // field names + num-fields
```

尾部计数让 `XREVRANGE` 不必从节点头重新扫描每条记录。

## 7. 宏节点何时分裂

追加前读取尾 listpack 的字节数。

满足任一条件则新建节点：

```text
lp_bytes + 本次字段值总长度 >= stream-node-max-bytes
count + deleted >= stream-node-max-entries
```

第二个条件包含 deleted。

这意味着大量墓碑会让当前节点停止接收新条目，即使有效 count 很少。

此外实现有硬上限，防止配置把单个 listpack 放大到无法编码或造成整数溢出。

新节点预分配一小块空间以减少每次 XADD 的 realloc；节点满时再 shrink-to-fit。

## 8. 为什么估算不能只加 payload

实际条目成本包括：

```text
listpack 元素编码头
ID delta
flags 与 lp-count
字段名（非 SAMEFIELDS）
rax 宏节点及 key
zmalloc 分配粒度
Stream key/Redis object
Consumer Group 与 PEL 元数据
内存碎片
```

短字符串可能以内联整数或短长度编码存储，长字符串需要更长长度头。

同一个 100 字节 JSON 在不同字段结构下总成本不同。

必须用真实数据测 `MEMORY USAGE` 斜率：

```text
B = (写入 N 条后的 usage - 空流 usage) / N
```

N 应足够大，使宏节点与分配器阶梯被平均。

## 9. 墓碑读取路径

`XDEL` 设置 `DELETED` 标志后：

- 范围迭代器仍经过该物理 entry。
- `skip_tombstones` 为真时不向客户端返回。
- 节点 deleted 增加、count 减少。
- Stream `length` 减少。
- `last_id` 不回退，后续 ID 仍必须更大。

因此随机删除比例上升会增加节点内无效扫描。

到达压缩阈值时，Redis 可重写节点并去掉墓碑。

头部裁剪若能移除整个 rax 节点，通常比随机 XDEL 更便宜。

## 10. 手工推演实例

假设节点 master ID 为 `1000-0`，master fields 为 `[type, order]`。

三条数据：

```text
1000-0 type=create order=O1
1000-1 type=paid   order=O1
1001-0 type=ship   order=O1 extra=x
```

前两条设置 SAMEFIELDS：

```text
[SAME,0,0,create,O1,5]
[SAME,0,1,paid,O1,5]
```

第三条字段不同：

```text
[NONE,1,0,3,type,ship,order,O1,extra,x,10]
```

这里的数字只表示元素数量推演，不代表 listpack 实际字节长度。

如果删除第二条，它仍可能物理存在：

```text
[DELETED|SAME,0,1,paid,O1,5]
```

## 11. 调试验证

在测试版本打开 `streamLogListpackContent()` 或用调试器遍历：

1. 固定字段顺序写 100 条。
2. 改变一条字段顺序。
3. 比较 flags 和 lp-count。
4. 删除中间 30 条。
5. 检查 count/deleted 与 `XLEN`。
6. 继续追加直到新建 rax 节点。
7. 对比 `raxSize(s->rax)` 与 `s->length`。

预期：rax 节点数远小于消息数；变更字段顺序的条目不使用 SAMEFIELDS；删除后物理 entry 仍可能可见于内部布局。

## 12. 面试追问

问：为什么 listpack 不能无限做大？

答：节点越大压缩率可能越好，但追加 realloc、边界精确裁剪、墓碑压缩、fork COW 和节点内扫描成本都增加；格式本身也有长度上限。

问：master 字段变化后会更新 master 吗？

答：已有宏节点以创建时字段为 master；后续不同 schema 条目走完整字段编码。创建新宏节点时才选择新的 master。

问：为什么 ID 采用相对 master 而非相对前一条？

答：相对 master 允许从 entry 与节点 key 独立还原 ID，反向迭代和节点内定位不依赖重放所有前项。

