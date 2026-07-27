# 14 · 面试题集：自测与冲刺 ⭐⭐

> 本章不重复各章的答题要点（那些在每章第 11–12 节），而是提供三样东西：
> ① goal.md 二十个重点问题的**标准回答框架**；② 按难度分层的**题目索引**；③ 面试冲刺的**三日复习法**。

## 1. 怎么用这一章

**自测流程**：合上其他章节 → 看问题 → 口头回答（**说出来，不是想一遍**）→ 对照答案框架 → 标记不会的 → 回到对应章节重读。

⚠️ **口头回答比默读重要得多**。面试是口语输出，你以为懂了但说不流畅的，实际就是没掌握。建议对着手机录音，回放时你会听出所有含糊的地方。

**回答的通用结构**（面试官最爱听的顺序）：
```text
① 一句话结论      "load 高但 CPU 闲，通常是磁盘 I/O 出了问题"
② 机制解释        "因为 Linux 的 load 把 D 状态也算进去了……"
③ 举例/数字       "比如 NFS 卡住时，进程全在 D 状态，load 25 但 CPU 只有 30%"
④ 排查/解决       "我会先 vmstat 看 b 列，再 ps 找 D 状态进程的 wchan"
⑤ 加分延伸        "顺带一提，D 状态 kill -9 也杀不掉，因为……"
```
只答 ② 是学生，答完 ①②③④ 是工程师，能到 ⑤ 是资深。

---

## 2. goal.md 二十个重点问题：回答框架

> 每题给"一句话结论 + 关键机制 + 排查路径"，展开细节回对应章节。

### 2.1 CPU 与调度

**Q1：为什么服务 CPU 很高？**
> 先分 us / sy（[12 章](12_observability_and_debugging.md) 第一分诊）。us 高 → 抓 CPU profile，`top` + `list` 定位到行；sy 高 → `strace -c` 找爆炸的 syscall。常见根因：热路径重复编译正则、大对象 JSON 序列化、忙轮询、GC 占比过高（gctrace 确认）、锁自旋。
> 排查：`top` → `pprof profile?seconds=30` → `list <func>`。

**Q2：为什么 CPU 不高但请求很慢？**
> CPU 闲说明**在等**，不是在算。逐一排查五个"等"：等 I/O（`iostat` + D 状态）、等锁（mutex profile）、等网络（`ss` 的 Recv-Q/Send-Q）、等下游（链路追踪）、等调度（`go tool trace` 的调度延迟）。
> **思维转换**：找"等什么"而不是"谁在算"。多数情况根本不在本机。

**Q3：为什么大量 goroutine 不一定提高性能？**
> CPU 密集型任务的并行上限就是核数（GOMAXPROCS 个 P），超出部分只增加切换开销和缓存互踩，吞吐不升反降，且每个任务的完成时间都变长。I/O 密集型才受益于高并发，但也受下游容量约束。
> 数字支撑：goroutine 切换 ~100ns，虽比线程便宜，但不是零。

**Q4：为什么服务 load average 很高？**
> **Linux 的 load = R 状态 + D 状态任务数**（与传统 Unix 只算 R 不同）——这是核心答案。所以 load 高有两种可能：CPU 不够（R 多）或存储卡住（D 多）。
> 排查：`vmstat 1` 看 r 列 vs b 列 → `ps -eo stat,wchan,comm | awk '$1~/D/'` → `iostat -x` 确认设备饱和。
> 判读：load 要**除以核数**；8 核 load 8 才是满载。

### 2.2 内存

**Q5：为什么内存持续增长？**
> 先分三层（[06 章](06_go_memory_and_gc.md) §2.5）：堆真的在涨？攥着不还？还是堆外？用 `gctrace` 的"存活堆"（第三个数字）区分——单调上升就是真泄漏。
> 定位：`heap` 两次采样做 `-base` diff，看**净增长**，用 `inuse_space` 不是 `alloc_space`。
> 常见根因：只增不删的 map 缓存、子切片钉住大数组、goroutine 泄漏连带引用、无界队列。

**Q6：为什么 Go 进程内存不下降？**
> 三层原因：① GC 根本没打算还（GOGC 模型下堆有目标值，回收的 span 留着复用）；② 还了但慢（scavenger 逐步 madvise；⚠️ Go 1.12–1.15 用 MADV_FREE 导致 RSS 数字不掉，1.16 起改回 MADV_DONTNEED）；③ RSS ≠ 堆（还含 goroutine 栈、runtime 元数据、CGO/mmap）。
> 排查顺序：MemStats → `HeapIdle-HeapReleased` 看攥着的 → 差额去堆外找。

**Q7：为什么容器被 OOM Kill？**
> exit 137 = 128+9 = SIGKILL。三个嫌疑：应用真泄漏（anon 涨）、**Page Cache 被计入 cgroup 内存账**（file 大）、limit 本来就没余量。
> 排查：`dmesg -T | grep -A20 'Killed process'` 读案卷 → `cat memory.stat` 拆 anon/file → `memory.events` 看 oom_kill 计数。
> 对策：`GOMEMLIMIT = limit × 0.9` 让 GC 提前发力，比裸奔稳得多。

**Q8：为什么无界队列最终会导致系统崩溃？**
> 生产快于消费时，队列就是"把今天的拒绝攒成明天的 OOM"。有界队列的满载拒绝**不是故障，是背压在工作**——它把压力如实反馈给上游，让上游退避。
> 队列容量的定法：**最大延迟预算 ÷ 单任务耗时**，不是拍脑袋。

### 2.3 进程与 Agent

**Q9：为什么任务取消了，子进程还在运行？**
> `cmd.Process.Kill()` 只发信号给直接子进程。你启动的是 `sh -c "python x.py"`，杀掉的是 sh，python 变成孤儿被 init 收养继续跑。
> 解法按防逃逸强度分层：`Setpgid` + `kill(-pgid)` → `Pdeathsig` 辅助 → PID namespace（**ns 内 PID 1 死则全灭**，无法用 setsid 逃逸）→ `cgroup.kill`（原子，v2 5.14+）。

**Q10：为什么只杀 Shell 后 Python 进程仍然存在？**
> 同 Q9 的具体形态。验证：`ps -eo pid,ppid,pgid,cmd` 看 python 的 PPID 变成 1（被收养）而 PGID 还是原来的组——说明你杀的是 PID 不是 PGID。

**Q11：为什么读取子进程 stdout 可能导致死锁？**
> 管道是**定长内核缓冲（Linux 默认 64KB）**。父进程不读 → 缓冲写满 → 子进程 `write` 永久阻塞；父进程在 `Wait()` 等子进程退出 → **互相等待**。
> 变体：只读 stdout 不读 stderr 同样死锁（python 异常栈、编译告警都走 stderr）。
> 解法：两根管道**各配一个 goroutine 并发排水**，全部读到 EOF 后才 `Wait()`。

**Q12：为什么出现大量僵尸进程？**
> 子进程死了但父进程不 `wait()`，内核保留 task_struct 等父进程领取退出码。危害：不占内存 CPU，但**占 PID**，堆多了全系统无法创建进程。
> ⚠️ 对僵尸 `kill -9` 无效——它已经死了。排查取**僵尸的 PPID**，罪犯是父进程。应急：杀父进程让僵尸被 init 收养回收。

**Q13：为什么 Agent 工具执行需要资源配额？**
> 工具执行的是**不可信代码**（LLM 生成或用户提供）。没有配额时，一个任务就能：吃光内存（OOM 拖垮宿主）、打满 CPU（其他任务饿死）、fork bomb（PID 耗尽）、写满磁盘（所有服务受害）。
> 配额分三层：应用层（输出/超时/并发）管自己、rlimit 管单进程、**cgroup 管整棵进程树**（不可信代码的唯一正确答案）。

**Q14：为什么 Sandbox 不能只依赖 Docker 默认配置？**
> 逐项列举默认缺失：**内存/CPU/进程数/磁盘全都不限制**；网络默认可访问**云元数据服务和内网**；**默认以 root 运行**；capabilities 保留 14 个。只有 seccomp 有默认 profile（且是黑名单思路）。
> 收尾给最小加固命令（[11 章](11_container_and_sandbox.md) §7.1）。

### 2.4 文件与 I/O

**Q15：为什么文件描述符不断增长？**
> 三种泄漏路径：错误路径提前 return 跳过 Close、循环里用 defer（全堆到函数结束）、**HTTP resp.Body 不关**（最高频）。
> 排查：`ls /proc/<pid>/fd | wc -l` 对比 `limits` → `lsof -p` 按类型/目标聚合。

**Q16：为什么出现 Too many open files？**
> fd 数撞上 `RLIMIT_NOFILE`。判决树：大量 socket + CLOSE_WAIT → 我方没 Close（HTTP body）；大量同名 REG → 文件泄漏；数字恰好卡在 1024 → ulimit 太小。
> ⚠️ 只调 ulimit 不修代码 = 把崩溃从 1 小时推迟到 3 天。

**Q17：为什么磁盘有空间却无法创建文件？**
> 两个原因：① **inode 耗尽**（`df -i` 看，格式化时固定，海量小文件的必然结果）；② 文件被删但仍被打开（nlink=0 但 fd 在，`lsof +L1`），空间未释放。
> 还有：配额（quota）、ext4 给 root 保留的 5%。

**Q18：为什么频繁写日志会影响性能？**
> 每条无缓冲日志 = 1 次 write syscall ≈ 1μs。QPS 1 万 × 每请求 10 条 = 10 万次/秒 ≈ **0.1 核纯烧在 syscall 上**，还没算缓存污染的间接损耗。同步刷盘（每条 fsync）更是慢 100 倍。
> 数字支撑：写 1MB 数据，4 字节一次 vs 64KB 一次，**差约 5000 倍**。
> 对策：缓冲 + 异步 + 采样。

### 2.5 并发

**Q19：为什么大量锁竞争导致吞吐下降？**
> 临界区占执行时间的比例 p 决定了加速比上限 1/p（Amdahl 定律的锁版本）——无论多少核。竞争时线程要进内核睡眠/唤醒（futex），成本从 ~20ns 涨到 μs 级。
> 排查：`strace -c` 看 futex 占比 → mutex profile 看等锁时长排名 → `list` 定位。
> 三板斧：**缩临界区**（把 I/O 和慢计算挪出去）→ **分片**（按 key 哈希成 N 把锁）→ **无锁快照**。

**Q20：为什么服务重启后问题消失，跑一段时间又出现？**
> 典型的**累积型问题**画像。四个嫌疑：goroutine 泄漏（`NumGoroutine` 单调涨）、内存泄漏（heap diff）、fd 泄漏（`/proc/<pid>/fd` 计数）、连接池/缓存无界增长。
> 通用手法：**两次采样看净增长**，不看绝对值。埋点：把这四个指标做成监控曲线，斜率不为零就告警。

---

## 3. 分层题目索引

### 3.1 必答题（答不出直接挂）

| 题目 | 章节 |
|---|---|
| 进程和线程的区别 | [03](03_thread_coroutine_scheduling.md) §2.1 |
| 用户态和内核态为什么要分 | [01](01_os_foundations.md) §2.2 |
| 虚拟内存解决什么问题 | [05](05_memory_management.md) §2.1 |
| 死锁的四个条件、怎么防 | [04](04_concurrency_synchronization.md) §3.6 |
| 进程间通信有哪些方式 | [02](02_process.md) §4、[07](07_file_system.md) §2.4 |
| select/poll/epoll 的区别 | [08](08_io_model.md) §2.2 |
| goroutine 为什么比线程轻量 | [03](03_thread_coroutine_scheduling.md) §3.5 |
| GMP 模型是什么 | [03](03_thread_coroutine_scheduling.md) §3.1 |
| Go 的 GC 怎么工作 | [06](06_go_memory_and_gc.md) §2.3 |
| 容器和虚拟机的区别 | [11](11_container_and_sandbox.md) §2.1 |

### 3.2 进阶题（区分中级和高级）

| 题目 | 章节 |
|---|---|
| 为什么需要 P？没有 P 会怎样 | [03](03_thread_coroutine_scheduling.md) §3.1 |
| syscall 阻塞时 GMP 怎么处理 | [03](03_thread_coroutine_scheduling.md) §3.4 |
| Go 怎么实现抢占（两代方案） | [03](03_thread_coroutine_scheduling.md) §3.3 |
| 写屏障解决什么问题、混合写屏障的价值 | [06](06_go_memory_and_gc.md) §2.3 |
| happens-before 的四个来源 | [04](04_concurrency_synchronization.md) §3.4 |
| futex 的快慢路径 | [04](04_concurrency_synchronization.md) §3.1 |
| netpoller 的完整链路 | [08](08_io_model.md) §3 |
| COW 的机制和残余成本 | [05](05_memory_management.md) §2.6 |
| minor/major page fault 的区别 | [05](05_memory_management.md) §2.3 |
| inode 与目录项的分工 | [07](07_file_system.md) §2.1 |
| LT 和 ET 的编程约束差异 | [08](08_io_model.md) §2.3 |
| cgroup v1 vs v2 | [11](11_container_and_sandbox.md) §4.1 |
| 零拷贝 / sendfile 原理 | [08](08_io_model.md) §2.5 |
| 伪共享是什么、怎么发现 | [04](04_concurrency_synchronization.md) §3.5 |

### 3.3 高级题（资深/架构岗）

| 题目 | 章节 |
|---|---|
| 设计一个代码执行沙箱 | [13](13_agent_code_runner_project.md) §5 Q1 |
| 怎么防止 fork bomb、为什么 rlimit 不够 | [11](11_container_and_sandbox.md) §4.3 |
| 云元数据服务的风险与防御 | [11](11_container_and_sandbox.md) §3.5 |
| seccomp 白名单怎么设计 | [11](11_container_and_sandbox.md) §5.2 |
| 容器逃逸的常见路径 | [11](11_container_and_sandbox.md) §7.3 |
| OverlayFS 的 Copy-Up/Whiteout 的工程影响 | [11](11_container_and_sandbox.md) §6 |
| 容器里 nproc/free 为什么不准 | [10](10_linux_resource_management.md) §2.7 |
| CPU limit 为什么导致 P99 恶化 | [11](11_container_and_sandbox.md) §4.3 |
| 怎么设计恰好一次执行 | [04](04_concurrency_synchronization.md) §4.1 |
| 怎么设计服务的可观测性 | [12](12_observability_and_debugging.md) §10 Q7 |
| GOMEMLIMIT 和 GOGC 怎么配 | [06](06_go_memory_and_gc.md) §2.4 |
| 超时体系怎么分层 | [13](13_agent_code_runner_project.md) §5 Q5 |

### 3.4 陷阱题（考细节，答错暴露"背过但没用过"）

| 题目 | 正确答案要点 |
|---|---|
| `kill -9` 一定能杀掉进程吗？ | 不能。D 状态（等 I/O，信号处理时机不到）和僵尸（已经死了）都杀不掉 |
| `ps` 的 %CPU 是瞬时值吗？ | 不是，是自启动以来的平均值。要瞬时用 `top`/`pidstat 1` |
| `free` 显示剩余很少是不是内存不足？ | 不是。Linux 把闲内存拿去做 Page Cache 是好事，看 `available` |
| heap profile 找泄漏用哪个视角？ | `inuse_space`（还占着的）。`alloc_space` 是找 GC 压力用的 |
| 大量 TIME_WAIT 是问题吗？ | 通常不是（正常关闭状态，60 秒消失）。**CLOSE_WAIT 才是 bug** |
| `%util` 100% 就是磁盘满载吗？ | 对 SSD/NVMe 不可靠（并行队列）。看 `await` 和 `aqu-sz` |
| RWMutex 一定比 Mutex 快吗？ | 不一定。读临界区极短时，读者计数的原子开销 + 缓存争用可能反超 |
| Go 的 map 并发写会 panic 吗？ | **不是 panic，是 fatal error，不可 recover，进程当场死** |
| syscall 会导致进程上下文切换吗？ | 不会。切换的是特权级和栈，不是进程。它可能*引发*调度（如阻塞），但 ≠ 上下文切换 |
| 容器里 `nproc` 可信吗？ | 不可信。`/proc` 不是 namespace 化的，读的是宿主机 |
| I/O 多路复用是异步 I/O 吗？ | 不是。前四种模型都是**同步**的——阶段 2（拷贝数据）都是应用线程自己做 |
| `RLIMIT_NPROC` 是按进程限制吗？ | **按 UID**。多任务共用 uid 时额度互相干扰 |

---

## 4. 三日冲刺复习法

### Day 1：地基（进程 + 并发）
- **上午**：[01](01_os_foundations.md)、[02](02_process.md) 的"本章总结"+"检查清单"，重点复习 fork/exec/wait、信号、进程组
- **下午**：[03](03_thread_coroutine_scheduling.md)、[04](04_concurrency_synchronization.md)，重点是 GMP 全景图和 happens-before
- **晚上**：口头回答 §3.1 的必答题，录音回放
- **产出**：能白板画出 GMP 图 + 进程状态迁移图

### Day 2：资源（内存 + I/O）
- **上午**：[05](05_memory_management.md)、[06](06_go_memory_and_gc.md)，重点是"承诺 vs 交割"和 GC 三色标记
- **下午**：[07](07_file_system.md)、[08](08_io_model.md)，重点是三张表和 netpoller 链路
- **晚上**：口头回答 §3.2 的进阶题
- **产出**：能白板画出 netpoller 五步链路 + 虚拟地址翻译路径

### Day 3：系统与排障
- **上午**：[10](10_linux_resource_management.md)、[12](12_observability_and_debugging.md)，重点是 load 定义和第一分诊
- **下午**：[11](11_container_and_sandbox.md)、[13](13_agent_code_runner_project.md)，重点是十二道防线和沙箱设计
- **晚上**：过一遍 §2 的二十个重点问题 + §3.4 的陷阱题
- **产出**：能完整回答"设计一个代码执行沙箱"这道系统设计题

⚠️ **最后一小时**：把 §3.4 的陷阱题再过一遍。这些题目区分"背过"和"用过"，也是面试官最爱的"补刀问题"。

---

## 5. 面试中的加分习惯

1. **主动给数字**："syscall 大约 100ns 到 1μs，比函数调用贵两三个数量级"——数字比形容词有说服力。
2. **主动说版本背景**："Go 1.14 引入异步抢占之前，紧循环会拖死 GC"——显示你跟进过演进。
3. **主动说排查路径**：不只答"是什么"，还答"我怎么验证它"——这是工程师和学生的分水岭。
4. **主动承认边界**："这块我只了解到原理层面，没有读过内核源码"——比编造强一百倍，面试官都能听出来。
5. **主动关联**："这个和刚才说的 XX 是同一个思想"——展示知识网络而非孤立点。比如：per-P 无锁化同时出现在 GMP 调度和内存分配器里；"检查与使用之间世界会变"同时出现在 check-then-act 竞态和 TOCTOU 路径攻击里。

## 6. 本章总结

- 答题的完整结构是"结论 → 机制 → 例子/数字 → 排查 → 延伸"，只答机制是学生。
- 二十个重点问题都有固定的回答框架，背框架比背细节有效。
- 陷阱题是"背过"和"用过"的分水岭——`kill -9` 杀不掉什么、inuse vs alloc、TIME_WAIT vs CLOSE_WAIT、多路复用是同步的。
- 口头练习不可省略：说不流畅的就是没掌握。

## 7. 延伸阅读

- 各章第 11–12 节的面试题与答题要点（本章的详细版）
- 本仓库 `go/knowledge/12_interview_traps.md`——Go 语言侧的陷阱题
- [15 十周学习计划](15_ten_week_plan.md)——如果时间充裕，按计划系统学一遍比冲刺有效得多
