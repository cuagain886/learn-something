# 07｜JVM 运行时数据区：Heap、Native、RSS 和容器内存的对账

> 优先级：S｜难度：★★★★★｜基线：JVMS/HotSpot 21｜前置：[05](05-class-file-and-bytecode.md)、[06](06-class-loading.md)

## 1. 本章目标

能把 JVMS 抽象区、HotSpot 内存类别、操作系统虚拟内存和容器统计对应起来；能为 StackOverflow、heap/metaspace/direct/native-thread OOM 选择正确证据；不再用“调大 `-Xmx`”处理所有内存问题。

## 2. 三张地图不能叠成一张

```text
JVMS 抽象                 HotSpot 21 常见实现                 OS/容器观察
────────────────         ─────────────────────────         ───────────────
Heap                  →  G1/ZGC heap regions              → virtual mappings/RSS
Method Area           →  Metaspace + class metadata       → native committed pages
Runtime Constant Pool →  per-class metadata structures    → native memory category
JVM Stack             →  platform-thread native stack     → reserved/committed mapping
Native Method Stack   →  与本地线程栈/ABI 集成             → thread mapping
PC Register           →  interpreter/JIT execution state  → CPU register/context
（规范外扩展）          Code Cache, GC structures, symbols → native mappings/RSS
Direct buffer         →  malloc/mmap + Cleaner            → native pages/RSS
```

JVMS 允许实现自由，例如 frame 甚至可以 heap allocate；“方法区”是规范概念，HotSpot 8+ 用 native Metaspace 承载类元数据，不能继续说“方法区就是 PermGen”。

## 3. 线程私有区

### 3.1 PC register

每个执行 Java 方法的线程有自己的 PC 概念，指向当前 JVM 指令；执行 native 方法时值可为 undefined。它不是业务可直接读取的计数器，也不是操作系统进程 PC 的固定 Java 对象。

### 3.2 JVM stack 与 frame

每次调用创建 frame，至少承载局部变量、操作数栈、当前类运行时常量池的动态链接信息，以及正常/异常返回状态。调用链深度、每帧需要的空间、`-Xss` 与 native guard pages 共同决定何时 `StackOverflowError`。

```text
thread JVM stack
┌─────────────────────────┐
│ frame C: locals | ops   │ ← current
├─────────────────────────┤
│ frame B: locals | ops   │
├─────────────────────────┤
│ frame A: locals | ops   │
└─────────────────────────┘
```

局部变量表 slot 是 JVMS 逻辑单位，不等于固定 4 字节 native stack cell。JIT 内联后，多个源方法可能合入一个 compiled frame，但 deoptimization metadata 允许重建解释状态和可理解的 stack trace。

### 3.3 native method stack

JNI/native 调用遵守目标 ABI 并消耗 native stack。JVMS 将其作为概念区，HotSpot 具体实现可与线程 native stack 结合。native recursion、巨大栈对象或 JNI bug 可能导致进程崩溃，而不总是优雅抛 Java `StackOverflowError`。

### 平台线程与虚拟线程

平台线程通常一一对应 OS thread 并预留 native stack；线程多会先耗地址空间、committed stack、内核线程资源或 cgroup pids。虚拟线程的 Java stack 以可伸缩 stack chunks 表示并可在 heap 中存活，降低“每并发一个大 native stack”成本，但 carrier、native 调用、pinning、heap 和下游资源仍有限。

## 4. 线程共享区

### 4.1 Java heap

heap 存放绝大多数普通对象/数组，是 GC 管理区。`-Xms/-Xmx` 约束 heap 的初始/最大目标，不约束 metaspace、thread stack、code cache、direct buffer、JNI 或 libc。对象可能被 JIT 标量替换而没有真实 heap allocation；语义上仍像对象。

“heap used”是当前已占对象/collector 数据量，“committed”是 JVM 已向 OS 承诺可用的 heap 范围，“reserved”是地址空间上限。GC 后 used 降低，不保证 JVM 立即 uncommit 页面，也不保证 RSS 同比例下降。

### 4.2 Method Area 与 Metaspace

Method Area 逻辑上保存 per-class 结构、运行时常量池、方法/字段数据和代码等；HotSpot 把类元数据主要放 native Metaspace，按 class-loader arena/chunk 管理。Class unloading 的回收粒度与 defining loader 生命周期相关：一个 loader 被线程/缓存保留，它定义的全部类元数据可能一起留下。

`CompressedClassSpaceSize` 与普通 metaspace 不应混为一项。JDK/参数不同，NMT 分类会变化，以当前输出为准。

### 4.3 Runtime Constant Pool

每个 Class/Interface 有运行时常量池，由 Class 文件 `constant_pool` 构造并参与动态链接。它不是 String intern table；一个是类的符号/字面量运行结构，一个是 canonical String 机制。

### 4.4 Code Cache

HotSpot 把 JIT 生成的 nmethod、runtime stub 等放 code heap/cache。分层编译常把 cache 分段。耗尽时编译可能被禁用、性能退化并出现告警，不一定抛 Java heap OOM。用 `jcmd <pid> Compiler.codecache`、JFR 和编译日志判断，不以 `-Xmx` 处理。

## 5. 规范外但生产关键的 native memory

### DirectByteBuffer

`ByteBuffer.allocateDirect` 的 payload 位于 heap 外，Java heap 中只有 wrapper/cleaner/attachment 等对象。优点是减少某些 I/O 路径复制；代价是分配/释放昂贵、受 GC reachability 和 cleaner 调度影响、heap dump 看不到 payload 全貌。`-XX:MaxDirectMemorySize` 限额与具体 JDK 默认推导需查目标版本。

### GC、JIT、symbol、JNI 与 libc

collector remembered set/mark bitmap、compiler arena、symbol/string table、JNI global ref、zip/native library、线程 TLS、malloc arena 都可能贡献 RSS。NMT 能覆盖 HotSpot 自己跟踪的大类，但不是完整 OS 内存审计，第三方 native library 与某些 mmap 仍需 OS 工具。

## 6. OS 虚拟内存：reserved、committed、RSS

```text
virtual address reserved  ≥  OS committed / backed  ≥?  current resident RSS
```

严格关系依 OS 语义而异，不能用一个不等号代替工具定义。核心区别：

- **virtual size/address space**：地址范围，可能尚无物理页；
- **committed**：JVM/NMT 或 OS 承诺的可用范围，定义因工具而异；
- **RSS/working set**：当前驻留物理页，可能含 shared pages；
- **container memory.current**：cgroup 记账，可能含 anonymous/file cache 等；
- **heap committed/used**：只是进程内一个子系统。

因此 `Xmx=2g` 的 JVM RSS 可超过 2 GiB；GC 后 heap used 降到 500 MiB，RSS 仍高也不自动等于 leak。要对账 heap、NMT、thread count/direct buffer、mapped file 与 cgroup 指标。

## 7. 六类失败实验与安全边界

配套 [FailureLab.java](examples/jvm/FailureLab.java) 默认拒绝“无参数运行”，native-thread 模式还需显式系统属性。先由脚本编译，再在**独立测试进程**执行。

### 7.1 StackOverflowError

```powershell
java -Xss256k -cp build\classes dev.deepjava.jvm.FailureLab stack
```

保留最后数十帧与递归深度。修复应找缺失终止条件/递归数据深度；调大 `-Xss` 只在算法确实有界且容量已核算时使用，它还会降低可创建平台线程数量。

### 7.2 Java heap OOM

```powershell
java -Xms32m -Xmx32m -XX:+HeapDumpOnOutOfMemoryError `
  -cp build\classes dev.deepjava.jvm.FailureLab heap
```

样例强引用 1 MiB 数组，预期 `OutOfMemoryError: Java heap space`。分析 retained size、dominator、GC 后 live set 与分配路径；heap dump 本身需要磁盘，生产应设置安全路径和访问控制。

### 7.3 Metaspace OOM

```powershell
java -XX:MaxMetaspaceSize=32m -Xmx128m -Xlog:class+load=info `
  -cp build\classes dev.deepjava.jvm.FailureLab metaspace
```

样例持续创建 loader 与 proxy class 并保留 loader。真正系统常见原因是热部署 loader 泄漏或无限动态类生成。对比 class loader statistics、class histogram、NMT，而不是增大 heap。

### 7.4 Direct buffer OOM

```powershell
java -Xmx128m -XX:MaxDirectMemorySize=32m `
  -cp build\classes dev.deepjava.jvm.FailureLab direct
```

预期 `Cannot reserve ... bytes of direct buffer memory` 一类消息。查看 NMT、direct buffer pool/JMX、分配栈和 wrapper reachability。手动 `System.gc()` 只是诊断扰动，不是可靠资源管理方案。

### 7.5 Unable to create native thread

**禁止直接在桌面主机运行。** 在有 pids、内存和 wall-clock 限制的容器/VM 内执行，并保留外部 kill：

```text
java -Xmx128m -Xss256k -Ddeepjava.allowNativeThreadExhaustion=true \
  -cp build/classes dev.deepjava.jvm.FailureLab native-thread
```

失败可能来自 pids limit、用户进程限额、地址空间、native memory，而非 heap。先查线程数、`-Xss`、容器 pids、OS limit 与虚拟线程替代；不要只加 `-Xmx`。

### 7.6 GC overhead limit exceeded

这是特定 collector/策略在“几乎全部时间 GC、回收极少”时的保护性 OOM，并非所有 GC/JDK 都稳定复现。构造大量仍可达的小对象加少量 churn 也受 heuristic 影响。实验必须记录 collector/flags，不能把没复现当机制不存在。诊断仍回到 GC log 的时间比例、回收量和 live set。

## 8. 诊断工具矩阵

启动时启用 NMT 才能获得细分：

```powershell
java -XX:NativeMemoryTracking=summary -Xlog:os+memory=info ...
jcmd <pid> VM.native_memory baseline
jcmd <pid> VM.native_memory summary.diff
```

| 问题 | 第一证据 | 第二证据 | 不能推出 |
|---|---|---|---|
| heap live set 高 | GC after-used、heap dump | JFR allocation/old object sample | RSS 都来自 heap |
| metaspace 增长 | `VM.metaspace`、loader stats | class unload log、heap 中 loader roots | 加 Xmx 会修复 |
| native 高 | NMT diff | OS mappings/RSS、库级指标 | NMT 能解释所有第三方 malloc |
| thread 高 | thread count/dump | OS threads、pids、stack reservation | 所有 WAITING 线程都“没成本” |
| direct 高 | BufferPool/JFR/NMT | wrapper roots、I/O 路径 | heap dump retained size含 payload |
| code cache 满 | `Compiler.codecache` | compilation log/JFR | heap GC 能回收全部代码 |

其他常用：`jcmd GC.heap_info`、`GC.class_histogram`、`Thread.print`、JFR、`jstat -gcutil`；Linux 再对照 `/proc/<pid>/smaps_rollup`、`pmap -x`、cgroup `memory.current/events`。`jmap -histo:live` 可能触发昂贵操作，生产先评估影响。

## 9. 后端与 Agent 的内存模型

一个 Agent 请求可能同时占：prompt/JSON 的 heap、SSE/Netty direct buffer、虚拟线程 stack chunk、TLS/native buffer、动态 Tool class 的 metaspace、JIT code cache、向量 mmap/file cache。只按 token 数估 `-Xmx` 会漏掉至少五类资源。

设计有界性：

- 输入文档按 byte/页流式解析，chunk 队列有界；
- 模型 delta、tool stdout/stderr 与事件 replay 分别设 buffer 上限；
- embedding 并发由 semaphore 限制，不随文档数创建无限任务；
- 插件/脚本运行在可回收 loader 或独立进程，禁止全局 cache 留引用；
- 记录 heap allocation rate、direct pool、thread/virtual thread、metaspace、RSS 与 cgroup OOM kill。

容器被 kernel OOM kill 可能来不及生成 Java heap dump；必须从 `memory.events`、pod status 和节点日志确认，而不是等待 Java OOM stack trace。

## 10. 性能权衡

- 大 heap 降低收集频率但扩大扫描/转移工作与容器成本，低延迟 collector 也不是零成本。
- 小 `-Xss` 允许更多平台线程，却缩短递归/深调用余量；框架深栈要压测。
- direct buffer 适合 I/O 复用，不适合无池化的小对象滥用；池化又引入生命周期与泄漏风险。
- metaspace 无上限可拖到容器 kill，有上限可更早失败；上限值需覆盖正常 class growth 和故障余量。
- RSS 不回落不一定影响服务，真正目标应是容器预算、缺页、swap、延迟与 kill 风险。

## 11. 常见错误

1. **JVM 内存=Java heap**：漏掉 thread/direct/metaspace/code/native。
2. **方法区=PermGen**：把历史 HotSpot 实现当当前规范。
3. **GC 后 RSS 不降=泄漏**：可能是 committed heap、allocator、file cache；需对账。
4. **heap dump 能看全部内存**：不含 direct payload/第三方 native 全貌。
5. **OOM 可 catch 后继续服务**：进程可能处于资源枯竭/不变量破坏状态，通常应保留证据并受控重启。
6. **虚拟线程没有栈成本**：stack chunks 在 heap 中增长，carrier/native/ThreadLocal 仍有成本。

## 12. 面试题与检查清单

**Q：JVM 运行时区哪些线程私有？** 规范上的 pc、JVM stack、native method stack 与线程相关；heap/method area 共享。具体分配由实现决定。

**Q：Xmx 1G 为什么 RSS 2G？** Xmx 只限制 heap 最大；metaspace、code cache、thread stack、direct、GC/JIT/JNI/native、映射文件等另计。

**Q：GC 后 heap 降、RSS 不降怎么查？** 对照 heap committed/used、NMT diff、direct/thread/mapping、cgroup；先确认是否真的超预算或只是页面未归还。

- [ ] 能区分 JVMS area、HotSpot category、OS RSS 与 container 记账。
- [ ] 能为六类失败选择隔离参数和证据。
- [ ] 知道 NMT 必须启动时启用且覆盖有限。
- [ ] 不在无 pids 限制的主机制造线程耗尽。
- [ ] 能给 Agent 各缓冲/并发资源设上限。

## 13. 延伸阅读

- [JVMS 2.5：Run-Time Data Areas](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-2.html#jvms-2.5)
- [JVMS 2.6：Frames](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-2.html#jvms-2.6)
- [Java 21 Troubleshooting Guide](https://docs.oracle.com/en/java/javase/21/troubleshoot/)
- [Native Memory Tracking](https://docs.oracle.com/en/java/javase/21/vm/native-memory-tracking.html)

下一章：[08-object-layout.md](08-object-layout.md)
