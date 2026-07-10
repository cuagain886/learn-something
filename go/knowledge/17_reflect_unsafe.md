# 17 · 反射、泛型与 unsafe：动态能力的成本和边界 ⭐⭐⭐

> 对应代码：[`../code/25_reflect_unsafe`](../code/25_reflect_unsafe)

反射和 unsafe 都能绕过普通静态代码的部分约束，但性质完全不同：反射仍受运行时类型系统检查，错误通常 panic 或返回失败；unsafe 允许把编译器和 GC 依赖的不变量交给程序员维护，错误可能直接变成内存破坏。

---

## 1. 什么时候需要反射

典型场景：

- JSON/ORM/配置绑定等需要读取 struct tag；
- 框架在运行时处理调用方未知的具体类型；
- 通用调试、序列化和依赖装配工具。

如果类型集合在编译期已知，普通接口、泛型或生成代码通常更清晰。不要因为“少写几行重复代码”就把业务逻辑变成反射状态机。

本章配置绑定器读取：

```go
Addr string        `cfg:"ADDR,required"`
Port int           `cfg:"PORT,default=8080"`
Timeout time.Duration `cfg:"TIMEOUT,default=2s"`
```

它严格拒绝非法 target、未知 tag、未导出字段和不支持类型。反射工具最危险的失败方式不是报错，而是静默保留零值后让错误在更远处爆发。

---

## 2. Type 与 Value

- `reflect.Type` 描述静态/动态类型、字段、方法、Kind、Size、Align；
- `reflect.Value` 同时携带类型和值，并记录是否可寻址、可修改等标志。

`Kind` 是底层类别。例如 `type Port int16` 的 Type 是 `main.Port`，Kind 是 `reflect.Int16`。配置绑定器可以按 Kind 支持所有命名有符号整数，同时用 Type 特判 `time.Duration`。

Go 1.22+ 的 `reflect.TypeFor[T]()` 可以直接取得类型参数的 Type，不需要构造 `(*T)(nil).Elem()` 这类技巧。

---

## 3. addressable 与 settable

```go
value := reflect.ValueOf(config)       // 拿到副本，不可 Set
target := reflect.ValueOf(&config).Elem() // 指向原变量，可 Set
```

要通过反射设置字段，通常需要：

1. 传入非 nil 指针；
2. `Elem()` 后是 struct；
3. 字段已导出；
4. Value 可寻址且 CanSet；
5. 写入值的类型可赋值或按规则转换。

直接对不可设置 Value 调 Set 会 panic。库代码应先验证并返回结构化错误，不能把反射 panic 暴露给普通配置输入。

未导出字段即便与绑定器在同一个 package，也不应通过 unsafe 绕过，因为这会破坏被绑定类型的封装不变量。

---

## 4. 反射配置绑定器的执行过程

```text
target any
  → ValueOf：必须是 non-nil pointer
  → Elem：必须是 struct
  → 遍历字段
      ├── 未带 cfg 的嵌套 struct：递归
      ├── 解析 key/required/default
      ├── 从 map 取原始字符串
      ├── 按 Type/Kind 严格转换
      └── Set 写入
```

错误用 `FieldError` 包装字段名、配置 key、原始值和底层 cause：

```go
var fieldErr *FieldError
if errors.As(err, &fieldErr) { ... }
if errors.Is(err, ErrRequiredField) { ... }
```

调用方判断错误类别而不是匹配错误文本。

---

## 5. 泛型与反射怎样选择

| 需求 | 普通代码 | 泛型 | 反射 |
|---|---:|---:|---:|
| 具体类型已知 | 最佳 | 可用 | 不推荐 |
| 一组具有相同操作的类型 | 重复 | 最佳 | 可用但成本高 |
| 运行时才知道 struct 字段/tag | 无法通用 | 通常无法枚举字段 | 最佳 |
| 编译期类型安全 | 有 | 有 | 弱，很多错误运行时发现 |
| 调试复杂度 | 低 | 中 | 高 |

本章 `ParseSigned[T]` 用类型集合支持所有命名有符号整数，并通过 `TypeFor[T]().Bits()` 保留溢出检查。它比“用反射解析任意数字”更容易读、也更容易被编译器优化。

泛型不是宏。编译器实现可能使用形状、字典传递、单态化或组合策略，具体代码生成属于版本实现细节；不应在没有编译器输出和 Benchmark 时声称“每个泛型实例一定完整复制一份机器码”。

---

## 6. 结构体对齐与 padding

每个字段有对齐要求，字段起始偏移通常是其对齐倍数，结构体整体大小还要向最大对齐取整，保证数组中每个元素都正确对齐。

```go
type Wasteful struct {
    Enabled bool  // 1 byte + padding
    Count   int64 // 8-byte alignment
    Code    int16
}
```

把大对齐字段放前面常能减少 padding，但不是绝对规则。使用：

```go
unsafe.Sizeof(value)
unsafe.Alignof(value)
unsafe.Offsetof(value.Field)
```

字段重排的代价：

- 破坏按位置初始化的复合字面量（本包外通常只能按名）；
- 影响 cgo、二进制协议和共享内存布局；
- 可读性可能下降；
- 省下的字节未必是实际内存热点。

先测对象数量和堆占用，再决定是否重排。

---

## 7. unsafe.Pointer 与 uintptr

`unsafe.Pointer` 是 GC 仍能识别为指针的通用指针桥梁；`uintptr` 只是足够容纳地址的整数，GC 不把它当引用。

危险模式：

```go
address := uintptr(unsafe.Pointer(ptr))
// 中间发生调用、分配或 GC
ptr2 := unsafe.Pointer(address + offset)
```

转换成 uintptr 后，原对象可能不再因这个整数保持存活；栈增长、对象生命周期和 checkptr 规则都可能让拆开的转换无效。官方 unsafe 文档列出了少数合法转换模式，应把转换保持在同一个表达式中，并用 `runtime.KeepAlive` 明确生命周期尾部。

绝不要把 Go 指针伪装成 uintptr 长期保存。

---

## 8. []byte 到 string 的零拷贝

安全转换：

```go
s := string(bytes) // 语义上得到不可变字符串
```

unsafe 只读视图：

```go
s := unsafe.String(unsafe.SliceData(bytes), len(bytes))
```

零拷贝必须同时满足：

1. 字符串使用期间源 slice 一直存活；
2. 源字节不再发生任何修改；
3. 源 buffer 不会被池化并交给其他请求复用；
4. 调用者知道返回字符串借用了输入生命周期；
5. Benchmark 证明复制是显著热点。

最常见事故是把网络读取 buffer 转成 unsafe string 后放入 map，随后 buffer 被下一次 Read 或 `sync.Pool` 复用，map 的 key 内容“神秘变化”。

本章测试通过比较 `unsafe.StringData` 与 `unsafe.SliceData` 证明共享指针，但绝不在转换后修改 source。

---

## 9. checkptr 能检查什么

```powershell
go test -gcflags=all=-d=checkptr=2 ./25_reflect_unsafe
```

checkptr 会在运行时检查部分非法 unsafe 指针算术和对象边界。Race Detector 检查并发访问，checkptr 检查部分指针规则，它们互不替代。

checkptr 通过也不证明 unsafe 代码正确：生命周期、不可变性、cgo 指针规则和业务所有权仍可能出错。

---

## 10. 性能结论怎样验证

```powershell
go test -run='^$' -bench=. -benchmem ./25_reflect_unsafe
```

本章比较：

- 直接解析和字段赋值；
- 泛型整数解析；
- 反射 tag 解析与 Set；
- 安全 string copy 与 unsafe view。

反射通常有字段元数据遍历、字符串解析和动态分派成本。成熟框架常缓存 `reflect.Type` 到绑定计划的映射，把 schema 解析从每次调用移到首次使用；是否值得缓存仍要通过 profile 决定。

不要只比较 ns/op：unsafe 零分配可能引入极难定位的所有权 bug；正确性成本必须进入工程决策。

---

## 11. 常见反模式

1. 对不可 Set 的 Value 直接调用 Set；
2. 用 recover 掩盖所有反射 panic，却不报告字段；
3. 用 unsafe 修改未导出字段；
4. 把 uintptr 当长期指针保存；
5. 零拷贝 string 引用会复用的网络 buffer；
6. 看到一次 Benchmark 更快就全局替换安全转换；
7. 反射绑定失败后静默留下零值；
8. 用 `Kind` 判断后忘记命名类型和位宽；
9. 结构体重排破坏二进制协议布局；
10. 把当前 runtime/编译器实现当语言永久保证。

---

## 12. 高频面试题与参考答案

### Q1. reflect.Type 和 Value 有什么区别？

Type 描述类型元数据；Value 表示带类型的运行时值，并包含可寻址、可修改等状态。

### Q2. 为什么 `reflect.ValueOf(x).CanSet()` 通常为 false？

接口中拿到的是 x 的副本，不可修改原变量。传 `&x` 再 Elem 才得到可寻址、通常可设置的 Value。

### Q3. Kind 和 Type 有什么区别？

Type 保留命名类型身份；Kind 是底层类别。`type Port int16` 的 Type 是 Port，Kind 是 Int16。

### Q4. 泛型能替代所有反射吗？

不能。泛型要求编译期表达类型关系，不能直接枚举运行时未知 struct 的字段和 tag；这类元编程仍适合反射或代码生成。

### Q5. unsafe.Pointer 与 uintptr 的关键区别？

unsafe.Pointer 仍是 GC 可识别指针；uintptr 是整数，不保持对象存活，不能长期充当引用。

### Q6. 为什么结构体字段顺序影响大小？

字段必须满足对齐，编译器在字段间和末尾插入 padding。不同顺序产生不同空洞。

### Q7. `unsafe.Sizeof` 会递归计算 slice/map 指向的数据吗？

不会，只返回值本身描述符的大小，不包含其引用的底层存储。

### Q8. []byte 零拷贝转 string 有什么风险？

字符串承诺不可变，却与可变 slice 共享内存；修改、池化复用或生命周期错误会破坏 string/map 等不变量。

### Q9. checkptr 通过能证明安全吗？

不能。它只能动态检查部分非法指针模式，不理解完整的业务所有权和不可变性。

### Q10. 反射慢应该怎样优化？

先 profile；常见方法是缓存 Type 解析结果、减少 Interface 装箱、把热路径改成泛型/生成代码，而不是直接上 unsafe。

### Q11. interface 装箱一定逃逸吗？

不一定。逃逸由编译器根据值的生命周期和调用上下文决定，应使用 `-gcflags=-m=2` 和 Benchmark 验证。

### Q12. 什么时候可以使用 unsafe？

安全实现无法满足已证明的性能/互操作需求，且生命周期、对齐、不可变性和版本边界都能被测试与审查清楚时；使用范围应尽量小。

---

## 13. 官方资料

- [`reflect` package](https://pkg.go.dev/reflect)
- [`unsafe` package and valid conversion patterns](https://pkg.go.dev/unsafe)
- [Go Language Specification: alignment guarantees](https://go.dev/ref/spec#Size_and_alignment_guarantees)
- [`runtime.KeepAlive`](https://pkg.go.dev/runtime#KeepAlive)

## 一句话总结

> 反射解决运行时未知类型，泛型解决编译期类型族，unsafe 把内存不变量交给程序员；先选择最安全、最可证明的工具，再让 Benchmark 决定是否值得承担复杂度。
