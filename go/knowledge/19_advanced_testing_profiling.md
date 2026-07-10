# 19 · 高级测试、Fuzz、Benchmark、pprof 与 trace ⭐⭐⭐

> 对应代码：[`../code/27_advanced_testing_profiling`](../code/27_advanced_testing_profiling)

测试不是“证明程序没有 bug”，性能工具也不是“生成一张火焰图”。成熟工程需要一条可重复的证据链：用不同测试方法约束行为，用 Race/Fuzz 扩大输入和调度空间，用 Benchmark 建基线，再用 pprof/trace 找到真正瓶颈。

---

## 1. 四类测试各自负责什么

| 方法 | 最擅长发现 | 本章示例 |
|---|---|---|
| 表驱动单元测试 | 已知边界和错误分类 | 短帧、长度错误、CRC 错误 |
| 属性测试 | 大量生成值都应满足的不变量 | Decode(Encode(x)) = x |
| Golden Test | 稳定文本/二进制格式回归 | 固定帧十六进制输出 |
| Fuzz | 未预想到的输入组合、panic、越界 | 任意字节 Decode 不 panic |

它们互补，不是替代关系。Fuzz 很擅长找到“某个输入会崩”，但业务关键示例仍应写成可读单元测试；Golden 很容易更新，却不能告诉你新输出是否业务正确。

---

## 2. 二进制帧协议为何适合测试教学

本章格式：

```text
offset  size  field
0       1     version
1       1     flags
2       2     payload length（big endian）
4       N     payload
4+N     4     CRC32 IEEE(header + payload)
```

Decode 的安全顺序：

1. 长度至少 8 才能读取固定字段；
2. 读取 uint16 声明长度；
3. 验证总长度精确相等；
4. 再计算并比较 CRC；
5. 最后复制 payload 返回。

任何切片前先验证边界，Fuzz 才不会轻易找到 slice-bounds panic。

返回 payload 副本让结果不依赖调用者后续复用输入 buffer，这也是一种所有权契约。

---

## 3. 属性测试

传统单元测试枚举几个样例；属性测试表达所有输入应满足的关系：

```go
property := func(version, flags uint8, payload []byte) bool {
    encoded, err := Encode(Frame{version, flags, payload})
    decoded, err := Decode(encoded)
    return decoded == original
}
quick.Check(property, &quick.Config{MaxCount: 500})
```

常见属性：

- round-trip；
- 幂等：normalize(normalize(x)) = normalize(x)；
- 逆运算；
- 排序后有序且元素多重集合不变；
- 输入变换后的单调性/守恒关系。

属性本身也可能写错。要保留几个容易人工判断的例子，并让失败输出能还原输入。

---

## 4. Go Fuzz 工作流

Fuzz 函数签名：

```go
func FuzzFrameRoundTrip(f *testing.F) {
    f.Add(uint8(1), uint8(0), []byte("seed"))
    f.Fuzz(func(t *testing.T, version, flags uint8, payload []byte) { ... })
}
```

普通 `go test` 只运行 seed corpus。持续变异需要显式命令：

```powershell
go test -fuzz=FuzzFrameRoundTrip -fuzztime=10s ./27_advanced_testing_profiling
go test -fuzz=FuzzDecodeNeverPanics -fuzztime=10s ./27_advanced_testing_profiling
```

一个 `-fuzz` 正则必须只匹配一个 fuzz target；项目有多个 `Fuzz...` 时不要使用模糊的 `-fuzz=Fuzz`。

Fuzzer 找到失败后会最小化输入，并把回归样本写入 `testdata/fuzz/<Target>`。确认不是错误断言后，应保留样本，让普通测试也持续覆盖。

好的 Fuzz 性质：

- 不允许 panic；
- 成功结果满足不变量；
- 错误必须属于已定义类别；
- 资源使用有合理上限；
- 不依赖网络、时间和全局可变状态。

不要在 fuzz target 中对大输入做无上限分配；先限制长度或让解析器本身有资源上限。

---

## 5. Golden Test 的纪律

Golden 文件适合：

- 稳定序列化格式；
- CLI 输出；
- 模板渲染；
- 复杂错误报告；
- AST/代码生成结果。

风险是“测试失败就更新 Golden”。正确流程：

1. 阅读 diff；
2. 判断格式变更是否兼容；
3. 必要时升级版本字段；
4. 只在变更确实预期时更新；
5. 将 Golden 与代码一起审查。

二进制 Golden 可以存原始字节或规范十六进制。本章用小写 hex + 换行，便于 Git diff。

---

## 6. 并行测试

`t.Parallel()` 只适合彼此隔离的子测试。检查：

- 不共享可写 map/slice/全局变量；
- 不复用同一临时路径；
- 不修改进程级环境变量；
- 不争用固定端口；
- fake clock/随机源不是共享可变实例。

Go 1.22+ for-range 每轮变量重新声明，修复了很多闭包捕获陷阱，但测试用例内的 map、slice 指向数据仍可能共享。语言版本修复变量绑定，不会自动让对象并发安全。

使用 `t.TempDir()`、`t.Setenv()`（注意不能与 Parallel 混用）和每用例独立 fixture。

---

## 7. Race Detector 的能力边界

```powershell
go test -race ./...
```

Race Detector 基于动态 instrumentation，发现本次执行中两个实际并发且缺少同步的冲突访问。

能发现：

- map/slice/字段并发读写；
- 锁遗漏；
- 测试并行共享状态；
- 部分关闭/发送竞态。

不能证明：

- 未覆盖路径没有竞态；
- 没有死锁/活锁；
- 业务原子性正确；
- atomic 组合成的复合不变量正确；
- 分布式竞态不存在。

Race 构建更慢、更耗内存，CI 可以分层运行，但所有并发核心包至少要定期跑。

---

## 8. 可靠 Benchmark

Go 1.24+ 推荐：

```go
for b.Loop() {
    resultSink = operation(input)
}
```

注意：

- `b.ReportAllocs()` 或 `-benchmem` 查看分配；
- 输入和输出 sink 防止死代码消除；
- 准备数据放在计时循环外；
- 不在循环里 `b.Log`、随机初始化或创建无关 fixture；
- 对等价语义做比较；
- 用 `-count=5` 多次测，关注噪声和分布；
- CPU 频率、后台负载和电源策略都会影响结果。

```powershell
go test -run='^$' -bench=. -benchmem -count=5 ./27_advanced_testing_profiling
```

本章 32B、1KB、60KB 帧同时展示固定开销和 payload 大小时的复制/CRC 成本。

---

## 9. pprof 类型选择

| Profile | 回答的问题 |
|---|---|
| CPU | CPU 时间采样落在哪些调用栈 |
| heap | 当前存活对象占用在哪分配 |
| allocs | 历史累计分配发生在哪里 |
| goroutine | goroutine 当前栈和阻塞位置 |
| block | channel/select/锁等阻塞时间 |
| mutex | 锁竞争等待时间 |

CPU 示例：

```powershell
go run ./27_advanced_testing_profiling -mode=cpu -duration=5s -out cpu.pprof
go tool pprof -top cpu.pprof
```

heap 示例：

```powershell
go run ./27_advanced_testing_profiling -mode=alloc -duration=2s -out heap.pprof
go tool pprof -top -alloc_space heap.pprof
go tool pprof -top -inuse_space heap.pprof
```

alloc_space 看累计分配压力，inuse_space 看采样时仍存活的内存，两者回答不同问题。

mutex/block profile 需要设置采样率，常开会有成本。本章 workload 显式开启，结束后恢复/关闭。

---

## 10. trace 何时比 pprof 更合适

pprof 聚合调用栈，擅长“时间/内存主要在哪里”；trace 保留时间线，擅长：

- goroutine 创建、阻塞、唤醒；
- P/M/G 调度关系；
- GC、STW；
- 网络阻塞；
- scheduler latency；
- 并发阶段是否真正重叠。

```powershell
go run ./27_advanced_testing_profiling -mode=trace -duration=2s -out trace.out
go tool trace trace.out
```

trace 数据量大、采集成本更高，只采足够回答问题的短窗口。

---

## 11. 从现象到根因的性能流程

```text
1. 定义 SLO/问题：CPU 高、P99 高、内存涨、goroutine 涨？
2. 建立可重复 workload 和基线
3. 选择对应 profile，而不是全部一起开
4. top/cum 找热点和调用路径
5. 提出单一假设
6. 做一个最小修改
7. 重跑正确性、Race、Benchmark
8. 确认整体指标改善且没有把成本搬家
```

典型错误是看到某函数 flat 高就直接优化。它可能只是合理承担大量工作；也要看 cum、调用者、业务请求量和单位工作成本。

---

## 12. 常见反模式

1. 只写 happy path 单元测试；
2. Fuzz target 对输入做无限分配；
3. 失败就自动更新 Golden；
4. 并行测试共享全局 fixture；
5. Race 没报警就宣布并发正确；
6. Benchmark 结果未使用，被编译器删除；
7. 在不同语义/处理数量间直接比较 ns/op；
8. 只看一次 Benchmark；
9. 用 heap inuse 解释累计分配；
10. 生产常开最高 block/mutex 采样率；
11. 采很长 trace，得到难以分析的巨型文件；
12. 没有基线就声称优化百分比。

---

## 13. 高频面试题与参考答案

### Q1. 单元测试和 Fuzz 的区别？

单元测试验证人工选择的代表性行为；Fuzz 从 seed 变异大量输入，寻找未预想到的崩溃和不变量违反。

### Q2. Fuzz 找到失败后怎样处理？

确认性质正确，修复根因，保留最小化 corpus 作为永久回归样本。

### Q3. Golden Test 最大风险是什么？

把“更新输出”当修复，未经审查接受非预期或不兼容变更。

### Q4. Race Detector 没报错说明什么？

只说明本次覆盖到的执行没有观察到竞态，不能证明所有调度和路径安全。

### Q5. `b.Loop` 有什么价值？

由 testing 控制迭代，降低手写 b.N 循环和计时边界错误；仍需正确准备输入和保留结果。

### Q6. 为什么 Benchmark 要使用包级 sink？

防止结果未使用导致计算被编译器消除或过度常量折叠。

### Q7. heap 和 allocs profile 区别？

heap 关注当前存活对象，allocs 关注累计分配；一个解释占用，一个解释 GC 压力/分配流量。

### Q8. block 和 mutex profile 区别？

mutex 聚焦锁竞争；block 覆盖 channel、select、锁等多种阻塞事件。

### Q9. flat 与 cum 如何理解？

flat 是函数自身样本，cum 包含其调用的下游；调度/封装函数可能 flat 低但 cum 高。

### Q10. pprof 与 trace 如何选择？

找聚合 CPU/内存热点优先 pprof；分析调度时间线、goroutine 阻塞和 GC 阶段用 trace。

### Q11. Fuzz 是否替代边界测试？

不替代。关键边界和错误语义要有可读、稳定的显式测试，Fuzz 扩大未知输入空间。

### Q12. 性能优化完成的标准是什么？

目标指标在可重复基准/负载下改善，正确性、Race 和资源指标没有回归，代码复杂度收益可接受。

---

## 14. 官方资料

- [Go Fuzzing](https://go.dev/doc/fuzz/)
- [`testing` package](https://pkg.go.dev/testing)
- [Data Race Detector](https://go.dev/doc/articles/race_detector)
- [`runtime/pprof` package](https://pkg.go.dev/runtime/pprof)
- [`runtime/trace` package](https://pkg.go.dev/runtime/trace)
- [Diagnostics](https://go.dev/doc/diagnostics)

## 一句话总结

> 用单元/属性/Golden/Fuzz 扩大正确性证据，用 Race 检查实际并发冲突，用 Benchmark 建基线，再让 pprof/trace 指向真正值得改的热点。
