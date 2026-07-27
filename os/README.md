# 操作系统 · 面向后端与 Agent 开发的 OS 学习模块

> 依据 [goal.md](goal.md) 的目标生成。不是教材复述，而是回答三个问题：**后端程序跑起来时操作系统在干什么？出了问题怎么排查？Agent/Sandbox 该怎么设计？**

## 学习目标

学完本模块后应具备以下能力（对应 goal.md 七大目标）：

1. 理解一个 Go 后端进程从启动到处理请求的完整 OS 链路（加载、调度、内存、I/O）。
2. 能独立分析 CPU、内存、并发、I/O、进程和资源泄漏问题，形成"现象 → 原因 → 验证 → 解决"的排障方法论。
3. 说清 Go runtime（GMP、GC、netpoller、goroutine 栈）与操作系统（线程、虚拟内存、epoll、信号）的对应关系。
4. 正确设计 Agent 的子进程管理、任务取消、超时控制和资源清理机制——不留僵尸进程、不留孤儿进程树、不泄漏 fd。
5. 理解 Namespace、cgroup、seccomp、OverlayFS 等隔离技术，知道 Sandbox 每一层限制在防什么。
6. 熟练使用 Linux 工具（strace / lsof / vmstat / perf …）与 Go 工具（pprof / trace / GODEBUG …）定位线上问题。
7. 能独立实现一个简化版 Agent Code Runner / 代码执行 Sandbox。

## 适用人群

- 会写 Go 后端代码，但对"底下发生了什么"没有系统认识的开发者；
- 在做 Agent / 工具调用 / 代码执行平台，被子进程、超时、取消、资源清理坑过的开发者；
- 学过大学操作系统课，但无法把课本知识对应到 `top` 输出和线上故障的人。

前置要求：Go 基础语法、基本 Linux 命令行操作。不要求读过内核源码。

## 目录结构

```text
os/
├── goal.md                  # 需求与目标（本模块的"规格说明书"）
├── README.md                # 本文件：入口与导航
├── knowledge/               # 15 篇深度文章（编号 = 推荐阅读顺序）
│   ├── 00_learning_map.md   # 学习地图：章节目标/难度/优先级/终检对照表
│   ├── 01_os_foundations.md              # 用户态内核态、syscall、程序加载
│   ├── 02_process.md                     # fork/exec/wait、信号、进程组 ★Agent 命门
│   ├── 03_thread_coroutine_scheduling.md # 线程、协程、GMP
│   ├── 04_concurrency_synchronization.md # 竞态、锁、happens-before、状态机
│   ├── 05_memory_management.md           # 虚拟内存、Page Fault、OOM
│   ├── 06_go_memory_and_gc.md            # 逃逸、GC、防 OOM 五板斧
│   ├── 07_file_system.md                 # inode、fd、Page Cache、路径安全
│   ├── 08_io_model.md                    # epoll、netpoller、慢客户端
│   ├── 09_system_calls.md                # 调用链、成本量表、strace
│   ├── 10_linux_resource_management.md   # ulimit、load、OOM Killer、容器视图
│   ├── 11_container_and_sandbox.md       # Namespace、cgroup、seccomp ★重点
│   ├── 12_observability_and_debugging.md # 工具矩阵 + 五个故障剧本
│   ├── 13_agent_code_runner_project.md   # 十阶段毕业项目 ★重点
│   ├── 14_interview_questions.md         # 面试题集与三日冲刺
│   └── 15_ten_week_plan.md               # 10 周学习计划
├── code/                    # 31 个 Go 源文件，全部通过 vet
│   ├── 01_process/          # 子进程管理、超时、进程组、僵尸回收（5）
│   ├── 02_concurrency/      # 泄漏、竞态、死锁、Worker Pool、状态机（5）
│   ├── 03_memory/           # VSZ/RSS、逃逸、GC、泄漏模式、背压（5）
│   ├── 04_io/               # fd 泄漏、路径安全、工作目录、epoll、慢客户端（5）
│   ├── 05_profiling/        # syscall 成本、rlimit、五个 pprof 靶场（3）
│   └── 06_sandbox/          # namespace、cgroup、生命周期、Agent Runner（4）
└── labs/                    # 6 个动手实验（构造故障 → 排查 → 修复）
    ├── lab_01_process.md    # strace、僵尸、孤儿、进程树、管道死锁
    ├── lab_02_goroutine.md  # schedtrace、抢占、M 增生、泄漏、竞态、死锁
    ├── lab_03_memory.md     # 承诺vs交割、COW、OOM 案卷、逃逸、gctrace
    ├── lab_04_io.md         # fd 表、inode 耗尽、符号链接攻击、fsync、ss
    ├── lab_05_debugging.md  # rlimit、D 状态、容器视图 + 五个故障靶场
    └── lab_06_agent_runner.md # namespace、cgroup、fork bomb、Docker 加固对照
```

> 说明：goal.md 建议的 `operating-system-learning/` 扁平结构，按本仓库 CLAUDE.md 的统一规范映射为 `knowledge/ + code/ + labs/` 三层，章节内容一一对应，未做删减。goal.md 第五节要求的 16 个重点示例与代码的逐项对照表见 [00_learning_map.md](knowledge/00_learning_map.md) 末尾。

## 推荐学习顺序

**不按教材顺序，按后端/Agent 开发的需求优先级**（详细每周安排见 [15_ten_week_plan.md](knowledge/15_ten_week_plan.md)）：

```text
第一梯队（地基）     01 OS 基础 → 02 进程 → 03 线程协程与 GMP → 04 并发同步
第二梯队（资源）     05 虚拟内存 → 06 Go 内存与 GC → 07 文件系统 → 08 I/O 模型
第三梯队（系统）     09 系统调用 → 10 Linux 资源限制 → 12 可观测性与排障
第四梯队（综合）     11 容器与 Sandbox → 13 Agent Code Runner 项目 → 14 面试题自测
```

各章节依赖关系见 [00_learning_map.md](knowledge/00_learning_map.md) 的章节关系图。

## 与本仓库其他模块的关系

- `go/knowledge/06_gmp_scheduler.md`、`07_gc.md`、`27_syscall_cgo_netpoll.md` 等从 **Go runtime 视角**讲实现；本模块从 **OS 视角**讲 runtime 依赖的内核机制，两边互补，交叉引用。
- `docker-kubernetes/` 讲容器的使用与编排；本模块第 11 章讲容器**底下的内核技术**（Namespace/cgroup/seccomp）。
- `agent/` 讲 Agent 的模式与工程化；本模块讲 Agent 运行时的**进程/资源/隔离**基础。

## 实验运行方法

- **环境**：示例代码以 Linux 为准（内核 ≥ 5.x）。Windows 用户使用 WSL2，macOS 用户注意标注了 ⚠️ Linux-only 的示例（epoll、cgroup、Namespace 等无法在 macOS 原生运行）。
- **Go 版本**：1.22+（涉及调度与 GC 行为的章节会注明版本背景）。
- **运行方式**：每个 `code/0X_xxx/` 目录自包含，`cd` 进去 `go run .` 或按目录内 README 执行；涉及 root 权限的示例（cgroup、Namespace）会明确标注。
- **实验方式**：`labs/` 中每个实验都是"先构造故障，再用工具定位，最后修复验证"的闭环，不要跳过构造故障这一步。

## 最终能力目标（验收标准)

全部完成后，你应当能不查资料回答 [goal.md](goal.md) 第三节的 20 个重点问题（"为什么任务取消了子进程还在运行""为什么 Go 进程内存不下降"……），并且交付一个满足以下要求的 Agent Code Runner：

- 超时/取消后进程树无残留，任务目录被清理；
- stdout/stderr 流式读取且有输出上限，不会因大输出 OOM；
- 并发任务数受控，任务状态机无竞态，重复提交幂等；
- 有基础监控指标，可用 pprof 定位自身问题；
- 可选进阶：基于 Namespace + cgroup + seccomp 的资源隔离。
