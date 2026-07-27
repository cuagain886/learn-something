# Lab 01 | 抓 TCP 三次握手与四次挥手

> 配套章节：[05 TCP 连接管理与状态机](../knowledge/05_tcp_connection.md) · 难度 ★★★ · 预计耗时 90~120 分钟
> 关键 RFC：**RFC 9293**（TCP 现行标准，2022 年取代 RFC 793）、RFC 7323（窗口缩放与时间戳）、RFC 2018（SACK）

---

## 1. 实验目标

做完本实验，你应当能够**在自己抓的包里**：

1. 一眼认出三次握手（three-way handshake）的三个包，说出每个包的 `Flags`、`seq`、`ack` 为什么是那个值。
2. 指出 MSS、窗口缩放（window scale）、SACK permitted、时间戳这四个选项**分别在哪个包里协商**，以及"只在 SYN 里出现"的后果。
3. 解释 SYN 和 FIN 为什么各占 **1 个序列号**（俗称"幽灵字节"/phantom byte），并用 `ack` 的数值反推验证。
4. 区分**相对序列号**（relative sequence number，工具算出来的）与**绝对序列号**（absolute，线上真实值），并让 tcpdump / Wireshark 分别显示它们。
5. 抓到完整的四次挥手，判断**谁是主动关闭方**（active closer），并解释你抓到的为什么常常只有"三次"。
6. 说清 loopback 抓包、TSO/GRO 卸载、WSL2 与 Windows 抓包边界这三类"抓不到 / 抓错了"的坑。

### 前置条件

| 项 | 要求 | 检查命令 |
|----|------|----------|
| 读过 | `knowledge/05_tcp_connection.md` 的状态机小节 | — |
| WSL2 | Ubuntu，能 `sudo` | `wsl -l -v` 应显示 `Ubuntu ... 2` |
| Windows | Wireshark 4.x + Npcap（安装时勾选 loopback 支持） | 开 Wireshark 看接口列表里有没有 `Adapter for loopback traffic capture` |
| 网络 | 能出网访问 `example.com` 的 **80 端口**（http，不是 https） | `curl -4 -sI http://example.com \| head -1` |

⚠️ 本实验**必须用 http 不用 https**。HTTPS 的握手之后紧跟 TLS 握手，包一多就淹没了 TCP 层的细节；TLS 抓包留到 [lab_05](lab_05_tls_capture.md)。

---

## 2. 环境准备

### 2.1 WSL2（Ubuntu）：装 tcpdump

```bash
sudo apt-get update && sudo apt-get install -y tcpdump
tcpdump --version                                    # 期望 4.99.x / libpcap 1.10.x

# 抓包需要 CAP_NET_RAW，默认只有 root 有。要么每次 sudo，要么给二进制加 capability：
sudo setcap cap_net_raw,cap_net_admin=eip "$(readlink -f "$(which tcpdump)")"
```

⚠️ **Debian/Ubuntu 的 tcpdump 会主动降权**到 `tcpdump` 用户，再加上 AppArmor 策略，`-w` 写文件到 `$HOME` 或 `/mnt/c/...` 经常报 `Permission denied`。**统一写到 `/tmp`**，或者加 `-Z root` 关掉降权：

```bash
sudo tcpdump -i eth0 -nn -w /tmp/hs.pcap 'tcp port 80'      # ✅
sudo tcpdump -i eth0 -nn -w ~/hs.pcap    'tcp port 80'      # ⚠️ 可能被拒
```

### 2.2 Windows：Wireshark + Npcap

- 安装 Wireshark 时**必须**勾选 Npcap，并在 Npcap 安装页保留 `Support loopback traffic ("Npcap Loopback Adapter")`。老的 WinPcap 完全不支持 loopback。
- 命令行也可用（`tshark`/`dumpcap` 与 tcpdump 的过滤语法一致）：

```powershell
& "C:\Program Files\Wireshark\tshark.exe" -D                      # 列出接口编号
& "C:\Program Files\Wireshark\tshark.exe" -i 5 -f "tcp port 80" -w C:\Temp\hs.pcapng
```

### 2.3 ⚠️ 最容易踩的坑：WSL2 的流量在 Windows 侧抓不到

这一条单独拎出来，因为它会让你"抓了半小时空包"：

```text
┌──────────────── Windows 主机 ────────────────┐
│  Wireshark 能抓到:                            │
│    · 物理网卡 (Wi-Fi / 以太网)  ← Windows 自己的流量
│    · Npcap Loopback Adapter    ← Windows 的 127.0.0.1
│    · vEthernet (WSL)           ← WSL2 出入的流量(NAT 模式)
│                                               │
│   ┌───────── WSL2 (Hyper-V 轻量虚拟机) ─────┐ │
│   │  tcpdump 能抓到:                        │ │
│   │    · eth0  ← WSL 出入的流量             │ │
│   │    · lo    ← WSL 内部的 127.0.0.1       │ │
│   └─────────────────────────────────────────┘ │
└───────────────────────────────────────────────┘
```

- 在 **WSL2 里** `curl`，就在 **WSL2 里** `tcpdump -i eth0`。跑到 Windows 的 Wi-Fi 网卡上抓是抓不到的（NAT 模式下要抓 `vEthernet (WSL)`，而且已经过了一层 NAT，源地址被改写）。
- WSL2 的 `127.0.0.1` 和 Windows 的 `127.0.0.1` **是两个不同的回环栈**。Windows 能访问 WSL 的监听端口，靠的是 WSL 的 localhost 转发中继（relay），不是同一个协议栈——所以在 WSL 里看到的对端地址是中继的地址，不是 Windows 进程的真实端口。
- 本机的 `.wslconfig` 若配置了 `networkingMode=mirrored`（镜像模式），上面的边界会变（WSL 与 Windows 共享网络视图）。**验证方法**：WSL 里 `ip addr show eth0`，NAT 模式典型是 `172.x.x.x`，镜像模式则与 Windows 网卡同网段。

---

## 3. 抓包命令速查

### 3.1 tcpdump 参数：每个都解决一个具体问题

| 参数 | 解决什么问题 | 不加会怎样 |
|------|--------------|-----------|
| `-i eth0` | 指定接口。`-i any` 抓全部，`-i lo` 抓回环 | 默认挑第一个 up 的接口，常常挑错 |
| `-nn` | 不做 IP→域名、端口→服务名的反解 | 每个包触发一次 DNS 查询，**污染你正在抓的流量**，还会卡顿 |
| `-S` | 打印**绝对序列号** | 默认打印相对序列号（第一个包置 0），看不到真实 ISN |
| `-v` / `-vv` | 显示 IP TTL、id、总长、TCP 校验和 | 判断分片和路径跳数时信息不够 |
| `-w /tmp/x.pcap` / `-r /tmp/x.pcap` | 存盘 / 读回（可反复换过滤条件重放） | 只能在终端一次性读完，无法回溯 |
| `-c 20` | 抓够 20 个包自动退出 | 要手动 Ctrl-C，容易多抓一堆噪声 |
| `-ttt` | 显示与**上一个包**的时间差 | 默认绝对时间戳，算 RTT 要自己减 |
| `-A` / `-X` | 以 ASCII / 十六进制打印载荷 | 看不到 HTTP 请求行内容 |

⚠️ `-i any` 在 Linux 上用的是 **Linux cooked capture（SLL）** 链路类型，**没有以太网头**。要看 MAC 地址必须指定具体接口。

### 3.2 BPF 抓包过滤 vs Wireshark 显示过滤——两套语法，别混

这是新手最常见的困惑：

| | 抓包过滤（capture filter, BPF） | 显示过滤（display filter） |
|---|---|---|
| 用在哪 | `tcpdump '表达式'`、Wireshark 启动界面的过滤框、`tshark -f` | Wireshark 主界面顶部的绿色框、`tshark -Y` |
| 何时生效 | **抓之前**，内核层丢弃不匹配的包 | **抓之后**，只影响显示 |
| 性能 | 高流量下必须用，否则丢包 | 不影响抓包 |
| 语法 | `tcp port 80 and host 1.2.3.4` | `tcp.port == 80 && ip.addr == 1.2.3.4` |
| 能不能后悔 | 不能，没抓的就没了 | 能，随时改 |

**建议**：抓包过滤写宽一点（只按端口/主机粗筛），显示过滤写细一点。

### 3.3 常用过滤表达式对照表

| 想看什么 | tcpdump（BPF） | Wireshark（显示过滤） |
|----------|----------------|----------------------|
| 只看纯 SYN（发起握手） | `'tcp[tcpflags] & tcp-syn != 0 and tcp[tcpflags] & tcp-ack == 0'` | `tcp.flags.syn==1 && tcp.flags.ack==0` |
| 只看 SYN-ACK | `'tcp[tcpflags] & (tcp-syn\|tcp-ack) == (tcp-syn\|tcp-ack)'` | `tcp.flags.syn==1 && tcp.flags.ack==1` |
| 所有 FIN | `'tcp[tcpflags] & tcp-fin != 0'` | `tcp.flags.fin==1` |
| 所有 RST | `'tcp[tcpflags] & tcp-rst != 0'` | `tcp.flags.reset==1` |
| 握手 + 挥手（排除纯数据） | `'tcp[tcpflags] & (tcp-syn\|tcp-fin\|tcp-rst) != 0'` | `tcp.flags.syn==1 \|\| tcp.flags.fin==1 \|\| tcp.flags.reset==1` |
| 某条连接的全部包 | `'host 93.184.216.34 and port 80'` | `tcp.stream eq 0` |
| 重传 | 无（tcpdump 不做分析） | `tcp.analysis.retransmission` |
| 对端通告的 MSS | 需 `-v` 肉眼看 options | `tcp.options.mss_val` |
| 窗口缩放后的真实窗口 | 无（需自己算） | `tcp.window_size`（已缩放）对比 `tcp.window_size_value`（原始字段） |
| 零窗口 | 无 | `tcp.analysis.zero_window` |

⚠️ 在 PowerShell / bash 里 `|` 是管道符，BPF 表达式里的 `|` **必须整体加单引号**，否则 shell 会先把它当管道解析。

---

## 4. 步骤 A：抓一次完整的三次握手

### 4.1 起抓

WSL2 里开**两个终端**。终端 1 抓包：

```bash
# -c 20 抓够 20 个包自动停；-ttt 显示包间时间差，方便量 RTT
sudo tcpdump -i eth0 -nn -S -ttt -c 20 -w /tmp/hs.pcap 'tcp port 80 and host example.com'
```

终端 2 产生流量：

```bash
# -4 强制 IPv4（避免走 IPv6 让过滤条件失配）
# -v 打印协议交互
# --no-keepalive 让 curl 请求完就关连接，方便同时抓到挥手
curl -4 -v --no-keepalive http://example.com/ -o /dev/null
```

抓完读回来（`-r` 可以反复重放，换参数不用重抓）：

```bash
tcpdump -r /tmp/hs.pcap -nn -S -ttt
```

### 4.2 备选流量源：用本仓库的示例服务

不方便出网时，用 `net/code/03_tcp_states` 起一个本地服务（抓 `-i lo`）：

```bash
cd net/code/03_tcp_states
go run . -mode server -addr 127.0.0.1:9000 &      # 正常回显服务
sudo tcpdump -i lo -nn -S -c 20 'tcp port 9000' & # 注意是 lo 不是 eth0
go run . -mode client -addr 127.0.0.1:9000        # 建连、发一行、关闭
```

⚠️ 该目录尚未生成时的**兜底方案**（纯 shell，效果等价）：

```bash
# 终端 1：一个最小 TCP 服务
nc -l -p 9000 &
# 终端 2：抓包
sudo tcpdump -i lo -nn -S -c 20 'tcp port 9000'
# 终端 3：连一下就断
printf 'hello\n' | nc -q0 127.0.0.1 9000
```

---

## 5. 逐包解读

### 5.1 tcpdump 的 Flags 记号

tcpdump 用单字符缩写表示标志位，`.` 单独出现代表"只有 ACK"：

| 记号 | 含义 | 出现场景 |
|------|------|----------|
| `[S]` | SYN | 握手第 1 包 |
| `[S.]` | SYN + ACK | 握手第 2 包 |
| `[.]` | 纯 ACK | 握手第 3 包、确认数据 |
| `[P.]` | PSH + ACK | 带数据的包（PSH 提示对端尽快上交应用） |
| `[F.]` | FIN + ACK | 挥手，几乎不会有纯 `[F]` |
| `[R]` / `[R.]` | RST / RST+ACK | 连接被拒或异常关闭 |
| `[FP.]` | FIN + PSH + ACK | 最后一段数据和 FIN 合在一个包里 |

### 5.2 示例输出（⚠️ 这是**示例**，你抓到的 IP、端口、序列号一定不同）

```text
 00:00:00.000000 IP 172.24.113.5.51514 > 93.184.216.34.80: Flags [S], seq 1580274191,
                    win 64240, options [mss 1460,sackOK,TS val 3892015561 ecr 0,nop,wscale 7], length 0
 00:00:00.187442 IP 93.184.216.34.80 > 172.24.113.5.51514: Flags [S.], seq 2456123001, ack 1580274192,
                    win 65535, options [mss 1440,sackOK,TS val 1194785012 ecr 3892015561,nop,wscale 9], length 0
 00:00:00.000061 IP 172.24.113.5.51514 > 93.184.216.34.80: Flags [.], ack 2456123002,
                    win 502, options [nop,nop,TS val 3892015623 ecr 1194785012], length 0
 00:00:00.000180 IP 172.24.113.5.51514 > 93.184.216.34.80: Flags [P.], seq 1580274192:1580274268,
                    ack 2456123002, win 502, options [nop,nop,TS val 3892015623 ecr 1194785012], length 76: HTTP: GET / HTTP/1.1
 00:00:00.186903 IP 93.184.216.34.80 > 172.24.113.5.51514: Flags [.], ack 1580274268,
                    win 128, options [nop,nop,TS val 1194785199 ecr 3892015623], length 0
 00:00:00.001204 IP 93.184.216.34.80 > 172.24.113.5.51514: Flags [P.], seq 2456123002:2456124584,
                    ack 1580274268, win 128, length 1582: HTTP: HTTP/1.1 200 OK
```

### 5.3 第 1 包：SYN

```text
IP 172.24.113.5.51514 > 93.184.216.34.80: Flags [S], seq 1580274191, win 64240,
   options [mss 1460,sackOK,TS val 3892015561 ecr 0,nop,wscale 7], length 0
```

- `172.24.113.5.51514` — 源 IP.源端口。**最后一段点号后面是端口**，不是 IP 的第五段。`51514` 是内核从临时端口范围（ephemeral port range）里挑的。
- `Flags [S]` — 只有 SYN，说明这是**主动打开**（active open）的第一步。客户端此刻进入 `SYN_SENT`。
- `seq 1580274191` — 初始序列号（ISN, Initial Sequence Number）。**它是随机的**：RFC 9293 §3.4.1 要求 ISN 用带时钟和密钥的方式生成，防止旧连接的残包被错误接收、也防序列号预测攻击。所以每次抓这个数都不一样。
- `win 64240` — 通告的接收窗口原始字段值。**注意：SYN 包里的 win 不受窗口缩放影响**（缩放要等双方都确认支持后才生效），所以这里是真实的 64240 字节。
- `length 0` — 没有应用数据。⚠️ 但它**消耗 1 个序列号**（见 5.6）。
- `options [...]` — 四个选项全在这里，下一节细讲。

### 5.4 第 2 包：SYN-ACK

```text
IP 93.184.216.34.80 > 172.24.113.5.51514: Flags [S.], seq 2456123001, ack 1580274192, ...
```

- `Flags [S.]` = SYN + ACK。服务端此刻在 `SYN_RCVD`（Linux 显示为 `SYN-RECV`）。
- `seq 2456123001` — 服务端自己的 ISN，**与客户端的 ISN 毫无关系**。两个方向是两条独立的字节流，各有各的编号。
- `ack 1580274192` = 客户端 ISN + 1 = `1580274191 + 1`。**这个 +1 就是 SYN 占的那 1 个序列号。**
- 时间差 `0.187442` 秒 ≈ 一个 RTT。⚠️ 这是**唯一可以用抓包直接量到 RTT** 的地方之一，另一个是数据包与其 ACK 的间隔（但会被延迟确认干扰）。

### 5.5 第 3 包：ACK

```text
IP 172.24.113.5.51514 > 93.184.216.34.80: Flags [.], ack 2456123002, win 502,
   options [nop,nop,TS val ... ecr ...], length 0
```

- `ack 2456123002` = 服务端 ISN + 1。至此双向都确认了对方的 ISN，**两端都进入 ESTABLISHED**。
- 客户端发出这个包就认为连接建立好了（`connect()` 返回）；服务端要**收到**这个包才把连接挪进 accept 队列（`accept()` 才能返回）。这个半包的时间差是"客户端已连上但服务端还没 accept"的根源，也是 [lab_03](lab_03_time_wait_close_wait.md) 实验 C 的基础。
- `win 502` — ⚠️ **重点**：这已经是缩放后的编码值。真实窗口 = `502 << 7 = 64256` 字节（7 是第 1 包里通告的 `wscale 7`）。**tcpdump 不替你做这个乘法**，Wireshark 会（前提是它抓到了握手，见 5.8）。
- 选项只剩 `nop,nop,TS`：MSS、wscale、sackOK **只在 SYN/SYN-ACK 里出现一次**，之后每个包都带的只有时间戳（TS）。

### 5.6 幽灵字节：SYN 和 FIN 为什么各占 1 个序列号

**结论**：SYN 和 FIN 在序列号空间里各占 1 个字节的位置，但**不传输任何真实数据**。RFC 9293 §3.4 的原话是这两个控制标志"占用序列号空间中的一个八位组（octet）"。

**为什么必须这样设计？** 因为 TCP 的可靠性完全建立在"序列号 + 确认号"之上：

```text
如果 SYN 不占序列号：
  客户端: SYN seq=100
  服务端: SYN-ACK seq=500, ack=100    ← ack=100 表示"我期待收到 100"
  客户端: 这个 ack 到底是在确认我的 SYN，还是在说"你还没发过东西"？
          分不清 → SYN 丢失时无法判断该不该重传。

SYN 占 1 个序列号后：
  服务端: SYN-ACK ack=101             ← "101 之前的我都收到了" = SYN 已确认
          语义唯一，重传逻辑与普通数据完全统一。
```

**自己动手验证**（这是本实验的核心动作）：

```bash
# 提取所有 SYN 和它的 ACK，手算差值
tcpdump -r /tmp/hs.pcap -nn -S 'tcp[tcpflags] & (tcp-syn|tcp-fin) != 0'
```

对着输出算：`SYN-ACK 的 ack` − `SYN 的 seq` 必须**恰好等于 1**。FIN 同理：`对 FIN 的 ACK` − `FIN 的 seq` = 1（前提是那个 FIN 包 `length 0`；若是 `[FP.]` 带了 N 字节数据，则差值 = N + 1）。

**推论**（面试高频）：一个连接从建立到关闭，序列号总共前进 = `发送的字节数 + 1(SYN) + 1(FIN)`。

### 5.7 相对序列号 vs 绝对序列号

| | 绝对序列号 | 相对序列号 |
|---|---|---|
| 是什么 | 线上真实传输的 32 位值，从随机 ISN 开始 | 工具把 ISN 当作 0 重新编号后的值 |
| tcpdump | 加 `-S` | **默认**（tcpdump 记住每条流的 ISN 后自动换算） |
| Wireshark | Preferences → Protocols → TCP → **取消勾选** `Relative sequence numbers` | **默认勾选** |
| 好处 | 与线上字节一致；能看到 ISN 随机性；抓不到握手时唯一可信 | 可读性极高，`seq 1` 就是第一个数据字节 |

⚠️ **两个必须知道的陷阱**：

1. **抓不到握手时，相对序列号会骗你**。工具是靠"这条流的第一个包"推断 ISN 的。如果你在连接建立后才开始抓包，它会把看到的第一个包当成起点，算出来的相对序列号毫无意义（还可能把正常包标成"乱序"）。**排障线上长连接时，一律用绝对序列号。**
2. **相对序列号会掩盖序列号回绕（wraparound）**。序列号是 32 位，约 4 GiB 就绕回 0。万兆链路上几秒就绕一圈——这正是 RFC 7323 时间戳选项（PAWS，Protection Against Wrapped Sequence numbers）存在的理由。

### 5.8 三个选项在哪个包里协商

```text
                     SYN         SYN-ACK      之后的每个包
  MSS               ✅ 通告      ✅ 通告       ❌ 不再出现
  Window Scale      ✅ 通告      ✅ 通告       ❌ 不再出现（但一直生效）
  SACK permitted    ✅ 通告      ✅ 通告       ❌（真正的 SACK 块在丢包时才出现）
  Timestamps        ✅ 通告      ✅ 通告       ✅ 每包都带（各 10 字节）
```

**MSS（Maximum Segment Size，RFC 9293 §3.7.1）**

- 每一端通告的是"**我愿意接收**的最大段大小"，**不是**双方协商取最小值。示例里客户端说 1460、服务端说 1440，那么：客户端发往服务端的段 ≤ 1440，服务端发往客户端的段 ≤ 1460。**方向不同、取值不同。**
- 1460 = 1500(以太网 MTU) − 20(IPv4 头) − 20(TCP 头)。服务端的 1440 通常意味着它前面隔着 PPPoE(−8) 或某种隧道。
- ⚠️ 实际每段载荷还要再减去选项。开了时间戳（10 字节 + 2 字节 padding = 12）后，实际载荷是 1448 而不是 1460——**"为什么我的包总是 1448 字节"的答案就在这里**。

**Window Scale（RFC 7323 §2）**

- `wscale 7` 表示"我通告的窗口值请左移 7 位（×128）来理解"。最大 shift 是 14，窗口上限约 1 GiB。
- ⚠️ **只要有一端的 SYN 里没有 wscale，两个方向的缩放全部关闭**，窗口被卡在 65535 字节。跨洋链路 RTT 200ms 时，吞吐上限 = 65535 / 0.2s ≈ 2.6 Mbps——万兆专线跑出 2 Mbps 的经典事故就是这么来的（老防火墙剥掉 SYN 选项是常见元凶）。
- 两个方向的 shift **可以不同**（示例里客户端 7、服务端 9）。

**SACK permitted（RFC 2018）**

- 只是声明"我支持选择性确认"。丢包时接收方才会在 ACK 里带 `sack` 块，告诉发送方"我收到了 X:Y 这一段"，避免把整个窗口全部重传。
- 验证：Wireshark 显示过滤 `tcp.options.sack_le`。没丢包就抓不到，属正常。

---

## 6. 步骤 B：四次挥手与"三次挥手"现象

### 6.1 抓挥手

curl 拿完响应就关连接，所以 4.1 的抓包里通常已经包含挥手。单独筛出来：

```bash
tcpdump -r /tmp/hs.pcap -nn -S 'tcp[tcpflags] & (tcp-fin|tcp-rst) != 0'
```

典型的**四包**形态（⚠️ 示例输出）：

```text
IP 172.24.113.5.51514 > 93.184.216.34.80: Flags [F.], seq 1580274268, ack 2456124584, win 501, length 0
IP 93.184.216.34.80 > 172.24.113.5.51514: Flags [.],  ack 1580274269,                  win 128, length 0
IP 93.184.216.34.80 > 172.24.113.5.51514: Flags [F.], seq 2456124584, ack 1580274269, win 128, length 0
IP 172.24.113.5.51514 > 93.184.216.34.80: Flags [.],  ack 2456124585,                  win 501, length 0
```

判定**谁是主动关闭方**：**第一个发 FIN 的就是**。它随后会进入 `TIME_WAIT` 并停留 2MSL——这条推断链是 [lab_03](lab_03_time_wait_close_wait.md) 的全部起点。

### 6.2 为什么你抓到的常常只有三个包

大量情况下第 2、3 包会合并，看起来像"三次挥手"：

```text
IP A > B: Flags [F.], seq u,   ack v,   length 0      ← A 说"我发完了"
IP B > A: Flags [F.], seq v,   ack u+1, length 0      ← B 一个包同时干两件事:
                                                        ① ack=u+1 确认 A 的 FIN
                                                        ② FIN 宣布自己也发完了
IP A > B: Flags [.],  ack v+1,          length 0      ← A 确认 B 的 FIN
```

**原因**：TCP 的"四次"是**语义上的四步**（`FIN(A) → ACK(A的FIN) → FIN(B) → ACK(B的FIN)`），不是**线上必须四个包**。中间两步都由 B 发出，当 B 侧应用**没有剩余数据要发**、且**在延迟确认（delayed ACK，Linux 默认最多 40ms）的窗口内完成了 `close()`**，内核还没来得及单独发 ACK 就发现可以和 FIN 一起发，两步便被捎带确认（piggyback）合并成一个包。

**真·四个包**的两种典型场景：① B 是"半关闭"用法，收到 FIN 后还要继续发数据（HTTP 服务端边收边回就是这样）；② **B 的应用有 bug 迟迟不 `close()`**——你会看到 ACK 之后长时间没有 FIN，B 停在 `CLOSE_WAIT`。

**排障价值**：抓到"ACK 来了但 FIN 迟迟不来"，就等于抓到了 CLOSE_WAIT 现场，可以直接下结论"对端应用没调 close"——正是 [lab_03](lab_03_time_wait_close_wait.md) 实验 B 要复现的故障。

### 6.3 ASCII 时序图（含状态迁移）

```text
       客户端(主动打开/主动关闭)                          服务端(被动打开/被动关闭)
            CLOSED                                              CLOSED
              │                                                   │ listen()
              │                                                LISTEN
   connect()  │                                                   │
              │ ①  [S]   seq=x                                    │
              ├──────────────────────────────────────────────────▶│
          SYN_SENT      options: mss/sackOK/TS/wscale          SYN_RCVD
              │                                                   │
              │ ②  [S.]  seq=y  ack=x+1                           │
              │◀──────────────────────────────────────────────────┤
        ESTABLISHED     options: mss/sackOK/TS/wscale             │
              │                                                   │
              │ ③  [.]   ack=y+1        ← 此包起窗口缩放生效      │
              ├──────────────────────────────────────────────────▶│
              │                                             ESTABLISHED  ← accept() 返回
              │                                                   │
              │ ══════════════ 数据传输（seq 从 x+1 开始）═════════│
              │                                                   │
   close()    │ ①  [F.]  seq=u                                    │
              ├──────────────────────────────────────────────────▶│
        FIN_WAIT_1                                          CLOSE_WAIT ←── ⚠️ 应用不 close()
              │                                                   │      就永远卡在这里
              │ ②  [.]   ack=u+1                                  │
              │◀──────────────────────────────────────────────────┤
        FIN_WAIT_2         ② ③ 常合并成一个 [F.] 包      close()  │
              │                                                   │
              │ ③  [F.]  seq=v  ack=u+1                           │
              │◀──────────────────────────────────────────────────┤
              │                                              LAST_ACK
              │ ④  [.]   ack=v+1                                  │
              ├──────────────────────────────────────────────────▶│
         TIME_WAIT                                             CLOSED
              │ 等 2MSL(协议标准 4 分钟 / Linux 固定 60 秒)
            CLOSED
```

---

## 7. 在 Wireshark 里做同一件事

1. 把 `/tmp/hs.pcap` 拷到 Windows：`cp /tmp/hs.pcap /mnt/c/Temp/`，双击打开。
2. 右键任一包 → **Follow → TCP Stream**：自动加上 `tcp.stream eq N` 过滤，只剩这一条连接。
3. **Statistics → Flow Graph**，勾选 `Limit to display filter` + `TCP Flows`：自动生成时序图，和 6.3 的手绘图一一对应。
4. 想看真实窗口：点开 TCP 层 → `Window` 是原始字段值，`Calculated window size` 是缩放后的值，`Window size scaling factor` 显示倍数。⚠️ 若抓包时**没抓到握手**，这里显示 `-1 (unknown)`——Wireshark 不知道 wscale 是多少。
5. 关掉相对序列号：Edit → Preferences → Protocols → TCP → 取消 `Relative sequence numbers`，序列号立刻变回线上真值。

---

## 8. ⚠️ 常见坑

| 坑 | 现象 | 原因 | 解法 |
|----|------|------|------|
| **抓 127.0.0.1 抓不到** | 一个包都没有 | 回环流量不经过物理网卡 | Linux/WSL2：`-i lo`；Windows：选 `Adapter for loopback traffic capture`（需 Npcap 且勾选 loopback 支持） |
| **包"变大"，看不到真实分段** | 明明 MSS=1460，却抓到 `length 25000` 的包 | 网卡的 TSO/GSO（发送侧）、GRO/LRO（接收侧）卸载：分段/聚合交给网卡做，抓包点在卸载之前/之后 | 临时关闭：`sudo ethtool -K eth0 tso off gso off gro off lro off`；查看当前状态：`ethtool -k eth0 \| grep -E 'segmentation\|offload'`。**排查完记得开回来**，关掉会掉性能 |
| **抓不到握手** | 只有数据包，没有 SYN | ① curl 传多个 URL 时会**复用连接**；② 系统里有 HTTP 代理；③ 抓包起晚了 | ① 一次只请求一个 URL，或加 `--no-keepalive`；② `env \| grep -i proxy` 确认，必要时 `curl --noproxy '*'`；③ 先起 tcpdump 再发请求 |
| **过滤条件全不匹配** | 抓到 0 个包 | curl 走了 IPv6，而你的过滤写的是 IPv4 主机名/地址 | `curl -4` 强制 IPv4；或过滤写 `'tcp port 80'` 不带 host |
| **在 Windows 抓 WSL 的流量** | 空包 | 两个网络栈（见 2.3） | 在 WSL 里抓；或抓 `vEthernet (WSL)` 适配器（已过 NAT） |
| **tcpdump -w 报 Permission denied** | 起不来 | Ubuntu tcpdump 降权 + AppArmor | 写到 `/tmp`，或加 `-Z root` |
| **`-i any` 看不到 MAC** | Ethernet 层缺失 | Linux cooked capture (SLL) 链路类型 | 指定具体接口 |
| **DNS 噪声淹没抓包** | 满屏 53 端口的包 | 忘了 `-nn`，tcpdump 自己在做反解 | 永远加 `-nn` |
| **序列号看着不连续/一堆"乱序"** | Wireshark 满屏红黑警告 | 抓包起点在连接建立之后，相对序列号基准错了 | 关掉相对序列号，或重抓完整连接 |

---

## 9. 验收清单

打开**你自己抓的**包，逐条回答。全部答得出才算过关：

- [ ] 1. 找出握手的三个包，写出各自的 `Flags` 记号（应为 `[S]`、`[S.]`、`[.]`）。
- [ ] 2. 写出客户端 ISN 和服务端 ISN 各是多少（用 `-S`）。两次重跑实验，确认它们**每次都变**。
- [ ] 3. 用 `SYN-ACK 的 ack` − `SYN 的 seq` 验证结果等于 **1**，并解释这个 1 是什么。
- [ ] 4. 找出**对端通告的 MSS 值**，说明它是"对端愿意接收的"还是"双方协商的最小值"。
- [ ] 5. 找出双方的 `wscale`，取握手后任意一个包的 `win` 值，**算出实际窗口字节数**（`win << wscale`）。
- [ ] 6. 说出 SACK permitted 出现在第几个包里；再解释为什么你的包里找不到真正的 `sack` 块。
- [ ] 7. 用第 1、2 包的时间差估算 RTT，与 `ping` 的结果对比，数量级应一致。
- [ ] 8. 找出第一个 FIN，指出**谁是主动关闭方**，并说明它接下来会进入哪个状态。
- [ ] 9. 数一数你抓到的挥手是 3 个包还是 4 个包；如果是 3 个，指出哪两步被合并了。
- [ ] 10. 分别用**相对**和**绝对**序列号看同一个包，说出同一字段的两个数值差多少（差值应等于 ISN）。
- [ ] 11. 抓一次 `-i lo` 的本机连接，说明它的 MSS 为什么远大于 1460（回环接口 MTU 通常是 65536）。
- [ ] 12. 故意用 `curl -4 http://example.com/ http://example.com/`（两个 URL），确认第二个请求**没有**新的握手，解释原因。

---

## 10. 思考题

**Q1：为什么是三次握手？两次不行吗？四次多余吗？**

<details><summary>参考答案</summary>

三次是"双向确认 ISN"的**最小**次数。连接是全双工的，两个方向各有独立的序列号空间，每个方向的 ISN 都必须"发出 + 被确认"，共 4 个动作；服务端的"确认客户端 ISN"和"发送自己的 ISN"能捎带在同一个包里，于是 4 步压缩成 3 包。所以"四次"不是多余而是"可以合并"——拆开也正确，只是白白多一个包。

两次不行的核心理由（RFC 9293 §3.5）：一个在网络里滞留很久的旧 SYN 到达服务端，服务端若两次握手就直接建立连接并分配资源，客户端根本不知情，服务端白白占着连接等数据——这就是**半开连接**（half-open）。三次握手要求客户端对服务端的 ISN 再确认一次，旧 SYN 场景下客户端会回 RST，服务端得以释放。
</details>

**Q2：抓到 `[S]` 之后立刻回 `[R.]`（RST+ACK），说明什么？**

<details><summary>参考答案</summary>

目标 IP 可达、主机在线（否则是超时无响应），但**目标端口没有程序在 LISTEN**。内核直接回 RST 拒绝。这对应应用层的 `connection refused`（Go 里是 `dial tcp x.x.x.x:port: connect: connection refused`）。

排障上的关键区分：
- `[S]` 重传数次后无任何回应 → 包被丢了：防火墙 DROP 策略、安全组、路由不通、或对端主机不在线。
- `[S]` → `[R.]` → 端口没监听：进程没起、监听在 `127.0.0.1` 而你从外部连（见 `01_network_foundations.md` 2.6 节）、或容器端口没映射。

抓包能一秒钟区分这两种"连不上"，这是 `telnet` 做不到的。
</details>

**Q3：为什么握手包里的 `win` 不能直接当作真实窗口用，而握手之后的可以（乘上倍数）？**

<details><summary>参考答案</summary>

窗口缩放选项（RFC 7323）本身在 SYN 里通告，而**接收方在解析这个 SYN 时还不知道对方支持不支持缩放**——如果对 SYN 里的 win 也应用缩放，双方对同一个数字的理解就会不一致。所以 RFC 明确规定：**SYN 段（含 SYN-ACK）里的窗口字段一律按字面值理解，不缩放**；缩放从第三个包（第一个非 SYN 段）开始对**双向**生效。

工程后果：只要任何一端的 SYN 里没有 wscale 选项（比如被中间的老防火墙剥掉了），整条连接的窗口就被永久锁在 65535 字节以内。高带宽长距离（long fat network）场景下这是隐蔽的吞吐杀手，症状是"链路带宽很大但单条 TCP 连接只跑得动几 Mbps"。
</details>

**Q4：明明代码里 `write()` 了 20 KB，为什么抓到的是十几个 1448 字节的包？如果抓到一个 20000 字节的包又是怎么回事？**

<details><summary>参考答案</summary>

前半问：TCP 是**字节流**，没有消息边界。内核按 MSS 分段发送，1448 = 1460(MSS) − 12(时间戳选项及对齐)。这正是"粘包/拆包"现象的底层来源（见 [lab_02](lab_02_sticky_packets.md)）。

后半问：抓到超过 MTU 的巨包，说明网卡开了 **TSO/GSO**（发送侧分段卸载）或 **GRO/LRO**（接收侧聚合卸载）。tcpdump 的抓包点在协议栈里、在网卡卸载**之前**（发送）或**之后**（接收），所以看到的是"未分段的大块"或"已合并的大块"，**线上真实传输的仍然是符合 MSS 的小段**。

验证：`ethtool -k eth0 | grep -E 'tcp-segmentation-offload|generic-receive-offload'`。需要看真实分段时临时 `sudo ethtool -K eth0 tso off gso off gro off lro off`，排查完开回来。
</details>

**Q5：我在服务端抓包，看到大量 `[S]` 但几乎没有 `[S.]` 回应，服务端 CPU 和网络都不忙。可能是什么问题？怎么继续查？**

<details><summary>参考答案</summary>

服务端收到 SYN 却不回 SYN-ACK，常见原因按排查顺序：

1. **端口根本没监听**（但这种情况通常回 RST 而不是沉默）——先 `ss -lnt` 确认。
2. **半连接队列（SYN queue）满**：`net.ipv4.tcp_max_syn_backlog` 用尽，新 SYN 被丢弃。查 `nstat -az | grep -i -E 'SyncookiesSent|ListenDrops'`，若 `TcpExtSyncookiesSent` 在涨，说明触发了 SYN Cookie（`tcp_syncookies=1` 时的保护机制）。
3. **全连接队列（accept queue）满**：Linux 在 accept 队列满时**也会直接丢弃新 SYN** 并累加 `TcpExtListenOverflows`。这是 [lab_03](lab_03_time_wait_close_wait.md) 实验 C 实测确认的行为。查 `ss -lnt` 的 Recv-Q 是否持续贴着 Send-Q。
4. **本机防火墙/安全组** 在 INPUT 链 DROP：`sudo iptables -L -n -v` 看 DROP 规则的计数器是否在涨。
5. **conntrack 表满**：`dmesg | grep -i conntrack`，看有没有 `nf_conntrack: table full, dropping packet`。

要点：**"服务端不忙"不等于"服务端没问题"**——队列溢出和防火墙丢包都不消耗 CPU。必须看计数器，不能看负载。
</details>

---

## 11. 延伸阅读

- **RFC 9293** — Transmission Control Protocol（2022 年 8 月，TCP 现行标准，取代 RFC 793）。§3.4 序列号与幽灵字节、§3.5 握手与挥手、§3.6 状态机，是本实验的全部依据。
- **RFC 7323** — TCP Extensions for High Performance（窗口缩放、时间戳、PAWS；取代 RFC 1323）。
- **RFC 2018** — TCP Selective Acknowledgment Options。
- **RFC 1122** — Requirements for Internet Hosts（延迟确认的上限 500ms 出自这里）。
- `man 8 tcpdump` 与 `man 7 pcap-filter`（BPF 表达式的权威语法参考）。
- Wireshark 官方 [TCP Analysis 文档](https://www.wireshark.org/docs/wsug_html_chunked/ChAdvTCPAnalysis.html)，讲清了那些红黑警告各自的判定条件。
- 《TCP/IP 详解 卷 1》第 2 版 第 13 章（TCP 连接管理），逐字段解读的经典。
- 本仓库：[knowledge/05_tcp_connection.md](../knowledge/05_tcp_connection.md) 讲状态机原理；[lab_03](lab_03_time_wait_close_wait.md) 接着用 `ss` 观察本实验抓到的状态在系统里的样子。
