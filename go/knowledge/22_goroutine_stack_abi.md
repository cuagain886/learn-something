# 22 · goroutine 栈与 Go ABI：从 morestack 到 panic 展开 ⭐⭐⭐

> 基线为 Go 1.26.4、amd64。栈会自动增长是可观察能力；初始大小、寄存器分配和私有函数属于版本实现。

## 1. goroutine 为什么能很多

goroutine 不预留一个固定的大线程栈。runtime 为它分配较小的连续栈，并在需要时增长，因此大量浅栈 goroutine 的内存成本远低于为每个任务预留大栈。数量仍不是免费：栈、G 元数据、引用对象和等待资源都会占内存。

## 2. 栈边界与 morestack

编译器通常在函数入口插入栈检查，把当前 SP 与 G 的 stackguard 比较。空间不足时进入 `morestack`/`newstack` 路径。标记为 nosplit 的函数不能走普通扩栈路径，因此只能用于严格受控的短调用链。

## 3. 连续栈增长与复制

现代 Go 使用连续栈。扩容时分配更大的区域、复制活动栈帧，并根据栈图调整指向旧栈的指针。GC 与编译器生成的指针位图使 runtime 知道哪些字是指针。裸 `uintptr` 不受 GC 跟踪，不能跨可能扩栈或移动对象的安全点长期保存。

## 4. 栈收缩

深调用返回后，runtime 可以在 GC 等时机收缩利用率很低的栈。是否、何时收缩是实现策略，业务不应通过地址变化推断正确性。

## 5. 调用帧与寄存器 ABI

Go 1.17 起主要平台使用寄存器 ABI。参数与返回值优先通过寄存器，仍保留栈槽、spill 和栈图来支持抢占、GC、调试和反射。调用约定是编译器/runtime 的内部契约，不是跨 Go 版本的二进制 ABI 承诺。

`go tool objdump` 应观察编译产物，而不是背某一次寄存器编号。内联会让函数符号或 CALL 消失，因此教学锚点使用 `//go:noinline`。

## 6. 闭包捕获与逃逸

闭包引用外层局部变量时，变量生命周期可能超过创建函数。编译器会把捕获状态放到合适位置，常见结果是逃逸到堆。是否逃逸要看实际编译器输出，不能用“闭包一定在堆”代替分析。

## 7. defer 的实现

简单 defer 常被编译器转换成开放编码，正常路径不必维护传统链表；复杂循环、recover 等情况可能走不同路径。defer 参数在注册时求值，多个 defer 逆序执行。

## 8. panic、recover 与栈展开

panic 沿当前 goroutine 调用栈展开并执行 defer。recover 只有在同一 goroutine 的 deferred function 中直接调用才有意义；父 goroutine 无法捕获子 goroutine panic。runtime fatal error 通常不可 recover。

## 9. 实验与工具

`CaptureStackAtDepth` 只捕获栈文本，不持有跨扩栈的地址。深度上限避免教材默认触发栈耗尽。

```powershell
go run ./30_goroutine_stack_abi -depth=4096
go build -gcflags='-m=2' ./30_goroutine_stack_abi
go build -o $env:TEMP\stack_abi.exe ./30_goroutine_stack_abi
go tool objdump -s 'main\.CallAddSix' $env:TEMP\stack_abi.exe
Remove-Item -LiteralPath $env:TEMP\stack_abi.exe
```

## 10. 工程边界

- 不用递归处理攻击者可控的无限深度输入。
- 不依赖局部变量地址稳定；需要身份时使用显式 ID。
- defer 优先保证资源安全，只有 Benchmark 证明是热点才考虑改写。
- panic 适合不可恢复的程序员错误或包边界转换，不替代普通 error。

## 11. 高频面试题与参考答案

### Q1. goroutine 栈与线程栈的主要区别？
goroutine 栈由 runtime 管理并可扩缩；线程栈由 OS/线程模型管理，通常预留更大空间。

### Q2. 栈增长为什么要编译器配合？
编译器插入栈检查并生成栈图，runtime 才能安全复制栈和调整指针。

### Q3. 栈增长会让 Go 指针失效吗？
正常 Go 指针会被 runtime 调整；把地址转成长期保存的 uintptr 会脱离跟踪并可能失效。

### Q4. nosplit 是性能优化开关吗？
不是通用优化；它用于 runtime 等无法安全扩栈的短路径，并受严格调用链预算约束。

### Q5. Go 为什么需要栈图？
用于精确 GC、栈复制、抢占和调试，区分指针与普通机器字。

### Q6. 寄存器 ABI 是否意味着没有栈帧？
不是。仍需栈槽、保存寄存器、局部变量、spill、调试和 GC 元数据。

### Q7. 如何观察 ABI？
编译带稳定符号的 noinline 函数，再用 objdump/compile -S；结论标注版本和架构。

### Q8. 闭包一定逃逸吗？
不一定。是否逃逸由捕获方式、生命周期、内联和编译器分析决定，以 `-m=2` 为证据。

### Q9. defer 现在是否“很慢”？
不能笼统说。开放编码显著降低常见路径成本，仍应在具体热点上 Benchmark。

### Q10. recover 为什么抓不到其他 goroutine panic？
panic 展开只沿发生 panic 的 goroutine 栈；goroutine 之间没有共享调用栈。

### Q11. 栈会在函数返回后立刻缩小吗？
不保证。收缩时机属于 runtime 策略，可能结合 GC 与利用率判断。

### Q12. 深递归有什么生产风险？
持续扩栈增加复制和内存成本，极端深度可触发栈上限；外部输入必须限制深度或改迭代。

## 12. 源码地图

- `runtime/stack.go`：newstack、栈复制与收缩。
- `runtime/asm_*.s`：morestack 等架构入口。
- `runtime/panic.go`：panic/defer/recover 主路径。
- `internal/abi`、`cmd/compile/internal/abi`：类型与调用 ABI。

## 一句话总结

goroutine 的可伸缩性来自编译器与 runtime 共同维护的连续栈、栈图和安全点；ABI、闭包与 panic 的成本必须用当前编译结果解释，而不是背固定布局。
