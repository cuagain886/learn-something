# 11｜解释器、JIT 与执行：Profile、内联、OSR 和去优化

> 优先级：S｜难度：★★★★★｜基线：HotSpot Server VM 21｜前置：[05](05-class-file-and-bytecode.md)、[09](09-memory-allocation.md)

## 1. 本章目标

能解释冷启动为何慢、tiered compilation 如何从解释/C1到 C2、方法/回边计数与 OSR、code cache 和 compilation threads；能说明 profile-guided speculative optimization、inlining/devirtualization 与 uncommon trap/deoptimization；能写不被 DCE/constant folding 欺骗的 JMH，并理解 AOT/Native Image 的闭世界交换。

## 2. 执行引擎不是“先解释整程序再统一编译”

方法按需进入执行：

```text
Class verified bytecode
      │ first/cold invocation
      ▼
Template Interpreter ── collect invocation/branch/type profiles
      │ thresholds + compiler queue
      ├─► C1 compiled code（快编译，可携 profile instrumentation）
      │        │ more profile/hotness
      │        └─► C2 optimized code
      │
loop backedge hot ──► OSR compiled loop entry

assumption invalid / uncommon case ──► deopt → interpreter/lower tier state
```

不同方法同时处于不同 tier；一个方法还能有普通 entry 和 OSR nmethod。threshold 是自适应策略/flags，不背“调用 10000 次就 C2”的固定数。

## 3. 模板解释器

HotSpot template interpreter 为每个 bytecode template 生成/使用本地执行片段，维护 frame、operand stack 和 dispatch。优点：立即执行、逐操作采集 profile、无需编译等待；缺点是 dispatch/stack traffic 较高。

“解释器逐行读源码”错误：运行的是已验证 bytecode。异常、safepoint、field/method resolution 都与 runtime metadata 协作。

## 4. 热度：方法调用与回边

invocation counter 反映方法入口，backedge counter 反映 loop 回跳。一个调用一次却循环亿次的方法需要 OSR，不应等下次入口。计数会 decay/受 tier policy、队列负载、code cache 等影响。

OSR（On-Stack Replacement）在正在执行的 loop 中途，从 interpreter/C1 frame 切到 compiled entry，需把局部/栈状态映射进机器码。基准第一轮 iteration 可能在中途 OSR，时间混合多个 tier，正是 warmup 必要原因。

## 5. C1、C2 与分层编译

C1 编译快、优化较轻，可插 profile probes；C2 编译慢，使用 richer IR 与 profile 做 aggressive optimization。tiered 默认使程序比纯解释更快收集 profile，同时达到 C2 peak。

不要把 C1=client、C2=server 简化为两个独立 JVM；在现代 Server VM 中二者协作。Graal JIT 可作为其他编译器路径（发行版/配置不同），本文私有 pipeline 只指 HotSpot C2 21。

compiler threads 在后台消费 compile queue，占 CPU/native memory；CPU quota 小/启动类多时会与业务争抢。JFR `jdk.Compilation`、`jcmd Compiler.queue`/`Compiler.codecache`（具体命令支持检查）用于观察。

## 6. Code Cache

JIT nmethods、stubs 和 interpreter/runtime code 位于 native code cache，不在 Java heap。tiered 时常分 non-method、profiled、non-profiled heaps，改善 locality/回收。

code cache 满会触发 sweeping、停止部分编译并告警，应用可能退回低 tier导致 CPU/延迟变化；加 Xmx 无效。动态生成大量类/方法、AOP、表达式编译会增加压力。

```powershell
jcmd <pid> Compiler.codecache
jcmd <pid> Compiler.queue
```

`ReservedCodeCacheSize` 是实现 flag，先定位增长/碎片/生成类根因，再调。

## 7. Profile-Guided Optimization

解释/C1 记录：receiver type、branch frequency、null/range、call count等。C2基于“目前常见”生成快路径和 guard：

```text
if (receiver.klass != ObservedKlass) uncommon_trap;
// inline ObservedKlass.apply body
```

若新类加载或 call site 变多态，guard fail/uncommon trap，把 compiled frame 的 locals/virtual objects还原为 interpreter frames，称 deoptimization。之后可带新 profile 重编。

投机不改变语义；它把罕见路径移出 hot code。大量 deopt/recompile 会造成 latency/CPU 抖动，应查 class loading、unstable profile 与 trap reason，而非禁用 JIT。

## 8. 方法内联是优化放大器

内联把 callee IR 合入 caller，省调用并暴露跨方法常量、escape、range和virtual target：

```text
virtual call
 → type profile monomorphic
 → guarded devirtualization
 → inline
 → Pair allocation no longer escapes
 → scalar replacement + constant/range/DCE
```

是否内联取决于 bytecode/machine size、hotness、depth、profile、exception path、compiler budget；不是“少于 35 bytes 永远内联”。巨大方法会挤压 budget和instruction cache，过度手工内联可能更差。

实际 [DispatchBenchmark.java](benchmarks/jmh/src/main/java/dev/deepjava/jmh/DispatchBenchmark.java) quick run：1 receiver type ~1339.984 ops/µs，8 types ~427.091 ops/µs。它与去虚拟化直觉一致，但短 run/不同数组访问/profile 也影响；需 PrintInlining/perfasm 才能归因到具体机器码。

## 9. 常见优化

- **escape/scalar replacement**：第 09 章，消 allocation/lock。
- **constant folding/propagation**：编译期或 JIT 计算常量。
- **dead code elimination**：不可达/结果不可观察代码删除。
- **common subexpression elimination**：安全条件下复用相同计算。
- **range-check elimination**：loop bounds证明后移除数组检查。
- **loop unroll/peeling/hoisting/vectorization**：增加 ILP/SIMD 或移不变量。
- **devirtualization/intrinsics**：直接 target，或用 CPU 指令实现 String/crypto/math 等。

每项受 exception、alias、overflow、NaN、memory ordering 约束。例如不能把可能抛异常的 load 随意越过可观察副作用；volatile/monitor限制移动。

## 10. 为什么第一次请求慢

冷请求叠加：class/resource load、verification、Spring bean/Jackson serializer初始化、DNS/TLS/connection、page fault、interpreter/C1、compiler queue、cache miss。只说“JIT预热”不完整。

分层测：

```text
process start
 → application ready
 → first local handler
 → first DB/model connection
 → first complete business request
 → steady-state distribution
```

warmup 应运行代表性路径但不产生真实副作用/污染租户 cache。CDS/AppCDS 可减少 class metadata/startup；连接预建要有超时/失败策略。生产 readiness 在必要依赖就绪后再接流量。

## 11. 正确与错误 JMH

[BenchmarkPitfalls.java](benchmarks/jmh/src/main/java/dev/deepjava/jmh/BenchmarkPitfalls.java)：

```java
@Benchmark public void wrong() { Math.log(42.0); }
@Benchmark public double right() { return Math.log(inputParam); }
```

wrong 的输入常量、结果未观察，计算可完全消失；纳秒数字只测 harness。right 以 `@Param` state 输入并返回，让 JMH consume，但仍要确认 workload代表性。

最低实践：

1. annotation processor 生成 harness；独立 jar/fork；
2. warmup 到 compilation/profile稳定；
3. 参数来自 State，不在 benchmark 每次 setup；
4. 返回结果或 Blackhole，防 DCE；
5. 用 `-prof gc/perfasm` 验证 allocation/assembly；
6. 多 fork，看 variance/CI，不从 3 次 quick run发布结论；
7. baseline/negative control，避免测 loop、timer或 constant。

## 12. 实测 allocation optimization

第 09 章 JMH：escaping Pair 24 B/op，scalar candidate ≈0 B/op。0.305 ns/op 小于常见 wall clock resolution并不表示“真的每次在现实时间 0.3ns 完成一整个独立请求”；JMH批量循环、吞吐换算，且计算很小。可信主张是生成代码在该环境的 steady-state几乎无 allocation，不把绝对数字外推业务。

运行完整配置：

```powershell
java -jar target\benchmarks.jar AllocationBenchmark -prof gc
java -XX:+UnlockDiagnosticVMOptions -XX:+PrintCompilation -XX:+PrintInlining `
  -jar target\benchmarks.jar DispatchBenchmark -wi 3 -i 5 -f 1
```

PrintInlining 输出很大，按 benchmark generated stub/operation过滤并保留完整原始文件。诊断 flags 本身会扰动。

## 13. 去优化与 Uncommon Trap

trap 原因可能 class_check、null_check、range_check、unreached等；“uncommon”仅基于当前 profile。第一次罕见输入触发 deopt会有 latency spike，随后重编可能覆盖。

线上 p999 与平均 CPU 无异常时，查 JFR deoptimization/compiler/class load 时间线。框架动态部署新代理类、从单态变 megamorphic、异常路径突然变常见都可能触发。

过早压测单一数据会训练偏 profile；容量测试要覆盖真实 type/branch分布与 phase change。

## 14. AOT、JIT 与 GraalVM Native Image

- **传统 AOT/CDS**：预存部分元数据/代码，减少启动，运行仍可 JIT（具体 JDK特性按版本）。
- **JIT**：使用现场 profile达到 peak，付启动/CPU/code cache。
- **Native Image**：build-time closed-world reachability分析，编译 standalone binary，通常改善启动和内存；缺少同等动态现场 JIT优化，构建慢，反射/JNI/proxy/resource/dynamic loading需可达元数据或受限。

Agent 插件/动态 Tool/Byte Buddy 与 closed world天然冲突；Spring AOT等可生成 hints。选择必须跑：cold start、RSS、steady throughput/p99、构建时间、功能兼容、诊断能力与升级。不要宣称 Native Image 必然更快/更省成本。

## 15. 后端与 Agent 应用

- 模型网关长驻、流量稳定：JIT peak有价值；serverless冷启动可能偏 AOT/native。
- Tool call site若 thousands provider types megamorphic，可按 registry把 adapter预绑定 MethodHandle/function，仍需实测。
- 生成每请求新 proxy class会涨 metaspace/code cache；按 schema/version cache class，loader生命周期有界。
- warmup不能发送真实邮件/PR；使用 fake provider、dry-run或read-only健康路径。
- latency budget要区分 compilation spike 与模型网络；trace/JFR时间线对齐。

## 16. 常见错误与排障

| 现象 | 证据 | 方向 |
|---|---|---|
| 启动 CPU 高 | JFR compilation/class load | warmup/CDS/减少生成类，不先禁 JIT |
| 运行一段时间变快 | tier transitions/cache | 分冷/热报告 |
| p999 周期尖峰 | deopt/compiler/GC/class load | trap reason/profile phase |
| CodeCache full | `Compiler.codecache`/warning | 动态 code、cache size/sweeping |
| benchmark 0 ns | DCE/constant fold | param + consume + assembly |
| 改接口后热路径慢 | call site megamorphic/未内联 | PrintInlining/type profile |

## 17. 实验任务

1. 跑 BenchmarkPitfalls，观察 wrong；改成非 constant/返回值并用 perfasm。
2. Dispatch 1/2/8 types，保留 PrintInlining/deopt，找 monomorphic边界。
3. `-XX:-TieredCompilation`、`-Xint` 对照冷/热（新 fork），不用于生产结论。
4. `jcmd Compiler.codecache` 定时采样动态 proxy生成实验，证明增长/回收。
5. 真实 API冷启动分段：class/bean/connection/JIT，各建可证伪对照。

## 18. 面试题与检查清单

**Q：Java为何运行后变快？** profile累积，C1/C2编译、内联/去虚拟化和 cache warm；不是固定时间必然。

**Q：什么是 OSR？** 热 loop仍在 stack上时切换到编译版入口，避免等方法返回再调用。

**Q：去优化是失败吗？** 是投机假设失效后的正确回退机制；频繁发生才是性能信号。

- [ ] 区分 interpreter/C1/C2/OSR/nmethod。
- [ ] 能解释 profile guard、inline 与 deopt。
- [ ] 知道 code cache是 native区，不是 heap。
- [ ] JMH有fork/warmup/consume/param/对照/profiler。
- [ ] AOT/Native Image按 closed-world与真实 workload选。

## 19. 延伸阅读

- [HotSpot VM Performance Enhancements](https://docs.oracle.com/en/java/javase/21/vm/java-hotspot-virtual-machine-performance-enhancements.html)
- [java JIT options](https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html)
- [OpenJDK JMH](https://github.com/openjdk/jmh)
- [GraalVM Native Image](https://www.graalvm.org/jdk25/reference-manual/native-image/)

下一章：[12-generics.md](12-generics.md)
