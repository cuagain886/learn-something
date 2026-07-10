# Go 进阶核心八讲设计规格

## 1. 背景

仓库目前已经具备两层 Go 学习材料：

- `go/code/01_hello` 至 `go/code/20_testing`：基础语法、类型系统、并发和工程化的可运行示例。
- `go/knowledge/01_slice_internals.md` 至 `go/knowledge/12_interview_traps.md`：slice、map、channel、interface、GMP、GC、逃逸、同步原语、并发模式和性能分析等进阶文章。

现有材料覆盖面较广，但代码课程在 20 之后缺少能够把底层机制、生产实践和面试追问连接起来的深度实验。本阶段新增八个核心主题，目标不是重复已有文章，而是把知识推进到“能验证、能设计、能排障、能解释”的层次。

## 2. 目标

完成后，学习者应当能够：

1. 使用 Go 内存模型解释并发代码的可见性、顺序性和同步关系。
2. 设计可取消、可限流、可回收且不会泄漏 goroutine 的并发任务。
3. 根据负载选择背压策略，而不是只会扩大 channel 缓冲区。
4. 正确配置和诊断 `net/http` 客户端、服务端及连接池。
5. 理解反射、泛型、`unsafe` 和内存布局的成本与边界。
6. 使用编译器输出、SSA、汇编和 Benchmark 验证优化判断。
7. 熟练使用 Fuzz、Race Detector、pprof 和 trace 排查问题。
8. 独立实现并验证一个具备过载保护和优雅停机能力的 HTTP 服务。
9. 对每个主题回答从概念、原理、代码到生产事故的递进式面试问题。

## 3. 非目标

第一阶段不包含以下内容：

- 数据库、消息队列、分布式事务、服务注册或云平台集成。
- Web 框架、ORM、第三方日志库和第三方测试框架。
- 完整复刻 Go runtime 或编译器源码。
- 以不安全技巧替代清晰、可维护的普通 Go 代码。
- 对现有 01–20 课程和 01–12 知识文档进行无关重构。

八讲全部使用 Go 标准库，确保本地可运行、结果可重复，并把注意力集中在 Go 本身。

## 4. 总体架构

新增代码目录：

```text
go/code/
├── 21_memory_model/
├── 22_structured_concurrency/
├── 23_backpressure_pipeline/
├── 24_http_transport_netpoll/
├── 25_reflect_unsafe/
├── 26_compiler_ssa/
├── 27_advanced_testing_profiling/
└── 28_production_service/
```

新增知识文档：

```text
go/knowledge/
├── 13_memory_model.md
├── 14_structured_concurrency.md
├── 15_backpressure_pipeline.md
├── 16_http_netpoll.md
├── 17_reflect_unsafe.md
├── 18_compiler_ssa.md
├── 19_advanced_testing_profiling.md
└── 20_production_service.md
```

每个编号形成同一个学习闭环：

```text
生产问题 → 可运行实验 → 底层执行过程 → 正确实现
        → 单元/竞态/基准验证 → 面试追问与参考答案
```

21–27 互不依赖，可以单独运行和复习。28 是多包综合项目，会复用前七讲的设计思想，但不从前七讲的目录导入教学代码，避免章节耦合。

## 5. 单章交付规范

每个主题至少包含：

- `main.go`：直接运行的实验入口，文件开头包含学习目标、先修知识、运行命令和关键陷阱。
- 一个或多个实现文件：核心逻辑与演示输出分离，便于测试和复用。
- `_test.go`：正常路径、边界、取消、错误和并发行为测试。
- `BenchmarkXxx`：验证关键性能结论，并报告时间和内存分配。
- 对应 `knowledge` 文档：原理、关键运行时或编译器结构、代码实验、工程决策、常见误区、面试问答和一句话总结。
- 根级 README 更新：补充章节索引、先修关系、运行命令和推荐学习顺序。

故意错误的竞态、泄漏和 `unsafe` 用法只出现在显式运行的演示入口或不会被默认执行的实验函数中，不得破坏全量测试。

## 6. 八个主题详细设计

### 6.1 21_memory_model

核心内容：

- Go 内存模型中的 happens-before、同步事件和数据竞争定义。
- goroutine 启动、channel 收发与关闭、Mutex、Once 和 atomic 建立的顺序关系。
- 编译器和 CPU 重排序为何使“看起来先写后读”的代码仍不安全。
- Mutex、channel、`atomic.Value`、`atomic.Pointer` 的适用边界。
- CAS 循环、ABA 问题及无锁结构并不天然更快的原因。
- cache line、伪共享及填充字段的可移植性限制。

代码实验：

- 使用 `atomic.Pointer` 实现只读配置快照的原子发布。
- 对比 Mutex 保护配置与原子快照的读多写少场景。
- 通过相邻计数器和分离计数器 Benchmark 观察伪共享影响。
- 展示缺少同步关系的错误发布模式，但不把结果写成确定性断言。

重点面试追问：内存可见性、CAS 失败重试、ABA、`atomic.Value` 类型约束、双重检查锁、无锁与无等待的区别。

### 6.2 22_structured_concurrency

核心内容：

- goroutine 的生命周期必须从属于一个清晰的调用范围。
- `context.WithCancelCause` 的取消原因传播。
- 首错取消、并发度限制、结果收集和资源释放顺序。
- goroutine 中的 panic 不会自动传递给启动者，必须在任务边界隔离。
- context 只传递请求范围元数据，不作为可选参数容器。

代码实验：

- 实现一个标准库版本的 `TaskGroup`。
- `Go` 方法接收任务，捕获首个错误并取消同组任务；`Wait` 开始后拒绝新任务。
- 使用有界信号量限制同时运行的任务数。
- 把任务 panic 转换成包含堆栈的错误。
- `Wait` 等待所有已启动任务退出，并返回稳定的首个失败原因；重复调用返回同一结果。

测试重点：首错取消、父 context 取消、并发上限、panic 隔离、全部成功、无任务和重复等待行为。

### 6.3 23_backpressure_pipeline

核心内容：

- 吞吐、延迟、队列长度和 Little's Law 的关系。
- 有界队列为何是生产系统的安全边界。
- 阻塞、拒绝、丢弃最新、丢弃最旧和合并更新等背压策略。
- Fan-out、Fan-in、Pipeline 的关闭权和取消传播。
- channel 缓冲区不是无限扩容，也不能修复下游永久变慢。

代码实验：

- 构建可取消的泛型 Pipeline。
- 实现阻塞提交、立即拒绝和保留最新值三种策略。
- Worker Pool 在输入关闭、context 取消和处理错误时都能退出。
- 暴露已接收、已处理、已拒绝和当前队列长度统计。

正常关闭会停止接收并排空已接受任务；context 取消会中止等待并尽快退出。队列关闭权只属于 Pipeline，生产者不得直接关闭内部 channel。

测试与 Benchmark：验证不丢不重、关闭时排空策略、取消无泄漏、队列满时的确定性行为，以及不同 worker 数和缓冲区大小的吞吐差异。

### 6.4 24_http_transport_netpoll

核心内容：

- `http.Client`、`Transport`、连接池和 keep-alive 的职责边界。
- DNS、建连、TLS、响应头、请求总时限和空闲连接时限的区别。
- 响应 Body 未读完或未关闭如何影响连接复用。
- `httptrace` 如何观察连接新建、复用和等待。
- 服务端 ReadHeaderTimeout、ReadTimeout、WriteTimeout、IdleTimeout 的含义。
- `Server.Shutdown` 与 `Server.Close` 的差异。
- runtime netpoll 如何把 Windows IOCP、Linux epoll 或 BSD/macOS kqueue 的就绪事件转换为 goroutine 可运行状态。

代码实验：

- 使用 `httptest.Server` 构造快响应、慢响应和流式响应。
- 自定义 `Transport` 并通过 `httptrace` 记录连接复用。
- 演示正确消费和关闭 Body。
- 实现带超时、取消和优雅关闭的 HTTP 服务。

测试不依赖公网，不对调度时序作脆弱断言，只验证可观察的协议行为和资源生命周期。

### 6.5 25_reflect_unsafe

核心内容：

- `reflect.Type`、`reflect.Value`、addressable、settable 和零值语义。
- 接口装箱、泛型单态化实现边界与反射动态派发成本。
- 结构体对齐、padding、`unsafe.Sizeof`、`Alignof` 和 `Offsetof`。
- `unsafe.Pointer`、`uintptr` 与 GC 可见性的差异。
- `unsafe.String`、`unsafe.Slice` 等零拷贝能力的生命周期和不可变性约束。
- 为什么除非有 Benchmark 和明确所有权证明，否则不应使用 `unsafe` 优化。

代码实验：

- 实现一个支持默认值、必填项和基础类型转换的反射配置绑定器。
- 对比直接赋值、泛型辅助函数和反射绑定的 Benchmark。
- 输出不同字段顺序下的结构体大小与偏移。
- 提供安全拷贝和零拷贝只读视图的对照实验。

测试覆盖非法目标、未导出字段、转换失败、必填项缺失、嵌套结构及 `checkptr` 检查。

### 6.6 26_compiler_ssa

核心内容：

- Go 源码从解析、类型检查、IR、SSA 到机器码的主要阶段。
- 逃逸分析、内联预算、去虚拟化和边界检查消除。
- 接口调用、泛型调用和直接调用可能产生的代码差异。
- `//go:noinline` 仅用于教学对照，不作为生产优化手段。
- 汇编输出和 Benchmark 只能共同支持结论，不能用单次耗时猜测编译器行为。

代码实验：

- 成对编写可逃逸/不逃逸、可内联/不可内联、可消除/不可消除边界检查的函数。
- 使用 `-gcflags=-m=2` 查看编译器决策。
- 使用 `GOSSAFUNC` 生成目标函数 SSA。
- 使用 `go tool objdump` 或编译器汇编输出观察关键指令。
- 用 Benchmark 验证更改是否真正改善时间或分配。

文档给出 PowerShell 可直接执行的命令，并说明输出可能随 Go 版本和架构变化，判断应基于语义而不是固定行号。

### 6.7 27_advanced_testing_profiling

核心内容：

- 表驱动测试、属性测试、Golden Test 和 Fuzz 的职责差异。
- Fuzz seed corpus、输入约束、崩溃样本最小化和回归保存。
- 并行子测试的隔离要求和共享状态风险。
- Race Detector 能发现什么、不能证明什么。
- 正确 Benchmark：`b.Loop`、准备阶段排除、内存报告和抗噪声比较。
- CPU、Heap、Alloc、Goroutine、Block、Mutex Profile 和 trace 的选择。
- “建立基线 → 采样 → 找热点 → 单点修改 → 回归验证”的优化闭环。

代码实验：

- 为一个二进制帧解析器编写单元测试、属性测试和 Fuzz 测试。
- 使用 Golden 文件验证稳定格式输出。
- 提供有意共享状态的竞态演示入口和修复版本。
- 为 CPU、分配、锁竞争和 goroutine 阻塞准备可采样负载。
- 为同一功能实现基线版与优化版 Benchmark。

默认测试只运行 Fuzz seed corpus；持续 fuzz 使用显式命令和有限时间。

### 6.8 28_production_service

综合项目是一个纯内存异步任务服务。它用于整合前七讲的设计能力，而不是模拟完整业务平台。

建议结构：

```text
28_production_service/
├── main.go
├── internal/
│   ├── api/             # 路由、JSON、错误映射、中间件
│   ├── jobs/            # 有界队列、worker、状态存储
│   ├── resilience/      # 限流、重试、熔断
│   ├── observability/   # 结构化日志、指标、pprof 注册
│   └── config/          # 校验和原子配置快照
└── *_test.go / internal/**/*_test.go
```

请求数据流：

```text
HTTP 请求
  → 请求 ID、访问日志和 panic 隔离
  → JSON 大小限制与参数校验
  → 并发/速率限制
  → 有界任务队列
  → Worker 执行器
  → 重试与熔断包装
  → 并发安全状态存储
  → JSON 响应、指标和日志
```

服务端点：

- `POST /v1/jobs`：提交任务；队列满时立即返回稳定的过载错误。
- `GET /v1/jobs/{id}`：查询 queued、running、succeeded、failed 或 canceled 状态。
- `GET /healthz`：进程存活检查。
- `GET /readyz`：服务是否接受新任务。
- `GET /metrics`：标准库实现的教学型文本指标。
- `/debug/pprof/*`：仅绑定到独立诊断服务器，避免与业务路由混杂。

执行器通过接口注入。实际运行入口使用确定性的本地工作负载；测试使用 fake executor 精确制造临时失败、永久失败、阻塞和 panic，以验证重试、熔断、取消及隔离行为。

重试只处理明确标记的临时错误，使用受 context 控制的有限次数退避；参数错误、永久错误、panic 和取消不重试。熔断器包含 closed、open 和 half-open 三种状态，测试通过可注入时钟稳定验证状态转换。速率限制采用本地 token bucket，不依赖外部服务。

关闭顺序：

1. 标记 not ready，拒绝新任务。
2. 关闭业务监听并等待在途 HTTP 请求。
3. 关闭任务提交入口。
4. 在关闭预算内排空队列；超时后取消剩余任务。
5. 等待 worker 退出。
6. 停止诊断服务器和后台指标任务。
7. 返回聚合后的关闭错误。

## 7. 错误处理规范

- 可预期失败返回 `error`，使用 `%w` 保留错误链。
- 使用 `errors.Is/As` 判断类别，不依赖错误文本。
- context 传播超时、取消及首个失败原因。
- panic 只在任务和 HTTP 边界捕获，转换为带堆栈信息的内部错误。
- 谁创建资源，谁负责关闭；对外暴露的 `Close` 或 `Shutdown` 必须可安全重复调用。
- 综合服务至少区分：无效参数、任务不存在、队列已满、限流、任务超时、服务关闭和内部错误。

HTTP 映射保持稳定：参数错误为 400，不存在为 404，速率限制为 429，队列已满或服务关闭为 503，客户端可观察的任务超时为 504，未分类内部错误为 500。响应不泄露内部堆栈。

## 8. 测试与验证策略

全量验证命令：

```powershell
cd go/code
$files = Get-ChildItem ./2[1-8]_* -Recurse -Filter *.go
gofmt -w $files.FullName
go test ./...
go test -race ./...
go vet ./...
```

专项验证：

```powershell
go test -bench=. -benchmem ./21_memory_model
go test -bench=. -benchmem ./23_backpressure_pipeline
go test -bench=. -benchmem ./25_reflect_unsafe
go test -bench=. -benchmem ./26_compiler_ssa
go test -bench=. -benchmem ./27_advanced_testing_profiling
go test -fuzz=Fuzz -fuzztime=10s ./27_advanced_testing_profiling
go test -gcflags=all=-d=checkptr=2 ./25_reflect_unsafe
```

测试设计约束：

- 不访问真实外网；HTTP 测试使用 `httptest`。
- 不使用长时间 `Sleep` 推断并发顺序；使用 channel、barrier、fake executor 和明确 deadline。
- 所有可能阻塞的测试都有超时保护。
- 不用 `runtime.NumGoroutine` 的瞬时值作严格相等断言。
- Benchmark 结论记录趋势和原因，不承诺跨机器的固定纳秒数。
- Race、Fuzz、Profile 和 Trace 的能力边界在文档中明确说明。

## 9. 资料准确性与版本策略

- 代码目标版本为仓库当前的 Go 1.26.4。
- 版本敏感行为必须标注首次引入版本或当前适用范围。
- 底层结论优先依据 Go Language Specification、Go Memory Model、官方博客、标准库源码、runtime 源码和 compiler 源码。
- runtime 内部结构只解释与当前主题相关的稳定概念；易变字段和函数名标注其版本属性。
- 操作系统相关 netpoll 机制分别说明 Windows、Linux 和 BSD/macOS 的差异，不把某个平台实现描述成 Go 的统一实现。

## 10. 实施顺序

按以下批次实施和回归：

1. 并发语义：21–23。
2. 网络、内存与编译器：24–26。
3. 测试和性能诊断：27。
4. 综合服务与全量回归：28。
5. 更新两个 README，检查链接、编号和学习路径。

每个批次完成后运行相关测试；第 28 讲完成后运行全量 `test`、`race` 和 `vet`。

## 11. 验收标准

- 八个代码主题均能按 README 命令运行。
- 八篇知识文档与代码目录一一对应，交叉链接有效。
- 每篇知识文档包含 8–12 道递进式面试题及参考答案。
- 关键结论能够由代码、测试、Benchmark、工具输出或官方资料支撑。
- 综合服务覆盖正常处理、队列过载、限流、任务超时、临时失败重试、熔断、panic、客户端取消和优雅停机。
- `go test ./...`、`go test -race ./...` 和 `go vet ./...` 通过。
- 所有新增 Go 代码经过 `gofmt`。
- 默认测试无外部服务依赖，不产生需要提交的构建产物或 profile 文件。
- 现有 01–20 代码课程和 01–12 知识文档保持可用。
