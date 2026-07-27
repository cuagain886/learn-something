# 06 · Go 内存与 GC：逃逸、三色标记与防 OOM 五板斧 ⭐⭐⭐⭐

> 对应代码：[`../code/03_memory`](../code/03_memory)（02–05）· 对应实验：[lab_03](../labs/lab_03_memory.md) 实验 4–7
>
> 本章回答：为什么 Go 进程内存不下降？为什么无界队列最终导致崩溃？长上下文/流式输出/大文件怎么处理才不 OOM？——第 05 章是 OS 的账本，本章是 Go runtime 在它上面记的二级账。

## 1. 本章目标

- 掌握逃逸分析的判定规则，会用 `-gcflags='-m'` 验证；
- 理解分配器三级结构（mcache/mcentral/mheap）与 size class 的设计动机；
- 掌握 GC 全流程：三色标记、混合写屏障、两次 STW、GOGC/GOMEMLIMIT、assist；
- 能完整解释"RSS 不下降"的三层原因；
- **工程输出**：防 OOM 五板斧（流式/分块/背压/临时文件/输出限制）落进 Runner。

## 2. 核心概念

### 2.1 栈还是堆：逃逸分析说了算

Go 变量分配在栈还是堆，**不由 new/make 决定，由编译器的逃逸分析（escape analysis）决定**：函数返回后还可能被引用的，就"逃"到堆上。栈分配 ≈ 挪一下栈指针（近乎免费、随函数返回整体蒸发）；堆分配要走分配器还要 GC 来收——**性能优化的第一现场就是减少逃逸**。

高频逃逸场景（可用 `go build -gcflags='-m'` 逐一验证，[02_escape_analysis](../code/03_memory/02_escape_analysis/main.go)）：

```go
func f() *User      { u := User{}; return &u }   // ① 返回局部变量指针 → 逃逸
var sink interface{}                              // ② 存进 interface（如 fmt.Println 的参数）→ 逃逸
                                                  //    (装箱 + 编译器看不穿动态调用)
func g() func() int { x := 0; return func() int { x++; return x } } // ③ 被闭包捕获且闭包外泄 → 逃逸
buf := make([]byte, n)                            // ④ 大小是变量(编译期未知) → 逃逸
big := make([]byte, 10<<20)                       // ⑤ 太大(超过栈上限阈值) → 逃逸
ch <- &obj                                        // ⑥ 发进 channel → 逃逸(去向不可知)
```

⚠️ 两个纠偏：逃逸分析结果**随编译器版本变**（内联更激进后，某些历史上逃逸的现在不逃了）——结论以 `-m` 输出为准，别背静态清单；"零逃逸"不是目标，**热路径上的高频小对象**才值得抠。

### 2.2 分配器：tcmalloc 思想的 Go 实现

第 05 章说 Go 不用 brk，直接 mmap 大块 arena 自己管。管理结构三级（对照第 03 章 GMP——**无锁化的思路一模一样**）：

```text
mcache (每 P 一份, 无锁)      ← 小对象快路径: 从本 P 缓存的 span 里切, 零竞争
   │ 没货了
mcentral (全局, 按 size class 分 68 把锁) ← 补货: 领一个 span 回来
   │ 没货了
mheap (全局大账房)            ← 切新 span; 不够就 mmap 新 arena(64MB) 向 OS 要地
```

- **size class**：小对象按 ~68 个规格档分桶（8B、16B、24B…32KB），一个 span（若干页）只装同规格对象——**用内碎片（平均 ~12%）换免搜索、免外碎片**（对照第 05 章 slab，同一思想）；
- **三条路径**：tiny（<16B 无指针，多个合并进一格）、small（≤32KB 走 size class）、large（>32KB 绕过缓存直接 mheap 拿整 span）——**32KB 是"大对象"的分水岭**（面试常问数字）；
- 对象头没有？Go 对象**没有 per-object header**，类型信息靠指针图（bitmap）+ span 元数据——这也是 GC 扫描方式的伏笔。

### 2.3 GC：并发三色标记 + 混合写屏障

Go GC 是**非分代、非压缩、并发标记清扫**：

**三色不变式**：白（未访问，默认可回收）→ 灰（已发现待扫描）→ 黑（已扫描完）。从根（全局变量、各 G 的栈）出发把可达对象染黑，结束时仍白者回收。

**并发的难题**：标记的同时用户代码（mutator）在改指针——黑对象可能悄悄指向一个白对象（漏标 = 误删活对象，灾难）。解法是**写屏障（write barrier）**：编译器在每次指针写入处插一小段钩子。Go 1.8+ 用**混合写屏障（hybrid barrier）**：被覆盖的旧指针和新写入的指针都标灰（删除屏障 + 插入屏障合体）。⚠️ 它换来的大奖是：**标记结束不再需要重扫各 goroutine 栈**——1.7 以前 STW 里最贵的一项被消灭，STW 从百 ms 级进到 sub-ms 级。

**一轮 GC 的时间线**：

```text
sweep termination ─ STW① (~几十μs): 开写屏障, 扫根准备
concurrent mark   ─ 并发标记: 后台 worker(占 25% CPU 目标) + 【assist】
                    assist: 分配太快的 G 被拉去"帮工"——分配即还债,
                    这是"分配速率影响你请求延迟"的直接机制!
mark termination  ─ STW② (~几十μs): 关写屏障, 收尾
concurrent sweep  ─ 并发清扫: 惰性进行, 分配时顺手清
```

**触发条件**四个：堆增长到目标（下条）、距上次 GC 超 **2 分钟**（sysmon 强制）、`runtime.GC()` 手动、内存逼近 GOMEMLIMIT。

### 2.4 GOGC 与 GOMEMLIMIT：两个旋钮一台戏

- **GOGC（默认 100）**：下次 GC 目标堆 = 活跃堆 × (1 + GOGC/100)。活跃 1GB、GOGC=100 → 堆长到 ~2GB 触发。调大 = 少 GC 省 CPU 费内存；调小反之。**推论：Go 进程稳态内存 ≈ 活跃堆的 2 倍上下，这是"内存看起来偏高"的第一层解释。**
- **GOMEMLIMIT（Go 1.19+）**：软上限（含堆外 runtime 内存）。逼近时 GC 提前、更猛地跑——**专治容器场景**：设为 limit 的 ~90%，把"贴线被 OOM Kill"换成"提前多花 CPU 做 GC"。⚠️ 设太低会 GC 风暴（death spiral 有保护但仍会烧 CPU）；只设 GOMEMLIMIT 常配 `GOGC=off` 的"定内存"玩法要压测验证。
- 版本背景：1.19 前没有 limit，容器里只能拿 GOGC 硬凑（按 limit 反推），automemlimit 类库由此而生；1.19+ 直接用官方旋钮。

### 2.5 "Go 进程内存不下降"的三层完整答案（面试高频）

1. **GC 根本没打算还**：GOGC 模型下堆有目标值，回收的 span 优先留着复用（heap goal 摆在那）；
2. **还了但慢**：后台 **scavenger** 逐步把空闲页 `madvise` 还给 OS。⚠️ 版本考古：Go 1.12–1.15 用 `MADV_FREE`（内核"有空再收"，**RSS 数字不掉**，监控大型冤案）；1.16 起默认改回 `MADV_DONTNEED`（RSS 立刻掉）。老面经说"Go 内存永远不还"就是 MADV_FREE 时代的以讹传讹；
3. **RSS ≠ 堆**：RSS 还含 goroutine 栈（十万 G 的栈很可观）、runtime 元数据、CGO/mmap 的堆外内存——heap profile 干净不代表 RSS 该小。
   排查顺序：`runtime.ReadMemStats`/`/debug/pprof/heap` 看堆 → `HeapIdle-HeapReleased` 看"攥着没还的" → 差额去 CGO/栈/mmap 里找。

### 2.6 sync.Pool、string 转换与逻辑泄漏

- **sync.Pool**：高频大临时对象（buffer、编解码结构）的复用池，**减轻分配压力 = 降低 GC 频率**。机制要点：per-P 本地 + victim cache（两轮 GC 清空，1.13+），所以它是"缓冲 GC 压力"不是"永久缓存"。三陷阱：放回前必须 Reset（脏数据）、放不定长对象会单调膨胀（大 buffer 回来占着）、Get 出来的东西逃逸照旧要注意。
- **string ↔ []byte**：每次转换是一次完整拷贝（string 不可变的代价）。热路径优化：`strings.Builder`（内部免拷贝攒串）、map 查找 `m[string(b)]` 有编译器免拷贝特判、真要零拷贝上 `unsafe.String/Slice`（1.20+，⚠️ 违反不可变约定的后果自负）。
- **逻辑泄漏**（GC 视角没泄，业务视角泄了）：
  ```go
  small := huge[:8]        // ⚠️ 子切片钉住整个大底层数组 → 修: slices.Clone(huge[:8])
  cache[key] = v           // ⚠️ 只增不删的 map → 修: LRU + TTL + 容量上限
  m[k] = struct{}{}        // ⚠️ map 删 key 后 bucket 不缩(Go 1.24 前尤甚) → 修: 定期重建/换 swiss map 版本
  go func(){ <-ch }()      // ⚠️ goroutine 泄漏连带它引用的一切(第03章)
  ```

## 3. 底层原理：三条关键路径

§2 讲了"是什么"，这一节讲"怎么实现的"——理解这三条路径，才能解释性能现象而不只是背结论。

### 3.1 分配路径：一次 `make([]byte, 100)` 到底走了几步

```text
new/make 一个 100 字节对象
   │
   ├─ 编译期: 逃逸分析判定 → 不逃逸就直接在栈上挪指针, 【到此结束, 零成本】
   │
   └─ 逃逸 → runtime.mallocgc()
       ├─ size ≤ 16B 且无指针 → tiny 分配器: 塞进当前 P 的 16B tiny 块剩余空间
       │                        （多个小对象合用一格, 省内碎片）
       ├─ size ≤ 32KB → small: 按 size class 查表(100B → 112B 那一档)
       │   └─ mcache[class].alloc 拿一个空闲 slot  ← 【无锁快路径, ~25ns】
       │       └─ span 满了 → mcentral[class] 领一个新 span（加锁, 该 class 独立锁）
       │           └─ mcentral 也空 → mheap 切（全局锁）
       │               └─ mheap 没地 → mmap 新 arena 向 OS 要（64MB 粒度, syscall）
       └─ size > 32KB → large: 绕过 mcache/mcentral, 直接找 mheap 要整 span
   │
   └─ 分配完成前还要: ① 检查是否该触发 GC（堆到目标了吗）
                      ② 若 GC 正在标记 → 【assist】: 按本次分配量"还债"帮忙标记
```

**三个可解释的现象**：
- 为什么"减少分配"比"调 GOGC"有效？——分配不只是那 25ns，它还牵动 assist（帮 GC 干活）和 GC 触发频率。
- 为什么 32KB 是个分水岭？——大对象绕过两级缓存直接锁 mheap，高频分配大对象等于高频抢全局锁。
- 为什么 `sync.Pool` 能显著提速？——它把整条路径短路成"从 per-P 私有链表取一个"，连 size class 查表都省了。

### 3.2 写屏障：为什么并发标记不会漏标

**问题的本质**：并发标记时，如果 mutator 做出这两件事的组合，活对象会被误判为垃圾——

```text
条件① 黑对象 B 新增了一条指向白对象 W 的引用
条件② 所有指向 W 的其他引用都被删除了
      → W 只剩 B 指向它, 而 B 已扫描完不会再扫 → W 保持白色 → 被回收 → 💥 悬垂指针
```

**Go 1.8 的混合写屏障**在**每次指针写入**时执行（编译器插桩，伪代码）：

```go
writePointer(slot *unsafe.Pointer, ptr unsafe.Pointer) {
    shade(*slot)        // ① 删除屏障: 把【被覆盖的旧值】标灰 → 破坏条件②
    if 当前 G 的栈是黑色 {
        shade(ptr)      // ② 插入屏障: 把【新写入的值】标灰 → 破坏条件①
    }
    *slot = ptr
}
```

⚠️ **关键取舍**：混合屏障要求**GC 开始时把所有 goroutine 栈一次性扫黑**（并在此后保持黑色），代价是每个 G 要短暂停一下扫栈；换来的是**标记结束时不必重扫栈**——而重扫栈必须 STW 且时间与栈数量成正比。Go 1.7 的 STW 是百毫秒级，正是被这一项拖累；1.8 之后 STW 稳定在几十微秒。

**工程含义**：写屏障在 GC 期间对**每次指针写**都有开销（约几纳秒）。所以指针密集的数据结构（链表、树、大量 `map[string]*T`）在 GC 期间比值类型结构更慢——这是"用 `[]T` 而不是 `[]*T`"这条优化建议的底层依据。

### 3.3 Pacer：GC 什么时候开始跑

GC 不能等堆到达目标才开始——那时已经晚了（标记要花时间，期间还在分配）。**Pacer（步调控制器）**的工作是：**预测**要提前多久启动，使得标记结束时堆恰好接近目标。

```text
目标堆大小 = 活跃堆 × (1 + GOGC/100)        # GOGC=100 → 活跃堆的 2 倍
实际触发点 = 目标 × 某个比例（由 pacer 根据上一轮的标记速度和分配速度动态算）

标记进行中，如果分配速度超出预期：
   → 触发 assist：分配 N 字节的 G 必须帮忙标记 N×比例 的对象
   → 效果是【分配越快，你自己被拖得越慢】—— 一个自动的负反馈闸门
```

⚠️ **这解释了一个常见困惑**："我的服务 P99 毛刺对齐 GC 周期，但 STW 只有 50μs，为什么会毛刺？" 答案通常不是 STW，而是：① **assist**——分配大户被拉去帮工，那次请求就慢了；② 标记期后台 worker 占用 **25% CPU 目标**，留给业务的算力少了。`go tool trace` 里能直接看到 `MARK ASSIST` 区间归属于哪个 G。

**GOMEMLIMIT 如何介入**：它给 pacer 加了第二个约束——当"堆 + 堆外内存"逼近 limit 时，即使还没到 GOGC 的目标堆也强制开始 GC，且会跑得更频繁。极端情况下（活跃堆本身就逼近 limit）会陷入连续 GC，Go 有保护机制限制 GC 的 CPU 占用不超过 50%，但此时服务已经不健康了——**GOMEMLIMIT 是安全网，不是容量规划的替代品**。

## 4. 关键工程设计：防 OOM 五板斧（Agent 场景主战场）

goal 里列的每个 Agent 内存事故，都能映射到五板斧之一（示例 [05_stream_backpressure](../code/03_memory/05_stream_backpressure/main.go)）：

| 板斧 | 机制 | 治什么 |
|---|---|---|
| **① 流式** | io.Reader/Writer 管道化，永不 `ReadAll` 不可信大小的东西 | 2GB 上传文件、大模型流式输出攒全量 |
| **② 分块** | 固定 chunk 循环处理（bufio 64KB 级），复用缓冲 | 工具日志逐行转发、大文件逐块哈希 |
| **③ 背压** | 有界队列 + 满则阻塞/拒绝（第 04 章 worker pool） | 未消费的 channel、无界队列、生产>消费 |
| **④ 临时文件** | 超过阈值落盘（spooling），内存只留索引/游标 | 截图与二进制产物、需要回放的大输出 |
| **⑤ 输出限制** | 截断写入器：超上限截断+标记 truncated+可选杀任务 | 工具 `yes`/死循环日志刷爆内存 |

```go
// 板斧⑤的核心 30 行: 有上限的输出收集器 —— Runner 每个任务一个
type CappedBuffer struct {
    mu        sync.Mutex
    buf       bytes.Buffer
    limit     int
    Truncated bool
}
func (c *CappedBuffer) Write(p []byte) (int, error) {
    c.mu.Lock(); defer c.mu.Unlock()
    if room := c.limit - c.buf.Len(); room > 0 {
        if len(p) > room { p = p[:room]; c.Truncated = true }
        c.buf.Write(p)
    } else { c.Truncated = true }
    return len(p), nil // ⚠️ 对外永远"写成功": 丢弃超额而不是报错——
}                      //    子进程不该因为我们限额而写失败崩溃(它继续跑, 我们只是不存)
```

配套决策：Truncated 置位后可选择继续跑（保留退出码）或直接取消任务（省资源）——写进任务策略而不是拍脑袋。

## 5. Go 语言示例

| 示例 | 演示内容 |
|---|---|
| [02_escape_analysis](../code/03_memory/02_escape_analysis/main.go) | 六种逃逸场景 + `-m` 输出解读 + 分配计数实测 |
| [03_gc_observe](../code/03_memory/03_gc_observe/main.go) | ReadMemStats 逐字段、GOGC 对比、GOMEMLIMIT 演示、FreeOSMemory 与 HeapReleased |
| [04_leak_patterns](../code/03_memory/04_leak_patterns/main.go) | 子切片钉数组 / 只增 map 两种逻辑泄漏的测量与修复 |
| [05_stream_backpressure](../code/03_memory/05_stream_backpressure/main.go) | ReadAll vs 流式的 RSS 对比、CappedBuffer、有界队列背压 |

gctrace 读法（[lab_03](../labs/lab_03_memory.md) 实验 5 逐字段练）：

```text
GODEBUG=gctrace=1 ./app
gc 18 @6.068s 2%: 0.058+1.2+0.083 ms clock, 0.70+1.5/2.1/0+1.0 ms cpu, 7->8->4 MB, 8 MB goal, 12 P
      │       │   └ STW① + 并发标记 + STW② (clock 时间)      │           └ 下次触发目标
      │       └ GC 累计占用 CPU 百分比                        └ 标记开始堆→标记结束堆→存活堆
      └ 第 18 轮 —— 关注: 频率(间隔)、STW 是否 sub-ms、存活堆是否持续爬升(泄漏曲线)
```

## 6. 后端开发中的应用

- **GC 调优的正确顺序**：先降分配（逃逸、复用、Builder、Pool）→ 再动旋钮（GOGC/GOMEMLIMIT）→ 最后才考虑 off+定期手动这类偏方。90% 的"GC 吃 CPU"是分配速率问题不是参数问题——gctrace 里 GC 间隔短到秒级就是铁证。
- **延迟毛刺与 assist**：P99 毛刺对齐 GC 周期 → 嫌疑不是 STW（sub-ms）而是 **assist**（分配大户被拉去帮工）+ 标记期 25% CPU 被借走。`go tool trace` 里能直接看到 MARK ASSIST 段。
- **容器标准配置**：`GOMEMLIMIT = limit × 0.9`（留 CGO/栈/突发余量）+ 默认 GOGC——比裸奔或调 GOGC 硬凑都稳。

## 7. Agent 开发中的应用

- **上下文与流式的内存纪律**：LLM 流式 chunk 转发即丢，绝不在内存里攒全量对话史（要持久化就边收边落盘/入库——板斧①④）；上下文窗口管理（截断/摘要）在数据结构上就是"有界"思想对 token 的应用。
- **每任务内存预算**：输出上限（板斧⑤）+ 队列有界（③）+ 大产物落盘（④）三件套让单任务内存可估算 → 并发数 × 单任务预算 < GOMEMLIMIT，整条链路才有资格谈稳定。
- **进程内限额挡不住不可信代码**：工具子进程 malloc 失控不归 Go 管——那是 cgroup memory.max 的辖区（第 11 章）。五板斧管自己，cgroup 管别人，两层缺一不可。

## 8. 常见问题与错误设计

**错误 1：循环里 `+` 拼接字符串。** 每次 + 都是新分配+双向拷贝，O(n²)。修：strings.Builder（预 Grow 更佳）。

**错误 2：sync.Pool 当对象缓存/连接池用。** 两轮 GC 就清空，命中率随 GC 波动；连接这种有状态资源更不能进 Pool。它只是**分配压力缓冲器**。

**错误 3：io.ReadAll 一切。** `resp.Body`、子进程输出、上传文件——大小不可信的一律流式+上限。`ReadAll` 只配读已知小的东西。

**错误 4：手动 `runtime.GC()`/`FreeOSMemory()` 当保健品。** 周期性手动 GC 打乱 pacer 节奏白烧 CPU；FreeOSMemory 只在"刚释放巨量内存且短期不再用"的特殊时点有意义（如大任务结束后主动还地）。

## 9. 排障方法

**案例：服务 RSS 一周从 800MB 爬到 3GB，无 OOM 但被容量报警。**
- **现象**：RSS 单调爬升；gctrace 显示存活堆（第三个数字）同步爬升——排除"攥着不还"，是真增长。
- **验证**：
  ```bash
  curl -s localhost:6060/debug/pprof/heap > h1; sleep 3600; curl -s ... > h2
  go tool pprof -base h1 h2      # diff 视角: 一小时净增长在哪
  (pprof) top --cum              # inuse_space 排序, 直指增长栈
  ```
  ⚠️ 两个视角别搞混：`inuse_space`（现在还活着的，找泄漏用它）vs `alloc_space`（历史累计分配，找 GC 压力用它）。
- **常见判决**：增长栈落在某 map 赋值 → 只增不删缓存（修 LRU）；落在 bytes.growSlice 且引用链是某全局 slice → 无界队列/攒 buffer；heap 干净但 RSS 涨 → 跳 2.5 第三层（goroutine 栈/CGO），用 `/debug/pprof/goroutine` 数量与 `mstats.StackSys` 交叉验证。
- **解决与回归**：修复后 48h 观察 RSS 平台期 + gctrace 存活堆走平。

## 10. 实验任务

[lab_03_memory.md](../labs/lab_03_memory.md) 实验 4–7：④ `-m` 验证六种逃逸；⑤ gctrace 逐字段解读 + GOGC 对比曲线；⑥ heap profile 双视角 + base diff 定位注入的泄漏；⑦ ReadAll vs 流式的 RSS 实测（板斧验证）。

## 11. 面试题（附答题要点）

**Q1：逃逸分析是什么？哪些情况会逃逸？**
要点：编译期决定栈/堆，"函数结束后仍可能被引用"即逃逸；背四大类——返回指针、进 interface（fmt 系）、被外泄闭包捕获、大小不定或过大；用 `-gcflags='-m'` 验证。加分：栈分配随返回整体蒸发所以便宜；结论随版本变，热路径小对象才值得抠。

**Q2：描述 Go 的内存分配器。**
要点：tcmalloc 思想三级——mcache（per-P 无锁）→ mcentral（按 class 分锁）→ mheap（mmap arena）；size class ~68 档换免搜索；tiny/small/large 三路径，32KB 分水岭。加分：与 GMP 的 per-P 无锁化一脉相承；内碎片 ~12% 是设计成本。

**Q3：三色标记怎么工作？为什么需要写屏障？混合写屏障解决了什么？**
要点：白灰黑推进 + 三色不变式；并发标记时 mutator 改指针会造成"黑指白"漏标 → 写屏障兜底；混合屏障（1.8）= 删除+插入合体，**免栈重扫**，STW 进 sub-ms。加分：说出两次 STW 的位置和量级；assist 机制（分配即还债 → 延迟毛刺来源）。

**Q4：GOGC 和 GOMEMLIMIT 怎么配？**
要点：GOGC 定倍率（目标=活×2 默认）→ 稳态内存≈活堆两倍；GOMEMLIMIT（1.19+）软上限含堆外，容器设 limit×0.9 防 137。加分：limit 逼近时 GC 提前发力的行为、GC 风暴保护、1.19 前 automemlimit 的历史。

**Q5：为什么 Go 进程内存不下降？**
要点：三层——GC 留堆复用（GOGC 目标）；scavenger 慢还 + MADV_FREE/DONTNEED 版本考古（1.16 分水岭，RSS 显示差异）；RSS 含栈/元数据/CGO 非堆部分。能分层答 + 给排查顺序（MemStats → HeapIdle-Released → 堆外）就是满分。

**Q6：sync.Pool 的原理和陷阱？**
要点：per-P 本地 + victim cache 两轮 GC 清空 → 是 GC 压力缓冲不是缓存；三陷阱（Reset、不定长膨胀、有状态资源禁入）。加分：1.13 的 victim 机制让 GC 时不再全清，抖动改善。

**Q7：string 和 []byte 转换的成本？怎么优化？**
要点：不可变性 → 转换必拷贝；Builder 攒串、`m[string(b)]` 编译器特判免拷贝、unsafe.String/Slice（1.20+）零拷贝但契约自负。加分：不可变换来的是可安全共享/做 map key/哈希缓存。

## 12. 本章总结

- 逃逸分析定生死：栈上免费、堆上要养 GC；`-m` 是唯一真相来源。
- 分配三级（mcache/mcentral/mheap）+ size class：per-P 无锁思想与 GMP 同源；32KB 是大对象分水岭。
- GC = 并发三色 + 混合写屏障 + 两次 sub-ms STW；GOGC 定倍率、GOMEMLIMIT 兜底线、assist 把分配速率变成你的延迟。
- "内存不下降"三层答案；防 OOM 五板斧（流式/分块/背压/落盘/限额）是 Agent 内存纪律的全部。

**检查清单**：
- [ ] 我能对任意一段代码预判逃逸并用 -m 验证
- [ ] 我能画出一轮 GC 时间线（两次 STW 的位置、assist 在哪发生）
- [ ] 我能逐字段读 gctrace，并从 7->8->4 里读出存活堆趋势
- [ ] 我能分层背出"内存不下降"三个原因和排查顺序
- [ ] 我的 Runner 五板斧齐备：任何工具输出/文件/队列都有界

## 13. 延伸阅读

- Go 官方：*A Guide to the Go Garbage Collector*（gc guide，必读）
- 《Go 语言设计与实现》内存分配器/GC 章节
- Go blog: *Go GC: Prioritizing low latency*、GOMEMLIMIT 提案 issue #48409
- 本仓库 `go/knowledge/07_gc.md`、`08_memory_alloc_escape.md`、`23_allocator_gc_pacer.md`（pacer 数学）
- 上一章 [05 内存管理](05_memory_management.md)——OS 侧账本
