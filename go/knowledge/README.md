# Go 进阶 & 大厂面试知识点深入文档

> 适用对象：已掌握 Go 基础语法（见仓库根目录 01–20 教程），想深入**底层原理**、应对**大厂面试**的同学。
>
> 每篇文档结构统一：**原理讲解 → 源码/结构剖析 → 代码示例 → 高频面试题 + 标准答案 → 一句话总结**。
> 标 ⭐ 的是面试出现频率最高的考点，标 ⚠️ 的是最容易答错/写错的陷阱。

---

## 📚 章节索引

### 第一部分：数据结构底层原理（面试必考 ⭐⭐⭐）

| # | 文档 | 核心考点 |
|---|------|---------|
| 01 | [切片 slice 底层原理](01_slice_internals.md) | ⭐ 三要素结构、扩容机制（1.18 前后差异）、共享底层数组、值传递陷阱、`append` 返回值 |
| 02 | [map 底层原理](02_map_internals.md) | ⭐ hmap/bmap 结构、渐进式扩容（翻倍 vs 等量）、为什么无序、为什么并发不安全、sync.Map |
| 03 | [channel 底层原理](03_channel_internals.md) | ⭐ hchan 结构、收发流程、关闭语义、nil channel、select 实现 |
| 04 | [interface 底层原理](04_interface_internals.md) | ⭐ eface vs iface、类型断言原理、⚠️ nil interface 陷阱、类型元数据 |
| 05 | [defer / panic / recover](05_defer_panic_recover.md) | ⭐ defer 链表与开放编码、执行顺序、与命名返回值的交互、recover 边界 |

### 第二部分：运行时与内存（大厂区分度高 ⭐⭐⭐）

| # | 文档 | 核心考点 |
|---|------|---------|
| 06 | [GMP 调度模型](06_gmp_scheduler.md) | ⭐⭐ G/M/P 三者关系、本地/全局队列、work-stealing、抢占式调度、`GOMAXPROCS` |
| 07 | [GC 垃圾回收](07_gc.md) | ⭐⭐ 三色标记法、混合写屏障、STW、GC 触发时机、`GOGC` 调优 |
| 08 | [内存分配与逃逸分析](08_memory_alloc_escape.md) | ⭐ mcache/mcentral/mheap、size class、栈 vs 堆、逃逸分析、内存对齐 |

### 第三部分：并发编程与工程实战（高频 ⭐⭐）

| # | 文档 | 核心考点 |
|---|------|---------|
| 09 | [sync 原语深入](09_sync_primitives.md) | ⭐ Mutex 正常/饥饿模式、RWMutex、sync.Pool、atomic、Cond、Once 原理 |
| 10 | [并发模式与陷阱](10_concurrency_patterns.md) | ⭐ 常见并发模型、errgroup、死锁/活锁、goroutine 泄漏、并发安全设计 |
| 11 | [性能优化与 pprof](11_performance_pprof.md) | CPU/内存/阻塞分析、benchmark、常见性能反模式、逃逸优化实战 |
| 12 | [高频面试陷阱题集锦](12_interview_traps.md) | ⚠️ 30+ 道经典手撕题（输出什么？为什么？怎么改）+ 答案解析 |

---

## 🎯 推荐学习路线

```
面试冲刺（2 周）          系统进阶（1 个月）
─────────────          ─────────────
Day 1-3  : 01 02 03      先把 01-05 全部吃透（数据结构是地基）
Day 4-5  : 04 05         再攻 06 07 08（运行时，最能体现深度）
Day 6-8  : 06 07 ⭐重点   然后 09 10（并发是 Go 的招牌）
Day 9-10 : 08 09         最后 11 12（实战与查漏补缺）
Day 11-14: 10 11 12 刷题  ★ 每篇末尾的面试题都要能脱口而出
```

**面试官最爱问的 5 个"灵魂拷问"**（在对应文档里都有详解）：

1. **slice 作为参数传递，函数内 `append` 为什么有时影响外部、有时不影响？** → [01](01_slice_internals.md)
2. **map 为什么是无序的？为什么并发读写会 panic 而不是用锁？** → [02](02_map_internals.md)
3. **goroutine 那么轻量，调度器是怎么管理上百万个的？** → [06](06_gmp_scheduler.md)
4. **Go 的 GC 是怎么做到低延迟的？三色标记 + 写屏障讲一下。** → [07](07_gc.md)
5. **什么情况下变量会逃逸到堆上？怎么排查和优化？** → [08](08_memory_alloc_escape.md)

---

## 🛠️ 配套工具命令（边学边用）

```bash
# 逃逸分析：看哪些变量分配到了堆上
go build -gcflags="-m -l" ./...

# 反汇编：看编译器到底生成了什么（理解 defer/逃逸的利器）
go tool compile -S main.go

# 竞态检测：并发代码必跑
go run -race main.go

# 性能分析三件套
go test -bench=. -benchmem            # 基准测试 + 内存分配统计
go test -cpuprofile=cpu.out -bench=.  # CPU profile
go tool pprof cpu.out                 # 分析 profile

# 查看 GC 行为
GODEBUG=gctrace=1 go run main.go      # 打印每次 GC 的详情
GODEBUG=schedtrace=1000 go run main.go # 每秒打印调度器状态
```

---

## ⚠️ 关于版本

本文档基于 **Go 1.21+**（仓库环境为 Go 1.26）。涉及版本差异的地方会特别标注，常见的几个分水岭：

- **Go 1.13**：错误包装 `%w` / `errors.Is/As`
- **Go 1.14**：基于信号的**异步抢占式调度**（解决了死循环 goroutine 饿死调度器的问题）
- **Go 1.17**：寄存器传参（性能提升）、切片转数组指针
- **Go 1.18**：泛型；切片扩容阈值从 1024 调整、新增 `any`
- **Go 1.21**：`min`/`max`/`clear` 内置函数、`slices`/`maps`/`cmp` 标准库
- **Go 1.22**：循环变量每轮重新声明（修复了著名的闭包捕获坑）

> 面试时如果被问到"你用的哪个版本，有什么新特性"，上面这些是加分项。
