# 09｜内存分配、逃逸分析与标量替换：`new` 不等于一次堆对象

> 优先级：S｜难度：★★★★★｜基线：HotSpot 21、G1 默认、C2｜前置：[08](08-object-layout.md)、[11](11-interpreter-and-jit.md)（可交叉阅读）

## 1. 本章目标

能解释 TLAB/bump pointer、共享分配、zeroing、Eden/Survivor/晋升与大对象路径；能区分逃逸分析、标量替换和真正“栈上分配”；能用 JMH `gc.alloc.rate.norm`、JFR/async-profiler allocation 证明是否发生实际分配，而不从源码 `new` 或字节码 `new` 猜。

## 2. 先区分三种“对象存在”

```text
源码语义：new Pair(a,b)，有 identity/fields/constructor 的可观察规则
Class 文件：new + dup + invokespecial <init>
优化机器码：真实 heap allocation / 部分标量 / 完全消除
```

只要程序无法观察差异，JIT 可不物化对象。反射、identity hash、锁、返回/存入共享结构等会增加可观察性并限制优化。debug/JFR 还能依靠 deoptimization metadata 在需要时重建虚拟对象。

## 3. 常见 G1 young allocation fast path

对普通小对象，HotSpot 典型路径：

```text
thread current TLAB: top + size <= end ?
   yes → top bump，返回旧 top，初始化 header/字段
   no  → refill/retire TLAB
          ├─ 从共享 Eden 申请新 TLAB（CAS/慢路径）
          ├─ 大于 TLAB/策略不适合：共享区域直接分配
          └─ 空间不足：触发/等待 GC 或最终 OOM
```

指针碰撞快，是因为可用区连续，分配近似 increment；并不表示完整 `new` 只有一条指令：还需 size 计算、TLAB check、zeroing、header、constructor、写屏障/采样等。无连续空间的管理可使用 free list；不同 collector 的 region/page/allocation 策略不同。

## 4. TLAB：把全局竞争换成局部碎片

Thread Local Allocation Buffer 是线程从 Eden 划到的私有分配区，不是“对象只能被该线程访问”。对象引用一发布，其他线程照常访问；TLAB 只是 allocation ownership。

收益：多数小对象分配无需全局 CAS/锁，top bump cache-friendly。成本：每线程剩余 tail waste、refill accounting；大量短命平台线程/虚拟线程的具体 TLAB 使用由 HotSpot 策略控制，不能按“线程数×固定 TLAB”直接算。

可用 `-Xlog:gc+tlab=trace` 或 JFR TLAB allocation 事件观察目标 build。日志是采样/汇总，不保证记录每个对象。

## 5. Zeroing 与安全语义

对象字段在构造器前有默认零值，防止读取前一对象残留。JVM 可提前清零 page/TLAB、用 bulk zeroing 或消除随后被完整覆盖的清零，但必须保持 Java 语义。

OS 常用 demand-zero page：虚拟地址 reserve/commit 与物理页首次触碰分开，首次写可能 page fault。大数组分配延迟既含 JVM 逻辑也含 page touch；`-XX:+AlwaysPreTouch` 把部分成本移到启动，增加启动时间/RSS，需按低延迟目标评估。

## 6. Eden、Survivor 与晋升不是所有 GC 的共同布局

在典型 generational G1：新对象进入 young regions（Eden）；Young GC 把 live 对象 evacuation 到 Survivor/Old，年龄增长；达到 tenuring threshold 或 Survivor 压力时晋升。`-XX:MaxTenuringThreshold` 是上限/策略输入，不意味着所有对象固定活 N 次。

动态年龄、目标 Survivor size、to-space 容量和对象大小会改变晋升。promotion/evacuation 要复制对象并更新引用，若 to-space 不足可能 evacuation failure/Full GC。

ZGC、Epsilon 等有不同代际/分配模型。JDK 21 Generational ZGC 与 non-generational ZGC 都不能用“两个 Survivor 区”解释；章节讲 Eden/Survivor时必须标 collector。

## 7. 大对象路径

大对象可能不进 TLAB；G1 中超过 region 一半的对象是 humongous，使用一个或多个连续 regions，从 old/humongous 视角管理。阈值取决于实际 region size，不背固定 512 KiB。

本机实验 `-Xmx64m` 显示 G1 region=1 MiB，1 MiB `byte[]` 触发 `G1 Humongous Allocation`；日志中 humongous regions `28->0`。这是该 heap/flags 证据，换 heap 可能 region size 变化。

Agent 中大 JSON byte[]、embedding float[]、PDF page image、tool stdout 一次 materialize 都可能 humongous。流式/分块的目标不只是避免 OOM，也减少连续 region 与回收压力。

## 8. 逃逸分析的三个边界

HotSpot C2 在编译图上分析对象引用是否：

- **NoEscape**：不离开编译单元/线程可见范围；
- **ArgEscape**：作为参数等局部传播，仍有限；
- **GlobalEscape**：返回、写 static/heap 可达字段、传未知调用等。

实际分类/算法是 HotSpot 实现且会变化。跨未内联调用、复杂控制流、接口多态、native/reflection 往往使分析保守。逃逸分析不是运行时追踪每个对象，也不自动证明业务线程安全。

## 9. 标量替换不等于传统栈上分配

若 Pair 不逃逸，编译器可把：

```java
Pair p = new Pair(x, x + 1);
return p.left + p.right;
```

变为标量计算 `x + (x+1)`；对象 header、字段存储和 allocation 都不存在。这是 **scalar replacement / allocation elimination**。说“对象放栈上”会误导为栈帧仍有连续 Pair 内存；实际字段可能在寄存器、常量或全被折叠。

有些 VM/编译器可能实现真实 stack allocation，但不是 Java/HotSpot 对所有 NoEscape 对象的承诺。

## 10. 实测：escape 改变 24 B/op

配套 [AllocationBenchmark.java](benchmarks/jmh/src/main/java/dev/deepjava/jmh/AllocationBenchmark.java)：

```powershell
cd benchmarks\jmh
mvn -q -DskipTests package
java -jar target\benchmarks.jar 'dev.deepjava.jmh.AllocationBenchmark.*' `
  -wi 2 -i 3 -f 1 -w 300ms -r 300ms -prof gc
```

2026-07-20 本机 quick evidence：

| benchmark | time | alloc |
|---|---:|---:|
| returning `Pair` (escapes) | ~2.320 ns/op | 24.000 B/op |
| construct + sum (candidate) | ~0.305 ns/op | ≈10^-5 B/op |

这支持“在该 JDK/flags/代码形态，candidate allocation 被消除”的主张。它不证明所有 `new Pair`、debug mode 或其他 JVM 都消除；quick 仅 1 fork/短迭代，不作为容量数字。24 bytes 与对象布局（12-byte header + 8-byte fields + alignment）一致，但 JOL/GC profiler 是互补证据。

## 11. 锁消除与锁粗化

若 synchronized receiver 被证明不逃逸，其他线程不可能竞争，JIT 可消除 monitor。连续对同对象反复加锁可能被粗化以减少 enter/exit，但扩大临界区也可能影响 safepoint/竞争，具体由编译器权衡。

不要因此删除源码同步：源码必须在未优化/解释器和所有合法调用下正确。JIT 优化是性能，不是正确性来源。

identity hash、wait/notify、对象逃逸会限制锁/对象消除。JOL/日志观察对象头也可能使 benchmark 行为改变。

## 12. 分配速率、存活率与 live set

三个指标回答不同问题：

- allocation rate：每秒新分配 bytes，决定 young GC 频率/带宽；
- survival/promotion rate：每次 GC 留下/晋升多少，决定复制与 old 增长；
- live set after GC：长期可达量，决定 minimum heap 与 old cycle。

Little-like 直觉：`live bytes ≈ allocation rate × average lifetime`（只作量纲思考，真实分布/GC 批处理更复杂）。10 GB/s 短命对象可能 heap 稳定但 CPU/GC 高；100 MB/s 长寿命 cache 可能缓慢 OOM。

## 13. 工具证据链

```text
JFR ObjectAllocationInNewTLAB/OutsideTLAB（采样/事件）
  → async-profiler -e alloc（分配栈权重）
  → JMH -prof gc（固定 micro path B/op）
  → GC log（Eden/Survivor/Old/humongous 效果）
  → heap dump（留下的对象，不等于流经的对象）
```

`PrintEscapeAnalysis/PrintEliminateAllocations` 在某些发行 build 是 nonproduct flag，不可移植。优先用 alloc/op 与生成代码验证结果；JIT 日志仍需固定 build。

## 14. 微型实验的陷阱

- 对象没返回/结果没消费，被 dead-code elimination；
- 输入是常量，整个计算折叠；
- benchmark 内自己计时，测到 timer/loop；
- 没 warmup/fork，混解释器/C1/C2；
- 用 `System.gc` 扰动每次操作；
- 两个版本在同 JVM 顺序跑，profile/heap 状态不对称；
- debug/agent/profiler 改变 EA/内联。

JMH 是控制框架，不会自动让错误 workload 有代表性。用 `-prof gc`、compiler profile、fork 和负对照确认。

## 15. Agent 与后端应用

- SSE 每 token 多层 event/map/string：高 rate、低 lifetime；批量 delta 或 compact event，保留实时延迟目标。
- RAG chunks/embeddings：大 arrays、高 live set；分页、primitive storage、mmap/vector store，并明确 ownership。
- ThreadLocal builder/pool：可能随线程池长期保留大 buffer；虚拟线程海量 ThreadLocal 也增加 heap。
- 对象池：减少 allocation 但增加老年代、清零、锁和泄漏；只对昂贵 native/大 buffer 且可测复用使用。
- cache：按 retained weight、TTL/tenant quota，不按 entry count。

## 16. 常见错误与排障

| 现象 | 推理 |
|---|---|
| Young GC 频繁、after-used 低 | allocation rate 高；找 alloc stack，不先加 old heap |
| old 快速增长 | survival/cache/queue；看 promotion/live roots |
| humongous GC 频繁 | region size 与大数组；流式/分块/压缩表示 |
| 源码有 new 但 profiler 0 B/op | EA/scalar/DCE；检查结果与机器码 |
| 小测试快、接入框架慢 | 跨调用未内联/对象逃逸/profile 多态 |
| TLAB waste 高 | 线程/对象 size 分布与 refill；不要盲调 TLAB flags |

## 17. 实验任务

1. 给 Pair 加 identityHash/返回/存数组，逐个观察 B/op，找到优化边界。
2. 用 `-XX:-DoEscapeAnalysis` 对照（目标 VM 支持），新 fork 运行并记录 flags。
3. 跑 `GcLogLab young/humongous`，从 region size 推导阈值而非硬编码。
4. 用 JFR/async-profiler 找一段 JSON/SSE allocation top stack，修改后同负载验收。
5. 构造 ThreadLocal 扩到 10 MiB 后只 clear content/`remove` 对照 retained heap。

## 18. 面试题与检查清单

**Q：Java 对象一定在堆吗？** 语义像对象；JIT 可标量替换而无真实 allocation。不能简单说全部在堆或都“栈上”。

**Q：TLAB 是线程私有对象区吗？** 只是私有分配区，对象发布后可跨线程访问。

**Q：如何证明 EA 消除了对象？** 同 fork/正确 benchmark 的 alloc/op≈0，加 compiler/机器码证据；源码/字节码不足。

- [ ] 区分语义对象、bytecode new、实际 allocation。
- [ ] 能解释 TLAB fast/slow path 与 zeroing。
- [ ] 不把 generational G1 布局套给所有 collector。
- [ ] 能区分 allocation/survival/live set。
- [ ] 所有“栈上分配”陈述改为准确优化结果。

## 19. 延伸阅读

- [JVM Guide: Garbage Collection](https://docs.oracle.com/en/java/javase/21/gctuning/)
- [JMH](https://github.com/openjdk/jmh)
- [JFR Runtime Guide](https://docs.oracle.com/en/java/javase/21/jfapi/)
- 目标 OpenJDK tag 的 C2 escape analysis 与 allocation 源码（按问题导航）

下一章：[10-garbage-collection.md](10-garbage-collection.md)
