# 05 · 内存管理（OS 侧）：虚拟内存、Page Fault 与 OOM ⭐⭐⭐⭐

> 对应代码：[`../code/03_memory`](../code/03_memory)（01_vsz_rss）· 对应实验：[lab_03](../labs/lab_03_memory.md) 实验 1–3
>
> 本章回答：为什么内存持续增长？为什么容器被 OOM Kill？RSS 和 VSZ 到底啥区别？malloc 会失败吗？——先把 OS 的账本看懂，第 06 章再看 Go 在上面记的账。

## 1. 本章目标

- 说清虚拟内存解决的四个问题，能画出地址翻译的完整路径（页表 walk + TLB）；
- 区分三类 Page Fault（minor/major/invalid），知道各自的成本与含义；
- 掌握 mmap、COW、Swap、Overcommit、OOM Killer 的机制与相互关系；
- 能读懂 `free`、`/proc/<pid>/status`、`dmesg` OOM 记录、cgroup `memory.stat`；
- 建立"承诺的内存 vs 实际占用的内存"这对核心区分。

## 2. 核心概念

### 2.1 虚拟内存：一人一本假账，内核统一做真账

如果进程直接用物理地址，四个灾难立刻发生：互相踩内存（无隔离）、程序必须知道自己会被装到哪（无重定位）、内存用完就真的完了（无超量）、共享一段代码要复杂协商（无共享）。虚拟内存（virtual memory）一次解决四个：

**每个进程都以为自己独占一条平坦的地址空间**（64 位下用户态可用 128TB 量级），内核维护"虚拟地址 → 物理页"的映射表（页表），CPU 里的 MMU 在每次访存时自动翻译。于是：

| 能力 | 机制 |
|---|---|
| 隔离 | 各进程页表不同，你的地址 0x1000 和我的 0x1000 落在不同物理页；越权访问 = 页表里没映射 → 段错误 |
| 超量使用 | 虚拟空间可以远大于物理内存：没用到的不给真页，冷页可换出（Swap） |
| 共享 | 两个进程的页表指向同一物理页：共享库 libc 全系统一份、fork 的 COW |
| 连续假象 | 虚拟上连续的一段，物理上可以东一页西一页——碎片问题被翻译层吸收 |

回看实验 3 的 `/proc/self/maps`：每一行就是一个 **VMA（virtual memory area）**——内核用 VMA 链/树描述"这个地址区间是什么"（代码段/堆/栈/某文件的映射/匿名内存），页表则记录"具体到页映到哪"。两层记账：**VMA 是合同，页表是交割单**。

### 2.2 页、页表、TLB：翻译的三件套

- **页（page）**：映射的最小单位，x86-64 默认 **4KB**。物理侧对应叫页帧（page frame）。
- **多级页表**：64 位地址如果用一张平表，每进程要 GB 级页表——所以拆成 4 级（PGD→PUD→PMD→PTE，各 9 位索引，Linux 5.x 支持 5 级）。**多级的省钱原理：没用到的区间整棵子树不分配**。虚拟地址翻译 = 逐级查表走 4 步（"page walk"）。
- **TLB（Translation Lookaside Buffer）**：page walk 要 4 次访存，每次访存都走一遍谁受得了——CPU 把最近的翻译结果缓存在 TLB（几百~几千条）。TLB 命中 ~1ns 内；miss 则硬件自动 walk，几十~上百 ns。**TLB 是"进程切换贵"的重要一环**：切页表（换 CR3）会使 TLB 大面积失效（有 PCID 缓解）。
- **大页（huge page）**：2MB/1GB 一页，一条 TLB 条目覆盖 512 倍地址范围，数据库/DPDK 标配；Linux 的透明大页（THP）自动合并，⚠️ 但对延迟敏感服务可能引发抖动（合并/拆分的后台开销），很多数据库文档让你关它。

### 2.3 Page Fault：不是错误，是机制

访存时页表里没有有效映射 → CPU 抛缺页异常（page fault，第 01 章"三扇门"的异常门）→ 内核接管。三种结局：

| 类型 | 场景 | 成本 | 谁在用它 |
|---|---|---|---|
| **minor fault** | 物理页其实已在内存，只是没建映射 | ~μs 级 | demand paging（首次访问才真分配）、COW 写分裂、共享库已被别人载入 |
| **major fault** | 数据在磁盘，要真 I/O | ~ms 级（HDD）/ ~百 μs（SSD） | Swap 换入、文件映射页首次从盘读 |
| **invalid** | 地址根本不合法 | — | 野指针 → 内核发 SIGSEGV，进程默认死 |

**demand paging 把"分配"变成"承诺"**：`make([]byte, 1<<30)`（或 mmap 1GB）瞬间返回——内核只登记了 VMA（合同），一页物理内存都没给；你逐页写入时，每页触发一次 minor fault 才真正交割。这就是示例 [01_vsz_rss](../code/03_memory/01_vsz_rss/main.go) 里 **VSZ 先涨、RSS 后涨**的机制。监控里 major fault 突增是"内存吃紧开始换页/重读文件"的红色信号（`sar -B`、`ps -o maj_flt`）。

### 2.4 堆、栈与两条分配通道

进程地址空间里：栈由内核自动增长（有上限 `ulimit -s`）；堆的伸缩靠两个 syscall——
- **brk/sbrk**：推高"堆顶"指针，适合小块连续增长；
- **mmap 匿名映射**：单独开一块 VMA，适合大块（glibc malloc 默认 ≥128KB 走 mmap），free 时可整块归还。

⚠️ Go 不用 brk：runtime 直接 mmap 一块块 arena（64MB 粒度）自己管理（第 06 章）。所以 Go 进程的 heap 在 maps 里是一堆匿名映射段，不是 `[heap]`。

### 2.5 mmap 的四张面孔

`mmap(addr, len, prot, flags, fd, off)` 是内存管理的瑞士军刀：

1. **匿名私有**（`MAP_ANONYMOUS|MAP_PRIVATE`）：就是"要内存"——malloc 大块、Go arena、线程栈全是它；
2. **文件私有**（`MAP_PRIVATE` + fd）：加载可执行文件/动态库（第 01 章 ELF LOAD 段）；写时 COW，不回写文件；
3. **文件共享**（`MAP_SHARED` + fd）：内存映射文件——读写内存 = 读写文件（经 Page Cache），多进程可共享；数据库（如 SQLite/LMDB）和 mmap 读大文件的场景；
4. **匿名共享**：父子进程共享内存 IPC（还有 POSIX shm/System V shm 一族）。

mmap 读文件 vs read 读文件的取舍（面试常问）：mmap 省一次内核→用户拷贝、随机访问友好；但缺页是隐式 I/O（延迟不可控、错误变成 SIGBUS 而非 error 返回值）、映射建立/销毁本身有成本。顺序流式读，老实用 read/bufio 更好（第 07 章 Page Cache 会补全这张图）。

### 2.6 COW 补全（衔接第 02 章 fork）

fork 时父子共享全部物理页、页表项标只读；任一方写 → minor fault → 内核复制该页、两边页表各指各的、恢复可写。**代价转移**：fork 本身毫秒级，但 fork 后的首轮写会付一波 minor fault + 复制。经典事故（Redis bgsave）：fork 出子进程做快照，父进程继续写 → 热页疯狂 COW 分裂 → 内存峰值最多翻倍 + 写延迟毛刺。

### 2.7 Swap 与 Overcommit：承诺经济学

- **Swap**：物理内存吃紧时，内核把冷的**匿名页**（堆/栈——没有文件后盾的页）写到 swap 区腾地方；**文件页**不用写 swap（脏页回写文件、干净页直接丢，要用再从文件读）。`swappiness`（0–200，默认 60）调"偏好回收哪边"。⚠️ K8s 传统上默认禁 swap：调度器按内存额度做承诺，swap 让"内存不足"变成"变慢"，故障从可见变隐蔽。
- **Overcommit（过量承诺）**：Linux 默认（`vm.overcommit_memory=0`，启发式）允许所有进程的"承诺总量"超过物理内存+swap——赌大家不会同时兑现。**所以 Linux 下 malloc/make 几乎永不返回失败**——失败被推迟到"真正写入却无页可给"的时刻，此时无法返回错误码，只能行刑：**OOM Killer**。

### 2.8 OOM Killer：死刑的挑选逻辑

内存真枯竭（或 cgroup 到顶）时，内核给每个候选进程算 `oom_score`（≈ 内存占用占比 + 调整值 `oom_score_adj`，范围 -1000 全豁免 ~ +1000 优先死），**杀分数最高的**——通常就是最大的进程，未必是漏内存的那个（冤案高发）。两个层级：
- **全局 OOM**：整机枯竭，`dmesg` 出现 `Out of memory: Killed process 1234 (java) total-vm:..., anon-rss:...`；
- **cgroup OOM**（容器里的常态）：该 cgroup 内存到 `memory.max`，只在组内挑人杀，宿主机毫发无伤；K8s 里表现为容器重启 + `OOMKilled` + exit code 137（第 02 章退出码闭环）。

⚠️ 容器内存计账的著名陷阱：**cgroup 把进程引发的 Page Cache 也记账**（memory.current ≈ anon + file + kernel）。狂读写文件的服务，"内存用量"会被文件缓存顶到 limit——好消息是内核在到顶前会先回收可回收的 file 页；坏消息是回收不及/不可回收时照样 OOM。给容器设 limit 要留出 page cache 的呼吸空间，监控要看 `memory.stat` 里的 anon（真身）而不是笼统的 usage。

### 2.9 RSS、VSZ 与内存碎片

| 指标 | 含义 | 用途 |
|---|---|---|
| VSZ（virtual size） | 承诺总量：所有 VMA 之和 | ⚠️ 几乎没有报警价值（demand paging 下虚高是常态） |
| RSS（resident set size） | 实际驻留物理内存（含共享库摊到你头上的整份） | 看真实占用的主指标 |
| PSS | 共享页按共享者均摊后的 RSS | 多进程共享大时更公平（`smaps_rollup`） |

**碎片**两种：外碎片（空闲总量够但不连续——伙伴系统 buddy allocator 按 2^n 页块管理来对抗；`/proc/buddyinfo` 可见高阶块存量）；内碎片（分配粒度浪费——slab 分配器按对象大小分桶来对抗）。用户态同理：Go 的 size class 就是内碎片的用户态解法（第 06 章）。

## 3. 底层原理：一次访存的完整旅程

```text
mov rax, [0x7f8a12345678]           # 用户态一条普通读指令
   │
   ▼ MMU: 查 TLB ── 命中(≈99%) ──────────────→ 物理地址 → L1/L2/L3 → 内存
   │            └─ miss → 硬件 page walk: PGD→PUD→PMD→PTE (4 次访存)
   │                        │
   │                        ├─ PTE 有效 → 填 TLB → 重执行, 完成
   │                        └─ PTE 无效/权限不符 → Page Fault 异常, 陷入内核:
   │                              ├─ VMA 合法+页在内存(COW/共享) → minor: 建映射/复制页
   │                              ├─ VMA 合法+页在盘(swap/文件)  → major: 调 I/O 读入
   │                              └─ 无 VMA / 权限违规          → SIGSEGV
   ▼
恢复用户态, 重新执行这条指令(它自己毫不知情)
```

OOM 链路补全：`make/mmap 只登记 VMA(承诺) → 首写 minor fault 要真页 → 空闲不足 → 回收(丢干净文件页/回写脏页/换出匿名页) → 还不够 → OOM Killer 挑 oom_score 最高者 SIGKILL`。

## 4. Go 语言示例

[`01_vsz_rss`](../code/03_memory/01_vsz_rss/main.go)：mmap 1GB 匿名内存，对照 `/proc/self/status` 的 VmSize/VmRSS——申请后 VSZ +1GB 而 RSS 不动；逐页写入时 RSS 阶梯上涨；`MADV_DONTNEED` 归还后 RSS 回落。把 2.3/2.7 的"承诺 vs 交割"变成肉眼可见的数字。

## 5. 后端开发中的应用

- **`free -h` 的正确读法**：`free` 少不代表内存紧张——Linux 把闲内存尽量拿去做 Page Cache（`buff/cache` 列），真正的可用性看 **`available`**（≈ free + 可轻松回收的 cache）。"内存怎么快用完了"的工单，八成是没看 available。
- **监控三原则**：报警用 RSS/工作集（K8s working_set = usage - inactive_file）不用 VSZ；容器看 memory.stat 的 anon 与 file 分开看；major fault 速率单独报警（换页/抖动前兆）。
- **fork 型工具的内存预算**：大 RSS 进程 fork（哪怕立刻 exec）要拷页表 + 瞬时承诺翻倍，overcommit 严格模式（=2）下会直接 ENOMEM。Go 的 exec 走 fork+exec，Agent 进程自身 RSS 越大，起子进程的固定成本越高——保持 Runner 进程苗条不只是美德，是性能。

## 6. Agent 开发中的应用

- **任务内存预算的层次**：进程内限制（第 06 章 GOMEMLIMIT/输出上限）挡"自己人失控"，cgroup memory.max（第 11 章）挡"不可信代码失控"——前者是软柔道，后者是硬墙，Sandbox 两层都要。
- **“把文件全读进内存”是 Agent 的默认错误姿势**：用户上传 2GB 日志让工具分析，`os.ReadFile` = RSS +2GB = 容器 OOM。正确：流式分块（第 06 章五板斧）；确需随机访问再考虑 mmap（且记住 cgroup 会把它计入 file 页）。
- **OOM 后的验尸流程要预先设计**：容器死于 137 时，你需要 dmesg/memory.events 的证据链——在镜像里留好 `cat /sys/fs/cgroup/memory.stat` 的采集脚本，别等出事再想怎么取证。

## 7. 常见问题与错误设计

**错误 1：用 VSZ 报警/找泄漏。** Go 程序 VSZ 轻松几十 GB（arena 预留），毫无意义；看 RSS 和 heap profile。

**错误 2：`if buf := malloc(...); buf == nil` 式安全感。** overcommit 下分配成功 ≠ 内存存在；真正的失败发生在写入时且不可捕获（OOM Kill）。防御要靠**预算与限额**（GOMEMLIMIT/cgroup），不是检查返回值。

**错误 3：容器 limit = 压测峰值 RSS。** 没给 page cache、临时突发、GC 目标留余量 → 稳态贴线跑，任何抖动即 137。经验：limit ≥ 稳态 anon 的 1.5–2 倍起步，再按 memory.stat 观测收敛。

**错误 4：疯狂读写文件的服务对"内存用量"报警。** cgroup usage 含 file 页，虚警不断。改盯 anon / working set。

## 8. 排障方法

**案例：容器被 OOM Kill（exit 137）。**
- **现象**：Pod 重启，`kubectl describe` 显示 OOMKilled；节点 `dmesg -T` 有 `Memory cgroup out of memory: Killed process ...`。
- **原因链**：anon 持续增长（真泄漏/负载升）或 file 页顶满且不可回收（脏页风暴）或 limit 本来就没余量。
- **验证**：
  ```bash
  dmesg -T | grep -A20 'Killed process'   # 看死者 RSS、cgroup 路径、当时各项计数
  cat /sys/fs/cgroup/<path>/memory.stat | egrep 'anon|file|slab'  # anon 大→进程真占; file 大→缓存计账
  cat /sys/fs/cgroup/<path>/memory.events # oom_kill 次数, high/max 触发史
  ```
  区分三种病：anon 单调涨 = 应用泄漏（转第 06 章 heap profile）；file 大 = IO 型计账（调 limit/写盘节奏）；瞬时尖峰 = 突发分配（fork/大请求，看 events 里 max 命中时刻）。
- **解决**：对症后：修泄漏 / 设 GOMEMLIMIT 让 GC 提前发力 / 调 limit 留余量 / 大文件改流式。回归验证：memory.events 的 oom_kill 不再增长。

## 9. 实验任务

[lab_03_memory.md](../labs/lab_03_memory.md) 实验 1–3：① VSZ/RSS/承诺与交割实测；② COW 观察（fork 后写页看 minor fault 计数）；③ 在小内存 cgroup 里触发 OOM，完整读一遍 dmesg 记录。

## 10. 面试题（附答题要点）

**Q1：为什么需要虚拟内存？**
要点：四件套——隔离、重定位、超量（demand paging + swap）、共享（库/COW）。加分：两层记账（VMA 合同 / 页表交割单）；MMU 硬件翻译 + 内核填表的分工。

**Q2：页表为什么是多级的？**
要点：平表按 64 位空间算每进程页表本身就 GB 级；多级让"没映射的区间整棵子树不存在"，稀疏地址空间下省几个数量级。代价：walk 变 4 次访存——引出 TLB。加分：大页减少条目/THP 的抖动争议。

**Q3：minor 和 major page fault 的区别？**
要点：minor 不碰盘（建映射/COW/共享命中，μs 级），major 要 I/O（swap in/文件首读，ms 级）。运维含义：major 速率飙升 = 内存压力/抖动前兆。加分：demand paging 使"分配"只是承诺，首写才交割——正是 VSZ/RSS 差异的来源。

**Q4：Linux 的 malloc 会返回 NULL 吗？OOM Killer 怎么选人？**
要点：overcommit 默认开，分配几乎总成功，失败推迟到写入时无页可给 → OOM Killer。选人按 oom_score（≈占用占比 + oom_score_adj 修正），杀最大不杀最漏（冤案常态）。加分：全局 OOM vs cgroup OOM；K8s QoS 通过 oom_score_adj 排 pod 处刑顺序；137=128+9 闭环。

**Q5：RSS 和 VSZ 的区别？监控该看哪个？**
要点：VSZ=承诺（VMA 总和），RSS=驻留物理页；demand paging 下 VSZ 天然虚高，报警无价值。看 RSS/working set，多进程共享大用 PSS。加分：cgroup usage 还含 file 页，容器监控要拆 memory.stat。

**Q6：fork 一个 10GB 的进程会发生什么？**
要点：COW——秒回，只拷页表（10GB ≈ 20MB 页表）+ 全部页标只读；后续双方写才逐页分裂。两个真实成本：页表拷贝、承诺翻倍（严格 overcommit 下直接 ENOMEM；Redis bgsave 峰值翻倍案例）。

**Q7：Swap 是好是坏？容器为什么常禁用？**
要点：机制——匿名页的磁盘后备，文件页天然有后备不走 swap。价值：顶住瞬时峰值、换出真冷页。容器禁它：资源承诺模型要求"超限即死"的确定性，swap 把故障变成隐性变慢，打破调度假设。加分：swappiness 语义；K8s 新版本对 swap 的有限支持是权衡的松动。

## 11. 本章总结

- 虚拟内存 = 每进程一本假账 + MMU/页表翻译 + 缺页异常按需交割；VMA 是合同、页表是交割单、TLB 是翻译缓存。
- Page Fault 是机制不是错误：minor 廉价（demand paging/COW），major 是 I/O（抖动信号），invalid 才是 bug。
- Linux 玩承诺经济：overcommit 让分配永不拒绝，代价是违约时刻的 OOM Killer——防御靠限额不靠返回值。
- 看内存的正确姿势：RSS/anon/working set 是真身，VSZ 是幻影，free 的 available 才是余粮，容器计账含 page cache。

**检查清单**：
- [ ] 我能画出 TLB→walk→fault 的访存全路径，并给三类 fault 各举一例
- [ ] 我能用"承诺 vs 交割"解释 VSZ/RSS 曲线（并亲手跑过 01_vsz_rss）
- [ ] 我能读懂 dmesg 的 OOM 记录和 memory.stat 的 anon/file 拆分
- [ ] 我能说出 fork 大进程的两个真实成本和 Redis bgsave 案例
- [ ] 我知道容器 limit 为什么要留余量、监控为什么不盯 usage 总数

## 12. 延伸阅读

- CSAPP 第 9 章（虚拟内存）——地址翻译讲得最清楚的教材
- 《The Linux Programming Interface》第 49 章（mmap）
- LWN: *Overcommit and OOM*；kernel 文档 `Documentation/admin-guide/mm/`
- Brendan Gregg: *Memory* 章节（《Systems Performance》2nd）
- 下一章 [06 Go 内存与 GC](06_go_memory_and_gc.md)——同一块内存的 Go runtime 账本
