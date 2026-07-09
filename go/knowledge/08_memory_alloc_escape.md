# 08 · 内存分配与逃逸分析 ⭐⭐

> "什么情况变量会逃逸到堆？怎么排查？"是性能向面试的高频题。理解逃逸分析 = 理解 Go 在哪分配内存 = 知道怎么优化 GC 压力。

---

## 1. 栈 vs 堆：分配在哪很重要 ⭐

| | 栈（stack） | 堆（heap） |
|---|------------|-----------|
| 管理 | 函数调用自动分配/释放（return 即销毁） | 由 **GC** 管理回收 |
| 速度 | 极快（移动栈指针） | 慢（要找空闲块 + 增加 GC 负担） |
| 谁的栈 | 每个 goroutine 有自己的栈（初始 2KB，可增长） | 全局共享 |

**核心结论**：能分配在栈上的就别上堆。栈分配快且函数返回自动回收，**完全不给 GC 添麻烦**。逃逸分析就是编译器决定"这个变量该放栈还是堆"的过程。

---

## 2. 逃逸分析：编译器的决策 ⭐

**逃逸分析在编译期进行**，判断一个变量的生命周期是否"逃出"了当前函数的栈帧。如果一个变量在函数返回后还可能被引用，它就必须分配到堆上（否则栈帧销毁后就是悬空指针）。

> ⚠️ 反直觉但重要：**Go 可以安全地返回局部变量的地址**！因为逃逸分析发现它逃逸了，会自动把它分配到堆上。这和 C 不同（C 返回局部变量地址是 bug）。

**查看逃逸分析**：
```bash
go build -gcflags="-m" main.go     # -m 打印逃逸决策
go build -gcflags="-m -l" main.go  # -l 禁用内联，结果更清晰
```

输出示例：
```
./main.go:5:9: &User{...} escapes to heap        ← 逃逸了
./main.go:8:13: moved to heap: x                 ← x 被移到堆
./main.go:12:6: can inline add                   ← 可以内联（好事）
```

---

## 3. ⭐ 常见的逃逸场景（必背）

### ① 返回局部变量的指针
```go
func newUser() *User {
    u := User{Name: "go"} // u 逃逸：返回了它的地址
    return &u             // 编译器自动把 u 分配到堆
}
```

### ② 变量被赋值给接口（装箱）
```go
func main() {
    x := 42
    fmt.Println(x) // ⚠️ x 逃逸！Println(...any) 把 x 装进接口 → 逃到堆
}
// 这就是为什么 fmt.Println 在热点循环里有 GC 压力
```

### ③ 闭包捕获的变量
```go
func counter() func() int {
    count := 0           // count 逃逸：被返回的闭包引用，生命周期超出函数
    return func() int { count++; return count }
}
```

### ④ 变量太大，栈放不下
```go
func big() {
    arr := [10_000_000]int{} // 太大，逃逸到堆（栈容量有限）
    _ = arr
}
```

### ⑤ 编译期大小不确定的切片
```go
func make1(n int) []int {
    return make([]int, n) // n 运行期才知道 → 逃逸
}
func make2() []int {
    return make([]int, 10) // 大小确定且不大，可能栈分配（取决于是否返回）
}
```

### ⑥ 切片/map 中存储指针，且切片本身逃逸
```go
s := []*int{}
x := 1
s = append(s, &x) // x 逃逸：被切片元素引用
```

**记忆口诀**：**"指针逃逸、接口逃逸、闭包逃逸、过大逃逸、不定逃逸"**。本质都是**生命周期超出当前栈帧** 或 **大小/引用关系编译期无法确定**。

---

## 4. 逃逸优化实战 ⭐

### 优化前后对比（用 benchmark 验证）

```go
// ✗ 每次调用都逃逸 + 装箱
func logBad(id int) string {
    return fmt.Sprintf("id=%d", id) // Sprintf 的 id 装箱逃逸
}

// ✓ 避免装箱（特定场景用 strconv）
func logGood(id int) string {
    return "id=" + strconv.Itoa(id) // strconv.Itoa 不装箱
}
```

```bash
go test -bench=. -benchmem
# logBad-8    20000000   85 ns/op   16 B/op   2 allocs/op  ← 2 次堆分配
# logGood-8   50000000   25 ns/op    8 B/op   1 allocs/op  ← 更少
#                                    ↑每op字节  ↑每op分配次数（关键指标！）
```

> ⭐ **`-benchmem` 的 `allocs/op` 是性能优化的核心指标**——堆分配次数直接关系 GC 频率。优化的目标常常是把 allocs/op 降到 0 或最小。

### 常用优化手段

1. **预分配切片/map 容量**：`make([]T, 0, n)`，一次分配避免多次扩容。
2. **sync.Pool 复用对象**：高频创建销毁的大对象（见 [09](09_sync_primitives.md)）。
3. **避免不必要的接口装箱**：热点路径用具体类型或泛型替代 `any`。
4. **小结构体传值而非传指针**：小对象传值可能栈分配，传指针反而逼它逃逸（不绝对，要测）。
5. **复用 buffer**：`bytes.Buffer` / `strings.Builder` 而非反复字符串拼接。

---

## 5. 内存分配器：mcache / mcentral / mheap ⭐

Go 的内存分配器借鉴 **TCMalloc**（Thread-Caching Malloc），核心是**多级缓存 + 按大小分级**，目标是**减少锁竞争**。

```
对象按大小分三类：
  Tiny   (<16B，无指针)  → tiny 分配器，多个小对象合并到一块
  Small  (16B~32KB)     → 按 size class 分配（约 67 个等级）
  Large  (>32KB)        → 直接从 mheap 分配

三级缓存（和 GMP 的 P 对应）：
┌─────────────────────────────────────────────────────┐
│ mcache  ── 每个 P 一个，线程本地，【无锁】！           │ ← 最快
│            按 size class 缓存 span                    │
└────────────────────┬────────────────────────────────┘
                     │ mcache 不够，向 mcentral 要
┌────────────────────▼────────────────────────────────┐
│ mcentral ── 全局，每个 size class 一个，加锁          │
└────────────────────┬────────────────────────────────┘
                     │ mcentral 不够，向 mheap 要
┌────────────────────▼────────────────────────────────┐
│ mheap   ── 全局堆，管理所有 span，向 OS 申请内存       │ ← 最慢
└──────────────────────────────────────────────────────┘
```

- **size class**：把对象大小归到约 67 个固定档位（如 8, 16, 32, 48...），避免外部碎片。申请 17 字节实际给 32 字节的 span（有内部碎片但管理简单）。
- **span（mspan）**：一组连续的内存页（8KB/页），是分配的基本单位，每个 span 服务一个 size class。
- **mcache 无锁**是关键：和 GMP 的 P 绑定，每个 P 有自己的 mcache，小对象分配大多数时候**无需加锁**，极快。

---

## 6. 内存对齐 ⭐（结构体字段顺序的坑）

CPU 按对齐边界读内存更高效，所以结构体字段会**按对齐要求填充（padding）**。**字段顺序影响结构体大小！**

```go
// ✗ 字段顺序不当，有填充浪费
type Bad struct {
    a bool   // 1 字节
    b int64  // 8 字节 → a 后面要填 7 字节对齐
    c bool   // 1 字节 → 后面填 7 字节
}              // 总共 24 字节

// ✓ 按大小排列，减少填充
type Good struct {
    b int64  // 8
    a bool   // 1
    c bool   // 1  → 后面填 6
}              // 总共 16 字节，省了 8 字节
```

**规则**：把**大字段放前面、小字段放后面**（或相同大小的放一起），减少 padding。在有海量实例的结构体上，这能省下可观内存。

```go
import "unsafe"
fmt.Println(unsafe.Sizeof(Bad{}))  // 24
fmt.Println(unsafe.Sizeof(Good{})) // 16
// 工具：用 `fieldalignment` linter 自动检测字段顺序问题
//   go install golang.org/x/tools/go/analysis/passes/fieldalignment/cmd/fieldalignment@latest
```

> ⚠️ 还有个细节：空结构体 `struct{}` 大小为 **0 字节**，所以 `map[string]struct{}` 当 Set 用最省内存。

---

## 7. 栈的增长

每个 goroutine 栈初始 **2KB**，是**可增长的连续栈**：
- 函数调用前检查栈空间是否够，不够就**分配 2 倍的新栈，把旧栈数据拷贝过去**（栈拷贝，需要调整指针）。
- 栈用得少了也会**收缩**（GC 时）。
- 所以 goroutine 才能做到初始极小、按需伸缩——百万 goroutine 内存可控。

---

## 8. 面试速答清单

| 问题 | 一句话答案 |
|------|-----------|
| 栈和堆区别？ | 栈快、随函数返回自动回收；堆慢、靠 GC，逃逸的变量上堆 |
| 逃逸分析是什么？ | 编译期判断变量生命周期是否超出栈帧，超出则分配到堆 |
| 常见逃逸场景？ | 返回指针、装箱进接口、闭包捕获、对象过大、大小不定 |
| 怎么查逃逸？ | `go build -gcflags="-m -l"`，看 escapes to heap |
| 怎么衡量优化？ | `go test -benchmem` 看 allocs/op（堆分配次数） |
| 内存分配器结构？ | mcache(P本地无锁)→mcentral(全局按class)→mheap(向OS要)，仿 TCMalloc |
| size class？ | 约 67 个固定档位，减少碎片，mcache 按 class 缓存 span |
| 内存对齐优化？ | 大字段在前减少 padding；空结构体 0 字节 |

---

## 一句话总结

> **逃逸分析在编译期决定变量上栈还是堆（生命周期超出栈帧/大小不定就逃逸）；分配走 mcache(无锁)→mcentral→mheap 三级、按 size class 分档；用 `-gcflags=-m` 查逃逸、`-benchmem` 看 allocs/op，配合预分配/sync.Pool/字段对齐降 GC 压力。**

➡️ 上一篇：[07 · GC](07_gc.md) ｜ 下一篇：[09 · sync 原语深入](09_sync_primitives.md)
