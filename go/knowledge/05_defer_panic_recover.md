# 05 · defer / panic / recover ⭐⭐⭐

> defer 是面试手撕题的重灾区——尤其和**命名返回值**、**闭包**、**循环**结合时，输出结果常常反直觉。把执行时机和求值时机分清楚就稳了。

---

## 1. defer 的三条铁律

```go
func demo() {
    defer fmt.Println("A")        // ③ 最后执行
    defer fmt.Println("B")        // ②
    x := 10
    defer fmt.Println("x =", x)   // ① 参数立即求值为 10！下面改 x 无效
    x = 20
    fmt.Println("函数体")
}
// 输出：函数体 / x = 10 / B / A
```

1. **延迟执行**：defer 的函数在**所在函数 return 之后、真正返回调用者之前**执行。
2. **后进先出（LIFO）**：多个 defer 像压栈，逆序执行。
3. ⚠️ **参数立即求值**：注册 defer 那一刻，函数的**参数就已经算好并拷贝**了，不是等执行时才算。

> 第 3 条是最大的坑。`defer fmt.Println("x =", x)` 在注册时就把 `x=10` 算进去了。如果想延迟取值，用闭包：`defer func(){ fmt.Println(x) }()`（闭包捕获的是变量本身）。

---

## 2. ⭐⭐ defer 与命名返回值的交互（最高频手撕题）

defer 能修改**命名返回值**，因为 `return` 不是原子的，它分两步：

```
return x   实际等价于：
  1. 把返回值赋给"返回变量"（命名的或匿名的）
  2. 执行所有 defer
  3. 真正返回
```

**对比下面三个函数，能讲清就过关：**

```go
// ① 匿名返回值：defer 改的是局部 result，不影响已确定的返回值
func f1() int {
    result := 0
    defer func() { result++ }() // 改的是 result，但返回值早已拷贝为 0
    return result               // 返回 0
}

// ② 命名返回值：defer 直接改返回变量 result 本身
func f2() (result int) {
    defer func() { result++ }() // result 就是返回变量，+1 生效
    return 0                    // 先令 result=0，defer 改成 1，返回 1
}

// ③ 命名返回值 + 返回前赋值
func f3() (result int) {
    result = 5
    defer func() { result *= 2 }() // 5 * 2
    return result                  // 返回 10
}
```

**结果**：`f1()=0`，`f2()=1`，`f3()=10`。

**标准答法**：
> `return x` 不是一步完成的，它先把 x 赋给返回变量，再执行 defer，最后才真正返回。匿名返回值在赋值后 defer 改不到它；命名返回值因为 defer 能直接访问那个变量，所以能修改最终返回结果。

**实战用途**：这正是 `recover` 能"挽救"返回值的原理——
```go
func safeDiv(a, b int) (result int, err error) {
    defer func() {
        if r := recover(); r != nil {
            err = fmt.Errorf("恢复自 panic: %v", r) // 修改命名返回值 err
        }
    }()
    return a / b, nil // b=0 时 panic，被 defer 捕获，err 被设置
}
```

---

## 3. defer 的底层实现（性能演进）⭐

Go 的 defer 经历了三代优化，面试问到"defer 性能"要知道：

| 版本 | 实现 | 性能 |
|------|------|------|
| ≤1.12 | **堆上分配** defer 结构，链表串联 | 慢（每个 defer 都堆分配） |
| 1.13 | **栈上分配** defer 结构 | 快约 30% |
| 1.14+ | **开放编码（open-coded defer）** | 接近零开销，几乎和直接调用一样快 |
1. 第一代：堆上分配
	用链表模拟栈，插入时在头部插入，实现后进先出
	![[Pasted image 20260724114412.png]]
2. 第二代：栈上分配
	![[Pasted image 20260724114808.png]]
3. 第三代：开放编码，通过函数内联在编译期实现
	在有判断条件的代码中，编译器会使用延迟位图来操作，工作机制为：
	- **分配一个字节的位图**：编译器会在函数的栈帧里悄悄放一个 8 位的整数 `deferBits`（如 `uint8`，这也意味着开放编码最多支持同一个函数内 **8 个** `defer`）。
    
	- **注册时置位**：代码每运行到一个 `defer` 语句，就将位图对应的 Bit 位置为 `1`。
    
	- **退出时按位检查**：在函数 exit 处，按倒序检查位图。如果某位是 `1`，就执行对应的 `defer` 函数并把该位置为 `0`。
```go
func test(cond bool) {
    var deferBits uint8 = 0 // 1. 初始化延迟位图（8位比特）

    // ----- 第一条 defer -----
    // 延迟函数的参数先保存在栈上
    deferBits |= 1 << 0     // 将第 0 位置 1 (deferBits = 00000001)

    if cond {
        // ----- 第二条 defer -----
        deferBits |= 1 << 1 // 将第 1 位置 1 (deferBits = 00000011)
    }

    println("end")

    // ----- 函数退出处的倒序清理逻辑 -----
    if deferBits & (1 << 1) != 0 { // 检查第 1 位
        deferBits &^= (1 << 1)     // 清零
        println("defer 2")
    }
    if deferBits & (1 << 0) != 0 { // 检查第 0 位
        deferBits &^= (1 << 0)     // 清零
        println("defer 1")
    }
    return
}
```
- **编译期**：做“打标记”的准备工作。把每条 `defer` 按照在源码里出现的顺序编号（0, 1, 2...），并在 `defer` 代码旁边贴上 `deferBits |= 1 << N` 指令，在函数末尾贴上倒序检查 Bit 位并执行的伪代码。
    
- **运行期**：做“真实的条件判断”。代码跑过了哪个 `defer`，哪个 Bit 位就被置 1；退出时根据 `deferBits` 的最终结果，像“开开关”一样决定哪些内联代码该响应执行。

既然第三代取消了 `g._defer` 链表，如果代码中间突然 `panic` 了，或者被 `recover()` 捕获了，Go 运行时怎么知道当前函数有哪些 `defer` 需要被执行？

答案是：**借助编译期生成的元信息（FuncInfo）与栈扫描**。

- 编译器在编译每个函数时，会额外生成一份只读的**元数据表**（写在二进制文件的符号表中），记录了这个函数里每个 `defer` 函数的地址、参数位置以及 `deferBits` 在栈中的偏移量。
    
- 当发生 `panic` 时，运行时会暂停当前 goroutine，沿着调用栈向上扫描栈帧（Stack Unwinding）。
    
- 运行时一旦发现某个栈帧使用的是开放编码（Open-Coded），就会读取该栈帧里的 `deferBits` 值，并结合编译期留在符号表里的元信息，**现场把还没执行的 `defer` 依次补救执行掉**。

第三代虽然性能无敌（~1.4ns），但并不是所有场景都能使用。要触发开放编码，必须同时满足以下条件：

1. **不能在循环（`for`）内部**（因为循环内的 `defer` 数量不可预测，8 位的 `deferBits` 塞不下）。
    
2. **同一个函数内的 `defer` 数量不超过 8 个**（因为 Go 为了极致性能，默认使用的 `deferBits` 是 1 个字节 `uint8`；如果超过 8 个，位图放不下）。
    
3. **`defer` 表达式的返回值/参数占用空间不能过大**。
    

如果**不满足**上述条件（比如在 `for` 循环里写了 `defer`，或者写了 10 个 `defer`），Go 编译器就会**自动向下兼容退化**：

- 优先退化为**第二代（栈上分配）**。
    
- 如果连栈上分配都不满足（如动态循环），再退化为**第一代（堆上分配）**。


**开放编码**：编译器在**编译期**直接把 defer 的调用内联展开到函数返回前的位置（不走运行时 defer 链表），条件是 defer 数量 ≤ 8 且不在循环里。

```go
// 这种简单 defer 会被开放编码优化，几乎无开销：
func f() {
    mu.Lock()
    defer mu.Unlock() // 编译器直接在 return 前插入 mu.Unlock()
    // ...
}
```

> ⚠️ **defer 在循环里无法开放编码**，会退回到堆/栈分配的慢路径——这也引出下一个陷阱。

---

## 4. ⚠️ defer 在循环里的陷阱

```go
// ✗ 错误：1000 个文件句柄全部积压到函数结束才释放
func processFiles(names []string) {
    for _, name := range names {
        f, _ := os.Open(name)
        defer f.Close() // defer 是函数级的，不在每轮迭代结束时执行！
        // ... 处理 f
    }
} // 到这里才一次性关闭 1000 个文件 → 可能耗尽文件描述符

// ✓ 正确：把循环体提取成函数，让 defer 每轮结束就执行
func processFiles(names []string) {
    for _, name := range names {
        processOne(name) // defer 在 processOne 返回时就执行
    }
}
func processOne(name string) {
    f, _ := os.Open(name)
    defer f.Close()
    // ... 处理 f
}
```

**记住**：**defer 绑定的是函数作用域，不是块/循环作用域。**

---

## 5. panic 与 recover ⭐

### panic 的传播

panic 会：① 停止当前函数正常执行 → ② **逆序执行当前 goroutine 已注册的 defer** → ③ 一路向上冒泡到调用栈顶 → ④ 没被 recover 就**整个程序崩溃**并打印堆栈。

### recover 的边界（容易答错）

```go
func main() {
    defer func() {
        if r := recover(); r != nil { // ✓ 必须在 defer 函数里直接调用
            fmt.Println("捕获:", r)
        }
    }()
    panic("boom")
}
```

⚠️ **recover 只在以下条件生效**：
1. **必须在 defer 调用的函数里**直接调用 `recover()`。
2. 不能在 defer 函数再调一层普通函数里 recover（要 defer 直接调）。
3. 不在 defer 里调用 recover **永远返回 nil**（无效）。

```go
recover()           // ✗ 直接调用，返回 nil，无效
defer recover()     // ✗ 没在函数包裹里，无效
defer func() { recover() }() // ✓ 正确
```

### ⚠️ recover 跨不了 goroutine

```go
func main() {
    defer func() { recover() }() // 救不了子 goroutine 的 panic！
    go func() {
        panic("子 goroutine 爆炸") // 整个程序崩溃
    }()
    time.Sleep(time.Second)
}
```
**每个 goroutine 的 panic 只能被它自己的 defer+recover 捕获。** 启动 goroutine 时如果担心 panic，要在 goroutine **内部**加 recover。

---

## 6. 什么时候用 panic，什么时候用 error ⭐

| | error | panic |
|---|-------|-------|
| 用于 | **预期内**的失败：文件不存在、网络超时、输入非法 | **预期外**的程序 bug：数组越界、nil 解引用、不变量被破坏 |
| 处理 | 调用方显式检查 `if err != nil` | 通常让它崩溃，或在边界 recover |
| 频率 | 99% 的错误 | 极少数，初始化失败/不可恢复场景 |

**惯例**：
- 库代码**不要随便 panic**，返回 error 让调用方决定。
- `recover` 主要用在**框架/服务的边界**：比如 HTTP server 给每个请求 handler 包一层 recover，防止单个请求的 panic 拖垮整个服务（`net/http` 内部就是这么做的）。

```go
// Web 中间件常见的 recover 兜底
func recoverMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if err := recover(); err != nil {
                log.Printf("panic: %v\n%s", err, debug.Stack())
                http.Error(w, "Internal Server Error", 500)
            }
        }()
        next.ServeHTTP(w, r)
    })
}
```

---

## 7. 面试速答清单

| 问题 | 一句话答案 |
|------|-----------|
| defer 执行顺序？ | LIFO 后进先出，函数 return 后、返回前执行 |
| defer 参数何时求值？ | 注册时立即求值拷贝（要延迟取值用闭包） |
| defer 能改返回值吗？ | 能改命名返回值（return 先赋值再执行 defer）；匿名返回值改不了 |
| defer 性能？ | 1.14+ 开放编码几乎零开销；循环里会退化到慢路径 |
| recover 生效条件？ | 必须在 defer 直接调用的函数里，否则返回 nil |
| recover 跨 goroutine？ | 不行，只能捕获本 goroutine 的 panic |
| panic vs error？ | error 处理预期失败，panic 留给不可恢复的 bug；库别乱 panic |

---

## 一句话总结

> **defer 后进先出、参数注册时求值、能改命名返回值；1.14 起开放编码近零开销但循环里退化；recover 只在 defer 函数内、本 goroutine 有效；panic 留给真正的 bug，错误处理用 error。**

➡️ 上一篇：[04 · interface](04_interface_internals.md) ｜ 下一篇：[06 · GMP 调度模型](06_gmp_scheduler.md)
