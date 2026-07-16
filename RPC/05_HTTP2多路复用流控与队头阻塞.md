# 05｜HTTP/2 多路复用、流控与队头阻塞：共享一条连接时，谁能继续发送

> HTTP/2 把多条 gRPC 调用复用到一条 TCP 连接，但“能够并发建 stream”不等于“每条 stream 都能立即发送”。真正决定 DATA 能否前进的是 stream window、connection window、发送调度器、TCP 发送能力和接收端消费速度的共同最小值。

## 1. 本章要解决的核心问题

上一篇已经把一次 gRPC attempt 拆成：

```text
HEADERS → DATA(gRPC envelope + message) → Trailers
```

这一篇研究多条 attempt 同时存在时发生什么：

```text
stream 1 ─┐
stream 3 ─┼─ HTTP/2 connection ─ TLS ─ TCP ─ network
stream 5 ─┘
```

需要回答的不是“HTTP/2 支持多路复用吗”，而是以下机制问题：

1. 三条 stream 的 frame 如何交错到同一 TCP 字节流？
2. 为什么某条 stream 明明还有额度，却仍然不能发送？
3. `WINDOW_UPDATE` 是确认收到、确认读入内存，还是确认应用消费？
4. 为什么默认 65,535 字节窗口会限制高带宽、高 RTT 链路？
5. 为什么一个慢消费者可能拖住同连接上的无关 RPC？
6. HTTP/2 消除了哪一种队头阻塞，又保留了哪一种？
7. 多开连接为什么有时能降低尾延迟，却也可能降低整体效率？

先给出贯穿全文的发送条件：

```text
某 stream 可发送的 DATA payload
  <= min(
       该 stream 的发送窗口,
       connection 发送窗口,
       peer 允许的最大 frame payload,
       本轮调度器分配额度,
       本地 socket/TCP 当前可接收额度,
       待发送数据量
     )
```

只看其中任意一项，都会得到不完整的诊断结论。

---

## 2. 多路复用的本质：frame 交错，不是字节并行

TCP 向 HTTP/2 提供一条可靠、有序的字节流。HTTP/2 在这条字节流上依次写入 frame：

```text
TCP byte stream:

[HEADERS s1][HEADERS s3][DATA s1][DATA s3][DATA s1][HEADERS s5]...
```

每个 frame header 中都有 31-bit stream identifier，因此接收端可以把 frame 分派回对应 stream：

```text
                    ┌─ stream 1 state machine
TCP → frame parser ─┼─ stream 3 state machine
                    └─ stream 5 state machine
```

这带来两个重要结论。

第一，HTTP/2 多路复用发生在 frame 层，而不是让三条 stream 各自拥有独立 TCP 通道。

第二，发送端必须主动做调度。如果它连续写入某条大流的 DATA，协议不会自动保证其他流及时获得带宽。

例如，两个响应同时就绪：

```text
不公平调度：
DATA s1, DATA s1, DATA s1, DATA s1, DATA s3

轮转调度：
DATA s1, DATA s3, DATA s1, DATA s3, DATA s1
```

两种序列都可能符合 HTTP/2。公平性主要是实现策略，不是 frame 格式天然提供的保证。

---

## 3. HTTP/1.1 与 HTTP/2 的应用层队头阻塞

### 3.1 HTTP/1.1 pipeline 的问题

在一条 HTTP/1.1 持久连接上，如果按顺序发送请求：

```text
request A → request B → request C
```

响应也必须按请求顺序排列。即使 B 很快完成，只要 A 的响应还没完成，B 的响应就不能越过 A：

```text
A: ████████████████████
B:                     ██
C:                       █
```

这是 HTTP 消息层的队头阻塞。

### 3.2 HTTP/2 如何缓解

HTTP/2 给每个请求分配独立 stream，frame 可以交错：

```text
A: DATA s1 ───────── DATA s1 ───────── DATA s1
B:          DATA s3
C:                    DATA s5
```

B 和 C 不必等待 A 的整个响应完成。这是 HTTP/2 多路复用解决的问题。

但“可以交错”只表示协议允许，并不表示：

- 调度器一定公平；
- connection window 一定充足；
- TCP 一定没有丢包；
- 接收端一定及时消费；
- 中间代理一定不会缓冲。

因此，更准确的说法是：

> HTTP/2 移除了 HTTP/1.1 响应排序造成的应用层队头阻塞，但共享连接仍然存在资源竞争，底层 TCP 仍然提供连接级有序交付。

---

## 4. 流控不是拥塞控制，也不是并发限制

三个经常混淆的机制分别回答不同问题。

| 机制 | 保护对象 | 谁给出限制 | 限制什么 |
|---|---|---|---|
| HTTP/2 flow control | 接收端及其缓冲资源 | HTTP/2 receiver | 可以继续发送多少 DATA payload |
| TCP congestion control | 网络路径 | sender 根据 ACK、丢包、ECN 等推断 | 可以有多少数据在网络中飞行 |
| `SETTINGS_MAX_CONCURRENT_STREAMS` | endpoint 的 stream 管理资源 | HTTP/2 peer | 同时活跃的 stream 数量 |

因此：

```text
stream 数量未超限
≠ HTTP/2 window 有额度
≠ TCP congestion window 有额度
≠ 应用已经消费数据
```

一个连接可以只活跃 2 条 stream，却因为 connection window 为 0 而完全不能发送 DATA。

反过来，connection window 可以非常大，但如果 peer 把最大并发 stream 数设为 1，新 RPC 仍然不能立即创建 stream。

---

## 5. HTTP/2 流控的七条协议不变量

RFC 9113 给出的核心规则可以压缩成七条。

### 5.1 它是逐 hop 的

流控只作用于一条 HTTP/2 connection 的两个直接 endpoint：

```text
client ←window A→ proxy ←window B→ server
```

`WINDOW_UPDATE` 不会由 proxy 原样转发。A、B 是两套独立状态。

但如果 proxy 的上游发不出去，它的缓冲区最终会满，于是它可能停止给下游补充额度，背压会以“间接因果”向源头传播。

### 5.2 它是有方向的

同一条 connection 上存在两个独立方向：

```text
client ──request DATA──> server
client <─response DATA── server
```

request DATA 的 receiver 是 server，因此 server 给 client 广告 request 方向的接收额度；client 发送 request DATA 时消耗这份额度。

response DATA 的 receiver 是 client，因此 client 给 server 广告 response 方向的接收额度；server 发送 response DATA 时消耗这份额度。

一个方向堵塞，不代表反方向自动堵塞。

### 5.3 receiver 授予 credit，sender 消耗 credit

窗口是 receiver 对 sender 的承诺：

```text
“在收到新的 WINDOW_UPDATE 前，你最多还可以给我这些 DATA octets。”
```

sender 必须遵守 peer 广告的额度；sender 不能因为自己内存充足而忽略它。

### 5.4 同时有 stream 和 connection 两级窗口

发送 stream 3 的 DATA 时，同时扣减：

```text
send_window[3]
connection_send_window
```

任一个不足都不能发送超额 DATA。

### 5.5 只有 DATA 受 HTTP/2 flow control

以下 frame 不消耗 HTTP/2 流控窗口：

- HEADERS
- CONTINUATION
- SETTINGS
- PING
- RST_STREAM
- GOAWAY
- WINDOW_UPDATE

这保证在 DATA window 耗尽时，控制 frame 仍有机会前进。

### 5.6 默认初始值都是 65,535 octets

连接建立时：

```text
connection window = 65,535
new stream window = 65,535
```

实现通常会主动放大它们，但不能把某个库的默认调优值误认为协议默认值。

### 5.7 规范定义 wire semantics，不规定补窗算法

规范定义 `WINDOW_UPDATE` 的格式、合法范围和加法语义，但不规定 receiver：

- 消费多少字节后补窗；
- 每次补多少；
- 是否根据 BDP 动态调节；
- 如何在吞吐量和内存之间取舍。

因此，不同 gRPC 实现即使线格式兼容，性能也可能明显不同。

---

## 6. 双窗口账本：发送 DATA 必须同时扣两次

从 sender 视角，为每个方向维护：

```text
connection_send_window
stream_send_window[stream_id]
```

如果在 stream `s` 上发送 payload length 为 `n` 的 DATA：

```text
前置条件：
n <= connection_send_window
n <= stream_send_window[s]

发送后：
connection_send_window -= n
stream_send_window[s]  -= n
```

收到 `WINDOW_UPDATE(stream=0, increment=k)`：

```text
connection_send_window += k
```

收到 `WINDOW_UPDATE(stream=s, increment=k)`：

```text
stream_send_window[s] += k
```

两类 update 互不替代。

### 6.1 一个常见误诊

抓包看到：

```text
WINDOW_UPDATE stream=3 increment=32768
```

但 stream 3 仍未继续发送。原因可能是：

```text
stream_send_window[3] = 32768
connection_send_window = 0
```

stream 有额度不够，还需要 connection 额度。

反过来也一样：

```text
stream_send_window[3] = 0
connection_send_window = 1048576
```

连接有大量额度，stream 3 仍不能发送 DATA。

---

## 7. 手算三条 gRPC stream 的窗口变化

假设 client 在同一连接上向 server 发送三个 request body：

```text
stream 1: 准备发送 32,768 B
stream 3: 准备发送 16,384 B
stream 5: 准备发送 16,384 B
```

初始账本：

```text
C  = 65,535
S1 = 65,535
S3 = 65,535
S5 = 65,535
```

先发 stream 1 的 32,768 B：

```text
C  = 65,535 - 32,768 = 32,767
S1 = 65,535 - 32,768 = 32,767
```

再发 stream 3 的 16,384 B：

```text
C  = 32,767 - 16,384 = 16,383
S3 = 65,535 - 16,384 = 49,151
```

stream 5 原本还想发 16,384 B，但此时连接只剩 16,383 B：

```text
sendable(s5) = min(S5=65,535, C=16,383) = 16,383
```

发送后：

```text
C  = 0
S5 = 49,152
```

还剩 1 B request body 无法发送。

此时即使收到：

```text
WINDOW_UPDATE stream=5 increment=16,383
```

也不能继续，因为 `C=0`。

必须再收到连接级更新：

```text
WINDOW_UPDATE stream=0 increment=49,152
```

账本才变成：

```text
C  = 49,152
S5 = 65,535
```

剩余 1 B 才能发送。

这个例子揭示了 connection window 的作用：它限制所有 stream 合计尚未被 receiver 归还的 DATA credit。

---

## 8. 究竟哪些字节消耗窗口

发送一个 HTTP/2 DATA frame：

```text
9-byte frame header + DATA payload
```

流控计数不包含 9-byte frame header，只按 DATA frame payload length 扣减。

如果未使用 padding：

```text
flow-controlled octets = DATA 中的实际数据长度
```

如果设置 PADDED flag，DATA payload 还包含 Pad Length 字段和 padding；整个 DATA payload 都计入流控，而不只是应用数据。

对于 gRPC，DATA 中通常是：

```text
1-byte compressed flag
+ 4-byte message length
+ serialized message bytes
```

所以一个未压缩、序列化后为 100 B 的 gRPC message，至少消耗：

```text
5 + 100 = 105 B HTTP/2 flow-control credit
```

但不消耗窗口的内容包括：

- HTTP/2 的 9-byte frame header；
- 承载 gRPC metadata 的 HEADERS payload；
- 最终 trailers 的 HEADERS payload。

这不表示它们没有网络或 CPU 成本，只表示它们不进入 HTTP/2 DATA 流控账本。

---

## 9. WINDOW_UPDATE 的线格式与错误边界

`WINDOW_UPDATE` frame：

```text
+-----------------------------------------------+
| HTTP/2 frame header: Length=4, Type=0x08      |
+-----------------------------------------------+
| R | Window Size Increment (31 bits)            |
+-----------------------------------------------+
```

关键字段：

```text
stream id = 0     → connection window
stream id != 0    → 对应 stream window
increment         → 1 .. 2^31-1
```

它表达的是增量，不是新的绝对窗口值：

```text
new_window = old_window + increment
```

以下情况非法：

1. payload length 不是 4：`FRAME_SIZE_ERROR`；
2. increment 为 0：stream 级是 stream error，connection 级是 connection error；
3. 相加后窗口超过 `2^31-1`：`FLOW_CONTROL_ERROR`；
4. sender 发送的 DATA 超过 peer 广告额度：`FLOW_CONTROL_ERROR`。

为什么上限是 `2^31-1`，而窗口有时又能为负数？因为实现需要在处理 `SETTINGS_INITIAL_WINDOW_SIZE` 缩小时，用有符号账本表示“已经超前使用的 credit”。

---

## 10. SETTINGS 只能修改 stream 初始窗口

`SETTINGS_INITIAL_WINDOW_SIZE` 控制的是 peer 以后以及当前活跃 stream 的初始窗口基线。

它不修改 connection window。

```text
stream window     ← SETTINGS_INITIAL_WINDOW_SIZE 可调整
connection window ← 只能由 WINDOW_UPDATE 增加
```

连接刚建立时，如果 receiver 想把 connection receive window 从 65,535 放大到 1 MiB，需要发送：

```text
WINDOW_UPDATE stream=0
increment = 1,048,576 - 65,535
          =   983,041
```

不能通过 SETTINGS 一步设置 connection window 为 1 MiB。

### 10.1 SETTINGS 修改所有活跃 stream 的账本

假设旧 initial window 是 65,535，新值是 16,384：

```text
delta = 16,384 - 65,535 = -49,151
```

所有 open 或 half-closed(remote) stream 的发送窗口都加上这个 delta。

若某 stream 已发送 60 KiB，只剩：

```text
old window = 65,535 - 61,440 = 4,095
new window = 4,095 - 49,151 = -45,056
```

负窗口不是又发送了负数字节，而是表示 sender 已经比新限制多用了 45,056 B。它必须等待后续 `WINDOW_UPDATE` 把窗口恢复为正数，才能发送新的 DATA。

### 10.2 为什么不能瞬时收回已授予的 credit

SETTINGS 与 DATA 在网络中异步传输。receiver 降低窗口时，sender 可能尚未看到 SETTINGS，并已按旧额度发出 DATA。

所以 receiver 必须准备接收这段在途数据。流控是信用协议，不是把已经发出的字节召回。

---

## 11. 最大 frame size 不等于 flow-control window

HTTP/2 默认最大 frame payload 是 16,384 B，默认窗口是 65,535 B。

两者分别限制：

```text
SETTINGS_MAX_FRAME_SIZE
  → 单个 frame payload 最多多大

flow-control window
  → 在得到新 credit 前累计还能发多少 DATA payload
```

如果：

```text
stream window = 50,000
connection window = 30,000
max frame size = 16,384
```

第一次最多发送：

```text
min(50,000, 30,000, 16,384) = 16,384 B
```

第二次最多发送：

```text
connection 剩 13,616
min(33,616, 13,616, 16,384) = 13,616 B
```

frame size 调大不等于获得更多总 credit；window 调大也不表示可以用一个巨大 frame 发完。

对多路复用而言，较小 frame 更容易提供细粒度交错，但 frame header、系统调用和调度次数相对更多。较大 frame 降低相对开销，却可能让高优先级小消息等待更久。

---

## 12. receiver 在什么时候归还 credit

协议只规定 receiver “消费数据并释放容量”后可以发 `WINDOW_UPDATE`，但“消费”落到实现里有多个边界：

```text
NIC
 ↓
kernel TCP receive buffer
 ↓
TLS record buffer
 ↓
HTTP/2 frame parser
 ↓
gRPC deframer / message buffer
 ↓
application callback / iterator
```

某个实现可能在以下时机补窗：

- DATA 从 transport buffer 移入更上层 buffer；
- 完整 gRPC message 被组装；
- message 交给应用；
- 应用显式请求下一条消息；
- 缓冲占用降到某阈值以下。

这些选择影响背压强度。

### 12.1 过早补窗

如果框架一读到 DATA 就立即全额补窗，却无限制地把 message 堆进应用队列：

```text
network backpressure 被解除
→ sender 持续发送
→ receiver 用户态内存增长
```

这时 HTTP/2 flow control 没有真正保护应用处理能力，只把压力从 socket 转移到了 heap。

### 12.2 过晚补窗

如果必须等应用完成耗时处理才补窗：

```text
应用每处理一条才归还 credit
→ 内存更稳定
→ pipeline 深度降低
→ 高 RTT 下可能无法填满链路
```

正确策略依赖消息大小、并发数、处理时间、RTT 和内存预算。

因此看到 `WINDOW_UPDATE` 只能得出“receiver 归还了 HTTP/2 credit”，不能直接解释为：

- 业务 handler 已处理；
- 数据已落盘；
- RPC 已成功；
- 对端已经发送应用级 ACK。

---

## 13. gRPC write 返回不代表什么

一次 streaming write 可能只完成了：

```text
application object
→ serialized message
→ 进入 gRPC framework 的待发送队列
```

后续仍可能等待：

```text
stream window
connection window
HTTP/2 scheduler
socket send buffer
TCP congestion window
network delivery
peer application read
```

不同语言的同步/异步 API 对“write 完成”的定义不完全相同，但普遍不能把它当成 peer 已消费的证明。

业务如果需要确认消费，必须在 RPC 消息模型中设计应用级 acknowledgement，例如：

```protobuf
message Chunk {
  uint64 sequence = 1;
  bytes data = 2;
}

message Ack {
  uint64 committed_sequence = 1;
}
```

transport credit 和业务提交进度是两个不同状态机。

---

## 14. 从应用到网络的五层背压

一次 write 卡住时，应沿以下链条定位：

```text
应用生产速度
  ↓
gRPC outbound queue / per-call buffer
  ↓
HTTP/2 stream + connection window
  ↓
socket send buffer
  ↓
TCP congestion window / receiver window / loss recovery
```

可以把瞬时可发送量近似写成：

```text
sendable = min(
  app/framework quota,
  h2 stream window,
  h2 connection window,
  socket capacity,
  TCP cwnd,
  TCP peer receive window
)
```

几个典型症状：

| 症状 | 更可能的限制 |
|---|---|
| `WINDOW_UPDATE` 很久不来，stream window=0 | peer HTTP/2 消费/补窗慢 |
| stream window>0，但所有 stream 都停 | connection window 或 TCP 层 |
| HTTP/2 window 很大，socket write 经常阻塞 | socket/TCP/网络路径 |
| transport 不堵，进程内 pending bytes 持续涨 | 应用生产过快或框架缓冲无界 |
| 只有某一 stream 停，其他 stream 正常 | stream window、单调用消费或调度问题 |

“网络慢”不是诊断；找到第一个额度耗尽或队列持续增长的位置才是诊断。

---

## 15. 带宽时延积：窗口为什么会限制吞吐量

带宽时延积 BDP 表示填满链路需要多少在途数据：

```text
BDP = bandwidth × RTT
```

假设：

```text
bandwidth = 1 Gbit/s = 125,000,000 B/s
RTT       = 40 ms = 0.04 s
```

则：

```text
BDP = 125,000,000 × 0.04
    = 5,000,000 B
    ≈ 4.77 MiB
```

如果 connection window 只有协议默认的 65,535 B，并且 sender 必须大致等待一轮 RTT 才获得新 credit，那么窗口上限对应吞吐量近似：

```text
throughput <= window / RTT
           <= 65,535 / 0.04
           <= 1,638,375 B/s
           ≈ 1.56 MiB/s
           ≈ 13.1 Mbit/s
```

在 1 Gbit/s 路径上，只利用约 1.3%。

这也是实现采用较大静态窗口或 BDP 动态估计的原因。

### 15.1 窗口至少多大才够

想避免 flow control 成为主要瓶颈，持续可用 credit 通常需要覆盖大致一个 BDP，并留出更新延迟和调度余量：

```text
target window ≳ bandwidth × effective feedback delay
```

但窗口越大，peer 可在收到背压前注入的未消费数据越多。把窗口直接设成最大值不是免费的性能开关。

---

## 16. 补窗阈值为何形成锯齿

假设 receive window 目标是 1 MiB，receiver 每消费 512 KiB 才补一次 512 KiB：

```text
available credit
1 MiB ┐\      /\      /\
      │ \    /  \    /  \
512KiB│  \__/    \__/    \
      └──────────────────── time
```

如果 sender 足够快，credit 在 update 抵达前跌到 0，就会出现周期性停顿：

```text
burst → window=0 → wait WINDOW_UPDATE → burst
```

降低 update threshold 可以更及时补窗，但会产生更多控制 frame；提高 threshold 可以减少 frame 数，却增加停顿风险。

规范建议避免极小增量，因为频繁小 `WINDOW_UPDATE` 会带来 frame 处理开销，也可能诱导 sender 生成大量小 DATA frame。

### 16.1 动态窗口的基本思路

实现可以通过 PING 往返时间和一段时间内收到的数据量估计 BDP，然后调整目标窗口：

```text
estimated bandwidth ≈ bytes_received / sample_time
estimated BDP       ≈ estimated bandwidth × measured RTT
```

这是实现层算法，不是 HTTP/2 线协议强制行为。不同语言、版本和配置是否启用、如何封顶，都应查对应实现。

---

## 17. connection window 如何造成跨 stream 干扰

stream window 能隔离单条慢流，但 connection window 是共享总账本。

假设：

```text
connection window = 1 MiB
stream A window   = 1 MiB
stream B window   = 1 MiB
```

A 是大文件流，调度器让它先发送 1 MiB：

```text
connection window = 0
stream A window   = 0
stream B window   = 1 MiB
```

B 即使只有一个 20 B 的心跳 message，也不能发 DATA，必须等 connection credit 返回。

所以 stream-level window 不能消除 connection-level contention。

缓解方式通常包括：

- 公平调度 DATA frame；
- 限制单 stream 每轮发送量；
- 维持足够大的 connection window；
- 将大流量与低延迟控制 RPC 分到不同 connection/channel；
- 为 outbound queue 设置上限；
- 避免在一个 stream 中写入超大 message。

最后一项很重要：HTTP/2 可以把超大 message 拆成多个 DATA frame并与其他 stream 交错，但 gRPC receiver 往往要收齐完整 message 才能反序列化并交给应用。大 message 的内存与首条可见延迟仍然存在。

---

## 18. 慢消费者为何有时只堵一条流，有时堵整条连接

理想情况下，receiver 对 stream A 停止补 stream credit，但继续处理 B：

```text
S_A = 0
S_B > 0
C   > 0
```

此时 A 停止，B 继续，stream window 实现了隔离。

但以下实现行为会扩大故障半径：

### 18.1 event loop 被阻塞

如果 A 的 callback 在 transport/event-loop 线程上执行耗时任务：

```text
无法及时读取 TCP
→ 无法解析 B 的 DATA
→ 无法处理对端 WINDOW_UPDATE
→ 整条 connection 停顿
```

规范明确要求 endpoint 尽快读取并处理 frame，关键控制 frame 不能被困在 TCP receive buffer 中。

### 18.2 共享 connection buffer 达到上限

即使 B 的应用很快，如果 A 占满 connection 级接收缓冲，receiver 可能停止归还 connection credit：

```text
C = 0
```

sender 的所有 stream 都会受影响。

### 18.3 单线程序列化或压缩

发送端若在共享线程上对 A 做巨大 message 的序列化/压缩，B 甚至还没进入 HTTP/2 scheduler 就已经等待。

这不是 HTTP/2 flow control，却会呈现出类似“同连接被大流拖住”的现象。

### 18.4 proxy buffering

中间代理可能先完整缓冲一段 body 再向上游发送，使两侧的背压边界与端到端预期不同。

---

## 19. 双向流的经典死锁

官方 gRPC flow-control 指南特别提醒：手动流控或同步 API 中，双方都只写不读可能死锁。

假设 client 和 server 的协议都规定：

```text
先连续写 1000 条 message
写完后再开始读
```

运行过程：

```text
client send window → 0
server send window → 0

client 等 server 读取并补窗
server 等 client 读取并补窗
```

双方都在等待对方，但双方应用都没有进入 read：

```text
client write blocked ──等待──> server read
server write blocked ──等待──> client read
```

修复不是简单“把窗口调大”。更大的窗口只会让死锁更晚出现。

协议设计应满足至少一个条件：

- read 与 write 独立并发；
- 明确 request/response 轮次；
- 限制未确认 message 数；
- 应用级 ACK 推动发送窗口；
- 手动 inbound flow control 时持续请求必要消息；
- write queue 有界且能响应 cancellation/deadline。

---

## 20. 调度器：协议允许并发，谁先发由实现决定

当多个 stream 同时有 DATA 且窗口充足，sender 需要选择下一个 frame。

可能的策略包括：

### 20.1 FIFO

```text
按进入队列顺序发完或发到某阈值
```

简单，但大 message 可能增加后来的小 message 延迟。

### 20.2 Round-robin

```text
s1 → s3 → s5 → s1 → s3 → s5
```

更公平，但没有区分业务紧急度和 message 大小。

### 20.3 Deficit round-robin

每条 stream 累积 quantum，用 deficit 抵扣 frame 大小，可兼顾不同 frame size。

### 20.4 priority-aware

根据 urgency、权重或本地策略调度，但 priority 通常只是输入信号，不是严格的完成顺序保证。

需要区分：

```text
协议优先级信号
≠ 实现一定采用
≠ 中间代理一定保留
≠ 业务 SLA 隔离
```

真正需要强隔离时，独立连接、独立连接池、独立 endpoint 或资源池通常比“希望同连接调度器公平”更可靠。

---

## 21. HTTP/2 优先级模型为什么不能当作可靠 QoS

早期 HTTP/2 使用 stream dependency tree 和 weight 表达优先级。RFC 9113 已弃用这些 priority signaling 字段的语义，但为 wire compatibility 保留相关协议元素。

RFC 9218 提供了可扩展优先级方案，核心参数包括：

```text
urgency:    0..7，数值越小越紧急
incremental: 是否适合与同优先级响应渐进交错
```

但这些信号仍然只是建议。server 或 intermediary 可以结合自身状态调度，也可能忽略。

对 gRPC 来说，还存在现实限制：

- 并非所有 gRPC API 都暴露 HTTP priority；
- proxy 可能重建两侧连接，采用不同调度；
- priority 不创造额外 connection credit；
- priority 不能越过 TCP 的有序交付；
- 高优先级任务若共享 CPU、线程池、数据库，网络调度也无法提供端到端隔离。

所以优先级适合做优化信号，不适合充当正确性机制。

---

## 22. HTTP/2 仍然存在 TCP 队头阻塞

HTTP/2 frame 最终按顺序进入一条 TCP 字节流：

```text
TCP segment #100: DATA stream 1
TCP segment #101: DATA stream 3
TCP segment #102: DATA stream 5
```

如果 segment #100 丢失，而 #101、#102 已到达接收端，TCP 为应用提供有序字节流，因此不能先把后面的字节交给 HTTP/2 parser：

```text
收到: #101, #102
等待: #100 retransmission
HTTP/2 暂时看不到 #101, #102
```

虽然丢失的字节可能只属于 stream 1，stream 3 和 stream 5 也会等待。这是 TCP transport-level head-of-line blocking。

### 22.1 为什么 HTTP/2 自己无法绕过

HTTP/2 frame parser 甚至不能可靠知道后续 TCP 字节从哪个 frame 开始，因为 TCP 只暴露连续字节流，不暴露保留边界的独立 stream。

只要缺口未填，TLS record 解密和 HTTP/2 frame 解析也可能一起等待。

### 22.2 丢包对尾延迟的影响

丢包恢复可能依赖：

- fast retransmit / SACK；
- retransmission timeout；
- 拥塞窗口收缩；
- 路径 RTT。

因此一次底层丢包可同时制造多个 gRPC attempt 的延迟尖峰。监控上常表现为同一 connection 上多个无关方法同时变慢。

---

## 23. HTTP/3/QUIC 如何改变队头阻塞边界

QUIC 在一个 connection 内提供多个独立、可靠、有序的 stream。丢失的数据只阻塞依赖这些字节的 QUIC stream：

```text
packet contains stream 1 data → lost
stream 1 waits retransmission
stream 3 can still deliver its own contiguous data
stream 5 can still deliver its own contiguous data
```

所以 HTTP/3 避免了 TCP 在不同 HTTP stream 之间的 transport-level HOL。

但不能推导出“HTTP/3 没有任何队头阻塞”：

- 同一 QUIC stream 内仍要求有序交付；
- connection-level flow control 仍是共享资源；
- congestion control 仍作用于路径和 connection；
- QPACK 动态表引用可能造成 header 解码等待；
- 应用线程池、代理、数据库仍可形成队列；
- 丢失 packet 中包含多个 stream 的数据时，这些 stream 都受影响。

正确表述是：

> QUIC 把可靠有序交付从 connection 粒度下沉到 stream 粒度，缩小了单个丢失缺口的阻塞范围，而不是消除了所有共享资源竞争。

---

## 24. HPACK 与连接级顺序依赖

HTTP/2 的 header compression 使用 HPACK。动态表在 connection 两端维护共享状态，decoder 必须按编码顺序重放更新。

此外，一个 HEADERS frame 如果没有 `END_HEADERS`，后面必须继续同一 stream 的 CONTINUATION frame；在该 header block 完成前，不能插入其他类型或其他 stream 的 frame。

```text
HEADERS s1 (END_HEADERS=0)
CONTINUATION s1
CONTINUATION s1 (END_HEADERS=1)
HEADERS s3
```

不能写成：

```text
HEADERS s1 (END_HEADERS=0)
DATA s3                         ← 非法交错
CONTINUATION s1
```

因此超大的 metadata/header block 不仅消耗编码、内存和网络，还会短暂占据 frame 序列。

这也是限制 gRPC metadata 大小的一个性能理由，除了安全与资源保护之外。

HTTP/3 因为 QUIC 不提供跨 stream 全序，改用 QPACK 管理 header compression 状态。

---

## 25. 一条连接还是多条连接

### 25.1 单连接的收益

- 复用 TLS/TCP handshake；
- 复用 HPACK dynamic table；
- 连接数量、socket 和 keepalive 更少；
- TCP congestion window 可以长期增长并复用；
- 负载均衡器和 server 管理成本更低。

### 25.2 单连接的风险

- TCP 丢包影响所有 stream；
- connection window 是共享瓶颈；
- GOAWAY/连接断开影响大量 in-flight RPC；
- 大流与延迟敏感小流竞争调度和 socket；
- 单核/event loop/锁可能成为热点。

### 25.3 多连接的收益

- 将大流量和低延迟调用隔离；
- 独立 HTTP/2 connection window；
- 独立 TCP loss recovery 与 congestion state；
- 可跨更多 CPU/event loop 分摊处理；
- 单连接故障半径更小。

### 25.4 多连接的代价

- 更多 handshake、socket、内存和 keepalive；
- 每条 TCP connection 独立争夺网络带宽，过多连接可能不公平；
- 每条新连接需要重新建立 congestion window；
- 可能破坏连接级负载均衡预期；
- HPACK 状态无法跨连接复用。

因此连接池大小不是越大越好。应按以下信号调节：

```text
并发 stream 数
单连接排队时间
connection window stall 时间
大流/小流混合程度
丢包相关延迟尖峰
CPU/event-loop 饱和度
server 的 MAX_CONCURRENT_STREAMS
```

---

## 26. `MAX_CONCURRENT_STREAMS` 与客户端排队

server 可以通过：

```text
SETTINGS_MAX_CONCURRENT_STREAMS = N
```

限制 client 同时创建的活跃 stream 数。

若 N=100，当前已有 100 条未结束 RPC，第 101 个调用通常需要：

- 在 client channel 内等待可用 slot；
- 使用另一条已就绪 connection；
- 新建 connection；
- 或在 deadline 到期前失败。

这个等待可能发生在 request HEADERS 发送之前，因此 server access log 未必看到该 attempt。

诊断 deadline exceeded 时要区分：

```text
channel queue time
connection establishment time
time to send HEADERS
flow-control stall time
server handler time
response transfer time
```

只看 server handler latency 会漏掉客户端连接内排队。

`MAX_CONCURRENT_STREAMS=0` 表示暂时不能创建新 stream，不表示连接断开。规范建议 server 只短时间使用 0；如果不再接受请求，更适合关闭/排水连接。

---

## 27. 代理场景：背压如何跨两条连接传播

考虑 gRPC proxy：

```text
client ── conn A ──> proxy ── conn B ──> server
```

proxy 维护至少四组接收/发送状态：

```text
conn A inbound windows
conn A outbound windows
conn B inbound windows
conn B outbound windows
```

如果 server 消费慢：

```text
server 少发 conn B 的 WINDOW_UPDATE
→ proxy 向 server 的 outbound queue 增长
→ proxy 达到缓冲阈值
→ proxy 少发 conn A 的 WINDOW_UPDATE
→ client 最终停止发送
```

这叫背压传播，但它不是同一个 WINDOW_UPDATE 穿透 proxy。

如果 proxy 选择大缓冲：

```text
client 很快写完
proxy 内存堆积
server 仍然慢
```

client 观察到的 write latency 会掩盖真实下游速度。

如果 proxy 选择小缓冲，背压更快到达 client，但瞬时吞吐和高 RTT 利用率可能下降。

---

## 28. 大 message 与 streaming message 的区别

以下两种 API 传输总字节数相同：

```text
A: 一个 64 MiB gRPC message
B: 1024 个 64 KiB gRPC message
```

在 HTTP/2 层，两者都可以拆成许多 DATA frame。但在 gRPC message 层差异巨大。

### 28.1 单个大 message

- receiver 通常需组装完整 message 才能反序列化；
- 单条消息内没有应用级进度点；
- 重试可能重新传全部内容；
- 压缩/解压可能产生大块内存；
- cancellation 前已占用的缓冲较大；
- 无法逐 chunk ACK 或落盘。

### 28.2 多个小 message

- 应用可逐块处理、校验和提交；
- 可以设计 sequence/ACK/resume；
- 背压更接近应用消费速度；
- 单次序列化和重传粒度更小；
- 但每条都有 5-byte gRPC envelope 和对象处理开销。

需要断点续传或稳定内存时，应用级 chunking 往往比依赖 HTTP/2 自动切 DATA frame 更可靠。

HTTP/2 frame boundary 是 transport 实现细节，不是业务恢复边界。

---

## 29. 一个可实现的发送调度状态机

下面是简化的 sender 模型：

```text
state:
  conn_window
  stream[id].window
  stream[id].pending_bytes
  stream[id].closed
  max_frame_size
  runnable_queue
```

收到应用 write：

```text
serialize gRPC message
append 5-byte envelope + payload to pending_bytes
if stream has credit:
  mark runnable
```

调度循环：

```text
while conn_window > 0 and runnable_queue not empty:
  s = pick_next_stream()

  n = min(
        s.pending_bytes,
        s.window,
        conn_window,
        max_frame_size,
        scheduler_quantum
      )

  if n == 0:
    remove_or_park(s)
    continue

  emit DATA(s, n bytes)
  s.window   -= n
  conn_window -= n

  if s still has pending bytes and credit:
    requeue(s)
```

收到 stream `WINDOW_UPDATE`：

```text
validate increment and overflow
stream[id].window += increment
if pending and conn_window > 0:
  mark runnable
```

收到 connection `WINDOW_UPDATE`：

```text
validate increment and overflow
conn_window += increment
mark all pending streams with stream credit runnable
```

这个模型还没有覆盖 TLS/socket backpressure、priority、END_STREAM、RST_STREAM 和并发锁，但足以解释大多数“为什么没发”的问题。

---

## 30. 接收端补窗状态机

简化 receiver 可以维护：

```text
target_conn_window
target_stream_window[id]
unconsumed_conn_bytes
unconsumed_stream_bytes[id]
pending_update_conn
pending_update_stream[id]
```

收到 DATA payload `n`：

```text
decrement local receive-window accounting
unconsumed_conn_bytes += n
unconsumed_stream_bytes[id] += n
feed bytes into gRPC deframer
```

上层消费 `k` 字节对应的缓冲后：

```text
unconsumed_conn_bytes -= k
unconsumed_stream_bytes[id] -= k
pending_update_conn += k
pending_update_stream[id] += k
```

达到阈值时：

```text
emit WINDOW_UPDATE(stream=0, pending_update_conn)
emit WINDOW_UPDATE(stream=id, pending_update_stream[id])
reset pending counters
```

真实实现可能在“frame 被 transport 读取”与“message 被应用消费”之间选择不同归还点，也可能让 connection 和 stream 使用不同阈值。

审查实现时应问：

1. credit 在哪一层归还？
2. 未消费数据实际存在哪个 buffer？
3. buffer 是否有上限？
4. 单 stream 慢读会否停止 connection 补窗？
5. update 是否按 BDP 动态放大？

---

## 31. 抓包时怎样识别 flow-control stall

### 31.1 先按方向建账

不要只搜索 `WINDOW_UPDATE`，而要重放发送方向账本：

```text
initial connection window = 65,535
initial stream window     = peer SETTINGS value or 65,535
```

对每个 DATA：

```text
conn -= DATA payload length
stream[id] -= DATA payload length
```

对每个 update：

```text
stream=0  → conn += increment
stream!=0 → stream[id] += increment
```

再观察 DATA 停止时哪个账本为 0 或负数。

### 31.2 注意抓包位置

在 client、proxy、server 抓到的是不同 hop。TLS 终止后，proxy 两侧也不是同一组 stream ID 和窗口。

### 31.3 注意 capture 不等于应用时间线

抓包证明 frame 到达网卡附近，不证明：

- 内核已交给进程；
- event loop 已读取；
- gRPC 已 deframe；
- 应用已消费。

需要把 packet trace 与 runtime metrics、CPU profile、application timestamps 对齐。

### 31.4 Wireshark 关注项

可以围绕以下字段过滤和排序：

```text
http2.type == 0       # DATA
http2.type == 8       # WINDOW_UPDATE
http2.streamid
tcp.analysis.retransmission
tcp.analysis.lost_segment
```

字段名可能随 Wireshark 版本变化，应以本地字段提示为准。

---

## 32. 必须观测的指标

### 32.1 client/channel

- 活跃 stream 数；
- 等待可用 transport/stream slot 的调用数和时长；
- connection 建立数、复用率与连接年龄；
- pending outbound bytes/messages；
- write blocked duration；
- deadline 在排队阶段耗尽的数量。

### 32.2 HTTP/2 transport

- stream window stall duration；
- connection window stall duration；
- 收发 DATA bytes；
- 收发 `WINDOW_UPDATE` 次数、increment 分布；
- 当前目标 window；
- runnable stream 数；
- scheduler queue delay；
- frame size 分布。

### 32.3 TCP/system

- RTT / smoothed RTT；
- retransmissions；
- congestion window；
- sender/receiver socket queue；
- zero-window event；
- packet loss；
- event-loop lag；
- transport thread CPU 和锁等待。

### 32.4 application

- message 生产和消费速率；
- 单 message 大小分布；
- handler queue time；
- 未确认 sequence 数；
- application ACK latency；
- cancellation 后仍生产的数据量。

只有把四层指标关联，才能区分“peer 应用慢”和“网络丢包”这两种完全不同的根因。

---

## 33. 四组故障注入实验

### 实验 A：耗尽 stream window

步骤：

1. 建立 server-streaming RPC；
2. client 暂停读取这一条 stream；
3. server 持续发送固定大小 message；
4. 观察该 stream DATA 停止和 stream window 归零；
5. 同时发一条小 unary RPC。

验证：若 transport 与调度器隔离良好，小 RPC 应能继续；若 event loop 或 connection buffer 被拖住，小 RPC 尾延迟会升高。

### 实验 B：耗尽 connection window

步骤：

1. 多条 stream 同时持续发送；
2. 限制 receiver connection-level credit 或消费；
3. 重放窗口账本；
4. 观察所有 stream 在 connection window=0 时停顿。

验证：单条 stream 有剩余额度也不能越过 connection limit。

### 实验 C：制造 TCP 丢包

步骤：

1. 同一 connection 上运行大流和周期性小 unary；
2. 在测试网络注入小比例丢包；
3. 关联 retransmission 与所有 stream 的 latency spike；
4. 对比拆成两条 connection 后的结果。

验证：HTTP/2 stream 独立不等于 TCP loss recovery 独立。

### 实验 D：双向只写不读

步骤：

1. 使用测试环境和有界消息量；
2. client/server 都同步连续 write；
3. 不启动 read；
4. 观察双方 write 停在 flow-control credit；
5. 改成独立 read loop 后复测。

验证：扩大窗口只是推迟死锁，协议读写协作才能消除死锁条件。

---

## 34. 性能调优的推导顺序

不要从“把窗口改大”开始。推荐顺序是：

### 第一步：确认瓶颈确实是 HTTP/2 flow control

证据应包括：

```text
DATA 停止
AND stream/connection window 耗尽
AND socket/TCP 不是更早的限制
AND 有待发送数据
```

### 第二步：计算链路 BDP

使用目标带宽和 p50/p95 RTT 估算所需在途 credit。

### 第三步：核算内存上界

粗略预算不能只写：

```text
connections × connection_window
```

还要考虑：

```text
活跃 streams × per-stream buffer
序列化前对象
压缩/解压临时内存
TLS/socket buffers
应用队列
proxy 两侧缓冲
```

窗口是允许 peer 发送的 credit，并不必然等于立即分配等量内存；但系统必须有策略承受对应在途与缓冲压力。

### 第四步：检查补窗时机

窗口够大但 update 太晚，仍会周期性 stall。

### 第五步：检查调度公平性

connection credit 被大流抢完时，单纯继续放大可能掩盖不公平，而不是修复它。

### 第六步：必要时隔离连接

将 bulk streaming 与 latency-sensitive unary 分到不同 channel/connection pool，并用数据验证收益和连接成本。

### 第七步：做丢包和慢消费者压测

平均吞吐提升不代表 p99 稳定。必须在真实 RTT、并发、message size 和 loss 条件下测试。

---

## 35. 常见误区

### 误区 1：HTTP/2 多路复用后，stream 之间互不影响

它们仍共享 connection window、TCP、socket、调度器、HPACK 状态和进程资源。

### 误区 2：WINDOW_UPDATE 是数据 ACK

它只是 HTTP/2 credit 更新，不是业务处理或持久化确认。

### 误区 3：TCP ACK 会恢复 HTTP/2 window

不会。TCP ACK 与 HTTP/2 `WINDOW_UPDATE` 属于不同协议层和状态机。

### 误区 4：stream window 足够大就一定能发

还要检查 connection window、max frame size、scheduler、socket 和 TCP。

### 误区 5：SETTINGS 可以直接扩大 connection window

`SETTINGS_INITIAL_WINDOW_SIZE` 只调整 stream；connection window 通过 stream 0 的 `WINDOW_UPDATE` 增加。

### 误区 6：窗口不能为负数

处理 SETTINGS 初始窗口缩小时，活跃 stream 的发送窗口可以暂时为负；在恢复为正前不能发送新 DATA。

### 误区 7：frame header 也消耗 flow-control credit

9-byte HTTP/2 frame header 不计入，DATA payload 才计入；padding 属于 DATA payload，所以计入。

### 误区 8：把窗口设为最大一定最快

可能提升高 BDP 吞吐，也会扩大未消费数据、内存和多流干扰风险。

### 误区 9：一个大 message 与许多小 message 没区别

HTTP/2 都会切 frame，但 gRPC/application 的消费、ACK、重试和内存边界不同。

### 误区 10：HTTP/3 消除了所有 HOL

它主要消除跨 QUIC stream 的 transport HOL；同 stream 顺序、共享拥塞、connection flow control 和应用队列仍存在。

---

## 36. 高频追问

### Q1：HEADERS 能否在 DATA window 为 0 时发送？

可以。HTTP/2 flow control 只约束 DATA。实现仍可能受到 socket、内存或其他资源限制。

### Q2：window 为 0 时可以发送空 DATA + END_STREAM 吗？

可以。RFC 9113 允许在 stream 或 connection 没有可用窗口时发送长度为 0 且带 `END_STREAM` 的 DATA。

### Q3：RST_STREAM 会退还已经消耗的 connection credit 吗？

不能把 RST_STREAM 当成自动退款。receiver 对收到的 DATA 必须维持 connection flow-control accounting；否则双方账本会失步。实现仍需按规则管理 connection credit。

### Q4：为什么 stream 已关闭后还能看到 WINDOW_UPDATE？

frame 是异步的。peer 可能在看到关闭前已经发送 update。规范允许在 half-closed 或 closed 附近收到迟到的 `WINDOW_UPDATE`，不能一概视为错误。

### Q5：手动 inbound flow control 的价值是什么？

它让应用把“请求下一条 message”的时机与自身处理能力绑定，从而获得更明确的背压；代价是更容易因忘记 request/read 或双方只写不读而停顿。

### Q6：unary RPC 与 flow control 无关吗？

从 API 使用者角度，unary 通常不需要手动管理流控；但其 request/response DATA 仍受 HTTP/2 双窗口约束。大 unary message 或大量并发 unary 仍会消耗 connection credit。

### Q7：为什么流控正常，延迟仍随丢包同时尖峰？

因为 HTTP/2 window 不是 TCP loss recovery。TCP 缺失字节阻止后续字节交付给 HTTP/2，即使它们属于别的 stream。

### Q8：多开连接能彻底解决吗？

不能。它缩小 connection-level contention 和 loss fault domain，但增加连接成本、资源占用和全局拥塞竞争，需要基于负载测量。

### Q9：如何证明是 connection window 而不是 stream window？

重放两个账本。若目标 stream window>0、存在 pending DATA，但所有 stream 在 connection window=0 时停止，就是直接证据。

### Q10：为什么接收端应用很快，仍可能补窗慢？

可能卡在 event loop、TLS/frame parsing、共享锁、GC、proxy hop、补窗阈值或 update frame 的 TCP 发送路径，不能只看 handler 时间。

---

## 37. 本章验收清单

- [ ] 能解释多路复用是 frame 交错，而不是独立 TCP 通道。
- [ ] 能区分 flow control、congestion control 和并发 stream 限制。
- [ ] 知道 flow control 是逐 hop、双向、receiver-driven。
- [ ] 能写出 stream/connection 双窗口扣减公式。
- [ ] 能手算三条 stream 共享 65,535 B connection window 的过程。
- [ ] 知道只有 DATA payload 消耗窗口，9-byte frame header 不消耗。
- [ ] 知道 gRPC 5-byte envelope 会消耗 DATA credit。
- [ ] 能解释 stream window 有额度但 connection window 为 0 时为何不能发。
- [ ] 知道 `WINDOW_UPDATE` 是增量而不是绝对值。
- [ ] 知道 SETTINGS 只能改变 stream initial window。
- [ ] 能解释 active stream window 为什么可能因 SETTINGS 变成负数。
- [ ] 能区分 max frame size 与 window size。
- [ ] 能用 BDP 估算高 RTT 链路所需窗口。
- [ ] 能解释补窗阈值与吞吐/内存的权衡。
- [ ] 知道 write 返回不是 peer 消费确认。
- [ ] 能推演双向只写不读的 flow-control deadlock。
- [ ] 能说明调度公平性为何不是协议自动保证。
- [ ] 能区分 HTTP/1.1 应用层 HOL 与 HTTP/2 的 TCP HOL。
- [ ] 能准确描述 HTTP/3 缩小了哪一层的阻塞范围。
- [ ] 能设计抓包账本、运行时指标和四组故障注入实验。

---

## 38. 官方资料

- [RFC 9113 — HTTP/2](https://www.rfc-editor.org/rfc/rfc9113.html)：第 5.2 节定义 flow-control principles，第 6.9 节定义双窗口、`WINDOW_UPDATE` 与初始窗口调整。
- [gRPC Flow Control](https://grpc.io/docs/guides/flow-control/)：gRPC write/read 背压、手动流控以及双方只写不读的死锁风险。
- [gRPC over HTTP/2 Protocol](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md)：gRPC message envelope 如何承载于 HTTP/2 DATA。
- [RFC 9218 — Extensible Prioritization Scheme for HTTP](https://www.rfc-editor.org/rfc/rfc9218.html)：旧 HTTP/2 priority model 的问题，以及 urgency/incremental 信号。
- [RFC 9000 — QUIC](https://www.rfc-editor.org/rfc/rfc9000.html)：QUIC stream multiplexing、stream/connection flow control 与跨 stream HOL 的变化。
- [RFC 9114 — HTTP/3](https://www.rfc-editor.org/rfc/rfc9114.html)：HTTP/3 如何把 HTTP semantics 映射到 QUIC stream，以及 HPACK/QPACK 差异。

## 一句话总结

> HTTP/2 多路复用只保证不同 stream 的 frame 可以交错；DATA 真正能否前进取决于 stream credit 与 connection credit 的交集，再受调度器、socket 和 TCP 约束。双窗口把慢消费者的压力反馈给 sender，却不能消除共享连接竞争，更不能绕过 TCP 丢包造成的跨 stream 有序交付阻塞。

> 下一篇：[06｜Deadline、取消、重试与幂等](06_Deadline取消重试与幂等.md)。
