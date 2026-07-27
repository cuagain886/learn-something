# 13 · Agent Code Runner：十阶段渐进式项目 ⭐⭐⭐⭐⭐

> 对应代码：[`../code/06_sandbox/04_agent_runner`](../code/06_sandbox/04_agent_runner) · 对应实验：[lab_06](../labs/lab_06_agent_runner.md) 实验 6–10
>
> 这是本模块的**毕业设计**。前十二章学的每一个机制，在这里都要变成能跑、能扛攻击、能被观测的代码。做完它，你就具备了开发 Agent 代码执行平台的基础能力。

## 1. 项目目标与总体架构

**目标**：实现一个能安全执行 Shell / 代码任务的 Agent 运行器——超时可控、取消可传播、资源有限额、失败可排查、残留可清零。

```text
                    ┌─────────────────────────────────────┐
   HTTP/gRPC API ──►│  Submit(taskID, script, limits)     │
                    │    │                                │
                    │    ├─ 幂等占坑 (第04章)               │
                    │    ├─ 并发限流 (第04章 信号量)         │
                    │    ▼                                │
                    │  TaskStore (状态机, 第04章)          │
                    │    │  pending→running→终态           │
                    │    ▼                                │
                    │  Executor 接口                       │
                    │    ├─ LocalExecutor  (进程组+rlimit)  │
                    │    └─ SandboxExecutor(ns+cgroup,第11章)│
                    │    │                                │
                    │    ├─ 工作目录生命周期 (第07章)        │
                    │    ├─ 流式输出+限额   (第02/06章)      │
                    │    ├─ 超时/取消传播   (第02/04章)      │
                    │    └─ 回收+验尸       (第11/12章)      │
                    │    ▼                                │
                    │  Metrics / Logs / Events (第12章)    │
                    └─────────────────────────────────────┘
```

**十个阶段的依赖关系**：

```text
①单进程执行 → ②超时取消 → ③流式输出 → ④进程组清理 → ⑤并发任务
                                                        ↓
        ⑩可观测性 ← ⑨多租户隔离 ← ⑧容器 Sandbox ← ⑦资源限制 ← ⑥任务状态机
```

⚠️ **不要跳阶段**。每个阶段都在前一阶段的代码上增量演进，且都有独立的验收标准。跳过 ④（进程组清理）直接做 ⑧（容器）的人，会在容器不可用的降级路径上留下进程泄漏。

---

## 阶段 ①：单进程命令执行器

### 目标
能执行一条命令，拿到 stdout/stderr/退出码，且**不留僵尸**。

### 架构设计
```go
type Task struct {
    ID     string
    Script string
}
type Result struct {
    State    State  // succeeded / failed
    ExitCode int
    Signal   syscall.Signal
    Stdout   string
    Stderr   string
    Duration time.Duration
}
type Executor interface {
    Execute(ctx context.Context, t *Task) (*Result, error)
}
```

### 关键代码
```go
cmd := exec.Command("sh", "-c", t.Script)
cmd.Dir = workDir
cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + workDir, "LANG=C"}  // 白名单，不泄露宿主机凭证
err := cmd.Run()   // Run = Start + Wait，内部保证收尸
```

### 容易出现的问题
| 问题 | 原因 | 对策 |
|---|---|---|
| 僵尸进程堆积 | `Start()` 后不 `Wait()` | Start 必配 Wait（如同 Open 必配 Close，第 02 章） |
| 死因分不清 | 只记 ExitCode | 被信号杀死时 ExitCode 是 -1，要从 `WaitStatus.Signal()` 取（第 02 章 §3.5） |
| 继承了宿主机环境变量 | 默认继承全部 Env | 显式白名单 |
| 没有 shell 时报错难懂 | 命令不存在 vs shell 找不到命令 | 区分"启动失败"（无子进程）和 exit 127 |

### 测试方法
```bash
# 四种结局各测一次
echo hello           → succeeded, exit 0
exit 3               → failed, exit 3
kill -TERM $$        → killed, signal=terminated
no_such_command      → failed, exit 127
```

### 验收标准
- [ ] 四种结局都能正确分类，`state` 字段可区分
- [ ] 连续执行 100 个任务后 `ps -eo stat | grep -c Z` 为 0
- [ ] 环境变量不含宿主机的敏感项（`AWS_*`、`TOKEN` 等）

---

## 阶段 ②：支持超时和取消

### 目标
超时和用户取消走**同一条路径**，且先礼后兵（SIGTERM → 宽限期 → SIGKILL）。

### 架构设计
**核心原则**：超时 = `context.WithTimeout`，取消 = `context.WithCancel`——**下游代码不需要区分它们**，只认 `ctx.Done()`。区分只发生在最后的终态判定。

### 关键代码
```go
ctx, cancel := context.WithTimeout(parent, limits.Timeout)
defer cancel()

cmd := exec.CommandContext(ctx, "sh", "-c", t.Script)
cmd.Cancel = func() error {                       // ctx 到期时先发 SIGTERM（给清理机会）
    return syscall.Kill(cmd.Process.Pid, syscall.SIGTERM)
}
cmd.WaitDelay = limits.GracePeriod                // 宽限期后强杀 + 放弃管道，保证 Wait 返回

// 终态判定：必须区分 timeout / canceled / killed
switch {
case errors.Is(ctx.Err(), context.DeadlineExceeded): state = StateTimeout
case errors.Is(ctx.Err(), context.Canceled):         state = StateCanceled
}
```

### 容易出现的问题
| 问题 | 原因 |
|---|---|
| 取消了但进程还在跑 | `cancel()` 只关了 ctx，没有实际发信号 |
| Wait 永不返回 | 孙进程持有管道写端，父进程等 EOF 等到天荒地老 → 必须设 `WaitDelay` |
| 超时时间层层失效 | 内层超时 ≥ 外层超时，外层永远先触发 → **内层必须严格小于外层**（第 08 章 §7） |
| 直接用 SIGKILL | 进程来不及 flush 缓冲、提交事务、删临时文件 |

### 测试方法
```bash
sleep 60                                    → timeout, ~timeout 时长
trap 'echo cleanup; exit 143' TERM; sleep 60 → timeout, 但能看到 "cleanup" 输出 ✅
trap '' TERM; while :; do sleep 1; done      → timeout, 耗时 = timeout + grace（KILL 兜底）
```

### 验收标准
- [ ] 听话的进程在 SIGTERM 阶段体面退出，遗言（清理输出）能被捕获
- [ ] 无赖进程（`trap '' TERM`）在宽限期后被 SIGKILL
- [ ] 取消和超时的终态可区分
- [ ] `Wait()` 在任何情况下都会在 `timeout + grace + ε` 内返回

---

## 阶段 ③：支持流式输出

### 目标
边执行边吐出输出，且**永不因大输出 OOM**。

### 架构设计
```text
子进程 stdout ──管道(64KB)──► drain goroutine ──► 回调/Channel ──► 用户
子进程 stderr ──管道(64KB)──► drain goroutine ──┘        │
                                                      CappedWriter (限额+truncated 标记)
```

### 关键代码
```go
outPipe, _ := cmd.StdoutPipe()
errPipe, _ := cmd.StderrPipe()
cmd.Start()

var wg sync.WaitGroup
wg.Add(2)
drain := func(r io.Reader, stream string) {
    defer wg.Done()
    sc := bufio.NewScanner(r)
    sc.Buffer(make([]byte, 64<<10), 1<<20)   // 行缓冲上限，防超长行撑爆内存
    for sc.Scan() {
        capped.Write(sc.Bytes())              // 限额存储
        onLine(stream, sc.Text())             // 流式回调给用户
    }
}
go drain(outPipe, "stdout")
go drain(errPipe, "stderr")

wg.Wait()        // ⚠️ 必须先排空管道
cmd.Wait()       // 再收尸 —— 顺序不能反（第 02 章 §5）
```

### 容易出现的问题
| 问题 | 原因 | 后果 |
|---|---|---|
| **管道死锁** | 只读 stdout 不读 stderr，或先 Wait 后读 | 子进程写满 64KB 后永久阻塞 |
| 大输出 OOM | 用 `cmd.Output()` / `io.ReadAll` | 工具跑 `yes` 就打爆内存 |
| 超长行撑爆内存 | Scanner 没设 buffer 上限 | 一行 1GB 的 JSON 直接爆 |
| 输出乱序 | stdout/stderr 分别缓冲，时序不保证 | 需要精确交错时用 `cmd.Stdout = cmd.Stderr = 同一个 writer` |

### 测试方法
```bash
# 死锁检测：只写 stderr 的任务
for i in $(seq 10000); do echo "err line $i" >&2; done   → 必须正常完成，不能挂起
# 无限输出：
yes                                                       → 被限额截断，内存平稳
# 超长行：
python3 -c "print('x' * 100000000)"                       → 被行缓冲上限拦住
```

### 验收标准
- [ ] 只写 stderr 的任务不会死锁
- [ ] 执行 `yes` 时进程 RSS 保持平稳（用 `03_pprof_targets` 的观察方法验证）
- [ ] `truncated` 标记正确，`total_bytes` 记录真实产出量（审计用）
- [ ] 流式回调的延迟 < 100ms（用户能实时看到输出）

---

## 阶段 ④：支持进程组清理

### 目标
**杀掉的是整棵进程树**，不是只有直接子进程。

### 架构设计
第 02 章 §4.2 的四个方案，按防逃逸强度分层落地：
```text
方案 A  Setpgid + kill(-PGID)      ← 本阶段实现（够用的基线）
方案 B  Pdeathsig                  ← 辅助加固
方案 C  PID namespace              ← 阶段 ⑧
方案 D  cgroup.kill                ← 阶段 ⑦
```

### 关键代码
```go
cmd.SysProcAttr = &syscall.SysProcAttr{
    Setpgid:  true,                   // 子进程自立进程组，后代全在组里
    Pdeathsig: syscall.SIGKILL,       // 辅助：Runner 死了子进程跟着死
}
cmd.Start()
pgid := cmd.Process.Pid               // Setpgid 后 PGID == 子进程 PID

// 击杀：负号 = 发给整组
cmd.Cancel = func() error {
    err := syscall.Kill(-pgid, syscall.SIGTERM)
    if errors.Is(err, syscall.ESRCH) { return nil }   // 组已空
    return err
}
// 兜底：WaitDelay 的 SIGKILL 只打直接子进程，最后再对整组补一枪
defer syscall.Kill(-pgid, syscall.SIGKILL)
```

### 容易出现的问题
| 问题 | 原因 |
|---|---|
| 把 Runner 自己杀了 | 忘了 `Setpgid`，子进程与 Runner 同组，`kill(-pgid)` 连坐 |
| 孙进程逃逸 | 子进程自己调了 `setsid`/`setpgid` → 需要方案 C/D |
| Ctrl-C 不再影响子进程 | Setpgid 后不在前台进程组了——这是**预期行为**，调试时注意 |
| ESRCH 被当成错误 | 组已经空了是正常情况，要特殊处理 |

### 测试方法
```bash
# 三级进程树：runner → sh → sleep
sleep 300 & echo $!; wait
# 超时后验尸：
pgrep -g <pgid>      # 必须为空
```

### 验收标准
- [ ] 超时/取消后 `pgrep -g <pgid>` 为空
- [ ] 100 次任务后系统上没有多余的 `sleep`/`sh` 残留进程
- [ ] Runner 自身不会被误杀

---

## 阶段 ⑤：支持并发任务

### 目标
并发数受控，队列有界，满载时**背压而非崩溃**。

### 架构设计
```go
type Runner struct {
    sem      chan struct{}      // 信号量：并发额度
    queue    chan *Task         // 有界队列
    tasks    sync.Map           // taskID → *Task
    executor Executor
}
```
选型（第 04 章 §4.3）：任务同质稳定 → worker pool；稀疏突发 → 信号量。Runner 通常用**信号量 + 有界等待队列**。

### 关键代码
```go
func (r *Runner) Submit(ctx context.Context, t *Task) error {
    select {
    case r.sem <- struct{}{}:                    // 拿到并发名额
    case <-ctx.Done():
        return fmt.Errorf("%w: %v", ErrBusy, ctx.Err())   // 背压：拒绝而非无限等待
    }
    go func() {
        defer func() { <-r.sem }()               // ⚠️ 无论如何都要还名额
        defer r.cleanup(t)
        r.execute(t)
    }()
    return nil
}
```

### 容易出现的问题
| 问题 | 原因 | 后果 |
|---|---|---|
| **名额泄漏** | panic 或提前 return 时没还名额 | 并发额度逐渐降到 0，Runner 假死 |
| 无界队列 | `queue` 容量设成很大或不限 | 把"今天的拒绝"攒成"明天的 OOM"（第 06 章） |
| 队列满时无限等待 | Submit 不带 ctx | 上游被拖死，压力无法反馈 |
| goroutine 泄漏 | 任务 goroutine 没有退出路径 | 第 03 章的三种泄漏模式 |

### 测试方法
```bash
# 并发压测：100 个任务，并发上限 8
# 验证：同时运行的任务数 ≤ 8；被拒绝的任务返回明确的 ErrBusy
go test -race ./...      # 竞态检测必须全绿
```

### 验收标准
- [ ] 并发任务数严格 ≤ 上限（用原子计数器验证峰值）
- [ ] 队列满时返回 `ErrBusy` 而非阻塞或崩溃
- [ ] 压测后 `runtime.NumGoroutine()` 回落到基线
- [ ] `go test -race` 全绿

---

## 阶段 ⑥：支持任务状态机

### 目标
**并发攻击下状态不错乱**：重复提交只执行一次，迟到的取消被拒绝，终态不可篡改。

### 架构设计
第 04 章 §4.1/4.2 的幂等占坑 + 迁移表：
```go
var transitions = map[State][]State{
    StatePending: {StateRunning, StateCanceled},
    StateRunning: {StateSucceeded, StateFailed, StateCanceled, StateTimeout, StateOOMKilled},
    // 终态无出边
}
```

### 关键代码
```go
// 幂等提交：把"查 + 登记"压成一个原子点
actual, loaded := r.tasks.LoadOrStore(t.ID, t)
if loaded {
    return actual.(*Task), ErrAlreadyExists    // 幂等返回同一实例
}

// 状态迁移：非法迁移直接拒绝（这不是错误，是秩序）
func (t *Task) To(next State) bool {
    t.mu.Lock()
    if !slices.Contains(transitions[t.state], next) {
        t.mu.Unlock()
        return false                            // 迟到的取消、重复的完成，都在这里被挡下
    }
    t.state = next
    hooks := t.onTerminal
    isTerminal := next.IsTerminal()
    t.mu.Unlock()                               // ⚠️ 钩子在锁外跑（可能做慢操作）

    if isTerminal {
        for _, h := range hooks { h(next) }     // 清理挂在终态迁移上 → 天然恰好一次
    }
    return true
}
```

### 容易出现的问题
| 问题 | 原因 |
|---|---|
| 同一任务执行两次 | check-then-act 竞态（第 04 章 §2.2 形态 B） |
| 清理执行两次 | 清理散落在多处而非挂在状态迁移上 |
| 清理一次没执行 | 只在"取消"路径清理，正常完成时忘了 |
| 死锁 | 状态钩子里回调状态机（重入 Mutex） |

### 测试方法
```bash
# 三类并发攻击（对应 05_task_state_machine 示例）
100 个 goroutine 同时 Submit 同一 taskID   → 只执行 1 次
200 轮"执行 vs 取消"赛跑                    → 两边都赢过，但状态从不错乱
终态后再报 Failed/Canceled                  → 全部被拒绝
```

### 验收标准
- [ ] 并发重复提交 100 次，只执行 1 次
- [ ] 取消赛跑 200 轮无状态错乱
- [ ] 清理钩子执行次数 == 进入终态的任务数（恰好一次）
- [ ] `go test -race` 全绿

---

## 阶段 ⑦：支持资源限制

### 目标
单任务的 CPU / 内存 / 进程数 / 磁盘 / 输出全部有硬限额。

### 架构设计
三层限制（第 10 章 §7）：
```text
应用层    输出上限、超时、并发数        管自己
rlimit    RLIMIT_CPU/NOFILE/FSIZE     管单进程（有 UID 共享的坑）
cgroup    cpu/memory/pids/io          管整棵进程树 ← 不可信代码的正确答案
```

### 关键代码
```go
// cgroup（推荐，第 11 章 §4.2）
cgPath := "/sys/fs/cgroup/agent/" + taskID
os.Mkdir(cgPath, 0755)
write(cgPath+"/cpu.max",         "50000 100000")   // 0.5 核
write(cgPath+"/memory.max",      "536870912")      // 512MB
write(cgPath+"/memory.swap.max", "0")              // 禁 swap（防绕过）
write(cgPath+"/pids.max",        "64")             // ⚠️ 防 fork bomb 唯一可靠手段
cmd.Start()
write(cgPath+"/cgroup.procs", strconv.Itoa(cmd.Process.Pid))   // 子孙自动继承

// rlimit（降级方案，给子进程设）
exec.Command("prlimit", "--cpu=10", "--nofile=64", "--fsize=10485760", "--", "sh", "-c", script)
```

### 容易出现的问题
| 问题 | 原因 |
|---|---|
| 内存限制挡不住 fork bomb | fork bomb 的每个进程都很小 → 必须靠 `pids.max` |
| OOM 死因判不出 | 只看 exit 137，分不清超时强杀还是 OOM → 查 `memory.events` 的 `oom_kill` |
| CPU 限制导致延迟毛刺 | 多线程在 period 内提前用光配额被冻结（第 11 章 §4.3 坑 1） |
| cgroup 目录删不掉 | 里面还有进程 → 先 `cgroup.kill` 再 `rmdir` |
| 忘了禁 swap | 内存超限时先换出而不是 OOM，限制形同虚设 |

### 测试方法
```bash
# 四类资源攻击
while :; do :; done                          → CPU 被限制在配额内（cpu.stat 有 throttled）
python3 -c "a=[];\nwhile 1: a.append(bytearray(10<<20))"  → OOM Kill，state=oom_killed
:(){ :|:& };:                                → pids.max 挡住，宿主机无恙
dd if=/dev/zero of=big bs=1M count=10000     → FSIZE 或磁盘配额挡住
```

### 验收标准
- [ ] 四类资源攻击全部被限制在配额内，宿主机无影响
- [ ] `state=oom_killed` 能与 `timeout` / `killed` 正确区分
- [ ] 任务结束后 cgroup 目录被删除（无泄漏）
- [ ] `cpu.stat` 的 throttled 数据被记录进任务指标（供调优）

---

## 阶段 ⑧：支持容器 Sandbox

### 目标
执行后端可插拔：本地进程执行器 + 容器执行器，**复用同一套状态机/超时/输出限额逻辑**。

### 架构设计
```go
type Executor interface {
    Execute(ctx context.Context, t *Task, out OutputSink) (*Result, error)
}
type LocalExecutor struct   { /* 进程组 + rlimit + cgroup */ }
type SandboxExecutor struct { /* namespace + cgroup + pivot_root + seccomp */ }
type DockerExecutor struct  { /* docker run 加固参数 */ }
```
⚠️ **关键设计**：Executor 只负责"怎么跑"，**不碰状态机、不碰幂等、不碰指标**——这些在 Runner 层统一处理。这样新增执行后端时不会重复实现（也不会重复出 bug）。

### 关键代码
```go
// 最小加固的 Docker 执行器（第 11 章 §7.1）
args := []string{"run", "--rm",
    "--user", "65534:65534",
    "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--cap-drop=ALL",
    "--security-opt", "no-new-privileges",
    "--security-opt", "seccomp=" + seccompProfile,
    "--network", "none",
    "--memory", "512m", "--memory-swap", "512m",
    "--cpus", "0.5",
    "--pids-limit", "64",
    "--ulimit", "nofile=64:64", "--ulimit", "fsize=10485760",
    "-v", workDir + ":/work:rw", "-w", "/work",
    image, "sh", "-c", script,
}
```

### 容易出现的问题
| 问题 | 原因 |
|---|---|
| 容器杀不干净 | 只 `docker kill` 没 `docker rm` → 残留容器堆积 |
| 只依赖 Docker 默认配置 | 默认无内存/CPU/pids 限制、以 root 运行、可访问元数据服务（第 11 章 §7.1） |
| 容器内僵尸堆积 | PID 1 不 wait → 用 `--init` 或 tini |
| 降级路径未测试 | 容器不可用时回退到本地执行器，但那条路径没人测过 |
| 镜像拉取超时算进任务超时 | 任务还没开始就"超时"了 → 拉取要独立计时 |

### 测试方法
```bash
# 逃逸尝试（都必须失败）
cat /etc/shadow                     → 权限拒绝（非 root）
mount -o bind / /mnt                → seccomp 拦截 mount
curl http://169.254.169.254/        → 网络不通（--network none）
ls /var/run/docker.sock             → 不存在（没挂载）
```

### 验收标准
- [ ] 同一个任务在 Local 和 Sandbox 两种执行器下行为一致（除了隔离强度）
- [ ] 容器执行完毕后 `docker ps -a` 无残留
- [ ] 四类逃逸尝试全部失败
- [ ] 容器不可用时能正确降级到本地执行器，且降级路径有测试覆盖

---

## 阶段 ⑨：支持多租户隔离

### 目标
租户之间**互不可见、互不影响、配额独立**。

### 架构设计
```text
配额分层:
  租户总配额  (cpu=4核, mem=8G, 并发=20, 磁盘=50G)
    └─ 任务配额 (cpu=0.5核, mem=512M, 磁盘=1G)
  ⚠️ 租户总配额 ≥ 任务配额 × 并发上限，否则任务间互相饿死

隔离手段:
  uid       每租户独立 uid → 文件权限天然隔离
  cgroup    /sys/fs/cgroup/agent/<tenant>/<task>/ → 两级配额
  namespace PID/Mount/Network → 互相看不见
  工作目录  /var/agent/<tenant>/<task>/ → 0700 + 独立属主
```

### 关键代码
```go
type Tenant struct {
    ID       string
    UID, GID int                 // 每租户独立 uid
    Quota    ResourceQuota       // 租户总配额
    sem      chan struct{}       // 租户级并发信号量
}

// 两级 cgroup
tenantCg := "/sys/fs/cgroup/agent/" + tenant.ID     // 租户总配额
taskCg   := tenantCg + "/" + taskID                  // 任务配额（受父级约束）

// 以租户 uid 运行
cmd.SysProcAttr.Credential = &syscall.Credential{
    Uid: uint32(tenant.UID), Gid: uint32(tenant.GID),
}
```

### 容易出现的问题
| 问题 | 原因 | 后果 |
|---|---|---|
| 所有任务共用一个 uid | 图省事 | `RLIMIT_NPROC` 额度共享，一个租户的 fork bomb 影响所有人（第 10 章） |
| 只有任务配额没有租户配额 | 分层没做 | 一个租户开满并发就吃光集群 |
| 工作目录权限过松 | 0755 或共用父目录 | 租户 A 能读 B 的中间产物 |
| 审计日志缺租户维度 | 日志没带 tenant 字段 | 出事后无法定位是谁干的 |

### 测试方法
```bash
# 跨租户可见性测试
租户 A 的任务里: ps aux              → 看不到租户 B 的进程
租户 A 的任务里: ls /var/agent/      → 看不到租户 B 的目录（或权限拒绝）
租户 A 打满并发                       → 租户 B 的任务仍能正常提交执行
```

### 验收标准
- [ ] 跨租户进程/文件/网络完全不可见
- [ ] 一个租户打满配额不影响其他租户
- [ ] 每条日志都带 `tenant_id` 和 `task_id`
- [ ] 租户配额 ≥ 任务配额 × 并发上限（配置校验时检查）

---

## 阶段 ⑩：支持可观测性

### 目标
出问题时**能在 5 分钟内定位**，而不是靠猜。

### 架构设计（第 12 章 §7）
```text
指标 (Metrics)
  agent_tasks_running            当前运行中
  agent_tasks_queued             队列长度
  agent_task_duration_seconds    任务时长分位数 (P50/P95/P99)
  agent_tasks_total{state=...}   ⚠️ 按终态分类计数（排障的起点）
  agent_task_output_bytes        输出量分布（发现异常大输出）
  agent_task_truncated_total     被截断的任务数
  agent_subprocess_count         当前子进程数 ← 泄漏的早期信号
  agent_workdir_count            当前工作目录数 ← 清理失败的早期信号
  go_goroutines / go_memstats_*  Runner 自身健康

日志 (Logs) — 结构化，每个任务的完整生命周期事件
  {"ts":..., "task_id":"t-123", "tenant":"acme", "event":"submitted"}
  {"ts":..., "task_id":"t-123", "event":"started", "pid":1234, "cgroup":"..."}
  {"ts":..., "task_id":"t-123", "event":"output_truncated", "total_bytes":10485760}
  {"ts":..., "task_id":"t-123", "event":"terminated", "state":"timeout", "signal":"killed"}
  {"ts":..., "task_id":"t-123", "event":"cleaned", "duration_ms":45}

追踪 (Tracing)
  task_id 贯穿 API → 状态机 → 执行器 → 子进程日志 ← 没有它就无法关联
```

### 关键代码
```go
// 验尸检查做成自动化断言（第 12 章 §7）
func (r *Runner) autopsy(t *Task) []string {
    var problems []string
    if procs := readCgroupProcs(t.cgroupPath); len(procs) > 0 {
        problems = append(problems, fmt.Sprintf("cgroup 内残留 %d 个进程", len(procs)))
    }
    if syscall.Kill(-t.pgid, 0) == nil {
        problems = append(problems, "进程组仍有存活进程")
    }
    if _, err := os.Stat(t.workDir); err == nil {
        problems = append(problems, "工作目录未删除")
    }
    metrics.AutopsyProblems.Add(float64(len(problems)))
    return problems
}
```

### 容易出现的问题
| 问题 | 原因 |
|---|---|
| 终态只有"成功/失败" | 无法区分超时、OOM、取消 → 排障时抓瞎 |
| 没有 task_id 贯穿 | 子进程的日志和任务对不上 |
| pprof 端点暴露公网 | 信息泄露 + DoS 入口 → **只监听 localhost** |
| 指标只有平均值 | 平均值掩盖长尾 → 必须有 P95/P99 |
| 验尸检查只在开发时手工做 | 应该做成自动化断言 + 指标 |

### 测试方法
```bash
# 混沌测试：随机 kill Runner，重启后检查
kill -9 <runner_pid>
# 重启后: 上次的工作目录被扫孤儿清理、cgroup 被回收、指标从 0 重新计数
```

### 验收标准
- [ ] 五种终态都有独立计数，能画出饼图
- [ ] 任意一个 task_id 能在日志里检索出完整生命周期
- [ ] 验尸检查自动化，异常时告警
- [ ] pprof 端点只监听 localhost
- [ ] 能用 pprof 定位 Runner 自身的 CPU/内存/goroutine 问题

---

## 2. 完整验收：goal.md 第六节的十三项功能

| # | 功能 | 阶段 | 验证方式 |
|---|---|---|---|
| 1 | 接收执行任务 | ① | API 提交返回 task_id |
| 2 | 为任务创建独立工作目录 | ① | 目录随机名 + 0700 |
| 3 | 启动子进程 | ① | 四种结局分类正确 |
| 4 | 流式读取 stdout/stderr | ③ | 只写 stderr 不死锁 |
| 5 | 设置执行超时 | ② | 分级击杀，遗言可捕获 |
| 6 | 支持用户取消 | ② | 与超时同路径，终态可区分 |
| 7 | 限制最大输出 | ③ | `yes` 命令下内存平稳 |
| 8 | 限制并发任务数 | ⑤ | 峰值 ≤ 上限，满载返回 ErrBusy |
| 9 | 记录任务状态 | ⑥ | 状态机迁移表 + 并发攻击测试 |
| 10 | 防止重复执行 | ⑥ | 并发提交 100 次只执行 1 次 |
| 11 | 任务结束后清理进程和文件 | ④⑦ | 验尸检查全绿 |
| 12 | 提供基础监控指标 | ⑩ | 指标清单齐全 |
| 13 | 后续扩展到容器 Sandbox | ⑧ | 执行器可插拔，逃逸尝试全失败 |

## 3. 四类攻击的终极测试

上线前必过（对应 lab_06 实验 9）：

```bash
# 攻击 1：无限输出
yes
# 期望：输出被截断标记 truncated，Runner 内存平稳，任务正常终止

# 攻击 2：fork bomb
:(){ :|:& };:
# 期望：pids.max 挡住，宿主机无影响，任务被终止且进程清零

# 攻击 3：路径穿越
cat ../../../../etc/shadow
ln -s /etc/passwd innocent.txt && cat innocent.txt
# 期望：两种都失败（第 07 章三层防御 + 第 11 章 namespace）

# 攻击 4：超时不退出
trap '' TERM; while :; do sleep 1; done
# 期望：宽限期后被 SIGKILL，进程树清零，state=timeout
```

## 4. 从"能跑"到"能上线"的差距

做完十个阶段只是**功能完备**，离生产还有这些距离：

| 维度 | 还需要什么 |
|---|---|
| **持久化** | 任务状态存数据库，Runner 重启后能恢复（当前全在内存） |
| **分布式** | 多个 Runner 实例 + 任务分发 + 分布式幂等（Redis SETNX / DB 唯一约束） |
| **优雅发布** | SIGTERM 后停止接新任务、等存量完成（有总超时）、再退出 |
| **限流与优先级** | 租户级令牌桶、任务优先级队列、饥饿防护 |
| **镜像管理** | 预热常用镜像、镜像白名单、拉取超时独立计时 |
| **审计合规** | 完整的执行记录留存、敏感操作告警、可追溯 |
| **成本核算** | 按 CPU 秒 / 内存 GB 秒计费，需要精确的资源使用统计 |

## 5. 面试题（附答题要点）

**Q1：设计一个代码执行沙箱，你会怎么做？（系统设计题）**
要点：**分层作答**——① 进程管理层（进程组、超时分级击杀、流式输出防死锁、收尸）；② 资源限制层（cgroup 的 cpu/memory/pids/io，强调 pids.max 防 fork bomb）；③ 隔离层（namespace 六件套、seccomp 白名单、非 root、capabilities 全丢）；④ 网络层（默认禁网，必须联网时屏蔽元数据服务和内网）；⑤ 生命周期层（工作目录三层清理、验尸检查）；⑥ 可观测层（终态分类、task_id 贯穿）。最后加一句"用 gVisor/Kata 可以进一步提升隔离强度，代价是性能"。

**Q2：任务超时后进程还在跑，怎么排查和解决？**
要点：先定位——`ps -eo pid,ppid,pgid,cmd` 看残留进程的 PGID 和 PPID（PPID=1 说明成了孤儿）。根因：只 kill 了直接子进程。解决按防逃逸强度分层：Setpgid + `kill(-pgid)` → Pdeathsig 辅助 → PID namespace（ns 内 PID 1 死则全灭）→ `cgroup.kill`（原子，无法逃逸）。加分：说出验尸检查应该自动化。

**Q3：怎么保证任务不会重复执行？**
要点：单机用 `LoadOrStore` 原子占坑；分布式用 DB 唯一约束 / Redis SETNX。**核心思想是把"查 + 登记"压成一个原子操作**。配合状态机拒绝非法迁移。⚠️ 强调：跨系统的 exactly-once 不存在，只有"至少一次投递 + 幂等消费"——副作用本身也要有幂等键。

**Q4：Runner 自己 OOM 了怎么办？**
要点：分两个层面——① **防**：输出限额、有界队列、流式处理（第 06 章五板斧）、GOMEMLIMIT 设为容器 limit 的 90%；② **查**：exit 137 → `dmesg` / `memory.events` 确认是 OOM，heap profile 的 `inuse_space` 做 diff 找增长点。加分：区分"Runner 自己漏"和"被任务撑爆"——前者看 heap profile，后者看是否有任务的输出/队列超预期。

**Q5：如何设计任务的超时体系？**
要点：**分层且内层严格小于外层**——单次 write 超时（秒级）< 单个工具执行超时（分钟级）< 整个任务超时 < HTTP 请求超时。否则内层形同虚设。另外：镜像拉取、容器启动要独立计时，不能算进任务执行时间。加分：超时后要先 SIGTERM 给清理机会，宽限期后才 SIGKILL。

**Q6：这个项目里，哪个设计决策最关键？**
要点（开放题，展示深度）：我会答**"Executor 接口把'怎么跑'和'怎么管'分开"**——状态机、幂等、超时、输出限额、指标全在 Runner 层统一实现，Executor 只管执行。这样新增执行后端（本地/容器/远程）时不会重复实现，也不会重复出 bug。其次是**清理路径幂等且不可跳过**（sync.Once + defer + 信号处理 + 启动扫孤儿四层），因为清理是唯一"失败了不会立刻暴露、但会持续累积"的环节。

## 6. 本章总结

- 十个阶段是**增量演进**，每阶段都有独立验收；不要跳阶段，尤其不能跳过进程组清理直接做容器。
- 三条贯穿全项目的铁律：
  1. **清理路径幂等且不可跳过**（sync.Once + defer + 信号 + 启动扫孤儿）；
  2. **终态必须可区分**（succeeded/failed/timeout/oom_killed/canceled）——混在一起就无法排障；
  3. **验尸检查自动化**（进程/目录/cgroup/fd 四项），比任何监控都早发现问题。
- Executor 接口的分层是最关键的设计决策：执行方式可插拔，管理逻辑只写一遍。
- 四类攻击（无限输出 / fork bomb / 路径穿越 / 超时不退出）是上线前的最低门槛。

**检查清单**：
- [ ] 十个阶段的验收标准我都能独立验证
- [ ] goal.md 第六节的十三项功能全部可演示
- [ ] 四类攻击测试全部通过
- [ ] 我能说清每个阶段用到了前面哪一章的知识
- [ ] 我能回答"从能跑到能上线还差什么"

## 7. 延伸阅读

- 本模块第 02、04、06、07、11、12 章——本项目的每一块地基
- OpenAI Code Interpreter / E2B / Modal 的公开架构文档（生产级代码执行平台的设计）
- Firecracker 论文：*Firecracker: Lightweight Virtualization for Serverless Applications*（AWS Lambda 的隔离方案）
- gVisor 文档（用户态内核如何在容器便利性和 VM 隔离性之间取舍）
- 本仓库 `agent/` 目录——Agent 的模式与工程化
