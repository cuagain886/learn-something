# Go runtime 源码深挖八讲设计规格

## 1. 背景

仓库已经包含三组 Go 学习材料：

- `go/code/01_hello` 至 `go/code/20_testing`：基础语法、类型系统、并发和工程化示例。
- `go/code/21_memory_model` 至 `go/code/28_production_service`：内存模型、结构化并发、HTTP、编译器、性能诊断和生产服务等核心八讲。
- `go/knowledge/01_slice_internals.md` 至 `go/knowledge/20_production_service.md`：与代码配套的底层原理和面试材料。

现有课程已经能解释 Go 的主要稳定语义，但对 runtime 私有实现仍以概览为主。学习者还缺少一条从生产现象出发，使用工具复现，再沿 `$GOROOT/src` 定位实现，最后回到工程决策和面试表达的完整路线。

本阶段新增代码课程 29–36 和知识文档 21–28，深入调度器、栈与 ABI、分配器与 GC、Swiss Table map、channel/select/semaphore、接口与泛型、系统调用/cgo/netpoll，以及 runtime 综合故障诊断。

## 2. 已确认的范围决策

完整后续路线采用“底层源码 + 分布式生产工程”组合方案，并拆成两个独立阶段：

1. 先完成本规格定义的 29–36：runtime 与源码深挖。
2. 验收后再为 37–44 编写独立规格：数据库、缓存、消息队列、RPC、分布式一致性、服务发现、可观测性和综合项目。

运行环境采用混合策略：默认课程和测试自包含；第二阶段的真实 PostgreSQL、Redis、消息队列和 RPC 集成使用 Docker 与显式构建标签，不影响默认 `go test ./...`。

本阶段以 Go 1.26.4 和 Linux amd64 runtime 实现为源码讲解主线，同时对照 Windows/IOCP 与 macOS/kqueue。默认代码与测试必须能在当前 Windows amd64 环境运行。

## 3. 目标

完成本阶段后，学习者应当能够：

1. 从 goroutine 创建解释到入队、调度、抢占、阻塞、唤醒和退出。
2. 解释连续栈扩缩容、栈复制、调用帧、寄存器 ABI 和 defer/panic 的主要执行路径。
3. 解释小对象分配、size class、mcache/mcentral/mheap、GC pacer、写屏障和 scavenger 的协作关系。
4. 结合 Go 1.26.4 源码说明 Swiss Table map 的查找、插入、删除、增长、迭代和并发边界。
5. 沿 runtime 源码解释 channel、select、semaphore、Mutex、RWMutex 和 Cond 的阻塞与唤醒。
6. 区分接口装箱、itab、类型元数据、泛型 shape/dictionary 和编译器去虚拟化。
7. 判断系统调用、文件描述符、netpoll、cgo 和锁定 OS 线程对 G/M/P 的影响。
8. 使用 runtime/metrics、trace、pprof、schedtrace、gctrace 和崩溃栈诊断综合故障。
9. 在回答面试题时明确区分语言保证、标准库契约、当前 runtime 实现、平台差异和版本变化。

## 4. 非目标

本阶段不包含以下内容：

- 不完整复刻 Go runtime、编译器或操作系统内核。
- 不从教学代码导入 `runtime/internal` 或 `internal/runtime` 包。
- 不使用 `go:linkname` 绕过可见性访问 runtime 私有符号。
- 不把私有结构字段、函数名或具体数值描述成稳定语言规范。
- 不要求默认测试安装 C 编译器、Docker、数据库或第三方服务。
- 不在本阶段实现 37–44 的分布式工程内容。
- 不无关重构已有 01–28 课程；只更新学习索引和必要的版本说明。

## 5. 总体目录

新增代码目录：

```text
go/code/
├── 29_runtime_scheduler/
├── 30_goroutine_stack_abi/
├── 31_allocator_gc_pacer/
├── 32_map_swiss_table/
├── 33_channel_select_semaphore/
├── 34_interface_generics_runtime/
├── 35_syscall_cgo_netpoll/
└── 36_runtime_forensics/
```

新增知识文档：

```text
go/knowledge/
├── 21_runtime_scheduler.md
├── 22_goroutine_stack_abi.md
├── 23_allocator_gc_pacer.md
├── 24_map_swiss_table.md
├── 25_channel_select_semaphore.md
├── 26_interface_generics_runtime.md
├── 27_syscall_cgo_netpoll.md
└── 28_runtime_forensics.md
```

29–35 彼此独立，不能互相导入教学代码。36 是综合诊断实验，可以复用前七讲的设计思想，但仍在自己的目录内实现最小故障场景，避免章节耦合。

## 6. 单章交付契约

每个代码主题至少包含：

- `main.go`：直接运行的实验入口，文件头列出学习目标、先修知识、运行命令和安全边界。
- 一个或多个实现文件：把实验逻辑、观察逻辑和输出展示分离，便于测试。
- `_test.go`：覆盖正常、边界、错误和并发路径；平台差异使用构建标签或显式跳过说明。
- `BenchmarkXxx`：验证本章至少一个关键性能结论，使用 `b.Loop` 并报告分配。
- 可选受控子进程入口：隔离 deadlock、fatal error、panic、崩溃栈等不能在测试进程内安全触发的实验。
- 对应知识文档：原理、源码地图、实验、工程决策、常见误区、至少 12 道递进面试题及参考答案。

每章采用同一学习闭环：

```text
生产现象 → 最小复现 → 工具观察 → runtime 源码调用链
        → 稳定语义/版本实现区分 → 工程方案 → Benchmark → 面试追问
```

## 7. 源码引用规则

源码分析以本机 Go 1.26.4 的 `$GOROOT/src` 为事实基线。文档中的结论必须标记为以下四类之一：

| 类型 | 含义 | 写作要求 |
|---|---|---|
| 语言或标准库契约 | 跨版本应保持的公开语义 | 优先引用规范、公有 API 或测试可观察行为 |
| 当前 runtime 实现 | Go 1.26.4 的私有实现 | 标注版本，并给出 `$GOROOT/src` 文件与符号入口 |
| 平台实现 | Linux、Windows 或 macOS 专有路径 | 明确 GOOS/GOARCH，不外推到其他平台 |
| 实验观察 | 工具或 Benchmark 得到的结果 | 记录命令和环境，不把单次数字写成普遍定律 |

代码可以构造简化教学模型帮助理解队列、探测或状态迁移，但必须明确标注“教学模型”，不能声称与 runtime 实现逐行等价。

## 8. 八个主题的详细设计

### 8.1 29_runtime_scheduler

核心内容：

- G、M、P 的职责、状态和生命周期。
- `newproc`、本地 runq、全局 runq、work stealing 和 `findRunnable` 的主线关系。
- sysmon、网络轮询、计时器、阻塞系统调用和 P 的交接。
- 协作式安全点与异步抢占的边界。
- `GOMAXPROCS`、`LockOSThread` 和 cgo 对调度的影响。

源码地图以 `runtime/proc.go`、`runtime/runtime2.go`、`runtime/preempt.go` 和平台线程实现为主。实验使用 `runtime.GOMAXPROCS`、`runtime.LockOSThread`、`runtime/trace`、`GODEBUG=schedtrace` 和受控 CPU/阻塞任务观察调度性质，不断言固定执行顺序。

测试验证任务完整性、取消与无泄漏；Benchmark 对比不同并行度、共享队列竞争和任务粒度的成本。

### 8.2 30_goroutine_stack_abi

核心内容：

- goroutine 初始栈、连续栈增长、栈复制、指针调整与栈收缩。
- `morestack`、栈检查、安全点和禁止栈增长的边界。
- Go 内部 ABI、寄存器传参、调用帧、返回值和栈图。
- 闭包捕获、defer、panic/recover 与栈展开。
- 递归、超大局部变量和深调用链的工程风险。

源码地图以 `runtime/stack.go`、`runtime/panic.go`、`internal/abi` 和编译器 ABI 配置为主。实验结合递归/迭代实现、`runtime.Stack`、逃逸输出和 `go tool objdump`；不持有跨栈增长失效的裸 `uintptr`。

测试验证递归边界、panic 清理和结果一致性；Benchmark 对比递归与迭代、defer 与显式清理及不同参数形态。

### 8.3 31_allocator_gc_pacer

核心内容：

- size class、tiny allocator、小对象和大对象分配路径。
- mcache、mcentral、mheap、span、页分配和碎片。
- GC pacer、assist、标记工作、写屏障、STW 边界和 sweep。
- scavenger、物理内存归还、`GOGC` 与 `GOMEMLIMIT` 的协作。
- 对象池、内存滞留、指针密度和减少分配的真实收益。

源码地图以 `runtime/malloc.go`、`runtime/msize.go`、`runtime/mcache.go`、`runtime/mcentral.go`、`runtime/mheap.go`、`runtime/mgc.go`、`runtime/mgcpacer.go` 和 `runtime/mgcscavenge.go` 为主。

实验使用 `runtime.ReadMemStats`、`runtime/metrics`、`runtime/debug`、pprof 和 gctrace。GC/清扫时机具有非确定性，测试只验证最终性质和合理范围，不依赖一次 GC 的精确时间。

### 8.4 32_map_swiss_table

核心内容：

- Go 1.26.4 `internal/runtime/maps` 的 Swiss Table 组织方式。
- control byte、group、H1/H2、探测序列、空槽和删除标记。
- table 增长、目录分裂、负载控制和小 map 路径。
- 键的哈希与相等语义、NaN、接口键和不可比较键。
- 迭代顺序、迭代期间修改、并发读写边界与 race detector。
- 旧版 `hmap/bmap` 材料与新版实现的迁移说明。

代码包含一个明确标注的简化 Swiss Table 教学模型，用于验证探测、删除和扩容不变量；公开 map 实验用于观察语言保证。测试包含模型属性测试与 Fuzz，Benchmark 对比命中/未命中、预分配和不同键类型。

### 8.5 33_channel_select_semaphore

核心内容：

- `hchan`、`sudog`、缓冲区、sendq/recvq 和直接传递。
- 发送、接收、关闭、nil channel 和阻塞唤醒路径。
- select case 排列、poll order、锁顺序、注册、唤醒和公平性边界。
- runtime semaphore 与 OS futex/semaphore 的分工。
- Mutex 饥饿模式、RWMutex、Cond 和 WaitGroup 的 runtime 支撑。

源码地图以 `runtime/chan.go`、`runtime/select.go`、`runtime/sema.go`、`runtime/lock_futex.go` 及 `sync` 包实现为主。测试验证协议性质和竞态安全；概率性公平只作为重复实验的观察结果展示，不作为测试通过条件，也不要求均匀分布或固定选择顺序。

### 8.6 34_interface_generics_runtime

核心内容：

- eface、iface、itab、类型元数据、方法集和动态派发。
- 接口装箱、复制语义、typed nil、比较与哈希路径。
- 泛型实例化中的 shape、dictionary、方法表达式与类型断言。
- 泛型、接口、反射的选择边界及其分配和调用成本。
- 编译器内联与去虚拟化如何改变最终成本。

源码地图以 `runtime/iface.go`、`internal/abi/type.go`、编译器泛型实例化与 SSA 去虚拟化路径为主。实验使用公开反射 API、编译器诊断、符号表和反汇编；不把私有内存布局硬编码成业务契约。

测试验证 typed nil、方法集和泛型语义；Benchmark 对比具体调用、泛型调用、接口调用和反射调用，并用编译器输出解释差异。

### 8.7 35_syscall_cgo_netpoll

核心内容：

- 用户态/内核态切换、阻塞 syscall、文件描述符生命周期和非阻塞 IO。
- Linux epoll 主线及 runtime pollDesc、ready、wait 与 goroutine 唤醒。
- Windows IOCP 与 macOS/BSD kqueue 的模型差异。
- `internal/poll`、`net` 与 runtime netpoll 的边界。
- cgo 调用、额外线程、调度切换、指针传递规则和回调风险。

源码地图以 `runtime/netpoll.go`、`runtime/netpoll_epoll.go`、`runtime/netpoll_windows.go`、`runtime/netpoll_kqueue.go`、`runtime/cgocall.go` 和 `internal/poll/fd_poll_runtime.go` 为主。

默认实验使用 loopback TCP、`net.Pipe` 和跨平台文件 IO。Linux 专项文件使用 `//go:build linux`。真实 cgo 示例使用 `//go:build cgo && cgo_lab`，只有显式 `-tags=cgo_lab` 才参与构建，避免默认测试依赖本地 C 工具链；同时提供不启用 cgo 时的解释入口。

### 8.8 36_runtime_forensics

本章是受控 runtime 事故实验室，包含：

- CPU 自旋与调度饥饿。
- goroutine 泄漏、channel 阻塞和网络等待。
- Mutex 竞争与锁顺序死锁。
- 高频分配、GC 压力、堆滞留和缓存膨胀。
- panic、fatal error、崩溃栈和信号终止。
- runtime 指标、pprof、trace、schedtrace 和 gctrace 的联合证据链。

故障场景由场景名和持续时间驱动，默认只运行安全的短时观察。会挂死或终止进程的场景必须在子进程中执行，并由父测试设置超时、检查退出码和稳定输出标记。生成的 profile/trace 文件写入临时目录并自动清理。

最终练习要求学习者根据一组症状选择工具、收集证据、定位 runtime 层原因并提出工程修复，而不是只背工具命令。

## 9. 平台与构建策略

- 默认 `go test ./...` 在 Windows、Linux 和 macOS 上不需要外部服务。
- Linux 专项源码使用 `//go:build linux`，其他平台提供同名抽象的安全替代或明确的 unsupported 结果。
- cgo 实验必须同时要求 `cgo` 和 `cgo_lab` 标签；默认构建不编译 `import "C"` 文件。
- amd64 是汇编与 ABI 讲解主线；其他架构文档只描述稳定差异，不复制所有汇编实现。
- 平台不支持时返回可识别错误或在专项测试中 `Skip`，不得静默伪造成功结果。

## 10. 错误处理与非确定性实验

- 测试不能在主进程中主动触发 runtime fatal error、永久死锁或栈耗尽。
- 子进程实验必须有硬超时，并区分预期异常退出、启动失败和测试超时。
- 调度顺序、地址、哈希种子、GC 时间、select 分布和 Benchmark 数值不得写成固定断言。
- 性质测试使用不变量，例如“结果不丢失”“最终可取消”“关闭后缓冲数据仍可读出”“增长后仍能查到所有键”。
- 工具命令失败时输出实际命令、GOOS/GOARCH、Go 版本和 stderr，便于定位版本或环境差异。
- 所有实验产物写入 `t.TempDir()`、系统临时目录或用户显式指定路径，不污染仓库。

## 11. 测试与验证矩阵

全量验收至少包括：

```powershell
go test ./...
go test -race ./29_runtime_scheduler ./30_goroutine_stack_abi ./31_allocator_gc_pacer
go test -race ./32_map_swiss_table ./33_channel_select_semaphore ./34_interface_generics_runtime
go test -race ./35_syscall_cgo_netpoll ./36_runtime_forensics
go vet ./...
go test -bench=. -benchmem ./29_runtime_scheduler ./30_goroutine_stack_abi
go test -bench=. -benchmem ./31_allocator_gc_pacer ./32_map_swiss_table
go test -bench=. -benchmem ./33_channel_select_semaphore ./34_interface_generics_runtime
go test -bench=. -benchmem ./35_syscall_cgo_netpoll ./36_runtime_forensics
go test -fuzz=FuzzSwissTable -fuzztime=10s ./32_map_swiss_table
```

还必须执行：

- 29–36 的全部 `go run` 入口。
- Linux amd64 交叉构建验证平台文件能够编译；Linux 环境专项测试实际运行 epoll 实验。若当前会话没有 Linux 运行环境，必须明确记录只完成了交叉构建，不能声称 epoll 已运行验证。
- `CGO_ENABLED=0` 的全量构建，确保主课程不依赖 cgo。
- 本地具备 C 工具链时显式运行 `-tags=cgo_lab` 专项测试。
- `gofmt`、`git diff --check`、文档链接和占位符扫描。

## 12. 文档与学习地图

`go/code/README.md` 新增“第六阶段：runtime 源码与系统边界（29–36）”，列出先修关系、运行命令和专项验证。

`go/knowledge/README.md` 新增第五部分知识索引，并给出推荐顺序：

```text
29 调度器 → 30 栈/ABI → 31 分配器/GC
          → 32 Swiss Table → 33 channel/select/semaphore
          → 34 接口/泛型 → 35 syscall/cgo/netpoll → 36 综合诊断
```

既有 map、GMP、GC、interface 和 sync 文档保留作为概念先修，但要增加指向新实验的链接，并修正与 Go 1.26.4 明显不一致的版本描述，尤其是旧版 `hmap/bmap` 与新版 Swiss Table 的区分。

## 13. 第二阶段边界

为了保证单份规格可执行，本规格不设计 37–44 的内部实现，只固定后续目录主题：

```text
37_database_sql_pool
38_transaction_idempotency
39_cache_consistency
40_message_delivery
41_rpc_grpc
42_discovery_loadbalancing
43_distributed_observability
44_distributed_service
```

29–36 完成并验收后，37–44 必须重新执行设计流程。其默认测试使用内存替身或轻量协议测试，真实 PostgreSQL、Redis、消息队列和 RPC 环境通过 Docker 与显式标签验证。

## 14. 完成标准

本阶段只有同时满足以下条件才算完成：

- 八个代码目录和八篇知识文档全部存在，并遵循单章交付契约。
- 每章至少包含一个可运行入口、一组自动测试、一个 Benchmark 和 12 道面试题。
- 危险实验全部隔离，默认测试不会挂死、崩溃或依赖外部服务。
- 源码结论明确区分稳定契约、Go 1.26.4 实现、平台实现与实验观察。
- Windows 默认测试、race、vet、Fuzz、Benchmark、Linux 构建和无 cgo 构建全部通过。
- 两份根级 README 已更新，已有 01–28 课程继续可运行。
- 仓库中没有遗留 profile、trace、测试二进制或其他生成物。
