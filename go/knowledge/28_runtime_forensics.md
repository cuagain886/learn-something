# 28 · Go runtime 综合事故诊断：从症状到证据链 ⭐⭐⭐

## 1. 分诊原则

先固定时间窗口和用户影响，再区分 CPU、调度、锁、IO、GC/内存与外部依赖。不要同时打开所有高开销工具；先用指标和 goroutine profile 缩小范围，再选 pprof 或 trace。

## 2. CPU 与调度饥饿

CPU profile 看采样热点及 flat/cum；trace 看 G 从 runnable 到 running 的延迟、P 时间线和抢占。CPU 满可能是有效计算，也可能是自旋、序列化、GC assist 或锁竞争的副作用。

## 3. goroutine 泄漏

持续按等待原因增长才是关键信号。比较多次 goroutine profile，按相同栈聚合，检查 channel、network、select、Mutex 和 context 生命周期。一次峰值不能证明泄漏。

## 4. 锁与阻塞

mutex profile 统计竞争等待，block profile 覆盖 channel、select 等阻塞。高 cum 指向下游调用链，高 flat 指向直接消耗点。采样率本身会带来成本。

## 5. GC、分配与堆滞留

allocs profile 找累计分配热点，heap/inuse 找仍存活对象和保留路径。结合 heap goal、GC CPU、assist、gctrace 和 GOMEMLIMIT，区分高分配、真泄漏、缓存和未归还页。

## 6. panic、fatal 与崩溃栈

panic 可在同一 goroutine defer 边界 recover；runtime fatal 通常不可恢复。事故实验用子进程隔离 panic/deadlock，父进程检查退出码、marker 和超时，避免测试进程被终止。

## 7. pprof 与 trace 的选择

pprof 适合聚合热点；trace 适合时间顺序、调度、GC、网络与 goroutine 因果。先用 pprof 找“哪里多”，用 trace 回答“何时等待、谁唤醒”。

## 8. 证据链模板

1. 指标确认异常窗口；2. profile/trace 定位资源类别；3. 源码和调用链解释机制；4. 最小复现；5. 修复后用同负载回归吞吐、P99、资源和错误率。

## 9. 安全实验

```powershell
go run ./36_runtime_forensics -scenario=mutex -duration=200ms
go run ./36_runtime_forensics -scenario=cpu -duration=200ms -cpu-profile cpu.pprof -trace trace.out
go run ./36_runtime_forensics -danger=panic
go test -race ./36_runtime_forensics
```

profile/trace 写临时或显式路径，用后清理；生产环境设置采样窗口、访问控制和磁盘上限。

## 10. 高频面试题与参考答案

### Q1. pprof 与 trace 如何选择？
聚合 CPU/内存热点先 pprof；调度时间线和 goroutine 因果用 trace。
### Q2. flat 与 cum 区别？
flat 是函数自身采样，cum 包含下游调用累计。
### Q3. goroutine 多就是泄漏吗？
不是，要看持续趋势、等待栈、生命周期和负载是否回落。
### Q4. mutex 与 block profile 区别？
mutex 聚焦锁竞争；block 覆盖 channel/select 等阻塞等待。
### Q5. heap 与 allocs profile 区别？
heap 看当前存活/占用，allocs 看累计分配热点。
### Q6. CPU 满但 profile 无业务热点怎么办？
检查 GC、runtime、内核/cgo、采样窗口和是否有自旋，再结合系统级工具。
### Q7. 如何证明内存泄漏？
多轮 GC 后存活对象持续增长，并能从 profile 找到稳定保留路径。
### Q8. trace 为什么不能长期开？
数据量和运行开销较高，适合受控窗口而非无限采集。
### Q9. recover 能抓 runtime fatal 吗？
通常不能；fatal 直接终止进程，应靠子进程/进程管理器隔离。
### Q10. schedtrace 能回答什么？
观察 P/M/G 队列与状态快照，适合发现 runnable 堆积和线程/syscall 异常。
### Q11. 修复性能问题怎样验收？
相同负载比较吞吐/P99/资源/profile，并确认正确性和错误率未退化。
### Q12. 为什么诊断要保留环境信息？
Go 版本、GOOS/GOARCH、GOMAXPROCS、负载与配置会改变 runtime 行为和工具输出。

## 11. 源码地图

`runtime/metrics`、`runtime/pprof`、`runtime/trace`、`runtime/proc.go`、`runtime/mgc*.go`、`runtime/sema.go`。

## 一句话总结

runtime 排障不是背工具，而是把症状、时间窗口、profile/trace、源码机制和修复回归串成可复现证据链。
