# Go 进阶核心八讲 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Go 基础课程之后新增八个可运行、可测试、可验证的进阶主题，贯通生产工程、底层原理和高频面试题。

**Architecture:** 21–27 是彼此独立的实验模块，每个模块包含实现、测试、Benchmark、运行入口和一篇对应知识文档。28 是纯标准库、多包的内存任务服务，只复用前七讲的设计思想，不导入前七讲代码；全程按“失败测试 → 最小实现 → 完整验证 → 文档 → 提交”的顺序推进。

**Tech Stack:** Go 1.26.4、Go 标准库、`testing`、Race Detector、Fuzz、Benchmark、pprof、trace、PowerShell、Markdown。

## Global Constraints

- 代码目标版本固定为 Go 1.26.4，与 `go/code/go.mod` 一致。
- 八讲全部使用 Go 标准库，不新增第三方依赖或 `go.sum`。
- 所有代码主题必须在本地运行，不访问真实外网；HTTP 测试只使用 `httptest`。
- 每个主题包含可运行入口、核心实现、单元/并发测试、Benchmark、底层文档和 8–12 道面试题。
- 故意错误的竞态、泄漏和 `unsafe` 代码不得由默认测试执行。
- 并发测试使用 channel、barrier、fake executor 和 deadline，不用长时间 `Sleep` 猜测调度顺序。
- 不修改 01–20 课程和 01–12 知识正文；只允许更新两个 README 的索引和运行说明。
- 新增 Go 文件必须通过 `gofmt`、`go test ./...`、`go test -race ./...` 和 `go vet ./...`。
- 版本和 runtime/compiler 结论以 Go 官方规范、官方文档及本机 Go 1.26.4 源码为依据。

---

## File Map

### 独立实验 21–27

- `go/code/21_memory_model/main.go`：内存模型实验入口。
- `go/code/21_memory_model/snapshot.go`：Mutex 与原子配置快照。
- `go/code/21_memory_model/snapshot_test.go`：发布语义与并发正确性测试。
- `go/code/21_memory_model/snapshot_bench_test.go`：快照和伪共享 Benchmark。
- `go/knowledge/13_memory_model.md`：内存模型原理与面试题。

- `go/code/22_structured_concurrency/main.go`：任务组取消和 panic 演示。
- `go/code/22_structured_concurrency/taskgroup.go`：结构化任务组。
- `go/code/22_structured_concurrency/taskgroup_test.go`：生命周期测试。
- `go/code/22_structured_concurrency/taskgroup_bench_test.go`：任务调度开销 Benchmark。
- `go/knowledge/14_structured_concurrency.md`：结构化并发文档。

- `go/code/23_backpressure_pipeline/main.go`：三种背压策略演示。
- `go/code/23_backpressure_pipeline/pipeline.go`：泛型有界 Pipeline。
- `go/code/23_backpressure_pipeline/pipeline_test.go`：排空、取消和统计测试。
- `go/code/23_backpressure_pipeline/pipeline_bench_test.go`：队列与 worker 吞吐 Benchmark。
- `go/knowledge/15_backpressure_pipeline.md`：背压与 Pipeline 文档。

- `go/code/24_http_transport_netpoll/main.go`：连接复用、超时和优雅停机实验。
- `go/code/24_http_transport_netpoll/client.go`：HTTP Client/Transport/Trace 辅助类型。
- `go/code/24_http_transport_netpoll/client_test.go`：`httptest` 协议行为测试。
- `go/code/24_http_transport_netpoll/client_bench_test.go`：Handler 路径 Benchmark。
- `go/knowledge/16_http_netpoll.md`：HTTP 与 netpoll 文档。

- `go/code/25_reflect_unsafe/main.go`：反射绑定、布局和零拷贝实验入口。
- `go/code/25_reflect_unsafe/bind.go`：反射配置绑定器。
- `go/code/25_reflect_unsafe/layout.go`：安全/不安全转换与布局示例。
- `go/code/25_reflect_unsafe/bind_test.go`：绑定器与边界测试。
- `go/code/25_reflect_unsafe/bind_bench_test.go`：直接/泛型/反射 Benchmark。
- `go/knowledge/17_reflect_unsafe.md`：反射与 unsafe 文档。

- `go/code/26_compiler_ssa/main.go`：编译器观察命令入口。
- `go/code/26_compiler_ssa/compiler_cases.go`：逃逸、内联、BCE 和派发对照函数。
- `go/code/26_compiler_ssa/compiler_cases_test.go`：语义等价测试。
- `go/code/26_compiler_ssa/compiler_cases_bench_test.go`：编译优化 Benchmark。
- `go/knowledge/18_compiler_ssa.md`：编译器、SSA 和汇编文档。

- `go/code/27_advanced_testing_profiling/main.go`：Profile/Trace 负载入口。
- `go/code/27_advanced_testing_profiling/frame.go`：二进制帧编解码器。
- `go/code/27_advanced_testing_profiling/frame_test.go`：单元、属性和 Golden Test。
- `go/code/27_advanced_testing_profiling/frame_fuzz_test.go`：Fuzz seed 与性质。
- `go/code/27_advanced_testing_profiling/frame_bench_test.go`：基准和 profile 负载。
- `go/code/27_advanced_testing_profiling/testdata/frame.golden`：稳定格式样本。
- `go/knowledge/19_advanced_testing_profiling.md`：高级测试与分析文档。

### 综合项目 28

- `go/code/28_production_service/main.go`：信号处理、依赖组装和双服务器启动。
- `go/code/28_production_service/internal/config/config.go`：配置默认值、校验和原子快照。
- `go/code/28_production_service/internal/jobs/job.go`：任务模型、状态和错误。
- `go/code/28_production_service/internal/jobs/engine.go`：有界队列、worker 和关闭流程。
- `go/code/28_production_service/internal/jobs/store.go`：并发安全任务快照存储。
- `go/code/28_production_service/internal/resilience/retry.go`：临时错误有限重试。
- `go/code/28_production_service/internal/resilience/breaker.go`：三态熔断器。
- `go/code/28_production_service/internal/resilience/limiter.go`：本地 token bucket。
- `go/code/28_production_service/internal/observability/metrics.go`：原子指标与文本导出。
- `go/code/28_production_service/internal/api/handler.go`：路由、中间件、JSON 和错误映射。
- `go/code/28_production_service/internal/app/app.go`：业务/诊断服务器生命周期。
- `go/code/28_production_service/internal/**/*_test.go`：各组件测试。
- `go/code/28_production_service/integration_test.go`：端到端协议和关闭测试。
- `go/knowledge/20_production_service.md`：综合设计与面试题。
- `go/code/README.md`、`go/knowledge/README.md`：新增八讲索引、命令和学习路线。

---

### Task 0: 基线与官方资料核验

**Files:**
- Read: `go/code/go.mod`
- Read: `docs/superpowers/specs/2026-07-10-go-advanced-core-design.md`
- Read: 本机 `$GOROOT/src/runtime`、`$GOROOT/src/net/http`、`$GOROOT/src/sync`、`$GOROOT/src/reflect`

**Interfaces:**
- Consumes: 现有 Go 模块和已批准设计规格。
- Produces: 可重复的基线结果与后续文档使用的官方事实清单。

- [ ] **Step 1: 记录工具链和干净基线**

Run:

```powershell
cd E:\NoteBook\Fighting\go\code
go version
go env GOROOT GOOS GOARCH CGO_ENABLED
go test ./...
go vet ./...
```

Expected: Go 版本为 `go1.26.4 windows/amd64`，现有测试和 vet 均退出 0。

- [ ] **Step 2: 核验官方一手资料**

只使用以下资料族，并在知识文档末尾列出实际引用页面：

```text
https://go.dev/ref/mem
https://go.dev/ref/spec
https://pkg.go.dev/context
https://pkg.go.dev/sync
https://pkg.go.dev/sync/atomic
https://pkg.go.dev/net/http
https://pkg.go.dev/net/http/httptrace
https://pkg.go.dev/reflect
https://pkg.go.dev/unsafe
https://go.dev/doc/fuzz/
https://go.dev/blog/pprof
$GOROOT/src/runtime/
$GOROOT/src/cmd/compile/
```

Expected: 为所有版本敏感结论找到规范、官方文档或 Go 1.26.4 源码依据；不引用二手博客作为事实来源。

---

### Task 1: 21_memory_model

**Files:**
- Create: `go/code/21_memory_model/main.go`
- Create: `go/code/21_memory_model/snapshot.go`
- Create: `go/code/21_memory_model/snapshot_test.go`
- Create: `go/code/21_memory_model/snapshot_bench_test.go`
- Create: `go/knowledge/13_memory_model.md`

**Interfaces:**
- Consumes: `sync.Mutex`、`sync/atomic`、`time.Duration`。
- Produces: `NewAtomicSnapshot(Config) *AtomicSnapshot`、`Load() Config`、`Store(Config)`、`NewLockedSnapshot(Config) *LockedSnapshot`。

- [ ] **Step 1: 写配置快照失败测试**

```go
func TestAtomicSnapshotPublishesImmutableCopy(t *testing.T) {
	original := Config{Version: 1, Endpoint: "v1", Timeout: time.Second}
	s := NewAtomicSnapshot(original)
	original.Endpoint = "mutated"
	if got := s.Load().Endpoint; got != "v1" {
		t.Fatalf("Load().Endpoint = %q, want v1", got)
	}

	next := Config{Version: 2, Endpoint: "v2", Timeout: 2 * time.Second}
	s.Store(next)
	next.Endpoint = "mutated-again"
	if got := s.Load(); got.Version != 2 || got.Endpoint != "v2" {
		t.Fatalf("Load() = %+v, want published v2 snapshot", got)
	}
}
```

- [ ] **Step 2: 验证测试因 API 缺失而失败**

Run: `go test ./21_memory_model -run TestAtomicSnapshotPublishesImmutableCopy -v`

Expected: FAIL，错误包含 `undefined: Config` 或 `undefined: NewAtomicSnapshot`。

- [ ] **Step 3: 实现原子和锁版本快照**

```go
type Config struct {
	Version  int64
	Endpoint string
	Timeout  time.Duration
}

type AtomicSnapshot struct{ value atomic.Pointer[Config] }

func NewAtomicSnapshot(initial Config) *AtomicSnapshot {
	s := &AtomicSnapshot{}
	s.Store(initial)
	return s
}

func (s *AtomicSnapshot) Load() Config {
	p := s.value.Load()
	if p == nil {
		return Config{}
	}
	return *p
}

func (s *AtomicSnapshot) Store(next Config) {
	copy := next
	s.value.Store(&copy)
}

type LockedSnapshot struct {
	mu    sync.RWMutex
	value Config
}
```

为 `LockedSnapshot` 实现同名 `Load`/`Store`，所有读取返回值拷贝。

- [ ] **Step 4: 添加并发发布测试并跑 Race Detector**

测试启动一个 writer 连续发布递增 Version，多个 reader 只接受合法 Endpoint/Version 组合；使用开始 barrier 和完成 channel，不对 reader 顺序作假设。

Run: `go test -race ./21_memory_model -v`

Expected: PASS，且无 `DATA RACE`。

- [ ] **Step 5: 添加 Benchmark 和可运行教材**

Benchmark 必须包含：

```go
func BenchmarkAtomicSnapshotLoad(b *testing.B)
func BenchmarkLockedSnapshotLoad(b *testing.B)
func BenchmarkFalseSharing(b *testing.B)
func BenchmarkPaddedCounters(b *testing.B)
```

伪共享基准内部使用 `type Counters struct{ Left, Right atomic.Uint64 }`，填充版本把两个计数器分别包在含 64-byte 教学填充的结构中；文档明确说明 cache line 大小依架构而异，填充仅用于观察趋势。

`main.go` 顺序演示错误发布概念、锁同步、channel 同步、原子快照、CAS 重试和伪共享；错误发布只说明“行为未定义/存在数据竞争”，不声称每次都输出固定错误结果。

- [ ] **Step 6: 编写底层文档**

`13_memory_model.md` 固定章节：内存模型术语、happens-before 表、重排序、同步原语、atomic/CAS、ABA、伪共享、工程选择、实验命令、10 道面试题、官方资料、一句话总结。

- [ ] **Step 7: 验证并提交**

Run:

```powershell
gofmt -w (Get-ChildItem ./21_memory_model -Filter *.go).FullName
go test -race ./21_memory_model
go test -run=^$ -bench=. -benchmem ./21_memory_model
go vet ./21_memory_model
```

Expected: 所有命令退出 0，Benchmark 输出 `ns/op` 和 `allocs/op`。

Commit:

```powershell
git add go/code/21_memory_model go/knowledge/13_memory_model.md
git commit -m "feat: 添加 Go 内存模型进阶课程"
```

---

### Task 2: 22_structured_concurrency

**Files:**
- Create: `go/code/22_structured_concurrency/main.go`
- Create: `go/code/22_structured_concurrency/taskgroup.go`
- Create: `go/code/22_structured_concurrency/taskgroup_test.go`
- Create: `go/code/22_structured_concurrency/taskgroup_bench_test.go`
- Create: `go/knowledge/14_structured_concurrency.md`

**Interfaces:**
- Consumes: `context.Context`。
- Produces: `type Task func(context.Context) error`、`NewTaskGroup(context.Context, int) (*TaskGroup, error)`、`Go(Task) error`、`Wait() error`、`ErrGroupClosed`、`PanicError`。

- [ ] **Step 1: 写首错取消失败测试**

```go
func TestTaskGroupCancelsSiblingsOnFirstError(t *testing.T) {
	want := errors.New("boom")
	g, err := NewTaskGroup(context.Background(), 2)
	if err != nil { t.Fatal(err) }
	canceled := make(chan struct{})
	if err := g.Go(func(context.Context) error { return want }); err != nil { t.Fatal(err) }
	if err := g.Go(func(ctx context.Context) error {
		<-ctx.Done()
		close(canceled)
		return nil
	}); err != nil { t.Fatal(err) }
	if got := g.Wait(); !errors.Is(got, want) { t.Fatalf("Wait() = %v", got) }
	select {
	case <-canceled:
	case <-time.After(time.Second): t.Fatal("sibling was not canceled")
	}
}
```

- [ ] **Step 2: 运行失败测试**

Run: `go test ./22_structured_concurrency -run TestTaskGroupCancelsSiblingsOnFirstError -v`

Expected: FAIL，API 未定义。

- [ ] **Step 3: 实现 TaskGroup 生命周期**

核心声明固定为：

```go
var ErrGroupClosed = errors.New("task group is waiting or closed")

type Task func(context.Context) error

type PanicError struct {
	Value any
	Stack []byte
}

func (e *PanicError) Error() string { return fmt.Sprintf("task panic: %v", e.Value) }

type TaskGroup struct {
	ctx context.Context
	cancel context.CancelCauseFunc
	limit chan struct{}
	wg sync.WaitGroup
	mu sync.Mutex
	waiting bool
	first error
	waitOnce sync.Once
	done chan struct{}
}
```

`Go` 在 `waiting` 后返回 `ErrGroupClosed`；任务开始前获取 limit token；任务返回或 panic 时释放 token；首个非 nil 错误调用 `cancel(err)`；`Wait` 只启动一次等待并可重复返回同一错误。

- [ ] **Step 4: 补齐生命周期测试**

添加 `TestTaskGroupHonorsLimit`、`TestTaskGroupConvertsPanic`、`TestTaskGroupRejectsGoAfterWait`、`TestTaskGroupWaitIsIdempotent`、`TestTaskGroupParentCancellation`。panic 断言使用 `errors.As(err, *PanicError)` 并验证 Stack 非空。

Run: `go test -race ./22_structured_concurrency -v`

Expected: PASS，无竞态。

- [ ] **Step 5: 添加 Benchmark、教材和文档**

Benchmark 对比直接函数调用、无限制 TaskGroup 和限制并发 TaskGroup。`main.go` 演示成功、首错取消、超时、panic 隔离和并发上限。`14_structured_concurrency.md` 包含生命周期树、取消原因、首错策略、panic 边界、泄漏模式、工程准则、10 道面试题和官方资料。

- [ ] **Step 6: 验证并提交**

Run:

```powershell
gofmt -w (Get-ChildItem ./22_structured_concurrency -Filter *.go).FullName
go test -race ./22_structured_concurrency
go test -run=^$ -bench=. -benchmem ./22_structured_concurrency
go vet ./22_structured_concurrency
```

Commit: `git commit -m "feat: 添加结构化并发进阶课程"`

---

### Task 3: 23_backpressure_pipeline

**Files:**
- Create: `go/code/23_backpressure_pipeline/main.go`
- Create: `go/code/23_backpressure_pipeline/pipeline.go`
- Create: `go/code/23_backpressure_pipeline/pipeline_test.go`
- Create: `go/code/23_backpressure_pipeline/pipeline_bench_test.go`
- Create: `go/knowledge/15_backpressure_pipeline.md`

**Interfaces:**
- Consumes: `context.Context` 和泛型处理函数。
- Produces: `PolicyBlock`、`PolicyReject`、`PolicyKeepLatest`、`NewPipeline[I,O]`、`Submit`、`Results`、`Close`、`Wait`、`Stats`、`ErrQueueFull`、`ErrClosed`。

- [ ] **Step 1: 写队列满失败测试**

```go
func TestPipelineRejectsWhenQueueIsFull(t *testing.T) {
	gate := make(chan struct{})
	p, err := NewPipeline(context.Background(), 1, 1, PolicyReject,
		func(ctx context.Context, v int) (int, error) { <-gate; return v * 2, nil })
	if err != nil { t.Fatal(err) }
	t.Cleanup(func() { close(gate); _ = p.Close(); _ = p.Wait() })
	if err := p.Submit(context.Background(), 1); err != nil { t.Fatal(err) }
	if err := p.Submit(context.Background(), 2); err != nil { t.Fatal(err) }
	if err := p.Submit(context.Background(), 3); !errors.Is(err, ErrQueueFull) {
		t.Fatalf("Submit() = %v, want ErrQueueFull", err)
	}
}
```

- [ ] **Step 2: 运行失败测试**

Run: `go test ./23_backpressure_pipeline -run TestPipelineRejectsWhenQueueIsFull -v`

Expected: FAIL，Pipeline API 未定义。

- [ ] **Step 3: 实现泛型 Pipeline**

核心 API 固定为：

```go
type Policy uint8
const ( PolicyBlock Policy = iota; PolicyReject; PolicyKeepLatest )
var ErrQueueFull = errors.New("pipeline queue is full")
var ErrClosed = errors.New("pipeline is closed")

type Result[T any] struct { Value T; Err error }
type Stats struct { Accepted, Processed, Rejected, Dropped uint64; QueueLength int }
type Processor[I, O any] func(context.Context, I) (O, error)

func NewPipeline[I, O any](parent context.Context, workers, capacity int, policy Policy, fn Processor[I,O]) (*Pipeline[I,O], error)
func (p *Pipeline[I,O]) Submit(context.Context, I) error
func (p *Pipeline[I,O]) Results() <-chan Result[O]
func (p *Pipeline[I,O]) Close() error
func (p *Pipeline[I,O]) Wait() error
func (p *Pipeline[I,O]) Stats() Stats
```

用提交互斥锁串行化 close/submit 和 KeepLatest 的“弹出最旧项再写入”；正常 Close 停止提交并让 worker 排空；父 context 取消使 worker 尽快退出；最后一个 worker 关闭 results。

构造函数拒绝 workers<=0、capacity<0、nil processor 和未知策略；PolicyKeepLatest 额外要求 capacity>0。调用者必须持续消费 Results，文档和 main 都要演示该所有权规则。

- [ ] **Step 4: 补齐确定性测试**

添加：`TestPipelineDrainsOnClose`、`TestPipelineKeepLatestDropsOldest`、`TestPipelineBlockHonorsSubmitContext`、`TestPipelineCancellationStopsWorkers`、`TestPipelineCloseIsIdempotent`、`TestPipelineStats`。测试必须消费 `Results()`，避免 worker 因结果无人接收阻塞。

Run: `go test -race ./23_backpressure_pipeline -v`

Expected: PASS，无泄漏症状和竞态。

- [ ] **Step 5: 添加 Benchmark、教材和文档**

Benchmark 表格覆盖 worker=1/CPU 数、queue=0/64/1024 和三种策略。`main.go` 可视化打印 accepted/processed/rejected/dropped。`15_backpressure_pipeline.md` 包含 Little's Law、策略决策表、关闭权、Fan-out/Fan-in、常见死锁、10 道面试题和官方资料。

- [ ] **Step 6: 批次一验证并提交**

Run:

```powershell
gofmt -w (Get-ChildItem ./2[1-3]_* -Recurse -Filter *.go).FullName
go test -race ./21_memory_model ./22_structured_concurrency ./23_backpressure_pipeline
go vet ./21_memory_model ./22_structured_concurrency ./23_backpressure_pipeline
```

Commit: `git commit -m "feat: 添加背压与有界流水线进阶课程"`

---

### Task 4: 24_http_transport_netpoll

**Files:**
- Create: `go/code/24_http_transport_netpoll/main.go`
- Create: `go/code/24_http_transport_netpoll/client.go`
- Create: `go/code/24_http_transport_netpoll/client_test.go`
- Create: `go/code/24_http_transport_netpoll/client_bench_test.go`
- Create: `go/knowledge/16_http_netpoll.md`

**Interfaces:**
- Consumes: `net/http`、`net/http/httptrace`。
- Produces: `ClientConfig`、`NewClient(ClientConfig) (*http.Client, error)`、`TraceEvents`、`WithTrace(context.Context, *TraceEvents) context.Context`、`NewTeachingServer(http.Handler) *http.Server`。

- [ ] **Step 1: 写连接复用失败测试**

创建 `httptest.Server`，连续发两次请求并完全读取/关闭 Body；使用 `httptrace.GotConnInfo.Reused` 断言第一次 false、第二次 true。随后增加“不关闭 Body 不保证复用”的演示，但不作跨平台脆弱断言。

- [ ] **Step 2: 实现 ClientConfig 与 TraceEvents**

`ClientConfig` 明确包含 `RequestTimeout`、`DialTimeout`、`TLSHandshakeTimeout`、`ResponseHeaderTimeout`、`IdleConnTimeout`、`MaxIdleConns`、`MaxIdleConnsPerHost`；所有 duration 非负，负值返回字段化校验错误。

- [ ] **Step 3: 添加超时和优雅关闭测试**

覆盖总请求超时、响应头超时、客户端取消、Body 关闭、`Server.Shutdown` 等待在途请求和 shutdown deadline。实现 `NewTeachingServer(handler http.Handler) *http.Server`，默认设置 ReadHeaderTimeout、ReadTimeout、WriteTimeout 和 IdleTimeout；测试全部使用本地 listener/`httptest`。

- [ ] **Step 4: 添加教材、Handler Benchmark 和文档**

Benchmark 使用 `httptest.NewRequest` + `httptest.NewRecorder` 直接测 Handler，不把端口调度噪声当作业务性能。文档区分 Windows IOCP、Linux epoll、BSD/macOS kqueue，并只把共同的“事件唤醒 goroutine”描述为统一抽象。

- [ ] **Step 5: 验证并提交**

Run:

```powershell
go test -race ./24_http_transport_netpoll
go vet ./24_http_transport_netpoll
```

Commit: `git commit -m "feat: 添加 HTTP Transport 与 netpoll 进阶课程"`

---

### Task 5: 25_reflect_unsafe

**Files:**
- Create: `go/code/25_reflect_unsafe/main.go`
- Create: `go/code/25_reflect_unsafe/bind.go`
- Create: `go/code/25_reflect_unsafe/layout.go`
- Create: `go/code/25_reflect_unsafe/bind_test.go`
- Create: `go/code/25_reflect_unsafe/bind_bench_test.go`
- Create: `go/knowledge/17_reflect_unsafe.md`

**Interfaces:**
- Consumes: `map[string]string` 和结构体指针。
- Produces: `Bind(any, map[string]string) error`、`FieldError`、`SafeBytesToString`、`UnsafeBytesToReadOnlyString`、`Layout`、`LayoutOf[T]`。

- [ ] **Step 1: 写绑定器失败测试**

```go
type testConfig struct {
	Addr string `cfg:"ADDR,required"`
	Port int `cfg:"PORT,default=8080"`
	Debug bool `cfg:"DEBUG,default=false"`
	Timeout time.Duration `cfg:"TIMEOUT,default=2s"`
}
```

断言 `ADDR` 被设置、默认值生效、duration 正确解析；缺少必填项时 `errors.As` 得到 `*FieldError` 且 Field=`Addr`。

- [ ] **Step 2: 实现严格反射绑定**

`Bind` 只接受非 nil 的结构体指针；只处理带 `cfg` tag 的导出字段；支持 string、bool、所有有符号整数和 `time.Duration`；转换错误包装字段名和原值；未知选项、未导出字段、非结构体目标都返回错误。

- [ ] **Step 3: 添加布局和零拷贝边界**

`SafeBytesToString` 使用普通转换；`UnsafeBytesToReadOnlyString` 使用 `unsafe.String(unsafe.SliceData(src), len(src))`，空切片返回空串，并在注释中声明源切片不得修改或提前失去生命周期。布局 API 固定为：

```go
type Layout struct { Size, Align uintptr }
func LayoutOf[T any]() Layout {
	var value T
	return Layout{Size: unsafe.Sizeof(value), Align: unsafe.Alignof(value)}
}
```

具体字段 Offset 在 main 中用 `unsafe.Offsetof` 展示。

- [ ] **Step 4: 测试、Benchmark 和 checkptr**

对比直接字段赋值、类型明确的泛型 parse helper、反射 Bind；使用 `b.ReportAllocs()`。零拷贝测试只验证内容和分配趋势，不在转换后修改底层字节。

Run: `go test -gcflags=all=-d=checkptr=2 ./25_reflect_unsafe`

Expected: PASS。

- [ ] **Step 5: 教材、文档、验证和提交**

文档必须包含 addressable/settable、接口装箱、泛型与反射决策表、padding、Pointer/uintptr、GC 生命周期、零拷贝所有权、10 道面试题。提交信息：`feat: 添加反射与 unsafe 进阶课程`。

---

### Task 6: 26_compiler_ssa

**Files:**
- Create: `go/code/26_compiler_ssa/main.go`
- Create: `go/code/26_compiler_ssa/compiler_cases.go`
- Create: `go/code/26_compiler_ssa/compiler_cases_test.go`
- Create: `go/code/26_compiler_ssa/compiler_cases_bench_test.go`
- Create: `go/knowledge/18_compiler_ssa.md`

**Interfaces:**
- Consumes: `[]int`、小接口和泛型约束。
- Produces: 成对的 `SumChecked`/`SumBCE`、`StackValue`/`EscapingValue`、`InlineAdd`/`NoInlineAdd`、`InterfaceSum`/`GenericSum`。

- [ ] **Step 1: 写语义等价失败测试**

对空、单元素和多元素切片断言 `SumChecked` 与 `SumBCE` 返回相同结果；对接口与泛型版本断言相同总和。

- [ ] **Step 2: 实现编译器对照函数**

`SumBCE` 在循环前使用 `_ = values[len(values)-1]` 建立边界事实但必须先处理空切片；`NoInlineAdd` 标记 `//go:noinline`；`EscapingValue` 返回局部变量地址；接口和泛型版本功能完全一致。

- [ ] **Step 3: 运行编译器观察命令**

Run:

```powershell
go test ./26_compiler_ssa
go test -gcflags='-m=2' ./26_compiler_ssa 2> compiler.txt
$env:GOSSAFUNC='SumBCE'; go build ./26_compiler_ssa
go build -o compiler-demo.exe ./26_compiler_ssa
go tool objdump -s 'main\.SumBCE' compiler-demo.exe
```

Expected: 测试 PASS；`compiler.txt` 包含 inline/escape 决策；生成 `ssa.html`；objdump 能定位目标函数。检查完成后删除 `compiler.txt`、`compiler-demo.exe`、`ssa.html`，不得提交产物。

- [ ] **Step 4: 添加 Benchmark、教材和文档**

Benchmark 避免被整体常量折叠：输入保存在包级变量，结果写入包级 sink。文档解释输出会随版本和架构变化，不记录固定汇编行号。

- [ ] **Step 5: 批次二验证并提交**

Run: `go test -race ./24_http_transport_netpoll ./25_reflect_unsafe ./26_compiler_ssa; go vet ./24_http_transport_netpoll ./25_reflect_unsafe ./26_compiler_ssa`

Commit: `git commit -m "feat: 添加 Go 编译器与 SSA 进阶课程"`

---

### Task 7: 27_advanced_testing_profiling

**Files:**
- Create: `go/code/27_advanced_testing_profiling/main.go`
- Create: `go/code/27_advanced_testing_profiling/frame.go`
- Create: `go/code/27_advanced_testing_profiling/frame_test.go`
- Create: `go/code/27_advanced_testing_profiling/frame_fuzz_test.go`
- Create: `go/code/27_advanced_testing_profiling/frame_bench_test.go`
- Create: `go/code/27_advanced_testing_profiling/testdata/frame.golden`
- Create: `go/knowledge/19_advanced_testing_profiling.md`

**Interfaces:**
- Consumes: 二进制帧。
- Produces: `Frame`、`Encode(Frame) ([]byte,error)`、`Decode([]byte) (Frame,error)`、`ErrShortFrame`、`ErrLengthMismatch`、`ErrChecksum`。

- [ ] **Step 1: 写编解码失败测试**

帧格式固定为：1 byte version、1 byte flags、2 bytes big-endian payload length、payload、4 bytes CRC32 IEEE。测试 round-trip、短帧、长度不匹配、checksum 错误和 payload 超过 65535。

- [ ] **Step 2: 实现严格编解码器**

`Encode` 拒绝超长 payload 并复制输入；`Decode` 在任何切片前先检查长度，校验声明长度与总长度，再校验 CRC，返回的 Payload 不与输入共享底层数组。

- [ ] **Step 3: 添加 Fuzz 和属性测试**

```go
func FuzzFrameRoundTrip(f *testing.F) {
	f.Add(uint8(1), uint8(0), []byte("seed"))
	f.Fuzz(func(t *testing.T, version, flags uint8, payload []byte) {
		if len(payload) > math.MaxUint16 { t.Skip() }
		encoded, err := Encode(Frame{Version: version, Flags: flags, Payload: payload})
		if err != nil { t.Fatal(err) }
		decoded, err := Decode(encoded)
		if err != nil { t.Fatal(err) }
		if decoded.Version != version || decoded.Flags != flags || !bytes.Equal(decoded.Payload, payload) {
			t.Fatalf("round trip mismatch")
		}
	})
}
```

另加 `FuzzDecodeNeverPanics`，对任意字节只允许成功或已分类错误，不允许 panic。

- [ ] **Step 4: Golden、并行测试、Benchmark 和采样入口**

Golden 文件记录 `Frame{1,2,"Go"}` 的十六进制输出。Benchmark 覆盖 32B/1KB/60KB payload 并报告分配。`main.go` 提供 `-mode=cpu|alloc|mutex|block|trace` 和 `-duration`，profile 文件只在显式 `-out` 时生成。

- [ ] **Step 5: 编写文档并专项验证**

Run:

```powershell
go test -race ./27_advanced_testing_profiling
go test -fuzz=Fuzz -fuzztime=10s ./27_advanced_testing_profiling
go test -run=^$ -bench=. -benchmem ./27_advanced_testing_profiling
```

文档覆盖测试金字塔、属性、Fuzz、Race 边界、可靠 Benchmark、六类 Profile、trace、排障闭环和 12 道面试题。

- [ ] **Step 6: 提交**

Commit: `git commit -m "feat: 添加高级测试与性能诊断课程"`

---

### Task 8: 28 的配置、模型、存储和任务引擎

**Files:**
- Create: `go/code/28_production_service/internal/config/config.go`
- Create: `go/code/28_production_service/internal/config/config_test.go`
- Create: `go/code/28_production_service/internal/jobs/job.go`
- Create: `go/code/28_production_service/internal/jobs/store.go`
- Create: `go/code/28_production_service/internal/jobs/engine.go`
- Create: `go/code/28_production_service/internal/jobs/engine_test.go`

**Interfaces:**
- Produces: `config.Config`/`config.Snapshot`；`jobs.Job`/`jobs.Executor`/`jobs.Engine`/`jobs.Store`。
- Consumed by: Tasks 9–10。

- [ ] **Step 1: 写配置失败测试**

`Default()` 必须生成可通过 `Validate()` 的配置；Workers、QueueSize、Burst、TaskTimeout、ShutdownTimeout 小于等于零时报字段错误；`Snapshot.Load` 返回不可变值拷贝。

- [ ] **Step 2: 实现配置 API**

```go
type Config struct {
	Addr string
	DebugAddr string
	Workers int
	QueueSize int
	MaxBodyBytes int64
	TaskTimeout time.Duration
	ShutdownTimeout time.Duration
	RatePerSecond float64
	Burst int
}

func Default() Config
func (c Config) Validate() error
type Snapshot struct{ value atomic.Pointer[Config] }
func NewSnapshot(Config) (*Snapshot,error)
func (s *Snapshot) Load() Config
func (s *Snapshot) Store(Config) error
```

- [ ] **Step 3: 写任务引擎失败测试**

覆盖 Submit→queued→running→succeeded、队列满返回 `ErrQueueFull`、执行超时变 failed/canceled、executor panic 被隔离、Shutdown 停止接收并排空、Shutdown deadline 取消剩余任务、重复 Shutdown 安全。

- [ ] **Step 4: 实现任务引擎**

```go
type Status string
const (Queued Status="queued"; Running Status="running"; Succeeded Status="succeeded"; Failed Status="failed"; Canceled Status="canceled")
var ErrQueueFull = errors.New("job queue is full")
var ErrClosed = errors.New("job engine is closed")

type Job struct {
	ID, Payload, Result, Error string
	Status Status
	CreatedAt, StartedAt, FinishedAt time.Time
	Attempts int
}
type Executor interface { Execute(context.Context, string) (string, error) }
func NewEngine(context.Context, int, int, time.Duration, Executor) (*Engine,error)
func (e *Engine) Submit(context.Context, string) (Job,error)
func (e *Engine) Get(string) (Job,bool)
func (e *Engine) Shutdown(context.Context) error
```

Store 所有写入和读取都复制 Job；ID 使用进程内 atomic counter 生成；每个任务创建 task timeout context；worker 边界 recover 并记录 stack 到日志错误而非响应字段。

- [ ] **Step 5: 验证并提交**

Run: `go test -race ./28_production_service/internal/config ./28_production_service/internal/jobs`

Commit: `git commit -m "feat: 实现生产服务任务引擎"`

---

### Task 9: 28 的重试、熔断和限流

**Files:**
- Create: `go/code/28_production_service/internal/resilience/retry.go`
- Create: `go/code/28_production_service/internal/resilience/retry_test.go`
- Create: `go/code/28_production_service/internal/resilience/breaker.go`
- Create: `go/code/28_production_service/internal/resilience/breaker_test.go`
- Create: `go/code/28_production_service/internal/resilience/limiter.go`
- Create: `go/code/28_production_service/internal/resilience/limiter_test.go`

**Interfaces:**
- Consumes: `jobs.Executor`。
- Produces: `RetryExecutor`、`CircuitExecutor`、`TokenBucket`。

- [ ] **Step 1: 写有限重试失败测试**

fake executor 前两次返回 `TemporaryError`、第三次成功；断言总调用三次。永久错误、context 取消和 panic 均只调用一次。

- [ ] **Step 2: 实现可测试重试器**

```go
type Temporary interface { Temporary() bool }
type SleepFunc func(context.Context, time.Duration) error
type RetryConfig struct { MaxAttempts int; BaseDelay, MaxDelay time.Duration }
type RetryExecutor struct { Next jobs.Executor; Config RetryConfig; Sleep SleepFunc }
func (e *RetryExecutor) Execute(context.Context, string) (string,error)
```

退避为 `min(BaseDelay << (attempt-1), MaxDelay)`；默认 Sleep 用 timer + select 响应取消；不添加随机抖动，保持教学和测试确定性，并在文档说明生产环境通常需要 jitter。

- [ ] **Step 3: 写并实现熔断器状态测试**

状态固定为 Closed/Open/HalfOpen。连续失败达到 threshold 后 Open；冷却前返回 `ErrCircuitOpen`；冷却后只允许一个 probe；probe 成功回 Closed，失败回 Open。`Now func() time.Time` 注入假时钟。

```go
type State uint8
const (Closed State = iota; Open; HalfOpen)
var ErrCircuitOpen = errors.New("circuit breaker is open")
type CircuitExecutor struct { Next jobs.Executor; Breaker *Breaker }
func NewBreaker(threshold int, cooldown time.Duration, now func() time.Time) (*Breaker,error)
func (e *CircuitExecutor) Execute(context.Context, string) (string,error)
```

- [ ] **Step 4: 写并实现 token bucket 测试**

`NewTokenBucket(rate float64, burst int, now func() time.Time)`；初始拥有 burst 个 token；`Allow()` 消耗一个；时间推进按 rate 补充且不超过 burst；并发调用通过 race。

- [ ] **Step 5: 验证并提交**

Run: `go test -race ./28_production_service/internal/resilience`

Commit: `git commit -m "feat: 添加重试熔断与限流组件"`

---

### Task 10: 28 的 API、可观测性和应用生命周期

**Files:**
- Create: `go/code/28_production_service/internal/observability/metrics.go`
- Create: `go/code/28_production_service/internal/observability/metrics_test.go`
- Create: `go/code/28_production_service/internal/api/handler.go`
- Create: `go/code/28_production_service/internal/api/handler_test.go`
- Create: `go/code/28_production_service/internal/app/app.go`
- Create: `go/code/28_production_service/internal/app/app_test.go`
- Create: `go/code/28_production_service/main.go`
- Create: `go/code/28_production_service/integration_test.go`
- Create: `go/knowledge/20_production_service.md`

**Interfaces:**
- Consumes: Tasks 8–9 的 config、jobs、resilience。
- Produces: 可运行服务、业务 Handler、诊断 Handler、`app.Run(context.Context, config.Config, *slog.Logger) error`。

- [ ] **Step 1: 写 HTTP 错误映射失败测试**

使用 fake JobService 覆盖：非法 JSON/超大 Body=400/413，限流=429，队列满/关闭=503，不存在=404，成功提交=202，查询成功=200。所有响应包含 `Content-Type: application/json` 和 request ID。

- [ ] **Step 2: 实现 API 和中间件**

```go
type JobService interface {
	Submit(context.Context, string) (jobs.Job,error)
	Get(string) (jobs.Job,bool)
}
type Limiter interface { Allow() bool }
func NewHandler(JobService, Limiter, *observability.Metrics, *slog.Logger, int64) (http.Handler,error)
```

使用 Go 1.22+ ServeMux 方法模式；Body 用 `http.MaxBytesReader`；JSON Decoder 调 `DisallowUnknownFields`；中间件顺序固定为 request ID → access log/metrics → recover → limiter → route。

- [ ] **Step 3: 实现指标和独立诊断 Handler**

Metrics 使用 typed atomic counter，导出 requests_total、request_errors_total、jobs_submitted_total、jobs_rejected_total、panics_total 和 in_flight。业务指标采用确定性文本顺序。诊断 mux 注册 `/metrics`、`/healthz`、`/readyz` 和 `pprof`；业务 mux 只注册 `/v1/jobs`。

- [ ] **Step 4: 写并实现应用关闭顺序**

测试通过 fake server/engine 记录调用顺序，断言 not ready → business shutdown → engine shutdown → debug shutdown。`app.Run` 使用两个 `http.Server`，任一非 `http.ErrServerClosed` 的错误触发整体取消；关闭错误使用 `errors.Join`。

- [ ] **Step 5: 端到端测试和可运行入口**

Integration Test 使用真实本地 listener 或 `httptest`：提交确定性 SHA-256 工作任务，轮询到 succeeded；制造队列过载、任务超时、临时失败重试、熔断、panic 和客户端取消；每个轮询有 deadline。

`main.go` 使用 `signal.NotifyContext`，默认配置来自 `config.Default()`，日志使用 `slog.NewJSONHandler`，退出时只由 main 决定进程状态，不在库中调用 `os.Exit`。

为自动 smoke test 增加 `-run-for` duration flag；默认值为 0，表示只响应操作系统信号，非零值只用于教材验证并在到期时取消根 context。

- [ ] **Step 6: 编写综合文档和 Benchmark**

文档包括架构、请求数据流、错误表、队列容量、重试/熔断次序、过载保护、指标、pprof、关闭时序、故障注入、12 道面试题和官方资料。Benchmark 至少覆盖 Handler 提交成功、Store Get 和 token bucket Allow。

- [ ] **Step 7: 验证并提交**

Run:

```powershell
go test -race ./28_production_service/...
go test -run=^$ -bench=. -benchmem ./28_production_service/...
go vet ./28_production_service/...
```

Commit: `git commit -m "feat: 完成生产级并发 HTTP 服务课程"`

---

### Task 11: README、全量回归和课程验收

**Files:**
- Modify: `go/code/README.md`
- Modify: `go/knowledge/README.md`
- Verify: `go/code/21_*` through `go/code/28_*`
- Verify: `go/knowledge/13_*` through `go/knowledge/20_*`

**Interfaces:**
- Consumes: Tasks 1–10 的全部产物。
- Produces: 完整学习地图和全仓可验证状态。

- [ ] **Step 1: 更新代码课程 README**

新增“第五阶段：进阶原理与生产实践（21–28）”表格，每行包含主题链接、核心知识、运行命令和专项验证命令；增加推荐顺序 21→23→24→26→25→27→28。

- [ ] **Step 2: 更新知识 README**

新增第四部分八篇文章索引；把学习路线扩展为基础 01–20、底层 01–12、核心八讲三层；注明 Go 1.26.4 和版本敏感内容标记规则。

- [ ] **Step 3: 格式、链接和占位符扫描**

Run:

```powershell
$files = Get-ChildItem ./2[1-8]_* -Recurse -Filter *.go
gofmt -w $files.FullName
Get-ChildItem ..\knowledge\1[3-9]_*.md,..\knowledge\20_*.md | Select-String -Pattern 'TBD|TODO|待定|占位'
git diff --check
```

Expected: 占位符扫描无输出，`git diff --check` 退出 0。

- [ ] **Step 4: 全量测试、竞态和静态检查**

Run:

```powershell
go test ./...
go test -race ./...
go vet ./...
```

Expected: 三条命令退出 0；race 输出无 `DATA RACE`。

- [ ] **Step 5: 专项工具验收**

Run:

```powershell
go test -fuzz=Fuzz -fuzztime=10s ./27_advanced_testing_profiling
go test -gcflags=all=-d=checkptr=2 ./25_reflect_unsafe
go test -run=^$ -bench=. -benchmem ./21_memory_model ./23_backpressure_pipeline ./25_reflect_unsafe ./26_compiler_ssa ./27_advanced_testing_profiling ./28_production_service/...
```

Expected: Fuzz 和 checkptr 通过；所有列出的模块至少输出一个 Benchmark。

- [ ] **Step 6: 运行八个教材入口**

Run:

```powershell
go run ./21_memory_model
go run ./22_structured_concurrency
go run ./23_backpressure_pipeline
go run ./24_http_transport_netpoll
go run ./25_reflect_unsafe
go run ./26_compiler_ssa
go run ./27_advanced_testing_profiling -duration=100ms
go run ./28_production_service -run-for=1s
```

Expected: 所有入口输出章节说明，无 panic；28 输出启动和关闭日志。

- [ ] **Step 7: 最终提交**

```powershell
git add go/code/README.md go/knowledge/README.md
git commit -m "docs: 完善 Go 进阶核心八讲学习地图"
git status --short
```

Expected: commit 成功，`git status --short` 无输出。
