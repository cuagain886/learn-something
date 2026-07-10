# 09 · sync 原语深入 ⭐⭐

> Mutex 的"正常模式 vs 饥饿模式"、sync.Pool 的回收时机、atomic 与锁的取舍——这些是并发面试的进阶考点。

---

## 1. sync.Mutex：正常模式 vs 饥饿模式 ⭐（高频）

Mutex 内部就两个字段，靠位运算实现状态机：
```go
type Mutex struct {
    state int32  // 复合状态：锁定位 + 唤醒位 + 饥饿位 + 等待者数量
    sema  uint32 // 信号量，用于阻塞/唤醒 goroutine
}
```

### 两种模式 ⭐

| | 正常模式（normal） | 饥饿模式（starvation） |
|---|------------------|----------------------|
| 唤醒后 | 新来的 goroutine 和被唤醒的**竞争**锁 | 锁**直接交给**队首等待者，新来的不许抢 |
| 优点 | 吞吐高（新来的在 CPU 上，无需上下文切换） | 公平，防止队尾饿死 |
| 缺点 | 队尾可能长期抢不到（饥饿） | 吞吐略低 |

**切换规则**：
- 正常 → 饥饿：某个 goroutine 等待锁**超过 1ms** 还没拿到。
- 饥饿 → 正常：某 goroutine 拿到锁时，发现自己是最后一个等待者，或等待时间 < 1ms。

> **设计精髓**：正常模式优先吞吐（让活跃的 goroutine 快速拿锁，避免切换开销），但用 1ms 阈值兜底公平性，防止极端饥饿。这个"性能与公平的折中"是高质量答案。

### 自旋（spin）

加锁失败时，Mutex 不会立即休眠，而是先**自旋几次**（空转等待），赌锁很快释放——避免"休眠+唤醒"的昂贵上下文切换。自旋条件苛刻（多核、自旋次数<4、P 队列空等），不满足才真正 park。

### Mutex 使用铁律 ⚠️

```go
var mu sync.Mutex
mu.Lock()
defer mu.Unlock()  // ★ 用 defer 防止忘记/panic 时漏解锁

// ⚠️ Mutex 不可重入！同一 goroutine 重复 Lock 会死锁
// mu.Lock(); mu.Lock()  // deadlock

// ⚠️ Mutex 是值类型，不能拷贝！拷贝后是两把不同的锁
// 含 Mutex 的结构体要用指针传递（go vet 会检测 mutex 拷贝）
```

---

## 2. sync.RWMutex：读写锁 ⭐

```go
var rw sync.RWMutex
rw.RLock();  /* 多个读可同时持有 */ rw.RUnlock()
rw.Lock();   /* 写独占，排斥所有读和其他写 */ rw.Unlock()
```

- **读多写少**时性能远胜 Mutex（读之间不互斥）。
- **写优先**：有写锁等待时，新的读锁会被阻塞，防止写饿死。
- ⚠️ 读锁不可升级为写锁（`RLock` 后 `Lock` 会死锁）。
- ⚠️ 写少读多才有收益；写频繁时 RWMutex 比 Mutex 还慢（维护读计数有开销）。

---

## 3. sync.WaitGroup ⭐

```go
var wg sync.WaitGroup
for i := 0; i < 3; i++ {
    wg.Add(1)             // ★ 必须在 go 之前 Add
    go func() {
        defer wg.Done()   // 计数 -1
        // 干活
    }()
}
wg.Wait()                 // 阻塞到计数归零
```

⚠️ **三大坑**：
1. **Add 必须在 goroutine 启动前**调用——若在 goroutine 内 Add，可能 Wait 先执行导致提前返回。
2. **不能拷贝** WaitGroup（值传递会复制内部计数器）——传指针。
3. Add 的负数或 Done 过多会 panic（计数变负）。

> Go 1.25+ 新增 `wg.Go(func(){...})`，自动 Add(1) 并在结束时 Done，更简洁。

---

## 4. sync.Once：单例/一次性初始化 ⭐

```go
var once sync.Once
var instance *Singleton

func GetInstance() *Singleton {
    once.Do(func() {           // 无论多少 goroutine 并发调，func 只执行一次
        instance = &Singleton{} // 其他调用会阻塞等这次执行完
    })
    return instance
}
```

**原理**：内部一个 `done uint32` 标志 + Mutex。用**双重检查 + 原子读** `done`：已完成就直接返回（无锁快路径），未完成才加锁执行。

> ⚠️ `once.Do` 里的函数 panic 了，也算"已执行"，之后不会重试。Go 1.21 新增 `OnceFunc`/`OnceValue`/`OnceValues` 更方便。

---

## 5. sync.Pool：对象复用，减轻 GC ⭐⭐

```go
var bufPool = sync.Pool{
    New: func() any { return new(bytes.Buffer) }, // 池空时的构造函数
}

func handle() {
    buf := bufPool.Get().(*bytes.Buffer) // 取（池空则调 New）
    defer func() {
        buf.Reset()        // ★ 放回前必须重置状态！否则污染下次使用
        bufPool.Put(buf)   // 归还
    }()
    buf.WriteString("...")
}
```

**适用场景**：**高频创建销毁的临时对象**（buffer、临时切片、序列化中间对象）。能大幅减少堆分配和 GC 压力。

⚠️ **关键特性与坑**：
1. **GC 时池会被清空**！Pool 里的对象在每轮 GC 时可能被回收——它是"缓存"不是"对象池"，**不能用来存连接等需要长期持有的资源**（用连接池库）。
2. 取出的对象状态是脏的，**用前/放回前要 Reset**。
3. 底层和 P 绑定（每个 P 有本地 pool），所以**并发性能好**（多数情况无锁）。
4. `Get` 返回的对象不保证是之前 `Put` 的那个，也可能是 New 出来的。

> 标准库大量使用它，如 `fmt`、`encoding/json` 内部都用 sync.Pool 复用缓冲区。

---

## 6. atomic：无锁原子操作 ⭐

```go
import "sync/atomic"

var counter atomic.Int64    // Go 1.19+ 类型化原子（推荐，比函数式更安全）
counter.Add(1)              // 原子加
counter.Load()             // 原子读
counter.Store(100)         // 原子写
counter.CompareAndSwap(100, 200) // CAS：值是 100 才改成 200

// 老式函数风格（仍可用）：
var n int64
atomic.AddInt64(&n, 1)
atomic.LoadInt64(&n)
```

**atomic vs Mutex 怎么选**：
- **单个数值的简单读写/增减** → atomic（无锁，基于 CPU 的 CAS/LOCK 指令，比 Mutex 快）。
- **多个变量要保持一致 / 复杂临界区**（如改 map、多字段） → Mutex。

**CAS（Compare-And-Swap）** 是无锁编程的基石：
```go
// 无锁自增的本质（atomic.Add 内部就是 CAS 循环）
for {
    old := counter.Load()
    if counter.CompareAndSwap(old, old+1) { // 期间没被别人改才成功
        break
    }
    // 失败说明有竞争，重试
}
```
⚠️ CAS 的 **ABA 问题**：值从 A→B→A，CAS 以为没变。Go 一般场景不受影响，但做无锁数据结构时要注意（可加版本号）。

---

## 7. sync.Cond：条件变量（少用但要知道）

```go
var mu sync.Mutex
cond := sync.NewCond(&mu)
ready := false

// 等待方
mu.Lock()
for !ready {        // ★ 必须用 for 而非 if（防止虚假唤醒）
    cond.Wait()     // 释放锁并挂起，被唤醒后重新拿锁
}
mu.Unlock()

// 通知方
mu.Lock()
ready = true
cond.Broadcast()    // 唤醒所有等待者（Signal 唤醒一个）
mu.Unlock()
```

> 现代 Go 更推荐用 **channel** 表达这类"等待条件"的场景，Cond 主要用于"一个事件唤醒多个等待者"且 channel 不好表达时。

---

## 8. 面试速答清单

| 问题 | 一句话答案 |
|------|-----------|
| Mutex 两种模式？ | 正常模式（新旧竞争，吞吐高）/ 饥饿模式（>1ms 等待转入，直接给队首，保公平） |
| Mutex 能重入/拷贝吗？ | 都不能，重入死锁、拷贝是两把锁；用 defer Unlock + 指针传递 |
| RWMutex 何时用？ | 读多写少；写频繁反而比 Mutex 慢 |
| WaitGroup 坑？ | Add 要在 go 前、不能拷贝、Done 过多 panic |
| sync.Once 原理？ | 原子标志双重检查，已完成走无锁快路径 |
| sync.Pool 注意？ | GC 时清空（是缓存非对象池），用前 Reset，不能存连接 |
| atomic vs Mutex？ | 单值用 atomic(CAS 无锁更快)，复杂临界区用 Mutex |
| CAS 是什么？ | Compare-And-Swap，无锁基石，注意 ABA 问题 |

---

## 一句话总结

继续实验：[25 · channel、select 与 runtime semaphore](25_channel_select_semaphore.md) / [`33_channel_select_semaphore`](../code/33_channel_select_semaphore)。

> **Mutex 用正常/饥饿双模式平衡吞吐与公平（1ms 阈值切换）、不可重入不可拷贝；读多写少用 RWMutex；单值并发用 atomic(CAS)，复杂临界区用 Mutex；sync.Pool 复用临时对象降 GC 但 GC 时会清空。**

➡️ 上一篇：[08 · 内存逃逸](08_memory_alloc_escape.md) ｜ 下一篇：[10 · 并发模式与陷阱](10_concurrency_patterns.md)
