# 09 · AQS 原理（AbstractQueuedSynchronizer）⭐⭐⭐

> ReentrantLock、CountDownLatch、Semaphore、ReentrantReadWriteLock 的**共同地基**。
> 核心一句话：**AQS = 一个 volatile 的 state + 一个 CLH 双向等待队列，用 CAS 改 state、抢不到就入队阻塞。**

---

## 1. AQS 是什么

`AbstractQueuedSynchronizer` 是 `java.util.concurrent.locks` 包里的**抽象基类**，把"管理同步状态 + 排队等待 + 阻塞唤醒"这些通用逻辑封装好，具体的锁只需定义"**什么是获取/释放**"。这是**模板方法模式**的典范。

它管两样东西：
1. **state**：一个 `volatile int`，表示同步状态（含义由子类定义）。
2. **CLH 队列**：一个 **FIFO 双向链表**，存抢不到锁而被阻塞的线程（封装成 Node）。

```java
private volatile int state;              // 同步状态（volatile 保证可见性）
private transient Node head, tail;       // CLH 队列头尾
// 用 CAS 操作 state
protected final boolean compareAndSetState(int expect, int update) { ... }
```

---

## 2. state 在不同同步器里代表什么 ⭐

**这是理解 AQS 的钥匙**：同一个 state 字段，被各同步器赋予不同含义：

| 同步器 | state 含义 |
|--------|-----------|
| ReentrantLock | 0=未锁，>0=重入次数；改变 owner 线程 |
| Semaphore | 剩余许可证数量 |
| CountDownLatch | 还剩几个 countDown 没调用 |
| ReentrantReadWriteLock | 高 16 位=读锁次数，低 16 位=写锁次数 |

---

## 3. 独占模式 vs 共享模式

AQS 支持两种获取方式，子类按需实现对应模板方法：

- **独占（Exclusive）**：同一时刻只有一个线程能拿到。如 ReentrantLock。
  - 子类实现 `tryAcquire(int)` / `tryRelease(int)`。
- **共享（Shared）**：多个线程可同时拿到。如 Semaphore、CountDownLatch、读锁。
  - 子类实现 `tryAcquireShared(int)` / `tryReleaseShared(int)`。

子类只重写这几个"tryXxx"方法定义语义，**排队、阻塞、唤醒由 AQS 父类统一处理**。

---

## 4. 获取锁的流程（独占模式） ⭐⭐

```java
// AQS.acquire 模板（ReentrantLock.lock 最终走到这里）
public final void acquire(int arg) {
    if (!tryAcquire(arg) &&                            // ① 子类尝试获取（CAS 改 state）
        acquireQueued(addWaiter(Node.EXCLUSIVE), arg)) // ② 失败则入队并阻塞
        selfInterrupt();
}
```

1. **tryAcquire**：CAS 尝试把 state 0→1。成功则记 owner 为当前线程，直接返回（**快路径，无排队**）。
2. 失败 → **addWaiter**：把当前线程包成 Node 加入 CLH 队列尾部（CAS 入队）。
3. **acquireQueued**：在队列里**自旋**：
   - 若自己是 head 的后继（排第一），再 tryAcquire 一次；成功就出队当家。
   - 否则把前驱节点状态置为 SIGNAL，然后 **`LockSupport.park()` 阻塞**自己，等待被唤醒。

**释放**：`release` → `tryRelease`（state 减到 0）→ `LockSupport.unpark()` 唤醒队列里的后继节点。

> 阻塞/唤醒底层用 **`LockSupport.park()/unpark()`**（基于 Unsafe，不需要先持锁，比 wait/notify 灵活）。

---

## 5. 公平锁 vs 非公平锁 ⭐

以 ReentrantLock 为例，差别只在 `tryAcquire` 里**要不要看队列**：

- **非公平锁**（默认）：一来就 CAS 抢 state，**不管队列里有没有人在等**。抢到就插队。
  - 优点：吞吐高（减少线程切换）；缺点：可能"饿死"排队的线程。
- **公平锁**：tryAcquire 前先用 `hasQueuedPredecessors()` 检查队列**有没有人排在自己前面**，有就乖乖入队。
  - 优点：先到先得，公平；缺点：吞吐略低。

```java
// 非公平：直接抢
if (compareAndSetState(0, acquires)) { setExclusiveOwnerThread(current); return true; }
// 公平：先看有没有前驱在排队
if (!hasQueuedPredecessors() && compareAndSetState(0, acquires)) { ... }
```

---

## 6. 基于 AQS 的同步器一览

| 同步器 | 模式 | tryAcquire 逻辑 |
|--------|------|----------------|
| **ReentrantLock** | 独占 | state 0→1 获取，重入则 +1；释放减到 0 |
| **CountDownLatch** | 共享 | 构造时 state=N；await() 检查 state==0 才放行；countDown() 让 state-1，减到 0 唤醒所有等待者 |
| **Semaphore** | 共享 | state=许可数；acquire 减、release 加，减到 <0 则排队 |
| **ReentrantReadWriteLock** | 混合 | state 拆高低 16 位分别记读/写锁 |
| **CyclicBarrier** | 基于 ReentrantLock + Condition（非直接 AQS） | 凑齐一批线程再一起放行，可重用 |

### Condition（等待/通知）
AQS 还提供 `ConditionObject`，是 `Object.wait/notify` 的替代，且一个锁可有**多个 Condition 队列**（如生产者-消费者用"非满"和"非空"两个条件），比 synchronized 的单一等待集更灵活。

---

## 7. 高频面试题 + 标准答案

**Q1：AQS 是什么？核心原理？** ⭐⭐
> AbstractQueuedSynchronizer，是 ReentrantLock/Semaphore/CountDownLatch 等的基类。核心 = 一个 volatile int 的 state（同步状态）+ 一个 CLH 双向 FIFO 队列（存阻塞线程）。用 CAS 改 state，改成功即获取同步资源，失败则入队并用 LockSupport.park 阻塞，释放时 unpark 唤醒后继。它用模板方法把排队/阻塞/唤醒封装好，子类只定义 tryAcquire/tryRelease。

**Q2：state 在不同锁里代表什么？** ⭐
> ReentrantLock 是重入次数，Semaphore 是剩余许可数，CountDownLatch 是剩余计数，ReadWriteLock 高 16 位读锁、低 16 位写锁。

**Q3：公平锁和非公平锁的区别？怎么实现的？** ⭐⭐
> 非公平锁（默认）线程来了直接 CAS 抢 state，不看队列，可能插队，吞吐高但可能饿死。公平锁在抢之前先 hasQueuedPredecessors() 检查是否有线程排在前面，有则入队，先到先得但吞吐略低。区别就在 tryAcquire 是否检查队列。

**Q4：独占模式和共享模式的区别？**
> 独占：同一时刻只一个线程持有（ReentrantLock），实现 tryAcquire/tryRelease。共享：多个线程可同时持有（Semaphore、CountDownLatch、读锁），实现 tryAcquireShared/tryReleaseShared，释放时可唤醒多个等待者。

**Q5：AQS 用什么阻塞和唤醒线程？为什么不用 wait/notify？**
> 用 LockSupport.park()/unpark()（底层 Unsafe）。相比 wait/notify：park/unpark 不要求先持有锁、可以先 unpark 后 park（不会丢信号）、能精确唤醒指定线程，更灵活可靠。

**Q6：CountDownLatch 的原理？**
> 共享模式 AQS。构造时 state=N；await() 调 tryAcquireShared，state≠0 则阻塞入队；每次 countDown() 用 CAS 把 state 减 1，减到 0 时唤醒所有 await 的线程一起放行。注意它不可重用（state 到 0 就结束）。

---

## 一句话总结

> AQS = **volatile state + CLH 等待队列**，CAS 改 state 抢资源、抢不到 park 阻塞入队、释放时 unpark 唤醒；
> **state 的含义由子类定义**（重入次数/许可数/计数），独占给 ReentrantLock，共享给 Semaphore/CountDownLatch；
> 公平与否只看 tryAcquire **要不要先查队列**。它是整个 J.U.C 锁体系的发动机。
