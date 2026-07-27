# 03 · 线程、协程与调度：从上下文切换到 GMP ⭐⭐⭐⭐

> 对应代码：[`../code/02_concurrency`](../code/02_concurrency)（01_goroutine_leak、02_cpu_starvation）· 对应实验：[lab_02](../labs/lab_02_goroutine.md)
>
> 本章回答：goroutine 为什么比线程轻量？goroutine 多是否一定性能更好？一个 goroutine 阻塞时为什么不一定阻塞整个程序？CPU 密集型 goroutine 为什么可能影响其他请求？如何定位 goroutine 泄漏？

## 1. 本章目标

- 说清线程与进程在内核里的真实关系（clone 共享标志）；
- 量化上下文切换的成本构成，理解"为什么要发明协程"；
- 掌握 GMP 模型：G/M/P 各是什么、调度循环、work stealing、两代抢占、syscall 时的 P 交接；
- 能定位 goroutine 泄漏，能解释 CPU 密集任务对延迟的伤害；
- 能正确设置容器里的 GOMAXPROCS（含 Go 1.25 之后的行为变化）。

## 2. 核心概念

### 2.1 线程 = 共享地址空间的"进程"

第 02 章说进程 = task_struct + 资源。**Linux 内核里没有独立的"线程"概念**——线程就是创建时选择"共享"而非"复制"的 task_struct：

```text
fork()   ≈ clone(SIGCHLD)                      # 什么都复制 → 进程
pthread_create ≈ clone(CLONE_VM | CLONE_FILES  # 共享地址空间、fd 表、
               | CLONE_SIGHAND | CLONE_THREAD…)#  信号处理、同一线程组 → 线程
```

所以：同进程的线程**共享**——地址空间（堆、全局变量）、fd 表、信号处理；**各有**——栈、寄存器上下文、内核调度实体、errno。这一句解释了并发编程的一切苦难：**共享堆 = 需要同步（第 04 章）；各有栈 = 切换要换栈**。

PID 语义补一刀（面试易错）：内核给每个线程一个唯一 task id（`gettid`），线程组共享 tgid（= 首线程 tid）。**用户看到的 "PID" 其实是 tgid**，`ps -T`/`top -H` 才能看到线程级的 tid。Go 程序 `top` 里一个 PID，`top -H` 下面挂着十几个线程（M）。

### 2.2 上下文切换的成本账单

上下文切换（context switch）= 保存当前执行流的现场，装载另一个的。成本分两笔：

| | 直接成本 | 间接成本（大头） |
|---|---|---|
| 内容 | 陷入内核、保存/恢复寄存器、切换内核栈、选下一个任务（调度器决策）、（跨进程时）切页表 | L1/L2/TLB 里全是旧任务的数据 → 新任务开局全是缓存 miss |
| 量级 | 1–2 μs（同进程线程间） | 数 μs 到数十 μs 等效损耗，取决于工作集大小 |

⚠️ 数量级记忆锚点：**函数调用 ~1ns，goroutine 切换 ~100–200ns，线程切换 ~1–2μs+缓存损耗**。三者各差一个数量级——这张表是"为什么 M:N"的物理依据。

线程切换为什么必须进内核？因为调度器在内核里（时钟中断驱动，第 01 章三扇门）。而协程切换是**用户态的函数调用级操作**：保存少量寄存器、换个栈指针就完事，不陷入、不惊动内核——这就是轻量的第一来源。

### 2.3 抢占、时间片与两类任务

- **抢占式调度（preemptive）**：内核靠时钟中断周期性夺回 CPU，按策略（Linux 主力是 CFS，公平分配虚拟运行时间）决定下一个跑谁。时间片不是固定值，CFS 按"权重占比 + 目标延迟"动态算，nice 值调权重（第 10 章）。
- **CPU 密集型（CPU-bound）**：一拿到 CPU 就用满时间片（视频转码、加密、大 JSON 序列化）。特征：延迟敏感的邻居会被它拖累。
- **I/O 密集型（I/O-bound）**：跑一小会儿就阻塞等数据（典型 Web 后端）。特征：CPU 使用率不高但对调度延迟极敏感。

**多核并行**让"并发"变"并行"：4 核同一瞬间真的有 4 个执行流。**超线程（SMT/Hyper-Threading）**：一个物理核伪装成 2 个逻辑核，共享执行单元——一个流缓存 miss 停顿时另一个补位。⚠️ 收益典型 10–30%，绝不是 2 倍；压测标机时要按物理核算容量。

### 2.4 三种线程模型：为什么殊途同归到 M:N

| 模型 | 含义 | 代表 | 命门 |
|---|---|---|---|
| M:1 | M 个用户协程 ↤ 1 个内核线程 | 早期绿色线程 | 一个 syscall 阻塞 → 全体卡死；用不了多核 |
| 1:1 | 1 用户线程 = 1 内核线程 | pthread、Java 传统线程 | 创建/切换/内存全是内核价，万级并发就撑不住 |
| M:N | M 个协程复用 N 个内核线程 | **Go goroutine**、Java 21+ 虚拟线程 | 实现复杂：要自建调度器，处理阻塞、抢占 |

M:N 的精髓：**用户态调度器把"海量便宜的执行流"复用到"少量昂贵的内核线程"上**，syscall 阻塞、抢占这些脏活由 runtime 兜底——Go 的兜底方案就是 GMP。

## 3. 底层原理：GMP 深讲

### 3.1 G、M、P 各是什么

```text
G (goroutine)  执行流本体：栈(2KB 起步)、程序计数器、状态。便宜，可以百万个。
M (machine)    OS 线程的化身：真正在 CPU 上跑的实体。默认上限 10000（SetMaxThreads）。
P (processor)  逻辑处理器 = 调度上下文 + 资源包：本地运行队列(容量256)、mcache(内存
               分配缓存, 第06章)、定时器堆。数量 = GOMAXPROCS，默认 = 可用 CPU 数。

铁律：M 必须持有一个 P 才能执行 Go 代码。  M ←绑定→ P ←取出→ G
```

**为什么要发明 P？（面试必考）** 没有 P 的旧版调度器（Go 1.0）只有一个全局队列，所有 M 抢一把全局锁——多核下锁竞争把并行优势吃光。P 带来三件宝：
1. **本地队列**：每个 P 私有 runq，取 G 无锁（仅 steal 时用原子操作）；
2. **资源分片**：mcache 挂在 P 上，内存分配也无锁化（第 06 章）；
3. **并行度旋钮**：P 的数量精确控制"同时有几个 M 在跑 Go 代码"，与 M 的数量解耦（M 可以因 syscall 阻塞而临时增多，但跑 Go 代码的永远 ≤ GOMAXPROCS 个）。

### 3.2 调度循环：一个 G 跑完了，下一个从哪来

M 执行完/挂起一个 G 后进入 `schedule()` 找下一个，优先级顺序（Go 1.2x 实现）：

```text
① P.runnext        刚被唤醒/新建的"插队位"(改善局部性: 生产者刚 ready 的 G 趁热跑)
② P 本地队列        无锁弹出
③ 全局队列          每 61 次调度强制查一次(防全局队列饿死) + 本地空时查
④ netpoller        网络就绪的 G(第08章: epoll 事件转成可运行 G)
⑤ work stealing    随机挑受害者 P, 偷走它本地队列的一半
⑥ 都没有 → M 休眠(停车场), P 进空闲列表
```

**work stealing 的设计感**：偷"一半"而不是一个——摊薄偷窃开销；随机选受害者——避免固定模式下的持续冲突。效果：负载自动均衡，无需中央协调者。

### 3.3 抢占：从"君子协定"到"强制执行"

**协作式（Go ≤1.13）**：编译器在函数序言插检查（栈增长检查顺带看抢占标志）。致命伤：`for i:=0;i<1e10;i++ {}` 这种无函数调用的紧循环**永远不到检查点**——一个 G 霸占 P，GC 的 STW 都等不来（整个程序卡住等它）。

**异步抢占（Go 1.14+）**：sysmon（一个不绑 P 的后台监控 M，周期 20μs~10ms 自适应）发现某 G 连续运行 >10ms → 给该 M 发 **SIGURG 信号** → 信号处理函数在 M 上强行保存现场、把 G 摘下来放回队列。⚠️ 版本背景：这就是 Go 程序 strace 里一堆 `rt_sigaction`/`tgkill SIGURG` 的来源；也解释了实验 1 里 Go 接管信号的原因之一。

对照 OS：内核抢占靠**时钟中断**（硬件强制），Go 抢占靠**信号**（软件模拟的"中断"）——同一思想在两层的复刻。

### 3.4 syscall 阻塞：为什么一个 G 卡住不会卡死全程序

G 进入阻塞 syscall（比如读一个慢磁盘文件）时，**M 会跟着一起陷进内核**——M 是真线程，它没法分身。GMP 的解法是"弃车保帅"：

```text
G1 发起 syscall:
  M1 带着 G1 陷入内核(entersyscall) → M1 与 P 解绑(P 进入 _Psyscall)
  ├─ 快返回: M1 出来后优先抢回原 P / 找空闲 P, 继续跑 G1
  └─ 慢返回: sysmon 发现 P 卡在 _Psyscall 太久且有活可干
             → 把 P 剥离(retake), 交给空闲 M(没有就【新建 M】) 继续跑其他 G
             → M1 从 syscall 出来后: 没 P 了, 把 G1 放回队列, 自己进停车场
```

推论三连：
1. **程序不卡**：P 被转移走，其他 G 照跑——"一个 goroutine 阻塞不阻塞程序"的完整答案；
2. **M 会增生**：大量 G 同时做阻塞 syscall（磁盘 I/O、cgo、DNS）→ M 数量膨胀（`top -H` 线程数暴涨的解释）；`GODEBUG=schedtrace=1000` 里 `threads` 字段可见；
3. **网络 I/O 是例外**：socket 读写不走这条重路径——netpoller 把 fd 设成非阻塞 + epoll 统一等待，G 挂起时 **M 根本不陷内核**，成本只是一次 goroutine 切换（第 08 章主角）。

### 3.5 goroutine 栈：2KB 起步的秘密

线程栈是**预留固定虚拟区间**（默认 8MB，`ulimit -s`），不能缩、超了就 SIGSEGV；万级线程 = 万级 8MB 区间，虚拟地址空间和页表先扛不住。goroutine 栈是**堆上分配的可搬家内存**：

- 起步 2KB；函数序言检查剩余空间，不够 → `morestack`：分配 2 倍新栈，**把旧栈整个拷过去**，指针全部修正（能这么干是因为 Go 精确知道栈上哪些字是指针——GC 元数据的复用）；
- GC 时发现栈用得少会**收缩**（对半）；
- ⚠️ 深递归 + 栈上大数组 → 反复 morestack 拷贝，性能刺客；曾经的"分段栈"（segmented stack, Go ≤1.2）在热点边界反复分配/释放（hot split 问题），1.3 改为连续栈（contiguous stack）。

**"goroutine 为什么轻"的三笔账（标准答案）**：
1. **内存**：2KB vs 8MB 虚拟 + 页表压力（4000 倍差距的起点）；
2. **创建/销毁**：用户态堆分配 + 入队 vs clone syscall；
3. **切换**：用户态换寄存器 ~100ns vs 陷内核 + 调度器决策 + 缓存损耗 ~μs 级。

### 3.6 GOMAXPROCS 与容器（版本敏感，面试新宠）

- GOMAXPROCS 默认 = 机器逻辑 CPU 数。**容器里灾难**：Pod limit 2 核跑在 96 核宿主机 → Go 看到 96 → 起 96 个 P → 96 个忙 M 在 2 核配额里被 cgroup 疯狂节流（throttle）→ 延迟毛刺 + 调度开销爆炸。
- ⚠️ 版本背景：**Go 1.25 起 runtime 默认感知 cgroup CPU 配额**（并周期性适配变化），此前需要 `uber-go/automaxprocs` 或手动设置。本仓库 Go 1.26 已内置；但读老项目/老面经时要知道这段历史。
- 相关但不同的旋钮：`runtime.GOMAXPROCS()`（P 数）≠ `debug.SetMaxThreads`（M 上限，默认 1 万，超了直接 crash）≠ cgroup cpu.max（内核配额，第 11 章）。

## 4. 关键执行流程图（GMP 全景）

```text
          ┌────────────────────────── 全局队列 (锁保护) ──────────────┐
          │  ┌─────────┐  steal 一半   ┌─────────┐                   │
          ▼  │ P0      │◄────────────►│ P1      │  ... × GOMAXPROCS │
   ┌─────────┤ runnext │              │ runnext │                   │
   │ 每61次   │ 本地队列 │              │ 本地队列 │◄──────────────────┘
   │ 查一次   │ mcache  │              │ mcache  │      放回/唤醒
   │         └────┬────┘              └────┬────┘         ▲
   │              │ 绑定                    │ 绑定          │
   │         ┌────▼────┐              ┌────▼────┐    ┌────┴─────┐
   │         │   M0    │              │   M1    │    │netpoller │←epoll(第08章)
   │         │ 跑 G_a  │              │ 跑 G_b  │    └──────────┘
   │         └─────────┘              └────┬────┘
   │  sysmon(无P的M): >10ms 发 SIGURG 抢占 ─┘   G_b 陷入阻塞syscall:
   │                                           M1+G_b 陷内核, P1 被 retake
   └── 停车场: 空闲 M / 空闲 P                   交给 M2(可新建) 继续消费队列
```

## 5. Go 语言示例

见 [`code/02_concurrency`](../../os/code/02_concurrency)：

| 示例 | 演示内容 | 对应正文 |
|---|---|---|
| [01_goroutine_leak](../code/02_concurrency/01_goroutine_leak/main.go) | 三种经典泄漏的构造、探测（NumGoroutine + pprof dump）与修复 | 本章 §6/排障 |
| [02_cpu_starvation](../code/02_concurrency/02_cpu_starvation/main.go) | CPU 密集 goroutine 如何拉高 I/O 型请求的延迟；GOMAXPROCS/配额的影响 | §2.3/3.6 |

核心片段——三种泄漏的"病理切片"：

```go
// 泄漏 1: 发送者卡死 —— 没人收, ch 无缓冲
go func() { ch <- compute() }()   // 调用方 timeout 后不收了, 这个 G 永远卡在发送
// 修: buffered channel(容量1) 或 select+ctx.Done()

// 泄漏 2: range 一个永不 close 的 channel
go func() { for v := range ch { use(v) } }() // 生产者退出时没 close(ch)
// 修: 生产者 defer close(ch) —— "谁生产谁关门"

// 泄漏 3: 忘了带取消的阻塞调用
go func() { resp, _ := http.Get(url); ... }() // 服务端不回, 没超时 → G 挂一辈子
// 修: 一切阻塞 I/O 都要 ctx/timeout —— http.NewRequestWithContext
```

## 6. 后端开发中的应用

- **“每请求一 goroutine”成立的边界**：net/http 天然如此，10 万连接 = 10 万 G ≈ 几百 MB，可行。但**每请求再无限 spawn**（每条日志一个 G、每次重试一个 G）就是失控——G 便宜不等于免费：调度队列变长、GC 扫描栈变多（第 06 章）。原则：**长期存在的 goroutine 必须有编号、有退出路径、有 owner**。
- **容器部署自查三件套**：GOMAXPROCS 是否匹配配额（1.25+ 自动）、是否用 `top -H` 确认过线程数没有异常增生（大量阻塞 syscall/cgo 的信号）、压测是否按物理核而非超线程核估容量。
- **延迟毛刺排查思路升级**：P99 毛刺 ≠ 一定是 GC——CPU 密集 G 霸占 P（1.14 前无异步抢占更惨）、cgroup throttle、M 增生都能造成。`go tool trace` 能直接看到 G 在"可运行但排队"状态等了多久（scheduler latency）。

## 7. Agent 开发中的应用

- **每个工具调用的 goroutine 预算**：一次工具执行至少 3 个 G（排水 stdout、排水 stderr、Wait/看门狗）。1000 个并发任务 = 3000+ G——没问题，但**它们必须与任务同生共死**：任务终态后这些 G 必须可证退出（第 02 章排水 goroutine 在管道 EOF 后退出——这就是设计好的退出路径）。
- **泄漏的复利效应**：Agent 是长跑进程，每任务泄漏 1 个 G，一天一万任务就是一万僵尸 G + 它们抓着的内存/fd。上线前必做：压测后对比 `runtime.NumGoroutine()` 水位是否回落（lab_02 实验 5）。
- **LLM 流式转发是 I/O 型，工具执行可能是 CPU 型**：同进程混跑时，后者会抢占前者的 P → 流式输出卡顿。手段：限制工具并发数（第 04 章 semaphore）、重 CPU 工具丢子进程/独立池（还能顺便上资源限制，第 11 章）。

## 8. 常见问题与错误设计

**错误 1：goroutine 数量当性能旋钮猛拧。**

```go
// ⚠️ 错误直觉: "并发越大越快" —— CPU 密集任务开 1000 个 G
for i := 0; i < 1000; i++ { go crunch(data[i]) }
// 真相: CPU 密集的并行上限 = 核数。1000 个 G 在 8 个 P 上轮转,
// 吞吐不升反降(切换+缓存互踩), 且每个任务的完成时间都变长(全在半成品状态)。
// ✅ 正确: worker 数 = GOMAXPROCS(CPU型) 或 按下游容量定(I/O型), 见第04章 worker pool
```

**错误 2：用 time.Sleep 轮询代替事件驱动。** 一千个 G 各自 `for { poll(); time.Sleep(100ms) }`——空转唤醒吃 CPU、延迟还高。正确：channel/Cond 通知，或统一的定时器轮。

**错误 3：认为 "阻塞了 runtime 总会救我"。** runtime 救的是 **syscall 和 channel/锁**：cgo 长调用、纯计算紧循环（1.14 前）它救不了或救得慢；被救走 P 的代价是 M 增生——阻塞得多，线程就多，`SetMaxThreads` 1 万上限撞上直接 crash（典型：无限制并发的 cgo DNS 解析）。

## 9. 排障方法

**案例：goroutine 从 2000 涨到 20 万，内存跟着涨。**

- **现象**：监控里 `go_goroutines` 单调上升；重启后归零再爬升——教科书级泄漏曲线。
- **原因假设**：某路径的 G 没有退出路径（三种泄漏之一）。
- **验证**：
  ```bash
  curl -s localhost:6060/debug/pprof/goroutine?debug=1 | head -50
  # debug=1 按【创建点栈】聚合并计数 —— 第一行就是最大嫌疑:
  #   19xxxx @ 0x... goroutine 泄漏点的完整调用栈
  # debug=2 看每个 G 的完整栈+阻塞了多久(wait minutes), 适合看少量样本的细节
  ```
  两次采样相减（隔 10 分钟）看**净增长**在哪个栈上——静态大数可能是合理常驻，增长才是泄漏。
- **解决**：给该阻塞点补 ctx/超时/close；回归标准：压测后 NumGoroutine 回落到基线。
- ⚠️ 误区：`kill -QUIT <pid>` 会 dump 全部 goroutine 栈到 stderr 然后**退出进程**——线上想 dump 不想死，用 pprof 端点。

**日常工具**：`GODEBUG=schedtrace=1000`（每秒打印：gomaxprocs/idleprocs/threads/runqueue/每 P 队列长度——runqueue 持续大 = 消费不动）；`go tool trace`（看单个 G 的调度时间线）；游离在监控外时至少埋 `runtime.NumGoroutine()`。

## 10. 实验任务

[lab_02_goroutine.md](../labs/lab_02_goroutine.md)：① 10 万 goroutine vs 线程的内存对比；② schedtrace 读数；③ 构造紧循环观察 1.14+ 异步抢占；④ syscall 阻塞观察 M 增生；⑤ 三种泄漏的构造与 pprof 定位。

## 11. 面试题（附答题要点）

**Q1：goroutine 和线程的区别？为什么轻量？**
要点：三笔账——内存（2KB 可增长的堆上栈 vs 8MB 固定虚拟区间）、创建（用户态分配 vs clone syscall）、切换（~100ns 用户态换寄存器 vs ~μs 陷内核+缓存损耗）。加分：栈能搬家靠 GC 元数据精确定位指针；线程 = clone 共享标志的马甲（连回第 02 章）。

**Q2：讲讲 GMP。为什么有了 M 还要 P？**
要点：先一句话定义三者；P 的三件宝——无锁本地队列、mcache 资源分片、并行度与线程数解耦。叙事线：Go 1.0 全局一把锁 → 1.1 引入 P（work stealing 调度器）。加分：说出调度循环的六级优先序（runnext → 本地 → 全局 1/61 → netpoller → steal → 睡）。

**Q3：goroutine 阻塞在 syscall 会发生什么？**
要点：M 陪着陷内核 → P 解绑；快返回抢回 P，慢返回被 sysmon retake、P 交给别的 M（不够就新建）→ 程序不卡但 M 增生。**网络 I/O 例外**：netpoller 非阻塞化，M 不陷内核。加分：这就是"线程数远超 GOMAXPROCS"的原因；cgo/磁盘 I/O/老版本 DNS 是 M 增生三大户。

**Q4：Go 如何实现抢占？**
要点：两代——协作式（函数序言检查点，紧循环失效，GC 都能被拖死）→ Go 1.14 异步抢占（sysmon 发现 >10ms → SIGURG → 信号处理器强制保存现场摘下 G）。加分：对照内核用时钟中断，Go 用信号模拟"中断"；strace 里的 SIGURG 就是它。

**Q5：GOMAXPROCS 在容器里有什么坑？**
要点：默认读宿主机核数 → P 过多 → cgroup throttle + 调度开销 → 延迟毛刺。⚠️ 版本分水岭：Go 1.25 起默认感知 cgroup 配额，之前用 automaxprocs。加分：区分三个旋钮 GOMAXPROCS(P)/SetMaxThreads(M 上限 1 万)/cpu.max(内核配额)。

**Q6：如何定位 goroutine 泄漏？**
要点：现象（数量单调涨）→ pprof goroutine debug=1 按创建栈聚合 → 两次采样看净增长 → 补退出路径（ctx/close/超时）。加分：三种泄漏模式各举一例；长期 G 要有 owner 和退出路径的设计纪律。

**Q7：10 万个 goroutine 同时 time.Sleep，会有 10 万个定时器压垮系统吗？**
要点：不会——定时器按 P 分片成最小堆（每 P 一个），到期由持有 P 的 M/netpoller 统一触发，无 per-timer 线程。加分：⚠️ 版本背景——Go 1.23 前 `time.After` 在循环里会堆积到期前无法回收的 timer（经典泄漏面题），1.23 起 timer 可被 GC，老面经的"必须用 NewTimer+Stop"结论要更新。

## 12. 本章总结

- 线程是共享地址空间的 task_struct；切换成本 = 陷内核 + 缓存损耗，这是协程存在的物理理由。
- GMP = M:N 调度：P 的本地无锁队列是性能核心，work stealing 负责均衡，六级取活顺序保公平。
- 两代抢占（检查点 → SIGURG）；syscall 用"P 交接 + M 增生"保活；网络 I/O 走 netpoller 免陷阱。
- goroutine 轻在三笔账，但不免费：无退出路径 = 泄漏，CPU 密集不设限 = 延迟灾难，容器不认配额 = throttle（1.25 已内置修复）。

**检查清单**：
- [ ] 我能画出 GMP 全景图并讲出取活六级顺序
- [ ] 我能解释 P 存在的三个理由和"为什么跑 Go 代码的 M ≤ GOMAXPROCS"
- [ ] 我能说清 syscall 阻塞的完整交接流程和 M 增生的三大来源
- [ ] 我能写出三种 goroutine 泄漏和各自的修法，会用 pprof 两次采样定位
- [ ] 我知道 Go 1.14（抢占）、1.25（容器感知）两个版本分水岭

## 13. 延伸阅读

- 《The Linux Programming Interface》第 28 章（线程与 clone）
- Go 官方设计文档：*Scalable Go Scheduler Design Doc*（Dmitry Vyukov，P 的出生证明）
- GopherCon 演讲：*The Scheduler Saga*（Kavya Joshi，最好的 GMP 入门）
- 本仓库 `go/knowledge/06_gmp_scheduler.md`、`21_runtime_scheduler.md`（源码级细节）、`22_goroutine_stack_abi.md`（栈机制）
- `man 2 clone`、`man 7 sched`
