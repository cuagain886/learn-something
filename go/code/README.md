# Go 语言系统学习教程

为有其他语言经验的程序员准备的 Go 入门到进阶教程。每个编号目录是一个**可独立运行**的主题，代码中的中文注释就是教材——**建议边读注释边运行，再动手改代码做实验**。

## 环境与运行方式

```powershell
go version                    # 确认已安装（本教程基于 Go 1.26.4）

# 在本目录（learn_go/）下运行任意主题：
go run ./01_hello             # 编译并运行第 1 课
go run ./16_channels          # 运行第 16 课

# 特殊几课：
go run -race ./15_goroutines  # ★ 加 -race 体验竞态检测器
go test -v ./20_testing       # 第 20 课用 go test 运行
go test -bench=. ./20_testing # 运行基准测试

# 进阶课程统一验证：
go test -race ./21_memory_model ./22_structured_concurrency ./23_backpressure_pipeline
go test -gcflags=all=-d=checkptr=2 ./25_reflect_unsafe
go test -fuzz=FuzzFrameRoundTrip -fuzztime=10s ./27_advanced_testing_profiling
go test -race ./28_production_service/...
```

## 学习顺序

按编号顺序学即可，每课约 30–60 分钟（读注释 + 运行 + 自己改代码实验）。

### 第一阶段：基础语法（01–09）

| # | 主题 | 核心知识点 |
|---|------|-----------|
| 01 | [程序结构](01_hello/main.go) | package / import / main、注释、大小写可见性规则 |
| 02 | [变量与类型](02_variables/main.go) | var、`:=`、零值、const、iota、显式类型转换 |
| 03 | [运算符与格式化](03_operators_fmt/main.go) | 运算符、`++` 是语句、无三元运算符、fmt 动词速查 |
| 04 | [流程控制](04_flow_control/main.go) | if 带初始化、for 的四种形态（没有 while）、switch 不穿透、label |
| 05 | [函数](05_functions/main.go) | 多返回值、命名返回值、变参、闭包、defer 三规则 |
| 06 | [数组与切片](06_arrays_slices/main.go) | len/cap、append、copy、⚠️底层数组共享陷阱、slices 包 |
| 07 | [映射 map](07_maps/main.go) | comma-ok、遍历无序、⚠️nil map、用 map 做 Set/计数器 |
| 08 | [字符串与 Unicode](08_strings_runes/main.go) | byte vs rune、⚠️len 数的是字节、strings/strconv、Builder |
| 09 | [指针](09_pointers/main.go) | `&` 与 `*`、值传递语义、new、逃逸分析、何时用指针 |

### 第二阶段：类型系统（10–14）

| # | 主题 | 核心知识点 |
|---|------|-----------|
| 10 | [结构体](10_structs/main.go) | 初始化方式、嵌入（组合代替继承）、匿名结构体、tag |
| 11 | [方法](11_methods/main.go) | 接收者、⚠️值接收者 vs 指针接收者、方法提升 |
| 12 | [接口](12_interfaces/main.go) | 隐式实现、类型断言、type switch、any、⚠️nil 接口陷阱 |
| 13 | [错误处理](13_errors/main.go) | error 是值、`%w` 包装、errors.Is/As、panic/recover 的边界 |
| 14 | [泛型](14_generics/main.go) | 类型参数、comparable/Ordered/自定义约束、`~`、泛型容器 |

### 第三阶段：并发（15–17）—— Go 的招牌

| # | 主题 | 核心知识点 |
|---|------|-----------|
| 15 | [goroutine 与锁](15_goroutines/main.go) | go 关键字、WaitGroup、⚠️竞态条件、Mutex、atomic、Once |
| 16 | [通道 channel](16_channels/main.go) | 无缓冲/有缓冲、close、select、超时、worker pool |
| 17 | [context](17_context/main.go) | 取消传播、WithTimeout、⚠️goroutine 泄漏防治 |

### 第四阶段：工程化（18–20）

| # | 主题 | 核心知识点 |
|---|------|-----------|
| 18 | [包与模块](18_packages/main.go) | module vs package、导入自己的包（见 [shapes 子包](18_packages/shapes/shapes.go)）、init、go mod 命令 |
| 19 | [标准库速览](19_stdlib/main.go) | time 参考时间、文件读写、JSON 序列化、HTTP 服务端/客户端 |
| 20 | [测试](20_testing/mathx_test.go) | 表驱动测试、t.Run 子测试、基准测试、示例测试 |

### 第五阶段：底层原理与生产实践（21–28）

> 每个主题都包含可运行入口、单元/竞态测试、Benchmark，以及 `../knowledge/13–20` 对应的底层文章和面试题。建议每课投入 2–4 小时，先跑测试和工具，再阅读原理。

| # | 主题 | 核心知识点 | 专项验证 |
|---|------|-----------|---------|
| 21 | [Go 内存模型](21_memory_model/main.go) | happens-before、atomic.Pointer、CAS、ABA、伪共享 | `go test -race ./21_memory_model` |
| 22 | [结构化并发](22_structured_concurrency/main.go) | 首错取消、并发上限、panic 隔离、幂等 Wait | `go test -race ./22_structured_concurrency` |
| 23 | [背压与 Pipeline](23_backpressure_pipeline/main.go) | 有界队列、Block/Reject/KeepLatest、排空与取消 | `go test -race ./23_backpressure_pipeline` |
| 24 | [HTTP Transport 与 netpoll](24_http_transport_netpoll/main.go) | 连接复用、分层超时、httptrace、IOCP/epoll/kqueue | `go test -race ./24_http_transport_netpoll` |
| 25 | [反射与 unsafe](25_reflect_unsafe/main.go) | 配置绑定、泛型、内存布局、零拷贝边界 | `go test -gcflags=all=-d=checkptr=2 ./25_reflect_unsafe` |
| 26 | [编译器与 SSA](26_compiler_ssa/main.go) | 逃逸、内联、BCE、GOSSAFUNC、objdump | `go test -gcflags='-m=2' ./26_compiler_ssa` |
| 27 | [高级测试与诊断](27_advanced_testing_profiling/main.go) | 属性/Golden/Fuzz、Race、Benchmark、pprof、trace | `go test -fuzz=FuzzFrameRoundTrip -fuzztime=10s ./27_advanced_testing_profiling` |
| 28 | [生产级并发 HTTP 服务](28_production_service/main.go) | 限流、队列、重试、熔断、指标、pprof、优雅停机 | `go test -race ./28_production_service/...` |

进阶推荐顺序：

```text
21 内存模型 → 22 结构化并发 → 23 背压
                         ↓
24 HTTP/netpoll → 26 编译器 → 25 反射/unsafe
                         ↓
27 测试与诊断 → 28 综合服务
```

### 第六阶段：runtime 源码与系统边界（29–36）

> 以 Go 1.26.4、Linux amd64 源码为主线；默认代码跨平台，Linux epoll 与 cgo 使用专项构建条件。每讲对应 `../knowledge/21–28`，并包含源码地图、测试、Benchmark 和至少 12 道面试题。

| # | 主题 | 核心知识点 | 专项验证 |
|---|------|-----------|---------|
| 29 | [runtime 调度器](29_runtime_scheduler/main.go) | G/M/P、runq、work stealing、sysmon、抢占 | `go test -race ./29_runtime_scheduler` |
| 30 | [goroutine 栈与 ABI](30_goroutine_stack_abi/main.go) | 连续栈、morestack、寄存器 ABI、闭包、panic 展开 | `go test -race ./30_goroutine_stack_abi` |
| 31 | [分配器与 GC pacer](31_allocator_gc_pacer/main.go) | size class、mcache/mheap、写屏障、scavenger、内存上限 | `go test -race ./31_allocator_gc_pacer` |
| 32 | [Swiss Table map](32_map_swiss_table/main.go) | control byte、H1/H2、探测、tombstone、目录分裂 | `go test ./32_map_swiss_table -fuzz FuzzSwissTable -fuzztime 10s` |
| 33 | [channel/select/semaphore](33_channel_select_semaphore/main.go) | hchan、sudog、select、gopark、futex、Cond | `go test -race ./33_channel_select_semaphore` |
| 34 | [接口与泛型 runtime](34_interface_generics_runtime/main.go) | eface/iface/itab、装箱、shape/dictionary、去虚拟化 | `go test -race ./34_interface_generics_runtime` |
| 35 | [syscall/cgo/netpoll](35_syscall_cgo_netpoll/main.go) | fd、epoll/IOCP/kqueue、pollDesc、cgo 边界 | `go test -race ./35_syscall_cgo_netpoll` |
| 36 | [runtime 事故实验室](36_runtime_forensics/main.go) | metrics、pprof、trace、泄漏、竞争、GC、子进程隔离 | `go test -race ./36_runtime_forensics` |

源码深挖顺序：`29 → 30 → 31 → 32 → 33 → 34 → 35 → 36`。

```powershell
go test -race ./29_runtime_scheduler ./30_goroutine_stack_abi ./31_allocator_gc_pacer ./32_map_swiss_table ./33_channel_select_semaphore ./34_interface_generics_runtime ./35_syscall_cgo_netpoll ./36_runtime_forensics
$env:CGO_ENABLED='0'
go test ./...
Remove-Item Env:CGO_ENABLED
# 有 C 工具链时再运行：go test -tags=cgo_lab ./35_syscall_cgo_netpoll
```

## 怎么学效果最好

1. **先跑再读**：`go run` 看输出，对照源码注释理解每一行
2. **动手破坏**：把注释里标 ⚠️ 的陷阱代码取消注释，亲眼看它怎么坏
3. **自己重写**：合上教程，凭记忆重写本课的核心示例
4. **工具习惯**：写完代码就跑 `go vet ./...`；并发代码必跑 `go run -race`
5. **结论要有证据**：性能判断附 Benchmark/pprof，底层判断附规范、工具输出或当前版本源码

## 学完之后

- **官方 Tour**：<https://go.dev/tour>（交互式练习，巩固语法）
- **Effective Go**：<https://go.dev/doc/effective_go>（官方风格指南）
- **Go by Example**：<https://gobyexample.com>（速查各种场景的惯用写法）
- **标准库文档**：<https://pkg.go.dev/std>（Go 程序员的日常字典）
- **配套深度文档**：[`../knowledge/README.md`](../knowledge/README.md)（底层原理、生产决策和面试追问）
- **练手项目建议**：CLI 待办工具（练 flag/json/文件）→ REST API 服务（练 net/http/数据库）→ 并发爬虫（练 goroutine/channel/context）
