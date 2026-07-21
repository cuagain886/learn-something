# 16. 线程与锁：从生命周期、阻塞协议到 HotSpot Monitor

> 优先级：S｜难度：★★★★★｜基线：JDK 21、HotSpot 21｜前置：[15 Java 内存模型](15-java-memory-model.md)

## 1. 本章目标

学完后应能回答四类问题：Java 线程状态与操作系统线程状态为什么不能一一对应；`start`、`join`、中断、`park/unpark` 分别建立什么协议；`synchronized` 的字节码、可重入、等待集和内存语义如何配合；如何从线程转储证明死锁或锁竞争，而不是凭 `BLOCKED` 猜测。

## 2. Thread 是执行主体，不是任务抽象

`Runnable`/`Callable` 描述工作，`Thread` 描述一次执行及其生命周期。调用 `run()` 只是普通方法调用；调用 `start()` 才请求 JVM 创建并调度一个新线程，而且同一个 `Thread` 对象只能启动一次。

```java
Thread t = Thread.ofPlatform().unstarted(task);
t.start();                  // start 前的动作 hb 新线程中的动作
t.join();                   // t 中所有动作 hb join 成功返回后的动作
```

这两条 happens-before 边让“主线程先填配置，工作线程读取；工作线程写结果，主线程 join 后读取”成为安全发布。`isAlive()` 的轮询不是 `join` 的等价替代：前者表达状态查询，后者同时表达等待、可中断和内存一致性协议。

JDK 21 的平台线程通常由 HotSpot 映射到一个 OS 线程。创建成本包括本地线程对象、栈地址空间和内核调度资源；这也是不能用数十万平台线程承载阻塞请求的根因。线程不是 CPU 核：可运行线程超过核数时靠时间片、抢占和上下文切换共享 CPU。

## 3. Java 状态不是 OS 调度器状态

`Thread.State` 只有六类：

| Java 状态 | 含义 | 常见来源 |
|---|---|---|
| `NEW` | 尚未启动 | `unstarted` / 构造后 |
| `RUNNABLE` | 正在执行或等待 OS 分配 CPU | Java 计算、部分 native I/O |
| `BLOCKED` | 等待进入 `synchronized` monitor | `monitorenter` 竞争 |
| `WAITING` | 无超时等待另一动作 | `Object.wait()`、`join()`、`park()` |
| `TIMED_WAITING` | 有截止时间的等待 | `sleep`、带超时 `wait/join/park` |
| `TERMINATED` | `run` 已退出 | 正常返回或未捕获异常 |

`RUNNABLE` 合并了 OS 的 running/runnable，甚至某些本地调用中的等待；不能据此断言线程正在占 CPU。`WAITING` 也不等于 monitor wait set：`park` 和 `join` 同属此状态，但唤醒协议不同。排障必须同时看堆栈顶部、锁拥有者、事件持续时间和 CPU/JFR 数据。

`sleep` 不释放已持有的 monitor；`Object.wait` 必须持有相应 monitor，调用时原子地进入等待并释放该 monitor，返回前再次竞争并获取它。二者都可能被中断，但只有 `wait` 参与条件队列协议。

## 4. 中断是协作请求，不是强制终止

`interrupt()` 设置目标线程的中断状态；若线程正阻塞在 `sleep/wait/join` 或许多可中断 JUC 方法中，方法通常清除状态并抛出 `InterruptedException`。它不会在任意指令处杀死线程，也不保证关闭 socket、数据库请求或子进程。

```java
try {
    queue.take();
} catch (InterruptedException cancelled) {
    Thread.currentThread().interrupt(); // 本层不完成取消策略，就恢复状态交给上层
    return;
}
```

正确处理取决于层的责任：

1. 任务边界可把中断解释为取消，清理资源后退出，不必恢复给已结束的调用者。
2. 中间库若不能完成取消，要恢复状态或把异常传播出去。
3. 禁止空 catch；它会吞掉 `Future.cancel(true)`、`shutdownNow()` 和请求 deadline 的信号。
4. CPU 长循环需定期检查 `isInterrupted()`；只检查一次或在每轮用 `Thread.interrupted()` 无意清除状态都可能失效。

中断不是业务数据。若任务还需区分“用户取消、超时、节点关闭”，应在结构化的取消 token/异常原因中保留语义，同时用中断唤醒阻塞点。

## 5. `park/unpark` 是单许可协议

`LockSupport` 是 AQS 等同步器的底层等待工具。每个线程至多关联一个 permit：

- `unpark(t)` 使 permit 可用；多次调用不会累计为计数器。
- `park()` 若有 permit 就消费并立即返回，否则可能阻塞。
- `park()` 也允许无理由返回；调用方必须在循环中重查谓词。
- 中断会使 `park` 返回，但不会像 `sleep` 那样抛异常并清除状态。
- blocker 版本能让线程转储显示“在等待谁”，自建同步器应提供有意义的 blocker。

```java
while (!condition()) {
    LockSupport.park(this);
    if (Thread.currentThread().isInterrupted()) cancel();
}
```

“先 `unpark`，后 `park`”能避免经典 lost wake-up，但有精确前提：目标线程必须已经 `start()`。对尚未启动线程调用 `unpark` 没有保证。本仓库的 [ThreadAndLockLab](examples/concurrency/ThreadAndLockLab.java) 因而先启动并用 latch 确认已进入任务，再在其真正执行 `park` 前发 permit。

## 6. `synchronized` 的语言、Class File 与运行时三层

同步代码块编译为成对的 `monitorenter`/`monitorexit`。编译器还必须生成异常路径上的 `monitorexit`，所以反编译常见 catch-all 异常表。同步方法没有显式 monitor 指令，而在方法上带 `ACC_SYNCHRONIZED`；实例方法锁 `this`，静态方法锁对应 `Class` 对象。

```java
synchronized (lock) {
    mutate();
}
```

概念上的执行是：求值并保存非 null 的 `lock` 引用 → 获取其 monitor → 执行临界区 → 正常或异常退出都释放。不要在锁块内替换变量后误以为释放的是新对象；monitor 绑定到进入时求值出的对象。

JMM 规定同一 monitor 的 unlock synchronizes-with 后续 lock，因此锁同时提供：

- 互斥：同一时刻最多一个拥有者在临界区；
- 可见性/有序性：释放前动作对后续成功获取者可见；
- 原子复合不变量：多个字段的检查与修改能作为一个临界区。

只有锁同一个对象才形成这条边；方法名字相同、字符串内容相同或“逻辑上是一把锁”都不够。

## 7. 可重入、竞争队列与等待集

Java monitor 可重入：拥有者再次进入同一 monitor 时增加递归计数，等量退出后才真正释放。没有可重入性，`synchronized` 方法调用本类另一个同步方法会自死锁。

需要区分三类角色：

```text
Owner          已拥有 monitor，正在临界区
Entry/contend  因 monitor 被占用而 BLOCKED，等待竞争所有权
Wait set       调用 wait 后释放 monitor，等待 notify/notifyAll/中断/超时
```

`notify` 只把某个等待者变为有资格重新竞争，不会立即移交 monitor；通知线程退出同步块前，被通知者仍不能继续。多个条件共享一个 wait set 时，`notify` 很容易唤醒不满足条件的线程，通常使用 `notifyAll` 加 `while` 谓词：

```java
synchronized (lock) {
    while (!ready) lock.wait();
    consume();
}
```

必须是 `while`，因为存在虚假唤醒、超时/中断竞争、其他消费者先改变条件等情况。通知与更新谓词必须在同一锁保护下，否则会重现 missed signal。

## 8. HotSpot monitor：不要背“锁升级固定流水线”

对象头与 monitor 的具体表示属于 HotSpot 实现，不是 JLS 承诺。JDK 21 中偏向锁已被移除，旧文章的“无锁→偏向→轻量→重量，只能升级不能降级”不能当作当前稳定模型。

在典型 HotSpot 21 中，无竞争/低竞争路径可使用对象头中的锁记录信息；竞争、需要 `wait`、某些哈希码与运行时情形可能关联/膨胀为 `ObjectMonitor`。JIT 还能做：

- 逃逸分析后锁消除：对象不逃逸，锁对其他线程不可见；
- 锁粗化：把连续小临界区合并，减少反复进入退出；
- 标量替换与内联改变对象和锁是否真实存在。

这些是观察到的优化，不是源码正确性的基础。锁实现还会随 JDK 改变，例如 JDK 24 的 JEP 491 为虚拟线程重做了 monitor 持有者记录和阻塞路径。分析必须记录 JDK build、架构、启动参数和编译层级。

## 9. 锁的性能来自等待结构，不是关键字价格

无竞争锁通常很便宜；真正成本来自：

- 临界区过长，尤其持锁做网络/磁盘 I/O；
- 高频共享写造成 cache line 迁移；
- 线程被挂起/唤醒与 OS 调度；
- 一个大锁把无关资源串行化；
- 锁顺序不一致导致死锁；
- 公平策略降低吞吐并增加 convoy。

优化顺序应是先确认不变量和 owner，再用 JFR `Java Monitor Blocked`、线程转储、async-profiler/JMC 等找等待热点，最后缩小持锁时间、分片、不可变快照或改变所有权。盲目把 `synchronized` 换成 `ReentrantLock` 不会自动消除共享瓶颈。

`String.intern()`、包装类型缓存对象、类对象和公开传入对象不适合作为私有锁：外部代码可能意外共享。优先使用 `private final Object lock = new Object()`，并保持锁引用不变。

## 10. 活跃性：死锁、饥饿与活锁

死锁通常满足互斥、持有并等待、不可抢占、循环等待。工程上最有效的预防是全局锁序：所有路径都按 `accountId` 等稳定顺序获取；或用 `tryLock(timeout)` 回退并释放已持锁。锁序键相等时还需 tie-breaker，否则排序并未定义全序。

[DeadlockLab](examples/concurrency/DeadlockLab.java) 故意让两个 daemon 线程相反顺序持锁，并用 `ThreadMXBean.findDeadlockedThreads()` 检测环。在本机 JDK 21 实测得到双方拥有者和等待对象。daemon 只为让实验 JVM 可退出，生产线程不能靠 daemon 掩盖泄漏。

饥饿是某线程长期拿不到执行/资源，可能来自优先级、非公平竞争或无界高优先任务；活锁则是线程持续响应对方、状态一直变化但没有进展。线程转储中二者不一定呈现锁环，需要进展指标、队列等待年龄和时间序列。

## 11. `ThreadLocal`：线程所有权不等于请求生命周期

`ThreadLocal` 的值与线程绑定；在线程池中线程会跨请求复用，因此值也可能泄漏到下一个任务。key 在 `ThreadLocalMap` 中是弱引用，但 value 在条目清理前仍可强引用大对象/class loader；“key 可回收”不等于 value 及时释放。

```java
try {
    context.set(requestContext);
    handle();
} finally {
    context.remove();
}
```

在线程池 decorator、日志 MDC、事务上下文中，必须定义捕获、安装、恢复/清理边界。虚拟线程每任务一个线程能减少跨任务污染，但百万虚拟线程各复制大 ThreadLocal 会变成内存问题；不要用 ThreadLocal 代替显式参数和生命周期设计。

## 12. 后端与 Agent 设计

Agent 一次 run 可有模型请求、多个 tool call、日志流和取消信号：

- 每个 run 有唯一 owner/状态机；共享快照通过不可变对象发布。
- deadline 从入口传到队列、HTTP、工具进程；超时不仅打标记，还要中断/取消下游。
- 不在持状态锁时调用模型或工具；先在锁内做状态转移和生成调用计划，锁外执行 I/O，再以版本/CAS 合并结果。
- tool A 等模型锁、模型回调又等 tool A 是跨组件死锁；必须画资源顺序，不能只审查单个类。
- `join` 适合有明确父子关系的少量线程；大规模任务交给 executor/结构化并发并保留取消传播。

状态锁保护“合法转移”，并不自动保证幂等。外部工具可能已成功但本地线程在记录结果前被中断，恢复时需 invocation id、持久化状态和幂等键。

## 13. 实验与验证

运行普通实验：

```powershell
cd deep_java\java-deep-learning
.\labs\compile-and-inspect.ps1
```

2026-07-20、Oracle HotSpot 21.0.8 实测：`start/join`、中断恢复、`unpark` 单许可均通过；MXBean 找到两线程的实际 monitor 环。可继续做：

1. 删除 `ThreadAndLockLab` 的 `unpark`，观察线程转储中的 `WAITING (parking)`。
2. 把 `unpark` 移到 `start` 前，验证程序不再可靠，并解释它不违反许可语义。
3. 用 `javap -c -v` 比较同步块和同步方法；指出异常表中的释放路径。
4. 用 JFR 记录一个有意延长的竞争临界区，关联等待时间而非只数 `BLOCKED` 数量。
5. 给死锁实验增加统一锁序，重复 `findDeadlockedThreads()` 应返回 null。

## 14. 常见误区与面试追问

1. **`sleep` 会释放锁**：不会；`wait` 才按 monitor 协议释放并重获。
2. **中断会杀线程**：它是协作信号；代码或阻塞 API 必须响应。
3. **`notify` 把锁交给目标**：只使等待者重新参与竞争。
4. **`BLOCKED` 表示 OS blocked**：它专指等待 monitor enter；OS 状态粒度不同。
5. **`park` 只会被 `unpark` 唤醒**：还可因中断或无理由返回，必须循环检查。
6. **JDK 21 还有偏向锁**：偏向锁机制已不在该基线中。
7. **换成显式锁就更快**：是否更快取决于竞争、功能需求和 JDK，实现前先测量。

**Q：为什么 `wait` 要在循环里？** 因为唤醒不等于谓词成立；虚假唤醒、其他消费者和超时竞争都要求持锁重查。

**Q：`start` 和 `join` 的价值只在调度吗？** 不是；二者还提供 JMM happens-before 边，是最基本的安全发布路径。

**Q：线程 dump 能证明 data race 吗？** 通常不能。它是某时点的栈和锁快照；data race 需协议审查、JMM 推导及 JCStress/专门工具。

- [ ] 能区分 Java 状态、OS 状态和栈顶阻塞原因。
- [ ] 能正确传播或消费中断。
- [ ] 能解释 permit 为什么不计数以及 start 前例外。
- [ ] 能从字节码解释同步块异常释放。
- [ ] 能画 owner、entry contenders、wait set。
- [ ] 能用锁序或 timed acquisition 修复死锁。

## 15. 延伸阅读

- [JLS 17：Threads and Locks](https://docs.oracle.com/javase/specs/jls/se21/html/jls-17.html)
- [JVMS 2.11.10：Exceptions 与同步方法](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-2.html#jvms-2.11.10)
- [LockSupport API, Java 21](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/locks/LockSupport.html)
- [Thread API, Java 21](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Thread.html)
- [JEP 491：JDK 24 虚拟线程 monitor 变化](https://openjdk.org/jeps/491)

下一章：[17 AQS 与并发工具](17-aqs-and-concurrency-tools.md)。
