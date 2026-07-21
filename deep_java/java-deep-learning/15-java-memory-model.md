# 15｜Java 内存模型：从允许执行到 volatile、final 与安全发布

> 优先级：S｜难度：★★★★★｜基线：JLS 21 §17.4/17.5、HotSpot 21｜前置：[02](02-type-system-and-core-syntax.md)、[05](05-class-file-and-bytecode.md)

## 1. 本章目标

能从 actions、program order、synchronization order 和 happens-before 推导并发程序允许的结果；能区分原子性、可见性、有序性；能解释 `volatile` 的 release/acquire 与非原子复合操作、`final` freeze 与 `this` 逃逸；能用 JCStress 做统计验证且不把“没观测到”当证明。

## 2. JMM 解决的是“哪些观察合法”

单线程编译器和 CPU 都希望重排、寄存器缓存、乱序执行；多处理器还有 store buffer、cache coherence 与不同内存模型。JMM 在源语言与所有实现之间定义可观察行为：只要执行满足规则，实现可自由优化。

常见“每个线程从主内存复制变量到工作内存”的图只是教学抽象，不能映射成“每线程有一份 heap”或固定 CPU cache。规范分析应使用 action/order，不用硬件名替代语义。

```text
Java program actions + synchronization
        │ JMM constraints: allowed executions
        ▼
compiler IR reordering / optimization
        ▼
HotSpot barriers and machine instructions
        ▼
CPU memory model / cache coherence / store buffers
```

上层约束下层结果；从 x86 某次行为不能反推没同步的数据竞争程序跨平台正确。

## 3. 执行模型的最小词汇

一个 inter-thread action 可包括 ordinary read/write、volatile read/write、lock/unlock、线程 start/join 检测、外部动作等。每个 action 有线程、变量和值等属性。

- **program order**：每个线程中符合 intra-thread semantics 的 action 顺序。
- **synchronization order**：所有 synchronization actions 的单一全序，并与每线程 program order 一致。
- **synchronizes-with (sw)**：特定同步 action 间的边，如对同一 volatile 的 write → 观察它的 read、unlock → 后续 lock、start → 新线程首 action。
- **happens-before (hb)**：program order 与 sw 的传递闭包。

`A hb→ B` 的核心用途是约束 B 的可见写和顺序；它不是 wall-clock “先发生”，也不是说 CPU 真的在两行之间执行一个全局 flush。

JMM 还要求 well-formed execution、happens-before consistency、synchronization-order consistency 和 causality 等，阻止凭空值（out-of-thin-air）一类不合法推断。工程中先掌握 hb，再读完整形式定义，避免把“有数据竞争时什么都可能”说得过头：JMM 仍有类型安全、每次读取必须看到某个允许写等约束。

## 4. 三个性质不是三种关键字

### 原子性

一次 action 不被观察为一半。单个普通 reference/int 读写具相应原子性；`i++` 是 read-modify-write 三步，不是原子复合操作。JLS 仍允许某些实现把非 volatile `long/double` 当两个 32-bit 写处理（word tearing 特例），主流现代 64-bit HotSpot 通常不会这样，但跨实现正确代码不能依赖偶然性；声明 volatile 或同步。

### 可见性

一个线程的 write 是否允许被另一个 read 观察。时间过去、调用 `sleep`、线程“跑得久”都不建立 hb。没有同步时，reader 可持续使用优化后的值或读到旧写。

### 有序性

其他线程观察到的顺序受 hb 约束。编译器/CPU 可在不改变单线程语义且不违反 JMM 的前提下重排。不要把源码行序直接当跨线程全序。

互斥常同时提供三者，但 `volatile` 只适合特定状态协议；原子类对某个 read-modify-write 原子，不自动保护多个字段不变量。

## 5. happens-before 规则及推导

常用规则：

1. 每个线程中，前 action hb 后 action（program order）。
2. monitor unlock sw 后续对同一 monitor 的 lock。
3. volatile write sw 后续观察该写的同变量 volatile read。
4. `Thread.start()` hb 被启动线程中的 action。
5. 线程中所有 action hb 另一个线程成功检测其终止（`join` 等）。
6. 对象 finalization 相关规则（不作为新资源设计）。
7. hb 具有传递性。

### 消息发布推导

```java
int payload;                 // ordinary
volatile boolean ready;

// writer                    // reader
payload = 42;                while (!ready) { }
ready = true;                use(payload);
```

若 reader 的 volatile read 看到 writer 的 `ready=true`：

```text
payload write
  hb(program order)
ready volatile write
  sw
ready volatile read
  hb(program order)
payload read
```

由传递性，payload write hb payload read，所以 reader 必须看到 42 或一个 hb 更晚的合法写。注意：如果 reader 先看到 `ready=false`，规则并不承诺 payload 已发布。

## 6. volatile 的精确能力

对同一 volatile 变量，写具有 release 效果，读具有 acquire 效果，并参与 synchronization order。它适合状态标志、不可变 snapshot 引用、单写多读版本等。

```java
volatile int count;
count++; // volatile read + add + volatile write；两个线程仍会丢更新
```

要保护复合不变量，使用 lock、CAS loop、原子类或单线程 owner。`volatile List<Task>` 只保证 list 引用的发布/替换；对普通 `ArrayList` 的并发 mutation 仍不安全。

### 双重检查锁（DCL）

```java
private static volatile Service instance;

static Service get() {
    Service local = instance;
    if (local == null) {
        synchronized (Owner.class) {
            local = instance;
            if (local == null) {
                local = new Service();
                instance = local;
            }
        }
    }
    return local;
}
```

volatile 阻止其他线程观察到引用已发布但构造写尚不可见的状态。更简单时优先 static holder/enum/容器生命周期；DCL 的正确性不代表每个 lazy cache 都需要复制模板。

## 7. 字节码看不到专属 `volatile` opcode

字段在 Class file 带 `ACC_VOLATILE`，访问仍用 `getfield/putfield/getstatic/putstatic`。解释器/JIT 根据 field metadata 生成对应 memory ordering。用 `javap` 只能证明字段 flag 与访问指令，不能证明 x86/ARM 的具体 fence。

机器层验证需要固定：HotSpot build、编译层级、架构、flags，并看 Ideal/assembly（JITWatch、PrintAssembly/perfasm 等）。x86 TSO 和 AArch64 较弱模型所需指令不同，但 Java 结果都必须满足 JMM。

## 8. synchronized：互斥之外还有内存语义

`monitorenter/monitorexit` 或 `ACC_SYNCHRONIZED` 提供 monitor 互斥；unlock sw 随后的同 monitor lock，因此临界区内前序普通 writes 对下一持锁者可见。

错误示例：writer 用 `synchronized(lockA)`，reader 用 `synchronized(lockB)`，两者互不建立 sw。另一个常见错误是锁对象可变：`synchronized(currentKey)` 后替换 key，线程实际锁不同对象。

`wait` 必须在持有 monitor 时调用，并原子释放 monitor 后等待；返回前重新获得。由于 spurious wakeup/其他条件变化，要用 while 重查 predicate。`notify` 只是从 wait set 选择等待者参与竞争，不把锁立即交出。

## 9. final 字段语义与构造安全

构造器正常结束前对 final fields 的写与对象引用第一次被外界读取之间有特殊 freeze 语义；正确构造且不泄露 `this` 的对象，其 final 字段能获得更强初始化可见性，包括通过 final 引用可达对象的相关保证边界。

危险：

```java
final class Listener {
    final int config;
    Listener(EventBus bus) {
        bus.register(this); // this escape；其他线程可能在 config 写前回调
        config = 42;
    }
}
```

构造期间启动线程、注册回调、写入 static/共享集合、让可覆盖方法调用到子类都可能泄露 `this`。final 不让对象深不可变：`final List` 仍可 mutation。应先在私有上下文完整构造，再通过安全机制发布。

## 10. 安全发布方式

可用路径：

- static initialization 完成后使用；
- 写入 volatile field，reader 通过同一 volatile 读取；
- 在同一 monitor/Lock 的释放—获取间传递；
- 线程 start 前设置，在线程内读取；线程完成后 join 再读取；
- 通过规范有并发保证的 concurrent collection/queue/future 传递；
- 正确构造的 immutable 对象配合 final 语义（仍避免 `this` 逃逸）。

普通 `HashMap.put` 后另一线程普通 `get`、构造后赋给普通 static、`sleep` 等不构成安全发布。

## 11. 数据竞争、DRF-SC 与“顺序一致”

两个 conflicting accesses（同一变量，至少一个写）若未按 hb 排序，存在 data race。正确同步、data-race-free 程序可按 sequentially consistent 的直觉理解：所有 action 像某个保持各线程 program order 的单一交错。

存在 race 时，不是立刻“随机内存损坏”，而是允许更多 JMM 执行，优化也不再为程序员维持 SC 直觉。race detector/JCStress 发现的是某些证据；代码审查应先建立共享变量、owner 与同步边。

## 12. JCStress：先写允许结果，再运行

本仓库两项测试位于 `benchmarks/jcstress`：

```powershell
cd benchmarks\jcstress
mvn -q -DskipTests package
java -jar target\jcstress.jar -m quick -c 2 -f 1 -iters 2 -time 200 `
  -t 'dev\.deepjava\.jcstress\.(PlainReorderingTest|VolatilePublicationTest)'
```

2026-07-20、HotSpot 21.0.8、Windows x64、2 CPUs quick run 的实际结果：

- `PlainReorderingTest` 总计约 1.9968 亿样本；`0,0` 约 5976 万（29.93%），其他 0/1 组合也出现，无 forbidden。
- `VolatilePublicationTest` 所有配置通过；只出现 reader 先读的 `-1` 或正确发布的 `42`，未出现 forbidden `0`。

关键解释：

1. plain test 的 `0,0` 是 JMM 允许结果，但**单凭该结果不能证明发生 CPU/编译器重排**；两次 read 各自早于对方 write 的合法交错也能产生 0,0。
2. volatile test 未看到 0 与理论一致，但有限样本“未出现 forbidden”不是数学证明；证明来自 JMM 推导，stress 用于发现实现/测试/代码错误。
3. JCStress 0.16 在 JDK 21 探测历史 `UseBiasedLocking` 参数时报告 N/A，这是非致命版本兼容探测，不应误判测试失败。
4. Windows 无 `taskset`，affinity 降级为 NONE；结果不能直接和 Linux 固定 affinity 频率比较。

## 13. 为什么普通单元测试和 sleep 不够

并发结果受 JIT 层级、内存布局、CPU 拓扑和时序影响。JUnit 中循环一万次没失败，只说明那次环境没有击中。JCStress 提供 actor/arbiter、结果分类、多 fork/JIT 配置和 harness，仍需要正确 outcome model。

错误 stress test 常见：

- 用 latch/barrier 放在被测访问之间，无意建立 hb；
- 用 println/volatile counter 观测，改变同步；
- 把所有未出现结果标 FORBIDDEN，却未做 JMM 推导；
- 只跑解释器或单核；
- 按出现频率宣称某结果“保证概率”。

## 14. CPU/编译器视角：建立桥，不越界

compiler reordering 可移动普通 load/store、消除循环读、合并写，只要单线程和 JMM 合法；CPU store buffer 让本核写先排队，cache coherence 保证某种一致传播但不自动提供高级语言所需 ordering。HotSpot 在 volatile/monitor/VarHandle access mode 处插入/利用 barrier，映射到不同 ISA。

不要使用“volatile 每次都强制从主内存读”“写完立刻刷新所有 CPU cache”作为精确定义。正确表述是 JMM 建立 sw/hb，具体实现用编译器 barrier 与目标 CPU 指令满足语义。

false sharing 是物理 cache line 级性能问题，不是 JMM 正确性问题；`@Contended` 是内部/受限机制并增加空间，先用 perf/JFR/基准证明竞争。

## 15. Agent 与后端并发

### Agent 状态发布

将 mutable `AgentState` 的多个字段逐个写后设置 volatile version，reader 只有在读到对应 version 后才可使用前序字段；更稳妥是构造 immutable snapshot 后以 `AtomicReference` 单次发布。状态机转移需 CAS(version,state)，避免两个 worker 同时从 RUNNING 写 COMPLETED/FAILED。

### 取消

`volatile boolean cancelled` 可发布标志，但不能唤醒不轮询的阻塞 I/O；`Thread.interrupt`/Future cancel/HTTP client cancel/子进程终止需要分别协作。中断标志本身有库语义，不要捕获 `InterruptedException` 后无声清除。

### Tool registry 与 cache

safe publication 只保证初始化可见，不保证后续 HashMap mutation。使用 immutable copy + volatile/atomic swap，或 ConcurrentHashMap 并遵守其复合操作契约。`computeIfAbsent` 的 mapping function 不应递归更新同 map，也不应做无限远程调用。

## 16. 排障与观测边界

Thread dump 能看 BLOCKED/WAITING 和持锁，不会直接标记 data race 或告诉你某 read 看到哪次 write。JFR 能看 monitor contention、park、thread events，但 race 仍需协议审查/JCStress/特定 detector。

排查“偶发旧状态”：

```text
列共享变量和 writer/reader
 → 标出每个 action 与同步原语
 → 画 sw/hb 路径
 → 若无路径，写最小 JCStress
 → 修复为 immutable publication/lock/CAS
 → stress + 业务故障注入 + 性能对照
```

不要先加 `volatile` 到所有字段：多字段不变量仍可能撕裂，且会增加 ordering 成本并隐藏 owner 设计问题。

## 17. 常见误区

1. **volatile 保证原子性**：只保证单次读写及 ordering/visibility，`++` 不是原子。
2. **时间会刷新可见性**：sleep/yield 没有 hb 规则。
3. **synchronized 只用于互斥**：unlock/lock 还建立可见性顺序。
4. **final=深不可变**：引用指向的对象可变；构造逃逸破坏保证。
5. **x86 强内存模型所以不需同步**：编译器与 JMM 已足以让 race 错误，且部署可能换架构。
6. **JCStress 没复现=正确**：有限观测不能证明禁止结果。
7. **0,0 就证明重排**：普通交错也可能得到同结果，需设计区分实验。

## 18. 实验任务

1. 将 volatile publication 的 `ready` 改普通字段，写 JCStress outcomes，不用 while 死循环。
2. 为 `volatile int count++` 写多 actor test，观察 lost update，再改 `AtomicInteger`。
3. 构造错误 `this` escape，用回调线程读取 final/普通字段；解释难复现不改变错误性。
4. 分别用 static holder、volatile、synchronized 发布同一 immutable config，写 hb 图。
5. 对 x64 与 AArch64 跑相同 tests，比较 outcome 是否合规；不比较裸频率下结论。

## 19. 面试题与检查清单

**Q：happens-before 是时间顺序吗？** 不是 wall-clock；是 JMM 约束执行与可见写的偏序，由 program order、synchronizes-with 和传递性构成。

**Q：volatile 如何实现？** 语义上 write/read 建 sw 和 synchronization order；HotSpot 按目标 ISA 生成 compiler/CPU barriers。不能用“刷新主内存”代替完整定义。

**Q：final 为什么特殊？** 正确构造结束形成 freeze，给 final fields 初始化可见性；构造期 `this` 逃逸会破坏前提。

- [ ] 能列出常用 hb 规则并画传递链。
- [ ] 能区分 atomicity/visibility/ordering。
- [ ] 能解释 volatile flag、DCL 与 `volatile++`。
- [ ] 能识别 `this` escape 和 shallow immutability。
- [ ] JCStress outcome 在运行前已由 JMM 推导。
- [ ] 不把工具未观测到当规范证明。

## 20. 延伸阅读

- [JLS 17.4：Memory Model](https://docs.oracle.com/javase/specs/jls/se21/html/jls-17.html#jls-17.4)
- [JLS 17.5：final Field Semantics](https://docs.oracle.com/javase/specs/jls/se21/html/jls-17.html#jls-17.5)
- [JLS 17.7：Non-Atomic Treatment of double and long](https://docs.oracle.com/javase/specs/jls/se21/html/jls-17.html#jls-17.7)
- [OpenJDK JCStress](https://github.com/openjdk/jcstress)
- [VarHandle API, Java 21](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/invoke/VarHandle.html)

路线回到：[00-learning-map.md](00-learning-map.md)；下一并发章（第二轮）：`16-thread-and-lock.md`。
