# Lab 05 · 排障：从 strace 到资源限制

> 配套章节：[09 系统调用](../knowledge/09_system_calls.md)、[10 Linux 资源限制](../knowledge/10_linux_resource_management.md)、[12 可观测性与排障](../knowledge/12_observability_and_debugging.md) · 配套代码：[`code/05_profiling`](../code/05_profiling)
>
> 实验 1–2 对应 09 章，3–5 对应 10 章，6+ 对应 12 章（靶场综合演练）。标 🐧 的需要 Linux/WSL2。

---

## 实验 1：strace 解剖一个 Go 程序的启动 🐧

**目的**：把第 01 章的"程序加载"和第 09 章的"syscall 清单"对上号。

```bash
cat > /tmp/hi.go <<'EOF'
package main
import "fmt"
func main() { fmt.Println("hi") }
EOF
cd /tmp && go build -o hi hi.go

strace -f -c ./hi                     # 统计：哪些 syscall、各多少次
strace -f ./hi 2>&1 | head -60        # 细看前 60 行
```

**逐类解读（写下你的答案再对照 09 章 §3）**：

| syscall | 大约几次 | 谁产生的？ |
|---|---|---|
| `execve` | 1 | shell 变身（第 01 章 §3.4 ①） |
| `mmap` | 十几~几十 | Go runtime 初始化堆 arena（第 06 章 §2.2） |
| `rt_sigaction` | 几十 | runtime 接管信号（抢占用 SIGURG，第 03 章 §3.3） |
| `clone` | 几次 | runtime 启动后台 M（sysmon、GC worker） |
| `futex` | 若干 | M 之间的同步/唤醒（第 04 章 §3.1） |
| `write(1, ...)` | 1 | 你的 `fmt.Println` |
| `openat` | 少量 | 读 `/sys/kernel/mm/transparent_hugepage/*` 等 runtime 探测 |

**思考题**：为什么看不到 `clock_gettime`？（提示：vDSO，第 01 章 §3.2——**看不到不代表没调用**）

**加分实验**——对比 C 程序：
```bash
echo 'int main(){return 0;}' > /tmp/t.c && gcc -o /tmp/tc /tmp/t.c
strace -c /tmp/tc     # 注意 openat 一串 .so —— 动态链接器在加载 libc
```

## 实验 2：量化缓冲的收益并用 strace 验证 🐧

```bash
cd <repo>/os/code
go run ./05_profiling/01_syscall_cost

# 用 strace 验证 syscall 次数确实降了两个数量级
go build -o /tmp/sc ./05_profiling/01_syscall_cost
strace -c -f /tmp/sc 2>&1 | head -20
```

**预期观察**：4 字节 write 与 bufio 版本的耗时差几十到上千倍；`strace -c` 的 `write` calls 数应该和程序打印的估算量级吻合。

**思考题**：如果把 bufio 缓冲从 64KB 调到 1MB，收益还会线性增长吗？为什么？（提示：syscall 次数已经很少了，边际收益递减；且大缓冲增加崩溃丢数据的窗口）

## 实验 3：撞上 EMFILE 🐧

```bash
cd <repo>/os/code
go run ./05_profiling/02_rlimit                  # 程序内部会自己降软限复现

# 手工版：从 shell 设置限制
ulimit -n 32 && go run ./05_profiling/02_rlimit  # 看启动时的软限变化
```

**手工加深**——观察一个真实进程的 fd 与限制：
```bash
sleep 300 &
PID=$!
cat /proc/$PID/limits | grep -E 'open files|processes'
ls -l /proc/$PID/fd
kill $PID
```

**思考题**：`ulimit -n` 在容器里改不动（提示 "cannot modify limit"）是为什么？（提示：软限只能提到硬限；容器的硬限由运行时启动参数决定，如 docker 的 `--ulimit nofile=`）

## 实验 4：制造 D 状态，看 load 与 CPU 背离 🐧

**目的**：亲眼验证"load = R + D"这个 Linux 特有的定义。

```bash
# 先记录基线
uptime; nproc

# 方法 A：用 dd 制造大量磁盘 I/O（安全，随时可停）
for i in 1 2 3 4; do
  dd if=/dev/zero of=/tmp/load$i.img bs=1M count=2000 oflag=direct 2>/dev/null &
done

# 另一个终端持续观察
watch -n1 'uptime; echo "---"; vmstat 1 2 | tail -1; echo "--- D 状态进程:"; ps -eo stat,pid,wchan:25,comm | awk "\$1 ~ /D/"'

# 观察 15 秒后停止
sleep 15; killall dd; rm -f /tmp/load*.img
```

**预期观察**：
- `uptime` 的 load 明显上升；
- `top` 的 CPU 里 **`wa`（iowait）高但 `us`/`sy` 不高**——CPU 其实很闲；
- `vmstat` 的 **b 列（阻塞队列）** 有值；
- `ps` 能看到 dd 处于 **D 状态**，`wchan` 显示卡在哪个内核函数。

**思考题**：这时候给服务器加 CPU 有用吗？该加什么？（提示：瓶颈在存储，加 CPU 毫无意义）

**加分**：`iostat -x 1 3` 看 `%util`（设备饱和度）和 `await`（单次 I/O 平均等待），确认存储确实是瓶颈。

## 实验 5：容器视图失真 🐧

**目的**：验证"容器里 nproc/free 骗人"，这是容器化时代最实用的一个认知。

```bash
# 有 Docker 的话（最直观）：
docker run --rm --cpus=1 --memory=256m alpine sh -c '
  echo "nproc 看到:      $(nproc)"
  echo "free 看到:       $(free -m | awk "/^Mem/{print \$2}") MB"
  echo "--- 真实配额 ---"
  cat /sys/fs/cgroup/cpu.max 2>/dev/null || cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us
  cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes
'

# 没有 Docker：手工建一个 cgroup 观察
sudo mkdir -p /sys/fs/cgroup/viewlab
echo "200000 100000" | sudo tee /sys/fs/cgroup/viewlab/cpu.max   # 2 核
sudo sh -c "echo $$ > /sys/fs/cgroup/viewlab/cgroup.procs"
nproc                                    # 还是宿主机核数！
cat /sys/fs/cgroup/viewlab/cpu.max       # 真实配额
# 退出后清理: sudo rmdir /sys/fs/cgroup/viewlab
```

再跑 Go 版本对照：
```bash
cd <repo>/os/code && go run ./05_profiling/02_rlimit    # 看最后一节的对比输出
```

**预期观察**：`nproc`/`free` 显示宿主机的值，`cgroup` 文件显示真实配额，两者可能差几十倍。

**思考题**：一个 JVM 服务在 4GB limit 的容器里，堆设成 `-Xmx` 不指定（按物理内存的 1/4 自动算），宿主机 256GB，会发生什么？（提示：堆算成 64GB，启动就超 limit → OOMKilled；JDK 10+ 的 `UseContainerSupport` 修复了这个）

---

## 实验 6–10：五个故障靶场（配合 [12 章](../knowledge/12_observability_and_debugging.md)）

> **玩法**：启动靶场程序，随机挑一个端点触发，然后**限时 20 分钟**用工具定位根因，写出四段式报告。
> 报告模板见本节末尾。⚠️ 不要偷看代码——那等于看答案。

```bash
cd <repo>/os/code
go run ./05_profiling/03_pprof_targets     # 启动后会打印每个靶场的触发和定位命令
```

### 实验 6 · 靶场 A：CPU 打满

```bash
curl 'localhost:8099/cpu' &                # 触发（跑 30 秒）
# 立刻在另一个终端定位：
top -p $(pgrep -f pprof_targets)           # 确认是 us 高还是 sy 高
go tool pprof -top http://localhost:6060/debug/pprof/profile?seconds=20
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=20
  (pprof) top
  (pprof) list targetCPU                   # ← 定位到具体哪一行
```

**预期发现**：flat 时间集中在 `regexp.Compile` 相关的调用栈上。

**对照验证**：`curl 'localhost:8099/cpu?mode=fixed'` 后重新采样——同样的 30 秒，完成的次数应该多一个数量级。

**思考题**：为什么 profile 要采 20–30 秒而不是 1 秒？（提示：采样频率 100Hz，样本太少统计不可靠）

### 实验 7 · 靶场 B：goroutine 泄漏

```bash
curl -s localhost:6060/debug/pprof/goroutine?debug=1 | head -5   # 记下基线
for i in $(seq 5); do curl -s localhost:8099/goroutine-leak; done
curl -s localhost:6060/debug/pprof/goroutine?debug=1 | head -20
```

**预期发现**：输出第一行按数量排序，2500 个 goroutine 阻塞在同一个创建栈上（`chan receive`）。

**进阶**：用 `debug=2` 看单个 goroutine 的完整栈和阻塞时长（`[chan receive, 3 minutes]`）。

**思考题**：如果泄漏的 goroutine 只有几十个但持续增长，怎么和"正常的常驻 goroutine"区分？（提示：两次采样看**净增长**，不看绝对值）

### 实验 8 · 靶场 C：内存泄漏

```bash
curl -s localhost:6060/debug/pprof/heap > /tmp/h1
for i in $(seq 30); do curl -s localhost:8099/mem-leak > /dev/null; done
curl -s localhost:6060/debug/pprof/heap > /tmp/h2
go tool pprof -base /tmp/h1 -top /tmp/h2         # 只看这段时间的净增长
go tool pprof -base /tmp/h1 /tmp/h2
  (pprof) list targetMemLeak
```

**对照实验**——验证 inuse 与 alloc 的区别：
```bash
go tool pprof -sample_index=inuse_space -top /tmp/h2 | head -8   # 还占着的
go tool pprof -sample_index=alloc_space -top /tmp/h2 | head -8   # 历史累计分配的
```

**预期发现**：`inuse_space` 指向 `sessionCache` 的 make；两个视角的排名可能完全不同。

**思考题**：什么情况下 `alloc_space` 很大但 `inuse_space` 很小？这说明什么问题？（提示：大量短命对象 → GC 压力大但不泄漏 → 该优化分配而不是找泄漏）

### 实验 9 · 靶场 D：fd 泄漏 🐧

```bash
PID=$(pgrep -f pprof_targets)
ls /proc/$PID/fd | wc -l                          # 基线
for i in $(seq 10); do curl -s localhost:8099/fd-leak; done
ls /proc/$PID/fd | wc -l                          # 涨了多少
lsof -p $PID | awk '{print $5}' | sort | uniq -c | sort -rn    # 按类型
lsof -p $PID | grep -c TCP                        # socket 数量
```

**预期发现**：fd 数随每次请求线性增长，类型集中在 TCP socket。

**思考题**：真实服务里，如果 `lsof` 显示大量 `CLOSE_WAIT` 状态的 socket，第一嫌疑是什么？（提示：第 07 章 §9——HTTP resp.Body 未 Close）

### 实验 10 · 靶场 E：锁竞争

```bash
time curl 'localhost:8099/lock'                   # 慢操作在锁内
time curl 'localhost:8099/lock?mode=fixed'        # 慢操作在锁外
# 定位：
curl -s localhost:6060/debug/pprof/mutex > /tmp/m.out
go tool pprof -top /tmp/m.out
go tool pprof /tmp/m.out
  (pprof) list targetLockContention
# 交叉验证：
strace -c -f -p $(pgrep -f pprof_targets) & sleep 5; kill %1   # 看 futex 占比
```

**预期发现**：两种模式的耗时差好几倍；mutex profile 指向锁内的那次 `slowCompute`。

**思考题**：为什么"慢操作放锁外"能提升这么多？用第 04 章的哪个原理解释？（提示：临界区占比决定并行加速比上限）

---

## 四段式报告模板

每个靶场定位完成后，用这个格式写下来（这也是线上故障复盘的标准格式）：

```markdown
## 故障：<一句话描述>

**现象**  用户/监控看到了什么？（QPS、延迟、错误率、资源曲线）
**原因**  根因是什么？为什么会这样？（要能解释所有观察到的现象）
**验证**  用什么命令/数据证明了这个原因？（贴关键输出）
**解决**  改了什么？怎么验证修复有效？（要有回归验证的指标）
```

---

## 验收清单

**实验 1–5（系统与限制）**
- [ ] 我能逐类解释一个 Go 程序启动时的 syscall 来源，并说出为什么看不到 clock_gettime
- [ ] 我用 strace -c 验证过缓冲把 syscall 次数降了两个数量级
- [ ] 我亲手撞过 EMFILE，知道排查要对比 `/proc/<pid>/fd` 与 `limits`
- [ ] 我制造过 D 状态并观察到 load 高而 CPU 闲，能用 vmstat 的 b 列佐证
- [ ] 我验证过容器里 nproc/free 失真，知道该读哪些 cgroup 文件

**实验 6–10（故障靶场）**
- [ ] 五个靶场我都在 20 分钟内独立定位到了根因
- [ ] 我能用 `list` 命令把问题定位到**具体某一行代码**，而不只是某个函数
- [ ] 我分得清 heap 的 inuse_space 和 alloc_space，知道各自回答什么问题
- [ ] 我写了五份四段式报告，每份的"验证"部分都有真实的命令输出
- [ ] 我整理出了自己的排障速查表（12 章 §6 的模板 + 我踩过的坑）
