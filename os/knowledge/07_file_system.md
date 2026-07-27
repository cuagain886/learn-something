# 07 · 文件系统：inode、文件描述符与安全路径 ⭐⭐⭐

> 对应代码：[`../code/04_io`](../code/04_io)（01_fd_leak、02_safe_path、03_workdir_lifecycle）· 对应实验：[lab_04](../labs/lab_04_io.md) 实验 1–4
>
> 本章回答：为什么文件描述符不断增长？为什么出现 Too many open files？为什么磁盘有空间却无法创建文件？为什么频繁写日志会影响性能？——以及 Sandbox 的第一道防线：路径穿越与符号链接攻击。

## 1. 本章目标

- 说清 inode 与目录项的分工，理解"文件名只是指向 inode 的链接"；
- 掌握三张表（fd 表 / 打开文件表 / inode 表）的关系，能解释 fork、dup、多次 open 的差异；
- 掌握 Page Cache、脏页回写、fsync 的语义与代价；
- 能定位 fd 泄漏与 inode 耗尽；
- **工程输出**：安全路径处理（防穿越/防符号链接）+ 任务工作目录的完整生命周期。

## 2. 核心概念

### 2.1 inode：文件的真身，文件名只是标签

Unix 文件系统把"文件是什么"和"文件叫什么"彻底分开：

- **inode（index node）**：文件的元数据本体——类型、权限、uid/gid、大小、时间戳、**数据块指针**、链接计数。⚠️ **inode 里没有文件名**。
- **目录项（dentry）**：目录本质是一张表，每行是 `(文件名 → inode 号)`。所以"文件名"住在**目录里**，不在文件里。

这一刀切分解释了一连串现象：

| 现象 | 解释 |
|---|---|
| 硬链接（hard link）为什么"两个名字一个文件" | 两个目录项指向同一 inode，inode 的 `nlink` 计数 = 2。删除只是删目录项 + 计数减一，**计数归零才真删数据** |
| `rm` 一个正在被进程读写的大文件，磁盘空间为什么不释放 | 目录项没了、nlink=0，但**打开的 fd 也算一份引用**——进程不关闭，数据块就不释放。`lsof \| grep deleted` 就是查这个 |
| 为什么 `mv` 同分区内瞬间完成 | 只改目录项，数据块一动不动。跨分区才是真拷贝+删除 |
| 软链接（symlink）和硬链接的区别 | 软链接是**独立的一个文件**，内容是一段路径字符串；可跨分区、可指向目录、目标删了就成断链。硬链接不能跨分区（inode 号只在分区内唯一）、不能指向目录 |

**磁盘有空间却创建不了文件**：inode 数量在格式化时就固定了（`df -i` 看）。海量小文件（缓存碎片、Agent 生成的临时文件）会先耗尽 inode——`df -h` 显示还有 50% 空间，`touch` 报 `No space left on device`。这是"现象与报错完全对不上"的经典陷阱。

### 2.2 三张表：fd 到底是什么

`open()` 返回的 fd 只是**一个小整数**——进程 fd 表的下标。往下有三层：

```text
进程 A                     全局打开文件表                inode 表(内存中)
┌──────────────┐          ┌────────────────────┐      ┌───────────────┐
│ fd 0 → ───────────┐     │ 文件偏移量 offset   │      │ 权限/大小/时间 │
│ fd 1 → ───────┐   ├────►│ 状态标志 O_APPEND.. │─────►│ 数据块指针     │
│ fd 2 → ───────┤   │     │ 引用计数            │      │ nlink 计数     │
│ fd 3 →────────┼───┘     └────────────────────┘      └───────────────┘
└──────────────┘   │      ┌────────────────────┐              ▲
进程 B(fork 的子)   └─────►│ 另一个 offset       │──────────────┘
┌──────────────┐          └────────────────────┘
│ fd 3 → ──────────────────────┘ (fork: 共享同一个打开文件表项!)
└──────────────┘
```

三种"共享"的差异（面试高频）：

| 操作 | fd 表 | 打开文件表项（offset） | inode |
|---|---|---|---|
| `fork()` | 复制（父子各有 fd 3） | **共享**——父读了 100 字节，子的 offset 也前进 100 | 共享 |
| `dup()`/`dup2()` | 新 fd | **共享** | 共享 |
| 两次 `open()` 同一文件 | 两个 fd | **各自独立** | 共享 |

这解释了两件事：① shell 里 `cmd1 >> log & cmd2 >> log` 为什么不互相覆盖（各自 open，但 `O_APPEND` 保证每次写都原子地跳到末尾）；② 子进程继承 stdout 后，父子写同一终端为什么不会互相打乱 offset（共享同一表项，offset 是同一个）。

**fd 0/1/2** 是约定：stdin/stdout/stderr。它们只是"默认已经打开的三个 fd"，没有任何魔法——重定向就是把它们指向别的打开文件表项（`dup2`）。

### 2.3 文件权限与用户

`rwxr-xr--` 三组九位，对应 owner/group/other。⚠️ 几个容易错的点：

- **目录的 x 权限 = "可进入/可查询"**，不是执行。没有 x 就无法 `cd`，也无法访问目录下任何文件（哪怕知道全名）；只有 r 没有 x 可以 `ls` 出名字但拿不到属性。
- **删除文件的权限看目录不看文件**：删除是修改目录项，所以只要有目录的 w+x，就能删掉里面任何文件（哪怕文件本身是 root 的 444）。**Sandbox 里给工具一个可写工作目录，就等于给了它删除目录内一切的权力**——这是设计隔离时的必知点。
- **sticky bit**（`/tmp` 的 `drwxrwxrwt`）：正是为了修补上一条——设了 sticky 的目录里，只有文件属主能删自己的文件。
- **setuid/setgid**：执行时以文件属主身份运行（`passwd` 靠它改 `/etc/shadow`）。⚠️ Sandbox 必须 `nosuid` 挂载，否则是提权通道（第 11 章）。
- umask：新建文件的权限 = 请求权限 & ~umask。默认 022 → 请求 0666 实得 0644。

### 2.4 管道：进程间的字节流

- **匿名管道（pipe）**：`pipe()` 返回一对 fd，只能在有亲缘关系的进程间用（靠 fork 继承）。第 02 章的死锁就发生在这——**内核缓冲区默认 64KB，写满即阻塞**。
- **命名管道（FIFO）**：`mkfifo` 在文件系统里留个名字，无关进程也能用。特性：**open 会阻塞直到两端都到齐**。
- 管道是**字节流不是消息流**：写两次 100 字节，读端可能一次读到 200 字节，也可能分三次读完。需要消息边界就自己加长度前缀或分隔符。
- ⚠️ **写端全部关闭后读端得到 EOF；读端全部关闭后写端收到 SIGPIPE（默认杀进程）**。Go 会把 SIGPIPE 转成 `EPIPE` 错误（对非标准输出的 fd），但 shell 里 `yes | head -1` 之后 `yes` 就是被 SIGPIPE 干掉的。

### 2.5 Page Cache 与 fsync：写到哪儿才算写了

`write()` 返回成功 ≠ 数据在磁盘上。数据先进 **Page Cache**（内核的文件缓存），标记为脏页，由 `pdflush`/回写线程异步落盘：

```text
write(fd, buf, n)
   └→ 拷贝到 Page Cache 的页里，标脏 → 立即返回成功 (~μs)
                    │
                    ├─ 30 秒后 / 脏页比例超阈值 (dirty_ratio) → 回写线程刷盘
                    └─ fsync(fd) → 强制立即刷该文件的脏页 + 元数据，等落盘完成才返回 (~ms)
```

- **好处**：写快（不等磁盘）、读快（命中缓存直接返回）、合并小写、预读（readahead）。这就是为什么第二次读同一文件飞快。
- **代价**：**掉电丢数据**。数据库/消息队列的持久化承诺全靠 `fsync`——这也是它们写入慢的根本原因（一次 fsync 在 SSD 上 ~几百 μs 到 ms 级，HDD 更慢）。
- ⚠️ `fsync` vs `fdatasync`：后者不刷元数据（不含时间戳等），少一次元数据 I/O，稍快。
- **O_DIRECT** 绕过 Page Cache 直接落盘，数据库自己管缓存时用；普通应用别碰（对齐要求苛刻、性能通常更差）。
- **顺序 vs 随机**：HDD 上差 100 倍以上（寻道），SSD 上差距小很多但仍在（写放大、擦除块）。日志追加写是最友好的模式——这就是 LSM-Tree、WAL 的设计前提。

### 2.6 文件锁

- **flock（劝告锁 advisory lock）**：整文件加锁，需要**所有参与者都主动检查**——不检查的进程照样能写。跨进程互斥的常用手段（如 pid 文件防止服务重复启动）。
- **fcntl 记录锁**：可锁字节范围，NFS 上语义复杂。
- ⚠️ 劝告锁不是强制锁——Linux 的强制锁（mandatory lock）历史包袱重且 5.15 后基本弃用。**别指望用文件锁做安全边界**，它只在协作方之间有效。

## 3. 底层原理：一次 `open + read` 的完整链路

```text
open("/data/app.log", O_RDONLY)
  │
  ├─ VFS(虚拟文件系统层): 统一入口, 屏蔽 ext4/xfs/overlayfs/tmpfs 差异
  ├─ 路径解析: 从 / 开始逐级查 dentry 缓存 → 没命中就读目录数据块
  │            每一级都检查 x 权限; 遇到 symlink 就展开(最多 40 层, 防环)
  ├─ 找到 inode → 权限检查(uid/gid/mode) → 分配打开文件表项(offset=0)
  └─ 在进程 fd 表找最小空闲下标 → 返回该整数 (⚠️ "最小可用"是 POSIX 保证)

read(fd, buf, 4096)
  ├─ fd → 打开文件表项 → 当前 offset → inode → 算出要读第几个数据块
  ├─ 查 Page Cache: 命中 → 直接拷到用户 buf (~μs)
  │                 未命中 → 发起磁盘 I/O(major fault 同源) → 顺带预读后续块 (~百μs-ms)
  └─ offset += 实际读取字节数
```

**性能推论**：路径每深一级就多一次 dentry 查找（有缓存，但深路径+缓存冷时可观）；`open` 比 `read` 贵得多（路径解析+权限+分配），所以**高频访问的文件应该开一次长期持有，而不是每次用完就关**——这与"及时关闭防泄漏"看似矛盾，实则是"长生命周期显式持有 vs 短生命周期即用即关"两种模式的区分。

## 4. 关键工程设计

### 4.1 fd 泄漏：最常见的资源泄漏

fd 是**有限资源**（`ulimit -n`，容器里常见 1024/65536）。泄漏路径：

```go
// ⚠️ 泄漏 1: 错误路径提前 return，跳过了 Close
f, err := os.Open(path)
if err != nil { return err }
data, err := io.ReadAll(f)
if err != nil { return err }        // ← f 泄漏了！
f.Close()

// ⚠️ 泄漏 2: defer 在循环里 —— 全部堆到函数结束才关
for _, p := range paths {
    f, _ := os.Open(p)
    defer f.Close()                  // ← 一万个文件 = 一万个 fd 同时开着
    process(f)
}

// ⚠️ 泄漏 3: HTTP response body 不关(最高频)
resp, _ := http.Get(url)
if resp.StatusCode != 200 { return err }   // ← body 没关, 连接和 fd 都泄漏
// ✅ 正确: err 检查后立刻 defer resp.Body.Close()，且必须读完或 io.Copy(io.Discard, body) 才能复用连接
```

**正确姿势**：`defer f.Close()` 紧跟 open 成功之后；循环体内用**闭包或独立函数**包住，让 defer 在每次迭代结束时生效。

### 4.2 安全路径处理：Sandbox 的第一道防线

Agent 的工具接受用户提供的路径，两类攻击立刻上门：

**攻击 1：路径穿越（path traversal）**
```text
用户传入: "../../../../etc/passwd"  或  "subdir/../../../etc/shadow"
```

**攻击 2：符号链接攻击（symlink attack）**
```text
用户在工作目录里创建: ln -s /etc/passwd innocent.txt
然后请求读取 "innocent.txt" —— 路径检查通过了，读到的却是系统文件
更狠的是 TOCTOU：检查通过后、打开之前，把文件换成符号链接
```

防御必须**两层都做**（示例 [02_safe_path](../code/04_io/02_safe_path/main.go)）：

```go
// 第一层: 路径规范化 + 前缀校验 —— 挡住 ../
clean := filepath.Clean(filepath.Join(root, userPath))
if !strings.HasPrefix(clean, root+string(filepath.Separator)) {
    return errors.New("path escapes root")
}
// ⚠️ 只做这层是不够的: symlink 让"字符串上合法"的路径指向外面

// 第二层: 解析符号链接后再校验 —— 挡住 symlink
real, err := filepath.EvalSymlinks(clean)   // 展开所有链接得到真实路径
if err != nil { return err }
if !strings.HasPrefix(real, realRoot+string(filepath.Separator)) {
    return errors.New("symlink escapes root")
}
// ⚠️ 仍有 TOCTOU 窗口(检查后到打开前可能被换)

// 第三层(最强): 用 O_NOFOLLOW 打开 + openat2(RESOLVE_BENEATH) 内核级保证
// Go 1.24+ 提供 os.OpenRoot / os.Root —— 由内核保证不会逃出 root，无 TOCTOU 窗口
root, err := os.OpenRoot("/sandbox/task-123")
f, err := root.Open(userPath)   // ✅ 内核级约束，符号链接和 .. 都逃不出去
```

⚠️ **版本背景**：`os.Root`（Go 1.24 引入）是目前最干净的方案，底层用 `openat2` 的 `RESOLVE_BENEATH`（Linux 5.6+），无 TOCTOU 窗口。旧版本只能用两层字符串校验 + `O_NOFOLLOW`，并接受残余风险。

### 4.3 任务工作目录的完整生命周期

```go
// Agent 每个任务一个隔离目录，无论成败必须回收
dir, err := os.MkdirTemp(baseDir, "task-"+taskID+"-*")   // 随机后缀防碰撞/预测
if err != nil { return err }
defer os.RemoveAll(dir)          // ⚠️ 这一行不够！进程被 SIGKILL 时 defer 不执行

// 完整方案三层:
// ① defer 兜正常路径和 panic
// ② 信号处理(SIGTERM)时统一清理所有活跃任务目录 (第 02 章优雅退出)
// ③ 启动时扫描 baseDir 清理上次崩溃遗留的孤儿目录(带时间戳判断)
```

配额同样要三层：单文件大小上限（写入时计数截断）、目录总大小上限（周期性 du 或写入计数）、文件数上限（防"生成一百万个小文件"耗尽 inode）。**真正的硬限制在 cgroup/quota 层**（第 11 章）——应用层计数只是第一道软防线。

## 5. Go 语言示例

| 示例 | 演示内容 |
|---|---|
| [01_fd_leak](../code/04_io/01_fd_leak/main.go) | 三种 fd 泄漏构造 + `/proc/self/fd` 计数探测 + 修复对照 |
| [02_safe_path](../code/04_io/02_safe_path/main.go) | 路径穿越/符号链接攻击复现，三层防御逐层验证 |
| [03_workdir_lifecycle](../code/04_io/03_workdir_lifecycle/main.go) | 任务工作目录创建→配额→清理，含孤儿目录回收 |

## 6. 后端开发中的应用

- **日志写入的三档权衡**：不 fsync（快，掉电丢最近数据，绝大多数业务日志用这档）→ 定期 fsync（折中）→ 每条 fsync（金融审计，慢一到两个数量级）。选错档的代价：要么丢数据，要么 QPS 掉十倍。
- **`lsof | grep deleted` 是磁盘满排查的必查项**：日志被 `rm` 了但进程还开着，空间不释放。正解是 `truncate -s 0` 或让程序重开文件（logrotate 的 copytruncate/postrotate 机制）。
- **小文件是文件系统的敌人**：每个文件至少占一个 inode + 一个数据块（4KB）。一亿个 100 字节的文件 = 400GB 磁盘 + inode 耗尽。对象存储/打包合并是正解。

## 7. Agent 开发中的应用

| 场景 | 风险 | 对策 |
|---|---|---|
| 工具读用户指定路径 | 路径穿越读到 `/etc/passwd`、SSH 私钥 | `os.Root` 或三层校验（4.2） |
| 工具在工作目录建符号链接 | 后续操作跟着链接跑到宿主机 | EvalSymlinks 复查 + 挂载 `nosymfollow`（第 11 章） |
| 工具生成海量文件 | inode 耗尽拖垮整机 | 文件数配额 + 独立分区/tmpfs 隔离 |
| 工具写大文件 | 磁盘写满，所有任务受害 | 单任务磁盘配额（cgroup io / xfs quota） |
| 任务被强杀 | 工作目录残留，日积月累占满磁盘 | 三层清理（4.3），启动时扫孤儿 |
| 上传文件处理 | 文件名含 `../`、超长、特殊字符 | 只用随机生成的服务端文件名，原名仅作显示 |

**tmpfs 的妙用**：把任务工作目录挂在 tmpfs（内存文件系统）上——天然大小上限、任务结束卸载即彻底清理、无磁盘 I/O 开销。代价是占内存，要计入 cgroup 内存额度（第 05 章 cgroup 计账）。

## 8. 常见问题与错误设计

**错误 1：用文件存在性做锁。** `if !exists(lockfile) { create(lockfile) }` 是教科书级的 TOCTOU 竞态。正确：`O_CREAT|O_EXCL` 一步原子创建，或用 flock。

**错误 2：假设 `write` 会一次写完。** 管道/socket 上 `write` 可能只写了一部分（short write）。Go 的 `os.File.Write` 内部循环处理，但直接用 `syscall.Write` 就要自己循环。

**错误 3：临时文件用固定名。** `/tmp/myapp.tmp` 会被攻击者预创建成指向敏感文件的符号链接。永远用 `os.CreateTemp`（随机名 + `O_EXCL`）。

**错误 4：以为 Close 的错误可以忽略。** `defer f.Close()` 丢弃了写入文件的最后一次 flush 错误——磁盘满、配额超都在这时才报。写文件时应显式 `if err := f.Close(); err != nil`。

## 9. 排障方法

**案例 A：Too many open files。**
- **现象**：`accept: too many open files`，服务拒绝新连接但 CPU/内存正常。
- **验证**：
  ```bash
  ls /proc/<pid>/fd | wc -l          # 当前 fd 数
  cat /proc/<pid>/limits | grep files # 上限
  lsof -p <pid> | awk '{print $5}' | sort | uniq -c | sort -rn  # 按类型分组: 是 socket 还是 REG?
  lsof -p <pid> | awk '{print $9}' | sort | uniq -c | sort -rn | head  # 哪个文件/地址最多
  ```
- **判决**：大量同名 REG → 文件泄漏；大量 CLOSE_WAIT 的 socket → **对端已关闭而我方没 Close**（最常见，指向 HTTP body 未关或连接池 bug）；数量恰好卡在 1024 → 就是 ulimit 太小。
- **解决**：修泄漏为主，调 ulimit 为辅。⚠️ 只调 ulimit 不修代码 = 把崩溃推迟几小时。

**案例 B：磁盘有空间但写不进去。**
```bash
df -h /data     # 空间充足 → 排除普通满盘
df -i /data     # IUse% 100% → inode 耗尽！
find /data -xdev -type f | wc -l        # 确认文件数量级
find /data -xdev -type d -exec sh -c 'echo "$(ls -U {} | wc -l) {}"' \; | sort -rn | head
lsof +L1        # 另一种可能: 被删除但仍被打开的文件占着空间(nlink=0)
```

## 10. 实验任务

[lab_04_io.md](../labs/lab_04_io.md) 实验 1–4：① fd 表观察与泄漏复现；② inode 耗尽实验；③ 路径穿越与符号链接攻击的三层防御验证；④ Page Cache 与 fsync 的性能对比。

## 11. 面试题（附答题要点）

**Q1：inode 是什么？文件名存在哪里？**
要点：inode 存元数据+数据块指针，**不含文件名**；文件名在目录项里（目录是 `名字→inode号` 的表）。加分：由此推出硬链接（多目录项同 inode，nlink 计数）、mv 同分区为何是 O(1)、删除大文件空间不释放（fd 也是引用）。

**Q2：硬链接和软链接的区别？**
要点：硬链接=同一 inode 的另一个名字，不能跨分区/不能指向目录，删除只减计数；软链接=独立文件，内容是路径字符串，可跨分区/可指目录，目标删了成断链。加分：软链接的 TOCTOU 攻击面 → Sandbox 必须 EvalSymlinks 或 openat2。

**Q3：fd 是什么？fork 后父子的 fd 有什么关系？**
要点：fd 是进程 fd 表的下标；三张表结构（fd 表 → 打开文件表 → inode 表）。fork 复制 fd 表但**共享打开文件表项**——offset 是共享的，一方读了另一方也前进。加分：dup 同理共享，两次 open 各自独立；O_CLOEXEC 防止 fd 意外泄漏给 exec 后的子进程。

**Q4：write 返回成功，数据到磁盘了吗？**
要点：没有——先进 Page Cache 标脏，异步回写。要保证落盘必须 fsync（或 O_SYNC）。加分：fsync vs fdatasync 差元数据；数据库 WAL 的 fsync 是其写入延迟下限；掉电语义与 write barrier。

**Q5：Too many open files 怎么排查？**
要点：先看 `/proc/<pid>/fd` 数量 vs limits；用 lsof 按类型/名称聚合定位泄漏源；重点怀疑 HTTP body 未 Close（表现为大量 CLOSE_WAIT）。加分：区分"真泄漏"和"ulimit 设太小"；只调 limit 不修代码是拖延。

**Q6：磁盘有空间为什么创建不了文件？**
要点：两个原因——① inode 耗尽（`df -i`），格式化时固定，海量小文件的必然结果；② 文件被删但仍被打开（nlink=0 但 fd 在，`lsof +L1`），空间未释放。加分：还有配额（quota）和保留块（ext4 默认给 root 留 5%）。

**Q7：Page Cache 的作用？读文件为什么第二次快？**
要点：内核统一的文件缓存，读命中免磁盘 I/O、写先入缓存后异步刷、顺带预读。第二次快=命中缓存。加分：容器里 Page Cache 计入 cgroup 内存账（第 05 章）；`free` 的 buff/cache 与 available 的关系；drop_caches 只应在测试用。

**Q8：怎么防止路径穿越？**
要点：`filepath.Clean`+前缀校验只挡 `../`，挡不住符号链接；必须 EvalSymlinks 复查；最强是内核级 `openat2(RESOLVE_BENEATH)`，Go 1.24 的 `os.Root` 封装了它，且无 TOCTOU 窗口。加分：指出前两层都有 TOCTOU 窗口——这是"检查与使用之间世界会变"的又一实例（呼应第 04 章 check-then-act）。

## 12. 本章总结

- inode 是文件真身，文件名只是目录里的一行——硬链接、mv、删除不释放空间全由此推出。
- fd 的三层表结构决定了 fork/dup/open 的共享语义差异；fd 是有限资源，泄漏三大源是错误路径、循环 defer、HTTP body。
- write 只到 Page Cache，fsync 才到磁盘——性能与持久性的核心权衡点。
- Sandbox 路径安全要三层：规范化前缀校验 → EvalSymlinks → openat2/os.Root（唯一无 TOCTOU 的方案）。
- 工作目录生命周期要三层清理：defer + 信号处理 + 启动扫孤儿。

**检查清单**：
- [ ] 我能画出三张表并解释 fork/dup/双 open 的 offset 差异
- [ ] 我能说清"rm 了大文件空间没释放"的机制和排查命令
- [ ] 我能手写安全路径校验的三层，并说出各层挡什么、留什么窗口
- [ ] 我能用 lsof 完成一次 fd 泄漏定位（分得清 socket 和 REG）
- [ ] 我的 Runner 工作目录在 SIGKILL 后也不会永久残留

## 13. 延伸阅读

- 《The Linux Programming Interface》第 14–18 章（文件系统/inode/目录）、第 13 章（缓冲与 fsync）
- CSAPP 第 10 章（系统级 I/O）
- Go 1.24 release notes 的 `os.Root` 部分；`man 2 openat2`
- LWN: *Toward race-free directory operations*（openat2 的来龙去脉）
- 下一章 [08 I/O 模型](08_io_model.md)——同样是读写，换成 socket 后的世界
