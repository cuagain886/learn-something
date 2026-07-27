# Lab 03 · 内存：从缺页中断到 GC 调参

> 配套章节：[05 内存管理](../knowledge/05_memory_management.md)、[06 Go 内存与 GC](../knowledge/06_go_memory_and_gc.md) · 配套代码：[`code/03_memory`](../code/03_memory)
>
> 实验 1–3 对应 05 章（🐧 需 Linux/WSL2），4–7 对应 06 章（跨平台为主）。先预测，再验证。

---

## 实验 1：承诺 vs 交割——VSZ/RSS/minor fault 实测 🐧

```bash
cd <repo>/os/code && go run ./03_memory/01_vsz_rss
```

**预期观察**：② mmap 1GB 后 VSZ +1024MB 而 RSS +0；③ 逐页写 256MB 后 RSS +256MB 且 minor fault ≈ 65536 次（每 4KB 页一次）；⑤ MADV_DONTNEED 后 RSS 回落、VSZ 不动。

**思考题**：把 ③ 的"每页写 1 字节"改成"只写第一页"，RSS 会涨多少？（提示：交割以页为单位，碰哪页给哪页）

## 实验 2：COW 亲眼看 🐧

**目的**：验证 fork 后"共享页 + 写时分裂"。

```bash
cat > /tmp/cow.sh <<'EOF'
# 用 python 起一个占 200MB 的进程再 fork, 观察父子 RSS 与系统可用内存
python3 - <<'PY'
import os, mmap, time
buf = mmap.mmap(-1, 200<<20)
buf.write(b'x' * (200<<20))          # 父进程真实占住 200MB
pid = os.fork()
if pid == 0:
    time.sleep(5)                     # 子进程只是活着, 不写
    os._exit(0)
print("父=%d 子=%d — 另开终端看:" % (os.getpid(), pid))
print("  ps -o pid,rss,cmd -p %d,%d   # 两边 RSS 都显示 ~200MB" % (os.getpid(), pid))
print("  free -m                      # 但系统 used 没有翻倍 —— 物理页是同一份!")
time.sleep(5); os.waitpid(pid, 0)
PY
EOF
sh /tmp/cow.sh
```

**预期观察**：父子 RSS 各 ~200MB，但 `free` 的 used 只多了一份——RSS 把共享页在两边都记账（这就是 PSS 存在的理由）。若在子进程里写这块内存，`free` 的 used 才会真长（COW 分裂）。

**思考题**：Redis bgsave 期间父进程持续写热 key，内存最坏会怎样？（提示：热页全分裂 → 峰值≈翻倍）

## 实验 3：亲手喂一次 OOM Killer 🐧

**目的**：完整读一遍 OOM 的"死亡记录"。⚠️ 只在 WSL2/虚拟机做。

```bash
# cgroup v2: 建一个 100MB 上限的组, 在里面跑吃内存的进程
sudo mkdir /sys/fs/cgroup/oomlab
echo $((100*1024*1024)) | sudo tee /sys/fs/cgroup/oomlab/memory.max
sudo sh -c 'echo $$ > /sys/fs/cgroup/oomlab/cgroup.procs; python3 -c "
a = []
while True: a.append(bytearray(10<<20))
"'
echo "退出码: $?"                       # 137 = 128+9 —— 被 SIGKILL
dmesg -T | grep -B2 -A15 'Killed process' | tail -25
cat /sys/fs/cgroup/oomlab/memory.events # oom_kill: 1
sudo rmdir /sys/fs/cgroup/oomlab
```

**预期观察**：dmesg 里有完整案卷——触发的 cgroup 路径、候选进程表（含各自 oom_score_adj 与 RSS）、死者及其 anon-rss。**逐行读懂它**：这是线上 137 排障的核心证据。

**思考题**：为什么 python 的 `a.append` 没有抛 MemoryError 而是整个进程被杀？（提示：overcommit——承诺时不拒绝，交割时才行刑）

## 实验 4：逃逸分析验证（06 章 §2.1）

```bash
cd <repo>/os/code
go build -gcflags='-m' ./03_memory/02_escape_analysis 2>&1 | grep -E 'escapes|moved'
go run ./03_memory/02_escape_analysis
```

**预期观察**：六种场景的判决书与 AllocsPerRun 实测一致：不逃逸 = 0 次/调用。

**思考题**：把 `escapeReturnPtr` 改成返回 `User` 值（非指针），-m 和分配数怎么变？什么时候"返回值拷贝"反而比"返回指针"快？（提示：小结构体拷贝 < 堆分配+GC 的代价）

## 实验 5：gctrace 逐字段读数（06 章 §5）

```bash
GODEBUG=gctrace=1 go run ./03_memory/03_gc_observe 2>&1 | grep '^gc ' | head -10
```

**预期观察**：对照 06 章 §5 的注解逐字段解读一行；观察阶段 2 里 GOGC=50 与 400 的 gc 行数差异；阶段 3 里设 GOMEMLIMIT 后 gc 变密。

**验收动作**：随便挑一行，向自己回答——这轮 STW 总共多久？存活堆多大？下次目标多大？GC 至今吃了百分之几 CPU？

## 实验 6：heap profile 双视角 + diff 定位泄漏（06 章 §9）

**目的**：跑通"两次采样 -base diff"的标准定位流程。

```bash
# 给 04_leak_patterns 临时加 pprof 端点(或用你自己的服务), 也可直接:
go run ./03_memory/04_leak_patterns   # 先看两种逻辑泄漏的堆数字
```
进阶（对长跑服务）：
```bash
curl -s localhost:6060/debug/pprof/heap > /tmp/h1
sleep 600
curl -s localhost:6060/debug/pprof/heap > /tmp/h2
go tool pprof -base /tmp/h1 -top /tmp/h2 | head -15   # 净增长栈排名
```

**思考题**：inuse_space 和 alloc_space 各回答什么问题？找泄漏用哪个？找 GC 压力用哪个？

## 实验 7：五板斧的 RSS 实测（06 章 §4）

```bash
go run ./03_memory/05_stream_backpressure
```

**预期观察**：ReadAll 版堆 +256MB vs 流式版 +0.x MB；CappedBuffer 面对 1GB 输出堆只 +1MB；有界队列峰值 ~9MB vs "无界" ~200MB。

**思考题**：CappedBuffer 为什么对写入方"永远报成功"？如果如实返回 short write 会发生什么？（提示：子进程收到 EPIPE/写失败可能崩溃或行为改变——我们要限的是自己的存储，不是它的行为）

---

## 验收清单

- [ ] 我能用"承诺/交割"讲清 VSZ、RSS、minor fault 三条曲线（实验 1 亲测过）
- [ ] 我读懂过一份完整的 dmesg OOM 案卷，能指出死者为什么是它
- [ ] 我能对任意代码预判逃逸并用 -m 验证，知道何时返回值优于返回指针
- [ ] 我能逐字段解读 gctrace，说出 GOGC/GOMEMLIMIT 各自的交易
- [ ] 我跑通过 -base diff 定位泄漏，分得清 inuse/alloc 双视角
- [ ] 五板斧我每一斧都有可运行的证据（实验 7）
