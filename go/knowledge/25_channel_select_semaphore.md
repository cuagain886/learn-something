# 25 · channel、select 与 runtime semaphore 源码深挖 ⭐⭐⭐

> 基于 Go 1.26.4。收发、关闭和 nil channel 语义稳定；`hchan`、`sudog` 与锁字段是当前实现。

## 1. hchan 与等待者

`hchan` 管理环形缓冲、发送/接收索引、关闭状态、锁以及 sendq/recvq。阻塞 G 由 `sudog` 描述，连接 goroutine、元素地址和等待队列。它是 runtime 私有结构，业务不能依赖布局。

## 2. 发送与接收路径

有等待接收者时，发送可直接把值交给对方；否则尝试缓冲区；两者都不可用时，当前 G 入队并 `gopark`。接收是对称过程，唤醒通过 `goready` 让 G 重新 runnable，而不是保证立刻执行。

## 3. close 与 nil

close 唤醒等待者：接收者得到剩余缓冲后获得零值/false，发送者继续执行时 panic。只有发送方或协议拥有者应关闭。nil channel 的收发永久阻塞，select 中常用 nil 动态禁用 case。

## 4. select

runtime 生成 poll order 减少固定偏好，并按稳定 lock order 锁多个 channel，防止死锁。若无 case ready，G 以多个 sudog 注册；一个 case 唤醒后必须清理其他注册。随机化不构成严格公平 SLA。

## 5. runtime semaphore 与 OS 原语

sync.Mutex 等先在用户态原子 fast path 竞争，必要时进入 runtime semaphore 停车。Linux 最底层可能借助 futex 管理线程睡眠，但 Go semaphore 排队的是 goroutine 语义，两层不能简单画等号。

## 6. Mutex、RWMutex、Cond、WaitGroup

Mutex 在竞争下有正常/饥饿策略；RWMutex 协调读者计数和写者；Cond 的 Wait 必须位于 predicate 循环，因为唤醒只表示“可能变化”；WaitGroup 的计数与等待也由原子状态和 semaphore 协作。

## 7. 教学 CondQueue

队列在锁内检查 predicate，Push 后 Signal，Close 后 Broadcast。Pop 清零已消费槽避免引用滞留。它演示条件变量契约，不替代 channel 的所有权表达。

## 8. 工程与验证

```powershell
go test -race ./33_channel_select_semaphore
go test ./33_channel_select_semaphore -run '^$' -bench '.' -benchmem
go run ./33_channel_select_semaphore -iterations=100000
```

不要测试 select 的固定比例；测试消息不丢、关闭可收敛、协议不会 send-on-closed，并用 block/mutex profile 诊断等待。

## 9. 高频面试题与参考答案

### Q1. 无缓冲 channel 如何传值？
发送者与接收者 rendezvous，runtime 可直接复制元素并唤醒对方。
### Q2. buffered channel 满时怎样？
发送 G 入 sendq 并停车，直到空间、关闭或 select 其他 case 生效。
### Q3. close 后接收什么？
先读完缓冲，再持续得到元素零值和 ok=false。
### Q4. 为什么接收方通常不 close？
接收方通常不知道是否还有发送者；关闭权应属于能证明不再发送的一方。
### Q5. nil channel 有何用途？
直接收发永久阻塞；赋 nil 可在 select 中禁用分支。
### Q6. select 公平吗？
实现降低固定偏好，但规范不提供严格公平或最大等待时间保证。
### Q7. sudog 是 goroutine 吗？
不是，它是 G 在特定同步对象上的一次等待记录。
### Q8. gopark 会阻塞线程吗？
通常只停车 G，M/P 可执行其他 G；更底层无工作时线程才可能睡眠。
### Q9. Go semaphore 等于 futex 吗？
不等于；runtime semaphore 管 G 等待，futex 是 Linux 内核线程等待机制之一。
### Q10. Cond 为什么用 for 而不是 if？
被唤醒后条件可能仍不成立或已被其他 waiter 消费，必须重新检查 predicate。
### Q11. Mutex 饥饿模式解决什么？
高竞争下限制新到 goroutine 抢占，改善长期等待者的尾延迟。
### Q12. channel 能替代所有锁吗？
不能。所有权/流水线适合 channel，短临界区共享状态常用 Mutex 更直接高效。

## 10. 源码地图

`runtime/chan.go`、`runtime/select.go`、`runtime/sema.go`、`runtime/lock_futex.go` 与 `sync/{mutex,rwmutex,cond,waitgroup}.go`。

## 一句话总结

channel 与 sync 原语最终都把“条件不满足”转换为 G 停车与唤醒；正确性来自协议和 predicate，不来自调度运气。
