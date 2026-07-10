# 02 · map 底层原理 ⭐⭐⭐

> map 的考点集中在三个"为什么"：**为什么无序？为什么并发读写直接 panic？为什么 key 必须可比较？** 答好这三个，底层基本就通了。

> **版本说明：** 本文的 `hmap/bmap`、overflow bucket 和旧式渐进扩容描述适用于 Go 1.23 及更早实现。Go 1.24+ 已迁移到 Swiss Table；仓库当前 Go 1.26.4 的实现请学习 [24 · Swiss Table map](24_map_swiss_table.md) 与对应实验 [`32_map_swiss_table`](../code/32_map_swiss_table)。语言层的无序、可比较键和并发同步要求仍有效。

---

## 1. 旧版底层结构：哈希表 + 桶（bucket）

Go 1.23 及更早版本的 map 主体是 `runtime/map.go` 里的 `hmap`：

```go
type hmap struct {
    count     int    // 元素个数，len(map) 直接返回它
    flags     uint8  // 状态标志：是否正在写、是否正在扩容（用于并发检测！）
    B         uint8  // 桶数量的对数：桶数 = 2^B
    noverflow uint16 // 溢出桶的大致数量
    hash0     uint32 // 哈希种子，每个 map 不同 → 防哈希碰撞攻击
    buckets    unsafe.Pointer // 桶数组指针，指向 2^B 个 bmap
    oldbuckets unsafe.Pointer // 扩容时指向旧桶数组（渐进式迁移用）
    nevacuate  uintptr        // 扩容迁移进度
    extra      *mapextra      // 溢出桶管理
}
```

每个桶 `bmap` 固定存 **8 个键值对**：

```go
type bmap struct {
    tophash [8]uint8  // 8 个 key 哈希值的高 8 位（快速比较用）
    // 编译期追加（内存布局）：
    // keys     [8]keytype     ← 8 个 key 连续存放
    // values   [8]valuetype   ← 8 个 value 连续存放（key/value 分开存，省内存对齐）
    // overflow *bmap          ← 溢出桶指针，桶满了就挂链表
}
```

```
hmap.buckets ─▶ [bucket0][bucket1][bucket2]...   (2^B 个桶)
                    │
                    ▼ 一个 bucket（bmap）
                ┌─────────────────────────────────┐
                │ tophash[8]                       │
                │ key0 key1 ... key7  (8 个 key)   │
                │ val0 val1 ... val7  (8 个 value) │
                │ overflow ─▶ 下一个溢出桶（链表）   │
                └─────────────────────────────────┘
```

**为什么 key 和 value 分开连续存？** 比如 `map[int8]int64`，若按 `(k,v)(k,v)` 排列，每个 int8 后面要填 7 字节对齐；分开存就只需在最后对齐一次，**节省内存**。这是个不错的加分细节。

---

## 2. 查找流程：怎么定位一个 key

```
key ──hash(key, hash0)──▶ 64 位哈希值
                            │
        ┌───────────────────┼────────────────────┐
        ▼ 低 B 位                                  ▼ 高 8 位
   定位到哪个桶 (& (2^B - 1))            桶内比对 tophash 快速筛选
                                              │ tophash 命中
                                              ▼
                                       再逐字节比较完整 key 确认
```

1. 用哈希值的**低 B 位**确定落在哪个桶。
2. 用哈希值的**高 8 位（tophash）**在桶内 8 个槽快速比对——不等就跳过，避免每次都全量比较 key。
3. tophash 相等再比完整 key（防哈希冲突）。
4. 桶内 8 个满了还没找到，就沿 `overflow` 链表去溢出桶继续找。

---

## 3. 扩容机制 ⭐（渐进式 + 两种触发）

### 两种扩容

| 类型 | 触发条件 | 做什么 |
|------|---------|--------|
| **翻倍扩容** | 负载因子 > 6.5（`count / 2^B > 6.5`，元素太多） | 桶数 ×2（B+1），重新分布元素 |
| **等量扩容** | 溢出桶太多（哈希分布不均/大量删除留下空洞） | 桶数不变，**重新整理**，把元素紧凑排列，回收溢出桶 |

> **负载因子为什么是 6.5？** 这是空间和时间的权衡：太大则桶内冲突链太长查找慢，太小则浪费内存。6.5 是官方实测的平衡点。

### 渐进式扩容（rehash）⚠️ 重要

扩容**不是一次性搬完**（否则有几百万 key 时会卡顿 STW）。而是：

- 扩容时 `oldbuckets` 保留旧桶，分配新桶。
- **每次对 map 做写操作（增/删/改）时，顺手迁移 1~2 个旧桶**到新桶。
- 读操作时如果数据还在旧桶，去旧桶读。
- 直到所有旧桶迁移完，`oldbuckets` 置空。

这就是"渐进式"——把一次大停顿摊薄到多次操作里，保证单次操作延迟可控。

```go
// 观察扩容（间接）：预分配容量可避免多次扩容
m := make(map[int]int, 1000) // ★ 已知大小就预分配，省去多次 rehash
for i := 0; i < 1000; i++ {
    m[i] = i
}
```

---

## 4. ⭐ 三个"为什么"

### 为什么 map 是无序的？

两个原因：
1. **哈希分布本身**就是散列的，key 落在哪个桶不可预测。
2. **Go 故意的**：`for range` 遍历时，runtime 会随机选一个起始桶和起始槽位（`fastrand`）。这是**刻意设计**，目的是防止程序员依赖遍历顺序写出脆弱代码。

```go
m := map[string]int{"a": 1, "b": 2, "c": 3}
for k := range m { fmt.Print(k, " ") } // 每次运行顺序都可能不同
```

**要有序怎么办？** 取出 key 到切片，`sort.Strings(keys)` 排序后再遍历（见 [07_maps 教程](../code/07_maps/main.go)）。

### 为什么并发读写直接 panic 而不是加锁？⭐⭐

```go
m := map[int]int{}
go func() { for { m[1] = 1 } }()   // 写
go func() { for { _ = m[1] } }()   // 读
// fatal error: concurrent map read and map write
// 注意是 fatal error，recover 都救不了！
```

**设计哲学**：Go 团队认为**绝大多数 map 使用场景是单 goroutine 的**，如果给 map 内置锁，会让所有人（包括不需要并发的）付出性能代价。所以选择"默认不加锁、并发使用是你的责任"。

**检测原理**：`hmap.flags` 有个 `hashWriting` 位，写操作开始时置位、结束时清除。任何读/写操作进来先检查这个位——发现别人正在写，立即 `throw`（fatal error，无法 recover）。这是一种**快速失败（fail-fast）**机制，把潜在的数据损坏暴露成显式崩溃。

**并发安全方案**：
1. `sync.RWMutex` + 普通 map（读多写少，最常用）。
2. `sync.Map`（见下）。
3. 分片锁（sharded map，超高并发时减少锁竞争）。

### 为什么 key 必须可比较？

map 要用 `==` 判断 key 是否相等。所以 **slice、map、function 不能做 key**（它们不支持 `==`）。可以做 key 的：基本类型、指针、channel、接口、以及**字段全可比较的**数组和结构体。

```go
m1 := map[[2]int]string{{1, 2}: "ok"}  // ✓ 数组可比较
// m2 := map[[]int]string{}             // ✗ 编译错误：slice 不可比较
```

---

## 5. sync.Map：什么时候用？⭐

`sync.Map` 不是"加了锁的 map"，它针对**特定场景**做了优化（空间换时间、读写分离）：

```go
var sm sync.Map
sm.Store("key", 100)            // 写
v, ok := sm.Load("key")         // 读
sm.LoadOrStore("key", 200)      // 不存在才写
sm.Delete("key")                // 删
sm.Range(func(k, v any) bool {  // 遍历（返回 false 停止）
    fmt.Println(k, v)
    return true
})
```

**内部原理**：维护 `read`（只读，原子访问无锁）和 `dirty`（加锁）两个 map。读命中 read 时完全无锁；写或 read 未命中才碰锁。

**适用场景**（官方明确说明）：
1. **读多写少**，且 key 集合相对稳定（缓存类）。
2. 多个 goroutine 读写**不相交的 key 集合**。

> ⚠️ **不要无脑用 sync.Map**！普通场景下 `RWMutex + map` 往往更快、类型更安全（sync.Map 的 key/value 是 `any`，有装箱开销和断言成本）。面试问到要能说清"它不是银弹，只适合读多写少"。

---

## 6. 面试速答清单

| 问题 | 一句话答案 |
|------|-----------|
| map 底层结构？ | hmap + 桶数组，每桶 8 个 kv + tophash + overflow 链 |
| 怎么定位 key？ | 低 B 位选桶，高 8 位 tophash 桶内快筛，再比完整 key |
| 扩容时机？ | 负载因子 >6.5 翻倍扩容；溢出桶过多则等量扩容（整理） |
| 渐进式扩容？ | 每次写操作迁移 1-2 个旧桶，摊薄停顿，避免一次性 rehash 卡顿 |
| 为什么无序？ | 哈希散列 + range 随机起点（Go 刻意防依赖顺序） |
| 并发为什么 panic？ | flags 写标志位 fail-fast，throw fatal error（recover 无效）；默认不加锁是性能取舍 |
| sync.Map 适用？ | 读多写少 / key 不相交；普通场景 RWMutex+map 更优 |
| key 限制？ | 必须可比较，slice/map/func 不行 |

---

## 一句话总结

> **稳定语义是无序、键必须可比较、并发写需同步；旧版实现是 hmap/bmap，新版 Go 1.24+ 是 Swiss Table。要并发用所有权、Mutex/RWMutex 或适用场景下的 sync.Map。**

➡️ 上一篇：[01 · 切片](01_slice_internals.md) ｜ 下一篇：[03 · channel 底层原理](03_channel_internals.md)
