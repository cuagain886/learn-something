# 08 · 线程池原理 ThreadPoolExecutor ⭐⭐⭐

> "一个任务提交到线程池，会经历什么？为什么阿里规约禁止用 Executors？"
> 核心一句话：**七大参数决定行为；任务进来按"核心线程→队列→非核心线程→拒绝策略"四级处理。**

---

## 1. 为什么要线程池

- 线程创建/销毁开销大（涉及内核态、栈内存分配）。
- 无限制创建线程会耗尽 CPU 和内存，导致系统崩溃。
- 线程池：**复用**线程、**限制**并发数、**队列削峰**、**统一管理**生命周期与监控。

---

## 2. 七大核心参数 ⭐⭐（必背）

```java
new ThreadPoolExecutor(
    int corePoolSize,      // 1. 核心线程数：常驻（即使空闲也不回收，除非设置 allowCoreThreadTimeOut）
    int maximumPoolSize,   // 2. 最大线程数：核心 + 非核心的上限
    long keepAliveTime,    // 3. 空闲存活时间：非核心线程空闲超过它就被回收
    TimeUnit unit,         // 4. 时间单位
    BlockingQueue<Runnable> workQueue,  // 5. 任务队列：核心线程满后任务在此排队
    ThreadFactory threadFactory,        // 6. 线程工厂：自定义线程名/优先级/守护属性（便于排查）
    RejectedExecutionHandler handler    // 7. 拒绝策略：队列满 + 线程满时怎么办
)
```

---

## 3. 任务执行流程 ⭐⭐（核心中的核心）

一个任务 `execute(task)` 进来，**严格按四步**判断：

```
            ┌─────────────────────────────────────────┐
任务进来 →  │ ① 当前线程数 < corePoolSize ?              │
            │     是 → 新建【核心线程】执行              │
            │     否 ↓                                  │
            │ ② 任务队列 workQueue 没满 ?                │
            │     是 → 任务【入队】等待                  │
            │     否 ↓                                  │
            │ ③ 当前线程数 < maximumPoolSize ?           │
            │     是 → 新建【非核心线程】执行            │
            │     否 ↓                                  │
            │ ④ 执行【拒绝策略】 handler                 │
            └─────────────────────────────────────────┘
```

> ⚠️ 关键易错点：**队列没满时优先入队，而不是先开非核心线程**。
> 即"核心线程满 → 先塞队列 → 队列也满才开非核心线程 → 都满才拒绝"。
> 所以用**无界队列**时，maximumPoolSize 永远用不上（队列永远不满）。

---

## 4. 四种拒绝策略

| 策略 | 行为 |
|------|------|
| **AbortPolicy**（默认） | 抛 `RejectedExecutionException`，让调用方知道 |
| **CallerRunsPolicy** | 让**提交任务的线程**自己执行该任务（变相降速，反压） |
| **DiscardPolicy** | 静默丢弃新任务，不报错（危险，可能悄悄丢数据） |
| **DiscardOldestPolicy** | 丢弃队列里最老的任务，再尝试提交新任务 |

> 生产常用 CallerRunsPolicy（反压保护）或自定义（落库/告警/降级），慎用两个 Discard。

---

## 5. 常见队列选择

| 队列 | 特点 | 配套线程池 |
|------|------|-----------|
| `ArrayBlockingQueue` | **有界**数组队列 | 推荐：可控、防 OOM |
| `LinkedBlockingQueue` | 默认**无界**（可设容量） | FixedThreadPool 用它（无界→风险） |
| `SynchronousQueue` | **不存任务**，直接转交线程 | CachedThreadPool 用它（线程数无上限→风险） |
| `PriorityBlockingQueue` | 带优先级 | 任务有优先级时 |
| `DelayedWorkQueue` | 延迟队列 | ScheduledThreadPool |

---

## 6. ⚠️ 为什么阿里规约禁止用 Executors 工厂

`Executors` 的快捷方法藏着 OOM 风险：

```java
Executors.newFixedThreadPool(n)      // 用【无界】LinkedBlockingQueue → 任务堆积撑爆内存
Executors.newSingleThreadExecutor()  // 同上，无界队列
Executors.newCachedThreadPool()      // maximumPoolSize = Integer.MAX_VALUE → 线程数无限→OOM
Executors.newScheduledThreadPool(n)  // 无界队列
```

**正确做法**：手动 `new ThreadPoolExecutor(...)`，显式设置**有界队列** + **合理的最大线程数** + **明确的拒绝策略** + **自定义 ThreadFactory（给线程命名，便于排查）**。

```java
ThreadPoolExecutor pool = new ThreadPoolExecutor(
    8, 16, 60L, TimeUnit.SECONDS,
    new ArrayBlockingQueue<>(1000),                       // 有界！
    new ThreadFactoryBuilder().setNameFormat("order-%d").build(),
    new ThreadPoolExecutor.CallerRunsPolicy());            // 明确拒绝策略
```

---

## 7. 线程数怎么设（经典经验公式）

- **CPU 密集型**（计算为主）：`线程数 ≈ CPU 核数 + 1`。线程多了只会增加上下文切换。
- **IO 密集型**（等网络/磁盘为主）：`线程数 ≈ CPU 核数 × (1 + 平均等待时间/平均计算时间)`，经验上可设到 `2 × 核数` 甚至更高。
- 实际要**压测**为准，公式只是起点。
- ⭐ 现代方案：IO 密集型用**虚拟线程**（见 code/17）可以直接"每任务一线程"，免去精细调参。

---

## 8. 线程池状态 & 关闭

5 种状态（存在 ctl 这个 AtomicInteger 的高 3 位，低 29 位存线程数）：
`RUNNING → SHUTDOWN → STOP → TIDYING → TERMINATED`。

关闭：
- `shutdown()`：**温和**，不再接新任务，已提交的（含队列里的）执行完才停。
- `shutdownNow()`：**强硬**，尝试中断正在执行的线程，返回队列中未执行的任务。

---

## 9. 高频面试题 + 标准答案

**Q1：线程池七大参数？** ⭐⭐
> corePoolSize 核心线程数、maximumPoolSize 最大线程数、keepAliveTime 空闲存活时间、unit 单位、workQueue 任务队列、threadFactory 线程工厂、handler 拒绝策略。

**Q2：一个任务提交后的执行流程？** ⭐⭐
> ① 线程数<核心数 → 建核心线程执行；② 否则入队列；③ 队列满且线程数<最大数 → 建非核心线程；④ 都满 → 执行拒绝策略。关键：队列没满优先入队，不是先开非核心线程。

**Q3：为什么不推荐用 Executors 创建线程池？** ⭐⭐
> FixedThreadPool/SingleThreadExecutor 用无界队列，任务堆积会 OOM；CachedThreadPool 最大线程数是 Integer.MAX_VALUE，线程暴涨也会 OOM。应手动 new ThreadPoolExecutor 设有界队列、合理最大线程数和拒绝策略。

**Q4：有哪些拒绝策略？**
> AbortPolicy（默认，抛异常）、CallerRunsPolicy（提交线程自己跑，反压）、DiscardPolicy（静默丢弃）、DiscardOldestPolicy（丢最老的）。生产常用 CallerRuns 或自定义。

**Q5：核心线程会被回收吗？**
> 默认不会，核心线程常驻。但设置 `allowCoreThreadTimeOut(true)` 后，核心线程空闲超过 keepAliveTime 也会被回收。

**Q6：线程数怎么设置？** ⭐
> CPU 密集型设核数+1；IO 密集型设核数×(1+等待/计算)，经验上约 2×核数。需压测调优。现在 IO 密集更推荐虚拟线程，免调参。

**Q7：用无界队列时 maximumPoolSize 还有用吗？**
> 没用。队列永远不会满，流程走不到"建非核心线程"那一步，线程数最多到 corePoolSize。这正是 FixedThreadPool 的隐患。

---

## 一句话总结

> 线程池靠**七参数**运转，任务按"**核心线程→队列→非核心线程→拒绝策略**"四级处理（**队列优先于非核心线程**）；
> **Executors 工厂有无界队列/无限线程的 OOM 坑**，生产要手动设有界队列 + 拒绝策略 + 命名线程工厂；
> CPU 密集设核数+1，IO 密集设更多或干脆上**虚拟线程**。
