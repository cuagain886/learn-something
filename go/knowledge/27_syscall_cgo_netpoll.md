# 27 · syscall、cgo 与 runtime netpoll 源码深挖 ⭐⭐⭐

> Linux amd64 是源码主线，Windows IOCP 与 macOS/BSD kqueue 做模型对照。默认代码跨平台，raw epoll 只在 Linux 构建。

## 1. 从 goroutine 到内核

Go 调用网络 API 时会经过 `net`、`internal/poll`、runtime pollDesc 和平台 netpoll。用户态调用最终进入系统调用，但 runtime 在边界维护 G/M/P 状态，使阻塞不必冻结整个调度器。

## 2. entersyscall 与 exitsyscall

可能长期阻塞的 syscall 会让当前 G/M 进入 syscall 状态，P 可转交其他 M。返回线程尝试重新获得 P，失败时把 G 变为 runnable。普通文件 IO 未必像 socket 一样可被 netpoll 管理。

## 3. 非阻塞 fd 与 pollDesc

网络 fd 通常设置为 nonblocking。读写得到 would-block 后，G 在 pollDesc 对应方向等待；内核报告 ready 时，netpoll 把等待者转为 runnable。ready 只说明操作可能前进，实际读写仍要处理短读、EAGAIN 和关闭竞态。

## 4. epoll、IOCP 与 kqueue

- Linux epoll 返回 fd readiness，常见模型是 level/edge triggered。
- kqueue 用 filter/event 表达 readiness 和其他内核事件。
- Windows IOCP 更接近异步操作完成通知，而非简单 readiness。

所以“Go netpoll 就是 epoll”只在 Linux 实现层局部成立，跨平台抽象是 runtime netpoll 接口。

## 5. fd 生命周期

fd 数字可被 OS 复用。关闭、deadline 和并发读写必须通过 pollDesc 序列/状态避免把旧事件交给新 fd。业务层仍要关闭连接、限制并发并处理半关闭。

## 6. cgo 与调度

cgo 调用进入外部 C 世界，runtime 需要维护调用栈、线程和 GC 可见性。长 C 调用可能增加 OS thread；C 指针规则禁止让 C 长期保存含 Go 指针的 Go 内存。回调、线程局部状态和信号处理进一步增加边界复杂度。

本章只有显式 `-tags=cgo_lab` 才编译 `import "C"`，默认测试不依赖 C 编译器。

## 7. 实验

loopback 使用长度前缀和 deadline，验证完整读写与资源收敛；Linux 专项用 pipe+epoll 观察一次 readiness。交叉编译只能证明 Linux 文件可编译，不能声称 epoll 已实际运行。

```powershell
go test -race ./35_syscall_cgo_netpoll
go run ./35_syscall_cgo_netpoll -mode=platform
go test ./35_syscall_cgo_netpoll -run '^$' -bench '.' -benchmem
```

## 8. 工程决策

所有 IO 都要有 context/deadline；连接数和请求数都要有界；不要假设一次 Read/Write 完整；cgo 集中在小边界并建立独立容量、超时与故障监控。

## 9. 高频面试题与参考答案

### Q1. 网络 goroutine 是否一连接一线程？
通常不是；等待网络 fd 的 G 停在 netpoll，少量线程执行大量就绪连接。

### Q2. netpoll 是 epoll 吗？
netpoll 是 runtime 跨平台接口，Linux 后端使用 epoll，其他平台不同。

### Q3. fd ready 等于读一定成功吗？
不等于，可能短读、EAGAIN、关闭或被其他 goroutine 消费。

### Q4. 阻塞 syscall 会占住 P 吗？
runtime 可让 P 与阻塞 M 分离，交给其他 M。

### Q5. 普通文件为何可能占线程？
很多文件系统操作不能像 socket 一样用 readiness poll，需要阻塞 syscall。

### Q6. deadline 如何进入 netpoll？
internal/poll 把 deadline 与 timer/pollDesc 关联，超时会唤醒等待 G 并返回错误。

### Q7. IOCP 与 epoll 最大模型差异？
IOCP偏完成通知，epoll偏就绪通知；runtime 把二者映射到统一等待语义。

### Q8. 为什么关闭 fd 有复用风险？
数字可能迅速分配给新资源，旧事件必须通过序列状态识别并丢弃。

### Q9. cgo 为什么可能增加线程？
外部调用可能阻塞 M，runtime 为保持 P 的执行能力创建/唤醒其他 M。

### Q10. C 能长期保存 Go 指针吗？
通常不能，尤其指向含 Go 指针的内存；必须遵守当前 cgo pointer rules。

### Q11. cgo 调用开销固定吗？
不是，受调用转换、参数、阻塞、回调和平台影响，必须 Benchmark。

### Q12. 如何诊断 netpoll 问题？
结合 goroutine stack、trace network blocking、fd/连接指标、deadline 错误和系统调用跟踪。

## 10. 源码地图

`runtime/netpoll.go`、`netpoll_epoll.go`、`netpoll_windows.go`、`netpoll_kqueue.go`、`runtime/cgocall.go`、`internal/poll/fd_poll_runtime.go`。

## 一句话总结

netpoll 把不同内核 IO 模型转换成 G 的停车与唤醒；syscall 和 cgo 则要求 runtime 正确交接 P、线程与 GC 边界。
