# 26 · interface、泛型与 runtime 类型系统 ⭐⭐⭐

> 基于 Go 1.26.4。接口赋值/断言和泛型语义稳定；eface/iface/itab、shape 与字典是版本实现。

## 1. eface、iface 与类型元数据

空接口概念上保存动态类型和数据，非空接口还需方法表。runtime 的 `_type`/abi.Type 描述大小、对齐、指针位图、hash/equal 等；itab 连接具体类型与目标接口的方法集合。私有布局不能硬编码成业务协议。

## 2. 装箱与 typed nil

把值赋给接口会形成动态类型+动态值，数据可能直接复制或间接保存，是否逃逸看编译器。接口本身只有两部分都为空才等于 nil；`(*T)(nil)` 装入接口后动态类型存在，因此接口不为 nil。

## 3. 动态派发与去虚拟化

接口调用通常经 itab 找方法入口。若编译器能证明动态类型唯一，可去虚拟化并继续内联，因此“接口调用固定慢多少”没有通用答案。

## 4. 泛型 shape 与 dictionary

编译器可让具有相同底层表示的一组实例共享 shape 代码，并传入字典提供类型操作；也会针对具体情况生成代码。具体策略会演进，应用只依赖类型参数语义。

## 5. 反射的边界

反射在运行时检查 Kind/Type，适合 schema、序列化和框架边界；泛型适合编译期已知的一组类型。反射输入必须先判 Invalid、Kind 和 nil 能力，否则会 panic。

## 6. 工具验证

```powershell
go build -gcflags='-m=2' ./34_interface_generics_runtime
go test ./34_interface_generics_runtime -run '^$' -bench '.' -benchmem
go build -o $env:TEMP\dispatch.exe ./34_interface_generics_runtime
go tool nm $env:TEMP\dispatch.exe | Select-String 'CallGeneric|CallInterface'
```

Benchmark 只有在相同输入、阻止消除并查看编译器输出后才可解释。

## 7. 工程选择

普通函数优先；同一算法覆盖类型集时用泛型；行为多态用小接口；运行时未知 schema 才用反射。接口定义在消费者侧，避免宽接口和无意义 `any` 传播。

## 8. 高频面试题与参考答案

### Q1. 空接口与非空接口差异？
空接口只需动态类型/数据；非空接口还需把具体类型方法映射到接口方法。
### Q2. typed nil 为什么不等于 nil？
动态类型仍存在，接口的类型部分非空。
### Q3. itab 做什么？
连接具体类型和接口类型，并提供方法派发表及相关缓存信息。
### Q4. 接口装箱一定逃逸吗？
不一定，由调用上下文、内联和逃逸分析决定。
### Q5. 接口调用一定间接吗？
源码语义动态，但编译器可能去虚拟化为具体调用。
### Q6. 泛型一定生成每类型一份代码吗？
不一定，当前编译器可用 shape 共享代码并传字典。
### Q7. shape 是语言概念吗？
不是，是当前编译器实现细节。
### Q8. 泛型能替代反射吗？
不能；运行时才知道的字段/schema 仍需反射或代码生成。
### Q9. comparable 接口能比较所有值吗？
约束允许可比较类型，但接口动态值若含不可比较类型仍需遵守具体语义边界。
### Q10. IsNil 能对任意 reflect.Value 调用吗？
不能，只适用于 Chan/Func/Interface/Map/Pointer/Slice，Invalid 也会 panic。
### Q11. 方法集为何影响接口实现？
值类型与指针类型的方法集不同，决定哪个具体类型满足接口。
### Q12. 如何比较四种派发成本？
同一语义写 Benchmark，结合 allocs、`-m=2`、nm/objdump 判断装箱、内联和去虚拟化。

## 9. 源码地图

`runtime/iface.go`、`internal/abi/type.go`、`reflect/type.go`、`cmd/compile/internal/noder` 与 SSA devirtualize pass。

## 一句话总结

接口、泛型和反射分别解决运行时行为多态、编译期算法复用和运行时结构发现；性能取决于装箱、字典、内联与去虚拟化的组合。
