# 21 · Go runtime 调度器源码：G/M/P、运行队列与抢占 ⭐⭐⭐

> 本章基于 Go 1.26.4。语言保证与 runtime 私有实现必须分开：`go` 语句会启动 goroutine 是语言行为；G/M/P、runq 和 sysmon 是当前实现。

## 1. 从生产现象开始

调度问题通常表现为 CPU 已满但吞吐不升、goroutine 数持续增长、长尾延迟、系统调用后并行度下降或某个锁定线程的组件卡住。第一步不是背 G/M/P，而是收集 goroutine profile、trace、`/sched/*` 指标和 `GODEBUG=schedtrace=1000,scheddetail=1`。

## 2. G、M、P 分别是什么

- G 保存 goroutine 的栈、状态、等待原因和调度上下文。
- M 抽象 OS thread，真正执行机器指令。
- P 持有执行 Go 代码需要的调度资源、局部 runq、mcache 等。

M 必须绑定 P 才能执行普通 Go 代码；M 进入阻塞系统调用时，P 可以交给其他 M。`GOMAXPROCS` 控制 P 的数量，不等于 goroutine 数或进程线程上限。

## 3. 创建与入队

源码入口主要位于 `$GOROOT/src/runtime/proc.go`。`newproc` 创建 G，初始化入口和栈上下文，再把 runnable G 放入当前 P 的局部队列。局部队列减少全局锁竞争；溢出时一批任务转移到全局队列。

这解释了为什么“创建 goroutine 很便宜”不等于“无限创建没有成本”：G 仍需要栈、调度元数据、队列位置和最终回收路径。

## 4. runq 与 work stealing

每个 P 有局部 runq，runtime 也有全局队列。寻找工作时会综合局部队列、全局队列、网络轮询、计时器和其他 P 的队列。空闲 P 可以从其他 P 偷取一部分 runnable G，而不是每次都争用全局锁。

局部性提高吞吐，但不提供业务公平性。runtime 可以改变队列细节，业务不能依赖 goroutine 的固定执行顺序。

## 5. findRunnable 与停车/唤醒

`findRunnable` 是理解调度器数据源的主线：它寻找可执行 G；找不到工作时，M 可能与 P 分离并停车。新任务、timer、netpoll 或 GC 工作可以唤醒执行资源。runtime 还要避免同时唤醒过多线程造成惊群。

## 6. 系统调用与 netpoll

可能阻塞的 syscall 会进入 `entersyscall` 路径，runtime 可以把 P 转交出去；返回时通过 `exitsyscall` 尝试重新获得 P。支持非阻塞轮询的网络 fd 通常把 G 停在 runtime netpoll，而不是长期占用一个 M。

这也是普通文件 IO、cgo、网络 IO 行为不同的根源之一。

## 7. sysmon、timer 与抢占

sysmon 不需要 P，负责观察长时间 syscall、触发抢占、推动计时器和 netpoll 等。Go 1.14 起支持基于信号的异步抢占，解决缺少函数调用的长循环可能长期占用 P 的问题。

抢占不是任意机器指令处粗暴暂停。runtime 与编译器共同维护安全点和栈图，确保 GC 与栈扫描安全。

## 8. LockOSThread 与 cgo

`runtime.LockOSThread` 把当前 G 固定在当前 M，适合线程局部状态、GUI 或某些外部库。忘记解锁会限制调度自由；cgo 长调用可能需要额外线程。它们不是“禁止使用”，但必须进入容量与关闭设计。

## 9. 实验怎样解释

`29_runtime_scheduler` 的 Checksum 与 Parallelism 无关，证明业务结果不应依赖调度顺序。Benchmark 比较的是任务拆分和 goroutine 协调成本；不能把一次机器上的快慢比例当成 runtime 常数。

观察命令：

```powershell
$env:GODEBUG='schedtrace=1000,scheddetail=1'
go run ./29_runtime_scheduler -mode=cpu -tasks=10000 -iterations=10000
Remove-Item Env:GODEBUG
go test -run='^$' -bench=. -benchmem ./29_runtime_scheduler
go test -trace trace.out ./29_runtime_scheduler
go tool trace trace.out
```

## 10. 工程决策

- CPU 密集任务先以 `GOMAXPROCS` 为并行度基线，再用 Benchmark 调整。
- IO 并发仍要有界；netpoll 降低线程成本，不解决下游过载。
- goroutine 数是结果指标，队列等待时间和可运行延迟更接近问题本质。
- 调度问题要结合 CPU、锁、block profile 和 trace，单看 goroutine 数不足以定责。

## 11. 高频面试题与参考答案

### Q1. G、M、P 的关系？
G 是待执行任务，M 是线程，P 持有执行 Go 代码所需资源；M 绑定 P 后执行 G。

### Q2. GOMAXPROCS 限制什么？
主要限制同时执行 Go 代码的 P 数，不直接限制 goroutine 或 OS thread 总数。

### Q3. 为什么每个 P 有本地队列？
降低全局锁竞争并提高局部性；全局队列仍用于溢出和周期性公平检查。

### Q4. work stealing 做什么？
空闲 P 从繁忙 P 获取一部分 runnable G，使负载重新均衡。

### Q5. goroutine 阻塞在网络 IO 会占一个线程吗？
通常不会长期占用；可轮询 fd 会进入 netpoll，G 停车，fd ready 后再变 runnable。

### Q6. 阻塞 syscall 时 P 怎么办？
runtime 可让 M 与 P 分离，P 交给其他 M；syscall 返回的 M 再尝试获得 P。

### Q7. sysmon 为什么不需要 P？
它必须在普通 Go 调度资源紧张时仍能推动抢占、syscall 处理和计时工作。

### Q8. 异步抢占解决什么问题？
让缺少协作安全点的长计算循环也能被调度和 GC 打断，降低饥饿和停顿风险。

### Q9. goroutine 是公平调度吗？
语言不保证固定顺序或严格公平；业务正确性不能依赖一次 select 或队列选择顺序。

### Q10. goroutine 越多吞吐越高吗？
不是。过多任务增加内存、队列、缓存失效和调度成本，还可能压垮下游。

### Q11. LockOSThread 有什么风险？
减少 runtime 迁移 G/M 的自由，错误生命周期可能导致线程资源增长或线程局部状态泄漏。

### Q12. 如何诊断调度延迟？
先看 trace 的 runnable latency、processor 时间线和阻塞原因，再结合 schedtrace、CPU、mutex/block profile 与 runtime 指标。

## 12. 源码地图

- `runtime/proc.go`：newproc、runq、findRunnable、schedule、sysmon。
- `runtime/runtime2.go`：g、m、p 等核心结构。
- `runtime/preempt.go`：抢占状态与信号路径。
- `runtime/netpoll*.go`：平台网络轮询。
- `runtime/metrics/description.go`：稳定指标名称与定义。

## 一句话总结

调度器的价值不是让 goroutine “免费”，而是用 G/M/P、局部队列、stealing、netpoll 和抢占把大量并发映射到有限执行资源；工程上仍必须控制任务数量与生命周期。
