# 11 · ArrayList & LinkedList 源码 ⭐⭐

> "ArrayList 扩容机制？""为什么遍历时删元素会抛异常？""到底什么时候该用 LinkedList？"
> 核心一句话：**ArrayList 是动态数组（扩容 1.5 倍），LinkedList 是双向链表；99% 场景都该用 ArrayList。**

---

## 1. ArrayList：动态数组

### 1.1 底层结构
```java
transient Object[] elementData;   // 真正存元素的数组
private int size;                 // 实际元素个数（≠ 数组长度 capacity）
// 默认容量 DEFAULT_CAPACITY = 10
```

- `new ArrayList()` 时 `elementData` 是**空数组**，**第一次 add 才真正分配长度 10** 的数组（懒初始化，省内存）。
- `size` 是元素个数，`elementData.length` 是容量，两者不同。

### 1.2 扩容机制 ⭐（高频）
```java
// add 时若 size == capacity，触发 grow()
private int newCapacity(int minCapacity) {
    int oldCapacity = elementData.length;
    int newCapacity = oldCapacity + (oldCapacity >> 1);  // 新容量 = 旧容量 × 1.5
    // ... 边界处理
}
```
- **扩容 1.5 倍**（`oldCap + oldCap/2`），不是 2 倍。
- 扩容靠 `Arrays.copyOf` 把旧数组元素**复制到新数组** → 扩容是 O(n) 操作。
- **优化建议**：已知大致元素数量时，用 `new ArrayList<>(预估容量)` 预分配，避免多次扩容拷贝。

### 1.3 增删改查复杂度
| 操作 | 复杂度 | 说明 |
|------|--------|------|
| `get(i)` / `set(i)` | **O(1)** | 数组随机访问 |
| `add(e)`（尾部） | **O(1) 均摊** | 偶尔触发 O(n) 扩容 |
| `add(i, e)` / `remove(i)`（中间） | **O(n)** | 要移动后续元素 |
| `contains` / `indexOf` | O(n) | 顺序查找 |

---

## 2. LinkedList：双向链表

### 2.1 底层结构
```java
transient Node<E> first;   // 头节点
transient Node<E> last;    // 尾节点
private static class Node<E> {
    E item; Node<E> next; Node<E> prev;   // 双向
}
```
- 它同时实现了 `List` 和 `Deque`，所以**可当队列/双端队列/栈**用。

### 2.2 复杂度
| 操作 | 复杂度 | 说明 |
|------|--------|------|
| 头/尾增删 `addFirst/addLast/removeFirst` | **O(1)** | 改指针即可 |
| `get(i)`（按下标） | **O(n)** | 没有随机访问，要从头/尾遍历 |
| 中间插入删除 | O(n) 找位置 + O(1) 改指针 | 找位置是瓶颈 |

---

## 3. ArrayList vs LinkedList ⭐（务必有自己的结论）

| 维度 | ArrayList | LinkedList |
|------|-----------|------------|
| 结构 | 动态数组 | 双向链表 |
| 随机访问 get(i) | **O(1)** ✅ | O(n) ❌ |
| 尾部增删 | O(1) 均摊 | O(1) |
| 头部/中间增删 | O(n)（移动元素） | O(1) 改指针（但找位置 O(n)） |
| 内存 | 紧凑，可能有预留空间 | 每个元素多存两个指针，开销大 |
| 缓存友好 | **好**（连续内存，CPU 缓存命中高） | 差（节点分散） |

> ⚠️ **结论（反直觉但重要）**：教科书说"频繁中间插入用 LinkedList"，但**实践中几乎总是用 ArrayList**。原因：
> 1. LinkedList 中间插入虽是 O(1) 改指针，但**定位**到那个位置要 O(n) 遍历，整体不省。
> 2. ArrayList 连续内存对 **CPU 缓存极友好**，数组复制是高度优化的批量操作，实际比链表遍历快得多。
> 3. LinkedList 每个节点额外两个指针，内存开销大、GC 压力大。
>
> **LinkedList 真正合适的场景极少**：明确只在**两端**操作（用 Deque/队列），且不需要随机访问。即便如此，`ArrayDeque` 通常还更快。

---

## 4. fail-fast 与 modCount ⭐

### 4.1 现象
```java
List<Integer> list = new ArrayList<>(List.of(1, 2, 3));
for (Integer x : list) {        // 增强 for 用的是迭代器
    if (x == 2) list.remove(x); // ⚠️ 抛 ConcurrentModificationException
}
```

### 4.2 原理
- ArrayList 有个 `modCount` 字段，**每次结构性修改**（add/remove）都 +1。
- 创建迭代器时记下 `expectedModCount = modCount`。
- 迭代器每次 `next()` 都检查 `modCount == expectedModCount`，**不等就抛 `ConcurrentModificationException`**。
- 你在遍历中直接调 `list.remove`，改了 modCount 但没同步迭代器的 expectedModCount → 触发 fail-fast。

> "fail-fast"是一种**及早报错**机制：发现迭代期间被意外修改就立刻抛异常，而不是返回错误结果。**单线程遍历时改集合、或多线程并发改都会触发**。

### 4.3 正确的遍历删除
```java
list.removeIf(x -> x == 2);              // ✅ 推荐，一行搞定
// 或用迭代器自己的 remove（它会同步 expectedModCount）
Iterator<Integer> it = list.iterator();
while (it.hasNext()) { if (it.next() == 2) it.remove(); }  // ✅
```

> 并发安全需求用 `CopyOnWriteArrayList`（fail-safe，遍历的是快照，不抛异常但有写时复制开销）。

---

## 5. 其他常见源码点

- **`Arrays.asList()`** 返回的是固定大小的视图（背后是原数组），`add/remove` 抛 `UnsupportedOperationException`，且修改会反映到原数组。要可变就 `new ArrayList<>(Arrays.asList(...))`。
- **`subList()`** 返回的是原列表的视图，改子列表会影响原列表，且原列表结构性修改后子列表失效。
- **`List.of()`**（Java 9+）返回真正不可变列表，不允许 null。

---

## 6. 高频面试题 + 标准答案

**Q1：ArrayList 扩容机制？** ⭐
> 默认初始容量 10（首次 add 才分配）。容量满时扩容为原来的 1.5 倍（oldCap + oldCap>>1），用 Arrays.copyOf 把元素复制到新数组，是 O(n)。已知数据量应预设初始容量避免多次扩容。

**Q2：ArrayList 和 LinkedList 区别？怎么选？** ⭐⭐
> ArrayList 是动态数组，随机访问 O(1)，中间增删 O(n)，内存紧凑缓存友好。LinkedList 是双向链表，两端增删 O(1)，随机访问 O(n)，每节点多两个指针。实践中几乎总用 ArrayList——LinkedList 中间插入虽 O(1) 但定位要 O(n)，且缓存不友好、内存开销大。只在纯两端操作时才考虑，且 ArrayDeque 往往更优。

**Q3：为什么遍历 ArrayList 时 remove 会抛异常？怎么解决？** ⭐⭐
> fail-fast 机制。集合有 modCount 记录结构性修改次数，迭代器创建时记 expectedModCount，每次 next 检查两者是否相等，遍历中直接 list.remove 改了 modCount 导致不等，抛 ConcurrentModificationException。解决：用 removeIf 或迭代器的 it.remove()（它会同步 expectedModCount），并发场景用 CopyOnWriteArrayList。

**Q4：ArrayList 是线程安全的吗？**
> 不是。并发 add 可能丢数据、数组越界。需要线程安全用 CopyOnWriteArrayList（读多写少）或 Collections.synchronizedList（整体加锁）。

**Q5：size 和 capacity 的区别？**
> size 是实际元素个数，capacity（elementData.length）是底层数组长度。capacity ≥ size，多出的是为后续 add 预留的空间。

**Q6：Arrays.asList 返回的 List 能 add 吗？**
> 不能。它是定长视图，add/remove 抛 UnsupportedOperationException。要可变需 new ArrayList<>(Arrays.asList(...)) 包一层。

---

## 一句话总结

> ArrayList = 动态数组，**get O(1)、扩容 1.5 倍 O(n)**；LinkedList = 双向链表，**两端 O(1)、随机访问 O(n)**；
> 实践里**几乎永远选 ArrayList**（缓存友好、定位快）；
> 遍历时改集合触发 **fail-fast（modCount 机制）**，删元素用 **removeIf / 迭代器 remove**。
