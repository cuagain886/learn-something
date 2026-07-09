# 12 · 高频面试陷阱题集锦 ⚠️⭐⭐⭐

> 大厂"手撕输出题"合集。**先盖住答案自己推一遍**，再看解析。标注了涉及的章节，答错的回去复习。
>
> ⚠️ **重要版本说明**：本文基于 **Go 1.22+**。其中**循环变量**的行为在 1.22 发生了重大改变（每轮迭代重新声明），很多网上的"经典答案"还是旧版本的，注意甄别。

---

## 一、切片类（→ [01](01_slice_internals.md)）

### Q1. append 共享底层数组
```go
s1 := []int{1, 2, 3}
s2 := s1[:2]
s2 = append(s2, 100)
fmt.Println(s1, s2)
```
<details><summary>答案</summary>

**`[1 2 100] [1 2 100]`**。`s2` 的 cap 是 3（共享 s1 底层数组），append 100 时容量够，**不扩容**，直接写入底层数组第 3 个位置，覆盖了 s1 的 3。
</details>

### Q2. 扩容后脱钩
```go
s1 := []int{1, 2, 3}
s2 := append(s1, 4)   // s1 len=cap=3，append 触发扩容
s2[0] = 100
fmt.Println(s1, s2)
```
<details><summary>答案</summary>

**`[1 2 3] [100 2 3 4]`**。append 时 s1 已满，扩容到新数组，s2 指向新数组，改 s2 不影响 s1。
</details>

### Q3. 循环里 append 同一个切片
```go
s := []int{1, 2, 3}
for _, v := range s {
    s = append(s, v)
}
fmt.Println(len(s))
```
<details><summary>答案</summary>

**`6`**。`range` 在循环开始时就对 s 求值，确定遍历**原始的 3 个元素**，不会因为 append 而无限循环。结果 `[1 2 3 1 2 3]`。
</details>

---

## 二、循环变量 & 闭包类（→ [05](05_defer_panic_recover.md)）⚠️ 版本敏感

### Q4. 闭包捕获循环变量（经典中的经典）
```go
funcs := []func(){}
for i := 0; i < 3; i++ {
    funcs = append(funcs, func() { fmt.Print(i, " ") })
}
for _, f := range funcs { f() }
```
<details><summary>答案 ⚠️ 版本相关</summary>

- **Go 1.22+：`0 1 2`**（每轮迭代 `i` 是新变量，闭包各自捕获不同的 i）。
- **Go 1.21 及之前：`3 3 3`**（所有闭包共享同一个 i，循环结束时 i=3）。

这是 Go 1.22 最重要的破坏性改进之一。面试时**一定要先问/说明 Go 版本**，否则两个答案都可能"错"。旧版本的修复方法是循环内 `i := i` 重新声明。
</details>

### Q5. goroutine 捕获循环变量
```go
var wg sync.WaitGroup
for i := 0; i < 3; i++ {
    wg.Add(1)
    go func() { defer wg.Done(); fmt.Print(i, " ") }()
}
wg.Wait()
```
<details><summary>答案 ⚠️ 版本相关</summary>

- **Go 1.22+**：打印 `0 1 2` 的某种乱序（goroutine 调度无序，但值是 0/1/2 各一次）。
- **Go 1.21-**：很可能是 `3 3 3`（共享变量，且 goroutine 启动时 i 多半已是 3）。
</details>

### Q6. defer + 循环变量
```go
func main() {
    for i := 0; i < 3; i++ {
        defer fmt.Print(i, " ")
    }
}
```
<details><summary>答案</summary>

**`2 1 0`**。defer 参数**注册时即求值**（i 分别是 0,1,2），按 LIFO 逆序执行。这题不受 1.22 循环变量改动影响——因为 defer 当场就把 i 的值拷走了。
</details>

---

## 三、defer 类（→ [05](05_defer_panic_recover.md)）

### Q7. defer 改返回值
```go
func f() (result int) {
    defer func() { result++ }()
    return 10
}
// f() = ?
```
<details><summary>答案</summary>

**`11`**。命名返回值：`return 10` 先令 `result=10`，再执行 defer 把它 +1，返回 11。
</details>

### Q8. 匿名 vs 命名返回值
```go
func a() int {
    i := 0
    defer func() { i++ }()
    return i
}
func b() (i int) {
    defer func() { i++ }()
    return 0
}
// a()=? b()=?
```
<details><summary>答案</summary>

**`a()=0, b()=1`**。`a` 是匿名返回值，return 时把 i 的值(0)拷给隐藏返回变量，defer 改的是局部 i，不影响返回值 → 0。`b` 是命名返回值，defer 直接改返回变量 → 1。
</details>

### Q9. defer 参数求值时机
```go
func main() {
    i := 0
    defer fmt.Println("defer:", i)  // 注册时 i=0
    i = 10
    fmt.Println("normal:", i)
}
```
<details><summary>答案</summary>

```
normal: 10
defer: 0
```
defer 的参数 `i` 在**注册时就求值为 0**，后面改 i 不影响。
</details>

### Q10. defer 中的 recover
```go
func main() {
    defer fmt.Println("1")
    defer func() {
        if r := recover(); r != nil { fmt.Println("recovered:", r) }
    }()
    defer fmt.Println("2")
    panic("boom")
    defer fmt.Println("3") // 注意这行
}
```
<details><summary>答案</summary>

```
2
recovered: boom
1
```
panic 前的 defer（1、2）已注册；`panic("boom")` 触发后逆序执行 defer：先 "2"，再 recover 捕获，再 "1"。`defer fmt.Println("3")` 在 panic **之后**，根本没注册，不执行。
</details>

---

## 四、map 类（→ [02](02_map_internals.md)）

### Q11. map 取不存在的 key
```go
m := map[string]int{"a": 1}
v := m["b"]
fmt.Println(v)
```
<details><summary>答案</summary>

**`0`**。取不存在的 key 返回 value 类型的零值，不报错。要区分"不存在"和"值为0"用 `v, ok := m["b"]`。
</details>

### Q12. map 的 value 是结构体，能改字段吗？
```go
type P struct{ X int }
m := map[string]P{"a": {X: 1}}
m["a"].X = 10  // 这行？
```
<details><summary>答案</summary>

**编译错误**：`cannot assign to struct field m["a"].X in map`。map 的 value 不可寻址（可能因扩容搬迁），不能直接改字段。解法：取出→改→放回，或用 `map[string]*P`。
</details>

### Q13. 并发写 map
```go
m := map[int]int{}
var wg sync.WaitGroup
for i := 0; i < 100; i++ {
    wg.Add(1)
    go func(n int) { defer wg.Done(); m[n] = n }(i)
}
wg.Wait()
```
<details><summary>答案</summary>

**大概率 `fatal error: concurrent map writes`**，程序崩溃（recover 都救不了）。修复：加 `sync.Mutex` 或用 `sync.Map`。
</details>

---

## 五、interface 类（→ [04](04_interface_internals.md)）

### Q14. nil 接口陷阱（必考）
```go
type MyErr struct{}
func (*MyErr) Error() string { return "err" }

func do() error {
    var p *MyErr = nil
    return p
}
func main() {
    err := do()
    fmt.Println(err == nil)
}
```
<details><summary>答案</summary>

**`false`**。`err` 内部是 `(类型=*MyErr, 值=nil)`，类型部分非空，所以接口 != nil。这是最经典的陷阱，详见 [04](04_interface_internals.md)。
</details>

### Q15. 接口比较
```go
var a any = 1
var b any = 1
fmt.Println(a == b)

var c any = []int{1}
var d any = []int{1}
fmt.Println(c == d)  // 这行？
```
<details><summary>答案</summary>

第一个 **`true`**（类型和值都相等）。第二个 **运行时 panic**：`comparing uncomparable type []int`。接口比较时若动态类型不可比较（slice/map/func），会 panic。
</details>

---

## 六、channel 类（→ [03](03_channel_internals.md)）

### Q16. 读已关闭的 channel
```go
ch := make(chan int, 2)
ch <- 1
close(ch)
fmt.Println(<-ch)
fmt.Println(<-ch)
v, ok := <-ch
fmt.Println(v, ok)
```
<details><summary>答案</summary>

```
1
0       (缓冲只有一个 1，第二次读返回零值)
0 false (已关闭且空，返回零值+ok=false)
```
</details>

### Q17. 向已关闭 channel 发送
```go
ch := make(chan int, 1)
close(ch)
ch <- 1
```
<details><summary>答案</summary>

**panic：`send on closed channel`**。
</details>

### Q18. nil channel
```go
var ch chan int
go func() { ch <- 1 }()
fmt.Println(<-ch)
```
<details><summary>答案</summary>

**`fatal error: all goroutines are asleep - deadlock!`**。nil channel 收发都永久阻塞，两个 goroutine 都卡死。
</details>

### Q19. range 未关闭的 channel
```go
ch := make(chan int, 3)
ch <- 1; ch <- 2; ch <- 3
for v := range ch {
    fmt.Println(v)
}
```
<details><summary>答案</summary>

打印 `1 2 3` 后 **deadlock**。`range` 会一直等下一个值，channel 没 close，取完 3 个后阻塞，无人再发 → 死锁。必须 `close(ch)` 才能让 range 正常结束。
</details>

---

## 七、并发综合（→ [09](09_sync_primitives.md) [10](10_concurrency_patterns.md)）

### Q20. WaitGroup Add 位置错误
```go
var wg sync.WaitGroup
for i := 0; i < 3; i++ {
    go func() {
        wg.Add(1)        // ⚠️ Add 在 goroutine 内部
        defer wg.Done()
        fmt.Println("work")
    }()
}
wg.Wait()
```
<details><summary>答案</summary>

**结果不确定**，可能一个都没打印就结束。`wg.Wait()` 可能在所有 goroutine 的 `Add` 之前就执行（此时计数为 0，Wait 立即返回）。**Add 必须在 go 之前调用**。
</details>

### Q21. 拷贝 Mutex
```go
type Counter struct {
    mu sync.Mutex
    n  int
}
func (c Counter) Inc() {  // ⚠️ 值接收者
    c.mu.Lock()
    defer c.mu.Unlock()
    c.n++
}
```
<details><summary>答案</summary>

**两个 bug**：① 值接收者导致每次调用都**拷贝 Counter（含 Mutex）**——锁形同虚设，且 `go vet` 会警告"拷贝了 Mutex"。② 改的是副本的 n，外部看不到。应改为**指针接收者** `func (c *Counter)`。
</details>

### Q22. select 随机性
```go
ch := make(chan int, 1)
ch <- 1
select {
case v := <-ch: fmt.Println("a", v)
case v := <-ch: fmt.Println("b", v)
}
```
<details><summary>答案</summary>

打印 **`a 1` 或 `b 1`**（随机）。两个 case 都就绪时 select 伪随机选一个。
</details>

---

## 八、综合杂项

### Q23. 整数除法与取整
```go
fmt.Println(7 / 2)
fmt.Println(7.0 / 2)
fmt.Println(-7 / 2)
fmt.Println(-7 % 2)
```
<details><summary>答案</summary>

```
3      (整数除法截断)
3.5    (有浮点参与)
-3     (向零截断，不是 -4)
-1     (取余符号跟随被除数)
```
</details>

### Q24. const iota
```go
const (
    a = iota       // 0
    b              // 1
    c = iota * 10  // 20
    d              // 30
    _              // (跳过 40)
    f              // 50
)
fmt.Println(a, b, c, d, f)
```
<details><summary>答案</summary>

**`0 1 20 30 50`**。iota 在 const 块里逐行递增（每行+1，无论是否使用），`_` 占第 4 行(iota=4)被跳过，f 是第 5 行 iota=5 → 50。
</details>

### Q25. 字符串遍历（byte vs rune）
```go
s := "héllo"  // é 是 2 字节
fmt.Println(len(s))
count := 0
for range s { count++ }
fmt.Println(count)
```
<details><summary>答案</summary>

**`6` 和 `5`**。`len` 数**字节**（é 占 2 字节，共 6）；`for range` 按 **rune** 遍历（5 个字符）。详见 [08_strings 教程](../08_strings_runes/main.go)。
</details>

### Q26. defer 与 os.Exit
```go
func main() {
    defer fmt.Println("defer")
    os.Exit(0)
}
```
<details><summary>答案</summary>

**什么都不打印**。`os.Exit` 立即终止进程，**不执行任何 defer**。这是 os.Exit 和正常返回的关键区别。
</details>

### Q27. 切片作为 map 的 value
```go
m := map[string][]int{}
m["a"] = append(m["a"], 1)  // 这样行吗？
m["a"] = append(m["a"], 2)
fmt.Println(m["a"])
```
<details><summary>答案</summary>

**`[1 2]`**，完全正确。`m["a"]` 不存在时返回 nil 切片，`append(nil, 1)` 合法（返回新切片），再赋回 map。这是分组（group by）的惯用法。
</details>

### Q28. 结构体比较
```go
type P struct{ X, Y int }
a := P{1, 2}
b := P{1, 2}
fmt.Println(a == b)

type Q struct{ S []int }
c := Q{[]int{1}}
d := Q{[]int{1}}
fmt.Println(c == d)  // 这行？
```
<details><summary>答案</summary>

第一个 **`true`**（字段全可比较的结构体可用 ==）。第二个 **编译错误**：含 slice 字段的结构体不可比较。
</details>

### Q29. 方法值绑定时机
```go
type T struct{ x int }
func (t T) Get() int { return t.x }

t := T{x: 1}
f := t.Get   // 方法值，此刻绑定了 t 的副本
t.x = 100
fmt.Println(f())
```
<details><summary>答案</summary>

**`1`**。`t.Get`（值接收者）在赋值给 f 时就**拷贝了 t**（x=1），后面改 t.x 不影响。若是指针接收者则会打印 100。
</details>

### Q30. 多重赋值求值顺序
```go
i := 1
arr := []int{1, 2, 3}
i, arr[i] = 2, 100
fmt.Println(i, arr)
```
<details><summary>答案</summary>

**`2 [1 100 3]`**。多重赋值**右侧先全部求值**，左侧的索引 `arr[i]` 用的是**赋值前**的 i=1，所以改的是 arr[1]。Go 规范：赋值时左侧的索引表达式和指针解引用先于赋值计算。
</details>

### Q31. new vs make
```go
a := new([]int)   // *[]int，指向 nil 切片
b := make([]int, 0)
fmt.Println(*a == nil, b == nil)
```
<details><summary>答案</summary>

**`true false`**。`new([]int)` 返回 `*[]int`，指向的切片是零值 nil；`make([]int,0)` 返回已初始化的空切片（非 nil）。`new` 分配零值返回指针，`make` 只用于 slice/map/chan 的初始化并返回类型本身。
</details>

### Q32. goroutine 没机会执行
```go
func main() {
    go fmt.Println("goroutine")
    fmt.Println("main")
}
```
<details><summary>答案</summary>

**只打印 `main`**（大概率）。main 返回时程序立即退出，不等其他 goroutine。goroutine 可能还没被调度就被终止了。要等它需用 WaitGroup 或 channel 同步。
</details>

---

## 复习路线

答错的题对照章节回炉：

- Q1-3 → [01 切片](01_slice_internals.md)
- Q4-6 → 循环变量 + [05 defer](05_defer_panic_recover.md)
- Q7-10 → [05 defer/panic/recover](05_defer_panic_recover.md)
- Q11-13 → [02 map](02_map_internals.md)
- Q14-15 → [04 interface](04_interface_internals.md)
- Q16-19 → [03 channel](03_channel_internals.md)
- Q20-22 → [09 sync](09_sync_primitives.md) / [10 并发](10_concurrency_patterns.md)
- Q23-32 → 基础语法（仓库 01-11 教程）+ 综合

---

## 一句话总结

> **手撕题核心就几条主线：切片扩容是否脱钩、defer 的 LIFO+注册时求值+改命名返回值、接口 nil 陷阱、channel 关闭/nil 行为、循环变量 1.22 新语义、os.Exit 跳过 defer。把这些机制吃透，绝大多数变体都能推出来。**

➡️ 返回：[文档索引](README.md)
