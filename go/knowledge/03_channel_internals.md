# 03 · channel 底层原理 ⭐⭐⭐

> channel 是 Go 并发的灵魂。面试既考"会用"（select/超时/关闭），也考"懂原理"（hchan 结构、收发流程、为什么读已关闭 channel 不阻塞）。

---

## 1. 底层结构：hchan

channel 的真身是 `runtime/chan.go` 的 `hchan`：

```go
type hchan struct {
    qcount   uint           // 缓冲区当前元素个数（len(ch)）
    dataqsiz uint           // 缓冲区容量（cap(ch)）
    buf      unsafe.Pointer // 环形缓冲区指针（有缓冲 channel 才有）
    elemsize uint16         // 单个元素大小
    closed   uint32         // 是否已关闭（0/1）
    elemtype *_type         // 元素类型
    sendx    uint           // 环形缓冲区写位置
    recvx    uint           // 环形缓冲区读位置
    recvq    waitq          // 等待接收的 goroutine 队列（阻塞的接收者）
    sendq    waitq          // 等待发送的 goroutine 队列（阻塞的发送者）
    lock     mutex          // 互斥锁：channel 的所有操作都要先拿锁
}
```

**关键认知**：
- channel 内部有一把 **mutex**——所以 channel 操作是并发安全的，本质是"带锁的环形队列 + 两个等待队列"。
- `recvq` / `sendq` 是双向链表，挂着因为收不到/发不出而**阻塞挂起的 goroutine**（包装成 `sudog`）。

```
有缓冲 channel（cap=4，已存 2 个）:
     buf: ┌────┬────┬────┬────┐  环形缓冲
          │ v0 │ v1 │    │    │
          └────┴────┴────┴────┘
            ▲recvx    ▲sendx

发送者满了就排进 sendq，接收者空了就排进 recvq
```

---

## 2. 收发流程 ⭐（核心机制）

### 发送 `ch <- v` 的决策树

```
1. channel 为 nil？        → 永久阻塞（见陷阱）
2. 已关闭？                → panic: send on closed channel
3. recvq 有等待的接收者？   → 直接把数据【拷贝】给那个接收者，唤醒它（不经过缓冲区！最快路径）
4. 缓冲区还有空位？        → 数据放入 buf，sendx++，返回
5. 以上都不满足           → 当前 goroutine 打包成 sudog 挂入 sendq，park（挂起）
```

### 接收 `v := <-ch` 的决策树

```
1. channel 为 nil？        → 永久阻塞
2. sendq 有等待的发送者？
   - 无缓冲：直接从发送者拷贝数据，唤醒发送者
   - 有缓冲（说明 buf 满）：从 buf 头取一个给接收者，再把发送者的数据放入 buf 尾
3. 缓冲区有数据？          → 从 buf 取出，recvx++
4. 已关闭且缓冲区空？      → 返回零值，ok=false（不阻塞！）
5. 以上都不满足           → 打包成 sudog 挂入 recvq，park（挂起）
```

> ⭐ **重点：goroutine 间直接拷贝。** 当有等待者时，数据是从一个 goroutine 的栈**直接拷贝**到另一个 goroutine，**不经过缓冲区**。这是 channel 高效的关键，也印证了"通过通信共享内存"——数据有明确的所有权转移。

---

## 3. 无缓冲 vs 有缓冲

| | 无缓冲 `make(chan T)` | 有缓冲 `make(chan T, n)` |
|---|---|---|
| 缓冲区 | 无（dataqsiz=0） | 环形数组，容量 n |
| 发送 | **阻塞**直到有接收者（同步会合） | 缓冲未满不阻塞 |
| 接收 | **阻塞**直到有发送者 | 缓冲非空不阻塞 |
| 语义 | 同步、强保证"对方收到了" | 异步、解耦生产消费节奏 |
| 类比 | 当面交接 | 邮箱/快递柜 |

```go
// 无缓冲：发送和接收必须"碰面"，否则双方都等
 unbuf := make(chan int)
go func() { unbuf <- 1 }() // 必须放 goroutine，否则主线程发送就死锁
fmt.Println(<-unbuf)

// 有缓冲：容量内发送不阻塞
buf := make(chan int, 2)
buf <- 1; buf <- 2 // 不阻塞
// buf <- 3        // 满了，阻塞 → 死锁（没有接收者）
```

---

## 4. ⚠️ 关闭 channel 的"三规两不"

```go
ch := make(chan int, 2)
ch <- 1
close(ch)

// ✓ 关闭后仍可读出缓冲区剩余数据，读完返回零值
v, ok := <-ch  // v=1, ok=true
v, ok = <-ch   // v=0, ok=false（缓冲空了，channel 已关）

// ✗ 三条会 panic 的操作：
// close(ch)     // panic: close of closed channel（重复关闭）
// ch <- 2       // panic: send on closed channel（向关闭的发送）
// close(nilCh)  // panic: close of nil channel
```

**规矩**：
- **只由发送方关闭**，且只关一次（"谁生产谁关闭"）。
- 多个发送者时，不要让发送者关——用 `sync.Once` 或专门的信号 channel 协调。
- **关闭是一种广播**：所有阻塞在 `recvq` 的接收者都会被唤醒并收到零值——这是实现"通知多个 goroutine 退出"的常用手法。

```go
// 用 close 广播退出信号给多个 worker
done := make(chan struct{})
for i := 0; i < 3; i++ {
    go func(id int) {
        <-done // 阻塞等待
        fmt.Printf("worker %d 收到退出信号\n", id)
    }(i)
}
close(done) // 一次 close，3 个 worker 全部被唤醒
```

---

## 5. ⚠️ nil channel 的妙用

对 nil channel 的收发都**永久阻塞**，close 会 panic。看似是坑，实则有用：

```go
// 在 select 中动态"禁用"某个分支：把 channel 置 nil，该 case 永不就绪
var in chan int = someChannel
for {
    select {
    case v, ok := <-in:
        if !ok {
            in = nil // ★ channel 关闭后置 nil，下次 select 跳过这个 case
            continue // 避免对已关闭 channel 空转（会一直返回零值忙等）
        }
        process(v)
    case <-done:
        return
    }
}
```

---

## 6. select 的底层 ⭐

```go
select {
case v := <-ch1: ...
case ch2 <- x:   ...
default:         ...
}
```

- **随机选择**：所有就绪的 case 中**伪随机**挑一个执行（`runtime.selectgo` 会先打乱 case 顺序），防止某些 case 饥饿。
- **有 default**：所有 case 都不就绪时立即走 default（非阻塞）。
- **无 default 且都不就绪**：把当前 goroutine 同时挂到**所有** case 涉及 channel 的等待队列上，park；任一 channel 就绪即被唤醒，再把自己从其他队列摘除。
- **空 select `select{}`**：永久阻塞（有时用来阻塞 main 不退出）。

**经典模式：超时控制**
```go
select {
case res := <-resultCh:
    fmt.Println("结果:", res)
case <-time.After(2 * time.Second): // time.After 返回一个 2s 后会收到值的 channel
    fmt.Println("超时！")
}
```
> ⚠️ `time.After` 在 for-select 高频循环里会**泄漏 timer**（每次创建新 timer 直到触发才回收）。高频场景改用 `time.NewTimer` 复用并手动 `Reset`/`Stop`。

---

## 7. 面试速答清单

| 问题 | 一句话答案 |
|------|-----------|
| channel 底层？ | hchan：环形缓冲 + 发送/接收等待队列 + mutex |
| 有等待者时数据怎么传？ | goroutine 间**直接拷贝**，不过缓冲区（最快路径） |
| 读已关闭 channel？ | 缓冲有数据照常读，读完返回零值 + ok=false，不阻塞 |
| 哪些操作 panic？ | 重复 close、向关闭/nil channel 发送、close nil channel |
| nil channel？ | 收发永久阻塞——可在 select 中置 nil 来禁用分支 |
| select 怎么选？ | 就绪的里**随机**选一个；都不就绪则挂到所有 channel 队列上等 |
| 无缓冲 channel 意义？ | 同步会合，保证发送方知道接收方已收到 |
| 谁来 close？ | 发送方，且只关一次；可作退出广播 |

---

## 一句话总结

> **channel = 带锁的环形缓冲 + 收发等待队列；有等待者时 goroutine 间直接拷贝数据；关闭是广播且只能发送方关一次；nil channel 永久阻塞可用于 select 禁用分支。**

➡️ 上一篇：[02 · map](02_map_internals.md) ｜ 下一篇：[04 · interface 底层原理](04_interface_internals.md)
