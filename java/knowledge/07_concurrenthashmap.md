# 07 · ConcurrentHashMap 原理 ⭐⭐⭐

> "HashMap 线程不安全，那 ConcurrentHashMap 怎么做到既安全又高效？"
> 核心一句话：**JDK 7 用分段锁（Segment），JDK 8 改用 CAS + synchronized 锁单个桶，粒度更细、并发更高。**

---

## 1. JDK 7：分段锁 Segment

```
ConcurrentHashMap
 ├── Segment[0]  (继承 ReentrantLock) → HashEntry[] 小哈希表
 ├── Segment[1]  (锁) → HashEntry[]
 ├── ...
 └── Segment[15] (默认 16 段)
```

- 把整个 map 拆成默认 **16 个 Segment**，每段是一把独立的锁（`ReentrantLock`）。
- 写某个 key 只锁它所在的 Segment，**其他段照常并发** → 理论最高 16 个线程同时写。
- **并发度 = Segment 数量**（默认 16，构造时可设但不可变）。
- 缺点：锁粒度还是"一段"（多个桶共享一把锁），且 Segment 占额外内存，定位要两次 hash。

---

## 2. JDK 8：CAS + synchronized 锁桶 ⭐⭐

抛弃 Segment，结构向 HashMap 看齐（**数组 + 链表 + 红黑树**），但用更细粒度的并发控制：

```
table（Node 数组）
┌────┬────┬────┬────┐
│ 0  │ 1  │ 2  │... │
└─┬──┴─┬──┴────┴────┘
  │    └─ 空桶：CAS 直接放入（无锁！）
  └─ 非空桶：synchronized 锁住【这个桶的头节点】，只锁一个桶
```

### 2.1 put 流程（核心）
```java
1. 算 hash。
2. table 为空 → initTable()（CAS + 自旋保证只初始化一次）。
3. 目标桶为空 → CAS 写入新节点；成功结束，失败则自旋重试（无锁快路径）。
4. 桶正在扩容（头节点是 ForwardingNode，hash=MOVED）→ 当前线程帮忙一起扩容。
5. 桶非空 → synchronized 锁住【桶头节点】，再遍历链表/红黑树插入或覆盖。
6. 链长≥8 且容量≥64 → 树化。
7. addCount：用 CAS + CounterCell 更新元素总数，并判断是否要扩容。
```

### 2.2 为什么用 synchronized 而不是 ReentrantLock
- JDK 6 后 synchronized 经过锁升级优化（偏向/轻量级，见文档 05），低竞争下极快。
- 锁的是单个桶头节点，竞争本就小，synchronized 足够且更省内存（不用每个桶建 Lock 对象）。

### 2.3 锁粒度对比
- JDK 7：锁一个 Segment（一批桶）→ 并发度 = 段数（16）。
- JDK 8：锁一个桶 → 并发度 ≈ 桶数（table 长度），**粒度细得多，扩容后并发还能更高**。

---

## 3. 多线程协助扩容（JDK 8 亮点）

扩容时不是一个线程干，而是**多线程分工协助**：
- 扩容时把 table 分成若干区间，每个线程认领一段来迁移。
- 迁移完的旧桶放一个 **ForwardingNode（hash = MOVED）** 占位，指向新表。
- 别的线程 put 时若发现桶是 ForwardingNode，就知道"在扩容"，于是**也来帮忙迁移**（helpTransfer），干完再继续自己的操作。
- get 遇到 ForwardingNode 会到新表去查，读不阻塞。

---

## 4. 计数：为什么不用一个 size 字段

高并发下，所有线程抢着改一个 `size` 会成为瓶颈。CHM 借鉴 `LongAdder` 思路：
- 用 `baseCount` + `CounterCell[]` 数组**分散计数**，各线程 CAS 更新不同的 CounterCell，减少冲突。
- `size()` 时把 baseCount 和所有 CounterCell 求和。
- 所以 **`size()` 是估算值**，并发下不保证精确（这是设计取舍）。

---

## 5. 读操作为什么不加锁

- Node 的 `val` 和 `next` 都用 **volatile** 修饰 → 写的结果对读立即可见。
- get 全程**无锁**，靠 volatile 可见性保证读到最新值，性能极高。
- 这是"读多写少"场景下 CHM 高效的关键。

---

## 6. 重要特性与坑

- **不允许 null 键或 null 值**（HashMap 允许）。原因：并发下 `get` 返回 null 会有歧义——是"没这个 key"还是"value 就是 null"？无法用 `containsKey` 二次确认（中间可能被改），干脆禁止 null。
- 复合操作要用**原子方法**：`putIfAbsent`、`computeIfAbsent`、`merge` 都是原子的；
  自己写 `if (!map.containsKey(k)) map.put(k, v)` **不是原子的**，并发会出错。
- 弱一致性迭代器：遍历时允许其他线程修改，不抛 `ConcurrentModificationException`，但看到的可能不是最新快照。

```java
// ✓ 原子的并发计数
chm.merge(key, 1, Integer::sum);
// ✗ 非原子，并发下丢更新
if (chm.containsKey(key)) chm.put(key, chm.get(key) + 1);
```

---

## 7. 高频面试题 + 标准答案

**Q1：ConcurrentHashMap 在 JDK 7 和 8 的实现区别？** ⭐⭐
> 7 用分段锁：16 个 Segment 各一把 ReentrantLock，锁一段，并发度=段数。8 抛弃 Segment，结构同 HashMap（数组+链表+红黑树），空桶用 CAS 写入、非空桶用 synchronized 只锁桶头节点，粒度更细、并发更高，还支持多线程协助扩容。

**Q2：JDK 8 为什么用 synchronized 而不是 ReentrantLock？**
> synchronized 经过锁升级优化（偏向/轻量级），低竞争下很快；锁的只是单个桶头节点，竞争小，且不必为每个桶维护 Lock 对象，更省内存。

**Q3：ConcurrentHashMap 的 get 要加锁吗？** ⭐
> 不加锁。Node 的 value 和 next 用 volatile 修饰，保证可见性，读直接读最新值，性能高。

**Q4：为什么 ConcurrentHashMap 不允许 null 键值？** ⭐
> 并发下 get 返回 null 有二义性（key 不存在 vs value 为 null），又无法用 containsKey 安全地二次确认（中间可能被改），所以禁止 null 避免歧义。HashMap 单线程可以用 containsKey 区分，故允许。

**Q5：它的 size() 准吗？**
> 不保证精确。为减少计数热点，用 baseCount + CounterCell 分散计数（类似 LongAdder），size 是各部分求和的估算值，并发修改时可能有偏差。

**Q6：多个线程能同时给 ConcurrentHashMap 扩容吗？** ⭐
> 能。JDK 8 支持协助扩容：table 分区间，各线程认领迁移；迁移完的桶放 ForwardingNode 占位，其他线程 put 时发现正在扩容会一起帮忙迁移，加快扩容。

**Q7：`if(!containsKey) put` 在 CHM 里线程安全吗？**
> 不安全，这是"检查后操作"复合动作，两步之间可能被插入。要用原子的 putIfAbsent / computeIfAbsent / merge。

---

## 一句话总结

> CHM 从 **JDK 7 分段锁（锁一段，并发=16）** 进化到 **JDK 8 CAS+synchronized（空桶 CAS、非空锁桶头，并发≈桶数）**；
> **读无锁靠 volatile**，扩容多线程协助，计数用 CounterCell 分散；
> 不许 null、复合操作用 merge/computeIfAbsent 才原子。
