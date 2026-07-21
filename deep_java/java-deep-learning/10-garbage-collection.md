# 10｜垃圾回收：可达性、屏障与 G1/ZGC 的延迟—吞吐—空间交换

> 优先级：S｜难度：★★★★★｜基线：HotSpot 21；版本差异单列｜前置：[07](07-jvm-runtime-areas.md)、[09](09-memory-allocation.md)

## 1. 本章目标

能从 GC roots 与对象图解释存活，比较标记/清除/复制/整理和分代；能解释 remembered set、card、SATB、写/读屏障与 STW；能读 G1 young/mixed/humongous/evacuation 日志，理解 ZGC 并发转移；能围绕 SLO 选 collector/heap，而不是看到 Full GC 就复制参数模板。

## 2. GC 的 correctness 问题：哪些对象仍可能被使用

HotSpot 从 roots 出发遍历引用图。典型 roots 包括：运行线程 frame 中精确引用、static fields、JNI handles、活动线程/VM 内部结构等。具体 root 集合和扫描实现属 VM/collector；语言层只保证不可再访问对象可被回收，未承诺回收时刻。

```text
GC Roots
  ├─ thread stack ─► request ─► buffer
  ├─ static cache ─► map ─► tenant graph
  ├─ JNI global ─► native-owned object
  └─ live thread ─► ThreadLocal ─► parser workspace

unreachable cycle A ◄──► B   // 无 root 路径，可回收
```

引用计数能快速判断 0，但更新每条引用有成本，循环非零仍垃圾，且并发计数复杂。现代 tracing collector 以 reachability 为核心；某些内部仍可用计数做 region/page 辅助，不能因此说“JVM完全不用引用计数”。

## 3. 四种基础算法

| 算法 | 核心 | 优点 | 代价/前提 |
|---|---|---|---|
| mark-sweep | 标 live，回收未标 | 不复制所有 live | fragmentation/free-list、扫描成本 |
| copying/evacuation | live 复制到目标区 | 分配连续、顺便整理 | 需要 to-space、复制与引用更新 |
| mark-compact | 标 live，移动压紧 | 消除碎片 | 移动/更新成本，常需停顿或复杂 barrier |
| regionized hybrid | 按 region 选 collection set | 增量回收、可预测工作量 | remembered set、预测与碎片元数据 |

“清除”不是把每个字节写 0；通常更新 free structures/region state。对象移动需修复 roots/fields 或通过 forwarding/barrier 让旧引用自愈。

## 4. 分代假说与跨代引用

弱分代假说：大多数新对象很快死亡；活得越久往往继续存活。把 young 高频、小范围收集与 old 低频、全局标记分开，可减少平均扫描。但 cache、in-memory DB、large graph 或批任务可能不符合，需实际 survival。

只收 young 不能扫描整个 old 找 old→young 引用，所以维护 remembered set。write barrier 在应用写引用时记录可能包含跨区/跨代指针的位置；card table 把 heap 划为粗粒度 cards，dirty card 表示需扫描，不精确到某一引用以节省空间。

```text
old object.field = young object
        │ post/write barrier
        ▼
dirty card / remembered-set update queue
        │ refinement + GC scan
        ▼
young GC 把 old→young 当额外 root
```

barrier 是编译器插入的 fast/slow path，不是操作系统内存屏障同义词；它可能同时承担 JMM ordering 和 GC bookkeeping 的不同责任。

## 5. 并行、并发与 STW

- **parallel GC work**：多个 GC threads 同时工作，应用通常停顿。
- **concurrent phase**：GC 与 mutator 同时工作，需要 barrier/重访保持正确。
- **STW**：到 safepoint 停所有 Java mutators；并不意味着 GC 只有一个线程。

并发 collector 仍有短暂停顿做 root processing/phase transition；STW collector 也可多线程。低 pause 通过 barrier、并发 CPU、额外 metadata/headroom 换取，不是免费。

目标三角：

```text
throughput（业务 CPU）
latency（pause + allocation stall + barrier）
footprint（heap/headroom/metadata）
```

优化一个常伤另两个。SLO 应含 p99/p999、throughput、container memory 与成本，不只 `MaxGCPauseMillis`。

## 6. 并发标记与 SATB

标记期间应用会改对象图。若 marker 已扫 A 后，mutator 把唯一指向白对象 X 的引用从未扫 B 移到已扫 A，朴素 marker 可能漏 X。三色抽象用 white/grey/black描述状态，barrier 维持 invariant。

G1 使用 Snapshot-At-The-Beginning：把并发标记开始时可达对象视为本轮 live。pre-write barrier 在覆盖旧引用前把旧值记录到 SATB buffer，避免 snapshot 对象漏标。期间变垃圾的对象可能浮动到下一轮才回收，换取较短 remark/并发性。

“SATB 是拍一份 heap copy”错误；它是逻辑 snapshot + barrier/mark queues。

## 7. 收集器定位

### Serial GC

`-XX:+UseSerialGC`，单 GC thread 的 generational STW collector，简单、metadata/线程开销低，适合小 heap、单核/小工具；大 heap pause 会长。

### Parallel GC

`-XX:+UseParallelGC`，以吞吐为目标，STW 阶段并行，适合 batch/CPU 足/可接受 pause。吞吐高不代表低 p99。

### CMS（历史）

Concurrent Mark Sweep 曾用并发 mark/sweep 降 old pause，但有 fragmentation、concurrent mode failure、复杂调参；JDK 9 deprecated、JDK 14 removed。`Concurrent Mode Failure` 只用于分析旧日志，不能当 JDK 21 当前 collector 事件。

### G1

JDK 21 多数配置默认。generational、regionized、incremental、parallel、mostly-concurrent、evacuating，以 pause goal 高概率预测 collection set。适合通用 server，但 pause goal 非硬 deadline。

### ZGC

并发 marking/relocation，使用 colored pointer metadata 与 load barriers（generational 还用 store barriers），目标极低 pause，代价为 barrier/并发 CPU/heap headroom。JDK 21 `-XX:+UseZGC` 是 non-generational；Generational ZGC 需再加 `-XX:+ZGenerational`（JEP 439）。JDK 23 generational 成为默认，JDK 24 移除 non-generational（JEP 490）。所以旧启动参数在新 JDK 可 obsolete。

### Shenandoah

并发 compacting collector，用 forwarding/reference barriers 实现并发 evacuation，availability/支持随发行版。JDK 25 加 Generational Shenandoah（JEP 521）；不能把它写成 JDK 21 所有 vendor 默认可用。

### Epsilon

`-XX:+UseEpsilonGC` 只分配不回收，用于性能基线、短命程序或验证内存上限；heap 满即 OOM，绝非生产通用 collector。

## 8. G1 heap 与 Region

heap 被等大小 regions 划分，动态承担 Eden/Survivor/Old/Humongous。region size 由 heap ergonomics 选择（可受参数影响），不是固定 1 MiB。

### Humongous

对象大于 region capacity 的一半视为 humongous，占连续 whole regions，通常从 old/humongous 角度分配。G1 可在标记/young pause eager reclaim 死 humongous，但一般不在普通 evacuation 中移动，连续 region 压力可能提前启动 concurrent cycle/Full GC。

本机 64 MiB heap region=1 MiB，1 MiB `byte[]` 实际触发 `G1 Humongous Allocation`；详见第 09 章。

## 9. G1 cycle

简化时序：

```text
Young-only phase: repeated Young GC
   │ old occupancy / adaptive IHOP predicts mark start
   ▼
Concurrent Start Young pause（piggyback initial mark）
   ▼
Concurrent Mark → Remark(STW) → Cleanup(STW/transition)
   ▼
Space-reclamation phase: Mixed GCs
   │ CSet = young regions + selected profitable old regions
   └─ 回到 Young-only
```

### Collection Set

每次 pause 选择要 evacuation 的 regions。G1用历史 copy/scan/cost 预测在 `MaxGCPauseMillis` goal 内可做多少工作；实际对象图、RSet、OS 调度可超目标，它不是实时系统保证。

### Remembered Set

每 region 逻辑上维护指向它的外部引用近似位置，card 默认粒度在目标实现文档可查。写 barrier 把 dirty card 入队，concurrent refinement 更新 RSet；来不及的工作在 pause update/scan，造成 pause 增长。高跨 region mutation 会用 CPU/metadata。

### IHOP

Initiating Heap Occupancy 决定何时开始 concurrent mark。JDK 21 G1 默认 adaptive IHOP 根据 marking 时长和 old allocation 预测，保留 evacuation reserve。手工固定过晚会来不及回收，过早浪费并发 CPU；先看 adaptive prediction/old rate。

### Evacuation Failure

to-space/headroom 不足时部分对象无法复制，G1保留就地对象并修引用，成本增加；若紧张持续会 Full GC in-place compact，长 pause。解决要看 live set、promotion、humongous、heap reserve/容器，而非只改 pause goal。

## 10. ZGC 的低延迟思路

ZGC 把大部分 mark、reference processing、relocation 并发执行。colored pointers 在引用元数据位编码 mark/remap 等状态，load barrier 在读取引用时检测/修正 stale address；并发 relocation 可让应用继续运行。

Generational ZGC 增加 young/old 独立收集和 store barrier/remembered set，把部分 marking 责任从频繁 load barrier 移到 store barrier。JEP 描述的是设计与目标，实际 throughput/heap 仍按 workload 测。

低 STW 不等于无延迟：allocation stall、CPU contention、memory pressure、page fault、barrier 和外部 I/O 都能抬尾延迟。ZGC 需要足够 headroom 在应用继续分配时并发回收/relocate。

## 11. GC 日志实验

配套 [GcLogLab.java](examples/jvm/GcLogLab.java)：

```powershell
.\labs\compile-and-inspect.ps1
java -Xms64m -Xmx64m -XX:+UseG1GC `
  "-Xlog:gc*,gc+heap=debug:file=build/gc-young.log:time,uptime,level,tags" `
  -cp build\classes dev.deepjava.jvm.GcLogLab young
```

本机部分结果：

```text
GC(0) Pause Young (Normal) (G1 Evacuation Pause) 23M->1M(64M) 4.948ms
Eden regions: 23->0(33); Survivor: 0->1(3); Old: 0->0
GC(1) ... 34M->1M(64M) 1.653ms
```

含义：短命分配填 Eden；CSet evacuation 后 used 显著下降，少量对象进 Survivor，没有 old 增长。第一 pause 较长不能仅归因“JVM冷”，需分 phase/OS/JIT 再验证。

humongous 模式实测：region 1M、`Humongous regions: 28->0`、多次 `Pause Young (Concurrent Start) (G1 Humongous Allocation)`。样例是故意极端 allocation，不代表 1 MiB 数组在所有 heap 都同阈值。

## 12. 读日志的顺序

```text
collector/heap/CPU/container limits
 → event type/cause/timestamp
 → before→after / live set / reclaimed
 → pause phases与最大项
 → allocation/promotion/humongous/RSet
 → concurrent cycle 是否追得上
 → application latency/throughput 同时间线
```

只看总 pause 会漏 safepoint-to-reach、allocation stall 与 concurrent CPU；只看 GC percent 会漏单次 p999。统一日志 tag 随 JDK 演进，解析器要固定版本并保留原文。

## 13. 目标驱动选型与调优

1. 写 SLO：throughput、p99/p999、heap/RSS、容器成本、启动。
2. 固定真实 workload，记录 allocation/live set/对象寿命/峰值并发。
3. 先用 ergonomic baseline（JDK 21 G1）；只改一个变量。
4. 若 pause 不满足且 CPU/headroom 足，比较 Generational ZGC；batch 比较 Parallel。
5. 修代码/容量根因：无界 cache/queue、大数组、promotion、RSet mutation。
6. 才调 collector-specific flags；同负载多轮，含失败恢复。

`-XX:MaxGCPauseMillis` 是目标，不是上限；把它极小会缩 young、提高 GC 频率/CPU，反而吞吐差。不要同时改 10 个 flags 后无法归因。

## 14. 容器环境

JVM 会感知 cgroup 的 CPU/memory（版本/配置需验证），ergonomics 选择 heap/GC threads。容器 limit 不只给 heap：必须留 metaspace、thread stacks、direct、code cache、native、file cache 余量。

CPU quota 小但 host cores 多时，并发 GC thread 选择/调度可能影响业务；打印 `-Xlog:gc+init`/ActiveProcessorCount。kernel OOM kill 无 Java OOM/log尾，读 cgroup `memory.events` 和 orchestrator status。

## 15. Agent workload 的 GC 形状

- streaming deltas：高短命 allocation，young frequency/CPU；
- conversation/checkpoint/cache：长 live set 与 old cycle；
- document chunks/vector arrays：大对象/humongous 与 direct/mmap；
- parallel tools：瞬时峰值、buffer 与 cancellation 后滞留；
- long Agent run：对象跨多次 GC 晋升，即使逻辑“临时”。

用 per-run byte/event budget、流式上限、tenant cache weight 和 cancel cleanup 改形状。GC 调参不能让无界输入有界。

## 16. 常见错误与排障

| 现象 | 先验证 | 典型方向 |
|---|---|---|
| Young GC 高频 | allocation rate、after-used | 分配热点/young sizing；非先加 old |
| Mixed GC 频繁 | old allocation/live、mark cycle | cache/lifetime/IHOP/headroom |
| Full GC | cause、evac failure、metadata/system GC | live set/碎片/humongous/to-space |
| GC CPU 高 | alloc + barrier/RSet + concurrent | mutation/heap/collector/CPU quota |
| pause 长 | phase breakdown、roots/RSet/copy | thread roots、cards、live copy、OS |
| heap after GC 不降 | retained graph | heap dump/JFR old object；非只调 flag |

分析链必须是“现象→指标→GC log→allocation/live objects→代码路径→同负载验收”。

## 17. 面试题与检查清单

**Q：并发 GC 为什么还 STW？** phase transition/root/remark 等仍需全局一致点；大部分重工作并发不代表零 pause。

**Q：G1 为什么需要 RSet？** 收部分 regions 时不扫描全 heap，记录外部指入 CSet 的近似位置作为额外 roots。

**Q：SATB 做了 heap 快照吗？** 逻辑 snapshot；pre-write barrier 记录被覆盖旧引用，期间新死对象可能 floating garbage。

**Q：ZGC 为何低 pause？** concurrent mark/relocate + colored pointer/load barriers；用 CPU、barrier、metadata/headroom 换，仍有 stall/短 pause。

- [ ] 区分 roots/reachability 与引用计数。
- [ ] 能解释 card/RSet/write barrier/SATB。
- [ ] 不混淆 parallel/concurrent/STW。
- [ ] 能画 G1 young→mark→mixed cycle。
- [ ] ZGC 参数/模式按 JDK 21/23/24 标版本。
- [ ] 调优从 SLO/代码证据开始，不从 flag 列表开始。

## 18. 延伸阅读

- [JDK 21 GC Tuning Guide](https://docs.oracle.com/en/java/javase/21/gctuning/)
- [G1 Collector](https://docs.oracle.com/en/java/javase/21/gctuning/garbage-first-g1-garbage-collector1.html)
- [JEP 439: Generational ZGC](https://openjdk.org/jeps/439)
- [JEP 490: Remove Non-Generational ZGC](https://openjdk.org/jeps/490)
- [JEP 521: Generational Shenandoah](https://openjdk.org/jeps/521)

下一章：[11-interpreter-and-jit.md](11-interpreter-and-jit.md)
