# 12 · 可观测性与排障：工具矩阵与故障剧本 ⭐⭐⭐⭐

> 对应代码：[`../code/05_profiling`](../code/05_profiling)（03_pprof_targets）· 对应实验：[lab_05](../labs/lab_05_debugging.md) 实验 6–10
>
> 前面十章讲"系统怎么工作"，本章讲"**系统不工作时你怎么办**"。每个工具按统一格式讲：解决什么问题 / 常用命令 / 关注哪些字段 / 常见误区 / 真实案例。

## 1. 本章目标

- 建立**排障方法论**：从现象出发，用最少的命令收敛到根因；
- 掌握 Linux 工具矩阵（19 个）与 Go 工具矩阵（8 个 profile 类型）；
- 能对本模块的每类故障给出"四段式"报告：现象 → 原因 → 验证 → 解决；
- 建立个人的**排障速查表**（本章末尾给出模板）。

## 2. 排障方法论：先定位象限，再选工具

### 2.1 USE 方法（Brendan Gregg）

对每一类资源，检查三件事：
- **U**tilization（使用率）：忙的时间占比
- **S**aturation（饱和度）：排队的程度
- **E**rrors（错误）：出错计数

| 资源 | Utilization | Saturation | Errors |
|---|---|---|---|
| CPU | `top` 的 us+sy | `vmstat` 的 r 列、load | — |
| 内存 | `free` 的 used/available | swap 使用、major fault 速率 | OOM Kill 计数 |
| 磁盘 | `iostat` 的 %util | `iostat` 的 aqu-sz、await | `dmesg` 的 I/O error |
| 网络 | `sar -n DEV` 的带宽占比 | `ss` 的 Recv-Q/Send-Q | `netstat -s` 的重传/丢包 |

**为什么这个框架有用**：它逼你**逐个资源排除**，而不是凭直觉猜。90% 的"服务变慢"最终落在这四类资源之一，或者落在"根本不在本机"（下游依赖）。

### 2.2 第一分诊：四个象限

拿到"服务慢/挂了"的报告，先用两条命令分诊：

```bash
top        # 看 us / sy / wa / id 和 load
vmstat 1 5 # 看 r(运行队列) / b(阻塞队列) / si,so(swap) / bi,bo(块 I/O)
```

| 象限 | 特征 | 首选工具 | 转向章节 |
|---|---|---|---|
| **CPU 忙**（us 高） | us > 60%, r 队列长 | `pprof CPU profile`、`perf top` | 03、06 |
| **内核忙**（sy 高） | sy > 30% | `strace -c`、`perf trace` | 09 |
| **在等 I/O**（wa 高 / b 列大） | id 高但 load 高、D 状态多 | `iostat -x`、`ps` 找 D | 10 |
| **都不忙但慢** | CPU 闲、load 低 | `ss` 队列、block/mutex profile、下游延迟 | 04、08 |

⚠️ **第四象限是最难的**——CPU 闲、内存够、磁盘不忙，但请求就是慢。答案通常是：在等锁（第 04 章）、在等网络（第 08 章）、在等下游（不在本机）。

## 3. Linux 工具矩阵

> 格式统一：**问题 → 命令 → 关键字段 → 误区 → 案例**

### 3.1 进程与 CPU

**`ps`** — 进程快照
- **问题**：谁在跑？什么状态？父子关系？
- **命令**：
  ```bash
  ps -eo pid,ppid,pgid,stat,pcpu,pmem,rss,etime,cmd --sort=-pcpu | head -20
  ps -eo stat,pid,wchan:30,comm | awk '$1 ~ /D/'    # D 状态卡在哪个内核函数
  ps -T -p <pid>                                     # 线程级视图（Go 的 M）
  ps -eo pid,ppid,stat,cmd | awk '$3 ~ /Z/'          # 僵尸及其父进程
  ```
- **关键字段**：`STAT`（R/S/D/Z/T，第 02 章 §2.2）、`WCHAN`（睡在哪个内核函数——D 状态排障的关键）、`RSS`（真实内存）
- **误区**：`%CPU` 是**自进程启动以来的平均值**，不是瞬时值！要瞬时用 `top` 或 `pidstat 1`。
- **案例**：大量 `<defunct>` → 取它们的 PPID → 罪犯是父进程没 wait（第 02 章 §9）。

**`top` / `htop`** — 实时监控
- **命令**：`top -H -p <pid>`（线程级）、`top -o %MEM`（按内存排序）；交互键：`1`（展开每个 CPU）、`H`（线程模式）、`f`（选字段）
- **关键字段**：CPU 行的 us/sy/ni/id/wa/hi/si 六个去向（第 10 章 §2.3）、`VIRT`/`RES`/`SHR`（第 05 章 §2.9）
- **误区**：`VIRT` 对 Go 程序毫无意义（arena 预留几十 GB 是常态），只看 `RES`。
- **案例**：`si`（软中断）单核 100% 而其他核闲 → 网卡中断没分散 → RSS/RPS 调优（第 10 章 §2.4）。

**`pidstat`** — 按进程的细粒度统计
- **命令**：`pidstat -p <pid> 1`（CPU）、`pidstat -r -p <pid> 1`（内存+缺页）、`pidstat -d -p <pid> 1`（磁盘）、`pidstat -w -p <pid> 1`（上下文切换）
- **关键字段**：`cswch/s`（自愿切换：主动让出，如等 I/O）vs `nvcswch/s`（**非自愿切换：被抢占**——这个高说明 CPU 竞争激烈）
- **案例**：nvcswch 飙高 + 延迟毛刺 → CPU 超卖或 CPU 密集任务抢占（第 03 章 §7）。

**`mpstat`** — 按 CPU 核的统计
- **命令**：`mpstat -P ALL 1`
- **关键字段**：每核的 `%usr`/`%sys`/`%iowait`/`%irq`/`%soft`
- **案例**：单核 `%soft` 100% → 中断集中；某核 `%usr` 100% 其他闲 → 单线程瓶颈。

**`vmstat`** — 系统整体的十秒诊断
- **命令**：`vmstat 1 10`
- **关键字段**：
  - `r`（运行队列长度）> 核数 → CPU 不够
  - `b`（阻塞队列）> 0 → 有任务在等 I/O（D 状态）
  - `si`/`so`（swap in/out）> 0 → **内存不足在换页，危险信号**
  - `bi`/`bo`（块设备读写）
  - `cs`（上下文切换/秒）、`in`（中断/秒）
- **误区**：**第一行是自启动以来的平均值，要忽略**，从第二行开始看。
- **案例**：`so` 持续 > 0 → 内存压力 → 查是谁在涨（第 05/06 章）。

### 3.2 内存

**`free`** — 内存总览
- **命令**：`free -h`、`free -m -s 2`（每 2 秒刷新）
- **关键字段**：**`available`**（真正可用 ≈ free + 可回收的 cache），不是 `free`！
- **误区**：看到 `free` 很小就慌——Linux 会把闲内存全拿去做 Page Cache，这是**好事**（第 07 章 §2.5）。
- **案例**：`available` 持续下降 + `so` > 0 → 真的内存不足了。

**`/proc/meminfo`、`/proc/<pid>/status`、`smaps_rollup`**
```bash
grep -E 'MemAvailable|Dirty|Writeback|SwapFree' /proc/meminfo
grep -E 'VmRSS|VmSize|VmSwap|Threads' /proc/<pid>/status
cat /proc/<pid>/smaps_rollup      # PSS（共享页均摊后的真实占用）
```
- **案例**：`Dirty` 很大 → 大量脏页待回写 → 可能引发写延迟毛刺（第 07 章 §2.5）。

### 3.3 磁盘

**`iostat`** — 块设备性能
- **命令**：`iostat -x 1 5`
- **关键字段**：
  - `%util`：设备忙的时间占比。⚠️ **对 SSD/NVMe 不可靠**（并行队列使得 100% 不等于饱和）
  - `await`：单次 I/O 平均等待（含排队），**这才是延迟的直接指标**
  - `aqu-sz`（平均队列长度）：饱和度
  - `r/s`、`w/s`、`rkB/s`、`wkB/s`：IOPS 和吞吐
- **案例**：`await` 从 1ms 涨到 50ms + `aqu-sz` 大 → 存储饱和 → 应用侧表现为 D 状态多、load 高（第 10 章案例 C）。

**`df`** — 文件系统空间与 inode
- **问题**：磁盘写不进去了，是空间满还是 inode 满？
- **命令**：`df -h`（空间）、`df -i`（**inode**）、`df -h /path`（定位具体挂载点）
- **关键字段**：`Use%`（空间占比）、`IUse%`（inode 占比）、`Mounted on`（别看错挂载点）
- **误区**：只看 `df -h` 就下结论。⚠️ **`df -i` 是"磁盘有空间却写不进"的第一嫌疑**（第 07 章 §2.1）；另外 ext4 默认给 root 保留 5%，普通用户在 95% 时就写不进了。
- **案例**：`df -h` 显示 50% 空闲但 `touch` 报 `No space left on device` → `df -i` 显示 IUse% 100% → 海量小文件耗尽 inode（lab_04 实验 2 亲手复现过）。

**`du`** — 目录占用
- **问题**：空间被谁占了？
- **命令**：`du -sh * | sort -h`（当前层排序）、`du -xh --max-depth=2 / | sort -h | tail -20`（全盘找大户，`-x` 不跨文件系统）
- **关键字段**：就是大小本身，但要注意单位（`-h` 人类可读）
- **误区**：⚠️ **`du` 和 `df` 对不上是常态**——`du` 统计的是"能遍历到的文件"，`df` 统计的是"文件系统已分配的块"。差额通常来自：**被删除但仍被打开的文件**（`lsof +L1` 查）、其他挂载点覆盖了原目录内容、稀疏文件、保留块。
- **案例**：`df` 说满了，`du -sh /` 只有一半 → `lsof +L1` 找到一个被 `rm` 掉但进程仍持有的 50GB 日志 → `truncate -s 0` 或重启该进程（第 07 章 §6）。

**`lsblk` / `mount`** — 块设备与挂载
- **问题**：这个目录在哪个设备上？挂载参数对吗？是不是被重复挂载了？
- **命令**：
  ```bash
  lsblk -f                          # 块设备树 + 文件系统类型 + UUID + 挂载点
  mount | column -t                 # 当前挂载表
  findmnt /path                     # 反查某路径属于哪个挂载点（比 mount|grep 准）
  cat /proc/mounts                  # 内核视角的挂载表（mount 命令的数据源之一）
  ```
- **关键字段**：挂载选项——`ro`（只读）、`noexec`/`nosuid`/`nodev`（**Sandbox 三件套**，第 11 章 §3.3）、`relatime`/`noatime`（影响写放大）
- **误区**：⚠️ 在容器里 `mount` 看到的是**本 Mount namespace 的挂载表**，与宿主机不同——这正是 namespace 在起作用，不是命令出错。另外"目录看起来是空的"可能是被另一个文件系统挂载覆盖了原有内容（原内容还在，卸载后重现）。
- **案例**：Sandbox 里工具能执行 `/tmp` 下落的二进制 → `findmnt /tmp` 发现挂载选项漏了 `noexec` → 补上后攻击面消失。

**`lsof`** — 打开的文件（fd 排障的核心工具）
- **问题**：这个进程开了什么？谁占着这个文件/端口？fd 泄漏在哪？
- **命令**：
  ```bash
  lsof -p <pid>                              # 某进程的全部 fd
  lsof -p <pid> | awk '{print $5}' | sort | uniq -c | sort -rn   # 按类型聚合(REG/sock/pipe)
  lsof -p <pid> | awk '{print $9}' | sort | uniq -c | sort -rn   # 按目标聚合(找重复项)
  lsof -i :8080                              # 谁占着这个端口
  lsof +L1                                   # ⚠️ 已删除但仍被打开(nlink=0, 空间不释放)
  lsof /path/to/file                         # 谁在用这个文件(卸载失败时用)
  ```
- **关键字段**：`FD`（数字 = fd 号，`cwd`/`txt`/`mem` 是特殊项）、`TYPE`（**REG=普通文件、IPv4/IPv6=socket、FIFO=管道、DIR=目录**）、`NAME`（目标路径或地址，socket 会显示连接状态如 `CLOSE_WAIT`）
- **误区**：① 直接数 `lsof -p | wc -l` 会**多算**——`cwd`/`rtd`/`txt`/`mem` 这些不是真正的 fd，要数 fd 用 `ls /proc/<pid>/fd | wc -l`；② `lsof` 本身很慢（要遍历所有进程），排查单进程务必加 `-p`；③ 容器里跑 `lsof` 可能看不到宿主机进程（PID namespace）。
- **案例**：`too many open files` → `lsof -p <pid> | awk '{print $5}' | sort | uniq -c` 显示 9000 个 IPv4 → 再看 NAME 列全是 `CLOSE_WAIT` → **对端已关而我方没 Close** → 定位到某处 HTTP `resp.Body` 未关闭（第 07 章 §9 案例 A）。

### 3.4 网络

**`ss`** — socket 统计（`netstat` 的现代替代，快得多）
- **命令**：
  ```bash
  ss -s                          # 汇总：各状态连接数
  ss -ntp                        # TCP 连接 + 进程
  ss -ntp state established      # 只看已建立
  ss -lntp                       # 监听端口
  ss -ti                         # 详细 TCP 信息（cwnd/rtt/重传）
  ```
- **关键字段**：
  - `Recv-Q` 大 → **应用读得慢**（业务处理慢、goroutine 卡住）
  - `Send-Q` 大 → **对端收得慢或网络差**（慢客户端，第 08 章 §4）
  - 监听 socket 的 Recv-Q/Send-Q 语义不同：分别是 accept 队列当前长度和 backlog 上限
- **误区**：大量 `TIME_WAIT` 通常**不是问题**（正常的 TCP 关闭状态，60 秒自动消失）；大量 `CLOSE_WAIT` **才是 bug**（我方没 Close，第 07 章）。

**`netstat`** — 协议栈统计（连接列表已被 `ss` 取代，但 `-s` 仍不可替代）
- **问题**：丢包/重传/队列溢出的**累计计数**是多少？（`ss` 给不了这个）
- **命令**：
  ```bash
  netstat -s | grep -iE 'retrans|drop|overflow|listen|prune|collapse'
  netstat -i                       # 网卡级错误/丢弃计数
  # 对照观察: watch -d 'netstat -s | grep -i overflow'  看计数【是否在涨】
  ```
- **关键字段**：
  - `listen queue of a socket overflowed` → **accept 队列满**（backlog 太小或应用 accept 不过来）
  - `SYNs to LISTEN sockets dropped` → 同上，常与上一条同时涨
  - `segments retransmitted` → 网络质量或拥塞
  - `packets pruned from receive queue` → 接收缓冲不足
- **误区**：⚠️ **这些是自启动以来的累计值，绝对值没有意义**——必须看**增量**（两次采样相减，或 `watch -d` 看高亮变化）。很多人看到"重传 12 万"就慌，其实那是跑了半年的累计。
- **案例**：偶发连接超时 → `netstat -s` 两次采样发现 `listen queue overflowed` 在涨 → `ss -lnt` 看到监听 socket 的 Recv-Q 顶到 Send-Q（backlog 上限）→ 调大 backlog + 排查 accept 循环为什么慢。

### 3.5 内核与系统

**`dmesg`** — 内核日志
```bash
dmesg -T | tail -50                      # -T 显示可读时间戳
dmesg -T | grep -iE 'oom|killed|error|segfault'
journalctl -k --since '10 min ago'
```
- **案例**：OOM 的完整案卷（第 05 章 §8）、磁盘 I/O error、网卡 down。

**`strace`** — 系统调用跟踪（第 09 章 §5 已详述）
- **问题**：这个黑盒程序到底在干什么？为什么卡住？syscall 是不是太多？
- **命令**：`strace -c -f -p <pid>`（统计，最常用）、`strace -f -T -y -e trace=<syscall> -p <pid>`（细看）
- **关键字段**：`calls`（次数爆炸 → 找缓冲机会）、`% time`、`errors`（大量 ENOENT = 无效路径搜索）
- **误区**：⚠️ 基于 ptrace，**目标程序慢 10–100 倍**，生产禁用；Go 程序**必须加 `-f`**（多线程，否则只看到主线程）。
- **案例**：`top` 的 sy 占 40% → `strace -c -f` 显示 write 三万次/10 秒 → 无缓冲日志 → 加 bufio 后 sy 回落（第 09 章 §10）。

**`perf`** — 采样式性能分析（低开销，能看内核态）
- **问题**：CPU 时间花在哪个函数（**含内核函数**）？为什么缓存命中率低？
- **命令**：
  ```bash
  perf top                                    # 实时热点函数排行（含内核符号）
  perf record -F 99 -g -p <pid> -- sleep 30   # 99Hz 采样 30 秒, -g 抓调用栈
  perf report --stdio                         # 查看结果
  perf stat -p <pid> -- sleep 10              # 硬件计数器: IPC/缓存命中/分支预测
  perf trace -p <pid>                         # strace 的低开销替代
  perf c2c record/report                      # ⚠️ 定位伪共享(第 04 章 §3.5)的专用工具
  ```
- **关键字段**：`Overhead`（占比）、`Symbol`（函数名，`[k]` 前缀 = 内核态）；`perf stat` 的 `IPC`（每周期指令数，< 1 说明常在等内存）、`cache-misses`
- **误区**：① 采样是**统计性**的，需要足够时长（≥ 10 秒）才可信；② **看 Go 程序的栈需要 `-g` 且可能因栈帧指针缺失而不完整**——Go 1.21+ 默认保留帧指针（amd64/arm64）情况已改善，但**Go 程序优先用 pprof**，perf 的价值在于看**内核态**和**跨进程全局视图**；③ 需要 `perf_event_paranoid` 权限，容器里常被 seccomp 禁掉（第 11 章 §5.2）。
- **案例**：Go 服务 CPU 高但 pprof 显示用户态函数都不重 → `perf top` 发现 `[k] _raw_spin_lock` 占 30% → 内核锁竞争 → 定位到大量小 write 引发的 inode 锁争用。

**`bpftrace` / BCC** — eBPF 工具集（生产环境的首选）
- **问题**：需要 strace 级别的细节，但不能让服务慢 100 倍。
- **命令**：
  ```bash
  bpftrace -e 'tracepoint:syscalls:sys_enter_openat { @[comm] = count(); }'
  execsnoop-bpfcc          # 实时看谁在起进程 ← 排查"谁在 fork" 的神器
  opensnoop-bpfcc          # 实时看谁在开文件
  biolatency-bpfcc         # 块设备延迟直方图
  ```
- **误区**：需要较新内核（4.9+，功能完整要 5.x）和 root；容器内一般用不了（需要 `CAP_BPF`/`CAP_SYS_ADMIN`，而 Sandbox 恰恰要禁掉它，第 11 章 §5.2）。
- **案例**：线上偶发 fork 风暴但抓不到现场 → `execsnoop` 挂 10 分钟 → 抓到某个健康检查脚本每秒起 50 个子进程。

**`pstack` / `gdb` / `eu-stack`** — 线程栈快照（非 Go 程序的"goroutine dump"）
- **问题**：进程卡住了，每个线程分别卡在哪？
- **命令**：
  ```bash
  # ⚠️ pstack 在多数发行版已被移除，用等价替代:
  eu-stack -p <pid>                    # elfutils 包, 最轻量
  gdb -p <pid> -batch -ex 'thread apply all bt' -ex detach
  cat /proc/<pid>/task/*/stack         # 内核栈(需 root, 看 D 状态卡在哪最有用)
  cat /proc/<pid>/wchan                # 单值: 当前睡在哪个内核函数
  ```
- **关键字段**：栈顶函数（卡在哪）、多个线程是否卡在**同一个锁**上（锁竞争的直接证据）
- **误区**：⚠️ `gdb -p` 会**暂停目标进程**（ptrace attach），生产上要快进快出；**Go 程序不要用它**——用 `/debug/pprof/goroutine?debug=2` 或 `SIGQUIT`，那才有 goroutine 语义（线程栈只能看到 M，看不到 G）。
- **案例**：C++ 服务无响应 → `eu-stack` 显示 40 个线程全卡在同一个 `pthread_mutex_lock` → 持锁线程卡在一个没有超时的网络读上。

**`ulimit` / `/proc/<pid>/limits`** — 资源上限（第 10 章 §2.1 详述）
- **问题**：是不是撞到某个上限了？
- **命令**：`ulimit -a`（当前 shell）、**`cat /proc/<pid>/limits`（运行中的进程，排障用这个）**
- **误区**：⚠️ `ulimit -a` 显示的是**你这个 shell** 的限制，**不是目标进程的**——服务可能由 systemd 启动，limits 完全不同。永远查 `/proc/<pid>/limits`。
- **案例**：见第 10 章案例 B（`failed to create new OS thread` → NPROC 打满）。

## 4. Go 工具矩阵

### 4.1 pprof 的六种 profile

```go
import _ "net/http/pprof"                    // 注册到 DefaultServeMux
go func() { http.ListenAndServe("localhost:6060", nil) }()
// ⚠️ 只监听 localhost！pprof 端点暴露公网 = 信息泄露 + DoS 入口
```

| Profile | 回答什么问题 | 采集命令 | 默认开启 |
|---|---|---|---|
| **CPU** | 时间花在哪个函数 | `go tool pprof http://.../debug/pprof/profile?seconds=30` | 按需 |
| **heap** | 内存被谁占着 / 谁分配得多 | `go tool pprof http://.../debug/pprof/heap` | ✅ |
| **goroutine** | 有多少 G、卡在哪 | `curl .../debug/pprof/goroutine?debug=1` | ✅ |
| **block** | goroutine 阻塞在哪（channel/锁等待时长） | 需 `runtime.SetBlockProfileRate(n)` | ❌ |
| **mutex** | 锁竞争的等待时长排名 | 需 `runtime.SetMutexProfileFraction(n)` | ❌ |
| **allocs** | 累计分配（找 GC 压力源） | `.../debug/pprof/allocs` | ✅ |

**heap 的四个视角（最容易搞混）**：
```bash
go tool pprof -inuse_space  http://.../heap    # 【现在还占着】的字节 ← 找泄漏
go tool pprof -inuse_objects http://.../heap   # 现在还占着的对象数 ← 找小对象堆积
go tool pprof -alloc_space  http://.../heap    # 【历史累计】分配字节 ← 找 GC 压力
go tool pprof -alloc_objects http://.../heap   # 历史累计分配对象数
```
👉 **找内存泄漏用 `inuse_space`，找 GC 频繁的原因用 `alloc_space`**。搞反了会得出完全错误的结论。

**pprof 交互命令速查**：
```text
top          按 flat 排序（函数自身耗时/占用）
top -cum     按 cum 排序（含被调用者）← 找"这条链路总共花了多少"
list <func>  显示该函数的逐行开销 ← 最有用的一个命令
web          生成调用图 SVG（需 graphviz）
peek <func>  看谁调用了它、它调用了谁
```

**diff 模式（定位增长）**：
```bash
curl -s .../heap > h1; sleep 600; curl -s .../heap > h2
go tool pprof -base h1 -top h2      # 只看这 10 分钟的【净增长】
```

### 4.2 go tool trace — 时间线视角

```bash
curl -o trace.out 'http://localhost:6060/debug/pprof/trace?seconds=5'
go tool trace trace.out             # 打开浏览器界面
```
**能看到 pprof 看不到的**：
- 每个 goroutine 的完整生命周期（创建→运行→阻塞→唤醒）
- **调度延迟**：G 处于 runnable 但没被调度的时长 ← 定位"CPU 够但请求慢"
- GC 的每个阶段（STW 多久、mark assist 占了谁的时间，第 06 章 §2.3）
- syscall 阻塞的时长分布

⚠️ trace 的开销较大（几个百分点）且文件很大，**只采集几秒**。

### 4.3 GODEBUG — 零依赖的运行时观测

```bash
GODEBUG=gctrace=1 ./app          # 每轮 GC 一行（第 06 章 §5 逐字段解读）
GODEBUG=schedtrace=1000 ./app    # 每秒打印调度器状态（第 03 章 lab 实验 2）
GODEBUG=scheddetail=1,schedtrace=1000 ./app   # 详细到每个 P/M/G
GODEBUG=inittrace=1 ./app        # 每个包的 init 耗时 ← 启动慢的排查利器
GODEBUG=madvdontneed=1 ./app     # 强制立即归还内存（旧版本，第 06 章 §2.5）
```
**优势**：不需要改代码、不需要开端口，生产环境直接加环境变量重启即可。

### 4.4 goroutine dump — 卡住时的第一手证据

```bash
curl -s 'localhost:6060/debug/pprof/goroutine?debug=1'   # 按创建栈【聚合计数】← 找泄漏
curl -s 'localhost:6060/debug/pprof/goroutine?debug=2'   # 每个 G 的完整栈 + 阻塞时长
```
`debug=2` 的输出格式（读法是排障基本功）：
```text
goroutine 42 [chan receive, 8 minutes]:      ← 状态 + 已阻塞时长（8 分钟 = 极可疑）
main.worker(0xc000010060)
	/app/worker.go:37 +0x8c                   ← 卡在这一行
created by main.startWorkers in goroutine 1
	/app/main.go:52 +0x1a5                    ← 谁创建的
```
**常见阻塞状态与含义**：`chan receive`/`chan send`（channel 无人配对）、`select`（多路等待）、`semacquire`（**等锁**，大量出现 = 锁竞争或死锁）、`IO wait`（netpoller 上等网络，正常）、`syscall`（陷在系统调用里）、`GC assist wait`（被拉去帮 GC 干活，第 06 章 §2.3）。

⚠️ **误区**：`kill -QUIT <pid>` 也能 dump 全部 goroutine 栈，但它**会让进程退出**——线上想 dump 不想死，只能用 pprof 端点。

### 4.5 runtime 指标（埋进监控）

两套 API，优先用后者：

```go
// 老 API：简单但有代价
runtime.NumGoroutine()                 // goroutine 数 ← 泄漏的第一指标，很便宜
var ms runtime.MemStats
runtime.ReadMemStats(&ms)              // ⚠️ 会 STW（停顿随堆增大而变长），别高频调用

// 新 API（Go 1.16+ runtime/metrics）：无 STW、字段更细、随版本演进不破坏兼容
import "runtime/metrics"
samples := []metrics.Sample{
    {Name: "/gc/heap/live:bytes"},          // 存活堆 ← 泄漏看这个的趋势
    {Name: "/gc/pauses:seconds"},           // STW 直方图（不是平均值！）
    {Name: "/sched/goroutines:goroutines"}, // goroutine 数
    {Name: "/sched/latencies:seconds"},     // ⚠️ 调度延迟直方图 —— 老 API 拿不到
    {Name: "/cpu/classes/gc/total:cpu-seconds"}, // GC 占用的 CPU
}
metrics.Read(samples)
// metrics.All() 可列出当前 Go 版本支持的全部指标及其说明
```

**最小监控集**（每个 Go 服务都该有，缺一项就有一类问题看不见）：

| 指标 | 看什么 | 异常信号 |
|---|---|---|
| goroutine 数 | 泄漏 | 单调上升不回落（第 03 章 §9） |
| heap live / inuse | 内存泄漏 | 单调上升（第 06 章 §9） |
| GC 频率 + STW 分位数 | GC 压力 | 频率变高 / STW 超过 ms 级 |
| 调度延迟分位数 | CPU 竞争 | P99 变大 = 有人霸占 P（第 03 章 §7） |
| 线程数（M） | 阻塞 syscall 增生 | 远超 GOMAXPROCS（第 03 章 §3.4） |
| GC CPU 占比 | 分配速率 | > 25% 说明分配太快 |

⚠️ **监控要用分位数不用平均值**：平均值会把长尾完全掩盖——P99 延迟 2 秒、平均 20ms 的服务，看平均值一切正常。

## 5. 故障剧本：五个靶场的完整走查

> 配套程序 [`03_pprof_targets`](../code/05_profiling/03_pprof_targets/main.go) 可以按需触发这五种故障，用于练手。

### 剧本 A：CPU 打满

```text
现象  top 显示某进程 CPU 400%（4 核跑满），QPS 没涨，延迟上升
分诊  us 高 → 第一象限 → pprof CPU profile
验证  go tool pprof -http=:8080 'http://localhost:6060/debug/pprof/profile?seconds=30'
      → top 看 flat 最高的函数
      → list <该函数> 看具体是哪一行
常见根因
      · 正则在热路径里重复编译（regexp.MustCompile 应该提到包级变量）
      · JSON 序列化大对象（考虑 easyjson / 减少字段）
      · 无谓的字符串拼接/转换（第 06 章 §2.6）
      · 忙轮询（应该用 channel/条件变量）
      · GC 占比过高（gctrace 确认，转剧本 C）
解决  优化热点函数；验证：profile 里该函数占比下降，CPU 曲线回落
```

### 剧本 B：load 高但 CPU 低

```text
现象  load 25（8 核），top 显示 id 70%、wa 20%
分诊  第三象限 → 存储
验证  vmstat 1        → b 列常年 > 0
      ps -eo stat,pid,wchan:30,comm | awk '$1~/D/'   → 谁在 D、卡在哪个内核函数
      iostat -x 1     → %util 高、await 从 1ms 涨到 50ms
常见根因
      · 磁盘/云盘 IOPS 打满（await 高、aqu-sz 大）
      · NFS 服务端无响应（wchan 显示 nfs 相关）
      · 大量 fsync（第 07 章 §2.5）
      · 内存不足导致 swap（vmstat 的 si/so > 0）
解决  对症：限流/换盘/减少 fsync/修 NFS
⚠️ 陷阱  此时加 CPU 完全无用；D 状态 kill -9 也杀不掉（第 02 章 §2.2）
```

### 剧本 C：内存持续增长

```text
现象  RSS 一周从 800MB 涨到 3GB，无 OOM 但接近 limit
分诊  先分三层（第 06 章 §2.5）：是堆在涨？还是攥着不还？还是堆外？
验证  ① GODEBUG=gctrace=1 → 看"存活堆"（第三个数字）是否单调上升
         上升 = 真泄漏；不升但 RSS 涨 = 攥着不还或堆外
      ② heap diff 定位：
         curl -s .../heap > h1; sleep 600; curl -s .../heap > h2
         go tool pprof -base h1 -top h2      ← 只看净增长
      ③ 若 heap 干净但 RSS 涨：查 goroutine 数（栈）、CGO、mmap
常见根因
      · 只增不删的 map 缓存（加 LRU+TTL，第 06 章 §2.6）
      · 子切片钉住大数组（slices.Clone）
      · goroutine 泄漏连带引用（第 03 章 §9）
      · 无界队列（第 06 章 §4 板斧③）
解决  修复后 48h 观察 RSS 平台期 + gctrace 存活堆走平
```

### 剧本 D：fd 泄漏 / Too many open files

```text
现象  accept: too many open files，服务拒绝新连接
验证  ls /proc/<pid>/fd | wc -l           → 当前数
      cat /proc/<pid>/limits | grep files → 上限
      lsof -p <pid> | awk '{print $5}' | sort | uniq -c | sort -rn   → 按类型
      lsof -p <pid> | awk '{print $9}' | sort | uniq -c | sort -rn   → 按目标
判决  大量 socket + CLOSE_WAIT → HTTP resp.Body 未关（最高频）
      大量同名 REG            → 文件 Close 遗漏
      数字恰好卡在 1024       → ulimit 太小
解决  修代码为主、调 limit 为辅（第 07 章 §4.1 三种泄漏模式）
```

### 剧本 E：锁竞争导致吞吐塌陷

```text
现象  QPS 加压不上去，CPU 只有 60%，延迟随并发线性上升
分诊  第四象限（都不忙但慢）
验证  ① strace -c -f -p <pid>  → futex 调用占比高（第 09 章 §5.2）
      ② 开 mutex profile：
         runtime.SetMutexProfileFraction(5)
         go tool pprof http://.../debug/pprof/mutex
         → top 看等锁总时长排名，list 定位到具体的 Lock 调用
      ③ go tool trace → 看 goroutine 大量处于 "sync block"
常见根因
      · 全局锁保护热点数据结构（分片！）
      · 临界区里做 I/O 或慢计算（第 04 章 §7 错误 3）
      · RWMutex 用错场景（读临界区太短，第 04 章 §7 错误 1）
解决  缩临界区 → 分片（按 key 哈希成 N 把锁）→ 无锁快照
      验证：mutex profile 里该锁的等待时长下降一个数量级，QPS 上升
```

## 6. 个人排障速查表（模板）

把这张表打印出来贴在显示器边上：

```text
┌─ 第一分诊（30 秒）─────────────────────────────────────────┐
│ top          → us? sy? wa? id? load/核数?                  │
│ vmstat 1 5   → r? b? si/so? （忽略第一行）                  │
│ free -h      → available? （不是 free）                     │
│ df -h && df -i → 空间? inode?                              │
└────────────────────────────────────────────────────────────┘

us 高  → pprof CPU profile → top → list <func>
sy 高  → strace -c -f      → 看 calls 爆炸的那个
wa 高  → iostat -x + ps 找 D → 存储瓶颈
都不高 → ss 队列 / mutex profile / block profile / 查下游

Go 专用:
  goroutine 涨 → /debug/pprof/goroutine?debug=1（两次采样看净增长）
  内存涨       → gctrace 看存活堆 → heap -base diff → inuse_space
  GC 频繁      → alloc_space（不是 inuse!）→ 减少分配
  延迟毛刺     → go tool trace → 看调度延迟 / GC assist
  启动慢       → GODEBUG=inittrace=1

容器里:
  ⚠️ nproc/free 骗人 → 读 /sys/fs/cgroup/{cpu.max,memory.max,pids.max}
  exit 137 → dmesg OOM 案卷 + memory.events
```

## 7. Agent 开发中的应用

**Agent 自身的最小可观测集**（第 13 章会落地）：
```text
指标  · 运行中任务数 / 队列长度 / 等待时长分位数
      · 任务时长分位数（P50/P95/P99）
      · 任务终态计数（成功/失败/超时/取消/被杀）← 按原因分类是排障的起点
      · goroutine 数、heap inuse、GC 频率
      · 子进程数量、fd 数量 ← 泄漏的早期信号
日志  · 每个任务的完整生命周期事件（提交/开始/输出截断/终止/清理完成）
      · 结构化字段：task_id、tenant、exit_code、signal、duration、truncated
追踪  · task_id 贯穿从 API 到子进程的每一条日志 ← 没有它就无法关联
```

**"验尸"检查清单**（每个任务结束后自检，异常就告警）：
```bash
pgrep -g <pgid>              # 应为空 —— 有残留说明进程树没杀干净（第 02 章）
ls /proc/<agent_pid>/fd | wc -l   # 应回到基线 —— 涨了就是 fd 泄漏
ls <workdir>                 # 应已删除 —— 残留说明清理钩子没跑（第 07 章）
runtime.NumGoroutine()       # 应回到基线 —— 涨了就是 goroutine 泄漏（第 03 章）
```
👉 **把这四项做成集成测试**，比任何监控都早发现问题。

## 8. 常见误区总结

| 误区 | 真相 |
|---|---|
| `ps` 的 %CPU 是瞬时值 | 是自启动以来的平均值，要瞬时用 `top`/`pidstat 1` |
| `vmstat` 第一行有意义 | 是自启动以来的平均，从第二行看 |
| `free` 少就是内存不足 | 看 `available`；cache 多是好事 |
| `%util` 100% 就是磁盘满载 | 对 SSD/NVMe 不可靠，看 `await` 和 `aqu-sz` |
| 大量 TIME_WAIT 是问题 | 正常状态，60 秒消失；CLOSE_WAIT 才是 bug |
| heap profile 用 alloc_space 找泄漏 | 找泄漏用 `inuse_space`；alloc 用于找 GC 压力 |
| VIRT 大说明内存有问题 | Go 预留虚拟地址是常态，只看 RES |
| strace 可以在生产随便用 | 10–100 倍减速，用 `-c` 短采样或换 perf/eBPF |
| 容器里 `nproc` 可信 | `/proc` 不隔离，读 cgroup 文件 |
| load 高 = CPU 不够 | load 含 D 状态；先分清 R 还是 D |

## 9. 实验任务

[lab_05_debugging.md](../labs/lab_05_debugging.md) 实验 6–10：五个靶场按剧本 A–E 逐一演练，每个限时 20 分钟定位根因并写四段式报告。

## 10. 面试题（附答题要点）

**Q1：线上服务 CPU 突然打满，你怎么排查？**
要点：分层——① `top` 确认是 us 还是 sy（用户逻辑 vs 内核）；② us 高就抓 CPU profile，`top` + `list` 定位到行；③ sy 高就 `strace -c` 看哪个 syscall 爆炸；④ 别忘了检查是不是 GC 占比高（gctrace）。加分：说出 profile 要采 30 秒而不是瞬时；说出常见根因清单（正则重编译、JSON、忙轮询）。

**Q2：内存持续增长怎么定位？**
要点：先分三层（堆在涨 / 攥着不还 / 堆外），用 gctrace 的"存活堆"区分；然后 heap **diff**（`-base`）看净增长；**用 inuse_space 不是 alloc_space**。加分：堆干净但 RSS 涨 → 查 goroutine 栈、CGO、mmap；给出常见泄漏模式（只增 map、子切片钉数组、goroutine 泄漏）。

**Q3：pprof 有哪几种 profile？分别解决什么问题？**
要点：CPU（时间去哪）、heap（内存被谁占，四个视角）、goroutine（有多少、卡在哪）、block（阻塞时长）、mutex（锁竞争）、allocs（GC 压力）。加分：block/mutex 需要手动开启采样率；heap 的 inuse vs alloc 的区别；trace 补充了 pprof 看不到的调度延迟。

**Q4：怎么定位锁竞争？**
要点：现象（QPS 上不去、CPU 不满、延迟随并发涨）→ `strace -c` 看 futex 占比 → 开 mutex profile 看等锁时长排名 → `list` 定位具体 Lock。解决三板斧：缩临界区、分片、无锁快照。加分：`go tool trace` 的 sync block 视图。

**Q5：CPU 不高但请求很慢，可能是什么原因？**
要点：CPU 闲说明**在等**——逐一排查：等 I/O（iostat + D 状态）、等锁（mutex profile）、等网络（ss 的 Recv-Q/Send-Q）、等下游（链路追踪）、调度延迟（go tool trace）。加分：强调"找等什么"而不是"找谁在算"的思维转换。

**Q6：strace 和 perf 怎么选？**
要点：strace 基于 ptrace，看**具体每次调用的参数**，但 10–100 倍减速，只适合开发/预发或短时 `-c` 采样；perf 基于采样，开销小得多，看**热点分布**（含内核符号），适合生产。eBPF/bpftrace 是两者优点的结合（可编程、低开销）。加分：Go 程序优先 pprof（有完整的 goroutine 语义）。

**Q7：如何给一个服务设计可观测性？**
要点：三支柱——指标（RED：Rate/Error/Duration；USE：资源的使用率/饱和/错误）、日志（结构化 + trace_id 贯穿）、追踪（跨服务链路）。Go 服务必备最小集：goroutine 数、heap、GC、线程数。加分：给"验尸检查清单"这种可自动化的自检思路。

## 11. 本章总结

- 排障从**分诊**开始：`top` + `vmstat` 两条命令定位四个象限，再选工具，避免乱撞。
- USE 方法论逼你逐资源排除；第四象限（都不忙但慢）最难，答案通常是等锁/等网络/等下游。
- Linux 工具矩阵的关键字段比命令本身重要：`WCHAN`（D 状态卡在哪）、`available`（不是 free）、`await`（不是 %util）、`Recv-Q/Send-Q`（谁慢）。
- Go 工具：pprof 六种 profile 各司其职（**inuse 找泄漏、alloc 找 GC 压力**）、trace 看时间线、GODEBUG 零依赖。
- 五个故障剧本覆盖了本模块的全部故障类型，每个都有固定的验证路径。

**检查清单**：
- [ ] 我能用两条命令做第一分诊，并说出四个象限各自的首选工具
- [ ] 我能说出至少 10 个工具的"最该看的字段"
- [ ] 我分得清 heap 的 inuse/alloc 四个视角，知道各自回答什么问题
- [ ] 我能对五个靶场故障各写出一份四段式报告
- [ ] 我有一张自己的排障速查表，并且用过至少三次

## 12. 延伸阅读

- 《Systems Performance》(Brendan Gregg, 2nd ed.)——USE 方法论与 Linux 性能工具的圣经
- 《BPF Performance Tools》(Brendan Gregg)——eBPF 时代的工具集
- Go 官方博客：*Profiling Go Programs*、*Diagnostics* 文档页
- Brendan Gregg 的 *Linux Performance Analysis in 60,000 Milliseconds*（Netflix 团队的分诊清单）
- 本仓库 `go/knowledge/11_performance_pprof.md`、`19_advanced_testing_profiling.md`、`28_runtime_forensics.md`
