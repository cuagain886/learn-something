# 02 · 进程：fork/exec/wait、信号与进程树管理 ⭐⭐⭐

> 对应代码：[`../code/01_process`](../code/01_process)（全部 5 个示例）· 对应实验：[lab_01](../labs/lab_01_process.md) 实验 4–7
>
> 这是 Agent 开发的命门章节。学完要能回答：为什么任务取消了子进程还在运行？为什么只杀 Shell 后 Python 进程仍然存在？为什么读子进程 stdout 可能死锁？为什么出现大量僵尸进程？

## 1. 本章目标

- 掌握进程的内核表示（task_struct）、状态机、进程树；
- 掌握 fork/exec/wait 三件套与 COW（写时复制）；
- 能解释僵尸/孤儿进程的成因，并在 Go 里杜绝它们；
- 掌握信号机制与 SIGTERM/SIGKILL/SIGINT/SIGCHLD 的正确用法；
- 掌握进程组/会话，能可靠地**终止整棵进程树**；
- 能实现：捕获子进程输出不死锁、超时强杀、取消传播、资源清理。

## 2. 核心概念

### 2.1 进程是什么：程序的"运行实例"

程序（program）是磁盘上的死文件，进程（process）是它在内存中的活实例——同一个程序可以同时跑 N 个进程，互不相干。内核视角，一个进程 = **一份 task_struct 结构体** + **一套资源**：

```text
task_struct (Linux 内核中每个进程/线程一份, 约几 KB)
├── pid, tgid           # 进程号; tgid 是线程组 id(第03章讲线程时揭晓两者关系)
├── state               # 运行状态 R/S/D/Z/T
├── parent              # 指向父进程 → 全系统构成一棵进程树
├── mm        ──────→   # 地址空间: 页表、代码/堆/栈区间(第05章)
├── files     ──────→   # 打开文件表: fd 0,1,2,... (第07章)
├── signal/sighand      # 信号: 待决集合、屏蔽字、处理函数表
├── cred                # 身份: uid/gid/capabilities(第11章)
├── nsproxy   ──────→   # 所属 namespace(第11章)
└── exit_code           # 退出码, 死后留给父进程看
```

这张表是全模块的地图：**后面每一章都在深挖其中一个字段**。

### 2.2 进程状态：ps 输出里的 STAT 列

```text
         创建                    获得CPU
  fork ────────→  R (就绪/运行) ⇄────────  在 CPU 上执行
                    │  ▲
        等待事件(读磁盘│  │ 事件到达(数据就绪)
        /锁/sleep)    ▼  │
                  S (可中断睡眠)  ← 绝大多数"闲着"的进程都在这
                  D (不可中断睡眠) ← 通常在等磁盘/NFS I/O, ⚠️ kill -9 也杀不动
                    │
          exit()    ▼
                  Z (僵尸) ── 父进程 wait() ──→ 彻底消失
                  T (被暂停: SIGSTOP/Ctrl-Z)
```

| STAT | 含义 | 工程意义 |
|---|---|---|
| R | 在跑或在运行队列排队 | R 很多 → CPU 不够分，load 升高（第 10 章） |
| S | 可中断睡眠（interruptible sleep） | 正常。等网络/定时器/锁都是 S |
| D | 不可中断睡眠（uninterruptible sleep） | ⚠️ 大量 D = 存储/NFS 出事的强信号；D 计入 load；SIGKILL 无效——信号要等它醒来才处理 |
| Z | 僵尸（zombie） | 已死但父进程还没收尸；只占一条 task_struct 不占内存 CPU，但**占 PID** |
| T | 停止 | 被调试器/SIGSTOP 暂停 |

**为什么 D 状态 kill -9 杀不掉（面试高频）**：信号处理发生在进程**返回用户态的时机**，而 D 状态进程卡在内核里等硬件应答、不响应任何唤醒。它不是"忽略"信号，是"根本没到能看信号的地方"。硬件恢复或超时后它退出 D，信号立即生效。

### 2.3 PID、PPID 与进程树

每个进程有 PID（process ID），并记录 PPID（parent PID）——谁 fork 的它。全系统因此构成一棵以 PID 1（systemd/init）为根的树，`pstree -p` 可见。

**Agent 视角的关键事实**：你 `exec.Command("bash", "-c", "python worker.py")`，得到的树是：

```text
agent(Go, pid=100)
 └── bash (pid=201, 你 cmd.Process.Pid 拿到的是它)
      └── python (pid=202, 真正干活的, 你【没有】它的 PID)
```

`cmd.Process.Kill()` 只发信号给 201——python 202 毫发无伤，还被 PID 1 收养继续跑。**这就是"任务取消了子进程还在运行"的完整答案**，解法在 2.7 进程组。

## 3. 底层原理

### 3.1 fork：一次调用，两次返回

`fork()` 复制当前进程：子进程拿到父进程几乎一切的副本（地址空间、fd 表、信号处理、环境），只有 PID、统计信息等不同。最反直觉的是**一次调用两次返回**：父进程里返回子 PID，子进程里返回 0——同一行代码，两个进程各自往下跑。

**COW（Copy-on-Write，写时复制）**让 fork 变得便宜：fork 并不真的拷贝内存，而是让父子**共享全部物理页**，把两边页表都标记为只读。任何一方写某页时触发 Page Fault，内核这才复制该页（第 05 章详解）。所以 fork 一个 10GB 的进程是毫秒级的——只拷页表。

⚠️ 但 fork 大进程仍有两个真实成本：① 拷贝页表本身（10GB 进程的页表约 20MB）；② fork 瞬间"承诺"的内存翻倍，overcommit 严格模式下可能直接 ENOMEM（第 05 章 OOM 一节的经典案例：Redis bgsave）。

**fork / vfork / clone 的关系（面试加分）**：Linux 内核里只有一个底层实现 `kernel_clone()`，三者是不同参数的马甲——fork = 全复制+COW；vfork = 共享地址空间且暂停父进程（历史优化，现已不推荐）；clone = 精细控制共享什么（线程就是 `clone(CLONE_VM|CLONE_FILES|...)`，共享地址空间和 fd 表，第 03 章）。Go 的 `os/exec` 底层用 fork+exec 组合（`syscall.ForkExec`，实际经 clone 实现，并在 fork 后、exec 前的窄窗口里做 Setpgid 等设置）。

### 3.2 exec：换脑不换壳

`execve(path, argv, envp)` 把当前进程的内存映像整个丢弃，装载新程序（第 01 章 3.4 的 ELF 流程）。**不变的**：PID/PPID、打开的 fd（默认继承！）、进程组/会话、大部分资源限制。**变的**：代码、堆栈、信号处理函数（重置为默认，因为老函数的代码已不存在）。

fd 继承是把双刃剑：`exec.Command` 靠它把管道两端塞给子进程当 stdout；但**不该继承的 fd 泄漏给子进程是经典事故**（子进程意外持有监听 socket，导致父进程重启后端口仍被占用）。Linux 用 `O_CLOEXEC`（close-on-exec）标记解决——Go 的 os 包打开文件默认都带它，`cmd.ExtraFiles` 才是显式传 fd 的正道。

### 3.3 wait 与僵尸：为什么"死了还要留一条记录"

进程 `exit(code)` 后，内核**不能立即抹掉它的 task_struct**——退出码、CPU 统计还没人看过。于是它进入 **Z（僵尸）状态**：像一张"死亡证明"，等父进程用 `wait()`/`waitpid()` 来领取。领取后 task_struct 才释放，PID 才可复用。

- **僵尸进程（zombie）**：子死了，父活着但**不 wait**。危害：不占内存 CPU，但占 PID——PID 用尽（`kernel.pid_max`，默认 32768 或更大）后全系统无法创建任何进程。⚠️ 杀僵尸唯一的办法是让父进程 wait，或杀掉父进程让僵尸被 init 收养回收；对僵尸本身 kill -9 无意义——它已经死了。
- **孤儿进程（orphan）**：父先死，子还活着。内核把它**过继**给 PID 1（或最近的 subreaper，见 7.3），PID 1 会尽职地 wait。孤儿本身无害，**但它是 Agent 的大敌**：你杀掉 bash，python 变孤儿继续跑——任务"取消"了，算力还在烧。

**SIGCHLD**：子进程死时内核给父进程发的通知信号。服务端正确姿势之一：收到 SIGCHLD 后循环 `waitpid(-1, WNOHANG)` 收尸。Go 用户不用手写这个——`cmd.Wait()` 内部处理，但**你必须调用它**（见第 8 节错误 1）。

### 3.4 信号：内核的"异步敲门"

信号（signal）是内核→进程的异步通知。投递机制：内核在目标的 task_struct 里置一个 pending 位 → 目标进程**下次从内核态返回用户态时**检查并执行处理动作（默认动作 / 自定义 handler / 忽略）。这解释了两件事：D 状态收不到信号（不返回用户态）；信号不是实时的（最迟一个调度周期内送达）。

四个必须精通的信号：

| 信号 | 默认动作 | 可捕获? | 语义与正确用法 |
|---|---|---|---|
| SIGTERM (15) | 终止 | ✅ | "请你退出"——给进程清理机会。**永远先发它** |
| SIGKILL (9) | 终止 | ❌ 不可捕获/忽略/阻塞 | "处决"——内核直接回收，进程零机会执行任何代码。**宽限期后的兜底** |
| SIGINT (2) | 终止 | ✅ | Ctrl-C。⚠️ 发给**前台进程组**全体，不是单个进程（见 2.7） |
| SIGCHLD | 忽略 | ✅ | 子进程状态变化通知，收尸的触发器 |

**为什么"先 TERM 后 KILL"是铁律**：SIGKILL 下进程来不及 flush 缓冲、提交/回滚事务、删临时文件、关闭连接——数据损坏和资源泄漏的温床。K8s 终止 Pod 的行为就是该铁律的产品化：SIGTERM → 等 `terminationGracePeriodSeconds`（默认 30s）→ SIGKILL。你的 Runner 也要长这样（第 5 节示例 3）。

**优雅退出的 Go 标准姿势**：

```go
ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
defer stop()
// ctx 在收到信号时被取消 → 传给 http.Server.Shutdown / 各 worker
```

### 3.5 退出码：进程留给世界的最后一句话

`wait` 拿到的状态里编码着死因：正常 `exit(n)` → 退出码 n（0=成功，约定俗成）；被信号 k 杀死 → shell 显示 128+k。速查：

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1/2/... | 程序自定义错误 |
| 126 | 找到了但不可执行（权限） |
| 127 | 命令不存在（shell 报的） |
| 137 | 128+9 = 被 SIGKILL —— ⚠️ 容器里见到它先怀疑 **OOM Kill**（第 10 章）或超时强杀 |
| 143 | 128+15 = 被 SIGTERM（多半是正常停服） |

Go 侧：`cmd.Wait()` 返回的 `*exec.ExitError` 里 `ExitCode()` 拿码；被信号杀死时 ExitCode() 返回 -1，要用 `ProcessState.Sys().(syscall.WaitStatus).Signal()` 拿信号——Runner 记录任务死因时必须区分这两种（示例 1）。

## 4. 关键机制：进程组、会话与"杀掉整棵树"

### 4.1 三层结构

```text
会话 Session (SID)  ≈ 一次登录/一个终端窗口
└── 进程组 PGID=100 (前台: 正在占着终端的)     ┐ Ctrl-C 的 SIGINT
│    ├── vim (pid=100, 组长)                  ┘ 发给这一整组
└── 进程组 PGID=200 (后台: 以 & 启动的)
     ├── make (pid=200, 组长)
     └── cc1  (pid=213)
```

- **进程组（process group）**：信号的"群发单位"。`kill(-PGID, sig)`（负号！）把信号发给组内**每一个**进程。fork 出的子进程**默认继承父的进程组**——所以 bash 和它 fork 的 python 天然同组。
- **会话（session）**：进程组的集合，绑定一个控制终端（controlling terminal）。`setsid()` 创建新会话并脱离终端——守护进程化的核心一步。
- **Ctrl-C 的真相**：终端驱动收到 ^C → 给**前台进程组整组**发 SIGINT。这就是为什么 Ctrl-C 能一次杀掉 `a | b | c` 管道里的三个进程——shell 把整条管道放进同一个进程组。

### 4.2 Agent 杀进程树的标准方案（本章最重要的工程结论）

问题：`cmd.Process.Kill()` = `kill(pid, SIGKILL)`，只杀 bash，不杀它 fork 的 python/node/...

**方案 A：进程组隔离 + 负 PID 群发（主力方案，示例 4）**

```go
cmd := exec.Command("bash", "-c", script)
cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // ① 子进程自立门户当组长
                                                      //    它 fork 的后代都在这个新组里
_ = cmd.Start()
pgid := cmd.Process.Pid                               // ② Setpgid 后 PGID == 子 PID
// ...超时/取消时:
syscall.Kill(-pgid, syscall.SIGTERM)                  // ③ 负号 = 发给整组
time.Sleep(gracePeriod)                               //    宽限期
syscall.Kill(-pgid, syscall.SIGKILL)                  // ④ 兜底处决整组
```

为什么要 Setpgid：不设的话子进程和**你的 Agent 同组**，`kill(-pgid)` 会把 Agent 自己也杀了。⚠️ 设了之后 Ctrl-C 也不再影响子进程（不同组了），终端里调试时要自己处理。

方案 A 的漏洞：恶意/不羁的子进程可以自己再 `setpgid`/`setsid` 逃出你的组。堵法：
- **方案 B：PR_SET_PDEATHSIG**（Linux 特有）：子进程设置"父死我也死"信号。Go: `SysProcAttr{Pdeathsig: syscall.SIGKILL}`。⚠️ 陷阱：它绑的是**创建它的线程**死亡，Go 运行时线程可能退出，且只保护一级子进程——当辅助手段。
- **方案 C：PID Namespace**（第 11 章）：namespace 里 PID 1 死，内核保证整个 namespace 所有进程被杀。**Sandbox 的终极答案**。
- **方案 D：cgroup.kill**（cgroup v2, Linux 5.14+）：`echo 1 > cgroup.kill` 原子杀光 cgroup 内所有进程，逃逸也没用（第 11 章）。

工程分层：普通 Runner 用 A（+B 加固）；不可信代码必须 C/D。

### 4.3 守护进程：为什么要 fork 两次

守护进程（daemon）= 脱离终端、后台长期运行的进程。传统的 daemon 化有一套固定仪式，每一步都在解决一个具体问题：

```text
① fork()，父进程 exit
   目的: ① 让 shell 立即返回（父死，子被 init 收养）
         ② 保证子进程【不是进程组组长】—— 这是 setsid 的前提条件
              （setsid 会失败如果调用者已是组长，因为它要新建一个同名的会话/组）
② setsid()
   目的: 新建会话 + 新建进程组 + 【脱离控制终端】
         从此终端的 SIGHUP/SIGINT 再也影响不到它
③ 再 fork() 一次，父进程 exit          ← 最反直觉的一步
   目的: 第二个子进程【不是会话首领】，因此它【永远无法再获得控制终端】
         （只有会话首领打开终端设备时才会自动获得控制终端）
         ⚠️ 这是 System V 的规矩；BSD 系可以用 TIOCNOTTY 达到同样效果
④ chdir("/")        不占着某个目录 → 那个文件系统才能被卸载
⑤ umask(0)          不受继承的 umask 影响，文件权限完全自己说了算
⑥ 关闭/重定向 0,1,2  指向 /dev/null，避免误写终端；也防止继承的 fd 泄漏
```

**⚠️ 现代实践：不要自己写 daemon 化代码。**

| 时代 | 做法 | 谁管重启/日志/依赖 |
|---|---|---|
| 传统 | 程序自己双 fork | 自己写 pid 文件 + 自己写日志轮转 |
| **现代** | **程序就在前台跑**，用 systemd（`Type=simple`）或容器 | 由 init 系统/容器运行时管 |

Go 尤其如此——**Go 程序不能安全地在 `fork()` 之后不 `exec` 就继续运行**：fork 只复制调用线程，而 Go runtime 是多线程的（GMP 的 M 们、sysmon、GC worker），子进程里那些线程全部消失，但它们持有的锁和状态还在 → 随时死锁。这也是标准库**故意不提供 `fork()`** 的原因（只有 `ForkExec` 这种 fork 后立刻 exec 的组合）。

👉 **工程结论**：Go 服务写成前台进程 + `signal.NotifyContext` 处理 SIGTERM（§3.4），交给 systemd/K8s 托管。双 fork 只在面试题里出现（Q8），但 `setsid` 的**会话语义**你每天都在用——它正是"子进程能逃出你的进程组"（§4.2 方案 A 的漏洞）的原理。

## 5. Go 语言示例

五个可运行示例在 [`code/01_process/`](../../os/code/01_process)，与正文对应关系：

| 示例 | 演示内容 | 对应正文 |
|---|---|---|
| [01_basic_exec](../code/01_process/01_basic_exec/main.go) | 启动子进程、环境/目录控制、退出码与死因判定（exit vs signal） | 3.2、3.5 |
| [02_capture_output](../code/01_process/02_capture_output/main.go) | 输出捕获三姿势；⚠️ 复现管道写满死锁 + 两种修复 | 6.1 |
| [03_timeout_kill](../code/01_process/03_timeout_kill/main.go) | CommandContext 的默认杀法及其不足；TERM→宽限→KILL 的正确超时 | 3.4 |
| [04_process_group_kill](../code/01_process/04_process_group_kill/main.go) | 复现"杀 bash 留 python"；Setpgid + 负 PID 整树击杀 | 4.2 |
| [05_zombie_reap](../code/01_process/05_zombie_reap/main.go) | 亲手制造僵尸、ps 观察 Z、Wait 收尸；孤儿的收养观察 | 3.3 |

### 6.1 必须吃透的一个死锁：管道缓冲区写满

管道（pipe）是定长内核缓冲区（Linux 默认 64KB，`ulimit -p` 单位 512B×8）。`StdoutPipe` 给子进程的 stdout 接了根管道，**你不读，它写满 64KB 后子进程的 write 就永久阻塞**：

```go
// ⚠️ 错误: 先 Wait 再读 → 死锁四件套之一
out, _ := cmd.StdoutPipe()
cmd.Start()
cmd.Wait()                  // 等子进程退出; 子进程卡在 write(输出>64KB); 互相等 → 死锁
io.ReadAll(out)

// ⚠️ 错误: 只读 stdout 不读 stderr → 子进程 stderr 刷满 64KB 时同样卡死
// (python 异常栈、编译器警告都走 stderr, Agent 场景必踩)

// ✅ 正确: 两根管道各配一个 goroutine 并发排水, 全部读完后才 Wait
var wg sync.WaitGroup
for _, pair := range []struct{ r io.Reader; tag string }{{outPipe,"out"},{errPipe,"err"}} {
    wg.Add(1)
    go func(r io.Reader, tag string) { defer wg.Done(); scanLines(r, tag) }(pair.r, pair.tag)
}
wg.Wait()   // 先确保管道排空(读到 EOF)
cmd.Wait()  // 再收尸 —— godoc 明确要求这个顺序
```

为什么正确：读端持续排水 → 子进程永不阻塞在 write；EOF 后 Wait 不会与读竞争管道关闭。`cmd.Output()`/`CombinedOutput()` 内部就是这么做的，但它们**把全部输出堆内存**——对可能无限输出的工具（`yes`、死循环日志）等于自杀，Runner 必须用流式+上限（第 06 章背压、示例 12）。

## 6. 后端开发中的应用

- **优雅停服标配**：`signal.NotifyContext` 捕 SIGTERM → `server.Shutdown(ctx)` 排空在途请求 → 退出。配合 K8s 的 preStop/gracePeriod 实现零中断发布。踩坑点：忘记给 Shutdown 传带超时的 ctx，卡死在长连接上，最终被 SIGKILL，前功尽弃。
- **子进程即插件**：调用 ffmpeg/imagemagick/git 的服务，全部适用本章模式：Setpgid、并发排水、超时分级击杀、Wait 收尸——四件套一个不能少。
- **守护进程已外包**：经典双 fork+setsid 手法如今交给 systemd/容器运行时；但面试仍问（见 Q8），且 `setsid` 语义在杀进程树时依然每天用。

## 7. Agent 开发中的应用：子进程管理清单

Agent 执行工具的完整生命周期，每步都对应本章一个机制：

```text
① 启动     exec.CommandContext + Setpgid(自立进程组) + 工作目录/环境白名单
② 输出     StdoutPipe/StderrPipe + 两个排水 goroutine + 行缓冲回传 + 大小上限
③ 输入     需要交互则接 StdinPipe, 不需要则显式关闭(防子进程等 stdin 挂起)
④ 超时     context.WithTimeout → 到点 kill(-pgid, SIGTERM) → 宽限 3~5s → kill(-pgid, SIGKILL)
⑤ 取消     用户取消 = cancel() 同一条路径; ctx 层层传递, 不另起炉灶
⑥ 收尸     排水完成后 cmd.Wait(); 记录 ExitCode 或 Signal 作为任务死因
⑦ 清理     defer 删除任务工作目录、关闭全部 fd; 失败也要执行(第07章)
⑧ 验尸     结束后 pgrep -g <pgid> 应为空; 不为空说明有逃逸者 → 升级 Sandbox(第11章)
```

**取消传播的设计原则**：任务取消是一条 ctx 链：HTTP 请求断开/用户点停止 → cancel() → CommandContext 发起击杀 → 进程组整体死亡 → Wait 返回 → 状态机置 canceled → 清理钩子跑完。**任何一环用了不带 ctx 的阻塞调用，链条就断了**——这是"取消了却还在跑"的第二大成因（第一大是没杀进程组）。

## 8. 常见问题与错误设计

**错误 1：Start 后不 Wait → 僵尸制造机。**

```go
// ⚠️ 错误: 火忘炮制
cmd.Start()
go doSomethingElse() // 没人 Wait, 子进程死后变僵尸, 挂在 Agent 名下越积越多
// ✅ 正确: Start 必配 Wait(哪怕在 goroutine 里), 就像 Open 必配 Close
```

**错误 2：用 Output()/CombinedOutput() 跑不可信命令。** 无限输出 → 内存打爆（OOM）。正确：流式 + 截断上限。

**错误 3：cmd.Process.Kill() 当"取消"。** 只杀直接子进程 + 是 SIGKILL 零清理机会。正确：4.2 方案 A 的分级整组击杀。

**错误 4：超时用 time.AfterFunc 自己拼。** 忘了 cancel 泄漏 timer、与 Wait 竞态、杀完不收尸……`exec.CommandContext` + 自定义 `cmd.Cancel`/`cmd.WaitDelay`（Go 1.20+）已把这些坑填了：Cancel 定义"到点先干什么"（发 SIGTERM），WaitDelay 定义"宽限多久后强杀并放弃管道"。示例 3 演示两者配合。

**错误 5：在 handler 里同步跑长命令。** 请求超时/客户端断开后命令仍在跑。正确：命令生命周期绑请求 ctx（或独立任务队列，第 04 章状态机）。

## 9. 排障方法

**案例 A：机器上出现大量 `<defunct>` 僵尸。**
- 现象：`ps aux | grep -c defunct` 数百；创建新进程偶发失败。
- 原因：某父进程 Start 后不 Wait（或自定义 SIGCHLD 处理丢了收尸逻辑）。
- 验证：`ps -eo pid,ppid,stat,cmd | awk '$3~/Z/'` 取僵尸的 **PPID**——僵尸的 CMD 列没有信息量，**罪犯是父进程**；`pstree -p <ppid>` 确认聚集。
- 解决：修父进程代码补 Wait；应急：杀掉父进程，僵尸被 PID 1 收养后立即被回收。⚠️ 直接 kill -9 僵尸是无效操作——它已经死了。

**案例 B：任务取消了，python 还在烧 CPU。**
- 现象：Agent 显示任务已取消，`top` 里 python 满载；其 PPID=1。
- 原因：只杀了 bash（进程而非进程组），python 成孤儿被 init 收养。
- 验证：复现时先 `ps -eo pid,ppid,pgid,cmd | grep -E 'bash|python'`——看 python 的 PGID：与 bash 同组但你只 kill 了 bash 的 PID，就是本案。
- 解决：Setpgid + `kill(-pgid)`（4.2）；上线前用示例 4 的验尸步骤回归。

**日常工具**：`pstree -p` 看树、`ps -o pid,ppid,pgid,sid,stat,cmd` 看组织关系、`kill -0 <pid>` 探活（不发真信号只查存在与权限）、`/proc/<pid>/status` 看 State/PPid/SigPnd 全貌。

## 10. 实验任务

[lab_01_process.md](../labs/lab_01_process.md) 实验 4–7：④ 制造并回收僵尸；⑤ 制造孤儿观察收养；⑥ 复现"杀 bash 留 python"再用进程组整树击杀；⑦ 复现管道死锁并修复。每个实验都要求先预测再验证。

## 11. 面试题（附答题要点）

**Q1：fork 后父子进程的关系？COW 是什么？**
要点：子进程复制父的地址空间/fd 表/信号设置，PID 不同；一次调用两次返回。COW：fork 只拷页表、共享物理页并标只读，任一方写时缺页中断才复制该页——fork 大进程毫秒级。加分：页表拷贝与 overcommit 承诺仍是真实成本（Redis bgsave 案例）；fork/vfork/clone 都是 kernel_clone 的参数马甲。

**Q2：僵尸进程和孤儿进程的区别？各有什么危害？怎么处理？**
要点：僵尸=子死父不收尸，占 PID，堆多了耗尽 PID 表；孤儿=父死子活，被 PID 1 收养，本身无害但代表"失控的任务还在跑"。处理：僵尸→修父进程补 wait / 杀父让 init 收；孤儿→杀之前就该用进程组/namespace 连坐。⚠️ kill -9 对僵尸无效是必考点。

**Q3：为什么内核要设计僵尸态？直接销毁不行吗？**
要点：退出码和统计信息必须有个地方保存到父进程查询为止，否则 wait 语义无法实现；这是"父进程有知情权"的设计。类比：死亡证明必须有人签收才能销户。

**Q4：SIGTERM 和 SIGKILL 的区别？为什么 kill -9 有时也杀不掉？**
要点：TERM 可捕获（清理机会），KILL 不可捕获（内核直接回收）。杀不掉的两种情况：D 状态（卡内核等 I/O，信号处理时机不到）和僵尸（已经死了）。加分：K8s gracePeriod 就是 TERM→KILL 的工程化；D 状态大量出现指向存储故障。

**Q5：Ctrl-C 发生了什么？为什么能杀掉整条管道？**
要点：终端驱动把 SIGINT 发给**前台进程组**整组；shell 把 `a|b|c` 放进同一进程组。引出：进程组是信号群发单位，kill 负 PID 即群发——顺势把杀进程树方案讲了（面试官通常就是想听这个）。

**Q6：如何保证杀掉子进程创建的所有孙进程？**
要点：分层答——① Setpgid+kill(-pgid)（够用但可被 setsid 逃逸）；② Pdeathsig 辅助（Linux only，绑创建线程）；③ PID namespace：ns 内 PID 1 死全体死（内核保证，Sandbox 标准）；④ cgroup v2 的 cgroup.kill 原子全灭。能按防逃逸强度排序就是满分。

**Q7：读子进程 stdout 为什么可能死锁？**
要点：管道是 64KB 定长内核缓冲；父不读→满→子 write 阻塞；父在 Wait 等子退出→互相等。变体：只读 stdout 不读 stderr 同理。解法：并发排水两根管道，排空后才 Wait。

**Q8：守护进程为什么要 fork 两次？**
要点：一次 fork+setsid 脱离终端并当会话首领；**二次 fork 放弃会话首领身份**，防止将来误打开终端设备时重新获得控制终端（System V 规矩）；配合 chdir("/")、关标准 fd、umask。收尾提一句：现代交给 systemd，双 fork 是历史仪式但面试常青。

**Q9：exit code 137 意味着什么？**
要点：128+9=被 SIGKILL。三大嫌疑按序排查：容器 OOM Kill（`dmesg`/cgroup memory.events）、超时被编排系统强杀（K8s liveness/gracePeriod 到期）、人为 kill -9。Go 侧 ExitCode()=-1 时要从 WaitStatus 取信号。

## 12. 本章总结

- 进程 = task_struct + 资源；状态机里 D 和 Z 是排障重点：D 杀不动（等 I/O），Z 杀不着（已死，找父进程）。
- fork 靠 COW 便宜复制，exec 换映像不换壳，wait 收尸释放 PID——三件套残缺（无 wait）= 僵尸，父先死 = 孤儿。
- 信号是异步敲门：TERM 商量、KILL 处决、先商量后处决是铁律；信号在返回用户态时处理，解释了 D 状态免疫。
- 进程组是信号群发单位：Setpgid + kill(-pgid) 是杀进程树的主力，PID namespace / cgroup.kill 是防逃逸终极方案。
- 管道 64KB：不排水就死锁——并发读两根管道，排空再 Wait。

**检查清单**：
- [ ] 我能画出进程状态迁移图，说清 D/Z 各自为什么"杀不掉"
- [ ] 我能解释 COW 的完整机制和 fork 的两个残余成本
- [ ] 我能手写 TERM→宽限→KILL 的超时终止（含 Setpgid 与负 PID）
- [ ] 我能说出管道死锁的四个变体和统一解法
- [ ] 我能按防逃逸强度排出杀进程树的四个方案
- [ ] 我的 Runner 结束后 `pgrep -g <pgid>` 为空、`ps` 无 Z、工作目录已删

## 13. 延伸阅读

- 《The Linux Programming Interface》第 24–28 章（进程创建/终止/监控/exec）、第 34 章（进程组与会话）——本章最好的参考书
- `man 2 fork/execve/wait4/setpgid/setsid`、`man 7 signal`
- Go 官方 `os/exec` 文档中关于 Wait 与管道顺序、Cancel/WaitDelay 的说明（Go 1.20+ 行为）
- LWN: *The evolution of control groups*（为第 11 章 cgroup.kill 铺垫）
- 本仓库 `go/knowledge/14_structured_concurrency.md`——ctx 取消链的 Go 侧设计
