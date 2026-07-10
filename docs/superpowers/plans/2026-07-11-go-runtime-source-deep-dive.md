# Go runtime 源码深挖八讲 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 01–28 Go 课程之后新增 29–36 八个可运行、可测试、可验证的 runtime 源码深挖模块，并形成从生产现象到源码、工具、工程决策和面试表达的完整闭环。

**Architecture:** 29–35 是互不导入的独立实验模块，使用公开 API、受控教学模型和本机 `$GOROOT/src` 源码地图解释 runtime；36 是独立的综合事故实验室。平台无关路径默认可运行，Linux epoll 使用构建标签，真实 cgo 使用显式 `cgo_lab` 标签，危险场景全部放入受控子进程。

**Tech Stack:** Go 1.26.4、Go 标准库、`testing`、Race Detector、Fuzz、Benchmark、runtime/metrics、runtime/trace、pprof、GODEBUG、Linux epoll、可选 cgo、PowerShell、Markdown。

## Global Constraints

- 目标版本固定为 Go 1.26.4，与 `go/code/go.mod` 一致；源码结论以本机 Go 1.26.4 的 `$GOROOT/src` 为基线。
- 29–36 默认构建只使用 Go 标准库，不新增 `go.sum`，不要求 Docker、数据库、外网或 C 编译器。
- 不导入 `runtime/internal`、`internal/runtime`，不使用 `go:linkname`，不复制私有 runtime 实现作为生产代码。
- 每个源码结论必须标记为公开契约、Go 1.26.4 实现、平台实现或实验观察之一。
- 默认测试在 Windows、Linux 和 macOS 可运行；Linux 专项文件使用 `//go:build linux`。
- 真实 cgo 文件使用 `//go:build cgo && cgo_lab`；stub 使用 `//go:build !cgo || !cgo_lab`，默认构建不会编译 `import "C"`。
- deadlock、fatal error、panic 和长时间阻塞只在子进程中触发；父进程必须设置硬超时并检查退出状态。
- 调度顺序、地址、哈希种子、GC 时间、select 分布和 Benchmark 数值不写固定断言；测试只验证稳定语义和不变量。
- 每章至少包含可运行入口、核心实现、自动测试、一个 Benchmark、对应知识文档和至少 12 道面试题。
- 所有新 Go 文件通过 `gofmt`、`go test ./...`、`go test -race` 和 `go vet ./...`；生成物只写入临时目录。
- 37–44 的分布式工程阶段不在本计划实施，只在 README 中保留后续路线说明。

---

## File Map

### 29_runtime_scheduler

- `go/code/29_runtime_scheduler/main.go`：CPU、锁定线程和 runtime 指标实验入口。
- `go/code/29_runtime_scheduler/scheduler.go`：可取消 CPU 工作负载和调度指标快照。
- `go/code/29_runtime_scheduler/scheduler_test.go`：完成性、取消、参数和指标测试。
- `go/code/29_runtime_scheduler/scheduler_bench_test.go`：任务粒度与并行度 Benchmark。
- `go/knowledge/21_runtime_scheduler.md`：G/M/P、runq、steal、sysmon 与抢占源码地图。

### 30_goroutine_stack_abi

- `go/code/30_goroutine_stack_abi/main.go`：递归、栈捕获、panic 展开和 objdump 命令入口。
- `go/code/30_goroutine_stack_abi/stack.go`：递归/迭代对照、深栈捕获和 recover 边界。
- `go/code/30_goroutine_stack_abi/stack_test.go`：深度、栈文本、panic 和错误测试。
- `go/code/30_goroutine_stack_abi/stack_bench_test.go`：递归、迭代、defer 与参数形态 Benchmark。
- `go/knowledge/22_goroutine_stack_abi.md`：连续栈、栈复制、ABI 和栈展开文档。

### 31_allocator_gc_pacer

- `go/code/31_allocator_gc_pacer/main.go`：分配、保留、GC 参数与内存快照入口。
- `go/code/31_allocator_gc_pacer/allocator.go`：确定性分配器实验、GC 设置作用域和快照类型。
- `go/code/31_allocator_gc_pacer/allocator_test.go`：参数、保留对象、设置恢复和快照测试。
- `go/code/31_allocator_gc_pacer/allocator_bench_test.go`：对象大小、指针密度和 sync.Pool Benchmark。
- `go/knowledge/23_allocator_gc_pacer.md`：分配器、GC pacer、写屏障和 scavenger 源码地图。

### 32_map_swiss_table

- `go/code/32_map_swiss_table/main.go`：碰撞、删除、增长和内置 map 行为实验入口。
- `go/code/32_map_swiss_table/table.go`：简化 Swiss Table 教学模型和确定性哈希器。
- `go/code/32_map_swiss_table/table_test.go`：查找、覆盖、碰撞、删除和增长测试。
- `go/code/32_map_swiss_table/table_fuzz_test.go`：与内置 map 对照的状态机 Fuzz。
- `go/code/32_map_swiss_table/table_bench_test.go`：命中、未命中、预分配和键类型 Benchmark。
- `go/knowledge/24_map_swiss_table.md`：Go 1.26.4 Swiss Table 与旧 hmap 的迁移说明。

### 33_channel_select_semaphore

- `go/code/33_channel_select_semaphore/main.go`：关闭语义、ready select 和 Cond 队列实验入口。
- `go/code/33_channel_select_semaphore/concurrency.go`：CondQueue 和 select 观察辅助类型。
- `go/code/33_channel_select_semaphore/concurrency_test.go`：阻塞唤醒、关闭、并发生产消费和 select 性质测试。
- `go/code/33_channel_select_semaphore/concurrency_bench_test.go`：channel ping-pong 与 CondQueue Benchmark。
- `go/knowledge/25_channel_select_semaphore.md`：hchan、sudog、select、sema 和 sync 源码地图。

### 34_interface_generics_runtime

- `go/code/34_interface_generics_runtime/main.go`：typed nil、调用派发、编译器诊断和 objdump 入口。
- `go/code/34_interface_generics_runtime/dispatch.go`：具体、泛型、接口、反射四条求和路径。
- `go/code/34_interface_generics_runtime/dispatch_test.go`：语义、方法集、typed nil 和反射错误测试。
- `go/code/34_interface_generics_runtime/dispatch_bench_test.go`：四类派发成本 Benchmark。
- `go/knowledge/26_interface_generics_runtime.md`：eface/iface/itab、shape/dictionary 和去虚拟化文档。

### 35_syscall_cgo_netpoll

- `go/code/35_syscall_cgo_netpoll/main.go`：loopback、平台 poller 和可选 cgo 入口。
- `go/code/35_syscall_cgo_netpoll/poll.go`：跨平台长度前缀 loopback 协议。
- `go/code/35_syscall_cgo_netpoll/poll_linux.go`：Linux pipe + epoll 专项实验。
- `go/code/35_syscall_cgo_netpoll/poll_other.go`：非 Linux 平台模型名称和 unsupported 结果。
- `go/code/35_syscall_cgo_netpoll/cgo_lab.go`：显式 cgo_lab 标签下的最小 C 调用。
- `go/code/35_syscall_cgo_netpoll/cgo_stub.go`：默认构建的 cgo 未启用结果。
- `go/code/35_syscall_cgo_netpoll/poll_test.go`：loopback、取消、容量和平台测试。
- `go/code/35_syscall_cgo_netpoll/poll_linux_test.go`：Linux epoll 实际唤醒测试。
- `go/code/35_syscall_cgo_netpoll/cgo_lab_test.go`：显式 cgo_lab 标签下的真实调用测试。
- `go/code/35_syscall_cgo_netpoll/poll_bench_test.go`：loopback 消息大小 Benchmark。
- `go/knowledge/27_syscall_cgo_netpoll.md`：syscall、epoll/IOCP/kqueue、netpoll 与 cgo 文档。

### 36_runtime_forensics

- `go/code/36_runtime_forensics/main.go`：安全场景、诊断文件和危险子进程入口。
- `go/code/36_runtime_forensics/scenario.go`：CPU、分配、Mutex、阻塞场景和 runtime 快照。
- `go/code/36_runtime_forensics/child.go`：带超时的通用子进程执行器。
- `go/code/36_runtime_forensics/scenario_test.go`：安全场景、取消、快照和诊断文件测试。
- `go/code/36_runtime_forensics/child_test.go`：异常退出与超时隔离测试。
- `go/code/36_runtime_forensics/scenario_bench_test.go`：四类故障负载 Benchmark。
- `go/knowledge/28_runtime_forensics.md`：症状到证据链的综合事故手册。

### 索引与旧文档迁移

- `go/code/README.md`：新增第六阶段 29–36 和专项命令。
- `go/knowledge/README.md`：新增第五部分 21–28 和推荐路线。
- `go/knowledge/02_map_internals.md`：明确旧 hmap/bmap 与 Go 1.24+ Swiss Table 的版本边界。
- `go/knowledge/04_interface_internals.md`：增加 26 的深挖链接。
- `go/knowledge/06_gmp_scheduler.md`：增加 21、22、27、28 的实验链接。
- `go/knowledge/07_gc.md`：增加 23、28 的实验链接。
- `go/knowledge/09_sync_primitives.md`：增加 25 的实验链接。
- `go/knowledge/16_http_netpoll.md`：增加 27 的 syscall/netpoll 深挖链接。

---

### Task 0: 基线、版本与源码事实核验

**Files:**
- Read: `go/code/go.mod`
- Read: `docs/superpowers/specs/2026-07-11-go-runtime-source-deep-dive-design.md`
- Read: `$GOROOT/src/runtime`、`$GOROOT/src/internal/runtime/maps`、`$GOROOT/src/internal/abi`、`$GOROOT/src/internal/poll`

**Interfaces:**
- Consumes: 现有 01–28 课程和已批准设计规格。
- Produces: 可重复基线、源文件存在性清单和后续文档使用的版本事实。

- [ ] **Step 1: 记录工具链并运行干净基线**

Run:

```powershell
cd E:\NoteBook\Fighting\go\code
go version
go env GOROOT GOOS GOARCH CGO_ENABLED
go test ./...
go vet ./...
```

Expected: `go version go1.26.4 windows/amd64`；测试和 vet 均退出 0。

- [ ] **Step 2: 核验本机源码入口**

Run:

```powershell
$goroot = go env GOROOT
$paths = @(
  'src\runtime\proc.go','src\runtime\runtime2.go','src\runtime\preempt.go',
  'src\runtime\stack.go','src\runtime\malloc.go','src\runtime\mgcpacer.go',
  'src\internal\runtime\maps','src\runtime\chan.go','src\runtime\select.go',
  'src\runtime\sema.go','src\runtime\iface.go','src\internal\abi\type.go',
  'src\runtime\netpoll.go','src\runtime\netpoll_epoll.go',
  'src\runtime\netpoll_windows.go','src\runtime\netpoll_kqueue.go',
  'src\runtime\cgocall.go','src\internal\poll\fd_poll_runtime.go'
)
$paths | ForEach-Object { if (-not (Test-Path (Join-Path $goroot $_))) { throw "missing $_" } }
```

Expected: 无 `missing` 异常。

- [ ] **Step 3: 固定版本敏感事实**

核验并在对应知识文档中使用以下事实：

```text
runtime/metrics: /sched/goroutines:goroutines
runtime/metrics: /sched/gomaxprocs:threads
runtime/metrics: /gc/heap/objects:objects
runtime/metrics: /gc/heap/goal:bytes
runtime/metrics: /memory/classes/heap/objects:bytes
internal/runtime/maps: abi.MapGroupSlots == 8
internal/runtime/maps: maxAvgGroupLoad == 7
internal/runtime/maps: ctrlEmpty == 0x80, ctrlDeleted == 0xfe
```

Expected: 每项都能在 Go 1.26.4 的 `$GOROOT/src` 找到定义；文档把这些标为“当前实现”，不是语言保证。

---

### Task 1: 29_runtime_scheduler

**Files:**
- Create: `go/code/29_runtime_scheduler/main.go`
- Create: `go/code/29_runtime_scheduler/scheduler.go`
- Create: `go/code/29_runtime_scheduler/scheduler_test.go`
- Create: `go/code/29_runtime_scheduler/scheduler_bench_test.go`
- Create: `go/knowledge/21_runtime_scheduler.md`

**Interfaces:**
- Consumes: `context.Context`、`runtime`、`runtime/metrics`、`sync/atomic`。
- Produces: `WorkloadConfig`、`WorkloadResult`、`RunCPUWorkload(context.Context, WorkloadConfig) (WorkloadResult, error)`、`ReadSchedulerSnapshot() (SchedulerSnapshot, error)`、`ErrInvalidWorkload`。

- [ ] **Step 1: 写 CPU 工作负载失败测试**

```go
func TestRunCPUWorkloadCompletesEveryTask(t *testing.T) {
	cfg := WorkloadConfig{Tasks: 64, Parallelism: 4, Iterations: 200}
	got, err := RunCPUWorkload(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if got.Completed != cfg.Tasks {
		t.Fatalf("Completed = %d, want %d", got.Completed, cfg.Tasks)
	}
	want, err := RunCPUWorkload(context.Background(), WorkloadConfig{
		Tasks: cfg.Tasks, Parallelism: 1, Iterations: cfg.Iterations,
	})
	if err != nil || got.Checksum != want.Checksum {
		t.Fatalf("parallel checksum = %d, sequential = %d, err = %v", got.Checksum, want.Checksum, err)
	}
}

func TestRunCPUWorkloadRejectsInvalidConfig(t *testing.T) {
	_, err := RunCPUWorkload(context.Background(), WorkloadConfig{})
	if !errors.Is(err, ErrInvalidWorkload) {
		t.Fatalf("error = %v, want ErrInvalidWorkload", err)
	}
}
```

- [ ] **Step 2: 验证测试因 API 缺失而失败**

Run: `go test ./29_runtime_scheduler -run 'TestRunCPUWorkload' -v`

Expected: FAIL，包含 `undefined: WorkloadConfig` 或 `undefined: RunCPUWorkload`。

- [ ] **Step 3: 实现确定性、可取消的并行工作负载**

```go
var ErrInvalidWorkload = errors.New("invalid scheduler workload")

type WorkloadConfig struct {
	Tasks       int
	Parallelism int
	Iterations  int
}

type WorkloadResult struct {
	Completed int
	Checksum  uint64
}

func RunCPUWorkload(ctx context.Context, cfg WorkloadConfig) (WorkloadResult, error)
```

实现要求：三个配置值都必须大于 0；使用原子任务索引分发任务，每个 worker 累积局部 `Completed` 和 `Checksum`，结束后由调用 goroutine归并；每个任务的纯函数输入只依赖任务编号和 Iterations，确保不同 Parallelism 得到同一 Checksum；worker 在取任务和内部批次边界检查 `ctx.Done()`；取消返回 `ctx.Err()` 并等待所有 worker 退出。

- [ ] **Step 4: 添加取消与指标测试**

```go
func TestRunCPUWorkloadObservesCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := RunCPUWorkload(ctx, WorkloadConfig{Tasks: 10, Parallelism: 2, Iterations: 10})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}

func TestReadSchedulerSnapshot(t *testing.T) {
	got, err := ReadSchedulerSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	if got.Goroutines == 0 || got.GOMAXPROCS == 0 {
		t.Fatalf("snapshot = %+v, want positive counts", got)
	}
}
```

实现以下类型，并用 `metrics.Read` 读取 `/sched/goroutines:goroutines` 和 `/sched/gomaxprocs:threads`；若指标 Kind 不是 `metrics.KindUint64`，返回包含指标名的错误。

```go
type SchedulerSnapshot struct {
	Goroutines uint64
	GOMAXPROCS uint64
}
```

- [ ] **Step 5: 添加教材入口和 Benchmark**

`main.go` 提供 `-mode=cpu|metrics|locked`、`-tasks`、`-parallelism`、`-iterations`；`locked` 模式在 goroutine 内调用 `runtime.LockOSThread`/`UnlockOSThread`，只展示生命周期边界，不声称 goroutine ID 等于线程 ID。

Benchmark 固定包含：

```go
func BenchmarkCPUWorkloadParallelism1(b *testing.B)
func BenchmarkCPUWorkloadGOMAXPROCS(b *testing.B)
func BenchmarkFineGrainedTasks(b *testing.B)
func BenchmarkCoarseGrainedTasks(b *testing.B)
```

- [ ] **Step 6: 编写源码文档**

`21_runtime_scheduler.md` 固定章节：生产现象、G/M/P 状态、goroutine 创建、runq 与全局队列、work stealing、findRunnable、sysmon、netpoll/timer、系统调用交接、抢占、安全点、LockOSThread/cgo、工具实验、工程决策、至少 12 道面试题、官方资料与源码、一句话总结。

- [ ] **Step 7: 验证并提交**

Run:

```powershell
gofmt -w (Get-ChildItem ./29_runtime_scheduler -Filter *.go).FullName
go test -race ./29_runtime_scheduler
go test -run='^$' -bench=. -benchmem ./29_runtime_scheduler
go vet ./29_runtime_scheduler
go run ./29_runtime_scheduler -mode=metrics
```

Expected: 全部退出 0；指标输出包含正数 goroutines 和 GOMAXPROCS。

Commit: `git commit -m "feat: 添加 Go runtime 调度器源码课程"`

---

### Task 2: 30_goroutine_stack_abi

**Files:**
- Create: `go/code/30_goroutine_stack_abi/main.go`
- Create: `go/code/30_goroutine_stack_abi/stack.go`
- Create: `go/code/30_goroutine_stack_abi/stack_test.go`
- Create: `go/code/30_goroutine_stack_abi/stack_bench_test.go`
- Create: `go/knowledge/22_goroutine_stack_abi.md`

**Interfaces:**
- Consumes: `runtime.Stack`、`runtime.KeepAlive`、`errors`。
- Produces: `RecursiveSum(int) (int, error)`、`IterativeSum(int) (int, error)`、`CaptureStackAtDepth(int) ([]byte, error)`、`InvokeWithRecovery(func()) any`、`MakeCounter(int) func() int`、`ErrInvalidDepth`。

- [ ] **Step 1: 写递归与栈捕获失败测试**

```go
func TestRecursiveAndIterativeSumAgree(t *testing.T) {
	for _, n := range []int{0, 1, 128, 4096} {
		recursive, err := RecursiveSum(n)
		if err != nil {
			t.Fatal(err)
		}
		iterative, err := IterativeSum(n)
		if err != nil || recursive != iterative {
			t.Fatalf("n=%d recursive=%d iterative=%d err=%v", n, recursive, iterative, err)
		}
	}
}

func TestCaptureStackAtDepthContainsRecursiveFrames(t *testing.T) {
	stack, err := CaptureStackAtDepth(32)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(stack, []byte("captureStackAtDepth")) {
		t.Fatalf("stack does not contain recursive helper:\n%s", stack)
	}
}
```

- [ ] **Step 2: 验证失败**

Run: `go test ./30_goroutine_stack_abi -run 'TestRecursive|TestCapture' -v`

Expected: FAIL，包含未定义 API。

- [ ] **Step 3: 实现安全的深栈实验**

```go
const MaxTeachingDepth = 16_384
var ErrInvalidDepth = errors.New("depth is outside teaching limit")

func RecursiveSum(depth int) (int, error)
func IterativeSum(depth int) (int, error)
func CaptureStackAtDepth(depth int) ([]byte, error)
func InvokeWithRecovery(fn func()) (recovered any)
```

深度范围固定为 `0..MaxTeachingDepth`。递归 helper 使用小型局部 marker 并在递归返回后调用 `runtime.KeepAlive(marker)`，避免实验被错误解释为尾调用优化；栈 buffer 从 4 KiB 扩大到 1 MiB，直到 `runtime.Stack` 返回长度小于 buffer；超出上限返回 ErrInvalidDepth，不触发真实栈耗尽。

- [ ] **Step 4: 添加 panic 和边界测试**

```go
func TestInvokeWithRecoveryReturnsPanicValue(t *testing.T) {
	got := InvokeWithRecovery(func() { panic("boom") })
	if got != "boom" {
		t.Fatalf("recovered = %#v, want boom", got)
	}
}

func TestMakeCounterCapturesIndependentState(t *testing.T) {
	left, right := MakeCounter(10), MakeCounter(100)
	if left() != 11 || left() != 12 || right() != 101 {
		t.Fatal("closure state is not independent")
	}
}

func TestDepthValidation(t *testing.T) {
	for _, depth := range []int{-1, MaxTeachingDepth + 1} {
		if _, err := CaptureStackAtDepth(depth); !errors.Is(err, ErrInvalidDepth) {
			t.Fatalf("depth=%d error=%v", depth, err)
		}
	}
}
```

- [ ] **Step 5: 添加 ABI 教材函数、入口和 Benchmark**

实现 `MakeCounter` 返回捕获局部计数器的闭包，用逃逸分析观察捕获状态的存储位置。增加 `//go:noinline func AddSix(a, b, c, d, e, f int) int` 和 `//go:noinline func CallAddSix() int`，供以下命令观察寄存器 ABI：

```powershell
go build -o $env:TEMP\stack_abi.exe ./30_goroutine_stack_abi
go tool objdump -s 'main\.CallAddSix' $env:TEMP\stack_abi.exe
Remove-Item -LiteralPath $env:TEMP\stack_abi.exe
```

Benchmark：`BenchmarkRecursiveSum`、`BenchmarkIterativeSum`、`BenchmarkDeferCleanup`、`BenchmarkExplicitCleanup`、`BenchmarkAddSix`。

- [ ] **Step 6: 编写源码文档**

`22_goroutine_stack_abi.md` 覆盖 stackguard、morestack、newstack、连续栈复制、指针调整、栈收缩、nosplit/systemstack、安全点、寄存器 ABI、调用帧、栈图、defer/panic 展开、objdump 实验、工程边界和至少 12 道面试题。

- [ ] **Step 7: 验证并提交**

Run:

```powershell
go test -race ./30_goroutine_stack_abi
go test -run='^$' -bench=. -benchmem ./30_goroutine_stack_abi
go vet ./30_goroutine_stack_abi
go run ./30_goroutine_stack_abi -depth=128
```

Expected: 全部退出 0，输出包含递归/迭代一致结果和栈帧摘要。

Commit: `git commit -m "feat: 添加 goroutine 栈与 ABI 源码课程"`

---

### Task 3: 31_allocator_gc_pacer

**Files:**
- Create: `go/code/31_allocator_gc_pacer/main.go`
- Create: `go/code/31_allocator_gc_pacer/allocator.go`
- Create: `go/code/31_allocator_gc_pacer/allocator_test.go`
- Create: `go/code/31_allocator_gc_pacer/allocator_bench_test.go`
- Create: `go/knowledge/23_allocator_gc_pacer.md`

**Interfaces:**
- Consumes: `runtime.ReadMemStats`、`runtime/debug`、`sync.Pool`。
- Produces: `AllocationConfig`、`AllocateAndRetain(AllocationConfig) ([][]byte, uint64, error)`、`GCSettings`、`WithGCSettings(GCSettings, func()) error`、`ReadMemorySnapshot() MemorySnapshot`、`ErrInvalidAllocation`、`ErrInvalidGCSettings`。

- [ ] **Step 1: 写确定性分配失败测试**

```go
func TestAllocateAndRetain(t *testing.T) {
	retained, allocated, err := AllocateAndRetain(AllocationConfig{
		Objects: 10, BytesPerObject: 32, KeepEvery: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	if allocated != 320 || len(retained) != 4 {
		t.Fatalf("allocated=%d retained=%d", allocated, len(retained))
	}
	for _, object := range retained {
		if len(object) != 32 {
			t.Fatalf("retained object length = %d", len(object))
		}
	}
}
```

- [ ] **Step 2: 验证失败并实现分配 API**

Run: `go test ./31_allocator_gc_pacer -run TestAllocateAndRetain -v`

Expected: FAIL，包含未定义 API。

```go
type AllocationConfig struct {
	Objects        int
	BytesPerObject int
	KeepEvery      int
}

func AllocateAndRetain(cfg AllocationConfig) (retained [][]byte, allocated uint64, err error)
```

参数必须全部大于 0；每个对象至少写入首尾字节防止无效实验；索引 `index%KeepEvery==0` 的对象保留，其余交给 GC；allocated 使用检查过的乘法，溢出返回 ErrInvalidAllocation。

- [ ] **Step 3: 写并实现 GC 设置作用域测试**

```go
func TestWithGCSettingsCallsBodyAndRestoresSettings(t *testing.T) {
	originalPercent := debug.SetGCPercent(91)
	defer debug.SetGCPercent(originalPercent)
	originalLimit := debug.SetMemoryLimit(128 << 20)
	defer debug.SetMemoryLimit(originalLimit)

	called := false
	err := WithGCSettings(GCSettings{GCPercent: 50, MemoryLimit: 64 << 20}, func() {
		called = true
	})
	if err != nil || !called {
		t.Fatalf("called=%v err=%v", called, err)
	}
	if current := debug.SetGCPercent(91); current != 91 {
		t.Fatalf("GCPercent restored to %d, want 91", current)
	}
	if current := debug.SetMemoryLimit(128 << 20); current != 128<<20 {
		t.Fatalf("MemoryLimit restored to %d, want %d", current, 128<<20)
	}
}
```

```go
type GCSettings struct {
	GCPercent  int
	MemoryLimit int64
}
```

`WithGCSettings` 只接受 `GCPercent >= -1`、`MemoryLimit > 0` 和非 nil body；先保存 `debug.SetGCPercent`、`debug.SetMemoryLimit` 返回的旧值，defer 中按相反顺序恢复，即使 body panic 也恢复后继续传播 panic。该测试不并行运行，避免修改进程全局 GC 配置时互相干扰。

- [ ] **Step 4: 添加内存快照和性质测试**

```go
type MemorySnapshot struct {
	HeapAlloc   uint64
	HeapObjects uint64
	HeapInuse   uint64
	HeapIdle    uint64
	NumGC       uint32
}

func ReadMemorySnapshot() MemorySnapshot
```

测试只检查字段关系和调用安全，例如 `HeapInuse+HeapIdle > 0`；不要求一次分配后立即发生 GC，也不比较固定字节差。

- [ ] **Step 5: 添加入口和 Benchmark**

`main.go` 支持 `-objects`、`-size`、`-keep-every`、`-gc-percent`、`-memory-limit`，打印实验前后快照和保留总量。

Benchmark 固定包含小对象、32 KiB 大对象、指针丰富节点、无指针 `[]uint64`、直接 `make` 和 `sync.Pool` 六组；文档明确 Pool 对象可能在任意 GC 被丢弃。

- [ ] **Step 6: 编写源码文档**

`23_allocator_gc_pacer.md` 覆盖 size class、tiny allocator、mcache/mcentral/mheap、span/page、GC pacer、assist、写屏障、sweep、scavenger、GOGC/GOMEMLIMIT、内存滞留、pprof/metrics/gctrace、至少 12 道面试题和源码索引。

- [ ] **Step 7: 验证并提交**

Run:

```powershell
go test -race ./31_allocator_gc_pacer
go test -run='^$' -bench=. -benchmem ./31_allocator_gc_pacer
go vet ./31_allocator_gc_pacer
go run ./31_allocator_gc_pacer -objects=1000 -size=256 -keep-every=10
```

Expected: 全部退出 0；入口输出前后快照但不声称差值固定。

Commit: `git commit -m "feat: 添加内存分配器与 GC pacer 课程"`

---

### Task 4: 32_map_swiss_table

**Files:**
- Create: `go/code/32_map_swiss_table/main.go`
- Create: `go/code/32_map_swiss_table/table.go`
- Create: `go/code/32_map_swiss_table/table_test.go`
- Create: `go/code/32_map_swiss_table/table_fuzz_test.go`
- Create: `go/code/32_map_swiss_table/table_bench_test.go`
- Create: `go/knowledge/24_map_swiss_table.md`

**Interfaces:**
- Consumes: 泛型 comparable 键、调用方提供的 `Hasher[K]`。
- Produces: `Hasher[K]`、`Table[K,V]`、`NewTable(int, Hasher[K]) (*Table[K,V], error)`、`Set(K,V)`、`Get(K) (V,bool)`、`Delete(K) bool`、`Len() int`、`Capacity() int`、`HashString(string) uint64`、`HashInt(int) uint64`、`ErrInvalidTable`。

- [ ] **Step 1: 写基本行为失败测试**

```go
func TestTableSetGetDeleteAndGrow(t *testing.T) {
	table, err := NewTable[int, string](1, HashInt)
	if err != nil {
		t.Fatal(err)
	}
	for key := range 200 {
		table.Set(key, strconv.Itoa(key))
	}
	for key := range 200 {
		if got, ok := table.Get(key); !ok || got != strconv.Itoa(key) {
			t.Fatalf("Get(%d) = %q,%v", key, got, ok)
		}
	}
	if !table.Delete(17) {
		t.Fatal("Delete(17) = false")
	}
	if _, ok := table.Get(17); ok || table.Len() != 199 {
		t.Fatalf("deleted key remains, len=%d", table.Len())
	}
}
```

- [ ] **Step 2: 验证失败**

Run: `go test ./32_map_swiss_table -run TestTableSetGetDeleteAndGrow -v`

Expected: FAIL，包含 `undefined: NewTable`。

- [ ] **Step 3: 实现简化 Swiss Table 教学模型**

```go
const (
	groupSlots = 8
	ctrlEmpty   = uint8(0x80)
	ctrlDeleted = uint8(0xfe)
	maxLoad     = 7
)

type Hasher[K comparable] func(K) uint64

type entry[K comparable, V any] struct {
	key   K
	value V
}

type Table[K comparable, V any] struct {
	ctrls  []uint8
	slots  []entry[K, V]
	length int
	dead   int
	hash   Hasher[K]
}
```

容量向上取 8 的倍数并保持 2 的幂，最小 8。H2 使用 hash 低 7 位；起始槽使用其余位与 mask。查找逐槽探测，ctrlEmpty 终止，ctrlDeleted 继续；插入优先复用首个 deleted。`(length+dead+1)*8 > capacity*maxLoad` 时扩容并重新插入；删除清零 key/value 防止内存滞留。文件头明确这是教学模型，真实 Go 1.26.4 使用 group 匹配、目录和 table 分裂，二者不逐行等价。

- [ ] **Step 4: 添加碰撞、不变量和参数测试**

使用 `func(int) uint64 { return 1 }` 强制所有键碰撞，验证覆盖值不增加 Len、删除后其他键仍可查、deleted 槽可复用；nil hasher 和负 capacity 返回 ErrInvalidTable。再添加 `checkInvariants()` 测试 helper，确保 full control 数等于 Len、无重复键、容量和切片长度一致。

- [ ] **Step 5: 添加状态机 Fuzz**

```go
func FuzzSwissTable(f *testing.F) {
	f.Add([]byte{0, 1, 10, 1, 2, 20, 2, 1})
	f.Fuzz(func(t *testing.T, ops []byte) {
		table, err := NewTable[int, byte](0, HashInt)
		if err != nil {
			t.Fatal(err)
		}
		model := map[int]byte{}
		for index := 0; index+2 < len(ops); index += 3 {
			op, key, value := ops[index]%3, int(ops[index+1]), ops[index+2]
			switch op {
			case 0:
				table.Set(key, value)
				model[key] = value
			case 1:
				if table.Delete(key) != deleteModel(model, key) {
					t.Fatalf("Delete(%d) disagrees with model", key)
				}
			case 2:
				got, ok := table.Get(key)
				want, wantOK := model[key]
				if ok != wantOK || got != want {
					t.Fatalf("Get(%d)=%d,%v want %d,%v", key, got, ok, want, wantOK)
				}
			}
		}
		if table.Len() != len(model) {
			t.Fatalf("Len=%d want %d", table.Len(), len(model))
		}
	})
}
```

`deleteModel` 在删除前检查键是否存在并返回 bool，保证与 Table.Delete 语义一致。

- [ ] **Step 6: 添加入口、Benchmark 和文档**

入口演示 H1/H2、强碰撞、tombstone、增长以及内置 map 的非固定迭代顺序和并发边界。Benchmark 包含教学 Table 与内置 map 的 hit/miss、预分配、int/string 键；明确教学模型的性能不代表 runtime map。

`24_map_swiss_table.md` 以 Go 1.26.4 `internal/runtime/maps/{map,table,group}.go` 为主，覆盖 control word、8 slots、H1/H2、probe、增长/分裂、小 map、迭代、哈希/相等、并发、旧 hmap 迁移和至少 12 道面试题。

- [ ] **Step 7: 验证并提交**

Run:

```powershell
gofmt -w (Get-ChildItem ./32_map_swiss_table -Filter *.go).FullName
go test -race ./32_map_swiss_table
go test -fuzz=FuzzSwissTable -fuzztime=10s ./32_map_swiss_table
go test -run='^$' -bench=. -benchmem ./32_map_swiss_table
go vet ./32_map_swiss_table
go run ./32_map_swiss_table
```

Expected: 全部退出 0，Fuzz 不产生失败 corpus。

Commit: `git commit -m "feat: 添加 Swiss Table map 源码课程"`

---

### Task 5: 33_channel_select_semaphore

**Files:**
- Create: `go/code/33_channel_select_semaphore/main.go`
- Create: `go/code/33_channel_select_semaphore/concurrency.go`
- Create: `go/code/33_channel_select_semaphore/concurrency_test.go`
- Create: `go/code/33_channel_select_semaphore/concurrency_bench_test.go`
- Create: `go/knowledge/25_channel_select_semaphore.md`

**Interfaces:**
- Consumes: `sync.Cond`、channel、select。
- Produces: `CondQueue[T]`、`NewCondQueue[T]() *CondQueue[T]`、`Push(T) error`、`Pop() (T,bool)`、`Close()`、`SelectStats`、`MeasureReadySelect(int) (SelectStats,error)`、`ErrQueueClosed`、`ErrInvalidIterations`。

- [ ] **Step 1: 写 CondQueue 失败测试**

```go
func TestCondQueueBlocksThenWakes(t *testing.T) {
	queue := NewCondQueue[int]()
	result := make(chan int, 1)
	go func() {
		value, ok := queue.Pop()
		if ok {
			result <- value
		}
	}()

	select {
	case <-result:
		t.Fatal("Pop returned before Push")
	default:
	}
	if err := queue.Push(42); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-result:
		if got != 42 { t.Fatalf("got %d", got) }
	case <-time.After(time.Second):
		t.Fatal("Pop did not wake")
	}
}
```

- [ ] **Step 2: 验证失败并实现队列**

Run: `go test ./33_channel_select_semaphore -run TestCondQueueBlocksThenWakes -v`

Expected: FAIL，包含 `undefined: NewCondQueue`。

```go
type CondQueue[T any] struct {
	mu     sync.Mutex
	ready  *sync.Cond
	items  []T
	head   int
	closed bool
}
```

`Pop` 必须在 `for head == len(items) && !closed` 循环中 Wait；`Push` 在锁内追加后 Signal；`Close` 幂等并 Broadcast；Pop 取出后将槽位写零值，消费完全或 head 足够大时压缩切片，避免长期持有对象。关闭后 Push 返回 ErrQueueClosed，缓冲数据仍可被 Pop 排空，排空后返回零值、false。

- [ ] **Step 3: 添加并发、关闭和 race 测试**

测试 8 个 producer/consumer 传递 4,000 个唯一整数，最终每个值恰好出现一次；关闭唤醒阻塞 Pop；重复 Close 安全；关闭后 Push 失败。同步使用 channel/barrier，不用 Sleep 等待调度。

- [ ] **Step 4: 添加 ready select 观察器**

```go
type SelectStats struct { Left, Right int }

func MeasureReadySelect(iterations int) (SelectStats, error)
```

每轮向两个容量为 1 的 channel 各放一个值，使两个 case 同时 ready；select 一个后显式排空另一个。测试只断言 `Left+Right==iterations`，不要求左右比例，也不把随机选择描述成强公平保证；iterations <= 0 返回 ErrInvalidIterations。

- [ ] **Step 5: 添加入口、Benchmark 和文档**

入口演示关闭后排空、nil channel 禁用 case、两个 ready case 的统计，以及 CondQueue 的 predicate loop。Benchmark 包含 unbuffered ping-pong、buffered channel、CondQueue 单生产者/单消费者和多生产者/多消费者。

`25_channel_select_semaphore.md` 覆盖 hchan/sudog、send/recv 快慢路径、直接传递、close、nil channel、select poll order/lock order、gopark/goready、runtime semaphore、Linux futex、Mutex/RWMutex/Cond/WaitGroup 和至少 12 道面试题。

- [ ] **Step 6: 验证并提交**

Run:

```powershell
go test -race ./33_channel_select_semaphore
go test -run='^$' -bench=. -benchmem ./33_channel_select_semaphore
go vet ./33_channel_select_semaphore
go run ./33_channel_select_semaphore -iterations=10000
```

Expected: 全部退出 0；select 输出只作为观察结果。

Commit: `git commit -m "feat: 添加 channel select 与 semaphore 源码课程"`

---

### Task 6: 34_interface_generics_runtime

**Files:**
- Create: `go/code/34_interface_generics_runtime/main.go`
- Create: `go/code/34_interface_generics_runtime/dispatch.go`
- Create: `go/code/34_interface_generics_runtime/dispatch_test.go`
- Create: `go/code/34_interface_generics_runtime/dispatch_bench_test.go`
- Create: `go/knowledge/26_interface_generics_runtime.md`

**Interfaces:**
- Consumes: 泛型类型集、接口方法集、`reflect`。
- Produces: `Signed`、`SumConcrete([]int) int`、`SumGeneric[T Signed]([]T) T`、`IntSummer`、`IntValues`、`SumViaInterface(IntSummer) int`、`SumViaReflect(any) (int64,error)`、`IsTypedNil(any) bool`、`ErrNotSignedSequence`。

- [ ] **Step 1: 写四条派发路径失败测试**

```go
func TestSumPathsAgree(t *testing.T) {
	values := []int{1, 2, 3, 4}
	if got := SumConcrete(values); got != 10 { t.Fatalf("concrete=%d", got) }
	if got := SumGeneric(values); got != 10 { t.Fatalf("generic=%d", got) }
	if got := SumViaInterface(IntValues(values)); got != 10 { t.Fatalf("interface=%d", got) }
	got, err := SumViaReflect(values)
	if err != nil || got != 10 { t.Fatalf("reflect=%d err=%v", got, err) }
}
```

- [ ] **Step 2: 验证失败并实现具体/泛型/接口路径**

Run: `go test ./34_interface_generics_runtime -run TestSumPathsAgree -v`

Expected: FAIL，包含未定义 API。

```go
type Signed interface { ~int | ~int8 | ~int16 | ~int32 | ~int64 }

type IntSummer interface { Sum() int }
type IntValues []int

func (values IntValues) Sum() int
func SumConcrete(values []int) int
func SumGeneric[T Signed](values []T) T
func SumViaInterface(values IntSummer) int
```

- [ ] **Step 3: 实现反射和 typed nil 边界**

`SumViaReflect` 只接受 slice/array 且元素 Kind 为有符号整数，其他输入返回 ErrNotSignedSequence；nil slice 合法并返回 0。`IsTypedNil` 对 nil 接口返回 true，对 Chan/Func/Interface/Map/Pointer/Slice 使用 Value.IsNil，其他 Kind 返回 false，调用前先处理无效 Value。

测试至少覆盖 typed nil 指针放入接口、非 nil 零值、nil slice、`[]uint`、标量和数组。

- [ ] **Step 4: 添加编译器观察锚点和 Benchmark**

增加 `//go:noinline` wrapper：`CallConcrete`、`CallGeneric`、`CallInterface`、`CallReflect`，避免工具命令找不到符号。Benchmark 对四条路径使用同一 1,024 元素输入和包级 sink，`b.ReportAllocs()`。

入口打印 typed nil 判断和四条求和结果，并列出：

```powershell
go build -gcflags='-m=2' ./34_interface_generics_runtime
go test -run='^$' -bench=. -benchmem ./34_interface_generics_runtime
go build -o $env:TEMP\dispatch.exe ./34_interface_generics_runtime
go tool nm $env:TEMP\dispatch.exe | Select-String 'CallGeneric|CallInterface'
```

- [ ] **Step 5: 编写源码文档**

`26_interface_generics_runtime.md` 覆盖 eface/iface/itab、类型元数据、装箱、typed nil、比较/哈希、动态派发、method set、shape/dictionary、实例化、反射、内联/去虚拟化、工具证据、至少 12 道面试题和源码索引。

- [ ] **Step 6: 验证并提交**

Run:

```powershell
go test -race ./34_interface_generics_runtime
go test -run='^$' -bench=. -benchmem ./34_interface_generics_runtime
go vet ./34_interface_generics_runtime
go run ./34_interface_generics_runtime
```

Expected: 全部退出 0；Benchmark 报告四条路径的 ns/op 与 allocs/op。

Commit: `git commit -m "feat: 添加接口与泛型 runtime 源码课程"`

---

### Task 7: 35_syscall_cgo_netpoll

**Files:**
- Create: `go/code/35_syscall_cgo_netpoll/main.go`
- Create: `go/code/35_syscall_cgo_netpoll/poll.go`
- Create: `go/code/35_syscall_cgo_netpoll/poll_linux.go`
- Create: `go/code/35_syscall_cgo_netpoll/poll_other.go`
- Create: `go/code/35_syscall_cgo_netpoll/cgo_lab.go`
- Create: `go/code/35_syscall_cgo_netpoll/cgo_stub.go`
- Create: `go/code/35_syscall_cgo_netpoll/poll_test.go`
- Create: `go/code/35_syscall_cgo_netpoll/poll_linux_test.go`
- Create: `go/code/35_syscall_cgo_netpoll/cgo_lab_test.go`
- Create: `go/code/35_syscall_cgo_netpoll/poll_bench_test.go`
- Create: `go/knowledge/27_syscall_cgo_netpoll.md`

**Interfaces:**
- Consumes: `net`、`io`、`encoding/binary`、Linux `syscall`、可选 `import "C"`。
- Produces: `LoopbackRoundTrip(context.Context, []byte) ([]byte,error)`、`PlatformPoller() string`、`RunPlatformPoll(context.Context) (int,error)`、`CGOAdd(int,int) (int,error)`、`ErrPayloadTooLarge`、`ErrUnsupported`、`ErrCGOLabDisabled`。

- [ ] **Step 1: 写 loopback 失败测试**

```go
func TestLoopbackRoundTrip(t *testing.T) {
	want := []byte("netpoll")
	got, err := LoopbackRoundTrip(context.Background(), want)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("got %q want %q", got, want)
	}
	want[0] = 'X'
	if string(got) != "netpoll" {
		t.Fatal("response aliases caller buffer")
	}
}
```

- [ ] **Step 2: 验证失败并实现长度前缀协议**

Run: `go test ./35_syscall_cgo_netpoll -run TestLoopbackRoundTrip -v`

Expected: FAIL，包含 `undefined: LoopbackRoundTrip`。

`LoopbackRoundTrip` 先检查 `ctx.Err()`，再在 `127.0.0.1:0` 启动一次性 TCP listener；server goroutine 用 4-byte big-endian 长度读取 payload 并回写相同帧；client 使用 context deadline 设置连接 deadline，完整读写后等待 server 结果；payload 上限 1 MiB，超限返回 ErrPayloadTooLarge；任何返回路径都关闭 listener/conn 并等待 server goroutine，不能泄漏。

- [ ] **Step 3: 添加取消、错误和平台测试**

使用已取消 context 验证返回 context.Canceled；超大 payload 验证 ErrPayloadTooLarge；`PlatformPoller()` 在 Linux 返回 epoll、Windows 返回 iocp、Darwin/BSD 返回 kqueue，其余返回 unsupported。非 Linux `RunPlatformPoll` 返回包装 ErrUnsupported，测试不把它当失败。

- [ ] **Step 4: 实现 Linux epoll 专项文件**

`poll_linux.go` 顶部使用 `//go:build linux`。实现创建 pipe、将 read fd 设为 nonblocking、创建 epoll fd、注册 EPOLLIN、goroutine 写入 1 byte、循环 `EpollWait` 并每 50ms 检查 context；成功返回事件数。所有 fd defer Close，写 goroutine通过 channel 回传错误。

`poll_linux_test.go` 同样只在 Linux 编译，断言事件数 > 0。非 Linux实现只返回 ErrUnsupported。

- [ ] **Step 5: 实现显式 cgo_lab 与 stub**

```go
// cgo_lab.go
//go:build cgo && cgo_lab

package main

/* static int add_ints(int a, int b) { return a + b; } */
import "C"

func CGOAdd(a, b int) (int, error) { return int(C.add_ints(C.int(a), C.int(b))), nil }
```

```go
// cgo_stub.go
//go:build !cgo || !cgo_lab

package main

func CGOAdd(a, b int) (int, error) { return 0, ErrCGOLabDisabled }
```

默认测试接受 ErrCGOLabDisabled；`cgo_lab_test.go` 使用 `//go:build cgo && cgo_lab`，启用标签时断言 `CGOAdd(2,3)==5`。

- [ ] **Step 6: 添加入口、Benchmark 和文档**

入口提供 `-mode=loopback|platform|cgo` 和 `-payload-size`。Benchmark 对 32 B、1 KiB、64 KiB loopback，报告分配；不与内存函数比较并宣称 netpoll 固定开销。

`27_syscall_cgo_netpoll.md` 覆盖 syscall 阻塞、entersyscall/exitsyscall、fd 生命周期、非阻塞 IO、pollDesc、netpollblock/netpollready、epoll/IOCP/kqueue、internal/poll/net 分层、cgo 调度与指针规则、至少 12 道面试题和源码索引。

- [ ] **Step 7: 验证默认、无 cgo、Linux 构建与可选 cgo**

Run:

```powershell
go test -race ./35_syscall_cgo_netpoll
go test -run='^$' -bench=. -benchmem ./35_syscall_cgo_netpoll
go vet ./35_syscall_cgo_netpoll
go run ./35_syscall_cgo_netpoll -mode=loopback
$env:CGO_ENABLED='0'
go test ./35_syscall_cgo_netpoll
Remove-Item Env:CGO_ENABLED
$linuxTest = Join-Path $env:TEMP 'syscall_cgo_netpoll.test'
$env:GOOS='linux'
$env:GOARCH='amd64'
$env:CGO_ENABLED='0'
go test -c -o $linuxTest ./35_syscall_cgo_netpoll
Remove-Item Env:GOOS,Env:GOARCH,Env:CGO_ENABLED
Remove-Item -LiteralPath $linuxTest
```

Expected: 默认、无 cgo 和 Linux 测试二进制编译均退出 0。用 `Get-Command (go env CC) -ErrorAction SilentlyContinue` 确认 C 编译器可用后，再运行 `go test -tags=cgo_lab ./35_syscall_cgo_netpoll`；没有 C 工具链时记录跳过，不能声称已验证真实 cgo。

Commit: `git commit -m "feat: 添加 syscall cgo 与 netpoll 源码课程"`

---

### Task 8: 36_runtime_forensics

**Files:**
- Create: `go/code/36_runtime_forensics/main.go`
- Create: `go/code/36_runtime_forensics/scenario.go`
- Create: `go/code/36_runtime_forensics/child.go`
- Create: `go/code/36_runtime_forensics/scenario_test.go`
- Create: `go/code/36_runtime_forensics/child_test.go`
- Create: `go/code/36_runtime_forensics/scenario_bench_test.go`
- Create: `go/knowledge/28_runtime_forensics.md`

**Interfaces:**
- Consumes: `context`、`runtime`、`runtime/pprof`、`runtime/trace`、`os/exec`。
- Produces: `Scenario` 常量、`ScenarioConfig`、`Report`、`RunScenario(context.Context, ScenarioConfig) (Report,error)`、`RuntimeSnapshot`、`ReadRuntimeSnapshot() (RuntimeSnapshot,error)`、`ChildSpec`、`ChildResult`、`RunChild(context.Context, ChildSpec) (ChildResult,error)`、`ErrUnknownScenario`、`ErrInvalidScenario`、`ErrInvalidChildSpec`。

- [ ] **Step 1: 写安全场景失败测试**

```go
func TestRunScenarioSupportsSafeModes(t *testing.T) {
	for _, scenario := range []Scenario{ScenarioCPU, ScenarioAlloc, ScenarioMutex, ScenarioBlock} {
		t.Run(string(scenario), func(t *testing.T) {
			got, err := RunScenario(context.Background(), ScenarioConfig{
				Scenario: scenario, Duration: 5 * time.Millisecond, Workers: 4,
			})
			if err != nil {
				t.Fatal(err)
			}
			if got.Operations == 0 || got.Scenario != scenario {
				t.Fatalf("report = %+v", got)
			}
		})
	}
}
```

- [ ] **Step 2: 验证失败并实现场景框架**

Run: `go test ./36_runtime_forensics -run TestRunScenarioSupportsSafeModes -v`

Expected: FAIL，包含未定义 API。

```go
type Scenario string
const (
	ScenarioCPU   Scenario = "cpu"
	ScenarioAlloc Scenario = "alloc"
	ScenarioMutex Scenario = "mutex"
	ScenarioBlock Scenario = "block"
)

type ScenarioConfig struct {
	Scenario Scenario
	Duration time.Duration
	Workers  int
}

type Report struct {
	Scenario   Scenario
	Operations uint64
	Before     RuntimeSnapshot
	After      RuntimeSnapshot
}
```

RunScenario 校验 Duration/Workers，建立内部 timeout context，调用四个独立 workload，等待所有 goroutine 后返回；每个 worker 至少完成一次操作后才检查 timeout，保证合法短场景仍有稳定的正 Operations；内部 timeout 表示场景正常结束，父 context 提前取消则返回父 context 错误。alloc 场景循环复用有界 retained ring，不能按 Duration 无限增长内存。

- [ ] **Step 3: 实现 runtime 快照与错误测试**

```go
type RuntimeSnapshot struct {
	Goroutines     uint64
	HeapObjectBytes uint64
	HeapObjects    uint64
	HeapGoal       uint64
	NumGC          uint32
}
```

`ReadRuntimeSnapshot() (RuntimeSnapshot,error)` 使用 `runtime/metrics` 读取 `/sched/goroutines:goroutines`、`/memory/classes/heap/objects:bytes`、`/gc/heap/objects:objects` 和 `/gc/heap/goal:bytes`，校验每项为 KindUint64；使用 `runtime.ReadMemStats` 补充 NumGC。测试只断言 Goroutines > 0；未知场景返回 ErrUnknownScenario；Duration <= 0、Workers <= 0 返回 ErrInvalidScenario；预取消父 context 返回 context.Canceled。

- [ ] **Step 4: 写子进程失败测试并实现执行器**

```go
type ChildSpec struct {
	Executable string
	Args       []string
	Env        []string
}

type ChildResult struct {
	ExitCode int
	Output   string
	TimedOut bool
}

func RunChild(ctx context.Context, spec ChildSpec) (ChildResult, error)
```

测试使用当前测试二进制和 `GO_FORENSICS_HELPER=1`：一个 helper `panic("child panic")`，期望非零 ExitCode 且 Output 含稳定 marker；另一个 helper Sleep 5 秒，父 context 20ms，期望 TimedOut=true 且 error 包装 context.DeadlineExceeded。非零子进程退出是可观察结果，不作为 RunChild 的启动错误返回；Executable 为空才返回 ErrInvalidChildSpec。

- [ ] **Step 5: 添加安全入口、危险入口和诊断文件**

`main.go` 提供：

```text
-scenario=cpu|alloc|mutex|block
-duration=200ms
-workers=4
-cpu-profile=<path>
-trace=<path>
-danger=panic|deadlock
-child=<internal value>
```

默认只运行安全场景。`-danger` 由父进程用自身 executable 启动 `-child`，设置 2 秒 timeout 并打印 ExitCode/TimedOut；child panic 输出 marker 后 panic，child deadlock 输出 marker 后 `select {}`。CPU profile 和 trace 只在用户指定路径时创建，启动失败立即关闭已经打开的文件，Stop 顺序与 Start 相反。

测试在 `t.TempDir()` 运行短 CPU profile 和 trace，断言文件存在且非空；测试结束没有仓库内产物。

- [ ] **Step 6: 添加 Benchmark 和事故文档**

Benchmark 分别调用 CPU 核心循环、分配批次、Mutex 争用批次和 channel 阻塞批次；Benchmark 不依赖 wall-clock timeout，而是以固定操作数执行。

`28_runtime_forensics.md` 固定章节：事故分诊树、CPU、goroutine 泄漏、锁竞争、GC/堆滞留、panic/fatal、pprof、trace、schedtrace/gctrace、runtime/metrics、子进程安全实验、完整证据链案例、至少 12 道面试题、官方资料和源码索引。

- [ ] **Step 7: 验证并提交**

Run:

```powershell
go test -race ./36_runtime_forensics
go test -run='^$' -bench=. -benchmem ./36_runtime_forensics
go vet ./36_runtime_forensics
go run ./36_runtime_forensics -scenario=cpu -duration=50ms
$profile = Join-Path $env:TEMP 'forensics-cpu.pprof'
go run ./36_runtime_forensics -scenario=cpu -duration=100ms -cpu-profile $profile
Remove-Item -LiteralPath $profile
```

Expected: 全部退出 0；profile 写在系统临时目录并清理。

Commit: `git commit -m "feat: 添加 Go runtime 综合事故实验室"`

---

### Task 9: 学习地图、旧文档迁移与全量验收

**Files:**
- Modify: `go/code/README.md`
- Modify: `go/knowledge/README.md`
- Modify: `go/knowledge/02_map_internals.md`
- Modify: `go/knowledge/04_interface_internals.md`
- Modify: `go/knowledge/06_gmp_scheduler.md`
- Modify: `go/knowledge/07_gc.md`
- Modify: `go/knowledge/09_sync_primitives.md`
- Modify: `go/knowledge/16_http_netpoll.md`

**Interfaces:**
- Consumes: 29–36 全部实现、测试、Benchmark 和知识文档。
- Produces: 可导航课程地图、清晰版本迁移提示和最终验收证据。

- [ ] **Step 1: 更新代码学习地图**

在 `go/code/README.md` 新增“第六阶段：runtime 源码与系统边界（29–36）”表格，每行包含主题链接、核心知识、运行命令和专项验证。增加统一命令：race、Swiss Fuzz、Linux test-binary cross build、`CGO_ENABLED=0` 和可选 `-tags=cgo_lab`。推荐顺序固定为：

```text
29 → 30 → 31 → 32 → 33 → 34 → 35 → 36
```

- [ ] **Step 2: 更新知识索引和旧文档版本边界**

`go/knowledge/README.md` 新增第五部分 21–28 表格和源码深挖路线。

`02_map_internals.md` 开头增加醒目版本说明：该文 hmap/bmap 描述 Go 1.23 及更早的旧实现；Go 1.24+ 已切换到 Swiss Table，当前 Go 1.26.4 详见 `24_map_swiss_table.md`。不得只加链接而保留“当前实现仍是 hmap/bmap”的矛盾措辞。

其余旧文档在“一句话总结”前增加“继续实验”段，链接到对应 21–28，不复制新文档正文。

- [ ] **Step 3: 检查文档结构和面试题数量**

Run:

```powershell
$docs = 21..28 | ForEach-Object { Get-ChildItem ..\knowledge -Filter ("{0:D2}_*.md" -f $_) }
foreach ($doc in $docs) {
  $questions = (Select-String -Encoding utf8 -LiteralPath $doc.FullName -Pattern '^### Q\d+\.').Count
  if ($questions -lt 12) { throw "$($doc.Name) has only $questions questions" }
}
$tokens = @(('T' + 'BD'), ('T' + 'ODO'))
$pattern = '^(\s*)(' + ($tokens -join '|') + ')(\b|:|：)'
$placeholders = $docs | Select-String -Encoding utf8 -Pattern $pattern
if ($placeholders) { throw 'placeholder found' }
```

Expected: 每篇至少 12 道题，无占位内容。

- [ ] **Step 4: 格式化并运行全量默认验证**

Run:

```powershell
gofmt -w (Get-ChildItem ./29_runtime_scheduler,./30_goroutine_stack_abi,./31_allocator_gc_pacer,./32_map_swiss_table,./33_channel_select_semaphore,./34_interface_generics_runtime,./35_syscall_cgo_netpoll,./36_runtime_forensics -Recurse -Filter *.go).FullName
go test ./...
go test -race ./29_runtime_scheduler ./30_goroutine_stack_abi ./31_allocator_gc_pacer ./32_map_swiss_table ./33_channel_select_semaphore ./34_interface_generics_runtime ./35_syscall_cgo_netpoll ./36_runtime_forensics
go vet ./...
```

Expected: 全部退出 0，无 DATA RACE。

- [ ] **Step 5: 运行专项验证**

Run:

```powershell
go test -fuzz=FuzzSwissTable -fuzztime=10s ./32_map_swiss_table
go test -run='^$' -bench=. -benchmem ./29_runtime_scheduler ./30_goroutine_stack_abi ./31_allocator_gc_pacer ./32_map_swiss_table ./33_channel_select_semaphore ./34_interface_generics_runtime ./35_syscall_cgo_netpoll ./36_runtime_forensics
$env:CGO_ENABLED='0'
go test ./...
Remove-Item Env:CGO_ENABLED
foreach ($module in 29..36) {
  $dir = Get-ChildItem -Directory -Filter ("{0:D2}_*" -f $module)
  go run ("./" + $dir.Name)
  if ($LASTEXITCODE -ne 0) { throw "$($dir.Name) failed" }
}
```

Expected: Fuzz、Benchmark、无 cgo 全量测试和八个入口均退出 0。

- [ ] **Step 6: 验证 Linux 构建并记录运行边界**

Run:

```powershell
$linuxTest = Join-Path $env:TEMP 'runtime-source-deep-dive.test'
$env:GOOS='linux'
$env:GOARCH='amd64'
$env:CGO_ENABLED='0'
go test -c -o $linuxTest ./35_syscall_cgo_netpoll
Remove-Item Env:GOOS,Env:GOARCH,Env:CGO_ENABLED
Remove-Item -LiteralPath $linuxTest
```

Expected: 交叉编译退出 0。只有在 Linux 环境实际执行 `go test -race ./35_syscall_cgo_netpoll` 后，才能记录 epoll 运行验证；Windows 会话只记录 Linux 编译通过。

- [ ] **Step 7: 检查仓库卫生并提交**

Run:

```powershell
git diff --check
$newDirs = 29..36 | ForEach-Object { Get-ChildItem -Directory -Filter ("{0:D2}_*" -f $_) }
$artifacts = Get-ChildItem -LiteralPath $newDirs.FullName -Recurse -File | Where-Object { $_.Extension -in '.pprof','.out','.test','.exe' }
if ($artifacts) {
  $artifacts.FullName
  throw 'generated artifact remains'
}
git status --short
```

Expected: 无空白错误、无生成物，只显示本任务预期 README/旧文档修改。

Commit: `git commit -m "docs: 完善 Go runtime 源码课程学习地图"`

---

## Final Acceptance

- 29–36 八个代码目录、21–28 八篇知识文档及索引全部存在。
- 每章至少一个 main、自动测试、Benchmark 和 12 道面试题。
- 默认测试不依赖 Docker、外网、C 编译器或 Linux 运行环境。
- 危险实验只在子进程中触发，测试具有硬超时。
- Swiss Table 教学模型有单元测试、碰撞测试和 Fuzz 状态机。
- Go 1.26.4 私有实现、稳定契约与平台差异在文档中明确区分。
- `go test ./...`、八章 race、`go vet ./...`、Fuzz、Benchmark、无 cgo 测试和八个入口全部通过。
- Linux amd64 测试二进制交叉编译通过；Linux epoll 是否实际运行如实记录。
- 仓库中没有 profile、trace、测试二进制或其他生成物。
