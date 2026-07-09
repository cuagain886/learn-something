# 04 · interface 底层原理 ⭐⭐⭐

> interface 的考点：**eface vs iface 两种结构、类型断言/type switch 的代价、以及那道经典的"`err != nil` 却判断失败"的 nil 陷阱。**

---

## 1. 两种底层结构：eface 与 iface

Go 的接口在运行时有**两种**表示，取决于接口有没有方法：

### 空接口 `any`（`interface{}`）→ eface

```go
type eface struct {
    _type *_type         // 动态类型的元信息（是什么类型）
    data  unsafe.Pointer // 指向实际数据（值的拷贝，逃逸到堆）
}
```

### 非空接口（有方法）→ iface

```go
type iface struct {
    tab  *itab          // 类型 + 方法表（关键！）
    data unsafe.Pointer // 指向实际数据
}

type itab struct {
    inter *interfacetype // 接口类型信息
    _type *_type         // 动态类型信息
    hash  uint32         // 类型哈希（type switch 快速比较用）
    fun   [1]uintptr     // ★ 方法地址表：实现该接口的具体方法指针数组
}
```

**核心认知**：接口值 = **(类型信息, 数据指针)** 二元组。
- 非空接口的 `itab` 里有 `fun` 数组——存着具体类型实现接口方法的**函数指针**，调用接口方法就是查这张表跳转（类似 C++ 的虚表 vtable）。
- `itab` 是**缓存**的：同一对 (接口类型, 具体类型) 的 itab 全局只生成一次，存进 `itabTable`。

```
var w io.Writer = os.Stdout

w ─▶ iface ┌─ tab ─▶ itab ┌─ inter ─▶ io.Writer 接口信息
           │              ├─ _type ─▶ *os.File 类型信息
           │              └─ fun[0] ─▶ (*os.File).Write 的地址
           └─ data ─▶ os.Stdout 的数据
```

---

## 2. ⚠️⚠️ 最经典的 nil 陷阱（必考！）

```go
type MyErr struct{}
func (e *MyErr) Error() string { return "出错了" }

func doSomething() error {
    var p *MyErr = nil  // 一个 nil 的具体类型指针
    return p            // ⚠️ 把 (类型=*MyErr, 值=nil) 装进 error 接口
}

func main() {
    err := doSomething()
    if err != nil {
        fmt.Println("居然进来了！", err == nil) // 进来了，err == nil 是 false ⚠️
    }
}
```

**为什么 `err != nil`？**

接口值 == nil 的条件是：**类型和数据指针都为 nil**。这里 `err` 的内部是 `(_type=*MyErr, data=nil)`——**类型信息不为空**（是 `*MyErr`），所以整个接口值**不等于 nil**，哪怕它包的指针是 nil。

```
err 的真身：iface{ tab: *MyErr的itab(非nil), data: nil }
            └─ tab 非 nil → 整个接口 != nil
```

**怎么避免**：函数声明返回 `error` 时，要**直接返回 `nil` 字面量**，不要返回一个"值为 nil 的具体类型指针"。

```go
func doSomething() error {
    var p *MyErr = nil
    if p == nil {
        return nil  // ✓ 直接返回 nil，接口的类型和数据都为 nil
    }
    return p
}
```

**标准答法**：
> 接口值由"类型 + 数据"两部分组成，只有两者都为 nil 接口才等于 nil。返回一个类型确定但值为 nil 的指针，接口的类型部分非空，所以 `!= nil`。这就是为什么不要把具体类型的 nil 指针赋给 error 接口。

---

## 3. 类型断言与 type switch ⭐

### 类型断言的两种形式

```go
var i any = "hello"

s := i.(string)        // ① 断言失败直接 panic
s, ok := i.(string)    // ② 安全形式，失败时 ok=false 不 panic ★推荐
n, ok := i.(int)       // ok=false, n=0
```

**断言原理**：比较接口的 `_type` 和目标类型是否一致（指针比较，很快）。断言到**接口类型**时则要查/建 itab，稍慢。

### type switch

```go
func describe(i any) string {
    switch v := i.(type) {
    case nil:           return "nil"
    case int:           return fmt.Sprintf("int: %d", v)
    case string:        return fmt.Sprintf("string: %q", v)
    case io.Writer:     return "实现了 Writer"  // 也能断言到接口
    default:            return fmt.Sprintf("未知: %T", v)
    }
}
```

底层用 `itab.hash` 做快速分支匹配。⚠️ 注意 `case nil` 要单独处理（接口本身是 nil 的情况）。

---

## 4. 接口的隐式实现与设计哲学 ⭐

```go
// 不需要 implements 关键字！有方法就自动满足
type Stringer interface { String() string }

type Point struct{ X, Y int }
func (p Point) String() string { return fmt.Sprintf("(%d,%d)", p.X, p.Y) }
// Point 自动实现了 Stringer，无需声明
```

**编译期检查技巧**（确保某类型实现了某接口）：
```go
var _ Stringer = Point{}     // 值类型实现
var _ Stringer = (*Point)(nil) // 指针类型实现
// 如果没实现，这行编译就报错——常用于库代码做静态保证
```

**两条黄金准则**（面试谈设计能力时的加分项）：
1. **接受接口，返回结构体**（Accept interfaces, return structs）——参数用接口增加灵活性，返回具体类型让调用方拿到完整能力。
2. **接口越小越好**——`io.Reader`/`io.Writer` 都只有一个方法，却组合出整个 IO 生态。小接口易实现、易组合。

---

## 5. ⚠️ 值接收者 vs 指针接收者对接口实现的影响

这是个隐蔽考点：

```go
type Animal interface { Sound() string }

type Dog struct{}
func (d *Dog) Sound() string { return "汪" } // 指针接收者

func main() {
    var a Animal
    a = &Dog{}  // ✓ *Dog 实现了 Animal
    // a = Dog{} // ✗ 编译错误！Dog（值）没有实现 Animal
}
```

**规则**：
- 方法用**指针接收者** → 只有 **`*T`** 实现了接口（`T` 值没有）。
- 方法用**值接收者** → **`T` 和 `*T`** 都实现了接口。

**原因**：值 `T` 放进接口是拷贝，对拷贝取地址没意义（且可能不可寻址），所以指针方法集不包含值类型。

> 记忆：**指针方法挑剔（只认指针），值方法宽容（都认）。**

---

## 6. 性能注意点

- **接口调用有开销**：方法调用要经过 itab 查表跳转，无法内联，比直接调用慢一点。热点路径上百万次调用要留意。
- **装箱开销**：值放进接口会**逃逸到堆**（接口的 data 是指针），小值频繁装箱会增加 GC 压力。例如 `fmt.Println(i)` 里 `i` 会逃逸。
- 这也是 **Go 1.18 引入泛型**的动机之一：能用泛型表达的"对多类型做同样操作"，就不必用 `any` 装箱，省去运行时开销和断言。

---

## 7. 面试速答清单

| 问题 | 一句话答案 |
|------|-----------|
| 接口底层结构？ | eface（空接口：type+data）/ iface（非空：itab+data），itab 含方法表 fun |
| 接口怎么调方法？ | 查 itab.fun 函数指针表跳转，类似虚表 |
| `err != nil` 陷阱？ | 接口=类型+数据，返回 nil 指针会让类型部分非空，导致 != nil；应直接 return nil |
| 接口 == nil 条件？ | 类型和数据**都**为 nil |
| 断言失败？ | `v, ok := i.(T)` 安全形式 ok=false；`v := i.(T)` 会 panic |
| 值/指针接收者影响实现？ | 指针接收者只有 *T 实现接口；值接收者 T 和 *T 都实现 |
| 接口调用慢吗？ | 有 itab 查表 + 无法内联 + 装箱逃逸，热点路径可考虑泛型 |

---

## 一句话总结

> **接口 = (类型信息 itab/​_type, 数据指针) 二元组，方法调用靠 itab 方法表跳转；只有类型和数据都为 nil 接口才 == nil（nil 指针装箱仍 != nil）；指针接收者方法只让 *T 实现接口。**

➡️ 上一篇：[03 · channel](03_channel_internals.md) ｜ 下一篇：[05 · defer/panic/recover](05_defer_panic_recover.md)
