# 10 · 并发模式与陷阱 ⭐⭐

> 会用 goroutine/channel 只是入门，面试更看重**并发设计能力**：常见模式怎么写、goroutine 泄漏怎么防、死锁怎么排查。

---

## 1. 经典并发模式

### ① Worker Pool（工作池）⭐

固定数量的 worker 消费任务队列，控制并发度（防止无限开 goroutine 打爆系统）。

```go
func workerPool(tasks []int, numWorkers int) []int {
    jobs := make(chan int, len(tasks))
    results := make(chan int, len(tasks))

    // 启动固定数量 worker
    var wg sync.WaitGroup
    for w := 0; w < numWorkers; w++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for j := range jobs {        // 抢任务，channel 关闭后退出
                results <- j * j
            }
        }()
    }

    for _, t := range tasks { jobs <- t } // 投递任务
    close(jobs)                            // ★ 关闭后 worker 的 range 才能结束

    go func() { wg.Wait(); close(results) }() // 所有 worker 完成后关 results

    var out []int
    for r := range results { out = append(out, r) }
    return out
}
```

### ② Fan-out / Fan-in（分发/汇聚）

多个 goroutine 处理（fan-out），结果汇聚到一个 channel（fan-in）。

```go
// fan-in：把多个 channel 合并成一个
func fanIn(chans ...<-chan int) <-chan int {
    out := make(chan int)
    var wg sync.WaitGroup
    for _, c := range chans {
        wg.Add(1)
        go func(ch <-chan int) {
            defer wg.Done()
            for v := range ch { out <- v }
        }(c)
    }
    go func() { wg.Wait(); close(out) }()
    return out
}
```

### ③ Pipeline（流水线）

每个阶段是一个 goroutine，通过 channel 串联，数据像流水线一样流过。

```go
func gen(nums ...int) <-chan int {       // 阶段1：生产
    out := make(chan int)
    go func() { defer close(out); for _, n := range nums { out <- n } }()
    return out
}
func sq(in <-chan int) <-chan int {      // 阶段2：平方
    out := make(chan int)
    go func() { defer close(out); for n := range in { out <- n * n } }()
    return out
}
// 用：for n := range sq(gen(1, 2, 3)) { ... }  → 1 4 9
```

---

## 2. errgroup：带错误处理的并发 ⭐（实战必备）

`golang.org/x/sync/errgroup` 是工程中最常用的并发控制工具——**并发执行多个任务，任一出错就取消其余，并收集第一个错误**。

```go
import "golang.org/x/sync/errgroup"

func fetchAll(ctx context.Context, urls []string) error {
    g, ctx := errgroup.WithContext(ctx) // ctx 在任一任务出错时自动取消
    results := make([]string, len(urls))

    for i, url := range urls {
        i, url := i, url // (Go 1.22 前需要，1.22+ 可省)
        g.Go(func() error {            // 启动并发任务
            data, err := fetch(ctx, url)
            if err != nil {
                return err             // ★ 返回错误 → ctx 取消 → 其他任务收到取消信号
            }
            results[i] = data
            return nil
        })
    }
    return g.Wait() // 等全部完成，返回第一个非 nil 错误
}

// 还能限制并发数：
g.SetLimit(10) // 最多 10 个任务同时跑
```

> 比手写 WaitGroup + channel + 错误收集简洁太多，是面试展示工程经验的好例子。

---

## 3. ⚠️ goroutine 泄漏（最常见的并发 bug）

goroutine 泄漏 = 启动的 goroutine 永远无法退出，越积越多，内存只增不减。

### 泄漏场景 1：发送到无人接收的 channel
```go
func leak() {
    ch := make(chan int) // 无缓冲
    go func() {
        ch <- 42 // ⚠️ 没有接收者，这个 goroutine 永久阻塞，泄漏！
    }()
    return // 函数返回了，但上面的 goroutine 还卡着
}
```

### 泄漏场景 2：忘记 ctx 取消的退出路径
```go
// ✓ 正确：用 context/done 给 goroutine 退出通道
func worker(ctx context.Context, ch <-chan int) {
    for {
        select {
        case v := <-ch:
            process(v)
        case <-ctx.Done(): // ★ 收到取消信号，退出，不泄漏
            return
        }
    }
}
```

**防泄漏原则**：
1. **启动 goroutine 时就想好它怎么退出**——谁负责让它停？
2. 阻塞的发送/接收都用 `select` + `ctx.Done()` 加退出路径。
3. channel 用**带缓冲**或确保有接收者。
4. 检测：`runtime.NumGoroutine()` 监控数量；pprof 的 goroutine profile 看泄漏的栈。

```go
fmt.Println("当前 goroutine 数:", runtime.NumGoroutine()) // 持续增长 = 泄漏信号
```

---

## 4. ⚠️ 死锁（deadlock）

```go
// 经典死锁：主 goroutine 发送无缓冲 channel，无人接收
func main() {
    ch := make(chan int)
    ch <- 1 // fatal error: all goroutines are asleep - deadlock!
}
```

**死锁的四个必要条件**（面试可能问）：互斥、持有并等待、不可剥夺、循环等待。

**Go 常见死锁**：
1. 无缓冲 channel 自发自收（无并发）。
2. 所有 goroutine 都在等待（Go runtime 能检测到并报 `all goroutines are asleep`）。
3. **加锁顺序不一致**导致循环等待：
```go
// goroutine A: mu1.Lock(); mu2.Lock()
// goroutine B: mu2.Lock(); mu1.Lock()  ⚠️ 顺序相反 → 可能互相等待死锁
// 解法：全局统一加锁顺序（总是先 mu1 再 mu2）
```

> ⚠️ Go 只能检测到"**所有** goroutine 都阻塞"的死锁；**部分死锁**（如两个 goroutine 互锁但其他还在跑）检测不到，要靠 pprof 或 `GODEBUG`。

---

## 5. ⚠️ 数据竞争（data race）

多个 goroutine 并发访问同一变量且至少一个是写，又没有同步——结果未定义。

```go
counter := 0
for i := 0; i < 1000; i++ {
    go func() { counter++ }() // ⚠️ data race，结果 < 1000
}
```

**必杀技：竞态检测器**
```bash
go run -race main.go    # 运行时检测
go test -race ./...     # 测试时检测（CI 必加！）
```
`-race` 会插桩监控内存访问，发现竞争打印两个冲突的栈。**并发代码上线前必须跑 `-race`**。

**修复**：atomic（单值）/ Mutex（复杂）/ channel（传递所有权）三选一。

---

## 6. 并发安全设计准则

1. **优先用 channel 传递数据，而非共享内存**（"Don't communicate by sharing memory; share memory by communicating"）。
2. 必须共享时，**锁与数据封装在一起**（锁放结构体，方法内加锁，调用方无感）：
```go
type SafeCounter struct {
    mu sync.Mutex
    n  int
}
func (c *SafeCounter) Inc() { c.mu.Lock(); defer c.mu.Unlock(); c.n++ }
```
3. **明确数据所有权**：同一时刻只有一个 goroutine 拥有/修改某数据。
4. **不可变数据天然并发安全**：只读就不用锁。
5. 控制并发度（worker pool / `errgroup.SetLimit` / 带缓冲 channel 作信号量）。

```go
// 用带缓冲 channel 当信号量限流
sem := make(chan struct{}, 10) // 最多 10 个并发
for _, task := range tasks {
    sem <- struct{}{}          // 获取令牌（满了阻塞）
    go func(t Task) {
        defer func() { <-sem }() // 释放令牌
        process(t)
    }(task)
}
```

---

## 7. 面试速答清单

| 问题 | 一句话答案 |
|------|-----------|
| 控制并发度？ | worker pool / errgroup.SetLimit / 带缓冲 channel 当信号量 |
| errgroup 作用？ | 并发执行 + 任一出错取消其余 + 收集首个错误，比手写 WaitGroup 简洁 |
| goroutine 泄漏原因？ | 阻塞在无人收的 channel / 没有退出路径；用 select+ctx.Done 防 |
| 怎么检测泄漏？ | runtime.NumGoroutine 监控 + pprof goroutine profile |
| 死锁检测？ | runtime 能测"全部阻塞"，部分死锁要靠 pprof；加锁顺序要统一 |
| 数据竞争怎么查？ | `go run/test -race`，CI 必加 |
| 并发安全设计？ | 优先 channel 传递；共享则锁与数据封装；明确所有权 |

---

## 一句话总结

> **并发设计三板斧：worker pool/errgroup 控并发度、select+ctx.Done 防 goroutine 泄漏、`-race` 查数据竞争；优先用 channel 传递数据所有权，必须共享时把锁和数据封装在一起。**

➡️ 上一篇：[09 · sync 原语](09_sync_primitives.md) ｜ 下一篇：[11 · 性能优化与 pprof](11_performance_pprof.md)
