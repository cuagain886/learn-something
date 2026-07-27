# 13 · Go 内存模型：happens-before、原子发布与伪共享 ⭐⭐⭐

> 对应代码：[`../code/21_memory_model`](../code/21_memory_model)

很多并发 bug 不是“两个 goroutine 同时写”这么直观，而是程序错误地假设：源码里先写的语句，另一个 goroutine 就一定先看到。Go 内存模型回答的正是这个问题：**一个 goroutine 的读，什么时候保证能观察到另一个 goroutine 的写？**

---

## 1. 三种顺序关系

### 1.1 sequenced-before

单个 goroutine 内，由语言求值和控制流规则确定的先后关系。它只描述当前 goroutine，不能单独保证另一个 goroutine 看见写入。

### 1.2 synchronized-before

由同步操作建立的跨 goroutine 顺序，例如：

- channel 发送与对应接收；
- Mutex 的 Unlock 与后续 Lock；
- 能被另一个原子操作观察到的 atomic 操作；
- goroutine 创建与新 goroutine 开始执行。

### 1.3 happens-before

happens-before 是 sequenced-before 与 synchronized-before 并集的传递闭包。面试时可以这样表达：

> A happens-before B，意味着内存模型保证 B 能在规则允许的顺序中观察 A 的效果；源码先后不等于 happens-before，必须有同步边。

```text
普通写 message = "ready"
       │ sequenced-before
       ▼
close(done)
       │ synchronized-before
       ▼
<-done 返回
       │ sequenced-before
       ▼
读取 message
```

---

## 2. 数据竞争与 DRF-SC

两个并发内存操作访问同一位置，其中至少一个是写，并且两者没有 happens-before 顺序、也不是全部使用 atomic，就构成 data race。

无数据竞争的 Go 程序具有 DRF-SC 保证：其结果可以解释为 goroutine 操作的某种顺序一致交错。

⚠️ Go 的竞态程序是错误程序，但不要机械地套用 C/C++ 的“完全未定义行为”：Go 对带竞态程序仍规定了部分实现限制，例如不能凭空产生值。不过，多字机器字结构（string、slice、interface 等）发生竞态时可能观察到字段混合，甚至导致内存破坏。工程结论没有区别：**发现竞态就修，不能依赖一次运行结果。**

```powershell
go test -race ./21_memory_model
```

Race Detector 能证明“这次执行发现了竞态”，不能证明“没报告就永远没有竞态”；未被本次调度覆盖的路径不会被发现。

---

## 3. 高频同步规则表

| 操作                   | 内存模型保证                                        |
| -------------------- | --------------------------------------------- |
| 包初始化                 | 被导入包的 `init` 完成先于导入方初始化；全部 `init` 完成先于 `main` |
| `go f()`             | `go` 语句先于新 goroutine 开始执行                     |
| goroutine 退出         | 退出本身不保证先于任何其他事件，必须显式等待                        |
| channel send/receive | send 先于对应 receive 完成                          |
| channel close        | close 先于因关闭而返回零值的 receive                     |
| 无缓冲 channel          | receive 先于对应 send 完成，因此可以双向建立阶段边界             |
| 容量 C 的 channel       | 第 k 次 receive 先于第 k+C 次 send 完成               |
| Mutex/RWMutex        | 第 n 次 Unlock 先于后续第 m 次 Lock 返回（n < m）         |
| Once                 | `Do(f)` 中 f 完成先于所有 `Do(f)` 返回                 |
| atomic               | 可观察到 A 效果的 B 与 A 建立同步；所有 atomic 表现为某个顺序一致总序   |

最容易答错的是 goroutine 退出：

```go
go func() { value = 42 }()
fmt.Println(value) // 没有等待，没有可见性保证，而且存在数据竞争
```

即使把 `Println` 前面加一个很长的 `Sleep`，也没有建立同步关系。时间经过不是内存屏障。

---

## 4. 安全发布整份只读配置

读多写少配置有两种常见实现。

### 4.1 RWMutex
底层
```go
type RWMutex struct {
    w           Mutex        // 互斥锁：用于排他性地限制“多个写操作”之间的竞争
    writerSem   uint32       // 写者信号量：写协程等待“读协程全部退出”的休眠/唤醒通道
    readerSem   uint32       // 读者信号量：读协程等待“写协程释放锁”的休眠/唤醒通道
    readerCount atomic.Int32 // 关键！记录当前活跃的 Reader 数量，以及“是否有 Writer 在等待”
    readerWait  atomic.Int32 // 记录 Writer 进来时，前面还有多少个 Reader 还没离开
}
```

## 核心魔法：`readerCount` 的“反转技巧”

为了实现**防写者饿死**（当有 Writer 等待时，阻塞后续新进来的 Reader），Go 引入了一个巧妙的常量：

$$\text{rwmutexMaxReaders} = 1 \ll 30 \quad (\approx 10.7 亿)$$

当没有 Writer 竞争时，`readerCount` 就是一个正常的正整数（1, 2, 3...）。

一旦有 **Writer 试图加锁**，Go 会做一件神奇的事：**把 `readerCount` 减去 $\text{rwmutexMaxReaders}$**，让它直接变成一个**负数**！

这使得 `readerCount` 具备了**双重含义**：

1. **正数**：表示当前读锁的数量。
    
2. **负数**：表示**现在有 Writer 在等锁或拿着锁**！但只要加上 $\text{rwmutexMaxReaders}$，依然能还原出真实的 Reader 数量。

### `RLock()` (申请读锁)

1. **原子递增**：将 `readerCount` 加 1。
    
2. **检查结果**：
    
    - 如果加 1 后结果**仍是正数**：说明没有 Writer，加锁极快（仅一个 CAS 接口），直接返回。
        
    - 如果加 1 后结果**是负数**：说明当前有 Writer 在等待，新来的 Reader 不能进去！调用 `runtime_SemacquireMutex` 挂起自身，在 `readerSem` 信号量上排队休眠。
        

### `RUnlock()` (释放读锁)

1. **原子递减**：将 `readerCount` 减 1。
    
2. **检查结果**：
    
    - 如果减 1 后结果**大于等于 0**：说明没有 Writer，直接走完流程。
        
    - 如果减 1 后结果**小于 0**：说明有 Writer 在等着！
        
        - 将 `readerWait` 减 1。
            
        - 如果 `readerWait == 0`：说明自己是**最后一个**阻碍 Writer 的读协程！触发 `writerSem` 信号量，**唤醒正在休眠等待的 Writer**。
            

### `Lock()` (申请写锁)

1. **写写互斥**：先调用内部 `w.Lock()`。如果有其他 Writer，直接在这一步被锁住。
    
2. **阻断后续 Reader**：将 `readerCount` 减去 $\text{rwmutexMaxReaders}$（变成负数）。从这一刻起，后续所有新来的 `RLock()` 都会因为看到负数而休眠。
    
3. **等待前面的 Reader 离开**：
    
    - 计算当前还有多少个 Reader 没离开，把这个值存入 `readerWait`。
        
    - 如果 `readerWait != 0`，说明前面还有 Reader 没走完，Writer 调用 `writerSem` 阻塞休眠。
        

### `Unlock()` (释放写锁)

1. **恢复 `readerCount`**：给 `readerCount` 加回 $\text{rwmutexMaxReaders}$，使其恢复为正数（宣告写操作结束）。
    
2. **唤醒所有积压的 Reader**：如果刚才有 Reader 进不来被挂起了，循环调用 `readerSem` 信号量将它们**全部唤醒**。
    
3. **释放内部互斥锁**：调用 `w.Unlock()`，允许下一个 Writer 进场。

两个信号量：
在go的运行时维护了一张全局的哈希表——**`semtable`（信号量哈希表）**：
当出现竞争时，会对两个信号量取地址并hash，得到一个槽位，里面存了一棵树，然后把协程挂载到上面。

优点：

- 能在临界区原子地维护多个相关可变状态；
- 逻辑容易理解；
- 写入失败时可以在解锁前回滚。

代价：每次读都要进入锁协议，竞争严重时还会发生调度和缓存一致性开销。

### 4.2 atomic.Pointer

先构造一份完整、不会再修改的新 Config，再一次 Store 指针：

```go
func (s *AtomicSnapshot) Store(next Config) {
    copyOfNext := next
    s.value.Store(&copyOfNext)
}
```

读者只执行一次 Load，因此只会得到旧快照或新快照，不会得到“Version 是新的、Endpoint 是旧的”这种撕裂状态。

这里有两个不变量：

1. 发布后不得修改指针指向的对象；
2. Load 不把内部可变对象交给调用者修改。

如果 Config 包含 map、slice 或指针，简单复制结构体仍会共享其内部对象。这时应深拷贝，或把内部对象也设计为不可变值。

### 4.3 atomic.Value 与 atomic.Pointer

`atomic.Value` 可以存储任意具体类型，但第一次 Store 后，后续 Store 必须使用同一具体类型，也不能 Store nil。`atomic.Pointer[T]` 有编译期类型约束，更适合单一指针类型。

两者都不应在首次使用后被复制；包含它们的结构体通常也通过指针传递。

---

## 5. CAS 循环为什么必须重试

CAS（Compare-And-Swap）表达的是：

```text
如果当前值仍等于 old，就写入 new 并返回 true；
否则什么也不写，返回 false。
```

在 Load 与 CAS 之间，其他 goroutine 可能已经改了值，因此典型写法是：

```go
for {
    old := counter.Load()
    if counter.CompareAndSwap(old, old+1) {
        break
    }
}
```

单次 CAS 失败不是异常，而是“你的观察已经过期”。高竞争下，大量重试会消耗 CPU，因此无锁不等于更快。

### ABA 问题

goroutine 观察值为 A，暂停期间其他 goroutine 把它改为 B 又改回 A。CAS 只比较当前比特，无法知道值经历过变化。

常见处理方法：

- 把版本号与值一起比较；
- 使用不会快速复用的节点/标识；
- 改用锁，让复合不变量在临界区维护。

Go 有 GC，能减少手工内存回收产生的悬空指针问题，但不会自动消除所有逻辑层 ABA。

---

## 6. 伪共享：字段不同，cache line 相同

两个 goroutine 分别更新两个不同的计数器，语言层面没有数据竞争。如果两个计数器落在同一 cache line，CPU 缓存一致性协议仍需要反复转移这条 cache line 的所有权，导致互相拖慢，这就是 false sharing。

运行：

```powershell
go test -run='^$' -bench='FalseSharing|Padded' -benchmem ./21_memory_model
```

基准中的 64-byte padding 是常见硬件上的教学假设，不是 Go 语言保证。Benchmark 结果也会受 CPU 拓扑、系统负载、GOMAXPROCS 和调度影响，应多次测量趋势：

```powershell
go test -run='^$' -bench='FalseSharing|Padded' -count=5 ./21_memory_model
```

不要为了“可能的伪共享”到处填充结构体。只有 profile/benchmark 证明热点存在，并且内存膨胀可接受时才值得处理。

---

## 7. 典型错误

### 7.1 busy-wait 普通 bool

```go
for !done {}
```

没有同步操作，循环不保证看到另一个 goroutine 对 done 的写入，还会白白占用 CPU。

### 7.2 错误的双重检查

```go
if !initialized { // 普通读，与写并发
    mu.Lock()
    if !initialized {
        resource = build()
        initialized = true
    }
    mu.Unlock()
}
```

外层普通读已经构成竞态；观察到 initialized 也不保证观察到 resource 的完整初始化。优先使用 `sync.Once`、锁或原子快照。

### 7.3 混用 atomic 和普通访问

写用 atomic、读用普通表达式仍然是竞态。参与同一同步协议的访问必须全部遵守协议。

### 7.4 复制锁或原子类型

Mutex、atomic typed value 等一旦使用就不能复制。把含锁结构体按值传参，可能让调用方锁住副本而不是共享状态。`go vet` 的 copylocks 检查可以发现一部分问题。

---

## 8. 工程选择

| 场景 | 优先选择 |
|---|---|
| 一次性初始化 | `sync.Once` |
| 复杂复合不变量 | Mutex |
| 读多写少、整份不可变配置 | `atomic.Pointer[T]` / `atomic.Value` |
| 所有权转移、阶段同步 | channel |
| 单个独立计数器 | typed atomic |
| 需要等待一组 goroutine | WaitGroup/结构化任务组 |

选择标准不是“锁慢不慢”，而是哪个原语最清楚地表达不变量和生命周期。

---

## 9. 高频面试题与参考答案

### Q1. 什么是 happens-before？

它是 sequenced-before 与 synchronized-before 的传递闭包。A happens-before B 时，内存模型才为 B 观察 A 的效果提供顺序保证。

### Q2. `go f()` 前的写，新 goroutine 一定看得到吗？

一定。`go` 语句先于新 goroutine 开始。但反方向不成立：goroutine 退出不会自动先于启动者后续读取，启动者仍需 WaitGroup、channel 等等待。

### Q3. `time.Sleep` 能解决可见性问题吗？

不能。Sleep 只影响调度时间，不建立同步关系，也不能修复数据竞争。

### Q4. Go 的 atomic 是什么内存序？

Go 官方内存模型规定 atomic 操作表现为某个顺序一致的总序；API 不暴露 C++ 那样的 relaxed/acquire/release 参数。

### Q5. atomic.Pointer 发布配置为什么要复制？

为了保证发布对象不可变。Store 自己持有一份新值，调用者之后修改原变量不会改变已发布快照。

### Q6. CAS 一定比 Mutex 快吗？

不一定。高竞争时 CAS 会不断失败重试，消耗 CPU；复杂不变量还会使无锁算法难以证明。必须用基准和可维护性共同判断。

### Q7. 什么是 ABA？Go 有 GC 为什么仍可能发生？

值从 A 变 B 又回 A，CAS 无法发现中间变化。GC 解决部分内存生命周期问题，但版本、状态或节点身份的逻辑 ABA 仍然存在。

### Q8. atomic.Value 有什么陷阱？

首次 Store 决定具体类型，后续类型必须一致；不能 Store nil；首次使用后不能复制；Load 前未 Store 会得到 nil 接口，需要调用方处理。

### Q9. 什么是伪共享？它属于 data race 吗？

不同字段落在同一 cache line，被不同 CPU 核频繁写导致缓存行抖动。它不一定有语言层 data race，但会严重影响性能。

### Q10. Race Detector 没报警，能证明并发安全么？

不能。它是动态检测，只能覆盖本次执行到的路径和交错。正确性还需要明确同步设计、压力测试和代码审查。

---

## 10. 官方资料

- [The Go Memory Model](https://go.dev/ref/mem)
- [`sync` package](https://pkg.go.dev/sync)
- [`sync/atomic` package](https://pkg.go.dev/sync/atomic)
- [Data Race Detector](https://go.dev/doc/articles/race_detector)

## 一句话总结

> 并发正确性不取决于“通常谁先运行”，而取决于能否用同步原语证明 happens-before；atomic 适合发布简单不可变状态，复杂不变量优先用锁表达。
