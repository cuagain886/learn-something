# 14 · 结构化并发：让 goroutine 有父级、有边界、有结局 ⭐⭐⭐

> 对应代码：[`../code/22_structured_concurrency`](../code/22_structured_concurrency)

goroutine 很便宜，但不是免费资源。每个 goroutine 都会持有栈、调度状态以及它引用的对象。生产代码真正困难的不是 `go f()`，而是回答四个问题：谁启动它、谁取消它、谁等待它、错误交给谁？

---

## 1. 什么是结构化并发

结构化并发要求并发任务形成与调用结构一致的生命周期树：

```text
请求/批处理作用域
├── task A
├── task B
│   ├── task B1
│   └── task B2
└── task C
```

父作用域返回前，应当知道所有直接子任务已经：

- 成功完成；
- 返回错误；
- 因父级取消而退出；
- 发生 panic 并被边界转换为可管理的失败。

“启动后不再关心”的后台 goroutine 也必须归属于更长生命周期的 owner，例如 Server、Engine 或进程根 context，而不是没有归属。

---

## 2. 本章 TaskGroup 的契约

```go
group, err := NewTaskGroup(parent, limit)
group.Go(func(ctx context.Context) error { ... })
err = group.Wait()
```

契约如下：

1. `limit == 0` 表示不限制同时执行的任务，正数表示执行上限，负数非法。
2. 第一个非 nil 任务错误会成为稳定结果，并通过 `context.WithCancelCause` 取消兄弟任务。
3. `Wait` 开始后拒绝新任务，避免 `WaitGroup.Add` 与 `Wait` 的生命周期竞态。
4. `Wait` 等全部已接受任务真正退出，而不是发出取消后立刻返回。
5. `Wait` 可以重复调用并返回同一个结果。
6. 任务 panic 在 goroutine 边界恢复，转换为包含堆栈的 `PanicError`。

注意：限制的是“进入任务函数的数量”。`Go` 仍然会为等待令牌的任务创建 goroutine。因此它适合一组数量已知的子任务，不适合直接承接无限外部流量；后者应使用下一章的有界队列和背压。

---

## 3. 首错取消的数据流

```text
task A 返回 error E
        │
        ├── 记录 first=E（只允许一次）
        ├── cancel(E)
        │      ├── task B 的 ctx.Done 关闭
        │      └── task C 的 ctx.Done 关闭
        └── A 退出并 Done

Wait → 等待 A/B/C 全部 Done → 返回 E
```

为什么不是“第一个错误出现就立刻返回”？因为立即返回会把仍在运行的 goroutine 留给已经结束的调用作用域，资源和错误都失去 owner。

“首错”是并发完成顺序，不是提交顺序。如果多个任务几乎同时失败，哪个先拿到记录锁，哪个成为首错。调用方不应依赖错误顺序，除非业务显式定义优先级并集中仲裁。

---

## 4. context 取消是协作，不是强杀

取消 context 只会关闭 `Done()` 并提供错误原因。任务必须主动观察：

```go
select {
case item := <-input:
    return process(item)
case <-ctx.Done():
    return context.Cause(ctx)
}
```

如果任务执行不可中断的系统调用、死循环，或者从不检查 ctx，父级无法安全“杀死”它。Go 不提供任意终止 goroutine 的 API，因为在任意指令点终止会破坏锁、内存和资源不变量。

### Cancel 与 CancelCause

- `context.WithCancel`：观察者通常只看到 `context.Canceled`。
- `context.WithTimeout`：超时原因通常为 `context.DeadlineExceeded`。
- `context.WithCancelCause`：可以保留触发整组取消的业务错误，通过 `context.Cause(ctx)` 获取。

库代码应返回错误；只有作用域 owner 决定是否记录、重试或映射为 HTTP 状态。

---

## 5. WaitGroup 的正确边界

经典规则是 Add 必须在启动 goroutine 之前：

```go
wg.Add(1)
go func() {
    defer wg.Done()
    work()
}()
```

Go 1.25+ 的 `WaitGroup.Go` 封装了 Add/Done，但文档契约要求传入函数不能 panic。它解决的是计数样板代码，不负责错误传播、context 取消或 panic 转换。

本章 TaskGroup 在同一把状态锁下检查 `waiting` 并执行 `wg.Add(1)`；Wait 在同一把锁下把 `waiting` 置为 true 后才开始 `wg.Wait()`，从协议上消除“Wait 已开始又 Add”的歧义。

---

## 6. panic 为什么必须在 goroutine 内 recover

`recover` 只能捕获当前 goroutine 调用栈正在展开的 panic：

```go
defer func() {
    if value := recover(); value != nil {
        record(&PanicError{Value: value, Stack: debug.Stack()})
    }
}()
task(ctx)
```

在启动者 goroutine 外层 defer recover，捕获不到子 goroutine 的 panic。HTTP server 会在连接/请求边界做一定恢复，但自己启动的 worker、consumer、scheduler 仍要定义 panic 策略。

恢复 panic 后至少要：

- 保留 `debug.Stack()` 供日志和诊断；
- 把任务标记为失败；
- 释放令牌、锁、WaitGroup 和其他资源；
- 决定是否取消同组任务。

不要静默 recover 后继续假装成功。

---

## 7. 并发上限与背压不是同一件事

并发上限约束正在执行的工作数量，保护 CPU、下游连接或文件描述符。背压还必须约束等待中的工作数量。

```text
仅 semaphore：100 万请求 → 100 万 goroutine 等 10 个令牌
有界队列：   100 万请求 → 接受固定数量，其余阻塞或拒绝
```

因此：

- 已知长度、调用内分叉：TaskGroup + semaphore；
- 持续流量、生产消费速率不同：有界 Pipeline/Worker Pool；
- HTTP 外部流量：入口限流 + 有界队列 + deadline。

---

## 8. goroutine 泄漏检查思路

常见泄漏：

1. 向无人接收的 channel 发送；
2. 从永不关闭的 channel 接收；
3. ticker 没 Stop；
4. context 已取消但循环不检查；
5. 结果 channel 无消费者，worker 永久卡住；
6. 只 cancel 不 Wait，清理尚未完成调用方就返回。

测试优先验证“完成 channel 在 deadline 前关闭”和“所有 worker 都参与 Wait”。不要严格断言瞬时 `runtime.NumGoroutine()`，因为 runtime、测试框架和其他包会创建背景 goroutine。

---

## 9. Benchmark 应该怎样看

```powershell
go test -run='^$' -bench=. -benchmem ./22_structured_concurrency
```

直接函数调用与 TaskGroup 并非同一语义：后者购买了 goroutine 调度、错误聚合、取消、等待和 panic 边界。Benchmark 用来理解成本，不是用来得出“以后都不要结构化并发”的结论。

如果任务只有几十纳秒，启动 goroutine 本身就可能比任务贵；应批处理或保持同步。如果任务包含网络/磁盘等待，并发管理开销通常不是主导因素。

---

## 10. 高频面试题与参考答案

### Q1. 什么是结构化并发？

并发任务必须隶属于明确作用域；父作用域负责启动、取消、等待和收集子任务错误，返回时不遗留失去 owner 的任务。

### Q2. context 能强制停止 goroutine 吗？

不能。取消是协作信号，任务要在循环、channel、IO 或阶段边界检查 `Done()`。

### Q3. 为什么首错后仍要 Wait？

取消只发信号，子任务还要释放资源和退出。立刻返回会产生泄漏、越界访问调用方资源或丢失后续清理错误。

### Q4. `context.Cause` 相比 `ctx.Err()` 有什么价值？

`ctx.Err()` 通常只有 Canceled/DeadlineExceeded；Cause 可以保留触发取消的原始业务错误，便于错误链判断和日志诊断。

### Q5. WaitGroup Add 为什么通常放在 go 之前？

否则新 goroutine 还没 Add，Wait 可能已经观察到计数为零并返回。Add 与开始等待的协议必须明确。

### Q6. 父 goroutine 的 recover 能捕获子 goroutine panic 吗？

不能。recover 只作用于当前 goroutine 的 panic 栈展开，必须在子 goroutine 内部设置 defer 边界。

### Q7. semaphore 限制并发后，还会 goroutine 泄漏吗？

会。若先创建 goroutine 再等令牌，等待数量仍可能无限；若取消路径不释放令牌也会永久阻塞。外部流量需要有界队列。

### Q8. context.Value 应该存什么？

只存请求范围、跨 API 边界的元数据，如 trace/request ID；不用于传递可选业务参数、数据库连接或全局依赖。

### Q9. 多个任务同时报错，怎样保证错误顺序？

普通首错模型不保证提交顺序，只保证某个最先完成记录的错误成为结果。如需优先级，应收集后按业务规则排序或集中仲裁。

### Q10. `WaitGroup.Go` 能替代带错误的任务组吗？

不能完全替代。它封装计数，但不提供 error 返回、首错取消、取消原因和 panic 转换；适合不返回错误且不会 panic 的任务。

---

## 11. 官方资料

- [`context` package](https://pkg.go.dev/context)
- [`sync.WaitGroup` package documentation](https://pkg.go.dev/sync#WaitGroup)
- [The Go Memory Model](https://go.dev/ref/mem)
- [`runtime/debug.Stack`](https://pkg.go.dev/runtime/debug#Stack)

## 一句话总结

> 不要只问“怎么启动 goroutine”，要先定义它属于谁、何时取消、谁等待、错误去哪；结构化并发把这些生命周期规则变成可验证的代码契约。
