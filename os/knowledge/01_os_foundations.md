# 01 · 操作系统基础：从可执行文件到运行中的进程 ⭐⭐

> 对应代码：[`../code/01_process`](../code/01_process)（01_basic_exec）· 对应实验：[lab_01](../labs/lab_01_process.md) 实验 1–3
>
> 本章回答四个问题：为什么应用程序不能直接操作硬件？用户态切换到内核态的成本是什么？系统调用和普通函数调用有什么区别？一个可执行文件是如何变成运行中的进程的？

## 1. 本章目标

- 能画出"应用程序 → 标准库 → 系统调用 → 内核 → 硬件"的完整分层，并说清每层存在的理由；
- 能区分中断（interrupt）、异常（exception）、系统调用（system call）三种进入内核的方式；
- 能描述 `./app` 敲下回车后，从 ELF 文件到 Go `main` 函数执行的完整链路；
- 会用 `strace` 观察一个程序的系统调用，并能解读常见调用的用途。

## 2. 核心概念

### 2.1 操作系统的职责：一个"资源公司"的运营方

把一台机器看成一栋写字楼，操作系统就是物业+行政+安保的集合体，它只做两类事：

1. **资源管理（Resource Management）**：CPU 时间、内存、磁盘、网络设备都是稀缺资源，OS 负责分配、回收、记账。对应机制：调度器管 CPU、虚拟内存管内存、文件系统管磁盘、协议栈+驱动管网卡。
2. **抽象与隔离（Abstraction & Isolation）**：把"磁盘扇区"抽象成"文件"，把"网卡收发包"抽象成"socket"，把"物理内存地址"抽象成"每个进程独占的地址空间"。抽象让应用不用关心硬件差异；隔离让一个进程崩溃、越界不会带垮别人。

**具体场景**：你的 Go 服务里一行 `os.WriteFile("a.log", data, 0644)`，背后是 OS 在做：权限检查（你有没有资格写）→ 文件系统定位（写到磁盘哪些块）→ Page Cache 缓冲（先写内存稍后刷盘）→ 磁盘驱动排队（转成设备命令）。应用只看到"一个文件"，这就是抽象的价值。

### 2.2 用户态与内核态：两套权限的世界

- **内核态（kernel mode）**：CPU 处于最高特权级（x86-64 叫 Ring 0，ARM64 叫 EL1），可以执行特权指令——修改页表、开关中断、访问任意物理内存、操作设备寄存器。
- **用户态（user mode）**：最低特权级（Ring 3 / EL0），只能执行普通运算指令，访问自己被分配的虚拟地址。碰特权指令或未映射地址，CPU 直接抛异常。

**为什么应用程序不能直接操作硬件？** 三个理由，缺一不可：

| 理由 | 反例：如果允许直接碰硬件会怎样 |
|---|---|
| **安全**：硬件层没有"权限"概念 | 任何进程可以直接读磁盘上别人的文件、嗅探网卡上所有流量 |
| **稳定**：设备操作需要严格时序 | 一个写错的驱动式操作能让磁盘控制器挂死，整机跟着挂 |
| **复用**：设备同一时刻只有一份 | 两个进程同时给网卡下发送命令，数据包互相踩踏 |

所以硬件访问被收口到内核——应用想碰硬件，必须"填申请单"（系统调用），由内核代为执行。这个收口不是软件约定，而是 **CPU 硬件特权级强制的**：用户态执行 `out`（写设备端口）这类指令，CPU 直接产生 #GP 异常，进程收到 SIGSEGV。

### 2.3 内核、Shell、系统调用的关系

初学者常把三者混为一谈，实际是三层：

```text
你敲的命令:  ls -l
             │
   ┌─────────▼──────────┐
   │ Shell (bash/zsh)   │  ← 只是一个普通的【用户态进程】，
   │ 解析命令行 → fork + │     它自己也靠系统调用干活，
   │ exec 启动 ls 进程   │     没有任何特权
   └─────────┬──────────┘
             │ execve("/usr/bin/ls", ...)   ← 系统调用：用户态进入内核的【唯一正门】
   ┌─────────▼──────────┐
   │ 内核 (kernel)       │  ← 常驻内存的特权代码：调度、内存、VFS、网络栈、驱动
   └─────────┬──────────┘
   ┌─────────▼──────────┐
   │ 硬件                │
   └────────────────────┘
```

⚠️ 常见误解：**Shell 不是操作系统的一部分**，它和你的 Go 程序地位完全相同，都是用户态进程。"Agent 调用 Shell 执行命令"本质上是：你的 Go 进程 fork 出一个 bash 进程，bash 再 fork 出实际命令的进程——这条链在第 02 章会变成重点（杀进程树问题的根源就在这）。

### 2.4 进入内核的三扇门：中断、异常、系统调用

内核代码不会"自己跑起来"，它总是被三类事件之一**驱动**：

| | 中断 (Interrupt) | 异常 (Exception) | 系统调用 (Syscall) |
|---|---|---|---|
| 触发源 | 外部硬件（网卡收到包、时钟滴答、磁盘完成） | 当前指令出错或特殊情况（除零、缺页、非法指令） | 程序主动请求（`syscall` 指令） |
| 与当前指令的关系 | **异步**——和正在执行的代码无关 | **同步**——由当前这条指令引发 | **同步**——程序自己发起 |
| 典型例子 | 时钟中断驱动调度器抢占 | Page Fault 触发按需调页 | read/write/fork |
| 处理后 | 回到被打断的指令继续 | 修复后重执行该指令（如缺页），或杀进程（如段错误） | 返回下一条指令，带返回值 |

**一个 Go 服务一秒内三扇门都在开**：时钟中断打断某个 goroutine 所在线程（抢占的底层支撑）；新分配的大 slice 首次写入触发 Page Fault（内核这才真正分配物理页）；每次日志落盘是一次 `write` 系统调用。

### 2.5 四大硬件如何被管理（本模块后续章节的索引）

| 硬件 | OS 抽象 | 核心机制 | 详见 |
|---|---|---|---|
| CPU | 进程/线程 | 调度器、上下文切换、时间片 | 02、03 章 |
| 内存 | 虚拟地址空间 | 页表、Page Fault、Page Cache | 05、06 章 |
| 磁盘 | 文件 | VFS、inode、Page Cache、块层调度 | 07 章 |
| 网卡 | socket | 协议栈、中断+NAPI、epoll | 08 章 |

## 3. 底层原理

### 3.1 系统调用的完整路径（以 x86-64 Linux 为例）

以 Go 程序里一次 `write(fd, buf, n)` 为例，完整链路：

```text
用户态                                    内核态
──────────────────────────────────────────────────────────────
os.File.Write(buf)
  └→ runtime/internal syscall 封装:
     寄存器约定装参:
       rax = 1   (write 的系统调用号)
       rdi = fd, rsi = &buf, rdx = n
     执行 syscall 指令  ────────────────→  CPU 切换到 Ring 0:
                                          1. 从 MSR 寄存器取内核入口地址
                                          2. 切换到该线程的【内核栈】
                                          3. 保存用户态寄存器现场 (pt_regs)
                                          4. entry_SYSCALL_64 → 查系统调用表
                                             sys_call_table[1] = ksys_write
                                          5. 执行内核逻辑: 权限检查 → VFS
                                             → Page Cache 拷贝
                                          6. 返回值放 rax
     rax 里拿到返回值   ←────────────────  sysret 指令切回 Ring 3
     n 或 -errno
  └→ 若为负数, Go 封装成 error (syscall.Errno)
```

几个值得记住的细节：

- **系统调用号是内核的"API 编号"**，x86-64 上 write=1、open(实际是 openat)=257、fork(实际走 clone)=57/56。`man 2 syscalls` 可查全表。
- **参数走寄存器不走栈**：最多 6 个参数（rdi/rsi/rdx/r10/r8/r9），这是内核 ABI 约定。
- **错误码约定**：内核返回 `-errno`（如 -2 = ENOENT），libc/Go runtime 把它翻译成 `errno`/`error`。所以 Go 里 `err == syscall.ENOENT` 能直接比较。
- **每个线程有两个栈**：用户栈 + 内核栈（Linux 默认 16KB）。进内核必须换栈——不能信任用户栈（可能被恶意构造）。

### 3.2 用户态 ↔ 内核态切换的真实成本

"切换很贵"到底贵在哪？分三层拆开（数量级参考 x86-64，具体随硬件/内核版本浮动）：

1. **直接成本（~50–100+ ns）**：`syscall`/`sysret` 指令本身的特权级切换、换栈、保存/恢复寄存器。纯往返（如 `getpid` 这种空跑）大约百纳秒量级；作为对比，普通函数调用 ~1 ns。**差距约两个数量级。**
2. **间接成本（常被忽略，往往更大）**：进入内核后跑的是另一片代码和数据 → 你的 L1/L2 缓存、TLB 被内核代码"污染"，返回用户态后一段时间内缓存命中率下降。频繁 syscall 的程序，用户态代码也会变慢。
3. **安全缓解成本（2018 后新增）**：Meltdown/Spectre 漏洞的缓解措施（如 KPTI，内核页表隔离）让每次切换额外刷 TLB，最坏情况让 syscall 成本翻倍。⚠️ 版本背景：是否开启取决于 CPU 代次与内核配置，`cat /sys/devices/system/cpu/vulnerabilities/*` 可查。

**工程推论**（第 09 章展开）：
- 大量 4 字节的小 `write` 是灾难 → 所以有 `bufio.Writer`（攒批）、`writev`（一次提交多段）；
- `gettimeofday`/`clock_gettime` 这类高频只读调用，内核用 **vDSO**（virtual dynamic shared object）把实现映射进用户态，让它们**根本不进内核**——这就是 Go 的 `time.Now()` 每秒能调几千万次的原因。

### 3.3 系统调用 vs 普通函数调用（面试高频）

| 维度 | 普通函数调用 | 系统调用 |
|---|---|---|
| 指令 | `call`（同特权级跳转） | `syscall`（特权级切换） |
| 栈 | 同一个用户栈 | 切换到内核栈 |
| 地址空间 | 不变 | 不变（同一页表），但可访问范围变了 |
| 成本 | ~1 ns | ~100 ns 起 + 缓存污染 |
| 失败模式 | 不存在"权限拒绝" | 内核校验一切参数，可能返回 errno |
| 谁提供 | 你的代码/库 | 内核 ABI，跨语言统一 |

⚠️ 容易答错的点：系统调用**不发生进程切换**、通常也**不切页表**（KPTI 开启时切一半），切换的是**特权级和栈**。"系统调用会导致上下文切换"这句话在面试里要说精确：它可能*引发*调度（如 read 阻塞时让出 CPU），但 syscall 本身 ≠ 进程上下文切换。

### 3.4 从 ELF 文件到运行中的进程

`./app` 回车后发生的事，分五步：

**① Shell fork + execve**。bash 先 `fork()` 出子进程，子进程调用 `execve("./app", argv, envp)`——这是"变身"调用：进程壳（PID、fd 表）不变，内存映像整个换掉。

**② 内核解析 ELF**。ELF（Executable and Linkable Format）文件开头 64 字节是 ELF Header（魔数 `\x7fELF`、架构、入口地址 e_entry），随后的 **Program Headers** 告诉内核"哪些段（segment）要映射到内存哪里"：

```text
$ readelf -l app        # 典型 Go 静态二进制
Type   Offset    VirtAddr   FileSiz   Flags
LOAD   0x000000  0x400000   0x8a000   R E   ← 代码段: 只读+可执行
LOAD   0x08a000  0x48a000   0x9b000   R     ← 只读数据(常量/字符串)
LOAD   0x125000  0x525000   0x1c000   RW    ← 数据段: 全局变量
```

内核按这些描述调用 `mmap` 建立映射——⚠️ **此时并不真正读文件内容进内存**，只登记"这段地址对应文件这个区间"，等第一次执行/访问时靠 Page Fault 按需加载（demand paging，第 05 章）。

**③ 动态链接（C 程序）或跳过（Go 默认）**。动态链接的 C 程序，ELF 里记录着解释器 `/lib64/ld-linux-x86-64.so.2`，内核先把控制权交给这个动态链接器，由它加载 `libc.so` 等依赖、做符号重定位，再跳到程序入口。**Go 默认静态链接**（不依赖 CGO 时）：runtime 全部打进二进制，没有这一步。工程影响：Go 二进制拷进 `FROM scratch` 空容器就能跑，C 程序会报 `no such file or directory`（缺 ld.so——这个报错极具迷惑性，文件明明在）。

**④ 建立初始栈**。内核在栈顶摆好 argc、argv、envp 和 auxv（辅助向量，告诉程序页大小、vDSO 地址等），设置指令指针 = 入口地址，返回用户态。

**⑤ Go runtime 启动**。入口不是你的 `main`，而是汇编的 `_rt0_amd64_linux` → `runtime.rt0_go`，它依次：初始化 g0/m0（第 03 章）、内存分配器、调度器（`schedinit`，读 GOMAXPROCS）、启动 GC 相关后台任务，然后创建**第一个用户 goroutine** 去跑 `runtime.main`——它先执行所有包的 `init()`，最后才调用你的 `main.main()`。所以哪怕一行代码的 Go 程序，strace 也能看到几十次 mmap（分配堆区）和 clone（起后台线程）。

## 4. 关键执行流程（汇总图）

```text
 bash                     内核                          新进程(用户态)
──────                  ────────                      ──────────────
fork() ───────────────→ 复制出子进程(COW)
                        (第02章详解)
child: execve("./app")─→ 校验权限/格式
                         解析 ELF Program Headers
                         mmap 代码段/数据段(仅登记)
                         mmap 栈、vDSO
                         摆好 argc/argv/envp/auxv
                         设置入口 e_entry
                        ←返回用户态───────────────────  _rt0_amd64_linux
                                                       runtime: g0/m0/堆/调度器
                        ←首次执行代码页触发 Page Fault─  (透明发生多次)
                         从文件读入该页, 建页表项 →
                                                       runtime.main → init() → main.main()
```

## 5. Go 语言示例

完整代码见 [`code/01_process/01_basic_exec`](../../os/code/01_process/01_basic_exec/main.go)（本章先用它观察自身进程信息；启动子进程的完整讲解在第 02 章）。核心片段：

```go
// 观察: 哪些操作是纯用户态, 哪些要进内核
pid := os.Getpid()        // 进内核? 看似要, 但 Go 缓存了结果/走 vDSO 类优化路径
                          // ⚠️ 用 strace 验证, 不要想当然
var st syscall.Stat_t
_ = syscall.Stat("/etc/hosts", &st) // 一定进内核: 要查 VFS + inode(第07章)

buf := make([]byte, 1<<20) // 通常不触发 syscall: Go 从自己的堆内存池里切
                           // 池不够时 runtime 才 mmap 向内核要一大块(第06章)
_ = buf
os.Stdout.Write([]byte("x")) // 一定进内核: write(1, "x", 1)
```

配套观察命令（实验详情见 lab_01）：

```bash
go build -o hello ./01_process/01_basic_exec
strace -c ./hello            # -c 统计: 看 syscall 种类和次数
strace -e trace=write ./hello # 只看 write
readelf -h hello && readelf -l hello | head -30
cat /proc/self/maps          # 看一个进程的地址空间布局
```

## 6. 后端开发中的应用

- **缓冲是对抗 syscall 成本的第一手段**：`bufio.Writer` 默认 4KB 攒批，日志库（zap/zerolog）内部都有缓冲。裸 `fmt.Fprintf(os.Stdout, ...)` 每条日志一次 write，QPS 高时 syscall 开销能吃掉两位数百分比的 CPU（第 09 章有量化实验）。
- **静态链接是 Go 部署简单的根源**：`CGO_ENABLED=0 go build` 产出的二进制不依赖任何 .so，`scratch`/`distroless` 镜像直接跑。反过来，开了 CGO 的程序在 alpine（musl libc）上会遇到 glibc 兼容性问题——理解 3.4 节的动态链接过程就知道错在哪层。
- **理解"进内核的频率"是性能直觉的地基**：同样是"读文件"，`os.ReadFile` 一次性读完（少量大 read）与逐行 `Scanner`（bufio 兜底，实际也是大块 read）都没问题；自己写 `f.Read(make([]byte, 16))` 的循环就是性能事故。

## 7. Agent 开发中的应用

- **Agent 执行工具 = 完整复刻 3.4 节链路**：Agent 调用 `bash -c "python analyze.py"`，是 Go 进程 fork+exec bash，bash 再 fork+exec python——三级进程树。第 02 章讲怎么管住这棵树。
- **Sandbox 拦截的正是"进内核的门"**：seccomp（第 11 章）本质是给系统调用装白名单——恶意代码再怎么混淆，想干坏事（开文件、连网络、起进程）最终都要过 syscall 这道门，把门守住就守住了一切。这就是为什么理解 syscall 层是做 Sandbox 的前提。
- **容器里跑工具的兼容性判断**：工具是静态还是动态链接（`ldd` 一眼看穿），决定了你的 Sandbox 基础镜像要不要带 glibc、要挂哪些库目录。

## 8. 常见问题与错误设计

**错误 1：把"调用了库函数"当成"没有 syscall"。**

```go
// 错误认知: "我只是调了 fmt.Println, 没碰系统调用"
for _, item := range items {          // items 有 10 万条
    fmt.Println(item)                 // ⚠️ 每次一个 write syscall, 10 万次进内核
}
// 正确: 攒批
w := bufio.NewWriter(os.Stdout)
defer w.Flush()                       // 别忘了兜底 Flush
for _, item := range items {
    fmt.Fprintln(w, item)             // 写进用户态缓冲, 4KB 才进一次内核
}
```

为什么正确：把 10 万次特权级切换压缩成 ~几百次，缓存污染也同步减少。

**错误 2：容器里"文件明明存在却 no such file"。** 动态链接的二进制在缺 glibc 的镜像里，报错的是"找不到解释器 ld.so"，不是找不到你的程序。排查：`file app` 看 `dynamically linked` 还是 `statically linked`。

**错误 3：以为"用户态崩溃会影响内核"。** 段错误（SIGSEGV）是 CPU 异常 → 内核处理 → 默认杀掉该进程，内核和其他进程安然无恙。这正是特权级隔离的意义；反过来内核 panic 才是全机死亡。

## 9. 排障方法

**案例：日志刷屏拖慢服务。**

- **现象**：压测时 QPS 上不去，CPU 高但业务逻辑简单；`top` 看该进程 CPU 里 **sy（内核态）占比异常高**（如 us 30% / sy 40%）。
- **原因假设**：某个高频路径在做大量小 syscall——最常见就是每请求多条无缓冲日志。
- **验证**：
  ```bash
  strace -c -f -p <pid>   # 挂上 10 秒, 看 calls 列: write 次数是不是爆炸
  # 进一步: strace -e trace=write -p <pid> 看每次 write 的长度是不是几十字节
  ```
  ⚠️ strace 本身让目标变慢数倍（每个 syscall 都被 ptrace 拦截），只在压测/预发环境用；线上用 `perf trace` 或 eBPF 工具（第 12 章）。
- **解决**：日志改异步+缓冲；确认修复：sy 占比回落，strace -c 里 write 次数下降两个数量级。

通用信号：**`top` 的 us/sy 比例是判断"时间花在自己代码还是花在进内核"的第一现场**。sy 高 → strace/perf trace 找是哪个 syscall、谁调的。

## 10. 实验任务

做 [lab_01_process.md](../labs/lab_01_process.md) 的实验 1–3：① strace 统计最小 Go 程序的 syscall 并解释 top5；② readelf 对比 Go 静态二进制与 C 动态二进制；③ 解读 /proc/self/maps 的地址空间布局。

## 11. 面试题（附答题要点）

**Q1：为什么要区分用户态和内核态？**
要点：硬件资源必须收口管理（安全/稳定/复用三理由，见 2.2 表格）；隔离由 CPU 特权级硬件强制，不是软件君子协定；用户态崩溃可控（杀进程），内核态崩溃是全机事故——所以要把尽量少的代码放进内核。加分：提微内核 vs 宏内核的取舍、eBPF 是"受控地往内核放用户逻辑"。

**Q2：系统调用的成本到底在哪？**
要点：分三层答——直接成本（特权级切换+换栈+保存现场，~百 ns）；间接成本（L1/TLB 缓存污染，影响返回后的用户态性能）；漏洞缓解成本（KPTI 等）。加分：说出 vDSO 让 `clock_gettime` 不进内核；说出工程对策是"攒批"（bufio/writev）。

**Q3：系统调用和函数调用的区别？**
要点：`call` vs `syscall` 指令；同栈 vs 换内核栈；无特权检查 vs 内核全参数校验；~1ns vs ~100ns。⚠️ 强调 syscall 不等于进程上下文切换、不换页表（除 KPTI 半切）。

**Q4：一个可执行文件如何变成进程？**
要点：fork（复制壳）→ execve（换映像）→ 内核解析 ELF Program Headers → mmap 各段（只登记不读入）→ 动态链接器（Go 静态则跳过）→ 摆初始栈（argv/envp/auxv）→ 跳入口 → runtime 初始化 → main。加分：demand paging——真正读文件发生在首次访问的 Page Fault。

**Q5：中断、异常、系统调用的联系与区别？**
要点：三者都是"进内核的门"，都走"保存现场→查表分发→处理→恢复现场"。区别在触发源与同步性（2.4 表格）。加分：时钟中断是抢占式调度的物理基础（没有它，死循环进程永远霸占 CPU）；缺页异常是虚拟内存的实现基础。

**Q6：为什么 Go 的 time.Now() 可以每秒调用千万次？**
要点：vDSO——内核把时间读取代码+时钟数据页映射进每个进程用户态，调用它像普通函数，零特权级切换。这是"高频只读系统调用"的通用优化思路。

## 12. 本章总结

- OS = 资源管理 + 抽象隔离；隔离由 CPU 特权级（Ring 0/3）硬件强制。
- 进内核只有三扇门：中断（异步外部）、异常（同步出错）、系统调用（主动请求）；syscall 是应用与内核的唯一正式接口。
- syscall 成本 = 直接切换 + 缓存污染 + 安全缓解，工程对策是减少次数（缓冲/批量）而不是消灭它。
- 可执行文件 → 进程：fork + execve + ELF 映射 + demand paging + runtime 初始化；Go 静态链接省掉动态链接环节。

**检查清单**（都能不看书答出来才算过关）：
- [ ] 我能说出应用不能直碰硬件的三个理由，以及"强制"发生在哪一层
- [ ] 我能画出 write 系统调用的完整路径（指令/栈/表/返回值约定）
- [ ] 我能区分三扇门，并各举一个 Go 服务里的真实例子
- [ ] 我能解释 strace -c 输出里 mmap/clone/rt_sigaction 是谁产生的
- [ ] 我能说清 Go 静态链接在部署上的两个实际影响

## 13. 延伸阅读

- 《深入理解计算机系统》(CSAPP) 第 7 章（链接）、第 8 章（异常控制流）——本章的教科书版
- 《The Linux Programming Interface》(TLPI) 第 3 章（系统调用原理）
- `man 2 syscalls`、`man 7 vdso`
- LWN: *Anatomy of a system call*（两篇，讲 entry_SYSCALL_64 细节）
- 本仓库 `go/knowledge/27_syscall_cgo_netpoll.md`——Go runtime 侧的 syscall 封装
