# Lab 01 · 进程：从 strace 到进程树击杀

> 配套章节：[01 OS 基础](../knowledge/01_os_foundations.md)、[02 进程](../knowledge/02_process.md) · 配套代码：[`code/01_process`](../code/01_process)
>
> 玩法：每个实验先**写下你的预测**，再动手验证。预测错了才是学到东西的时刻。
> 环境：Linux / WSL2，安装 `strace psmisc procps binutils`（Ubuntu: `sudo apt install strace psmisc procps binutils`）。

---

## 实验 1：strace 一个最小 Go 程序（对应 01 章）

**目的**：亲眼看到"一行代码的程序"背后有多少系统调用，建立 syscall 层的直觉。

```bash
cat > /tmp/hello.go <<'EOF'
package main
func main() { println("hi") }
EOF
cd /tmp && go build -o hello hello.go

strace -c ./hello          # 按类别统计
strace ./hello 2>&1 | head -40   # 看前 40 行完整轨迹
```

**预期观察**：几十次 syscall。重点解读：
- `execve` 开局（shell 变身成 hello）；
- 一串 `mmap` —— Go runtime 初始化堆区、为 P 分配结构（01 章 3.4 ⑤）；
- `clone`/`clone3` 若干次 —— runtime 启动后台线程（sysmon、GC worker，03 章）；
- `rt_sigaction` 一大串 —— Go 接管几乎所有信号（抢占、panic 转 goroutine 栈都靠它）；
- `write(2, "hi\n", 3)` —— println 走 stderr（fd 2），不是 stdout！

**思考题**：为什么看不到 `open("/lib/.../libc.so")`？（提示：静态链接，01 章 3.4 ③）

## 实验 2：静态 vs 动态链接（对应 01 章）

**目的**：理解 Go 部署简单的根源，和容器里 "no such file" 假报错。

```bash
file hello && ldd hello          # Go: statically linked / not a dynamic executable
file /bin/ls && ldd /bin/ls      # C:  dynamically linked + 一串 .so 依赖
readelf -l /bin/ls | grep -A1 INTERP   # 看到解释器 /lib64/ld-linux-x86-64.so.2
readelf -l hello | head -25      # 对比: Go 没有 INTERP 段
```

**思考题**：把 `/bin/ls` 拷进 `FROM scratch` 容器运行会报什么错？错的是找不到 ls 本身吗？

## 实验 3：解读进程地址空间（对应 01 章）

**目的**：把"虚拟地址空间"从名词变成一张能看的表（为 05 章铺垫）。

```bash
sleep 300 &
cat /proc/$!/maps | head -20
kill %1
```

**预期观察**：每行一段映射：代码段 `r-xp`（可读可执行不可写）、数据段 `rw-p`、堆 `[heap]`、栈 `[stack]`、`[vdso]`（01 章讲的免陷入时钟）。

**思考题**：为什么代码段权限没有 w？（提示：W^X 安全策略 + 多进程共享同一份物理页）

## 实验 4：制造并回收僵尸（对应 02 章 §3.3）

**目的**：亲手养一只僵尸，验证 "kill -9 对僵尸无效"。

```bash
cd <repo>/os/code && go run ./01_process/05_zombie_reap
# 程序会停在僵尸阶段给你时间, 另开终端:
ps -o pid,ppid,stat,cmd -p <打印出的pid>    # STAT=Z, cmd 显示 <defunct>
```

**预期观察**：② 阶段 STAT=Z；③ 阶段 kill -9 后依然是 Z；④ Wait 后 /proc 条目消失。

**思考题**：线上看到 500 个僵尸，你第一个要查的字段是什么？（提示：不是僵尸的 PID，是它们共同的 PPID——罪犯是父进程）

## 实验 5：孤儿与收养（对应 02 章 §3.3）

**目的**：观察父先死后子进程的 PPID 变化。

```bash
sh -c 'sleep 60 & echo child=$!' ; # sh 立刻退出, sleep 变孤儿
ps -o pid,ppid,cmd -p <child>      # PPID 变成 1(或 systemd --user 的 pid)
kill <child>
```

**思考题**：WSL2/桌面发行版上 PPID 可能不是 1 而是几百的数——那是什么？（提示：subreaper，systemd --user 注册过 `PR_SET_CHILD_SUBREAPER`）

## 实验 6：杀 bash 留 python 事故复现（对应 02 章 §4.2，本实验是全 lab 核心）

**目的**：复现 Agent 最高频的进程泄漏，验证进程组方案真的能整树击杀。

```bash
cd <repo>/os/code && go run ./01_process/04_process_group_kill
```

**预期观察**：
- 事故版：sh 死后 sleep 仍在，PPID 变 1（孤儿）——"任务取消了还在烧 CPU"的现场；
- 修复版：`kill(-PGID)` 后验尸列表为空。

**手工加深**（不用 Go，纯 shell 复现一遍）：

```bash
bash -c 'sleep 300' &            # bash fork 出 sleep
ps -eo pid,ppid,pgid,cmd | grep -E 'bash|sleep 300' | grep -v grep
kill %1                          # 只杀 bash
ps -eo pid,ppid,pgid,cmd | grep 'sleep 300' | grep -v grep   # sleep 还在!
kill -- -<刚才记下的PGID>          # 负 PGID 整组击杀 → 这次干净了
```

**思考题**：如果子进程自己调用了 `setsid` 逃出进程组，方案 A 失效——还有哪两层防线？（提示：02 章 4.2 方案 C/D）

## 实验 7：管道死锁（对应 02 章 §5）

**目的**：复现"读子进程 stdout 为什么可能死锁"，并理解 64KB 这个数。

```bash
cd <repo>/os/code
go run ./01_process/02_capture_output            # 正确版本
go run ./01_process/02_capture_output -deadlock  # 死锁复现(10 秒自动解围)
```

**手工验证管道容量**：

```bash
# dd 往一个没人读的管道里灌数据, 看灌到多少字节卡住
mkfifo /tmp/p; cat /tmp/p > /dev/null &  # 先接一个读端, 稍后再断开验证也可
dd if=/dev/zero bs=1k count=200 | { sleep 1000; } # 简版: dd 卡住时 Ctrl-C, 观察 dd 报告≈64K
```

**思考题**：死锁时用什么命令确认双方各卡在哪？（提示：`cat /proc/<pid>/stack` 或 `wchan` 字段——都卡在 `pipe_write`/`do_wait`）

---

## 验收清单（全部打勾才算过关）

- [ ] 我能解释实验 1 里 top5 syscall 各自是谁产生的（shell / 内核 / Go runtime）
- [ ] 我能不查资料说出静态/动态链接在容器部署上的差异
- [ ] 我养过僵尸、试过 kill -9 无效、并用 Wait 送走了它
- [ ] 我亲手复现过"杀 bash 留 sleep"，并用负 PGID 干净收场
- [ ] 我能说出管道死锁的成因数字（64KB）和统一修法（并发排水后 Wait）
