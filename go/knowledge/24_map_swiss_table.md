# 24 · Go 1.26 Swiss Table map 源码深挖 ⭐⭐⭐

> Go 1.24 起 runtime map 改用 Swiss Table。本章的私有字段以 Go 1.26.4 为准；语言层仍只保证 map 的公开语义。

## 1. 为什么从 hmap 迁移

Swiss Table 把多个槽的状态压进 control word，可并行匹配 fingerprint，改善缓存局部性并减少逐槽分支。旧 `hmap/bmap` 是理解历史演进的材料，不再是当前实现图。

## 2. group、slot 与 control byte

Go 1.26.4 的 `internal/runtime/maps` 每组有 8 个 slot。control byte 的最高位区分空/删除，低 7 位保存 H2 fingerprint；`0x80` 表示 empty，`0xfe` 表示 deleted。当前平均负载上限为每组 7 个元素。

## 3. H1、H2 与探测

完整 hash 被拆成定位 table/group 的 H1 与快速过滤候选的 H2。H2 相等只表示“可能命中”，仍必须执行键相等比较。探测遇到 empty 可证明后续没有该键；deleted 不能终止，否则会漏掉碰撞链后的键。

## 4. 查找、写入与删除

查找先匹配 control，再比较候选键。写入优先覆盖已有键，否则选择可用槽；删除写 tombstone 并清理键值引用。教学代码使用线性逐槽探测，真实 runtime 使用组匹配和更复杂的 probe sequence。

## 5. 目录、table 与增长

大 map 由目录指向一个或多个 table，table 过大时可分裂并更新目录，避免每次增长都复制整个 map。小 map 可采用更紧凑路径。具体阈值属于版本实现。

## 6. 哈希与相等

键必须 comparable。字符串、整数、接口等类型有不同 hash/equal 函数；接口键还要考虑动态类型。NaN 可比较但不等于自身，会带来特殊查找/迭代语义。

## 7. 迭代保证

语言不保证迭代顺序。迭代期间删除未到达的键不会产生该键；新增键是否出现不确定。实现还需在增长/分裂期间维持“不重复返回已见键”等约束。

## 8. 并发边界

无同步并发读写是 data race，runtime 可能报 `concurrent map read and map write`，但 panic 不是同步机制，也不能覆盖所有竞态。用 Mutex、所有权转移或并发专用结构保护。

## 9. 教学模型与 Fuzz

`32_map_swiss_table` 明确不是 runtime 复刻。它保留 fingerprint、empty/deleted、负载阈值和重插不变量，并用状态机 Fuzz 与内置 map 对照，证明操作语义而非性能等价。

```powershell
go test -race ./32_map_swiss_table
go test ./32_map_swiss_table -fuzz FuzzSwissTable -fuzztime 10s
go test ./32_map_swiss_table -run '^$' -bench '.' -benchmem
```

## 10. 工程选择

预估容量可减少增长；键应短小、稳定、比较便宜；不要依赖迭代顺序；删除大量指针值后关注内存滞留；性能结论以当前版本 Benchmark/profile 为准。

## 11. 高频面试题与参考答案

### Q1. Swiss Table 的核心收益？
control word 批量筛选候选并提高缓存局部性，减少昂贵键比较和指针追逐。

### Q2. control byte 保存什么？
空/删除状态或 hash 的 H2 fingerprint；当前实现每组 8 槽。

### Q3. H2 相等就命中吗？
不是，还要比较完整键；fingerprint 只做快速过滤。

### Q4. deleted 为什么不能当 empty？
它可能位于碰撞探测链中，停止会漏掉后面的键。

### Q5. 当前 map 还使用 hmap/bmap 吗？
Go 1.24+ 主实现已迁移到 `internal/runtime/maps` Swiss Table；旧资料需标注版本。

### Q6. map 扩容一定整体搬迁吗？
当前大 map 可通过目录和 table 分裂增长，不应套用旧 bucket 渐进迁移细节。

### Q7. map 迭代为什么无序？
规范不承诺顺序，实现还会受 hash seed、表布局和增长状态影响。

### Q8. 并发只读安全吗？
没有并发写且 map 已安全发布时，多 goroutine 只读可以；任何并发写都需同步。

### Q9. runtime panic 能替代 race detector 吗？
不能。panic 只是部分实现检测，race detector 才分析实际内存访问同步关系。

### Q10. make(map, hint) 是否精确分配 hint？
hint 是容量提示，实现会按组、负载和小 map 策略选择布局。

### Q11. 接口键的成本来自哪里？
需要动态类型信息、对应 hash/equal 函数，装箱和间接访问也可能增加成本。

### Q12. 怎样验证 map 优化？
用代表性键和值、命中率和容量写 Benchmark，再结合 CPU/alloc profile；不比较教学模型得出生产结论。

## 12. 源码地图

- `internal/runtime/maps/group.go`：control/group 匹配。
- `internal/runtime/maps/table.go`：table 操作与增长。
- `internal/runtime/maps/map.go`：目录、小 map 与公开操作主线。
- `internal/abi/map*.go`：map 类型布局常量。

## 一句话总结

Swiss Table 用紧凑 control 元数据与组探测提升局部性；面试和工程判断必须把新版实现与旧 hmap 模型分开。
