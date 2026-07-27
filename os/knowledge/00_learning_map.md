# 00 · 学习地图：章节规划、优先级与生成计划

> 本文件是整个 OS 模块的"总控"：分析 [goal.md](../goal.md) 的目标 → 给出完整章节目录（含每章学习目标、难度、优先级、依赖）→ 制定文档生成计划并跟踪进度。

## 1. 目标分析：七大能力 → 章节映射

goal.md 提出的能力目标，与承载它们的章节对应如下：

| 能力目标 | 主要章节 | 辅助章节 |
|---|---|---|
| 1. 理解后端程序运行时 OS 内部发生什么 | 01, 02, 05, 08 | 09 |
| 2. 分析 CPU/内存/并发/I/O/进程/泄漏问题 | 12 | 03, 04, 06, 07, 10 |
| 3. 理解 Go runtime（GMP/GC/netpoller）与 OS 的关系 | 03, 06, 08 | 05, 09 |
| 4. Agent 进程管理、取消、超时、资源清理 | 02, 13 | 04, 07 |
| 5. 容器、Sandbox、Namespace、cgroup、seccomp | 11 | 10 |
| 6. Linux 工具定位线上问题 | 12 | 09, 10（工具穿插在各章排障小节） |
| 7. 开发简易 Agent Sandbox / 代码执行平台 | 13 | 02, 11 |

核心取向：**每一章都要回答"为什么这样设计、底层如何工作、项目中怎么用、出问题怎么查"四件事**，不做纯概念罗列。

## 2. 完整目录与每章规划

难度：⭐（入门）～ ⭐⭐⭐⭐⭐（硬核）。
优先级：P0 = goal.md 第八节点名必须深入的主题；P1 = 重要但可控制深度；P2 = 自测/索引性质。

### 第一梯队：地基（进程与并发是 Agent 开发的命门）

| 章节 | 学习目标 | 难度 | 优先级 | 依赖 |
|---|---|---|---|---|
| [01 OS 基础](01_os_foundations.md) | 说清用户态/内核态、中断/异常/系统调用的关系；描述一个 Go 程序从 ELF 到运行中进程的完整过程；理解为什么应用不能直接碰硬件、态切换的成本在哪 | ⭐⭐ | P0（前置） | 无 |
| [02 进程](02_process.md) | 掌握 fork/exec/wait、信号、进程组/会话；能解释并避免僵尸/孤儿进程；**Agent 重点**：终止整个进程树、stdout/stderr 处理不死锁、超时退出、取消传播、资源清理 | ⭐⭐⭐ | P0 | 01 |
| [03 线程、协程与调度](03_thread_coroutine_scheduling.md) | 理解线程 vs 进程、上下文切换、M:N 模型；掌握 GMP（G/M/P、work stealing、抢占、syscall 阻塞时的 handoff）；能定位 goroutine 泄漏 | ⭐⭐⭐⭐ | P0 | 02 |
| [04 并发与同步](04_concurrency_synchronization.md) | 掌握竞态/临界区/原子性可见性有序性、死锁活锁饥饿、happens-before；Go 侧 sync 全家桶与 channel 的选型；**Agent 重点**：幂等设计、任务状态机、并发限制 | ⭐⭐⭐⭐ | P0 | 03 |

### 第二梯队：资源（内存与 I/O 决定服务死活）

| 章节 | 学习目标 | 难度 | 优先级 | 依赖 |
|---|---|---|---|---|
| [05 内存管理（OS 侧）](05_memory_management.md) | 理解虚拟内存、页表/TLB、Page Fault、mmap、COW、Swap、overcommit 与 OOM；能解释 RSS/VSZ 的区别 | ⭐⭐⭐⭐ | P0 | 01 |
| [06 Go 内存与 GC](06_go_memory_and_gc.md) | 掌握逃逸分析、三色标记+写屏障、STW、GOGC、sync.Pool；解释"Go 进程内存为什么不下降"；**Agent 重点**：流式/分块/背压/输出限制防 OOM | ⭐⭐⭐⭐ | P0 | 05 |
| [07 文件系统](07_file_system.md) | 掌握 inode、fd、权限、链接、管道、Page Cache、fsync；**Sandbox 重点**：路径穿越与符号链接攻击防御、临时目录生命周期、fd 泄漏排查 | ⭐⭐⭐ | P1（fd 部分 P0） | 01 |
| [08 I/O 模型](08_io_model.md) | 掌握五种 I/O 模型、epoll（LT/ET）、Reactor、零拷贝；理解 Go netpoller 如何让百万连接不需要百万线程；慢客户端与背压设计 | ⭐⭐⭐⭐ | P0 | 03, 07 |

### 第三梯队：系统（把黑盒拆开）

| 章节 | 学习目标 | 难度 | 优先级 | 依赖 |
|---|---|---|---|---|
| [09 系统调用](09_system_calls.md) | 熟悉 open/read/write/fork/exec/clone/mmap 等调用链；理解 syscall 成本、为什么小 I/O 和频繁 fork 性能差；熟练使用 strace | ⭐⭐⭐ | P1 | 01, 02 |
| [10 Linux 资源限制](10_linux_resource_management.md) | 掌握 ulimit、OOM Killer、load average vs CPU 使用率、上下文切换/软中断；能解释"容器内看到的资源和宿主机不一致" | ⭐⭐⭐ | P1（OOM 部分 P0） | 05 |
| [12 可观测性与排障](12_observability_and_debugging.md) | 系统掌握 ps/top/vmstat/iostat/lsof/strace/perf/ss 等 19 个 Linux 工具 + pprof/trace/GODEBUG 等 Go 工具；每个工具：解决什么问题/常用命令/关键字段/误区/真实案例 | ⭐⭐⭐⭐ | P0 | 全部前置章节（工具在各章先局部出现，此章系统化） |

### 第四梯队：综合（Sandbox 与项目落地）

| 章节 | 学习目标 | 难度 | 优先级 | 依赖 |
|---|---|---|---|---|
| [11 容器与 Sandbox](11_container_and_sandbox.md) | 深入 6 种 Namespace、cgroup v1/v2、capabilities、seccomp、OverlayFS；**Agent Sandbox 重点**：CPU/内存/pids/磁盘/时间/网络限制、防 fork bomb、防元数据服务访问、非 root 运行、多租户隔离；给出简化版 Sandbox 架构 | ⭐⭐⭐⭐⭐ | P0 | 02, 05, 10 |
| [13 Agent Code Runner 项目](13_agent_code_runner_project.md) | 十阶段渐进实现代码执行器：单进程执行 → 超时取消 → 流式输出 → 进程组清理 → 并发 → 状态机 → 资源限制 → 容器 Sandbox → 多租户 → 可观测性；每阶段含目标/架构/关键代码/易错点/测试/验收 | ⭐⭐⭐⭐⭐ | P0 | 02, 04, 11 |
| [14 面试题集](14_interview_questions.md) | 按章节整理面试题 + goal.md 20 个重点问题的标准回答思路，用于自测 | ⭐⭐ | P2 | 全部 |
| [15 十周学习计划](15_ten_week_plan.md) | 每周主题/必读/实验/编码/排障/自测/产出/验收的可执行计划 | ⭐ | P0 | 无（先读） |

## 3. 章节关系图

```text
                    ┌──────────────┐
                    │ 01 OS 基础    │  用户态/内核态、syscall、程序加载
                    └──────┬───────┘
        ┌──────────────────┼──────────────────────┐
        ▼                  ▼                      ▼
 ┌────────────┐    ┌──────────────┐       ┌─────────────┐
 │ 02 进程     │    │ 05 内存(OS)  │       │ 07 文件系统  │
 │ fork/信号   │    │ 虚拟内存/OOM │       │ inode/fd    │
 └─────┬──────┘    └──────┬───────┘       └──────┬──────┘
       ▼                  ▼                      ▼
 ┌────────────┐    ┌──────────────┐       ┌─────────────┐
 │ 03 线程协程 │    │ 06 Go内存/GC │       │ 08 I/O 模型 │◄── 03 (netpoller
 │ GMP        │    │ 逃逸/背压    │       │ epoll       │      挂在调度上)
 └─────┬──────┘    └──────────────┘       └─────────────┘
       ▼
 ┌────────────┐         09 系统调用（横切：为 01/02/07/08 提供调用链和 strace 视角）
 │ 04 并发同步 │         10 资源限制（05 的延伸：ulimit/OOM Killer/load）
 │ 锁/状态机  │         12 排障（横切：所有章节的工具在此系统化）
 └─────┬──────┘
       ▼
 ┌─────────────────────────────────────┐
 │ 11 容器与 Sandbox（02+05+10 的集成）  │
 └─────────────────┬───────────────────┘
                   ▼
 ┌─────────────────────────────────────┐
 │ 13 Agent Code Runner（全模块的落地）  │ → 14 面试自测
 └─────────────────────────────────────┘
```

## 4. 重点问题清单 → 章节映射

goal.md 第三节的 20 个问题，学完对应章节后应能独立回答：

| 问题 | 主答章节 | 关键机制 |
|---|---|---|
| 为什么服务 CPU 很高？ | 12, 03 | perf/pprof CPU profile、GC 压力、忙轮询 |
| 为什么 CPU 不高但请求很慢？ | 08, 10, 12 | I/O 等待、锁竞争、D 状态、load 与 CPU 的区别 |
| 为什么内存持续增长？ | 06, 05 | 逻辑泄漏、goroutine 泄漏、缓存无界 |
| 为什么 Go 进程内存不下降？ | 06 | GC 归还策略、scavenger、RSS vs heap |
| 为什么容器被 OOM Kill？ | 10, 11, 05 | cgroup memory limit、Page Cache 计账、GOMEMLIMIT |
| 为什么 goroutine 越来越多？ | 03 | 阻塞的 channel/锁/网络读、缺少退出路径 |
| 为什么任务取消了，子进程还在运行？ | 02 | ctx cancel 只杀直接子进程、进程组未终止 |
| 为什么只杀 Shell 后 Python 进程仍然存在？ | 02 | 孤儿进程被 init 收养、需按进程组/PGID 杀 |
| 为什么读取子进程 stdout 可能导致死锁？ | 02, 07 | 管道缓冲区写满、父子互相等待 |
| 为什么出现大量僵尸进程？ | 02 | 父进程未 wait、SIGCHLD 处理缺失 |
| 为什么文件描述符不断增长？ | 07 | fd 泄漏：未 Close、defer 在循环里 |
| 为什么出现 Too many open files？ | 07, 10 | RLIMIT_NOFILE、连接/文件未释放 |
| 为什么磁盘有空间却无法创建文件？ | 07 | inode 耗尽 |
| 为什么大量锁竞争导致吞吐下降？ | 04 | 临界区过大、锁粒度、mutex profile |
| 为什么大量 goroutine 不一定提高性能？ | 03, 04 | 调度开销、CPU 上限、竞争放大 |
| 为什么服务 load average 很高？ | 10 | R+D 状态队列长度、I/O 等待计入 load |
| 为什么频繁写日志会影响性能？ | 09, 07 | write syscall 成本、Page Cache 回写、fsync |
| 为什么无界队列最终会导致系统崩溃？ | 06, 04 | 生产>消费 → 内存增长 → OOM，需背压 |
| 为什么 Agent 工具执行需要资源配额？ | 11, 13 | 不可信代码、fork bomb、磁盘写满、防拖垮宿主 |
| 为什么 Sandbox 不能只依赖 Docker 默认配置？ | 11 | 默认无内存/pids 限制、可访问元数据服务、capabilities 过宽 |

## 5. 文档生成计划（进度跟踪）

> 本节是生成工作的状态清单，每完成一批更新一次。生成顺序 = 学习顺序（先地基后综合），保证任意时刻已生成的部分自洽可学。

### 批次与状态

- [x] **批次 0（计划）**：README.md、00_learning_map.md、15_ten_week_plan.md
- [x] **批次 1（进程地基）**：01_os_foundations.md、02_process.md、code/01_process/（5 个示例）、labs/lab_01_process.md
- [x] **批次 2（调度与并发）**：03_thread_coroutine_scheduling.md、04_concurrency_synchronization.md、code/02_concurrency/（5 个示例）、labs/lab_02_goroutine.md
- [x] **批次 3（内存）**：05_memory_management.md、06_go_memory_and_gc.md、code/03_memory/（5 个示例）、labs/lab_03_memory.md
- [x] **批次 4（文件与 I/O）**：07_file_system.md、08_io_model.md、code/04_io/（5 个示例）、labs/lab_04_io.md
- [x] **批次 5（系统与限制）**：09_system_calls.md、10_linux_resource_management.md、code/05_profiling/（2 个示例）、labs/lab_05_debugging.md（实验 1–5）
- [x] **批次 6（排障）**：12_observability_and_debugging.md、labs/lab_05_debugging.md（实验 6–10 靶场）、code/05_profiling/03_pprof_targets
- [x] **批次 7（Sandbox）**：11_container_and_sandbox.md、code/06_sandbox/（3 个示例）、labs/lab_06_agent_runner.md（实验 1–6）
- [x] **批次 8（项目）**：13_agent_code_runner_project.md、code/06_sandbox/04_agent_runner（4 文件 + 测试）、labs/lab_06_agent_runner.md
- [x] **批次 9（收尾）**：14_interview_questions.md、code/README.md、终检

**全部生成完毕**：15 章知识文章 + 6 个 lab + 31 个 Go 源文件（含测试），全部通过 `GOOS=linux go vet ./...`。

### 每章生成后的自检项（goal.md 第四、九节）

1. 是否包含统一 14 段结构：本章目标 / 核心概念 / 底层原理 / 关键数据结构或流程 / 图解 / Go 示例 / 后端应用 / Agent 应用 / 常见错误设计 / 排障方法 / 实验任务 / 面试题 / 本章总结 / 延伸阅读；
2. 每个核心概念至少一个具体场景，术语首次出现给英文；
3. 明确区分：OS 通用原理 / Linux 实现 / Go runtime 实现，版本敏感处注明内核或 Go 版本；
4. 错误示例标明问题所在，正确示例解释为什么正确；
5. 排障按"现象 → 原因 → 验证 → 解决方案"组织，章末有检查清单；
6. **面试导向**：面试题必须附答题要点与加分点（大厂面试可直接用），不许只列问题；
7. **细致通俗**：每个抽象概念先给场景/类比再讲机制，拒绝教材式罗列和泛泛而谈。

### 终检结果（批次 9）

- [x] **goal.md 第三节 20 个问题**全部有主答章节，且 [14 章 §2](14_interview_questions.md) 给出统一的回答框架（结论→机制→数字→排查→延伸）；
- [x] **goal.md 第五节 16 个重点示例**全部落地为可运行代码（对照见下表）；
- [x] Agent、Sandbox、Go runtime、排障四类内容无遗漏；
- [x] 正文、代码、实验三者交叉引用一致；
- [x] 全部 Go 代码通过 `GOOS=linux go vet ./...`。

#### goal.md 第五节 16 个重点示例 → 代码对照

| # | 要求的示例 | 落地位置 |
|---|---|---|
| 1 | 启动和管理子进程 | [`01_process/01_basic_exec`](../code/01_process/01_basic_exec/main.go) |
| 2 | 捕获 stdout 和 stderr | [`01_process/02_capture_output`](../code/01_process/02_capture_output/main.go) |
| 3 | 超时后终止进程 | [`01_process/03_timeout_kill`](../code/01_process/03_timeout_kill/main.go) |
| 4 | 终止整个进程组 | [`01_process/04_process_group_kill`](../code/01_process/04_process_group_kill/main.go) |
| 5 | 回收子进程 | [`01_process/05_zombie_reap`](../code/01_process/05_zombie_reap/main.go) |
| 6 | 构造和排查 goroutine 泄漏 | [`02_concurrency/01_goroutine_leak`](../code/02_concurrency/01_goroutine_leak/main.go) |
| 7 | 构造死锁和竞态条件 | [`02_concurrency/03_race_deadlock`](../code/02_concurrency/03_race_deadlock/main.go) |
| 8 | Mutex/Atomic/Channel 解决并发问题 | [`03_race_deadlock`](../code/02_concurrency/03_race_deadlock/main.go) + [`05_task_state_machine`](../code/02_concurrency/05_task_state_machine/main.go) |
| 9 | 固定大小 Worker Pool | [`02_concurrency/04_worker_pool`](../code/02_concurrency/04_worker_pool/main.go) |
| 10 | 有界队列和背压 | [`04_worker_pool`](../code/02_concurrency/04_worker_pool/main.go) + [`03_memory/05_stream_backpressure`](../code/03_memory/05_stream_backpressure/main.go) |
| 11 | 流式读取大文件 | [`03_memory/05_stream_backpressure`](../code/03_memory/05_stream_backpressure/main.go) |
| 12 | 限制工具输出大小 | 同上（CappedBuffer）+ [`04_agent_runner/executor.go`](../code/06_sandbox/04_agent_runner/executor.go) |
| 13 | 用 pprof 定位 CPU 和内存问题 | [`05_profiling/03_pprof_targets`](../code/05_profiling/03_pprof_targets/main.go)（5 个靶场） |
| 14 | 用 strace 分析程序 | [`05_profiling/01_syscall_cost`](../code/05_profiling/01_syscall_cost/main.go) + [lab_05 实验 1–2](../labs/lab_05_debugging.md) |
| 15 | 简化版 Agent Task Runner | [`06_sandbox/04_agent_runner`](../code/06_sandbox/04_agent_runner)（十阶段完整实现） |
| 16 | 简化版 Sandbox 生命周期管理器 | [`06_sandbox/03_sandbox_lifecycle`](../code/06_sandbox/03_sandbox_lifecycle/main.go) |
