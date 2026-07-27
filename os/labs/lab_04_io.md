# Lab 04 · 文件与 I/O：从 fd 泄漏到慢客户端

> 配套章节：[07 文件系统](../knowledge/07_file_system.md)、[08 I/O 模型](../knowledge/08_io_model.md) · 配套代码：[`code/04_io`](../code/04_io)
>
> 实验 1–4 对应 07 章，5–7 对应 08 章。标 🐧 的需要 Linux/WSL2。先预测，再验证。

---

## 实验 1：fd 表观察与泄漏复现 🐧

**目的**：把"fd 是进程 fd 表的下标"从定义变成能看的目录。

```bash
cd <repo>/os/code && go run ./04_io/01_fd_leak
```

**预期观察**：`/proc/self/fd` 里每个 fd 是一个符号链接，指向它打开的文件/socket/pipe；三种泄漏各留下可数的增量。

**手工加深**——观察三张表的共享语义：
```bash
# 开一个进程持有文件, 观察 fd 与 offset
exec 9< /etc/hosts          # 用 fd 9 打开
ls -l /proc/$$/fd/9         # 看到 9 → /etc/hosts
cat /proc/$$/fdinfo/9       # pos: 当前 offset, flags: 打开标志
head -c 10 <&9 > /dev/null  # 读 10 字节
cat /proc/$$/fdinfo/9       # pos 变成 10 —— 这就是"打开文件表项"里的 offset
exec 9<&-                   # 关闭
```

**思考题**：`fork` 之后父子的 fd 9 共享同一个 offset 吗？两次 `open` 同一文件呢？（提示：07 章 §2.2 的表格——fork/dup 共享打开文件表项，两次 open 各自独立）

## 实验 2：inode 耗尽——磁盘有空间却写不进去 🐧

**目的**：亲手复现"报错和现象完全对不上"的经典陷阱。

```bash
# 造一个只有 128 个 inode 的小文件系统
dd if=/dev/zero of=/tmp/small.img bs=1M count=8
mkfs.ext4 -N 128 -F /tmp/small.img
sudo mkdir -p /mnt/inodelab && sudo mount /tmp/small.img /mnt/inodelab
sudo chmod 777 /mnt/inodelab

df -h /mnt/inodelab      # 空间: 还有好几 MB
df -i /mnt/inodelab      # inode: 只有 128 个

for i in $(seq 1 200); do touch /mnt/inodelab/f$i 2>&1 | head -1; done
# → touch: cannot touch 'f117': No space left on device   ← 空间明明还有！
df -h /mnt/inodelab && df -i /mnt/inodelab

sudo umount /mnt/inodelab && rm /tmp/small.img
```

**预期观察**：`df -h` 显示大量剩余空间，`df -i` 的 IUse% 到 100%，报错却是 "No space left"。

**思考题**：Agent 的工具生成了一百万个小文件，会先耗尽什么？怎么防？（提示：07 章 §7 文件数配额 + 独立分区/tmpfs 隔离）

**补充实验**——被删除但仍被打开的文件：
```bash
python3 -c "
import os, time
f = open('/tmp/bigfile', 'wb'); f.write(b'x' * (100<<20)); f.flush()
os.remove('/tmp/bigfile')     # 删了文件名, 但 fd 还开着
print('已删除文件名, 但空间未释放。另开终端: lsof +L1 | grep bigfile')
time.sleep(20)"
# 另一个终端: df -h /tmp 看空间; lsof +L1 找 nlink=0 的文件
```

## 实验 3：路径穿越与符号链接攻击

```bash
cd <repo>/os/code && go run ./04_io/02_safe_path
```

**预期观察**：
- 攻击 A（`../../etc/passwd`）：三层全部拦截；
- 攻击 B（符号链接）：**层 1 放行、层 2/3 拦截**——这一行就是本实验的全部价值，说明只做字符串校验是不够的。

**手工加深**：
```bash
mkdir -p /tmp/sandbox && cd /tmp/sandbox
ln -s /etc/passwd innocent.txt
# 字符串上它就在 sandbox 里:
python3 -c "
import os.path
print(os.path.abspath('innocent.txt'))          # /tmp/sandbox/innocent.txt —— 看起来很安全
print(os.path.realpath('innocent.txt'))         # /etc/passwd —— 真相
"
cat innocent.txt | head -2                      # 读到的是系统文件
cd / && rm -rf /tmp/sandbox
```

**思考题**：层 2 的 TOCTOU 窗口具体在哪两行代码之间？攻击者需要什么条件才能利用它？（提示：EvalSymlinks 返回后到 os.Open 之前；需要能在 sandbox 内创建文件——而这正是工作目录的定义）

## 实验 4：Page Cache 与 fsync 的代价 🐧

**目的**：量化"write 只到缓存"和"fsync 到磁盘"的差距。

```bash
# ① 第一次读 vs 第二次读（Page Cache 命中）
dd if=/dev/zero of=/tmp/pc.dat bs=1M count=512 2>/dev/null
sync && sudo sh -c 'echo 3 > /proc/sys/vm/drop_caches'   # 清空缓存
echo "冷读:"; time cat /tmp/pc.dat > /dev/null
echo "热读:"; time cat /tmp/pc.dat > /dev/null           # 快一个数量级

# ② write vs write+fsync
echo "不 fsync:"; time dd if=/dev/zero of=/tmp/w1.dat bs=4k count=10000 2>&1 | tail -1
echo "每次 fsync:"; time dd if=/dev/zero of=/tmp/w2.dat bs=4k count=10000 conv=fsync 2>&1 | tail -1
echo "oflag=dsync(每块同步):"; time dd if=/dev/zero of=/tmp/w3.dat bs=4k count=1000 oflag=dsync 2>&1 | tail -1

# ③ 观察脏页
grep -E 'Dirty|Writeback' /proc/meminfo
rm -f /tmp/pc.dat /tmp/w*.dat
```

**预期观察**：热读比冷读快一个数量级；`oflag=dsync`（每块都同步）比不 fsync 慢几十到上百倍——这就是数据库写入延迟的物理下限。

**思考题**：业务日志该用哪一档？金融交易流水呢？（提示：07 章 §6 三档权衡）

## 实验 5：裸 epoll vs net 包 🐧

**目的**：看清 netpoller 替你扛下了什么。

```bash
cd <repo>/os/code
# 终端 1
go run ./04_io/04_epoll_echo
# 终端 2
nc localhost 9099        # 随便输入几行, 看回显
# 终端 3: 观察系统调用
strace -f -p $(pgrep -f 04_epoll_echo | head -1) -e trace=epoll_wait,epoll_ctl,read,write 2>&1 | head -30
```

再跑 net 包版本对照：
```bash
go run ./04_io/04_epoll_echo -net
strace -f -p <pid> -e trace=epoll_wait,epoll_ctl,read,write,futex 2>&1 | head -30
```

**预期观察**：两者的 epoll 调用模式高度相似——**net 包版本底层也是 epoll**，只是被 runtime 封装成了同步 API。net 版还会看到 futex（goroutine 调度）。

**思考题**：裸版里 `for { read() until EAGAIN }` 这个循环，在 net 包版本里对应什么？（提示：runtime 的 gopark/goready + netpoll，08 章 §3 五步链路）

## 实验 6：慢客户端的内存堆积

```bash
cd <repo>/os/code && go run ./04_io/05_slow_client
```

**预期观察**：全量缓冲版堆峰值 ≈ 响应大小 × 客户端数（约 160MB），流式版几乎不涨；**两者的 goroutine 数量相同**——这是本实验最关键的一点：问题不在 goroutine 多，在它们抓着的数据。

**思考题**：为什么这个场景下 `pprof goroutine` 看不出问题，只有 `pprof heap` 能看出来？线上遇到这种画像该先查什么？（提示：08 章 §9 的 `ss -ntp` 看 Send-Q）

## 实验 7：ss 读懂队列 🐧

**目的**：学会用一条命令区分"应用读得慢"和"对端收得慢"。

```bash
# 起一个不读数据的服务端(模拟应用读得慢)
python3 -c "
import socket, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', 9100)); s.listen(5)
c, _ = s.accept()
print('已接受连接但故意不读数据...')
time.sleep(60)" &
sleep 1
# 客户端猛灌数据
python3 -c "
import socket
c = socket.socket(); c.connect(('127.0.0.1', 9100))
try:
    for _ in range(1000): c.send(b'x' * 65536)
except: pass
print('灌完/被阻塞')" &
sleep 2
ss -ntp | grep 9100     # 看两端的 Recv-Q / Send-Q
kill %1 %2 2>/dev/null
```

**预期观察**：服务端侧 **Recv-Q 很大**（数据到了内核但应用不读）；客户端侧 **Send-Q 可能也大**（发不出去堆在本地）。

**判读口诀**：
- **Recv-Q 大** = 应用读得慢（业务处理慢、goroutine 卡住）
- **Send-Q 大** = 对端收得慢或网络差（慢客户端、带宽不足）
- **Accept 队列满**（`ss -ltn` 的 Recv-Q vs Send-Q 列，监听 socket 语义不同）= 服务端 accept 不过来

---

## 验收清单

- [ ] 我能用 `/proc/<pid>/fd` 和 `fdinfo` 观察 fd 与 offset，说清 fork/dup/双 open 的差异
- [ ] 我亲手复现过 inode 耗尽和"删除后空间不释放"，知道各自的排查命令
- [ ] 我验证过符号链接能绕过字符串校验，能指出层 2 的 TOCTOU 窗口在哪
- [ ] 我量化过 Page Cache 命中和 fsync 的代价，能为不同业务选对持久化档位
- [ ] 我对照过裸 epoll 与 net 包的 strace，能讲出 netpoller 的五步链路
- [ ] 我复现过慢客户端 OOM，理解"goroutine 数正常但内存爆"的画像
- [ ] 我能用 `ss` 的 Recv-Q/Send-Q 区分应用慢和对端慢
