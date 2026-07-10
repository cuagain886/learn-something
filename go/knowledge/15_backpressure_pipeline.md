# 15 · 背压与有界 Pipeline：系统过载时怎么办 ⭐⭐⭐

> 对应代码：[`../code/23_backpressure_pipeline`](../code/23_backpressure_pipeline)

并发系统最危险的状态通常不是“完全停止”，而是生产速度持续高于消费速度：请求还能进来、队列不断增长、延迟越来越高，最终内存、连接、goroutine 或 deadline 一起崩溃。背压要解决的是：**当下游处理不过来时，上游必须感知并作出有界选择。**

---

## 1. 有界队列为什么是安全边界

无限队列只能把失败推迟：

```text
生产 10k/s → 消费 8k/s → 每秒积压 2k
```

十分钟后就是 120 万个待处理项。即使单项只占 1KB，也还没计算 goroutine、索引和 GC 扫描成本。

有界队列强迫系统在容量耗尽时执行明确策略：

- 阻塞生产者；
- 立即拒绝；
- 丢弃或覆盖；
- 降级到另一条路径。

这不是技术细节，而是业务语义：订单不能随便丢，实时 UI 状态可能只关心最新值，遥测数据可能允许采样。

---

## 2. Little's Law 与容量估算

稳定系统中常用关系：

```text
L = λ × W
```

- L：系统中平均任务数；
- λ：平均到达/吞吐速率；
- W：平均停留时间。

若吞吐 1000 req/s，平均停留 50ms，则平均在途约 50 个。容量不能只按平均值设置，还要考虑峰值、尾延迟和下游抖动；但公式能帮助识别荒谬配置，例如平均在途只有几十却配置百万队列。

队列越大并不等于吞吐越高。它常常只让请求在队列里等到 deadline 过期，浪费更多资源。

---

## 3. 三种策略

### 3.1 PolicyBlock

队列满时，Submit 等待可用空间，同时观察调用方 context 和 Pipeline context。

适合：

- 不能丢任务；
- 上游本身可以变慢；
- 调用链有明确 deadline。

风险：若调用方使用永不取消的 context，下游永久阻塞会把压力变成 goroutine 堆积。因此阻塞策略必须配合超时和入口并发限制。

### 3.2 PolicyReject

队列满立即返回 `ErrQueueFull`。HTTP 层通常映射为 429 或 503，并通过 Retry-After/客户端退避减少重试风暴。

适合：

- 外部请求可以重试；
- 低延迟比“最终一定接受”更重要；
- 系统必须快速保持自我保护。

### 3.3 PolicyKeepLatest

队列满时移除最旧的未处理项，再放入新项。正在执行的任务不会被抢占。

适合：

- 配置刷新、UI 状态、传感器最新读数；
- 中间版本没有独立业务价值。

不适合订单、审计、扣款等每项都必须处理的事件。

本章要求 KeepLatest 使用容量大于 0 的队列，否则“替换排队项”没有意义。

---

## 4. Submit 与 Close 的并发协议

直接让多个生产者向 channel 发送、另一个 goroutine 随时 close，容易出现：

```text
panic: send on closed channel
```

本章 Pipeline 使用两阶段协议：

1. Submit 在状态锁下检查 closed，并登记为活跃 submitter；
2. Submit 释放状态锁后执行可能阻塞的发送；
3. Close 在状态锁下把 closed 设为 true，阻止新的登记；
4. Close 等所有已登记 submitter 结束；
5. 只有 Pipeline 自己关闭 jobs channel。

```text
          state lock
Submit ── check/open + Add ── send ── Done
Close  ── mark closed ─────── Wait ── close(jobs)
```

关键不变量：Close 开始 Wait 后不会再有 WaitGroup.Add。这也避免了 WaitGroup 的 Add/Wait 生命周期误用。

channel 的关闭权属于能够证明“不会再有发送者”的 owner。接收方通常不应关闭输入 channel。

---

## 5. 正常关闭与取消

### 正常 Close

- 拒绝新 Submit；
- 等正在 Submit 的调用结束；
- 关闭输入；
- worker 处理所有已经接受的任务；
- 最后一个 worker 退出后关闭 Results。

这叫 drain，适合部署滚动关闭或批处理正常收尾。

### 父 context 取消

- 阻塞中的 Submit 收到取消；
- 正在执行的 processor 收到同一个 ctx；
- 排队但未执行的项被 worker 快速取出并跳过；
- Wait 返回父取消原因。

取消路径追求尽快释放资源，不保证处理所有排队项。

处理函数仍必须合作检查 context。Pipeline 无法强杀一个忽略 ctx 的 processor。

---

## 6. Results 也是背压点

很多 Worker Pool 只讨论输入队列，却忘了输出：

```text
worker → results channel → consumer
```

如果 consumer 不读 Results，worker 最终会阻塞在发送结果，接着输入队列填满，Submit 也阻塞。这可能正是期望的端到端背压，但调用方必须清楚所有权。

本章约定：

- 创建者持续消费 `Results()`；
- `Results` 只能由 Pipeline 在所有 worker 退出后关闭；
- consumer 不能关闭 Results；
- 调用方应先启动 consumer，再大量 Submit；
- 正常关闭后 range Results，最后 Wait。

---

## 7. Fan-out、Fan-in 与 Pipeline

### Fan-out

多个 worker 从同一输入读取，把 CPU/IO 工作并行化。worker 数不是越多越好：

- CPU 密集通常从 GOMAXPROCS 附近开始测；
- IO 密集可以更多，但要受下游连接池和配额限制；
- 锁竞争或单线程下游会让更多 worker 更慢。

### Fan-in

多个输出合并成一个 Results。关闭顺序必须是：所有发送者退出后，由协调者关闭结果 channel。

### 多阶段 Pipeline

每一阶段都应有自己的容量、context 和错误策略。若阶段 A 比 B 快，A→B 的边界必须施加背压，不能依赖无限缓存。

---

## 8. 统计指标怎样解释

本章暴露：

- Accepted：Submit 成功放入系统的次数；
- Processed：processor 实际执行完成的次数；
- Rejected：Submit 因满、取消等未接受的次数；
- Dropped：已接受但后来被 KeepLatest 覆盖的排队项；
- QueueLength：读取时刻的近似队列长度。

因此正常情况下可能出现：

```text
Accepted = Processed + Dropped + 取消时跳过的排队项
```

QueueLength 是瞬时观测，不应作为跨操作强一致断言。生产监控还应关注提交等待时间、处理时间、端到端延迟和队列最老任务年龄。

---

## 9. Benchmark 与容量实验

```powershell
go test -run='^$' -bench=. -benchmem ./23_backpressure_pipeline
```

本章比较 worker=1/多核、queue=0/64/1024 和三种策略。解读时注意：

- Reject/KeepLatest 可能处理更少任务，因此不能只比较单次循环耗时；
- 大 buffer 可能降低短时阻塞，却增加内存和尾延迟；
- 极短处理函数会让 channel/调度开销占主导；
- 真实容量需要使用接近生产的任务耗时和到达分布压测。

---

## 10. 常见反模式

1. 把 channel 容量设得极大，假装解决吞吐问题；
2. producer 和 consumer 都可能 close 同一 channel；
3. 用 `len(ch)` 做“检查后发送”，中间状态已经变化；
4. processor 不检查 context；
5. 忘记消费 Results，Wait 永久阻塞；
6. 关闭时直接 cancel，丢掉本应排空的任务；
7. 对所有业务统一采用“丢弃最新”；
8. 收到过载后客户端立即无限重试，形成重试风暴。

---

## 11. 高频面试题与参考答案

### Q1. 什么是背压？

当下游处理速度不足时，通过阻塞、拒绝、丢弃或降级把容量信号反馈给上游，使系统资源保持有界。

### Q2. channel buffer 越大吞吐越高吗？

不一定。buffer 主要吸收短时突发，不能提高慢下游的持续处理能力；过大还会增加内存和排队延迟。

### Q3. 谁应该关闭 channel？

能证明不会再发生发送的 owner。通常是发送协调方，而不是接收者。

### Q4. 如何避免 Submit 与 Close 的 send-on-closed panic？

建立生命周期协议：先阻止新 Submit，等待已登记 Submit 结束，再由唯一 owner 关闭 channel；不能只在发送前读一个 bool。

### Q5. PolicyBlock 有什么风险？

若调用方没有 deadline，下游永久阻塞会让提交 goroutine 堆积。必须配 context、入口限流和可观测等待时间。

### Q6. 什么时候适合 KeepLatest？

中间状态可被新状态覆盖的场景，如配置刷新或 UI 状态；不能用于每个事件都必须处理的交易/审计数据。

### Q7. 正常关闭为什么不直接 cancel？

正常关闭通常要排空已接受任务；cancel 表示中止，会让排队项被跳过。两种语义应分开。

### Q8. worker 数怎样设置？

从资源瓶颈出发：CPU 密集参考 GOMAXPROCS，IO 密集参考下游并发能力、连接池和配额，再用负载测试调整。

### Q9. 为什么 Results 也会产生背压？

consumer 变慢会阻塞 worker 发送结果，继而占满输入队列并阻塞 producer。背压会沿整个数据流传播。

### Q10. 队列满返回 429 还是 503？

取决于语义：单个调用方超过速率通常 429；服务整体暂时无容量通常 503。两者都应配合有界、带抖动的客户端退避。

---

## 12. 官方资料

- [The Go Memory Model：channel synchronization](https://go.dev/ref/mem#tmp_7)
- [`context` package](https://pkg.go.dev/context)
- [Go Concurrency Patterns: Pipelines and cancellation](https://go.dev/blog/pipelines)

## 一句话总结

> 高吞吐系统的核心不是“多开 goroutine”，而是给等待数量设上限，并在容量耗尽时执行清晰、可观测、符合业务语义的背压策略。
