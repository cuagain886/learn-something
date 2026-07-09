# 05 · synchronized 原理与锁升级 ⭐⭐⭐

> "synchronized 是不是重量级锁？"——早就不是了。核心一句话：
> **synchronized 靠对象头 Mark Word 记录锁状态，锁会随竞争从 偏向→轻量级→重量级 单向升级。**

---

## 1. synchronized 的三种用法与锁对象

```java
synchronized void m() {}              // 实例方法：锁 this
static synchronized void m() {}       // 静态方法：锁 类的 Class 对象
void m() { synchronized (obj) {...} } // 同步块：锁 obj
```

- 锁的是**对象**，不是代码。不同锁对象互不干扰。
- ⚠️ 常见坑：`synchronized(new Object())` 每次 new 不同锁，等于没锁；`synchronized(Integer)` 因缓存/装箱可能锁错对象。

---

## 2. 底层实现：monitor 与字节码

`javap -c` 反编译可见：
- **同步块**编译成 `monitorenter` / `monitorexit` 字节码（成对，含异常出口的 exit）。
- **同步方法**靠方法的 `ACC_SYNCHRONIZED` 标志，JVM 进入时隐式获取 monitor。

每个对象关联一个 **Monitor（管程，C++ 的 ObjectMonitor）**，重量级锁时它包含：
- `_owner`：持锁线程
- `_EntryList`：等待获取锁的阻塞线程队列
- `_WaitSet`：调用 `wait()` 后等待的线程
- `_count`/`_recursions`：重入计数

`wait()/notify()` 必须在 synchronized 中调用，就是因为它们操作的是这个 monitor。

---

## 3. 对象头 Mark Word ⭐——锁状态存在哪

每个对象的对象头里有个 **Mark Word（64 位 JVM 占 8 字节）**，复用同一块空间表示不同状态：

| 锁状态 | Mark Word 主要内容 | 标志位 |
|--------|-------------------|--------|
| 无锁 | 对象 hashCode、GC 分代年龄 | 01 |
| 偏向锁 | 持有偏向的**线程 ID**、epoch、年龄 | 01（偏向位 1） |
| 轻量级锁 | 指向栈中**锁记录(Lock Record)的指针** | 00 |
| 重量级锁 | 指向 **Monitor** 的指针 | 10 |
| GC 标记 | — | 11 |

> 因为锁信息和 hashCode、GC 年龄共用 Mark Word，所以"调用了 hashCode 的对象无法偏向"等细节由此而来。

---

## 4. 锁升级过程 ⭐⭐（最高频考点）

JDK 6 起对 synchronized 做了大量优化，引入**锁升级**：从最省的状态开始，竞争加剧才升级，**单向不可逆**。

```
无锁 → 偏向锁 → 轻量级锁 → 重量级锁
       (无竞争)  (少量竞争/交替)  (激烈竞争)
```

### 4.1 偏向锁 Biased Locking
- **场景**：锁总是被**同一个线程**获取（实际中大量锁根本没竞争）。
- **做法**：第一次获取时，用 CAS 把**线程 ID** 记进 Mark Word。之后该线程再进入，只需检查 Mark Word 里是不是自己——**连 CAS 都省了**，几乎零开销。
- **撤销**：一旦有**别的线程**来竞争，偏向锁被撤销（需到安全点 STW），升级为轻量级锁。
- ⚠️ **Java 15 起偏向锁被默认禁用、并在后续移除**（维护成本高、现代应用收益下降）。面试要知道这个变化。

### 4.2 轻量级锁 Lightweight Locking
- **场景**：多个线程**交替**执行同步块（竞争不激烈、几乎不重叠）。
- **做法**：线程在自己**栈帧**里建 **Lock Record**，用 **CAS** 把对象 Mark Word 替换为指向该 Lock Record 的指针。成功即获锁。
- **失败**：说明有竞争，**自旋**（CAS 重试一会儿，赌锁很快释放，避免直接阻塞的上下文切换开销）。
- 自旋仍拿不到 → 升级重量级锁。

### 4.3 重量级锁 Heavyweight Locking
- **场景**：竞争激烈。
- **做法**：Mark Word 指向 **Monitor**，没抢到锁的线程进入 `_EntryList` **阻塞**（操作系统互斥量 mutex，涉及用户态↔内核态切换，开销大）。
- 释放锁时唤醒等待线程重新竞争。

### 锁升级权衡一句话
> 偏向锁省了"无竞争时的 CAS"，轻量级锁省了"交替执行时的阻塞切换"，重量级锁兜底"真激烈竞争"。从省到贵逐级兜底。

---

## 5. 其他锁优化

- **自旋锁 / 自适应自旋**：短暂忙等而非立即阻塞；JVM 根据历史自旋成功率动态调整自旋次数。
- **锁消除（Lock Elision）**：JIT 逃逸分析发现锁对象不可能被其他线程访问，直接**去掉锁**。
  ```java
  // StringBuffer.append 内部有 synchronized，但局部 sb 不逃逸 → 锁被消除
  String f() { StringBuffer sb = new StringBuffer(); sb.append("a"); return sb.toString(); }
  ```
- **锁粗化（Lock Coarsening）**：连续多次加同一把锁（如循环里反复 append），JIT 把锁范围扩大到外面，加一次就好。

---

## 6. synchronized vs ReentrantLock（高频对比）

| 维度 | synchronized | ReentrantLock |
|------|-------------|---------------|
| 实现 | JVM 内置（关键字） | JDK 代码（AQS，见文档 09） |
| 释放 | 自动（出块/异常） | 手动 `unlock()`，须 finally |
| 可重入 | 是 | 是 |
| 公平性 | 非公平 | 可选公平/非公平 |
| 可中断获取 | 否 | `lockInterruptibly()` |
| 超时尝试 | 否 | `tryLock(timeout)` |
| 条件变量 | 一个（wait/notify） | 多个 `Condition` |
| 性能 | 优化后与 Lock 相当 | 相当 |

**选择**：默认用 synchronized（简单、自动释放、JVM 持续优化）；需要超时、可中断、公平锁、多条件队列时才用 ReentrantLock。

---

## 7. 高频面试题 + 标准答案

**Q1：synchronized 的锁升级过程？** ⭐⭐
> 无锁→偏向锁→轻量级锁→重量级锁，单向升级。偏向锁记线程 ID，同一线程重入零开销；有别的线程竞争则升轻量级锁，用 CAS + 自旋；自旋失败升重量级锁，线程进 Monitor 阻塞。锁状态存在对象头 Mark Word 里。

**Q2：synchronized 底层怎么实现？** ⭐
> 同步块编译成 monitorenter/monitorexit，同步方法用 ACC_SYNCHRONIZED 标志。每个对象关联一个 Monitor，重量级锁时未获锁线程进 EntryList 阻塞。锁状态记录在对象头 Mark Word。

**Q3：偏向锁解决什么问题？现在还有吗？** ⭐
> 解决"锁总被同一线程获取"时连 CAS 都嫌多的开销，只比对 Mark Word 里的线程 ID。但 Java 15 起默认禁用并逐步移除，因为维护成本高、现代多线程应用收益变小。

**Q4：锁消除和锁粗化是什么？**
> JIT 优化。锁消除：逃逸分析发现锁对象不会被其他线程访问，直接去掉锁（如局部 StringBuffer）。锁粗化：连续多次对同一锁加解锁（如循环内 append），扩大锁范围合并成一次加锁。

**Q5：synchronized 和 ReentrantLock 怎么选？** ⭐
> 默认 synchronized：JVM 内置、自动释放、写法简单、优化充分。需要可超时 tryLock、可中断、公平锁、多个条件队列 Condition 时用 ReentrantLock，代价是必须手动 finally unlock。

**Q6：synchronized 是可重入锁吗？为什么？**
> 是。Monitor 有重入计数 `_recursions`，同一线程再次获取已持有的锁时计数加 1，释放时减 1，到 0 才真正释放。可重入避免了自己调自己的同步方法时死锁。

---

## 一句话总结

> synchronized 把锁状态压进**对象头 Mark Word**，按竞争激烈程度**偏向→轻量级→重量级**逐级升级；
> 配合**自旋、锁消除、锁粗化**，早已不是当年的"重量级"；
> 它和 ReentrantLock 性能相当，差别在"自动 vs 灵活"——而 ReentrantLock 的灵活来自 AQS（文档 09）。
