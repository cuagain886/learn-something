# 15 · 十周学习计划：每周 8–10 小时的可执行路线

> 顺序按后端 / Agent 开发需求排列，不照搬教材：**先能管好进程和并发（W1–W4），再管好内存和 I/O（W5–W8），最后隔离与集成（W9–W10）**。贯穿始终的主线项目是 Agent Code Runner（见 [13 章](13_agent_code_runner_project.md)），十个阶段分摊到各周，学完即交付。

## 0. 总览

| 周 | 主题 | 必读章节 | Runner 阶段 | 时间分配（8–10h 参考） |
|---|---|---|---|---|
| W1 | OS 全景：从可执行文件到进程 | 01（+09 的 strace 入门节） | 环境准备 | 读 4h / 实验 3h / 自测 1h |
| W2 | 进程与子进程管理 | 02 | ①单进程执行器 ②超时与取消 | 读 3h / 码 4h / 排障 2h |
| W3 | 线程、协程与 GMP | 03 | ③流式输出 ④进程组清理 | 读 4h / 码 3h / 排障 2h |
| W4 | 并发与同步 | 04 | ⑤并发任务 ⑥任务状态机 | 读 3h / 码 4h / 排障 2h |
| W5 | 虚拟内存与 OOM | 05 | —（观察实验为主） | 读 4h / 实验 3h / 排障 2h |
| W6 | Go 内存与 GC、背压 | 06 | 输出上限 + 有界队列（⑦前奏） | 读 3h / 码 4h / 排障 2h |
| W7 | 文件系统、fd 与安全路径 | 07 + 09（文件类 syscall） | 工作目录生命周期 | 读 3h / 码 3h / 排障 3h |
| W8 | I/O 模型与 netpoller | 08 | 流式输出复审 + 背压 | 读 4h / 码 3h / 排障 2h |
| W9 | 资源限制与系统排障 | 10 + 12 | ⑦资源限制 ⑩可观测性 | 读 3h / 码 3h / 排障 3h |
| W10 | 容器 Sandbox 与项目集成 | 11 + 13（14 自测） | ⑧容器 Sandbox ⑨多租户 | 读 3h / 码 5h / 自测 2h |

每周节奏建议：工作日 2–3 次 × 1.5h（阅读+小实验），周末一次 3–4h 整块时间做编码与排障任务。

---

## W1 · OS 全景：从可执行文件到进程

- **学习主题**：操作系统职责、用户态/内核态（user/kernel mode）、中断/异常/系统调用（interrupt / exception / syscall）、ELF 加载与动态链接、一个 Go 程序从 `./app` 到运行的完整链路。
- **必读章节**：[01 OS 基础](01_os_foundations.md)；[09 系统调用](09_system_calls.md) 的 strace 入门小节。
- **实验任务**（[lab_01](../labs/lab_01_process.md) 前半）：
  1. `strace -c ./hello` 统计一个最小 Go 程序的系统调用，找出 `mmap`、`clone`、`rt_sigaction` 各自在干什么；
  2. `readelf -h` / `file` / `ldd` 观察 Go 静态二进制与 C 动态二进制的差异；
  3. 用 `cat /proc/<pid>/maps` 观察进程地址空间布局。
- **编码任务**：搭建实验环境（WSL2/Linux + Go 1.22+），跑通 `code/` 目录约定；写一个打印自身 PID/PPID/UID 并读取 `/proc/self/status` 的小程序。
- **排障任务**：用 `strace -e trace=write` 观察高频日志程序，直观感受 syscall 次数与耗时的关系。
- **自测问题**：为什么应用程序不能直接操作硬件？用户态→内核态切换的成本是什么？系统调用和普通函数调用的区别？一个可执行文件如何变成进程？
- **本周产出物**：环境就绪 + 一页"Go 程序启动链路"笔记（ELF → 加载 → runtime 初始化 → main）。
- **验收标准**：能对着 strace 输出说出每类 syscall 的用途；能画出用户态/内核态切换的时序图。

## W2 · 进程与子进程管理（Agent 核心周）

- **学习主题**：fork/exec/wait、进程状态与进程树、僵尸/孤儿进程、信号（SIGTERM/SIGKILL/SIGINT/SIGCHLD）、进程组（process group）与会话（session）、优雅退出。
- **必读章节**：[02 进程](02_process.md)。
- **实验任务**（[lab_01](../labs/lab_01_process.md) 后半）：
  1. 构造僵尸进程，用 `ps -o pid,ppid,stat,cmd` 观察 `Z` 状态，修复它；
  2. 构造孤儿进程，验证被 init/systemd 收养；
  3. 复现"杀掉 shell，其启动的 python 还活着"，再用进程组整树终止。
- **编码任务**（Runner 阶段①②，对应 goal.md 示例 1–5）：
  - `exec.CommandContext` 启动子进程，捕获 stdout/stderr；
  - 超时后先 SIGTERM 等待宽限期再 SIGKILL；
  - `Setpgid` + 负 PID 信号终止整个进程组；
  - 正确 `Wait()` 回收，杜绝僵尸。
- **排障任务**：构造"读 stdout 不读 stderr 导致的管道死锁"，解释管道缓冲区写满的机制并修复。
- **自测问题**：为什么任务取消了子进程还在运行？为什么只杀 Shell 后 Python 仍在？为什么出现大量僵尸进程？为什么读子进程 stdout 可能死锁？
- **本周产出物**：`code/01_process/` 可运行示例 + Runner v0.1（能执行命令、超时杀进程树、无僵尸残留）。
- **验收标准**：`kill` Runner 或任务超时后，`ps -ef --forest` 查无残留子进程；连续跑 100 个任务无 `Z` 状态进程。

## W3 · 线程、协程与 GMP

- **学习主题**：线程 vs 进程、上下文切换成本、内核线程与用户线程、M:1/1:1/M:N 模型、GMP（G/M/P、本地/全局队列、work stealing、基于信号的抢占、syscall 阻塞时 P 的 handoff）、GOMAXPROCS、goroutine 栈增长、goroutine 泄漏。
- **必读章节**：[03 线程、协程与调度](03_thread_coroutine_scheduling.md)（配合 `go/knowledge/06_gmp_scheduler.md` 对照读）。
- **实验任务**（[lab_02](../labs/lab_02_goroutine.md)）：
  1. 对比 1 万线程（C/ulimit 视角）与 1 万 goroutine 的内存占用；
  2. 用 `GODEBUG=schedtrace=1000` 观察调度器状态；
  3. 构造 CPU 密集 goroutine 拖慢其他请求的现象，调整 GOMAXPROCS 观察变化。
- **编码任务**（Runner 阶段③④，对应 goal.md 示例 2、6）：
  - stdout/stderr 改为流式读取（bufio.Scanner / io.Copy 到回调），边执行边吐出；
  - 完善进程组清理为独立的 `killProcessTree`，覆盖"子进程再 fork"的情况；
  - 构造三种典型 goroutine 泄漏（无接收者的 channel 发送、忘记 close 的 range、卡死的网络读）。
- **排障任务**：对泄漏程序抓 `pprof/goroutine?debug=2`，按创建栈聚类定位泄漏点。
- **自测问题**：goroutine 为什么比线程轻量？goroutine 多是否一定更快？一个 goroutine 阻塞为什么不一定阻塞程序？goroutine 越来越多怎么定位？
- **本周产出物**：Runner v0.2（流式输出 + 可靠进程树清理）+ goroutine 泄漏排查笔记。
- **验收标准**：能对任意一份 goroutine dump 说出每类 goroutine 阻塞在哪、该不该存在；Runner 长跑后 goroutine 数量稳定。

## W4 · 并发与同步

- **学习主题**：竞态条件、原子性/可见性/有序性、Mutex/RWMutex/Cond/Once/sync.Map、atomic 与 CAS、死锁/活锁/饥饿、锁粒度与 False Sharing、happens-before、channel vs 锁的选型。
- **必读章节**：[04 并发与同步](04_concurrency_synchronization.md)（配合 `go/knowledge/13_memory_model.md`）。
- **实验任务**：用 `-race` 抓一个真实竞态；构造经典双锁死锁并用 goroutine dump 定位；用 mutex profile 观察锁竞争热点。
- **编码任务**（Runner 阶段⑤⑥，对应 goal.md 示例 7–9）：
  - 固定大小 Worker Pool 限制并发任务数；
  - 任务状态机（pending → running → succeeded/failed/canceled/timeout），非法迁移直接报错；
  - 幂等提交：同一任务 ID 重复提交只执行一次（错误示例：check-then-act 竞态；正确示例：原子的 LoadOrStore / 加锁状态机）。
- **排障任务**：复现"用户取消后任务仍在运行"和"重试导致重复执行副作用"，分别用状态机 + context 传播修复。
- **自测问题**：为什么大量锁竞争导致吞吐下降？为什么大量 goroutine 不一定提高性能？如何设计幂等性？如何限制并发数量？
- **本周产出物**：Runner v0.3（并发受控 + 状态机 + 幂等）+ 每类并发问题的"错误/正确示例对"。
- **验收标准**：`go test -race` 全绿；压测下重复提交同一任务只执行一次；取消后状态机终态正确。

## W5 · 虚拟内存与 OOM

- **学习主题**：虚拟内存与地址空间、页/多级页表/TLB、Page Fault 与缺页中断、堆与栈、mmap、Copy-on-Write、Swap、内存过量分配（overcommit）、OOM、RSS vs VSZ、共享内存。
- **必读章节**：[05 内存管理](05_memory_management.md)。
- **实验任务**（[lab_03](../labs/lab_03_memory.md) 前半）：
  1. 用 `mmap` 申请 1GB 观察 VSZ 涨而 RSS 不涨，逐页写入观察 RSS 增长（overcommit 直观化）；
  2. fork 后观察 COW：父子共享页，写时分裂；
  3. 在受限 cgroup / 小内存 VM 中触发 OOM Killer，用 `dmesg` 读懂 oom score 与被杀原因。
- **编码任务**：写一个观察工具，周期性读取 `/proc/self/status`（VmRSS/VmSize）与 `runtime.ReadMemStats` 并对比两套数字。
- **排障任务**：给定"容器被 OOM Kill"的现场（dmesg + cgroup memory.stat），写出现象→原因→验证→解决四段分析。
- **自测问题**：为什么内存持续增长？为什么容器被 OOM Kill？RSS 和堆内存为什么对不上？
- **本周产出物**：内存观察工具 + OOM 分析笔记（含 dmesg 逐字段解读）。
- **验收标准**：能独立解释 VSZ/RSS/共享内存三者关系；能从 dmesg 的 OOM 记录还原事发过程。

## W6 · Go 内存与 GC、背压

- **学习主题**：Go 堆栈与逃逸分析、mcache/mcentral/mheap 分配路径（概念级）、三色标记与写屏障、STW、GC 触发条件与 GOGC/GOMEMLIMIT、sync.Pool、字符串与字节切片转换成本、逻辑内存泄漏、scavenger 与"内存不还给 OS"。
- **必读章节**：[06 Go 内存与 GC](06_go_memory_and_gc.md)（配合 `go/knowledge/07_gc.md`、`08_memory_alloc_escape.md`）。
- **实验任务**（[lab_03](../labs/lab_03_memory.md) 后半）：`-gcflags='-m'` 验证逃逸判断；`GODEBUG=gctrace=1` 读懂每行 GC 日志；对比 GOGC=100/400 的内存与 CPU 曲线。
- **编码任务**（对应 goal.md 示例 10–12，Runner 阶段⑦前奏）：
  - 流式读取大文件（错误示例：`os.ReadFile` 1GB；正确：bufio 分块）；
  - 有界队列 + 背压：生产快于消费时阻塞或拒绝，而不是无界堆积；
  - Runner 的输出上限：超过 N MB 截断并标记 truncated，防工具日志撑爆内存。
- **排障任务**：用 heap profile 的 inuse/alloc 两视角定位一个"缓存无限增长"泄漏；解释一个"RSS 高但 heap profile 小"的案例（goroutine 栈 / 未归还页）。
- **自测问题**：为什么 Go 进程内存不下降？为什么无界队列最终导致崩溃？长对话上下文/流式输出/大截图该怎么处理才不 OOM？
- **本周产出物**：Runner v0.4（输出限制 + 有界队列）+ GC 调参笔记。
- **验收标准**：Runner 执行 `yes` 这类无限输出命令时内存平稳、任务被正确截断终止；能读懂任意一行 gctrace。

## W7 · 文件系统、fd 与安全路径

- **学习主题**：inode、文件描述符（fd）表、权限与用户组、硬/软链接、管道与命名管道、文件锁、Page Cache 与 fsync、顺序/随机读写、临时文件、fd 泄漏与 Too many open files、磁盘满 vs inode 满。
- **必读章节**：[07 文件系统](07_file_system.md) + [09 系统调用](09_system_calls.md)（open/read/write/close 调用链与成本）。
- **实验任务**（[lab_04](../labs/lab_04_io.md) 前半）：
  1. 用 `lsof -p` / `ls /proc/<pid>/fd` 观察 fd 表；构造 fd 泄漏直到 `too many open files`，再用 lsof 定位；
  2. 小文件把 inode 耗尽，复现"df 有空间但创建文件失败"；
  3. 对比 write 后有无 fsync 掉电语义（用 strace 观察）。
- **编码任务**（对应 goal.md 示例 11 的文件侧 + Sandbox 安全）：
  - Runner 任务工作目录：创建隔离目录 → 执行 → 无论成败都清理（defer + 信号处理）；
  - 安全路径处理：`filepath.Clean` + 前缀校验 + `O_NOFOLLOW`/EvalSymlinks 防路径穿越与符号链接攻击（附攻击用例）；
  - 上传/生成文件的大小与数量配额。
- **排障任务**：给一个 fd 持续增长的服务（HTTP body 未 Close），用 lsof 增量对比定位并修复。
- **自测问题**：为什么 fd 不断增长？为什么 Too many open files？为什么磁盘有空间却无法创建文件？为什么频繁写日志影响性能？
- **本周产出物**：Runner v0.5（工作目录全生命周期管理 + 路径安全）+ fd 排障笔记。
- **验收标准**：路径穿越用例（`../../etc/passwd`、恶意符号链接）全部被拦截；任务结束后工作目录与 fd 双清零。

## W8 · I/O 模型与 netpoller

- **学习主题**：阻塞/非阻塞、同步/异步、I/O 多路复用（select/poll/epoll）、LT vs ET、Reactor/Proactor、零拷贝（sendfile/splice）、DMA、Go netpoller 与 goroutine 的挂起唤醒、慢客户端问题与背压。
- **必读章节**：[08 I/O 模型](08_io_model.md)（配合 `go/knowledge/16_http_netpoll.md`）。
- **实验任务**（[lab_04](../labs/lab_04_io.md) 后半）：
  1. 用原始 epoll syscall 写最小 echo server，对比 `net` 包版本，strace 看两者的 epoll_ctl/epoll_wait；
  2. 构造慢客户端（读得极慢），观察服务端 write 阻塞与发送缓冲堆积；
  3. `ss -ntp` 读懂 Recv-Q/Send-Q。
- **编码任务**：给 Runner 的输出通道加背压——消费者慢时限制缓冲、必要时断开；对比"每连接一线程"与"epoll + goroutine"的资源占用。
- **排障任务**："CPU 不高但请求很慢"的完整排查：先 ss/netstat 看队列，再 pprof block/trace 看 goroutine 等待在哪。
- **自测问题**：为什么大量连接不需要一线程一连接？为什么慢客户端造成内存堆积？为什么写阻塞会影响系统？CPU 不高但请求慢怎么查？
- **本周产出物**：epoll echo server + Runner v0.6（输出背压）+ 一张"goroutine 网络读的完整链路图"（read → EAGAIN → netpoller 注册 → epoll_wait → 唤醒）。
- **验收标准**：能白板画出 netpoller 链路并指出每步在用户态还是内核态；慢客户端不再拖垮 Runner 内存。

## W9 · 资源限制与系统排障

- **学习主题**：ulimit 全家（NOFILE/NPROC/STACK/AS）、nice 与优先级、OOM Killer 策略、load average 的真实含义（R+D 状态）、CPU 使用率 vs load、上下文切换与软中断；工具矩阵：ps/top/htop/free/vmstat/iostat/pidstat/mpstat/dmesg/df/du/lsblk/ss/perf + pprof/trace/GODEBUG 系统化。
- **必读章节**：[10 Linux 资源限制](10_linux_resource_management.md) + [12 可观测性与排障](12_observability_and_debugging.md)。
- **实验任务**（[lab_05](../labs/lab_05_debugging.md)）：每类故障给一个靶场程序：CPU 打满、iowait 打高（load 高 CPU 低）、内存泄漏、fd 泄漏、锁竞争——限时用工具链定位，写四段式报告。
- **编码任务**（Runner 阶段⑦⑩）：
  - 用 `syscall.Setrlimit`/prlimit 给任务加 CPU 时间、fd、进程数限制；
  - 暴露监控指标：运行中任务数、队列长度、任务时长分位数、被杀原因计数、goroutine 数、内存。
- **排障任务**："无法创建线程/子进程"两个案例（NPROC 打满、pids cgroup 打满）+"load 20 但 CPU 30%"案例（NFS 卡住的 D 状态）。
- **自测问题**：load average 高说明什么？CPU 使用率与 load 的区别？无法创建线程可能有哪些原因？容器内 top 看到的为什么和宿主机不一致（引出 W10）？
- **本周产出物**：Runner v0.7（rlimit + 指标）+ 个人排障速查表（现象 → 首选工具 → 关键字段）。
- **验收标准**：五个靶场故障全部在 30 分钟内定位到根因；速查表覆盖 goal.md 第 11 模块所有工具。

## W10 · 容器 Sandbox 与项目集成

- **学习主题**：容器 vs 虚拟机、6 种 Namespace（PID/Mount/Network/UTS/IPC/User）、cgroup v1/v2（cpu/memory/pids/io）、chroot 与 pivot_root、capabilities、seccomp、OverlayFS 与镜像分层、容器生命周期；Sandbox 设计：防 fork bomb、防元数据服务（169.254.169.254）访问、非 root 运行、失控进程清理、多租户隔离、容器逃逸风险概念。
- **必读章节**：[11 容器与 Sandbox](11_container_and_sandbox.md) + [13 Agent Code Runner 项目](13_agent_code_runner_project.md)；自测用 [14 面试题集](14_interview_questions.md)。
- **实验任务**（[lab_06](../labs/lab_06_agent_runner.md)）：
  1. `unshare -pf --mount-proc` 手工创建 PID Namespace，观察容器内 PID 1；
  2. cgroup v2 手工限制一个进程的 memory.max 与 pids.max，用 fork bomb 验证 pids 限制生效；
  3. `docker run` 默认配置 vs 加固配置（--memory/--pids-limit/--cap-drop/--security-opt seccomp/网络策略）对照实验。
- **编码任务**（Runner 阶段⑧⑨，对应 goal.md 示例 15–16）：
  - 执行后端抽象：本地进程执行器之外新增容器执行器（复用同一状态机/超时/输出限制）；
  - Sandbox 生命周期管理器：创建（namespace+cgroup+工作目录）→ 运行 → 超时/取消 → 强制回收（杀进程组、删 cgroup、清目录）；
  - 多租户：每租户并发/磁盘/CPU 配额，互不可见。
- **排障任务**：复现"容器内 free 看到宿主机内存"并解释 Go 在容器中 GOMAXPROCS/GOMEMLIMIT 该如何设置；模拟 fork bomb 验证防线。
- **自测问题**：为什么 Sandbox 不能只依赖 Docker 默认配置？为什么 Agent 工具执行需要资源配额？seccomp 挡的是什么层面的攻击？
- **本周产出物**：**Agent Code Runner v1.0**（本地 + 容器双后端、全生命周期管理、指标齐全）+ Sandbox 架构设计文档一份。
- **验收标准**：goal.md 第六节 13 项功能全部可演示；20 个重点问题口头自测全部通过；fork bomb / 无限输出 / 路径穿越 / 超时不退出四类攻击用例全部被正确处理。

---

## 使用说明

1. **每周先看"验收标准"再开始学**——目标导向，读不动的章节先跑实验找体感。
2. **排障任务不要跳过**：故障要自己亲手构造出来再修，只看别人的分析等于没学。
3. **进度弹性**：W3（GMP）和 W10（Sandbox）最重，允许溢出到 12 周；但 W2 的进程管理是后面一切的地基，必须做扎实。
4. **产出物就是复习材料**：每周的笔记/速查表/代码，最后汇成你自己的排障手册。
