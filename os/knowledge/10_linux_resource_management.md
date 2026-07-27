# 10 · Linux 资源限制：ulimit、OOM Killer 与 load average ⭐⭐⭐

> 对应代码：[`../code/05_profiling`](../code/05_profiling)（02_rlimit）· 对应实验：[lab_05](../labs/lab_05_debugging.md) 实验 3–5
>
> 本章回答：为什么 CPU 使用率不高但 load 很高？为什么无法创建线程/子进程？为什么容器内看到的资源和宿主机不一致？——这些问题的共同点是：**你以为的资源和系统实际给你的资源不是一回事**。

## 1. 本章目标

- 掌握 rlimit 全家（NOFILE/NPROC/STACK/AS/CORE）与它们对应的 errno；
- 精确理解 load average 的定义，能解释"CPU 空闲但 load 高"；
- 掌握 OOM Killer 的评分与豁免机制；
- 理解 nice/优先级、上下文切换、中断与软中断的观测方法；
- 能解释容器内资源视图失真的原因和后果。

## 2. 核心概念

### 2.1 rlimit：每进程的资源上限

`ulimit` 是 shell 内建命令，操作的是内核的 **rlimit**（resource limit）。每项都有**软限制（soft）**和**硬限制（hard）**：软限制是当前生效值，进程可自行调高到硬限制；硬限制只有 root（或有 `CAP_SYS_RESOURCE`）能提高。

```bash
ulimit -a                 # 看全部软限制
ulimit -Ha                # 看全部硬限制
cat /proc/<pid>/limits    # 看某个运行中进程的实际限制 ← 排障必用
```

| 限制项 | ulimit 参数 | rlimit 常量 | 超限时的表现 | ⚠️ 关键点 |
|---|---|---|---|---|
| 打开文件数 | `-n` | RLIMIT_NOFILE | `EMFILE: too many open files` | **最常撞的一个**。容器默认常见 1024/65536 |
| 进程/线程数 | `-u` | RLIMIT_NPROC | `EAGAIN: fork/clone failed` | ⚠️ 按 **UID** 统计，不是按进程！同 UID 的所有进程共享这个额度 |
| 栈大小 | `-s` | RLIMIT_STACK | 栈溢出 → SIGSEGV | 默认 8MB；影响线程默认栈大小 |
| 虚拟内存 | `-v` | RLIMIT_AS | `ENOMEM` 分配失败 | ⚠️ 限的是 **VSZ 不是 RSS**——Go 程序会预留大量虚拟地址，设这个容易误伤 |
| core dump | `-c` | RLIMIT_CORE | 不生成 core 文件 | 默认 0（不生成），调试崩溃时要开 |
| CPU 时间 | `-t` | RLIMIT_CPU | 超时收到 SIGXCPU | 沙箱里限制计算时长的一个手段 |

**Go 里设置**：
```go
var rl syscall.Rlimit
syscall.Getrlimit(syscall.RLIMIT_NOFILE, &rl)
rl.Cur = rl.Max                                   // 软限提到硬限（常见的自我调优）
syscall.Setrlimit(syscall.RLIMIT_NOFILE, &rl)
// 给子进程单独设：cmd.SysProcAttr 无法直接设 rlimit，
// 需要在 fork 后 exec 前设置——Go 里用 prlimit(子pid) 或包一层 shell 的 ulimit
```

⚠️ **限制的继承**：子进程继承父进程的 rlimit。所以 Agent 给自己设的限制会传给所有工具子进程——这既是特性（统一约束）也是陷阱（Agent 需要高 NOFILE，但工具不该有）。真正的按任务限制要用 cgroup（第 11 章）。

### 2.2 load average：最被误解的指标

`uptime` / `top` 显示的 `load average: 2.31, 1.95, 1.42` 是 1/5/15 分钟的指数移动平均。

**Linux 的定义（与传统 Unix 不同！）**：
```text
load = 处于 R 状态（运行/就绪）的任务数 + 处于 D 状态（不可中断睡眠）的任务数
```

⚠️ **关键点**：**Linux 把 D 状态也算进 load**，而传统 Unix（如 Solaris）只算 R。这一个差异解释了绝大多数"load 高但 CPU 闲"的困惑：

| 场景 | CPU 使用率 | load | 原因 |
|---|---|---|---|
| CPU 密集计算 | 高 | 高 | R 状态任务多，正常 |
| **磁盘/NFS 卡住** | **低** | **很高** | 大量任务 D 状态等 I/O，计入 load 但不烧 CPU |
| 大量短任务排队 | 高 | 高 | R 队列长 |
| 单线程满载（8 核机） | 12.5% | ~1 | load 1 ≠ 满载，要除以核数看 |

**正确的判读方法**：
1. **load 要除以核数**：8 核机器 load 8 = 满载，load 16 = 每个任务平均等一倍时间。
2. **load 高先看是 R 还是 D**：
   ```bash
   ps -eo stat,pid,comm | awk '$1 ~ /^R/' | wc -l    # R 状态数
   ps -eo stat,pid,comm | awk '$1 ~ /^D/'            # D 状态的都是谁 ← 关键
   vmstat 1 5    # r 列 = 运行队列, b 列 = 阻塞(D)队列
   ```
3. **D 状态多 = 存储子系统有问题**（磁盘故障、NFS 挂起、iowait 高），此时优化 CPU 毫无意义。

**CPU 使用率与 load 的本质区别**：使用率是"CPU 忙的时间占比"（有上界 100%），load 是"想用 CPU 的任务数"（无上界）。**使用率回答"CPU 累不累"，load 回答"有多少人在排队"**。

### 2.3 CPU 时间的六个去向

`top` 的 CPU 行：`us 20.1 sy 5.3 ni 0.0 id 70.2 wa 3.5 hi 0.2 si 0.7`

| 字段 | 含义 | 高了说明什么 |
|---|---|---|
| **us** (user) | 用户态代码 | 你的业务逻辑在算——正常 |
| **sy** (system) | 内核态代码 | syscall 太多/太重（第 09 章）、锁竞争 |
| **ni** (nice) | 被调低优先级的用户态任务 | 有 nice 过的后台任务 |
| **id** (idle) | 空闲 | 高说明 CPU 有余量 |
| **wa** (iowait) | **等待 I/O 完成的空闲时间** | ⚠️ 存储慢。注意：**这是空闲的一种**，CPU 并没在忙 |
| **hi** (hardirq) | 硬中断处理 | 网卡/磁盘中断风暴 |
| **si** (softirq) | 软中断处理 | ⚠️ 网络包处理的主战场，高流量服务这里常见 |

⚠️ **iowait 的常见误解**：`wa` 高不等于"CPU 忙"——它是**CPU 空闲且至少有一个任务在等 I/O** 的时间。单核机器上 wa 可能虚高；多核上要结合 `iostat` 看设备是否真的饱和。

### 2.4 中断与软中断

- **硬中断（hardirq）**：设备直接打断 CPU（第 01 章三扇门）。处理必须极短——只做"收下数据"这类紧急动作。
- **软中断（softirq）**：硬中断把耗时工作推迟到软中断上下文。网络收包的大部分处理（协议栈解析、送达 socket）都在 `NET_RX` 软中断里。

```bash
cat /proc/interrupts | head -20       # 各中断在各 CPU 上的计数（看是否均衡）
cat /proc/softirqs | head             # 软中断分布，重点看 NET_RX/NET_TX
mpstat -P ALL 1                       # 每个 CPU 的 hi/si 占比 ← 看是否有单核热点
```

**典型问题**：网卡中断全打在 CPU0 上 → CPU0 的 si 100%，其他核闲着 → 吞吐上不去。解法：开启 **RSS/RPS**（多队列网卡把中断分散到多核）、调 `irqbalance`。这是高流量服务的经典调优点。

### 2.5 nice 与优先级

- `nice` 值范围 -20（最高优先级）到 +19（最低），默认 0。**只影响 CFS 的权重**，不是硬性抢占。
- 提高优先级（负 nice）需要 root；降低任何人都可以。
- `renice -n 10 -p <pid>` 调整运行中进程。
- ⚠️ nice 只在 **CPU 竞争时**才有意义——CPU 有余量时，nice 19 的进程照样跑满。
- **实时调度**（`SCHED_FIFO`/`SCHED_RR`，`chrt` 命令）才是硬优先级，但用错会饿死普通任务甚至挂起系统，普通服务别碰。

👉 **Agent 场景**：给不可信的工具进程设 `nice 10`，保证 Agent 主进程和用户请求处理优先。这是**廉价的第一道防线**，但不能替代 cgroup CPU 配额（nice 只在竞争时生效，无法限制绝对用量）。

### 2.6 OOM Killer 的评分机制

第 05 章讲了 OOM 的成因，这里讲**它怎么选人**：

```text
oom_score ≈ (进程 RSS + swap + 页表大小) / 系统总内存 × 1000 + oom_score_adj

/proc/<pid>/oom_score       # 当前评分（0-1000+，越高越先死）
/proc/<pid>/oom_score_adj   # 手动调整值（-1000 到 +1000）
                            # -1000 = 完全豁免（永不被 OOM Killer 选中）
```

**核心特征：按占用量排序，不按"谁在漏"**。所以最大的进程最先死——你的主服务往往就是最大的那个，而真正漏内存的小工具毫发无伤。这是 OOM Killer 冤案的根源。

**实用手段**：
```bash
# 保护关键进程（如数据库、Agent 主进程）
echo -500 > /proc/<pid>/oom_score_adj
# 让不重要的进程优先死（如可重启的 worker）
echo 500 > /proc/<pid>/oom_score_adj
```
K8s 就是这么做的：**根据 QoS 等级设置 oom_score_adj**——Guaranteed（-997）> Burstable（2–999，按 request 比例算）> BestEffort（1000，最先死）。

**两个层级**（第 05 章已提，这里补排查命令）：
```bash
# 全局 OOM
dmesg -T | grep -i 'out of memory'
journalctl -k | grep -i oom

# cgroup OOM（容器）
cat /sys/fs/cgroup/<path>/memory.events     # oom / oom_kill 计数
cat /sys/fs/cgroup/<path>/memory.max        # 上限
cat /sys/fs/cgroup/<path>/memory.current    # 当前用量
```

### 2.7 容器内的资源视图失真

**这是容器时代最重要的一个认知**：

```text
容器里执行 nproc / free -m / top，看到的是【宿主机】的数据，不是容器的配额！
```

原因：这些工具读的是 `/proc/cpuinfo`、`/proc/meminfo`——而 `/proc` **不是 namespace 化的**（PID namespace 只隔离了 `/proc/<pid>` 部分）。容器的真实配额在 cgroup 文件里，普通工具不看那里。

**后果**：
| 现象 | 原因 | 后果 |
|---|---|---|
| Go 的 GOMAXPROCS = 宿主机核数 | 读 `/proc/cpuinfo` | P 过多 → cgroup 节流 + 调度开销（第 03 章 §3.6，Go 1.25 已修复） |
| JVM 堆按宿主机内存算 | 读 `/proc/meminfo` | 堆设得远超容器 limit → OOMKilled（JDK 10+ 的 UseContainerSupport 修复） |
| `free -m` 显示 64GB | 同上 | 运维误判"内存充足" |
| 线程池按 `nproc` 开 | 同上 | 线程数远超配额 |

**正确的做法**：
```bash
# 容器里查真实配额（cgroup v2）
cat /sys/fs/cgroup/cpu.max          # 如 "200000 100000" = 2 核
cat /sys/fs/cgroup/memory.max       # 内存上限字节数
cat /sys/fs/cgroup/pids.max         # 进程数上限

# cgroup v1
cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us   # 除以 cfs_period_us 得核数
cat /sys/fs/cgroup/memory/memory.limit_in_bytes
```
- 用 `lxcfs` 可以让容器里的 `/proc/meminfo` 等显示 cgroup 的值（治标）；
- 应用层面：Go 1.25+ 自动感知，之前用 `automaxprocs`；JVM 用 `-XX:+UseContainerSupport`（JDK 10+ 默认开）；自己写的代码直接读 cgroup 文件。

## 3. 底层原理：三个数字是怎么算出来的

### 3.1 load average 的指数移动平均

很多人只知道"1/5/15 分钟平均"，但不知道它**不是简单算术平均**，而是**指数加权移动平均（EWMA）**。内核每 5 秒采样一次当前的可运行+不可中断任务数 `n`，然后：

```text
load(t) = load(t-1) × e^(-5/60)  + n × (1 - e^(-5/60))     # 1 分钟负载
                     └ 衰减因子    └ 新样本的权重
        （5 = 采样间隔秒数, 60 = 时间窗口秒数）
```

**三个实用推论**：
1. **load 是滞后指标**。突发负载要经过约一个时间窗口才能充分反映到对应的数字上——所以"1 分钟 load 已经飙了但 15 分钟还很低"意味着**问题刚发生**；反过来"15 分钟高但 1 分钟已降"意味着**问题正在缓解**。看三个数字的**趋势关系**比看绝对值信息量大。
2. **它永远追不上瞬时值**。指数平均意味着新样本只占一部分权重，短促的尖峰会被抹平——所以 load 正常不代表没发生过瞬时拥塞。
3. **5 秒采样会漏掉更短的抖动**。亚秒级的调度问题 load 完全看不见，那得靠 `pidstat 1` 的 nvcswch 或 `go tool trace`。

⚠️ 内核为了避免浮点运算，实际用定点数实现（`FIXED_1 = 1<<11`），`/proc/loadavg` 里的数字是转换后的结果——这也是为什么它只有两位小数。

### 3.2 rlimit 在内核里怎么生效

rlimit 不是一个统一的检查点，而是**散落在各个 syscall 实现里的独立判断**：

```text
struct rlimit { rlim_cur; rlim_max; }  存在 task_struct->signal->rlim[RLIMIT_xxx]
                                        ⚠️ 挂在 signal_struct 上 = 【线程组共享】

open()   → 分配 fd 时检查 → 超 RLIMIT_NOFILE → 返回 EMFILE
clone()  → 检查该【UID 的进程总数】→ 超 RLIMIT_NPROC → 返回 EAGAIN
                └ 这就是"按 UID 统计"的实现依据: 检查的是 user_struct->processes
mmap()   → 检查地址空间总和 → 超 RLIMIT_AS → 返回 ENOMEM
write()  → 检查文件大小 → 超 RLIMIT_FSIZE → 返回 EFBIG + 发 SIGXFSZ
调度器   → 累计 CPU 时间 → 超 RLIMIT_CPU 软限 → 发 SIGXCPU（硬限则 SIGKILL）
```

**两个由实现决定的重要事实**：
- **rlimit 挂在 signal_struct 上 → 同一进程的所有线程共享**，改一个线程的 limit 等于改整个进程的。
- **RLIMIT_NPROC 检查的是 `user_struct`（按 UID 全局计数）而不是当前进程的子孙数**——这就是第 2.1 节说的坑的根源。⚠️ 补充一个细节：**root（有 `CAP_SYS_RESOURCE`）绕过 NPROC 检查**，所以 root 用户遇不到这个限制，用普通用户跑服务才会撞上。

### 3.3 OOM 评分的实际计算

内核的 `oom_badness()`（简化后）：

```text
points = 进程的 RSS + 页表大小 + swap 使用量        # 单位: 页
points = points × 1000 / 总可用内存页数            # 归一化到 0-1000
points += oom_score_adj                            # 手动调整值
若 oom_score_adj == -1000 → 直接【豁免】，永不选中
```

**四个由公式直接推出的结论**：
1. **按"占用量"而非"增长速度"排序** → 最大的进程先死，漏内存的小工具毫发无伤（冤案根源）。
2. **页表也计入** → 大量映射（如 fork 出的大进程）会额外增加得分。
3. `oom_score_adj` 的量纲是"千分比" → 设 `-500` 相当于"假装我少占了一半内存"，不是绝对豁免。
4. **cgroup OOM 只在组内比较** → 容器里被杀的是容器内最大的进程，与宿主机上其他进程无关。

⚠️ 一个容易忽略的行为：内核在真正 OOM 前会先尝试回收（丢干净的文件页、回写脏页、换出匿名页）。所以看到 OOM 说明**回收已经失败**——这时候 `dmesg` 里通常还会有一段回收统计，那才是"为什么回收不出来"的线索。

## 4. 关键排查场景

### 3.1 "无法创建线程/子进程"

三个可能原因，逐个排除：

```bash
# ① RLIMIT_NPROC（按 UID 统计！）
cat /proc/<pid>/limits | grep processes
ps -u <该uid> --no-headers | wc -l        # 该 UID 当前进程数
# ⚠️ 陷阱: 多个容器用同一个 UID(比如都用 uid 1000)时，额度是【共享】的

# ② 系统级 PID 上限
cat /proc/sys/kernel/pid_max              # 全系统 PID 上限
cat /proc/sys/kernel/threads-max          # 全系统线程上限
ls /proc | grep -c '^[0-9]'               # 当前进程数

# ③ cgroup pids 限制（容器里最常见）
cat /sys/fs/cgroup/pids.max
cat /sys/fs/cgroup/pids.current           # 逼近 max 就是它
```

Go 侧的特殊表现：`runtime: failed to create new OS thread` 然后进程直接崩溃——这是撞上 NPROC 或 `debug.SetMaxThreads`（默认 1 万）的信号。⚠️ 常见诱因：大量阻塞 syscall 导致 M 增生（第 03 章 §3.4）。

### 3.2 "Too many open files"

```bash
# 定位当前用量与上限
ls /proc/<pid>/fd | wc -l
cat /proc/<pid>/limits | grep 'open files'
# 系统级
cat /proc/sys/fs/file-nr        # 已分配 / 已用 / 上限
# 按类型拆解找泄漏源
lsof -p <pid> | awk '{print $5}' | sort | uniq -c | sort -rn
```
判决树（第 07 章 §9 已详述）：大量 socket + CLOSE_WAIT → HTTP body 未关；大量同名 REG → 文件泄漏；数量恰好卡在 1024 → ulimit 太小。

### 3.3 "load 高但 CPU 闲"

```bash
uptime                                    # load 有多高
nproc                                     # 除以核数看倍率
vmstat 1 5                                # r 列(运行队列) vs b 列(阻塞队列)
ps -eo stat,pid,wchan:30,comm | awk '$1 ~ /D/'   # D 状态的进程卡在哪个内核函数
iostat -x 1 3                             # %util 接近 100 = 设备饱和; await 高 = 单次 I/O 慢
```
**结论模式**：b 列大 + D 状态进程多 + iostat %util 高 → 存储瓶颈，跟 CPU 无关。常见根因：磁盘故障、NFS 服务端挂了、云盘 IOPS 打满、大量 fsync。

## 5. Go 语言示例

[`02_rlimit`](../code/05_profiling/02_rlimit/main.go)：读取并调整自身 rlimit，构造 EMFILE（fd 耗尽）和演示 NPROC 的 UID 共享特性，读取 cgroup 配额文件对比 `runtime.NumCPU()` 的差异。

## 6. 后端开发中的应用

- **部署清单必查三项**：NOFILE（连接数密集型服务至少 65536）、cgroup memory limit（留 page cache 余量）、GOMAXPROCS 是否匹配 CPU 配额。这三项配错的故障占容器化事故的很大比例。
- **监控要区分 load 的成分**：只报警 load 值会产生大量噪音（批处理时 load 高是正常的）。更有意义的组合：`load/核数 > 2` **且** `iowait < 5%`（CPU 瓶颈）vs `load 高` **且** `D 状态多`（存储瓶颈）。
- **给关键进程设 oom_score_adj**：数据库、Agent 主进程设负值；可重启的 worker 设正值。这是**在 OOM 不可避免时决定谁先死**的唯一手段。

## 7. Agent 开发中的应用

工具执行的资源限制分三层，各有适用边界：

| 层 | 手段 | 能限制什么 | 局限 |
|---|---|---|---|
| **应用层** | 输出上限、超时、并发数（第 04/06 章） | 自己的行为 | 管不住子进程 |
| **rlimit** | `RLIMIT_CPU/NOFILE/NPROC/AS` | 单进程的资源 | ⚠️ NPROC 按 UID 共享；AS 限 VSZ 容易误伤；子进程可继承但可能被绕过 |
| **cgroup** | cpu.max / memory.max / pids.max / io.max | **整棵进程树**，硬性 | 需要权限；配置更复杂（第 11 章） |

**结论**：rlimit 是"够用的第一层"，**cgroup 才是不可信代码的正确答案**。特别是 `pids.max`——它是**防 fork bomb 的唯一可靠手段**（rlimit NPROC 因为按 UID 统计，多租户下会互相干扰）。

**给子进程设 rlimit 的实操**（Go 没有直接的 SysProcAttr 字段）：
```go
// 方案 A: 包一层 shell（简单但多一个进程）
exec.Command("sh", "-c", "ulimit -t 10 -n 64; exec "+userCmd)

// 方案 B: 用 prlimit 命令（Linux util-linux）
exec.Command("prlimit", "--cpu=10", "--nofile=64", "--", "sh", "-c", userCmd)

// 方案 C（推荐）: 直接放进 cgroup（第 11 章）——限制整棵进程树，无法绕过
```

## 8. 常见问题与错误设计

**错误 1：只调 ulimit 不修代码。** fd 泄漏时把 NOFILE 从 1024 调到 65536，只是把崩溃从 1 小时推迟到 3 天。

**错误 2：用 RLIMIT_AS 限制 Go 程序内存。** 它限的是 VSZ，而 Go runtime 会预留大量虚拟地址空间（arena）——设小了程序启动就失败，设大了没有实际保护作用。**限内存要用 cgroup memory.max + GOMEMLIMIT**。

**错误 3：在容器里信任 `nproc`/`free`。** 它们读 `/proc`，看到的是宿主机。永远读 cgroup 文件。

**错误 4：把 load 当 CPU 使用率报警。** 两者定义不同，D 状态会让 load 虚高。要么分开报警，要么用组合条件。

**错误 5：以为 nice 能限制 CPU 用量。** nice 只在竞争时调整权重；CPU 空闲时 nice 19 照样跑满。要硬限制必须用 cgroup `cpu.max`。

## 9. 排障方法：三个真实案例

**案例 A：容器内 Go 服务频繁 OOMKilled，但 heap profile 很干净。**
- 现象：exit 137，`memory.events` 的 oom_kill 递增；pprof heap 只有几百 MB，limit 是 2GB。
- 排查：`cat /sys/fs/cgroup/memory.stat` → `file` 项占了 1.5GB（Page Cache 被计入 cgroup！）。
- 根因：服务大量读写临时文件，Page Cache 顶满 limit，内核回收不及时。
- 解决：① 调大 limit 给 cache 留余量；② 大文件读写后 `posix_fadvise(DONTNEED)` 主动丢弃缓存；③ 临时文件放 tmpfs 并单独计额。

**案例 B：`runtime: failed to create new OS thread`。**
- 现象：Go 服务突然崩溃，日志里这一行。
- 排查：`cat /proc/<pid>/limits | grep processes` → 上限 4096；`ps -u appuser | wc -l` → 已达 4090。
- 根因：某处大量并发阻塞 syscall（CGO 调用/DNS/磁盘 I/O）导致 M 增生（第 03 章 §3.4），撞上 NPROC。
- 解决：限制该操作的并发数（信号量）+ 提高 NPROC + 排查为什么有那么多阻塞调用。

**案例 C：`load 25`（8 核机），但 `top` 显示 CPU 空闲 70%。**
- 排查：`vmstat 1` → b 列常年 20+；`ps -eo stat,wchan,comm | awk '$1~/D/'` → 一堆进程卡在 NFS 相关的 wchan。
- 根因：NFS 服务端无响应，客户端进程全部 D 状态。
- 解决：修 NFS；应用侧改用带超时的挂载选项（`soft,timeo=`）避免无限期 D 状态。⚠️ 注意 D 状态 `kill -9` 也杀不掉（第 02 章 §2.2）。

## 10. 实验任务

[lab_05_debugging.md](../labs/lab_05_debugging.md) 实验 3–5：③ 构造 EMFILE 并观察 limits；④ 制造 D 状态观察 load 与 CPU 的背离；⑤ 在容器/cgroup 里对比 `nproc` 与真实配额。

## 11. 面试题（附答题要点）

**Q1：load average 是什么？为什么 CPU 不高 load 却很高？**
要点：**Linux 的 load = R 状态 + D 状态任务数**（与传统 Unix 只算 R 不同）——这是核心答案。D 状态是不可中断睡眠（等磁盘/NFS），不烧 CPU 但计入 load。判读：load 要除以核数；load 高先用 `vmstat` 的 b 列和 `ps` 找 D 状态进程。加分：iowait 是"CPU 空闲且有人等 I/O"，不是 CPU 忙。

**Q2：CPU 使用率和 load 的区别？**
要点：使用率 = CPU 忙的时间占比（有上界 100%），load = 想用 CPU 的任务数（无上界）。使用率回答"累不累"，load 回答"排队多长"。加分：8 核 load 8 ≈ 满载；单线程满载在 8 核上是 12.5% 使用率但 load ≈ 1。

**Q3：OOM Killer 怎么选择杀谁？怎么保护关键进程？**
要点：`oom_score ≈ 内存占用占比 × 1000 + oom_score_adj`——按**占用量**排序，不按"谁在漏"，所以最大的进程先死（冤案根源）。保护：`echo -500 > /proc/<pid>/oom_score_adj`（-1000 完全豁免）。加分：K8s 按 QoS 设置 adj（Guaranteed -997 / BestEffort 1000）；区分全局 OOM 和 cgroup OOM 的排查路径。

**Q4：无法创建线程/进程有哪些原因？**
要点：三层排查——① RLIMIT_NPROC（⚠️ **按 UID 统计，同 UID 进程共享额度**）；② 系统级 `pid_max`/`threads-max`；③ cgroup `pids.max`（容器里最常见）。Go 特有：M 增生撞上限（引出第 03 章阻塞 syscall）、`debug.SetMaxThreads` 默认 1 万。

**Q5：容器里 `nproc` 和 `free` 为什么不准？有什么后果？**
要点：`/proc` 不是 namespace 化的，这些工具读的是宿主机数据。后果：Go 的 GOMAXPROCS 过大（cgroup 节流 + 调度开销）、JVM 堆超 limit（OOMKilled）、线程池开太大。正解：读 cgroup 文件（`cpu.max`/`memory.max`）；Go 1.25+ 自动感知，之前用 automaxprocs；lxcfs 可治标。

**Q6：ulimit -n 和 cgroup 限制有什么区别？限制不可信代码该用哪个？**
要点：rlimit 是**每进程**的（且 NPROC 是每 UID 的），继承给子进程但语义有坑；cgroup 是**每控制组**的，限制整棵进程树且无法绕过。不可信代码必须用 cgroup——特别是 `pids.max` 是防 fork bomb 的唯一可靠手段。加分：三层限制模型（应用层/rlimit/cgroup）各自的适用边界。

**Q7：nice 能限制进程的 CPU 用量吗？**
要点：不能。nice 只调整 CFS 的**权重**，在 CPU 竞争时才生效；CPU 空闲时 nice 19 的进程照样跑满。要硬限制用 cgroup `cpu.max`（quota/period）。加分：实时调度（SCHED_FIFO）是硬优先级但危险；nice 是"廉价的第一道防线"，适合降低后台任务的干扰。

**Q8：softirq 高是什么问题？**
要点：软中断是硬中断推迟的工作，网络收包（NET_RX）是大头。si 高说明网络流量大或中断处理有瓶颈。典型问题：中断全打在 CPU0（`cat /proc/interrupts` 看分布），解法是 RSS/RPS 多队列分散 + irqbalance。加分：这是高流量服务的经典调优点。

## 12. 本章总结

- rlimit 是每进程（NPROC 是每 UID）的软硬双限；NOFILE 最常撞，AS 限 VSZ 不适合 Go，真正的隔离靠 cgroup。
- **load = R + D**：D 状态（等 I/O）让 load 与 CPU 使用率解耦，这是"load 高 CPU 闲"的完整答案。
- OOM Killer 按占用量排序而非按泄漏程度，`oom_score_adj` 是唯一的干预手段（K8s QoS 就是它）。
- 容器内 `/proc` 不隔离 → `nproc`/`free` 骗人 → 一切"按机器规格自动配置"的逻辑都要改成读 cgroup。
- 三层资源限制：应用层管自己、rlimit 管单进程、cgroup 管进程树（不可信代码的唯一正确答案）。

**检查清单**：
- [ ] 我能解释 Linux load 的定义，并说出它与传统 Unix 的差异
- [ ] 我能用 vmstat/ps/iostat 三条命令区分 CPU 瓶颈和存储瓶颈
- [ ] 我知道 RLIMIT_NPROC 按 UID 统计这个坑，能说出它在多租户下的后果
- [ ] 我能说出容器里 nproc/free 失真的原因和三个具体后果
- [ ] 我能为 Agent 的工具进程设计三层资源限制，并说清每层的边界

## 13. 延伸阅读

- 《Systems Performance》(Brendan Gregg) 第 6 章（CPU）、第 7 章（内存）——USE 方法论的出处
- `man 2 getrlimit`、`man 5 proc`（`/proc` 各文件的权威说明）
- Brendan Gregg: *Linux Load Averages: Solving the Mystery*（load 定义的考古学，强烈推荐）
- kernel 文档 `Documentation/admin-guide/cgroup-v2.rst`
- 下一章 [11 容器与 Sandbox](11_container_and_sandbox.md)——把本章的"限制"升级成"隔离"
