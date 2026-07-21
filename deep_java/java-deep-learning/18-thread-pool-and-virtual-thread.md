# 18. 线程池与虚拟线程：容量、调度、取消和版本边界

> 优先级：S｜难度：★★★★★｜基线：JDK 21、HotSpot 21｜前置：[16 线程与锁](16-thread-and-lock.md)、[17 AQS](17-aqs-and-concurrency-tools.md)

## 1. 本章目标

本章把“并发”还原成资源预算：理解 `ThreadPoolExecutor.execute` 的三阶段 admission、队列与拒绝策略；能从到达率和服务时间判断系统是否稳定；正确关闭、取消和传播上下文；知道虚拟线程减少了什么成本、没有增加什么容量，以及 JDK 21 与 JDK 24 的 pinning 差异。

## 2. 为什么有线程池

平台线程池复用昂贵的 OS 线程，并把提交速率和实际执行并发解耦。它同时承担三个职责：

1. **资源上限**：限定同时占用 CPU/栈/连接的 worker；
2. **排队**：吸收可容忍的短突发；
3. **过载反馈**：容量耗尽时拒绝、降级或让上游减速。

如果只看到“避免创建线程”，就会使用无界队列掩盖过载。队列并未消灭工作，只把失败从入口的快速拒绝改成稍后的高延迟、内存增长和 deadline 过期。

## 3. ThreadPoolExecutor 的状态骨架

OpenJDK 21 的 `ThreadPoolExecutor` 用一个原子 `ctl` 把 run state 与 worker count 打包，避免分别读取造成不一致快照。逻辑状态沿单向推进：

```text
RUNNING → SHUTDOWN → STOP → TIDYING → TERMINATED
     \----------------→ STOP
```

- RUNNING：接收并处理任务；
- SHUTDOWN：不收新任务，处理队列；
- STOP：不收新任务，不处理队列，并中断 workers；
- TIDYING/TERMINATED：worker 为零，执行终止钩子并完成。

这属于实现细节，不应从应用代码读取 ctl；理解它用于解释提交与 shutdown 同时发生时为何必须二次检查。

## 4. `execute` 的精确 admission 顺序

给定 `corePoolSize`、`maximumPoolSize` 和 `workQueue`，提交不是“先扩到 max 再排队”，而是：

```text
workerCount < core?
  ├─ 是：创建 core worker 承载任务；失败则重读状态
  └─ 否：若 RUNNING 且 queue.offer 成功
          ├─ 入队后重查 run state；若已 shutdown，尝试移除并拒绝
          └─ 若此时没有 worker，补一个空 worker 消费队列
        否则尝试创建 non-core worker，直到 maximum
          ├─ 成功：执行
          └─ 失败：reject
```

因此当使用可入队的无界 `LinkedBlockingQueue` 时，`maximumPoolSize` 基本不会参与扩容；pool 到 core 后任务一直入队。想让 pool 超过 core，队列必须在压力下 `offer` 失败，例如有界队列或 `SynchronousQueue`。

`prestartAllCoreThreads()` 可避免首批任务承担启动延迟；`allowCoreThreadTimeOut(true)` 能回收 core，但会改变低流量时延。选择都应由工作负载测量驱动。

## 5. 队列就是延迟预算

Little's Law 在稳定系统中给出 `L = λW`：系统内平均工作数等于到达率乘平均停留时间。若到达率 λ 长期大于服务能力 μ，任何有限队列最终都会满，任何无界队列最终都会拖垮延迟/内存。

容量估算的起点而非结论：

```text
CPU 密集：并行度接近可用核数，再按 profiling 调整
阻塞型：threads ≈ cores × targetUtilization × (1 + waitTime/computeTime)
```

公式假设等待与计算比例相对稳定，现实还受下游连接池、锁、GC、NUMA、超线程和流量分布影响。应通过生产式压测观察 throughput、p50/p99、队列年龄、拒绝率、CPU、下游饱和度，而不是照抄“CPU+1”或“2N”。

队列容量应从最大可接受排队时间反推：`capacity ≈ admittedRate × queueBudget`，再通过突发模型验证。任务自己的 deadline 小于队列等待时，执行它已没有价值，应在出队前检查并取消。

## 6. 队列选择与拒绝策略

- `ArrayBlockingQueue`：有界、数组存储、容量明确，可选公平锁；适合硬 admission。
- `LinkedBlockingQueue`：可指定容量；默认近似无界是危险默认值。
- `SynchronousQueue`：不存任务，提交必须与 worker 直接交接，常与弹性最大线程数配合。
- `PriorityBlockingQueue`：通常无界；优先级任务可饿死普通任务，且 deadline 需要额外淘汰。
- `DelayedWorkQueue`：ScheduledThreadPoolExecutor 内部延迟队列，不等于普通有界任务队列。

四个内置拒绝策略的业务含义不同：

- `AbortPolicy`：抛异常，最容易让过载显性传播；
- `CallerRunsPolicy`：调用线程执行，可能形成自然反压，但在事件循环/持锁线程中会放大故障；shutdown 后仍会丢弃；
- `DiscardPolicy`：静默丢弃，只有明确允许且有指标/补偿时才可用；
- `DiscardOldestPolicy`：移除队头重试，对优先级队列“oldest”语义甚至不同，容易破坏任务承诺。

自定义 rejection handler 应快速、不可阻塞池锁，不要在里面无限重试 `execute`。HTTP 服务通常把过载映射为 429/503 和 `Retry-After`，消息消费则暂停拉取或 nack，而不是吞掉。

## 7. 仓库的有界池实验

[ExecutorBoundaryLab](examples/concurrency/ExecutorBoundaryLab.java) 创建 `core=max=2`、队列容量 2 的池。前两个任务占 worker，后两个入队，第五个由 `AbortPolicy` 拒绝；finally 中取消 futures、释放 latch、`shutdownNow` 并限时等待终止。

2026-07-20、HotSpot 21.0.8 实测通过。这证明特定配置的 admission，不证明真实服务应使用 2/2/2；生产值必须来自任务时延、到达率和下游预算。

可以把队列改为默认 `new LinkedBlockingQueue<>()` 再运行：第五个任务不再拒绝，却会一直排队。这正是“功能测试通过、过载设计失败”的典型差异。

## 8. 关闭、取消与异常观测

`shutdown()` 停止接收但处理队列；`shutdownNow()` 尝试中断活动任务并返回尚未开始的队列任务。两者都不能强杀不响应中断的代码。标准关闭模板：

```java
pool.shutdown();
if (!pool.awaitTermination(grace, unit)) {
    List<Runnable> neverStarted = pool.shutdownNow();
    if (!pool.awaitTermination(forceWait, unit)) logLeak();
}
```

`Future.cancel(true)` 只在任务尚未完成时请求中断；`get` 之后分别处理 `CancellationException`、`ExecutionException`、`InterruptedException` 和 `TimeoutException`。`get(timeout)` 超时不会自动 cancel future，调用方需按策略显式取消。

`execute(Runnable)` 的未捕获异常可终止 worker 并走 UncaughtExceptionHandler；`submit` 会把异常封装在 Future，若没人 `get` 就可能静默。必须统一任务 wrapper/`afterExecute`、日志与指标，同时避免重复记录同一失败。

## 9. ThreadLocal 与池化上下文

线程池复用线程，ThreadLocal/MDC/安全身份不会自然按任务清零。正确的 task decorator 应：捕获提交方允许传播的不可变上下文；在 worker 保存旧值；安装新值；finally 恢复旧值或 remove。

不要传播事务连接、可变请求对象和完整安全上下文到无限生命周期。提交后调用方继续修改 map 会形成 race；应复制最小 snapshot。异步边界也要决定 trace span 的父子关系，而不是只复制 trace id。

## 10. ForkJoinPool 与工作窃取

ForkJoinPool 为大量可分解的小任务设计：worker 使用局部双端队列，通常本地取任务，空闲时从其他 worker 窃取，以减少中央队列竞争。`fork` 后应尽量 `join` 并保持任务粒度足够大，递归到单元素会让调度成本淹没计算。

工作窃取不擅长未知时长的阻塞 I/O。平台 FJP 任务若阻塞，可在特定场景使用 `ForkJoinPool.ManagedBlocker` 通知池补偿，但普通库调用未必这样做。`parallelStream()` 和无显式 executor 的部分 CompletableFuture async 方法使用 common pool；在共享进程里，一个模块的阻塞会影响其他模块。服务端重要路径应显式选择隔离 executor。

虚拟线程调度器虽然基于专用 ForkJoinPool，但不是 `ForkJoinPool.commonPool()`；不要把两者配置和故障域混为一谈。

## 11. CompletableFuture 的组合与陷阱

非 async continuation 通常由完成前序阶段的线程执行；`thenApplyAsync` 未传 executor 时通常使用 common pool。链路中一次慢 callback 可能占住网络完成线程或公共 worker，所以必须明确哪些 stage 是纯计算、哪些会阻塞，以及在哪个 executor 执行。

异常通道：

- `thenApply` 只处理成功；
- `exceptionally` 把失败恢复为值；
- `handle` 同时看到结果/异常并返回新结果；
- `whenComplete` 适合观察，若自身抛异常还会影响链路。

`allOf` 只给 `CompletableFuture<Void>`，不会自动收集结果；某个失败时如何取消兄弟任务需要自行编排。对一个 CompletableFuture 调 `cancel(true)` 的“true”不会像线程池 Future 那样保证中断实际执行线程；文档明确该参数在实现中没有效果。若业务需要真正取消 I/O，必须保留下游句柄并显式传播。

组合图很容易失去父子生命周期，这正是结构化并发试图改进的领域。

## 12. 虚拟线程改变的是线程成本

JEP 444 在 JDK 21 正式交付虚拟线程。它仍是 `java.lang.Thread`，保留 thread-per-request 的顺序代码、栈追踪、异常和 ThreadLocal 兼容性；但由 JDK 调度，执行时 mount 到 carrier 平台线程，阻塞在受支持操作时可 unmount，让 carrier 承载其他虚拟线程。

```java
try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
    Future<Response> f = executor.submit(() -> client.send(request));
    return f.get();
}
```

它适合“大量相互独立、主要等待 I/O 的任务”，减少平台线程和异步状态机的管理成本。它没有：

- 让 CPU 密集计算超过核数；
- 提高数据库连接数、模型 API QPS 或内存容量；
- 自动提供背压、deadline、幂等、错误隔离；
- 让线程变成应该池化的昂贵资源。

推荐每个并发任务创建一个虚拟线程，不要建立“虚拟线程池”去复用少量虚拟线程。需要限制的是下游资源，用 semaphore/rate limiter/连接池，而不是用线程数间接限制。

## 13. 虚拟线程调度与观测

JDK 21 默认调度器是专用 work-stealing ForkJoinPool，目标 parallelism 默认与可用处理器数相关，可用 `jdk.virtualThreadScheduler.parallelism` 等实现属性实验，但不应把它们当业务容量旋钮。

虚拟线程不会像平台线程那样永久占用 carrier；mounted 时才在其上运行。carrier 名称不是请求身份，ThreadLocal 绑定虚拟线程而非 carrier。虚拟线程是 daemon、固定普通优先级；应用不能依靠“还有虚拟线程存活”阻止 JVM 退出，顶层生命周期仍需 join/scope/executor close。

传统 `jstack` 输出数十万线程并不实用。JEP 444 增强了新式 thread dump 和 JFR 虚拟线程事件；观测要以任务/run id、结构化关系、pinning/长阻塞事件为中心，不要为每个虚拟线程创建高基数 metric label。

## 14. Pinning：必须标注 JDK 版本

在 JDK 21，虚拟线程在 `synchronized` 方法/块内执行阻塞操作，或执行特定 native/foreign 调用时，可能无法从 carrier unmount，即 pinned。大量长时间 pinning 会耗尽 carriers，吞吐坍塌。

[VirtualThreadPinningLab](examples/concurrency/VirtualThreadPinningLab.java) 在 monitor 内 sleep，JDK 21 可这样诊断：

```powershell
java "-Djdk.tracePinnedThreads=full" -cp build\classes `
  dev.deepjava.concurrency.VirtualThreadPinningLab
```

该属性只在发生对应阻塞时打印，不是所有 monitor 获取都会产生 trace。也可用 JFR 的 `jdk.VirtualThreadPinned` 事件。短暂、稀少 pin 不一定值得改；长 I/O 在 monitor 内才是高风险。

JDK 24 的 JEP 491 改造 monitor，使虚拟线程在 `synchronized` 内大多可 unmount，并移除该 system property 的诊断作用；native 调用回到 Java 后阻塞等少数情况仍可能 pin，JFR 事件保留并增强。因此：

- JDK 21 为避免已证实的长期 monitor pin，可缩小锁区，或在需要可中断/timed/Condition 时用 `ReentrantLock`；
- JDK 24+ 不应仅为了 pinning 机械替换所有 `synchronized`；按正确性、API 能力和实测竞争选择；
- 同一个实验在 21 和 24 输出不同是预期版本差异，不是实验坏了。

## 15. 虚拟线程仍需 admission control

仓库实验提交 30 个虚拟线程，但用 3-permit semaphore 包住模拟下游：

```java
if (!downstream.tryAcquire(remaining, NANOSECONDS)) reject();
try {
    callDownstream();
} finally {
    downstream.release();
}
```

实测最大同时进入下游不超过 3。若删除 semaphore，30 个任务都可以很快到达连接池/远端，虚拟线程只是把本地排队移到了更脆弱的下游。

对流式 Agent，至少分别限制：同时 active runs、模型调用、浏览器/解释器工具、每租户份额。全局 semaphore 可保护系统，却可能被单租户占满；需要分层配额和公平/权重策略。

## 16. Structured Concurrency 的价值与版本线

结构化并发要求子任务生命周期嵌套在父任务词法作用域中：父任务在离开 scope 前等待/取消所有子任务，失败和线程转储能保留任务树。这比散落的 Future 更容易实现“一个失败取消兄弟、父请求超时向下传播”。

但它不是 JDK 21 的最终 API：JEP 453 在 JDK 21 首次 Preview；22、23、24 多次 re-preview；JEP 505 在 JDK 25 仍是第五次 Preview，且从构造器改为 `open` factory + `Joiner`。因此本仓库主线不能把某个 preview 签名封装成稳定公共 API。

工程策略：

1. JDK 21 生产基线可用 executor/Future 实现同样的父子取消语义；
2. 若实验 Preview，编译和运行都需 `--enable-preview --release 21`/`--enable-preview`，并单独隔离模块；
3. 封装自己的 `TaskScope` 领域接口，避免 API 演进扩散；
4. 每次 JDK 升级对照对应 JEP，不复制跨版本示例。

## 17. Agent runtime 的调度设计

一个可靠的 Agent 调度层可以这样分层：

```text
HTTP admission（租户配额 / 全局 run 上限）
  → 每 run 一个虚拟线程或明确父任务
    → model semaphore + rate limit + deadline
    → tool-kind semaphore + sandbox/process lifetime
    → event writer 单 owner / 有界 channel
  → 所有子任务完成、失败或取消后结束 run
```

关键不变量：

- 入口拒绝发生在创建大量状态和外部副作用之前；
- 队列中保存 enqueue time/deadline，过期任务不执行；
- 取消原因沿父子树传播，下游释放 permit、连接和进程；
- 日志/事件队列有界，慢消费者不能让 worker 无限堆积；
- rejection、timeout、cancel、downstream failure 分开计数；
- executor 生命周期由应用组件拥有，不按请求临时创建平台池。

若工具调用不可安全中断，取消只能标记“不再接收其结果”，同时用进程隔离/外部 timeout 回收资源；不能假装 `Future.cancel(true)` 已经终止副作用。

## 18. 压测与诊断清单

压测至少覆盖 steady、burst、下游慢化和部分失败：

1. 固定到达率逐步增加，找队列开始持续增长的拐点；
2. 记录 active、queue size、oldest age、reject、task service time，而非只看总 QPS；
3. 下游延迟增加 10 倍，验证 admission 和 deadline 能否阻止级联；
4. 对比平台池与虚拟线程时保持下游并发相同，否则结论混入容量差异；
5. JDK 21 用 JFR/trace 检查长 pinning；JDK 24 按新事件语义检查剩余 native pin；
6. 关闭服务时验证停止接收、排空/取消、最终无泄漏线程和子进程。

JMH 不适合模拟完整线程池服务吞吐：它适合微操作；队列、网络和尾延迟需要独立负载发生器、恒定速率模型和生产式观测。

## 19. 常见误区与面试追问

1. **maximumPoolSize 总会生效**：无界可入队队列使 pool 通常停在 core。
2. **队列越大越抗突发**：过大会让过期任务占内存并放大尾延迟。
3. **CallerRuns 永远是反压**：调用者若是事件循环或持锁线程，会阻塞关键路径甚至死锁。
4. **shutdownNow 强制杀任务**：只尝试中断，任务必须协作。
5. **虚拟线程让下游容量无限**：它只降低线程等待成本，连接/QPS 仍有限。
6. **虚拟线程适合 CPU 并行加速**：核数没有增加。
7. **JDK 21 和 24 pinning 相同**：JEP 491 已改变 monitor 行为和诊断。
8. **StructuredTaskScope 已稳定**：到 JDK 25 仍是 Preview 且 API 变化。

**Q：线程池为什么入队后重查状态？** 提交与 shutdown 可并发；只在 offer 前检查会让 shutdown 后任务滞留，因此需重查并尝试移除/拒绝。

**Q：虚拟线程要不要池化？** 通常每任务一个，不复用；限制昂贵下游资源，而不是限制廉价线程实例。

**Q：如何选择池大小？** 用 CPU/等待比例做起点，以到达率、服务时间、队列预算和下游上限压测收敛，没有跨系统常数。

- [ ] 能背出并解释 core→queue→max→reject 顺序及重查。
- [ ] 能为队列容量给出延迟预算而非拍脑袋数字。
- [ ] 能正确处理 Future 的 timeout 与 cancel。
- [ ] 能区分 common FJP、虚拟线程 scheduler 和业务 executor。
- [ ] 能说明 mount/unmount/carrier 与 JDK 21 pinning。
- [ ] 能为 Agent 画出多层 admission 和取消树。

## 20. 延伸阅读

- [ThreadPoolExecutor API, Java 21](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ThreadPoolExecutor.html)
- [Executor 的内存一致性效果, Java 21](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/Executor.html)
- [JEP 444：Virtual Threads, JDK 21](https://openjdk.org/jeps/444)
- [JEP 491：Synchronize Virtual Threads without Pinning, JDK 24](https://openjdk.org/jeps/491)
- [JEP 453：Structured Concurrency Preview, JDK 21](https://openjdk.org/jeps/453)
- [JEP 505：Structured Concurrency Fifth Preview, JDK 25](https://openjdk.org/jeps/505)

下一阶段进入运行时扩展：[19 反射、代理与字节码增强](19-reflection-proxy-bytecode.md)。
