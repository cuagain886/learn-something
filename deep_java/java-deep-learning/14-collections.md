# 14｜集合框架底层：复杂度、对象布局、缓存局部性与并发语义

> 优先级：S｜难度：★★★★★｜基线：OpenJDK 21｜前置：[08](08-object-layout.md)、[12](12-generics.md)、[15](15-java-memory-model.md)

## 1. 本章目标

能根据数据结构、对象/数组布局、扩容和缓存局部性选集合；能解释 HashMap 索引、resize/treeify 与 mutable key，ConcurrentHashMap 的 CAS/bin lock/协助扩容与 weak consistency；能区分 fail-fast、snapshot、weakly consistent 与 blocking 语义，并从源码关键状态定位问题。

## 2. 先问 workload，不背 O(1)

集合选型至少需要：元素数 N、读写比例、访问模式、key 分布、顺序需求、并发者数量、内存预算、延迟尾部与 mutation 生命周期。

`ArrayList.get` 与 `LinkedList.addFirst` 都可 O(1)，但前者连续引用数组、少对象、CPU prefetch 友好；后者每元素 Node、两引用、pointer chasing 和 GC 压力。渐进复杂度不含常数、cache miss、allocation、resize spike 和锁等待。

## 3. Collection/Map 体系与契约

`Collection` 表示元素容器；`Map` 独立表示 key→value。`Iterator` 是消费协议，`Spliterator` 还描述 split 与 `ORDERED/DISTINCT/SIZED/CONCURRENT/IMMUTABLE` 等 characteristics，Stream 会据此优化。错误声明 characteristic 会产生错误结果，不只是性能差。

集合是否允许 null、重复、稳定顺序、并发修改，要查具体实现。接口的 default method 也不一定为实现提供原子复合语义；ConcurrentMap 会覆盖关键方法建立更强契约。

## 4. ArrayList：数组、size 与结构版本

核心状态（JDK 21 概念）：`Object[] elementData`、逻辑 `size`、继承的 `modCount`。capacity 是数组长度，不是 size。

### 扩容

添加前检查容量，空间不足分配更大数组并复制。具体增长公式属于版本实现（常见约 1.5 倍并处理最小需求/数组上限），不能写成接口保证。扩容时延 O(N)，摊销 append O(1)；p99 敏感批次可按可信上限预分配，但过大 capacity 会保留空引用数组。

`trimToSize` 会复制且下次增长可能再扩，不在每次请求末尾盲用。`clear` 把已用槽设 null 便于元素回收，但底层 capacity 通常保留。

### 插入删除

中间 add/remove 通过 `System.arraycopy` 搬移引用，O(N)；native/intrinsic 连续复制常比链表逐节点遍历快。remove(int) 与 remove(Object) 在 `List<Integer>` 上易重载误用：`remove(1)` 删除 index，`remove(Integer.valueOf(1))` 删除值。

### fail-fast

iterator 记录 expectedModCount，每次关键操作与 modCount 比较并可能抛 `ConcurrentModificationException`。它是 best-effort bug detector，不是同步机制：modCount 非 volatile，race 程序不能依赖“必抛”。iterator 自己的 `remove` 会同步版本。

### subList

是 backed view，set/remove 会反映 parent；parent 在 view 外结构修改可能让 view 后续操作 CME。长期保存小 subList 在某些实现/版本还会保留 parent/底层大数组，需看目标源码与 heap root。

## 5. LinkedList：理论边界与物理成本

双向 Node 保存 item/prev/next，list 保存 first/last/size。已持 Node 的 unlink O(1)，但 public `get(i)/add(i)` 仍需从近端遍历 O(N)。每节点对象 header + 两引用 + item 引用 + alignment，空间远高于数组槽；访问随机、cache locality 差。

Deque 两端频繁操作通常优先 ArrayDeque：环形数组、少分配、局部性好。LinkedList 仅在需要稳定 node identity/频繁已定位节点 splice 等特殊结构考虑，而标准 API 并不暴露 Node。

## 6. HashMap：从 hash 到 bin

OpenJDK 21 使用长度为 2 的幂的 table：

```text
spread = h ^ (h >>> 16)       // 让高位参与低位索引（实现细节）
index  = (capacity - 1) & spread
```

若容量不是 2 的幂，位掩码不能均匀覆盖范围；幂次还让 resize 从 N 到 2N 时节点只需看 `(hash & oldCap)`：为 0 留原 index，为 1 移到 `index + oldCap`，无需重新取模。

### put 路径

1. table 未初始化则 resize/分配；
2. bin 空直接放 Node；
3. 首节点 key 相等则更新；
4. tree bin 走树插入，否则遍历链；
5. 链达到阈值考虑 treeify；容量太小优先扩容；
6. size 超 threshold (`capacity * loadFactor`) 再 resize。

JDK 21 典型实现常量 treeify 8、untreeify 6、minimum treeify capacity 64；这是源码版本细节，不是 Map 规范。红黑树把恶意/坏 hash 的最坏查找从线性改善到对数，但节点更大、比较更复杂；修复 key/hash 仍优先。

### equals/hashCode 不变量

先 hash 定 bin，再 equals 确认 key。相等 key 必须 hash 相等；hash 相等不要求 equals。key 插入后参与 equality/hash 的字段必须不变。

[CollectionsMechanicsLab.java](examples/language/CollectionsMechanicsLab.java) 修改 key id 后：map size 仍 1，但 `get(key)==null`，条目停在旧 bin。它不是 GC leak 定义，却会成为逻辑不可达 retained entry。

### 非线程安全

并发 put/resize/get 没有 JMM 协议，会丢更新、观察不一致；现代 JDK 不应继续用旧版“扩容形成死循环”故事作为唯一解释。任何 race 已足以判错，不需要复现某历史实现 bug。

## 7. LinkedHashMap、TreeMap 与 PriorityQueue

- LinkedHashMap 在 hash nodes 上加 before/after 双链，支持 insertion/access order；可实现单线程 LRU hook，但并发/容量/加载原子性仍需设计。
- TreeMap 是红黑树，按 Comparator/natural ordering 确定 key identity；若 compare==0 但 equals=false，Map 仍视为同 key，contract 必须一致。
- PriorityQueue 是 binary heap，只保证 head 最小/大（按 comparator），迭代不排序；remove arbitrary O(N)，offer/poll O(logN)。可变 priority 会破坏 heap invariant。

## 8. ArrayDeque、CopyOnWrite 与队列

### ArrayDeque

环形数组用 head/tail，双端摊销 O(1)，不允许 null（null 可作为 poll 空标志）。capacity/索引实现随 JDK 变化，不背固定“必须 2 的幂”。Stack/LIFO 新代码优先 Deque，避免旧 `Stack` 的 Vector 继承与接口噪音。

### CopyOnWriteArrayList

写时在锁内复制整个数组并发布新 snapshot；reader 无锁读取稳定数组，iterator 是创建时 snapshot，不抛 CME，也看不到后续写。适合小集合、写极少、遍历远多于更新（listener registry）；写频繁/大集合会复制与 GC 爆炸。

### ConcurrentLinkedQueue

基于 linked nodes + CAS 的非阻塞队列，head/tail 可滞后并通过 traversal 修正；iterator weakly consistent。`size()` 需遍历且并发中只是瞬时值，不用来做严格 admission。

## 9. BlockingQueue 家族

| 实现 | 容量/结构 | 关键适用 |
|---|---|---|
| ArrayBlockingQueue | 固定数组，单/少量 lock + conditions | 有界、内存可预测 |
| LinkedBlockingQueue | linked nodes，可选容量（默认很大） | producer/consumer，必须显式 bound |
| SynchronousQueue | 无存储，直接 handoff | thread pool direct handoff |
| PriorityBlockingQueue | 无界 priority heap | priority；必须外部 admission |
| DelayQueue | 无界 delayed priority | timer/retry；防无限积压 |

`put/take` 响应中断；捕获后应传播取消。`offer(timeout)` 让 deadline 可控。队列“线程安全”不表示业务任务不会过期、重复或取消；元素需要 id/version/deadline。

## 10. ConcurrentHashMap（JDK 8+ 路线）

JDK 7 使用 Segment 分段结构；JDK 8+ 改为 table bin 级机制。不要混讲。JDK 21 核心概念：

- table/`sizeCtl` 协调初始化与 resize；
- 空 bin 用 CAS 安装；
- 非空普通 bin 更新通常 `synchronized` 首节点，锁粒度是 bin；
- `ForwardingNode` 标记迁移 bin并引导查新表；
- 多线程可协助 transfer，降低单线程扩容停顿；
- 冲突高用 `TreeBin` 管理树与访问同步；
- baseCount/counter cells 分散 size 更新竞争（与 Striped64 思路相关）；
- get 大多不锁，依赖 volatile/CAS/monitor 建立发布。

### weak consistency

iterator 不抛 CME，可反映创建以来的一部分更新，不保证全局瞬时 snapshot。要生成审计/账单一致快照，需版本化数据或更高层锁/复制，而不是遍历 CHM。

### computeIfAbsent

对目标 key 的映射安装有原子语义，但 mapping function：

- 可能在内部协调/锁路径执行，慢 I/O 会阻塞相关 bin；
- 不应递归更新同一 key/map，可能抛 `IllegalStateException` 或死锁/复杂行为；
- 失败/返回 null 不安装，后续调用可再次执行；
- 不能把“mapping function 调用次数”当外部副作用 exactly-once 保证。

正确做法是 compute 纯/快值，外部加载用 single-flight + timeout + failure eviction，并接受结果未知/重复语义。

## 11. ConcurrentSkipList 与排序并发结构

ConcurrentSkipListMap 用多层概率索引提供期望 O(logN) 有序操作和范围视图，更新 CAS/协作，迭代 weakly consistent。比锁住 TreeMap 并发扩展好，但节点/索引层空间大；Comparator 必须稳定且与 key identity 契约一致。

DelayQueue/PriorityQueue 使用 heap，不是 skip list；“有序”需区分全迭代顺序、head priority、range query。

## 12. 内存、局部性与复杂度表

| 结构 | 时间直觉 | 空间/局部性 | 并发语义 |
|---|---|---|---|
| ArrayList | get O(1), middle O(N) | 连续引用、扩容峰值 | 无；fail-fast best effort |
| LinkedList | ends O(1), index O(N) | 每元素 Node、差局部性 | 无 |
| HashMap | 平均 O(1) | table + Node/TreeNode | 无 |
| TreeMap | O(logN) | tree node/pointers | 无 |
| ArrayDeque | ends amortized O(1) | 环形数组、好局部性 | 无 |
| COWAL | read O(1), write O(N) | 每次写复制 | snapshot iterator |
| CHM | average O(1) | table/bin/tree/counters | atomic single-key ops、weak iterator |
| SkipListMap | expected O(logN) | node + index levels | weak iterator、range |

Big-O 建立增长趋势；容量规划还要 JOL/heap、allocation rate、cache miss 和 contention。

## 13. 后端与 Agent 选型

- Tool Registry：启动后 immutable Map；动态更新用 immutable snapshot atomic swap 或 CHM，descriptor/version 是 key。
- per-run event buffer：有界 ArrayBlockingQueue/环形缓冲，满时 backpressure/截断/断开策略，不能无界 list。
- retry schedule：DelayQueue 仅适合单进程 transient 调度；可靠重启需持久化 due time/idempotency。
- LRU model/token cache：有容量/weight/expiry/concurrency 的成熟 cache，不手写 `synchronized LinkedHashMap` 忽略 loader stampede。
- Agent state：多字段一致 snapshot 不靠 CHM weak iteration；持久 version/checkpoint。
- tenant index：Comparator/equals/ACL 必须稳定，不能让 mutable user profile 作 key。

## 14. 常见错误与排障

| 现象 | 首查 | 工具/修复 |
|---|---|---|
| heap 大量 HashMap$Node | key 基数、value graph、capacity/load | heap dominator、业务容量 |
| CHM compute 卡顿 | mapping function I/O/递归、hash collision | JFR locks/stack，移出慢加载 |
| queue OOM | 无界 producer>consumer | queue depth/age，bounded admission |
| LinkedList 比 ArrayList 慢 | traversal/cache/allocation | JMH+JFR alloc，不只 Big-O |
| CME | backed view/迭代时结构修改 | owner/同步/copy；不 catch 后重试 |
| TreeMap 丢“不同”key | comparator compare==0 | 修 comparator/equality contract |
| CHM size 控流超限 | size 非事务 snapshot | Semaphore/atomic admission |

## 15. 源码阅读关键路径

固定 `$JAVA_HOME/lib/src.zip`：

- ArrayList：`add/grow/fastRemove/Itr/SubList`；
- HashMap：`hash/putVal/resize/treeifyBin/TreeNode`；
- ConcurrentHashMap：`initTable/putVal/transfer/helpTransfer/TreeBin/computeIfAbsent`；
- ThreadPoolExecutor 与 BlockingQueue 的交互；
- Striped64/counter cells 解释并发 size 近似。

阅读模板：核心 state、不变量、happy path、resize/竞争、iterator 语义、失败/性能；不要从 private constant 推导跨版本 API。

## 16. 实验任务

```powershell
.\labs\compile-and-inspect.ps1
```

`CollectionsMechanicsLab` 已验证 mutable key、backed subList/CME 与 CHM compute。继续：

1. JMH 比较 ArrayList/LinkedList 的顺序遍历、随机 get、两端操作，报告 alloc/cache 解释。
2. 构造坏 hash key，记录链/tree 与延迟；对照修复 hash，不只调容量。
3. 多线程慢 `computeIfAbsent`，抓锁/等待并实现 single-flight+deadline。
4. 有界/无界 BlockingQueue 在 producer overload 下运行，比较 heap、queue age 与拒绝。
5. CHM 遍历同时更新，证明 weak snapshot 不适合审计，再改 versioned snapshot。

## 17. 面试题与检查清单

**Q：HashMap 容量为何常为 2 的幂？** `(n-1)&hash` 索引及 2N resize 的 high-bit split 高效；属于实现设计。

**Q：LinkedList 插入 O(1) 为何常不快？** 先定位 O(N)，Node allocation/pointer/cache miss；只有已定位 node unlink 才 O(1)，标准 API 不暴露 node。

**Q：CHM get 无锁如何安全？** table/bin/value 发布通过 volatile/CAS/monitor JMM 关系；具体字段见目标源码，不能简化为“CAS 实现所有操作”。

- [ ] 选集合前写 workload、order、concurrency、memory。
- [ ] 能解释 HashMap index/resize/treeify 与 mutable key。
- [ ] 不把 fail-fast/weak iterator 当一致 snapshot。
- [ ] CHM mapping function 无慢 I/O/外部副作用。
- [ ] 所有生产队列有容量、等待和拒绝/过期策略。

## 18. 延伸阅读

- [Collections Framework Overview](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/doc-files/coll-overview.html)
- [ConcurrentHashMap API](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ConcurrentHashMap.html)
- [JLS 17.4 Memory Model](https://docs.oracle.com/javase/specs/jls/se21/html/jls-17.html#jls-17.4)
- 目标 JDK 源码：`$JAVA_HOME/lib/src.zip`

下一主线：[15-java-memory-model.md](15-java-memory-model.md)
