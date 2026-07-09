# 11 · 性能优化与 pprof ⭐⭐

> 性能优化的铁律：**先测量，再优化**（Don't guess, measure）。本篇讲怎么用 benchmark 和 pprof 定位瓶颈，以及常见性能反模式。

---

## 1. 基准测试 benchmark ⭐

```go
// 文件名 xxx_test.go，函数名 BenchmarkXxx
func BenchmarkConcat(b *testing.B) {
    for b.Loop() {     // Go 1.24+ 写法（老写法 for i := 0; i < b.N; i++）
        _ = strings.Repeat("x", 100)
    }
}

// 需要初始化时，用 b.ResetTimer 排除准备时间
func BenchmarkProcess(b *testing.B) {
    data := setup()    // 准备数据
    b.ResetTimer()     // ★ 重置计时器，不计入上面的准备时间
    for b.Loop() {
        process(data)
    }
}
```

```bash
go test -bench=. -benchmem          # 跑所有基准 + 内存统计
go test -bench=Concat -benchmem     # 只跑名字含 Concat 的
go test -bench=. -benchtime=3s      # 每个基准跑 3 秒
go test -bench=. -count=5           # 跑 5 次（配合 benchstat 做统计显著性）
```

**读懂输出**：
```
BenchmarkConcat-8   1000000   1053 ns/op   512 B/op   3 allocs/op
              ↑       ↑          ↑           ↑          ↑
          GOMAXPROCS 迭代次数  每次耗时   每次分配字节  每次堆分配次数
```
⭐ **三个关键指标**：`ns/op`（速度）、`B/op`（内存量）、`allocs/op`（分配次数，最影响 GC）。优化目标常常是把后两个降下来。

**benchstat 做对比**（避免被噪声误导）：
```bash
go test -bench=. -count=10 > old.txt   # 优化前
# ...改代码...
go test -bench=. -count=10 > new.txt   # 优化后
benchstat old.txt new.txt              # 统计两者差异是否显著
```

---

## 2. pprof：性能剖析利器 ⭐⭐

pprof 能采集 CPU、内存、goroutine、阻塞、锁等多种 profile。

### 方式一：从测试采集
```bash
go test -bench=. -cpuprofile=cpu.out -memprofile=mem.out
go tool pprof cpu.out          # 进入交互式分析
```

### 方式二：Web 服务在线采集（生产常用）⭐
```go
import _ "net/http/pprof"  // ★ 空白导入，自动注册 /debug/pprof 路由

func main() {
    go func() {
        http.ListenAndServe("localhost:6060", nil) // 单独端口暴露 pprof
    }()
    // ... 你的业务
}
```
```bash
# 采集 30 秒 CPU profile 并分析
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30
# 内存
go tool pprof http://localhost:6060/debug/pprof/heap
# goroutine（查泄漏）
go tool pprof http://localhost:6060/debug/pprof/goroutine
```

### pprof 交互命令
```
(pprof) top10        # 耗时/占用最高的 10 个函数 ★最常用
(pprof) list 函数名   # 看该函数逐行的耗时
(pprof) web          # 生成调用图（需装 graphviz）
(pprof) traces       # 调用栈
```

### 火焰图（最直观）⭐
```bash
go tool pprof -http=:8080 cpu.out   # 浏览器打开，看火焰图(Flame Graph)
# 火焰图：横轴=耗时占比，越宽越耗时；纵轴=调用栈深度。一眼看出热点。
```

---

## 3. 五种 profile 各查什么

| profile | 查什么 | 采集路径 |
|---------|--------|---------|
| **CPU** | 哪个函数最耗 CPU | `/debug/pprof/profile` |
| **heap** | 内存分配/占用大户 | `/debug/pprof/heap` |
| **goroutine** | goroutine 泄漏、卡在哪 | `/debug/pprof/goroutine` |
| **block** | goroutine 阻塞在哪（channel/锁） | `/debug/pprof/block`（需开启） |
| **mutex** | 锁竞争热点 | `/debug/pprof/mutex`（需开启） |

block 和 mutex 默认关闭，要手动开：
```go
runtime.SetBlockProfileRate(1)     // 开启阻塞分析
runtime.SetMutexProfileFraction(1) // 开启锁竞争分析
```

---

## 4. 常见性能反模式与优化 ⭐

### ① 字符串拼接用 +（O(n²)）
```go
// ✗ 每次 += 都分配新字符串拷贝旧的
s := ""
for i := 0; i < 10000; i++ { s += "x" }

// ✓ strings.Builder（预分配 + 复用缓冲）
var b strings.Builder
b.Grow(10000)  // 预估容量，进一步减少分配
for i := 0; i < 10000; i++ { b.WriteByte('x') }
s := b.String()
```

### ② 切片/map 不预分配容量
```go
// ✗ 多次扩容，产生中间垃圾
s := []int{}
for i := 0; i < 10000; i++ { s = append(s, i) }

// ✓ 已知大小就预分配
s := make([]int, 0, 10000)  // 一次分配到位
m := make(map[int]int, 10000)
```

### ③ 热点路径用接口装箱
```go
// ✗ fmt.Sprintf 在热点循环里：装箱逃逸 + 反射解析格式串，慢
key := fmt.Sprintf("%d", id)
// ✓ strconv 直达
key := strconv.Itoa(id)
```

### ④ 高频临时对象不复用
```go
// ✓ sync.Pool 复用（见 09）
var bufPool = sync.Pool{New: func() any { return new(bytes.Buffer) }}
```

### ⑤ 不必要的内存拷贝
```go
// 大结构体传值会整体拷贝 → 传指针
func process(data *BigStruct) { ... }
// 但小结构体传值可能更快（栈分配，无逃逸）——要 benchmark 验证
```

### ⑥ defer 在超高频热点（极端情况）
```go
// 1.14+ 开放编码后 defer 已近零开销，但纳秒级热点循环里仍可考虑手动 Unlock
// 这是极端优化，一般不必，先 profile 确认是瓶颈再说
```

---

## 5. 优化方法论 ⭐

```
1. 先用 benchmark/pprof 找到真正的瓶颈（80% 时间在 20% 代码）
2. 优化那 20%，别凭感觉优化（直觉常常错）
3. 每次优化后用 benchmark + benchstat 验证确实变快了
4. 注意权衡：可读性 vs 性能，过早优化是万恶之源
```

> **面试金句**："Premature optimization is the root of all evil"——先写清晰正确的代码，用 profile 定位真瓶颈，再针对性优化，并用数据证明优化有效。

---

## 6. 其他实用诊断工具

```bash
# trace：可视化调度、GC、goroutine 时间线（比 pprof 更细粒度）
go test -trace=trace.out
go tool trace trace.out

# GC 行为
GODEBUG=gctrace=1 ./app        # 每次 GC 详情
# 调度器行为
GODEBUG=schedtrace=1000 ./app  # 每 1000ms 打印 P/M/G 状态

# 逃逸分析（见 08）
go build -gcflags="-m -l" ./...

# 竞态检测（见 10）
go test -race ./...
```

---

## 7. 面试速答清单

| 问题 | 一句话答案 |
|------|-----------|
| 怎么做性能优化？ | 先 benchmark/pprof 测量定位瓶颈，再针对性优化，数据验证 |
| benchmark 关键指标？ | ns/op、B/op、allocs/op（后两个最影响 GC） |
| pprof 能查什么？ | CPU/heap/goroutine/block/mutex 五种 profile |
| 生产怎么接 pprof？ | `import _ "net/http/pprof"` + 独立端口暴露 /debug/pprof |
| 火焰图怎么看？ | 横轴耗时占比(越宽越热)，纵轴调用栈，一眼定位热点 |
| 常见性能坑？ | 字符串+拼接、不预分配、接口装箱、不复用对象 |
| benchstat 作用？ | 多次运行做统计对比，排除噪声判断优化是否显著 |

---

## 一句话总结

> **性能优化先测量后优化：benchmark 看 ns/B/allocs per op、pprof 采集 CPU/heap/goroutine 找热点、火焰图定位；常见优化是 strings.Builder、预分配容量、strconv 替代 Sprintf、sync.Pool 复用——每步用 benchstat 验证。**

➡️ 上一篇：[10 · 并发模式](10_concurrency_patterns.md) ｜ 下一篇：[12 · 高频面试陷阱题集锦](12_interview_traps.md)
