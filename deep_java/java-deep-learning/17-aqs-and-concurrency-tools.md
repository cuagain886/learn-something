# 17. AQS 与并发工具：从 CAS、等待队列到同步器语义

> 优先级：S｜难度：★★★★★｜基线：JDK 21｜前置：[15 JMM](15-java-memory-model.md)、[16 线程与锁](16-thread-and-lock.md)

## 1. 本章目标

本章不是记 API 表，而是建立一条实现链：原子 read-modify-write 改变同步状态；竞争失败者进入等待队列；释放者传播唤醒；上层再组合出锁、闩锁、信号量和条件变量。完成后应能读 AQS 子类、设计超时/中断边界，并知道 CAS、`LongAdder`、读写锁何时会破坏业务不变量。

## 2. 从 CAS 到同步器

CAS 可抽象为：仅当内存中的当前值等于 expected 时，原子地写 update，并报告成功与否。

```java
do {
    int observed = state.get();
    int next = transition(observed);
} while (!state.compareAndSet(observed, next));
```

CAS 解决的是一个位置的一次条件更新；它没有自动解决：

- 多字段不变量，例如余额和版本必须一起变化；
- 外部副作用，例如 CAS 重试中重复发 HTTP；
- 公平性，失败线程可能长期重试；
- 过载，100 个线程自旋同一 cache line 会制造一致性流量；
- ABA：值从 A→B→A，CAS 只看到仍为 A，却没看到中间历史。

所以高层同步器通常采用“短时间竞争 + 入队阻塞”，而不是无限自旋。

## 3. AQS 的核心契约

`AbstractQueuedSynchronizer`（AQS）维护一个 `volatile int state` 和一个 FIFO 风格的双向等待队列。子类只解释 state 与获取/释放条件，AQS 框架处理入队、阻塞、取消和唤醒。

```text
调用方 acquire(arg)
  ├─ tryAcquire(arg) 成功 → 返回
  └─ 失败 → 创建 Node → 原子入队 → 按前驱状态 park
release(arg)
  └─ tryRelease(arg) 报告“可唤醒” → 找合适后继 unpark
```

队列受 CLH 锁思想影响，但不能简单称为“一个 CLH 自旋锁”：AQS 节点会阻塞、支持取消/超时/共享传播，具体节点字段与状态编码也跨 JDK 演化。业务代码依赖 API 契约；阅读源码时必须指定版本，本章以 OpenJDK 21 为基线。

子类常覆写：

- `tryAcquire/tryRelease`：独占模式，同一时刻一个逻辑拥有者；
- `tryAcquireShared/tryReleaseShared`：共享模式，返回值还决定是否可能继续传播；
- `isHeldExclusively`：Condition 所需的独占检查。

AQS 的公开模板方法负责超时和中断，不应由子类重写。子类的 try 方法必须短小、非阻塞，不能在其中做 I/O 或再次 park。

## 4. 独占获取的关键路径

以 `acquireInterruptibly` 的概念路径为例：

1. 先检查中断；
2. 调用子类 `tryAcquire` 快速路径；
3. 失败则原子加入队尾；
4. 只有前驱合适时再次 tryAcquire，避免所有节点同时争抢；
5. 无法获取时设置/观察前驱状态并 park；
6. 被唤醒、中断或虚假返回后循环；
7. 超时/中断退出时取消节点并修复可达的唤醒链。

`unpark` 只是给线程 permit，不代表它已经获得同步状态。醒来者必须再次 CAS；这也是唤醒顺序、队列顺序和 OS 实际运行顺序不完全等价的原因。

非公平 `ReentrantLock` 允许新线程在排队者之前通过快速 CAS barging，吞吐通常更好；公平锁在获取时尊重是否已有前驱，但“公平”仍不承诺严格 wall-clock 先来先得，因为线程调度、取消和超时会介入。

## 5. 释放与共享传播

独占 `release` 只有在 `tryRelease` 返回 true（通常表示重入计数归零）时才唤醒后继。若子类过早返回 true，可能让两个线程同时进入；永不返回 true 则队列停滞。

共享模式允许多个成功获取者并存。`tryAcquireShared` 的约定是：负数失败，0 成功但无需继续传播，正数成功且后续获取可能成功。像 `CountDownLatch` 打开后，后继应连续传播；像 `Semaphore`，剩余 permit 决定传播机会。

共享并不等于只读：信号量的 permit、闩锁的计数都是共享协议状态。它表达“可以有多个获取者”，不是数据结构不可变。

## 6. 仓库实验：OneShotLatch

[OneShotLatchLab](examples/concurrency/OneShotLatchLab.java) 用 state 0/1 实现只打开一次的门：

```java
protected int tryAcquireShared(int ignored) {
    return getState() == 1 ? 1 : -1;
}
protected boolean tryReleaseShared(int ignored) {
    return compareAndSetState(0, 1);
}
```

第一次 `open` 从 0 CAS 到 1 并触发共享传播；后续 open 返回 false，但门保持开放。等待支持 interrupt 和 timeout，因为调用的是 AQS 模板方法。2026-07-20 在 HotSpot 21.0.8 上验证：打开前定时等待失败，打开后无界和定时等待都立即成功。

这个极简例子仍有设计问题可讨论：

- `open` 是否应返回“本次是否首次打开”，而不是 void；
- 可否 reset？若加入 reset，旧等待者与新一代等待者会混淆，需要 generation；
- state 的 1 是否足够，还是还要发布异常/结果；
- await 超时与 open 同时发生时，API 允许哪一方胜出。

写同步器前先写状态机和竞态结果表，比先写 CAS 更重要。

## 7. `ReentrantLock` 与 `Condition`

显式锁相对 `synchronized` 的核心增量是可中断获取、带超时尝试、公平策略和多个条件队列：

```java
lock.lockInterruptibly();
try {
    while (!hasItem()) notEmpty.await();
    take();
    notFull.signal();
} finally {
    lock.unlock();
}
```

`unlock` 必须放 finally。`ConditionObject` 有自己的条件队列；`await` 完全释放 AQS 独占状态，等待 signal 后节点转移到同步等待队列，重新获取原来的 state 后才返回。`signal` 和 monitor `notify` 一样不直接交锁。

多个 Condition 可以把 `notEmpty`、`notFull` 分开，减少无关唤醒，但仍必须循环检查谓词。若在未持锁时 signal，或把谓词写在另一把锁下，会造成丢信号/数据竞争。

## 8. 闩锁、栅栏、信号量不是同一种计数器

### CountDownLatch

一次性相位门。计数只减不增，`await` 等到零；适合“等待 N 个初始化任务完成”。它不能重复使用，也不自动收集异常：工作线程必须在 finally countDown，并把失败另行传播。

### CyclicBarrier / Phaser

Barrier 让固定参与者在每一代会合，最后到达者推进 generation；某参与者中断/超时可能打破整代。`Phaser` 支持动态注册和多阶段，但到达、注销、等待的组合更复杂。它们协调阶段，不是限制资源并发。

### Semaphore

permit 表示可并发占用的容量；`acquire` 成功后必须在 finally release。信号量不拥有线程身份，错误的 release 会凭空增加容量。它适合限制数据库、模型 API、浏览器实例等下游并发，不应把“有 20 permits”误解为“下游能承受 20 QPS”——并发和速率是不同维度。

## 9. 读写锁与乐观读

`ReentrantReadWriteLock` 在读多写少且读临界区足够长时可能提升并发；但写者仍需等待所有读者，锁元数据和 cache 流量有成本，错误升级可能死锁。不要持 read lock 再直接获取 write lock；通常释放读锁后竞争写锁，并重新验证状态。

`StampedLock` 提供 optimistic read：先取 stamp，普通读取字段，再 validate；失败则退化为 read lock。读取的多个字段在 validate 前只是推测值，不能用于不可逆操作，且异常路径必须正确释放 stamp。它不是可重入锁，也没有 Condition，API 更容易误用。只有基准证明读路径值得时才选择。

## 10. 原子类、ABA 与复合状态

`AtomicInteger.incrementAndGet` 把 read-modify-write 做成一个线性化操作；`AtomicReference.updateAndGet` 的函数可能因 CAS 失败执行多次，必须无副作用。要原子更新多字段，可把它们封装在不可变 record 中，以一个 `AtomicReference<State>` CAS 整体快照。

ABA 的应对取决于是否关心历史：

- `AtomicStampedReference` 同时比较引用和版本；
- `AtomicMarkableReference` 只需一位标记；
- 不复用节点/句柄、使用单调版本也可；
- 若 A→B→A 对业务确实等价，则 ABA 不构成错误。

版本会溢出；证明需要考虑 wraparound 速度和对象生命周期，不能把 `int` stamp 当永久唯一 ID。

## 11. LongAdder：高吞吐统计，不是精确事务

`LongAdder` 在竞争时把更新分散到多个 cell，读取 `sum()` 再汇总，减少单一 CAS 热点。它适合请求数、指标采样等：

- `sum()` 不是与并发更新原子一致的快照；
- `sumThenReset()` 也不适合严格计费；
- 内存大于一个 AtomicLong；
- 低竞争时未必更快。

余额、库存、序号和限额必须有明确线性化点，优先 `AtomicLong`、锁或数据库原子事务。监控指标允许近似，业务账本通常不允许。

## 12. VarHandle、内存访问模式与 Unsafe 边界

`VarHandle` 是标准化的变量访问句柄，提供 plain、opaque、acquire/release、volatile 和 CAS 等模式。越弱的模式越难推导，不要为了“少一个屏障”擅自把 volatile 改为 opaque；先写 JMM 协议，再通过可信基准和目标架构验证。

`sun.misc.Unsafe`/内部 `jdk.internal.misc.Unsafe` 不是普通业务 API：模块封装、对象布局和 GC barrier 都可能使直接内存操作在升级时破裂。构建框架也应优先 VarHandle、MethodHandle、Foreign Function & Memory API 等受支持接口。若不得不用内部机制，要隔离适配层、做多 JDK CI 和故障降级。

## 13. 并发容器的原子性边界

`ConcurrentHashMap` 保证单项并发访问和特定复合方法，而不是任意多步组合：

```java
if (!map.containsKey(k)) map.put(k, build()); // 非原子 check-then-act
map.computeIfAbsent(k, this::build);          // 对该 key 采用容器协议
```

mapping function 应短小、无递归修改冲突，且必须接受“因竞态或异常可能被调用”的库契约。不要在它里面无限远程 I/O；这会把容器内部协调路径变成下游故障放大器。缓存加载宜用 `CompletableFuture<Value>` 占位、超时和失败淘汰策略，并明确谁能重试。

`CopyOnWriteArrayList` 读快照便宜、每次写复制整个数组，适合很少修改的监听器列表，不适合频繁写或大列表。`ConcurrentLinkedQueue` 的弱一致迭代不等于事务快照。选择容器时必须阅读每个方法的 happens-before 与迭代一致性承诺。

## 14. Agent 的许可、截止时间与状态机

Agent runtime 常见三层限制：run 总并发、每模型并发、每工具并发。可以用独立 Semaphore 隔离，但要规定获取顺序，避免一个任务持 model permit 等 tool permit、另一个反向等待。

从绝对 deadline 计算剩余时间：

```text
remaining = deadline - monotonicNow
acquire(remaining) → HTTP timeout(新的 remaining) → tool timeout(新的 remaining)
```

不能每层重新给 30 秒，否则总耗时无限膨胀。等待 permit 也消耗请求预算；超时后要取消排队和下游任务，并记录失败发生在 admission、execution 还是 result merge。

Agent 状态适合用不可变 record + `AtomicReference`：

```text
QUEUED(v3) --CAS--> RUNNING(v4) --CAS--> COMPLETED(v5)
                         \------CAS--> CANCELLED(v5)
```

完成与取消竞态必须预先规定允许结果，例如“已提交外部副作用后取消，只停止后续步骤并记录 uncertain”，而不是由最后一次 CAS 的偶然获胜者定义业务。

## 15. 测试策略

同步器测试至少包含：

1. 单线程状态机与非法调用；
2. 获取前中断、排队时中断、唤醒后中断；
3. timeout 与 release 同时发生；
4. 多等待者的共享传播；
5. 被取消节点位于队头/队中时后继仍进展；
6. 长时间 stress 的安全性与活跃性；
7. JCStress 验证内存语义，而不是靠 sleep 排时序。

普通单元测试负责确定性 API 行为；JCStress 负责可能执行结果；JMH 负责性能。三者不能互相替代。AQS 自定义实现若要生产使用，还应对照 TCK 风格测试并审计序列化、监控方法只提供瞬时估计的事实。

## 16. 常见误区与面试追问

1. **CAS 就是无锁且必然更快**：高竞争 CAS 会重试并制造 cache 热点；lock-free 也不保证单线程无饥饿。
2. **AQS 队列严格公平**：公平策略、队列顺序和 OS 调度仍有边界。
3. **`signal` 后等待者立即运行**：它需转入同步队列并重新获取锁。
4. **Semaphore 自动归还 permit**：不会；必须 finally release，且多 release 会破坏容量。
5. **LongAdder 可做余额**：`sum` 非线性化快照，不适合严格事务。
6. **并发容器让所有组合原子**：只保证文档定义的方法边界。
7. **AQS 是 CLH 自旋锁**：它借鉴队列思想，但包含阻塞、取消与共享传播。

**Q：为什么 AQS 子类只实现 try 方法？** 框架统一处理容易出错的排队、中断、超时、取消与唤醒，子类只定义 state 的业务语义。

**Q：公平锁为什么可能吞吐更低？** 它减少 barging，需要更多队列/调度交接，容易形成 convoy；是否值得取决于等待尾延迟与饥饿要求。

**Q：CAS 成功提供什么内存语义？** 取决于所用原子/VarHandle 方法；常用 Atomic CAS 具有 volatile 风格的读取和写入效果。不能把所有弱模式笼统当全栅栏。

- [ ] 能描述 AQS state、队列、park/unpark 的闭环。
- [ ] 能写出独占与共享 try 方法的返回契约。
- [ ] 能解释 Condition 节点从条件队列转同步队列。
- [ ] 能为 semaphore 设计 finally、timeout 和获取顺序。
- [ ] 能区分精确业务计数与近似指标。
- [ ] 能列出自定义同步器的竞态测试矩阵。

## 17. 延伸阅读

- [AbstractQueuedSynchronizer API, Java 21](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/locks/AbstractQueuedSynchronizer.html)
- [OpenJDK 21 AQS 源码](https://github.com/openjdk/jdk21u/blob/master/src/java.base/share/classes/java/util/concurrent/locks/AbstractQueuedSynchronizer.java)
- [VarHandle API, Java 21](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/invoke/VarHandle.html)
- [java.util.concurrent package specification](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/package-summary.html)

下一章：[18 线程池与虚拟线程](18-thread-pool-and-virtual-thread.md)。
