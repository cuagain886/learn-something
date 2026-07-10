# 23 · Go 分配器与 GC pacer：从 size class 到内存上限 ⭐⭐⭐

> 基于 Go 1.26.4。GC 可达性语义稳定；size class、span 字段、pacer 算法细节属于当前 runtime 实现。

## 1. 先区分三个问题

分配速率高、存活堆大和 RSS 高不是同一问题。前者增加 allocator/GC 工作，存活堆决定每轮扫描量，RSS 还受闲置页、碎片和操作系统回收影响。诊断时要分别看 alloc_space、inuse_space、heap goal 和内存类别。

## 2. size class 与小对象路径

小对象按大小和指针布局进入 size class。P 的 mcache 从 span 快速分配，常见路径避免全局锁；mcache 用尽时向 mcentral 获取 span。tiny allocator 可把若干无指针小对象合并进一个块，减少元数据成本。

大对象绕过普通小对象 fast path，直接从更高层页分配路径获得 span。分界值与 class 表是实现细节，应查看当前 `runtime/sizeclasses.go`。

## 3. mcache、mcentral、mheap

- mcache 与 P 关联，服务高频本地分配。
- mcentral 按 span class 管理部分/空闲 span，在多个 P 间补充资源。
- mheap 管理全局页和 arena，并与页分配器、清扫器协作。

这不是三层每次都经过的固定调用链：fast path 命中 mcache 时不会触碰全局层。

## 4. 三色标记与写屏障

并发标记期间，mutator 仍在修改对象图。写屏障维护标记不变量，防止新引用让可达对象被漏标。Go 使用混合写屏障思想减少重新扫描栈的需要。写屏障不是普通内存屏障，也不是为了 data race 同步。

## 5. GC pacer 与 assist

pacer 根据存活堆、分配速率、目标增长比例和内存上限设定下一轮目标及后台标记资源。若应用分配过快，会产生 mark assist：分配 goroutine 必须完成一部分标记债务，形成反馈控制。

`GOGC=100` 大致表达相对存活堆增长目标，不是“每 100 MB GC”。`GOMEMLIMIT` 是 soft limit，runtime 会更积极 GC，但在活跃内存或极端分配下仍可能超过。

## 6. sweep 与 scavenger

sweep 把不可达对象所在槽位重新变成可分配空间；scavenger 尝试把不再需要的物理页归还 OS。HeapIdle 不等于已归还，HeapReleased 更接近已释放给 OS 的页。

因此“GC 后 HeapAlloc 降了但 RSS 没立刻降”不自动等于泄漏。

## 7. 碎片与内存滞留

对象可能只保留大 backing array 的一小部分，或少数对象让整个 span 无法回收。常见治理包括复制小结果、缩小缓存上限、清零已消费指针槽、按尺寸分池和避免无界 map/slice。

## 8. sync.Pool 的边界

Pool 用于跨请求复用临时对象，减少分配和 GC 压力。对象可在任意 GC 周期被丢弃，所以 Pool 不是缓存、资源池或所有权存储；放回前要重置状态，不能把敏感数据泄漏给下一用户。

## 9. 实验与诊断

```powershell
go run ./31_allocator_gc_pacer -objects=100000 -size=256 -keep-every=10
$env:GODEBUG='gctrace=1'
go run ./31_allocator_gc_pacer -objects=1000000 -size=128
Remove-Item Env:GODEBUG
go test ./31_allocator_gc_pacer -run '^$' -bench '.' -benchmem
```

Benchmark 比较同一环境下的趋势；对象是否栈分配仍受逃逸、内联和调用上下文影响。

## 10. 工程决策

- 先用 heap/allocs profile 找到保留者和分配热点，再改对象布局。
- 降低 GOGC 可能降内存但提高 CPU；提高 GOGC 相反，必须压测。
- 设置 GOMEMLIMIT 时为非 Go 内存、mmap、cgo 和内核缓存留余量。
- 优化分配次数通常比手工猜 size class 更稳定。

## 11. 高频面试题与参考答案

### Q1. new 的对象一定在堆吗？
不一定。栈或堆由逃逸分析和编译上下文决定，与 new/make 语法不能直接等价。

### Q2. mcache 为什么与 P 而不是 G 绑定？
P 是执行 Go 代码的资源单元，本地 cache 能在其上提供低竞争分配快路径。

### Q3. mcentral 的作用？
按 span class 向 mcache 提供 span，并回收/组织可用 span，是本地 cache 与全局 heap 的中间层。

### Q4. tiny allocator 适合什么对象？
极小且不含指针的对象；具体阈值和组合方式是版本实现。

### Q5. 写屏障等于 CPU memory barrier 吗？
不是。GC 写屏障维护对象图标记不变量；并发可见性由语言内存模型和同步原语解决。

### Q6. 什么是 mark assist？
分配过快的 goroutine 被要求执行部分标记工作，用计算偿还分配产生的 GC 债务。

### Q7. GOGC=100 表示什么？
以本轮存活堆为基线的相对增长目标，不是固定时间或固定字节阈值。

### Q8. GOMEMLIMIT 是硬限制吗？
不是，是 runtime 管理内存的软目标；活跃堆、栈、非 Go 内存等都可能让进程超过它。

### Q9. GC 后 RSS 为什么不立即下降？
对象空间可能变为可复用但页尚未 scavenged，或存在碎片、非 Go 内存和 OS 统计延迟。

### Q10. sync.Pool 为什么不能当缓存？
runtime 可在 GC 时清空其中对象，没有持久性、容量和命中保证。

### Q11. 指针少为什么可能更利于 GC？
扫描器只需跟踪指针槽；无指针 span 可减少扫描工作，但仍要以真实 profile 验证收益。

### Q12. 怎样判断内存泄漏还是正常缓存？
观察多轮 GC 后 inuse heap 的增长趋势、对象类型和保留路径，再结合业务容量上限；单次 RSS 不足以下结论。

## 12. 源码地图

- `runtime/malloc.go`、`msize.go`、`sizeclasses.go`：分配与 class。
- `runtime/mcache.go`、`mcentral.go`、`mheap.go`：缓存、span 与页。
- `runtime/mgc.go`、`mgcpacer.go`：GC 周期与 pacer。
- `runtime/mgcmark.go`、`mbarrier.go`：标记与写屏障。
- `runtime/mgcscavenge.go`：物理页归还。

## 一句话总结

Go 内存性能由分配路径、存活对象图、pacer 反馈和 OS 页回收共同决定；正确优化必须把分配速率、存活堆与 RSS 分开测量。
