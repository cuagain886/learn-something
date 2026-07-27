# 11 · 容器与 Sandbox：Namespace、cgroup 与隔离设计 ⭐⭐⭐⭐⭐

> 对应代码：[`../code/06_sandbox`](../code/06_sandbox)（01_namespace_demo、02_cgroup_limit、03_sandbox_lifecycle）· 对应实验：[lab_06](../labs/lab_06_agent_runner.md) 实验 1–5
>
> 本章回答：容器到底是什么？为什么 Sandbox 不能只依赖 Docker 默认配置？怎么防 fork bomb？怎么禁止访问云元数据服务？——这是本模块的技术制高点，也是 Agent 安全的地基。

## 1. 本章目标

- 说清"容器不是虚拟机"到底差在哪，能画出容器的技术组成图；
- 掌握 6 种 Namespace 各自隔离什么、怎么验证；
- 掌握 cgroup v2 的核心控制器（cpu/memory/pids/io）与 v1 的差异；
- 掌握 capabilities、seccomp、OverlayFS 的作用与配置；
- **工程输出**：一个不可信代码执行 Sandbox 的完整架构与十二道防线。

## 2. 核心概念：容器 = 三件套 + 一堆约束

### 2.1 容器不是虚拟机

```text
虚拟机 (VM)                          容器 (Container)
┌──────────┬──────────┐             ┌──────────┬──────────┐
│  App A   │  App B   │             │  App A   │  App B   │
├──────────┼──────────┤             ├──────────┼──────────┤
│ Guest OS │ Guest OS │  ← 各一套内核 │  (无内核) │  (无内核) │
├──────────┴──────────┤             ├──────────┴──────────┤
│     Hypervisor      │             │   ⚠️ 共享宿主机内核   │
├─────────────────────┤             ├─────────────────────┤
│      宿主机内核       │             │      宿主机内核       │
└─────────────────────┘             └─────────────────────┘
启动: 秒~分钟                          启动: 毫秒
开销: 几百 MB 起                       开销: 就是进程本身
隔离: 硬件级(强)                       隔离: 内核级(弱)
```

**一句话定义**：**容器就是被 Namespace 限制了视野、被 cgroup 限制了资源、被 seccomp/capabilities 限制了权限的普通进程**。

⚠️ **最重要的推论**：容器里的进程和宿主机上的进程**跑在同一个内核上**。宿主机 `ps aux` 能看到容器里的所有进程（PID 不同但确实存在）。这意味着：
- **内核漏洞 = 逃逸风险**。VM 逃逸要打穿 Hypervisor，容器逃逸只要打穿内核的某个 syscall。
- 这就是为什么运行**不可信代码**时，很多人选择 gVisor（用户态内核）、Kata Containers（轻量 VM）或 Firecracker（microVM）——它们在容器的便利性和 VM 的隔离强度之间找平衡。

### 2.2 容器的技术组成

| 技术 | 作用 | 回答什么问题 |
|---|---|---|
| **Namespace** | 隔离**视野** | "我能看见什么？" |
| **cgroup** | 限制**资源** | "我能用多少？" |
| **Capabilities** | 削减**特权** | "我能做什么特权操作？" |
| **seccomp** | 过滤**系统调用** | "我能调哪些 syscall？" |
| **OverlayFS** | 分层**文件系统** | "我的根文件系统从哪来？" |
| **pivot_root/chroot** | 切换**根目录** | "我的 / 在哪？" |

**记忆口诀**：**Namespace 管"看见"，cgroup 管"用多少"，capabilities + seccomp 管"能干啥"，OverlayFS 管"从哪来"**。

## 3. Namespace：隔离视野

`clone()` 或 `unshare()` 时通过 flag 指定要新建哪些 namespace（第 09 章 §3.2 的 clone 又出现了）。

### 3.1 六种 Namespace 详解

| Namespace | flag | 隔离什么 | 验证方法 | Sandbox 重要性 |
|---|---|---|---|---|
| **PID** | `CLONE_NEWPID` | 进程号空间 | 容器内 `ps` 只见自己的进程，PID 从 1 开始 | ⭐⭐⭐⭐⭐ |
| **Mount** | `CLONE_NEWNS` | 挂载点视图 | 容器内 `mount` 看到独立的挂载表 | ⭐⭐⭐⭐⭐ |
| **Network** | `CLONE_NEWNET` | 网卡/IP/路由/端口/iptables | 容器内 `ip addr` 只有 lo 和 eth0 | ⭐⭐⭐⭐⭐ |
| **UTS** | `CLONE_NEWUTS` | 主机名、域名 | 容器内 `hostname` 独立 | ⭐⭐ |
| **IPC** | `CLONE_NEWIPC` | System V IPC、POSIX 消息队列 | `ipcs` 看到独立的共享内存段 | ⭐⭐⭐ |
| **User** | `CLONE_NEWUSER` | uid/gid 映射 | **容器内的 root 映射成宿主机的普通用户** | ⭐⭐⭐⭐⭐ |
| *(cgroup)* | `CLONE_NEWCGROUP` | cgroup 根视图 | 容器内看不到宿主机的 cgroup 路径 | ⭐⭐ |
| *(time)* | `CLONE_NEWTIME` | 系统时钟偏移（5.6+） | 容器内 uptime 独立 | ⭐ |

### 3.2 PID Namespace：Sandbox 的核心

```text
宿主机视角                      容器内视角
PID 12345  ← 同一个进程 →      PID 1     (容器的 init)
PID 12346  ← 同一个进程 →      PID 2
```

**三个关键特性**：

1. **PID 1 的特殊地位**：namespace 内的 PID 1 是这个 namespace 的 init。⚠️ **PID 1 死了，内核会杀掉该 namespace 内的所有进程**——这是"如何终止整个进程树"的**终极答案**（第 02 章 §4.2 方案 C），比进程组可靠得多，因为子进程无法通过 `setsid` 逃出 namespace。

2. **PID 1 的信号语义特殊**：内核**不会**给 PID 1 投递它没有注册处理函数的信号。所以容器里的 PID 1 如果没有处理 SIGTERM，`docker stop` 会一直等到超时才 SIGKILL——这是"容器停止很慢"的常见原因。

3. **PID 1 有收养义务**：容器内所有孤儿进程会被过继给 PID 1（第 02 章 §3.3）。如果你的 PID 1 是一个不会 wait 的应用程序，**僵尸进程会在容器内堆积**。
   👉 解法：用 `tini`/`dumb-init` 做 PID 1，或 `docker run --init`，或应用自己处理 SIGCHLD。

```bash
# 手工体验 PID namespace
sudo unshare --pid --fork --mount-proc bash
# 在新 shell 里：
ps aux        # 只看到 bash 和 ps —— PID 1 就是这个 bash
echo $$       # 1
exit
```
⚠️ `--mount-proc` 必须加：`/proc` 是 procfs 的挂载，不重新挂载的话 `ps` 读的还是宿主机的 `/proc`。这正好印证了第 10 章"`/proc` 不是 namespace 化的"——**必须配合 Mount namespace 重新挂载才能真正隔离**。

### 3.3 Mount Namespace 与 pivot_root

Mount namespace 让进程有独立的挂载表。但**光有 Mount namespace 还不够**——你还得把根目录换掉：

- **`chroot`**：改变进程的 `/` 指向。⚠️ **不安全**——已知多种逃逸方法（如持有 chroot 外的 fd、用 `chroot("..")` 反复上跳）。**不要用 chroot 做安全边界**。
- **`pivot_root`**：把整个挂载树的根换掉，旧根挂到新根下的某个点，然后卸载旧根。**这才是容器运行时用的方法**——旧的根文件系统被真正卸载，没有引用可以回去。

Sandbox 的挂载策略（安全性递增）：
```bash
mount -o bind,ro /usr /sandbox/usr     # 只读绑定系统目录
mount -t tmpfs -o size=100m,nosuid,nodev,noexec tmpfs /sandbox/tmp
#                                        └─ 三个必备挂载选项：
#   nosuid  → 禁用 setuid 位（第 07 章 §2.3，防提权）
#   nodev   → 禁止设备文件（防直接读写 /dev/mem 等）
#   noexec  → 禁止执行（防在可写目录里落下恶意二进制再执行）
```

### 3.4 User Namespace：最强也最复杂的一层

User namespace 让**容器内的 uid 0（root）映射到宿主机的一个普通 uid**：

```text
容器内 uid 0 (root)  ←映射→  宿主机 uid 100000 (无特权普通用户)
```

**价值**：即使攻击者在容器内拿到 root、即使他利用漏洞逃逸出去，在宿主机上他也只是 uid 100000——**逃逸的收益被大幅削减**。这是"纵深防御"的典范。

⚠️ **代价与陷阱**：
- 文件属主映射复杂（挂载卷的权限经常出问题）；
- 部分功能不兼容（某些网络/存储驱动）；
- Docker 默认**不开** user namespace（要 `--userns-remap`），K8s 到较新版本才有较完整支持；
- 讽刺的是：user namespace 本身允许非特权用户创建其他 namespace，这**扩大了内核攻击面**——多个容器逃逸 CVE 就是通过它触发的。有些发行版因此默认限制非特权用户创建 user namespace。

### 3.5 Network Namespace 与 Sandbox 网络策略

每个 network namespace 有独立的网卡、IP、路由表、iptables 规则、端口空间。

**Agent Sandbox 的四档网络策略**（按安全性递增）：

| 档位 | 配置 | 适用场景 |
|---|---|---|
| 完全禁网 | `--network=none`（只有 lo） | 纯计算任务、代码格式化——**默认应该是这档** |
| 白名单出网 | 独立 netns + iptables 只放行特定域名/IP | 需要装包（pip/npm）的任务 |
| 受限出网 | 允许公网但**屏蔽内网和元数据服务** | 需要访问外部 API |
| 完全放开 | 共享宿主机网络 | ❌ 不可信代码绝不使用 |

⚠️ **必须屏蔽的三类目标**（这是云上 Sandbox 最容易被忽略的致命点）：

```bash
# ① 云元数据服务 —— 拿到它就等于拿到云账号的临时凭证！
169.254.169.254         # AWS/GCP/Azure/阿里云通用
100.100.100.200         # 阿里云
fd00:ec2::254           # AWS IPv6

# ② 内网网段 —— 防止横向移动到你的数据库/内部服务
10.0.0.0/8  172.16.0.0/12  192.168.0.0/16  169.254.0.0/16

# ③ 宿主机自身
127.0.0.0/8             # 容器内的 lo 是独立的, 但共享网络时就是宿主机
```

**为什么元数据服务这么危险**：云主机上任何进程 `curl http://169.254.169.254/latest/meta-data/iam/security-credentials/` 就能拿到该实例绑定的 IAM 角色的**临时密钥**——攻击者用它可以直接操作你的云资源。**这是真实发生过多次的重大安全事件**（如 Capital One 数据泄露）。

```bash
# 最小防御（在 Sandbox 的 netns 里）
iptables -A OUTPUT -d 169.254.169.254 -j REJECT
iptables -A OUTPUT -d 10.0.0.0/8 -j REJECT
iptables -A OUTPUT -d 172.16.0.0/12 -j REJECT
iptables -A OUTPUT -d 192.168.0.0/16 -j REJECT
```

## 4. cgroup：限制资源

### 4.1 v1 vs v2

| | cgroup v1 | cgroup v2 |
|---|---|---|
| 层级 | 每个控制器一棵独立树（`/sys/fs/cgroup/cpu/`、`/memory/`…） | **统一单一层级**（`/sys/fs/cgroup/`） |
| 进程归属 | 同一进程可以在不同控制器里属于不同组 → 混乱 | 一个进程只属于一个 cgroup |
| 内存+IO 协同 | 无法协同（脏页回写的归属不清） | 支持（`io.max` 能正确归因） |
| 杀进程 | 需要遍历 PID 逐个杀 | **`cgroup.kill`（5.14+）原子杀光全组** |
| 现状 | 逐步淘汰 | 现代发行版默认（RHEL9、Ubuntu 22.04+、Debian 11+） |

判断当前系统用哪个：
```bash
stat -fc %T /sys/fs/cgroup/     # cgroup2fs = v2, tmpfs = v1
```

### 4.2 v2 核心控制器

```bash
# 创建一个 cgroup（v2 就是建目录，内核自动生成控制文件）
sudo mkdir /sys/fs/cgroup/sandbox-task-1
cd /sys/fs/cgroup/sandbox-task-1

# ① CPU 限制
echo "50000 100000" > cpu.max      # quota/period = 0.5 核
echo "100" > cpu.weight            # 相对权重（竞争时的份额，默认 100）

# ② 内存限制
echo $((512*1024*1024)) > memory.max      # 硬上限，超了就 OOM Kill
echo $((400*1024*1024)) > memory.high     # 软上限，超了开始节流回收（更温和）
echo 0 > memory.swap.max                  # 禁止使用 swap（防绕过内存限制）

# ③ 进程数限制 ← 防 fork bomb 的唯一可靠手段
echo 64 > pids.max

# ④ I/O 限制（需要设备号，lsblk 查）
echo "8:0 rbps=10485760 wbps=10485760" > io.max    # 读写各 10MB/s

# 把进程放进来（子进程自动继承）
echo <pid> > cgroup.procs

# 观察
cat memory.current pids.current cpu.stat
cat memory.events        # oom / oom_kill 计数 ← 排障关键
cat cpu.stat | grep throttled   # nr_throttled/throttled_usec ← CPU 被节流的证据

# 一键杀光全组（v2 5.14+）—— 无法逃逸
echo 1 > cgroup.kill
```

### 4.3 三个必须理解的坑

**坑 1：CPU 限制是"配额+周期"不是"核数"。**
`cpu.max = "50000 100000"` 表示每 100ms 周期内最多用 50ms CPU。**在多线程程序上，这意味着 4 个线程会在 12.5ms 后就把配额用光，然后被冻结 87.5ms**——表现为**周期性的延迟毛刺**，而不是均匀的减速。这就是 K8s 里"CPU limit 导致 P99 恶化"的著名问题。
👉 排查证据：`cpu.stat` 的 `nr_throttled` 和 `throttled_usec` 持续增长。
👉 缓解：调大 period、放宽 limit、或对延迟敏感服务只设 request 不设 limit（有争议但常见）。

**坑 2：memory.max 把 Page Cache 也算进去**（第 05 章 §2.8 已提）。
大量读写文件的任务，`memory.current` 会被 cache 顶满。内核会先尝试回收，但回收不及时就 OOM。
👉 对策：给 limit 留余量；用 `memory.stat` 区分 `anon`（真身）和 `file`（缓存）。

**坑 3：pids.max 是防 fork bomb 的唯一可靠手段。**
第 10 章讲过 `RLIMIT_NPROC` **按 UID 统计**——多个任务用同一个 uid 时额度互相干扰，一个任务的 fork bomb 会让所有任务都无法创建进程。`pids.max` 按 cgroup 统计，精确隔离。

```bash
# fork bomb 验证（在设了 pids.max=64 的 cgroup 里）
:(){ :|:& };:      # ⚠️ 只在有 pids 限制的隔离环境里跑！
# 结果：fork 到 64 个就失败，宿主机毫发无伤
```

## 5. 能力与系统调用：削减权限

### 5.1 Capabilities：把 root 拆成 40 多块

传统 Unix 只有"root 和非 root"两种。Capabilities 把 root 的权力拆成细粒度的能力，可以单独授予/剥夺：

| capability | 允许什么 | 危险度 |
|---|---|---|
| `CAP_SYS_ADMIN` | 挂载、namespace 操作等一大堆 | ☠️ **约等于 root**，被称为"新的 root" |
| `CAP_SYS_PTRACE` | ptrace 其他进程（读写其内存） | ☠️ 可用于逃逸 |
| `CAP_SYS_MODULE` | 加载内核模块 | ☠️ 直接控制内核 |
| `CAP_DAC_OVERRIDE` | 绕过文件权限检查 | ⚠️ 高 |
| `CAP_NET_RAW` | 原始套接字（ping、抓包、ARP 欺骗） | ⚠️ 中 |
| `CAP_NET_BIND_SERVICE` | 绑定 1024 以下端口 | 低（常见的合法需求） |
| `CAP_CHOWN` | 改文件属主 | 中 |

```bash
# Docker 的最佳实践：先全丢，再按需加回
docker run --cap-drop=ALL --cap-add=NET_BIND_SERVICE ...

# 查看进程当前的 capabilities
grep Cap /proc/<pid>/status
capsh --decode=<CapEff 的十六进制值>     # 解码成可读名字
```

👉 **Agent Sandbox 的结论**：不可信代码执行应该 `--cap-drop=ALL`，一个都不加。任何需要 capability 的需求都应该先质疑设计。

### 5.2 seccomp：系统调用白名单

seccomp（secure computing mode）过滤进程能调用哪些 syscall。这是**最后一道、也是最关键的一道防线**——因为第 01 章说过，**恶意代码想干任何坏事最终都要过 syscall 这道门**。

- **seccomp-bpf**：用 BPF 程序判断，可以检查 syscall 号和参数，动作包括：允许、拒绝（返回 errno）、杀进程、触发 ptrace、记录日志。
- Docker 默认的 seccomp profile 屏蔽了约 44 个 syscall（如 `mount`、`reboot`、`kexec_load`、`bpf`）——**这是默认配置里最有价值的一项防护**。

⚠️ **但 Docker 默认 profile 是"黑名单"思路，对不可信代码远远不够**。理想是白名单：

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "architectures": ["SCMP_ARCH_X86_64"],
  "syscalls": [
    { "names": ["read","write","openat","close","fstat","lseek","mmap",
                "munmap","brk","exit_group","rt_sigaction","clock_gettime"],
      "action": "SCMP_ACT_ALLOW" }
  ]
}
```

**怎么知道该放行哪些？**（这里和第 09 章闭环）：
```bash
strace -c -f <你的典型工具>          # 收集它实际用了哪些 syscall
# 或用 Docker 的 audit 模式先记录再收紧
docker run --security-opt seccomp=audit.json ...   # defaultAction 设为 SCMP_ACT_LOG
dmesg | grep seccomp                                # 看被记录的 syscall
```

**必须屏蔽的高危 syscall**：
```text
mount / umount2      挂载操作 → 逃逸的常见路径
ptrace               读写其他进程内存 → 逃逸
bpf                  加载 BPF 程序 → 多个提权 CVE
kexec_load           加载新内核 → 直接完蛋
init_module          加载内核模块
perf_event_open      多个提权 CVE 的入口
clone(CLONE_NEWUSER) 创建 user namespace → 扩大攻击面
unshare / setns      切换 namespace → 逃逸
process_vm_readv/writev   跨进程读写内存
keyctl               内核密钥环，有过 CVE
userfaultfd          曾被用于稳定化多个内核漏洞利用
```

### 5.3 no-new-privileges

```bash
docker run --security-opt no-new-privileges ...
# 或 prctl(PR_SET_NO_NEW_PRIVS, 1)
```
设置后，进程及其所有后代**永远无法通过 execve 获得新特权**（setuid 二进制失效）。**成本几乎为零，收益很大——应该无条件开启**。

## 6. OverlayFS 与镜像分层

```text
容器的根文件系统 = 多层叠加
┌─────────────────────────────┐
│ upperdir (容器可写层)         │ ← 容器内所有写操作落在这里
├─────────────────────────────┤
│ lowerdir N (镜像层: 你的 app) │ ┐
├─────────────────────────────┤ │
│ lowerdir 2 (镜像层: 依赖)     │ ├ 只读，多个容器【共享同一份】
├─────────────────────────────┤ │
│ lowerdir 1 (基础镜像: alpine) │ ┘
└─────────────────────────────┘
        ↓ 合并呈现
   merged (容器看到的 /)
```

**关键机制**：
- **Copy-Up**：修改只读层的文件时，先把整个文件复制到 upperdir 再改。⚠️ **改一个 1GB 文件的一个字节，要先复制 1GB**——这是容器里"改大文件很慢"的原因。
- **Whiteout**：删除只读层的文件时，在 upperdir 创建一个特殊标记文件（字符设备 0/0），表示"这个文件被删了"。**原文件仍在镜像层里占空间**——这就是"`rm` 了敏感文件但镜像里还能找到"的安全问题，也是为什么 `docker build` 里 `RUN wget secret && rm secret` 是无效的（要用多阶段构建）。
- **镜像分层的价值**：多个容器共享只读层 → 100 个相同镜像的容器只占一份基础镜像的空间和 Page Cache。

**Agent Sandbox 的用法**：每个任务一个新的 upperdir → 任务结束直接删掉 upperdir → **文件系统状态完美回滚，零残留**。这比 `rm -rf` 工作目录更彻底、更快。

## 7. Agent Sandbox 架构设计

### 7.1 十二道防线（按被突破的顺序）

```text
不可信代码
    │
 ①  │ ← 输入校验：路径穿越/命令注入（第 07 章）
    ▼
 ②  │ ← 非 root 运行（uid 65534 或专用 uid）+ no-new-privileges
    ▼
 ③  │ ← capabilities: --cap-drop=ALL
    ▼
 ④  │ ← seccomp 白名单：只放行必需的 syscall
    ▼
 ⑤  │ ← PID namespace：看不见宿主机进程；PID 1 死则全灭
    ▼
 ⑥  │ ← Mount namespace + pivot_root + 只读根 + nosuid,nodev,noexec
    ▼
 ⑦  │ ← Network namespace：默认禁网；必须联网时屏蔽元数据/内网
    ▼
 ⑧  │ ← User namespace：容器 root 映射成宿主机普通用户
    ▼
 ⑨  │ ← cgroup: cpu.max / memory.max / pids.max / io.max
    ▼
 ⑩  │ ← 超时：wall-clock 超时 + RLIMIT_CPU 双保险
    ▼
 ⑪  │ ← 输出限额：截断 + 标记（第 06 章板斧⑤）
    ▼
 ⑫  │ ← 清理：cgroup.kill + 删 upperdir + 删 cgroup + 验尸检查
```

⚠️ **"为什么不能只依赖 Docker 默认配置"的完整答案**：

| 防线 | Docker 默认 | 风险 |
|---|---|---|
| 内存限制 | ❌ **无限制** | 一个任务吃光宿主机内存 |
| CPU 限制 | ❌ **无限制** | 一个任务打满所有核 |
| **进程数限制** | ❌ **无限制** | **fork bomb 直接打死宿主机** |
| 磁盘限制 | ❌ 无限制 | 写满磁盘，所有服务受害 |
| 网络 | ⚠️ 默认 bridge，**可访问元数据服务和内网** | 凭证泄露、横向移动 |
| 用户 | ⚠️ **默认 root**（容器内） | 逃逸后果严重 |
| capabilities | ⚠️ 默认保留 14 个（含 NET_RAW、SETUID 等） | 攻击面偏大 |
| seccomp | ✅ 有默认 profile（黑名单） | 比没有好，但对不可信代码不够 |
| user namespace | ❌ 默认不开 | 容器 root = 宿主机 root |

**最小加固命令**：
```bash
docker run --rm \
  --user 65534:65534 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop=ALL \
  --security-opt no-new-privileges \
  --security-opt seccomp=./seccomp-strict.json \
  --network none \
  --memory 512m --memory-swap 512m \
  --cpus 0.5 \
  --pids-limit 64 \
  --ulimit nofile=64:64 --ulimit fsize=10485760 \
  sandbox-image:latest
```

### 7.2 多租户隔离原则

1. **每租户独立 uid**：不同租户的任务用不同 uid 运行，文件权限天然隔离。
2. **每任务独立 cgroup**：`/sys/fs/cgroup/agent/<tenant>/<task>/`，租户级设总配额，任务级设单份额。
3. **禁止跨租户可见**：PID/Mount/Network namespace 保证 A 看不见 B 的进程、文件、网络。
4. **配额分层**：租户总配额 > 单任务配额 × 并发数——防止一个租户的多个任务耗尽自己的份额影响他人。
5. **审计留痕**：每个任务记录 tenant、uid、cgroup 路径、执行的命令、资源峰值、终态原因。

### 7.3 容器逃逸的常见路径（了解攻击才能防御）

| 路径 | 原理 | 防御 |
|---|---|---|
| 挂载了 docker.sock | 容器内可控制 Docker daemon → 起特权容器 | **永远不要挂载 docker.sock 给不可信容器** |
| `--privileged` | 关闭几乎所有隔离 | 永远不用 |
| 挂载宿主机目录 | 写 `/etc/cron.d`、`~/.ssh/authorized_keys` | 只挂必需的、只读的 |
| 内核漏洞（如 Dirty COW、Dirty Pipe） | 利用内核 bug 提权 | 及时打补丁 + seccomp 缩小攻击面 |
| CAP_SYS_ADMIN + cgroup release_agent | 通过 cgroup 机制在宿主机执行命令 | `--cap-drop=ALL` |
| `/proc` 未正确挂载 | 通过 `/proc/sys/kernel/core_pattern` 执行命令 | 只读挂载 `/proc/sys` |

👉 **纵深防御的意义**：任何单一防线都可能被绕过，但攻击者需要**连续突破多层**才能造成实际损害。这就是为什么十二道防线要全部部署，而不是挑几个。

## 8. Go 语言示例

| 示例 | 演示内容 |
|---|---|
| [01_namespace_demo](../code/06_sandbox/01_namespace_demo/main.go) | 用 `SysProcAttr.Cloneflags` 创建 PID/UTS/Mount namespace，观察容器内外的视图差异 |
| [02_cgroup_limit](../code/06_sandbox/02_cgroup_limit/main.go) | 创建 cgroup v2、设置 cpu/memory/pids 限制、把子进程放进去、验证 fork bomb 被挡住、用 cgroup.kill 清理 |
| [03_sandbox_lifecycle](../code/06_sandbox/03_sandbox_lifecycle/main.go) | Sandbox 生命周期管理器：创建（namespace+cgroup+工作目录）→ 运行 → 超时/取消 → 强制回收 → 验尸 |

## 9. 常见问题与错误设计

**错误 1：用 chroot 做安全边界。** 已知多种逃逸方法。要用 `pivot_root` + Mount namespace。

**错误 2：容器内以 root 运行。** Docker 默认就是 root。加 `--user` 或 Dockerfile 里 `USER nobody`。⚠️ 注意：非 root 用户可能无法写某些目录，要提前规划好目录权限。

**错误 3：只设 memory limit 不设 pids limit。** 内存限制挡不住 fork bomb——fork bomb 的每个进程都很小，但数量能耗尽 PID 空间和调度器。

**错误 4：以为 `--network none` 就绝对安全。** 还要考虑：共享内存、通过文件系统传递数据、通过 CPU 侧信道（极端场景）。但对绝大多数场景，`--network none` 已经消除了最大的风险面。

**错误 5：忘了 PID 1 的收养义务。** 容器内的 PID 1 不 wait → 僵尸堆积 → 撞上 pids.max → 任务无法创建新进程。用 `--init` 或 tini。

**错误 6：把 cgroup 建在错的地方。** cgroup v2 下如果宿主机由 systemd 管理，直接在 `/sys/fs/cgroup/` 建目录可能与 systemd 冲突。正确做法是在 systemd 的委托范围内创建（`systemd-run --scope`）或使用容器运行时的接口。

## 10. 排障方法

**案例 A：容器启动就退出，exit code 139（SIGSEGV）或 1。**
```bash
docker logs <container>              # 先看应用日志
docker run --security-opt seccomp=unconfined <image>   # 临时关 seccomp 试试
dmesg | grep -i seccomp              # 看是不是 syscall 被拦
# 如果关掉 seccomp 就正常 → 白名单少了必需的 syscall → 用 audit 模式收集
```

**案例 B：容器 CPU 用不满 limit，但延迟很高。**
```bash
cat /sys/fs/cgroup/<path>/cpu.stat | grep -E 'nr_throttled|throttled_usec'
# 持续增长 = CPU 配额周期性耗尽 → 多线程程序在 period 内提前用光配额被冻结
# 缓解：调大 cpu.max 的 period、放宽 quota、或减少并发线程数（GOMAXPROCS）
```

**案例 C：任务结束后进程仍在运行。**
```bash
# 检查 cgroup 里还有没有进程（这比 pgrep 可靠——它不会漏掉逃出进程组的）
cat /sys/fs/cgroup/<path>/cgroup.procs
# 有残留 → 用 cgroup.kill 原子清理（v2 5.14+）
echo 1 > /sys/fs/cgroup/<path>/cgroup.kill
# 老内核：遍历 cgroup.procs 逐个 SIGKILL，然后再检查一遍（可能有新 fork 的）
```

## 11. 实验任务

[lab_06_agent_runner.md](../labs/lab_06_agent_runner.md) 实验 1–5：① 手工创建 PID namespace 观察 PID 1；② cgroup 限制 CPU/内存/pids；③ fork bomb 攻防；④ Docker 默认配置 vs 加固配置的对照实验；⑤ 元数据服务访问的攻防验证。

## 12. 面试题（附答题要点）

**Q1：容器和虚拟机的区别？**
要点：VM 有独立内核 + Hypervisor（硬件级隔离，重）；容器**共享宿主机内核**（内核级隔离，轻）。给一句定义："容器就是被 namespace 限制视野、cgroup 限制资源、seccomp/capabilities 限制权限的普通进程"。加分：共享内核意味着**内核漏洞 = 逃逸风险**；这就是 gVisor/Kata/Firecracker 存在的理由。

**Q2：容器用到了哪些内核技术？各自作用？**
要点：口诀式回答——**Namespace 管"看见"，cgroup 管"用多少"，capabilities + seccomp 管"能干啥"，OverlayFS 管"从哪来"**，再加 pivot_root 换根。每项举一个具体例子。

**Q3：Namespace 有哪几种？PID namespace 有什么特殊之处？**
要点：六种（PID/Mount/Network/UTS/IPC/User）+ cgroup/time。PID namespace 三个特性：① **PID 1 死则全灭**（终止进程树的终极方案，无法用 setsid 逃逸）；② PID 1 的信号语义特殊（未注册的信号不投递 → docker stop 慢）；③ PID 1 有收养义务（不 wait 就堆僵尸 → 用 tini/`--init`）。

**Q4：cgroup v1 和 v2 的区别？**
要点：v1 每控制器一棵树（进程可属不同组，混乱、内存与 IO 无法协同）；v2 统一层级（一个进程一个 cgroup，支持 IO 与内存协同归因）。**v2 的杀手锏是 `cgroup.kill`（5.14+）原子杀光全组**。加分：`stat -fc %T /sys/fs/cgroup/` 判断版本。

**Q5：怎么防止 fork bomb？**
要点：**cgroup 的 `pids.max` 是唯一可靠手段**。为什么不用 `RLIMIT_NPROC`：它**按 UID 统计**，多任务共用 uid 时额度互相干扰（连回第 10 章）。加分：Docker 的 `--pids-limit`；⚠️ Docker **默认不限制**——这是"不能只依赖默认配置"的最有力论据。

**Q6：为什么 Sandbox 不能只依赖 Docker 默认配置？（高频）**
要点：逐项列举默认缺失——内存/CPU/**进程数**/磁盘**全都不限制**；网络默认可访问**云元数据服务和内网**；默认以 **root** 运行；capabilities 保留 14 个；user namespace 默认不开。只有 seccomp 有默认 profile（但是黑名单思路）。给出最小加固命令作为收尾。

**Q7：什么是云元数据服务？为什么必须屏蔽？**
要点：`169.254.169.254` 是云厂商的实例元数据端点，**任何进程 curl 一下就能拿到该实例 IAM 角色的临时密钥**，等于拿到云账号权限。真实案例：Capital One 数据泄露。防御：在 Sandbox 的 netns 里 iptables REJECT，同时屏蔽内网网段防横向移动。⚠️ 这是云上 Sandbox 最容易漏掉的致命点。

**Q8：seccomp 是什么？怎么设计白名单？**
要点：过滤进程能调用哪些 syscall，是**最后一道也是最关键的防线**——因为恶意代码干任何坏事最终都要过 syscall。白名单设计流程：`strace -c -f` 收集典型工具的实际 syscall → 生成白名单 → audit 模式验证 → 逐步收紧。必须屏蔽的高危：mount/ptrace/bpf/kexec_load/init_module/unshare/setns/process_vm_*。

**Q9：OverlayFS 的 Copy-Up 和 Whiteout 是什么？有什么工程影响？**
要点：Copy-Up——改只读层文件要先整个复制到可写层（**改 1GB 文件的一个字节要复制 1GB**）；Whiteout——删除只读层文件只是打标记，**原文件仍在镜像里占空间**（所以 `RUN wget secret && rm secret` 无效，要用多阶段构建）。加分：Agent Sandbox 可以"每任务一个 upperdir，结束删掉"实现完美回滚。

**Q10：容器逃逸有哪些常见路径？**
要点：挂载 docker.sock（等于给了 root）、`--privileged`、挂载宿主机敏感目录、内核漏洞（Dirty COW/Dirty Pipe）、CAP_SYS_ADMIN + cgroup release_agent、`/proc` 未正确挂载。防御思路是**纵深防御**——攻击者需要连续突破多层才能造成损害。

## 13. 本章总结

- 容器 = 普通进程 + Namespace（视野）+ cgroup（资源）+ capabilities/seccomp（权限）+ OverlayFS（文件系统）；共享内核是它轻量的原因，也是它隔离弱的原因。
- PID namespace 的"PID 1 死则全灭"是终止进程树的终极方案；但要记得 PID 1 的信号语义和收养义务。
- cgroup v2 的 `pids.max` 是防 fork bomb 的唯一可靠手段；`cgroup.kill` 是清理残留进程的原子操作。
- seccomp 是最后一道防线，因为一切坏事都要过 syscall；白名单从 `strace -c` 收集开始。
- **Docker 默认配置对不可信代码远远不够**：内存/CPU/进程数/磁盘全不限、默认 root、可访问元数据服务——十二道防线要全部部署。

**检查清单**：
- [ ] 我能用一句话定义容器，并说出共享内核带来的两个后果
- [ ] 我能说出六种 namespace 各隔离什么，以及 PID namespace 的三个特殊性
- [ ] 我能手写一条加固的 docker run 命令，并解释每个参数挡什么
- [ ] 我知道云元数据服务的地址和危害，能写出屏蔽规则
- [ ] 我能解释 Copy-Up/Whiteout 及其两个工程影响
- [ ] 我能画出十二道防线并说明为什么需要纵深防御

## 14. 延伸阅读

- kernel 文档 `Documentation/admin-guide/cgroup-v2.rst`（cgroup v2 权威文档）
- `man 7 namespaces`、`man 7 capabilities`、`man 2 seccomp`
- Liz Rice: *Container Security*（容器安全最好的一本书）
- Jess Frazelle 的容器安全系列博客与 seccomp profile 实践
- Docker 官方 `seccomp` 默认 profile 源码（`profiles/seccomp/default.json`）
- gVisor / Kata Containers 的设计文档——理解"更强隔离"的代价与收益
- 下一章 [13 Agent Code Runner 项目](13_agent_code_runner_project.md)——把本章的防线落地成代码
