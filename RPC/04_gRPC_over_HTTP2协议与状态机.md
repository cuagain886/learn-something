# 04｜gRPC over HTTP/2 协议与状态机：一次调用如何变成 HEADERS、DATA 与 Trailers

> gRPC 不等于 Protobuf，也不等于 HTTP/2。标准 gRPC 将 RPC 方法、metadata、deadline、消息边界和最终状态映射到 HTTP/2 stream；只有把这三层拆开，才能解释 HTTP 200 下的业务失败、DATA 分片、取消、GOAWAY 和代理丢 trailers。

## 1. 三层嵌套：先确定你正在看的边界

```text
RPC 层
  method、metadata、deadline、message、grpc-status
        ↓ 映射
gRPC over HTTP/2
  Request-Headers、5B message envelope、Trailers
        ↓ 承载
HTTP/2
  connection、stream、9B frame header、HEADERS/DATA/RST_STREAM/GOAWAY
        ↓ 传输
TLS + TCP
  record、segment、重传、拥塞控制、字节流
```

最常见的错误是把三种长度混为一谈：

```text
Protobuf LEN
  → 给某个 string/bytes/submessage/packed field 定界

gRPC Message-Length
  → 给一条完整 RPC message 定界，固定 4-byte big-endian

HTTP/2 Frame Length
  → 给一个 frame payload 定界，固定 24-bit big-endian
```

TCP read、TLS record、HTTP/2 DATA frame、gRPC message 和 Protobuf field 之间都没有一一对齐保证。

---

## 2. HTTP/2 连接如何开始

### 2.1 TLS 场景：ALPN 选择 `h2`

```text
TCP connect
  → TLS ClientHello(ALPN: h2, http/1.1, ...)
  → TLS ServerHello(ALPN: h2)
  → TLS handshake complete
  → HTTP/2 connection preface + SETTINGS
```

`h2` 表示通过 TLS 使用 HTTP/2。若 TLS ALPN 最终没有协商为 `h2`，原生 gRPC over HTTP/2 不能把后续字节假装成 HTTP/2 frame 发送。

### 2.2 Cleartext：prior knowledge

在明文 TCP 中，客户端可通过配置预先知道对端支持 HTTP/2，连接后直接发送 preface。RFC 9113 已废弃传统 `h2c` HTTP Upgrade token 的用法；工程中常说的 “h2c” 仍可能指明文 HTTP/2，但必须确认具体库指 prior knowledge 还是旧 Upgrade 流程。

### 2.3 客户端 preface 的 24 字节魔数

```text
PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n
```

十六进制：

```text
50 52 49 20 2a 20 48 54 54 50 2f 32 2e 30 0d 0a
0d 0a 53 4d 0d 0a 0d 0a
```

客户端紧接着必须发送 SETTINGS frame。服务端的 connection preface 则是它发送的第一个 SETTINGS frame。

### 2.4 SETTINGS 是连接级协商

常见 settings：

| Setting | 作用 |
|---|---|
| HEADER_TABLE_SIZE | 约束 HPACK 动态表大小 |
| ENABLE_PUSH | 是否允许 server push；RPC 通常不依赖 push |
| MAX_CONCURRENT_STREAMS | 对端允许同时打开多少 stream |
| INITIAL_WINDOW_SIZE | 新 stream 初始流控窗口 |
| MAX_FRAME_SIZE | 接收方允许的最大 frame payload |
| MAX_HEADER_LIST_SIZE | 建议对端限制解压后 header section 大小 |

SETTINGS 属于 stream 0，接收方应用设置后发送空 payload、ACK flag=1 的 SETTINGS frame。客户端可以在发出自身 preface 后立即发请求，不必等待服务端 SETTINGS，但收到后必须遵守新约束。

```text
Client                                      Server
  │ 24B magic + SETTINGS                      │
  ├──────────────────────────────────────────>│
  │                         SETTINGS           │
  │<──────────────────────────────────────────┤
  │ SETTINGS(ACK)                              │
  ├──────────────────────────────────────────>│
  │                         SETTINGS(ACK)      │
  │<──────────────────────────────────────────┤
```

---

## 3. HTTP/2 Frame Header：固定 9 字节

```text
0                   1                   2                   3
0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-------------------------------+---------------+---------------+
|        Length (24)            |   Type (8)    |   Flags (8)   |
+---+---------------------------+-------------------------------+
| R |                Stream Identifier (31)                     |
+---+-----------------------------------------------------------+
|                    Frame Payload ...                          |
+---------------------------------------------------------------+
```

字段：

- `Length`：payload 字节数，不包含 9-byte header；
- `Type`：DATA=0、HEADERS=1、RST_STREAM=3、SETTINGS=4、PING=6、GOAWAY=7、WINDOW_UPDATE=8 等；
- `Flags`：语义随 frame type 改变；
- `R`：保留位，发送时为 0；
- `Stream Identifier`：31 bit；0 表示连接级 frame。

默认最大 frame payload 是 16,384 字节；对端可通过 `SETTINGS_MAX_FRAME_SIZE` 提高，但范围仍受 24-bit Length 限制。

### 3.1 Stream 0 不是一条 RPC

stream 0 用于 SETTINGS、PING、GOAWAY 等连接控制。DATA 和承载请求/响应的 HEADERS 必须关联非零 stream。

### 3.2 Client stream ID 为奇数

客户端发起的 stream 使用递增奇数：

```text
1, 3, 5, 7, ...
```

stream ID 只在当前 HTTP/2 connection 内唯一。连接重建后又可从 1 开始，因此不能拿它做：

- trace ID；
- 业务 request ID；
- 幂等键；
- 跨连接日志唯一键。

---

## 4. 一条 HTTP/2 Stream 就是一次 gRPC Call Attempt

对标准 gRPC over HTTP/2，一个物理 attempt 使用一个 HTTP/2 stream：

```text
connection C1
├── stream 1 → GetUser attempt
├── stream 3 → CreateOrder attempt 0
├── stream 5 → ListItems attempt
└── stream 7 → CreateOrder attempt 1
```

逻辑 call 重试后会创建新的 attempt，也就使用新的 stream，甚至可能换连接/后端。

### 4.1 Stream 状态主线

忽略 server push 后，RPC 主要经过：

```text
idle
  │ client HEADERS
  ▼
open
  │ client DATA + END_STREAM
  ▼
half-closed (local)      # client 不再发送，仍可接收 response
  │ server trailing HEADERS + END_STREAM
  ▼
closed
```

从服务端视角，收到 client END_STREAM 后是 half-closed(remote)：服务端不能再收请求 DATA，但仍可发响应。

### 4.2 Streaming 改变 END_STREAM 时机

- unary/client request 完成：最后一个请求 DATA 带 END_STREAM；
- client streaming：发送多条 message，调用 `CloseSend`/half-close 后才 END_STREAM；
- server streaming：客户端请求可早结束，但服务端持续发送多个 response message；
- bidi streaming：双方独立发送，任一方可先 half-close。

HTTP/2 stream 本身是双向的，END_STREAM 是单向“我不会再发送”，不是立即关闭整个 stream。

### 4.3 RST_STREAM 直接进入 closed

任一端发送 RST_STREAM 都会终止该 stream，不影响其他正常 stream。它适合取消或 stream-level protocol error，但不能撤销对端已经提交的业务副作用。

---

## 5. Request Headers：方法、deadline 和 metadata 在这里

gRPC request grammar：

```text
Request = Request-Headers + 0..N Length-Prefixed-Message + EOS
```

典型 headers：

```text
:method       = POST
:scheme       = https
:path         = /order.v1.OrderService/CreateOrder
:authority    = order.internal.example
te            = trailers
content-type  = application/grpc+proto
grpc-timeout  = 250m
grpc-encoding = gzip
grpc-accept-encoding = gzip,identity
authorization = Bearer ...
traceparent   = ...
```

### 5.1 `:path` 是方法网络身份

默认格式：

```text
/{Service-Name}/{method-name}
```

Protobuf package 通常进入 fully-qualified service name。path 大小写敏感。修改 package/service/method 会改变路由，即使 request bytes 完全兼容也会得到 `UNIMPLEMENTED`。

### 5.2 `te: trailers` 的目的

它用于发现不支持/不正确处理 trailers 的中间设施。代理若把 HTTP/2 降成不保留 trailers 的 HTTP/1 链路，客户端可能收到 HTTP 200 和 DATA，却收不到最终 `grpc-status`。

### 5.3 `content-type`

标准值以 `application/grpc` 开头，常见：

```text
application/grpc
application/grpc+proto
application/grpc+json
```

服务端收到不以 `application/grpc` 开头的 content-type，应返回 HTTP 415，避免普通 HTTP client 把 gRPC 的 HTTP 200 错当业务成功。

### 5.4 `grpc-timeout`

```text
grpc-timeout = TimeoutValue TimeoutUnit
```

`TimeoutValue` 最多 8 个十进制数字，单位：

| 单位 | 含义 | 注意大小写 |
|---|---|---|
| H | hour | 大写 |
| M | minute | 大写 |
| S | second | 大写 |
| m | millisecond | 小写 |
| u | microsecond | 小写 |
| n | nanosecond | 小写 |

```text
grpc-timeout: 250m  # 250 milliseconds，不是 250 minutes
```

传的是剩余 timeout，而非跨机器绝对时间点，可降低时钟偏差影响。省略时协议层按无限 timeout 理解，但生产客户端应主动设置业务 deadline。

### 5.5 Metadata

- ASCII metadata：普通 printable ASCII header；
- binary metadata：key 必须以 `-bin` 结尾，value 在 header block 中 Base64；
- `grpc-` 前缀保留给协议；
- header 名通常规范为小写；
- 重复 key 的值顺序处理有协议细节，不要把 metadata 当有序 map；
- 默认建议 header list 限制约 8 KiB，实际 runtime 可配置不同值。

metadata 适合认证、trace、租户、请求特性，不适合塞大业务 payload。HPACK 压缩不会消除解压后 header 内存和敏感值泄漏风险。

---

## 6. HEADERS 与 HPACK：看到的不是明文 header 行

HTTP/2 把 header section 经过 HPACK 编码，放入 HEADERS frame 的 field block fragment；太大时继续放到 CONTINUATION frame，直到 END_HEADERS。

```text
HEADERS(stream=1, END_HEADERS=0)
CONTINUATION(stream=1, END_HEADERS=0)
CONTINUATION(stream=1, END_HEADERS=1)
```

### 6.1 END_HEADERS 不等于 END_STREAM

- `END_HEADERS`：本次 header block 编码结束；
- `END_STREAM`：发送方不再为该 stream 发送任何 body/trailers。

两者属于不同维度。请求初始 HEADERS 通常只有 END_HEADERS，没有 END_STREAM，因为后面还有 DATA。

### 6.2 HPACK 是有状态的

同一连接上的 header block 解码依赖静态表和可能变化的动态表。抓取中间一小段 TLS 解密后的 bytes，若缺少之前的 header compression state，也未必能独立恢复 header。

HTTP/2 要求即使 stream 已关闭，某些 header block 仍需最低限度处理，以保持连接级 HPACK 状态同步。实现不能把“我不关心这个 stream”简单等同于“丢掉所有相关压缩字节”。

---

## 7. gRPC Message Envelope：固定 5 字节

每条 gRPC message：

```text
+--------------------+--------------------------+------------------+
| Compressed-Flag 1B | Message-Length 4B (BE)   | Message N bytes  |
+--------------------+--------------------------+------------------+
```

- flag `0`：该 message 未压缩；
- flag `1`：使用 `grpc-encoding` 指定算法压缩；
- length：压缩后 message bytes 的长度，4-byte unsigned big-endian；
- compression context 不跨 message 复用，每条消息独立压缩/解压。

### 7.1 最小 Protobuf message 的 envelope

上一章：

```text
Protobuf payload = 08 96 01  # field 1 = 150，共 3 bytes
```

未压缩 gRPC envelope：

```text
00 00 00 00 03 08 96 01
│  └─────────┘ └──────┘
│   length=3   message
└── compressed flag=0
```

共 8 字节。

### 7.2 Message-Length 与 HTTP/2 frame 不要求对齐

合法情况 A，一条 message 跨 frame：

```text
DATA #1: 00 00 00
DATA #2: 00 03 08 96
DATA #3: 01
```

合法情况 B，一个 DATA 携带多条 message：

```text
DATA:
  [00 00000003 089601]
  [00 00000002 0807]
```

gRPC parser 必须维护 per-stream reassembly buffer：先攒满 5-byte envelope，再按 length 攒满 message，不能把一次 DATA callback 当一条 message。

### 7.3 压缩是 per-message，不是 HTTP Content-Encoding

```text
grpc-encoding: gzip
Compressed-Flag: 1
```

表示该 message bytes 用 gzip 编码。不要用 HTTP `content-encoding` 的普通语义替代 gRPC message compression。stream 中也可出现 flag=0 的未压缩消息；算法能力通过 `grpc-accept-encoding` 协商。

小消息压缩可能增加体积和 CPU。还要防御“压缩后很小、解压后巨大”的 compression bomb，并同时限制压缩前/后的 message size。

---

## 8. 一帧可计算的原始 DATA

假设：

- stream ID = 1；
- DATA payload 是上面的 8-byte gRPC message；
- 客户端发送完 unary request，所以 DATA flags 含 END_STREAM；
- 无 padding。

HTTP/2 frame header：

```text
00 00 08   # Length=8
00         # Type=DATA
01         # Flags=END_STREAM
00 00 00 01# R=0, Stream ID=1
```

完整 17 字节：

```text
00 00 08 00 01 00 00 00 01  00 00 00 00 03 08 96 01
└──────── HTTP/2 9B ────────┘  └──── gRPC DATA 8B ───┘
```

逐层解读：

```text
HTTP/2 Length = 8
  → 当前 DATA frame payload 8 字节

gRPC Message-Length = 3
  → 当前 gRPC message payload 3 字节

Protobuf tag 08 + Varint 96 01
  → field 1 = 150
```

frame Length 不含 9-byte frame header；gRPC Message-Length 不含自身 5-byte envelope。

---

## 9. 正常 Unary 调用的完整时序

```text
Client                                              Server
  │ HEADERS(stream=1, END_HEADERS)                    │
  │ :method POST                                      │
  │ :path /order.v1.OrderService/CreateOrder          │
  │ te trailers                                       │
  │ content-type application/grpc+proto               │
  │ grpc-timeout 250m                                 │
  ├──────────────────────────────────────────────────>│ idle→open
  │ DATA(stream=1, END_STREAM)                         │
  │ [flag][length][request message]                    │
  ├──────────────────────────────────────────────────>│ request half-closed
  │                                                   │ decode/handler
  │                         HEADERS(END_HEADERS)       │
  │                         :status 200                │
  │                         content-type app/grpc      │
  │<──────────────────────────────────────────────────┤
  │                         DATA                      │
  │                         response message          │
  │<──────────────────────────────────────────────────┤
  │                         HEADERS trailers          │
  │                         grpc-status 0             │
  │                         END_HEADERS|END_STREAM     │
  │<──────────────────────────────────────────────────┤ closed
```

客户端完整成功条件不是“收到 DATA”，而是：

1. HTTP/gRPC content-type 合法；
2. 响应 message 可完整重组和解码；
3. 收到最终 trailers；
4. `grpc-status = 0`；
5. stream 正常 END_STREAM。

---

## 10. Response：为什么 HTTP 200 不等于 RPC 成功

gRPC 正常响应骨架：

```text
Response =
  Response-Headers
  + 0..N Length-Prefixed-Message
  + Trailers

或者：

Response = Trailers-Only
```

### 10.1 最终 RPC 状态在 trailers

```text
:status = 200
content-type = application/grpc+proto
...
grpc-status = 5
grpc-message = order%20not%20found
```

HTTP 200 表示 HTTP 层成功承载了 gRPC 交换；`grpc-status=5` 才表示 RPC 的 `NOT_FOUND`。如果监控只按 HTTP status 统计，所有业务/RPC 错误可能都被算成成功。

### 10.2 Trailers-Only

服务端在产生 response message 前就确定失败，可在最初且唯一的 HEADERS block 中同时发送：

```text
:status = 200
content-type = application/grpc
grpc-status = 3
grpc-message = invalid%20argument
END_STREAM
```

这叫 trailers-only：没有独立 initial response headers 和 DATA。协议要求 `grpc-status` 即使成功也必须存在于最终 trailers/trailers-only。

### 10.3 `grpc-message`

它概念上是 UTF-8 文本，线路上做特定 percent-encoding。它用于人类描述，不应被客户端解析成稳定业务协议；机器可处理细节应使用状态码、typed error detail 或 response 字段。

### 10.4 `grpc-status-details-bin`

可携带 Base64 后的二进制 status detail，常见为序列化的 `google.rpc.Status`，内含 code、message 和 `Any` details。客户端必须验证内部 code 不与 `grpc-status` 冲突。

---

## 11. HTTP→gRPC 状态映射只用于缺失 `grpc-status`

代理可能直接生成 HTTP 错误页，没有 gRPC trailers。客户端需要合成 gRPC status：

| HTTP status | 合成 gRPC status |
|---:|---|
| 400 | INTERNAL |
| 401 | UNAUTHENTICATED |
| 403 | PERMISSION_DENIED |
| 404 | UNIMPLEMENTED |
| 429 | UNAVAILABLE |
| 502/503/504 | UNAVAILABLE |
| 其他，包括缺 grpc-status 的 200 | UNKNOWN |

必须注意：

1. 只有响应没有 `grpc-status` 时才使用该表；有就以 gRPC status 为准。
2. 这是 client fallback，不是 server 选择 HTTP status 的反向表。
3. 映射非对称、非一一对应，不能据此还原代理根因。

缺 trailers 的 HTTP 200 映射 UNKNOWN，而不是 OK，因为真正的成功必须有 `grpc-status=0`。

---

## 12. Trailers 丢失时发生什么

```text
server: HEADERS(200) → DATA(response) → trailers(grpc-status=0)
proxy:  HEADERS(200) → DATA(response) → [trailers dropped]
client: 收到 response bytes，但没有最终 gRPC status
```

客户端不能猜成功。否则可能把截断的 server-streaming 响应当完整结果。正确行为是合成错误，例如 UNKNOWN/INTERNAL（具体 runtime 依据情形）。

排查证据：

- client 是否记录 `missing grpc-status`；
- proxy upstream/downstream 是否都为 HTTP/2；
- 是否发生 HTTP/1.1 转换并丢 trailer；
- `te: trailers` 是否保留；
- response content-type 是否被改写；
- frame capture 中最后是否有 HEADERS + END_STREAM。

---

## 13. RST_STREAM：只终止一条 stream

RST_STREAM frame：

```text
Type = 0x03
Stream ID = target stream
Payload = 4-byte HTTP/2 error code
```

收到后 stream 立即 closed。常见情况：

- client deadline/cancel；
- server 主动取消；
- stream-level protocol error；
- `REFUSED_STREAM` 表示未处理该 stream；
- flow-control 或 frame 违规。

### 13.1 HTTP/2 error 与 gRPC status 是两套空间

```text
HTTP/2 CANCEL
  ≠ gRPC CANCELLED 的线路表示完全等价

HTTP/2 REFUSED_STREAM
  → gRPC runtime 通常合成 UNAVAILABLE，并可透明重试
```

gRPC 规范定义部分映射，但业务代码通常只看到 gRPC status。诊断时仍要保留底层 reset code。

### 13.2 Cancel 不等于回滚

客户端发 RST_STREAM(CANCEL) 只说明它不再需要响应。服务端可能已：

- 进入 handler；
- 提交数据库；
- 调用下游；
- 把任务交给后台队列。

runtime 通知 handler context cancelled，业务代码需要协作停止；已提交 effect 不会因 stream closed 自动撤销。

### 13.3 REFUSED_STREAM 的特殊价值

HTTP/2 规定服务端只有在能保证请求未处理时才能使用 REFUSED_STREAM。它缩小了结果未知窗口，允许包括非幂等请求在内的安全传输级重试；服务端一旦把 stream 交给应用，就不应再声称 REFUSED_STREAM。

---

## 14. GOAWAY：连接排水与重试边界

GOAWAY 是 stream 0 上的连接级 frame：

```text
Last-Stream-ID (31)
Error-Code (32)
Additional Debug Data
```

`Last-Stream-ID` 表示发送方可能已经处理/采取动作的最高 stream ID。

收到：

```text
GOAWAY(last_stream_id=5, NO_ERROR)
```

客户端可推导：

```text
stream 1,3,5 → 可能已处理，继续等待/按实际终态处理
stream 7,9   → 对端未处理，可在新连接重试
```

这比“TCP 直接断开”提供更精确证据。若没有 GOAWAY，客户端不知道同时发出的最高几个 stream 是否到达服务端。

### 14.1 优雅关闭的两阶段 GOAWAY

RFC 9113 建议服务端先发送：

```text
GOAWAY(last_stream_id=2^31-1, NO_ERROR)
```

让客户端停止创建新 stream，但不误判当前 stream 未处理；等待至少一个往返后，再发送带真实 last-stream-id 的 GOAWAY 并完成排水。具体 gRPC runtime 实现可能有自己的 grace period。

### 14.2 GOAWAY 不会立即杀死已接受 stream

NO_ERROR GOAWAY 的目标是停止新 stream。已接受且 ID 不大于 last-stream-id 的调用可以继续完成，连接在排水后再关闭。

### 14.3 Error-Code 与 Debug Data

非 NO_ERROR 可能表示协议或资源问题。Debug Data 只用于诊断，不应当作稳定机器协议；它可能为空、未结构化或含实现细节。

---

## 15. Connection Error 与 Stream Error 的故障半径

```text
stream error
  → RST_STREAM
  → 影响单个 attempt

connection error
  → GOAWAY/close
  → 影响连接上所有 active attempts
```

单连接多路复用降低连接数量，却把更多调用放进同一故障域：

- TLS/socket reset；
- HPACK compression state 损坏；
- connection flow-control 错误；
- PING timeout；
- GOAWAY；
- TCP 丢包/重传。

连接断开后 client runtime 通常把 active calls 结束为 UNAVAILABLE/CANCELLED 等本地状态；是否重试还要结合幂等性、是否收到 response headers、retry policy 和 remaining deadline。

---

## 16. PING 与 Keepalive

PING 是 stream 0 的连接级 frame，payload 固定 8 字节；ACK 必须回显相同 opaque data。

用途：

- 检查连接是否仍能双向进展；
- 估算 RTT；
- 穿越某些空闲连接回收设备；
- 检测半开连接。

它不能证明：

- handler thread pool 有容量；
- 数据库健康；
- 某个 RPC 会在 deadline 内完成；
- 服务实例应该继续接收业务流量。

过于频繁 keepalive 会被服务端视为滥用，可能返回 GOAWAY/`ENHANCE_YOUR_CALM`。参数必须与代理/NAT idle timeout、移动网络和服务端 enforcement 协调。

---

## 17. Frame 边界与回调边界的五个反例

### 17.1 一个 TCP read 包含多个 frame

```text
read() → [DATA stream1][DATA stream3][WINDOW_UPDATE]
```

### 17.2 一个 frame 跨多个 TCP read

```text
read #1 → 9B header + half payload
read #2 → remaining payload
```

### 17.3 一个 gRPC envelope 跨 DATA

前 3 字节在 DATA #1，剩余 5 字节在 DATA #2。

### 17.4 一个 DATA 含多个 gRPC messages

streaming 高吞吐下 runtime 可批量写入。

### 17.5 一个 Protobuf field 跨任意底层边界

多字节 Varint、LEN payload 都可被 TLS record/TCP segment/DATA 任意切割。

正确 parser 是分层增量状态机：

```text
TCP/TLS reassembly
  → HTTP/2 frame decoder
  → per-stream DATA byte queue
  → gRPC envelope decoder
  → decompressor
  → Protobuf parser
```

---

## 18. gRPC per-stream 接收状态机

```text
EXPECT_HEADERS
  │ valid response headers / trailers-only
  ▼
READ_ENVELOPE
  │ buffer >= 5
  │ validate compressed flag and length limit
  ▼
READ_MESSAGE
  │ buffer >= Message-Length
  │ decompress if flag=1
  │ deserialize
  ├──────────────> deliver message → READ_ENVELOPE
  │
  │ trailing HEADERS
  ▼
READ_TRAILERS
  │ require grpc-status
  │ END_STREAM
  ▼
COMPLETE
```

异常：

- DATA 在 response headers 前：malformed；
- envelope 只到一半就 END_STREAM：truncated message；
- compressed flag 非 0/1：protocol error；
- flag=1 但无可用 grpc-encoding：解压失败；
- message length 超配置：RESOURCE_EXHAUSTED/stream fail；
- DATA 后没有 grpc-status：missing trailers；
- grpc-status=OK 但消息数不符合 unary：protocol/runtime error。

---

## 19. 四种 RPC 模式如何映射到同一协议

| 模式 | Request DATA | Response DATA | 双方 END_STREAM |
|---|---|---|---|
| Unary | 1 message | 1 message（成功时） | client request 后 half-close；server trailers 结束 |
| Client streaming | 0..N messages | 1 message | client 显式结束发送；server 返回结果 |
| Server streaming | 1 message | 0..N messages | client 早 half-close；server 最终 trailers |
| Bidirectional | 0..N messages | 0..N messages | 两方向独立，任一方可先 half-close |

协议 message 顺序在单 stream 内保持，但 bidi 两个方向之间没有全局先后关系。应用必须设计自己的 request/response correlation 或状态机，不能假设第 N 个 response 必然对应第 N 个 request。

---

## 20. 中间代理为何容易破坏 gRPC

### 20.1 降级到 HTTP/1.1

原生 gRPC 依赖 HTTP/2 stream 与 trailers。代理若 upstream/downstream 任一侧不正确支持：

- trailers 被丢弃；
- streaming 被完整缓冲；
- cancellation 不传播；
- flow control 退化为大内存队列；
- content-type/path 被重写。

### 20.2 Buffering

代理等待完整 request body 才转发，会让 client streaming 退化为“发完才开始”；等待完整 response 才回传，则 server streaming 首条消息延迟等于整个 RPC 时长。

### 20.3 Idle/Max Duration

长 stream 可能没有 DATA 但仍有效。代理的 idle timeout、max connection age、max stream duration 与 keepalive 配置不一致，会产生周期性 reset/GOAWAY。

### 20.4 Header/Trailer 限制

认证 token、trace baggage 和 rich error details 可能超过限制。HPACK 后线上 bytes 小，不代表解压后 header list 小；限制通常按解压后的 name/value 加开销计算。

### 20.5 gRPC-Web 不是原生 gRPC over HTTP/2

浏览器 API 无法直接暴露原生 HTTP/2 framing/trailers 控制，因此 gRPC-Web 使用不同的线上封装，通常经代理转换。抓包和故障语义分析时不能把 gRPC-Web frame 与本文原生协议混用。

---

## 21. 抓包与诊断方法

### 21.1 TLS 之前先确认协商

```powershell
openssl s_client `
  -connect localhost:50051 `
  -alpn h2
```

检查 ALPN 是否为 `h2`、证书/SNI 是否正确。

### 21.2 grpcurl

```powershell
grpcurl -vv -plaintext `
  -d '{"value":150}' `
  localhost:50051 `
  demo.TestService/Call
```

`-vv` 可观察方法、headers、响应状态和耗时，但不会替代原始 HTTP/2 frame capture。

### 21.3 Wireshark/tcpdump

明文 h2c 最容易直接观察；TLS 环境需要受控测试中的 session key log 或服务端侧调试日志。重点字段：

- stream ID；
- HEADERS/DATA/RST_STREAM/GOAWAY；
- END_STREAM/END_HEADERS；
- DATA length；
- trailers 中 grpc-status；
- GOAWAY last-stream-id/error-code；
- RST_STREAM error-code。

### 21.4 三侧证据

```text
Client
  logical call、attempt、stream/connection、最终 gRPC status

Proxy
  downstream/upstream protocol、reset reason、response flags、trailer forwarding

Server
  stream accepted、handler started、status produced、write/reset/GOAWAY
```

仅凭客户端 `UNAVAILABLE` 不能区分 DNS、connect、TLS、GOAWAY、RST_STREAM、proxy 503 或 server close。

---

## 22. 故障注入实验

### 实验 1：正常 Unary frame 序列

- 发一个 3-byte Protobuf 请求；
- 验证 gRPC DATA 为 8 bytes；
- 验证最后 response HEADERS 带 grpc-status 与 END_STREAM。

### 实验 2：Envelope 跨 DATA

- 自定义测试 transport 把 5-byte envelope 分成 2+3；
- 再把 message 拆到第三个 DATA；
- 验证应用只收到一条完整 message。

### 实验 3：一个 DATA 多消息

- server streaming 连续发送小消息；
- 观察多个 envelope 是否可能共处 DATA；
- 确认应用仍按 message 边界回调。

### 实验 4：Trailers-Only

- interceptor 在 handler 前返回 INVALID_ARGUMENT；
- 验证无 response DATA，单个 header block 同时含 HTTP 200、grpc-status 和 END_STREAM。

### 实验 5：丢弃 Trailers

- 让故障代理保留 HTTP 200/DATA 但丢最终 trailers；
- 验证客户端不能返回 OK；
- 比较代理日志与 client missing-status 错误。

### 实验 6：RST_STREAM Cancel

- client 在 server commit 前后分别取消；
- 观察底层 reset 与 handler context；
- 证明 commit 后取消不回滚数据库。

### 实验 7：GOAWAY Drain

- 服务端有多个并发 stream 时触发 graceful shutdown；
- 记录 GOAWAY last-stream-id；
- 验证高于 last ID 的 attempt 在新连接重试，低于等于它的 stream 完成。

### 实验 8：代理降级/缓冲

- client streaming 每秒发一条消息；
- 对比支持 streaming 的 HTTP/2 proxy 与 buffer-all proxy；
- 用 server 首次收到 DATA 的时间证明差异。

---

## 23. 常见误区

1. **“gRPC 一条调用就是一个 TCP 连接。”** 多个 call stream 复用一条连接。
2. **“一个 DATA frame 就是一条 Protobuf message。”** 两层边界完全独立。
3. **“HTTP 200 表示 gRPC 成功。”** 最终看 trailers 中 grpc-status。
4. **“收到 response DATA 就可以返回成功。”** trailers 可能随后给出失败或缺失。
5. **“END_HEADERS 表示调用结束。”** 它只结束一个 HPACK header block。
6. **“END_STREAM 关闭双方。”** 它只关闭发送方方向，进入 half-closed。
7. **“RST_STREAM 会回滚 handler。”** 它只终止协议 stream。
8. **“GOAWAY 会立即终止所有调用。”** 优雅排水允许已接受 stream 完成。
9. **“stream ID 是全局请求 ID。”** 它只在单连接内唯一。
10. **“HPACK 后很小，所以 metadata 不占资源。”** 解压后 header list 和动态表仍占内存。
11. **“PING 成功表示服务健康。”** 只证明连接级往返仍工作。
12. **“gRPC-Web 就是浏览器里的原生 gRPC。”** 两者线上 framing 和能力边界不同。

---

## 24. 高频追问

### Q1：为什么 gRPC 使用 HTTP 200 表示业务失败？

HTTP 层成功承载了 gRPC 响应，RPC 状态独立放在 trailers。这样 streaming 可以在已经发送 response headers/data 后仍给出最终状态。

### Q2：为什么状态放 trailers，不放第一组 headers？

最终状态只有 handler/stream 完成后才知道。server streaming 可能已发送很多 message，最后才失败；trailers 正好位于响应末尾。

### Q3：客户端怎样知道一条 gRPC message 结束？

读取 1-byte compression flag 和 4-byte big-endian length，再累计 exactly N bytes。不能使用 DATA frame 边界。

### Q4：为何 `te: trailers` 必须发送？

用于发现不兼容的中间设施，并声明客户端理解 trailers。缺失/被移除可能说明代理链不能正确承载原生 gRPC。

### Q5：HEADERS frame 一定包含完整 metadata 吗？

不一定。HPACK field block 可跨 HEADERS + CONTINUATION，直到 END_HEADERS。

### Q6：收到 GOAWAY 后哪些调用可重试？

stream ID 高于 last-stream-id 的请求被对端保证未处理，可在新连接安全重试；不高于的 stream 可能已处理，需按实际终态和方法幂等性判断。

### Q7：RST_STREAM 与 GOAWAY 的区别？

RST_STREAM 针对单 stream；GOAWAY 针对整条连接并声明可能处理到的最高 stream ID。

### Q8：grpc-timeout 为什么传 duration 而非绝对 deadline？

跨主机绝对时间受时钟偏差影响；传剩余 timeout 并扣除已耗时更稳健。

### Q9：为什么缺 grpc-status 的 HTTP 200 映射 UNKNOWN？

成功必须由 `grpc-status=0` 明确结束。没有 trailers 可能是代理截断或服务端崩溃，不能把收到部分 DATA 猜成成功。

### Q10：单连接多路复用的代价是什么？

连接级 reset、GOAWAY、TCP 丢包、HPACK 状态和 connection flow control 会成为多个 call 的共享故障域。

---

## 25. 本章验收清单

- [ ] 能写出 TLS ALPN、connection preface、SETTINGS/ACK 顺序。
- [ ] 能逐字段解释 9-byte HTTP/2 frame header。
- [ ] 知道 client stream ID 是奇数且只在连接内唯一。
- [ ] 能画出 idle→open→half-closed→closed。
- [ ] 能区分 END_HEADERS 与 END_STREAM。
- [ ] 能手算 5-byte gRPC envelope 和 17-byte DATA frame 示例。
- [ ] 能解释一条 message 跨 DATA、一个 DATA 含多条 message。
- [ ] 能说明 HTTP 200、grpc-status、trailers-only 的关系。
- [ ] 知道 HTTP→gRPC mapping 只在缺 grpc-status 时使用。
- [ ] 能区分 RST_STREAM 与 GOAWAY 的故障半径。
- [ ] 能用 last-stream-id 判断哪些请求保证未处理。
- [ ] 能识别代理丢 trailers、buffering 和 HTTP 降级问题。

---

## 26. 官方资料

- [gRPC over HTTP/2 Protocol](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md)：request/response grammar、headers、5-byte message envelope、trailers 与 HTTP/2 error mapping。
- [RFC 9113 — HTTP/2](https://www.rfc-editor.org/rfc/rfc9113.html)：connection preface、9-byte frame header、stream 状态、SETTINGS、RST_STREAM、PING、GOAWAY 与 flow control。
- [HTTP to gRPC Status Code Mapping](https://grpc.github.io/grpc/core/md_doc_http-grpc-status-mapping.html)：缺失 grpc-status 时的 client fallback 映射。
- [gRPC Status Codes](https://grpc.io/docs/guides/status-codes/)：标准 RPC 状态语义。
- [gRPC Cancellation](https://grpc.io/docs/guides/cancellation/)：取消传播与 handler 协作停止。
- [gRPC Keepalive](https://grpc.io/docs/guides/keepalive/)：HTTP/2 PING keepalive 的配置和风险。
- [gRPC-Web Protocol](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-WEB.md)：浏览器协议与原生 gRPC framing 的差异。

## 一句话总结

> 一次 gRPC attempt 是一条 HTTP/2 stream：初始 HEADERS 定义方法和调用上下文，DATA 字节流中用 5 字节 envelope 切分 message，最终 trailers 用 grpc-status 给出唯一可信的 RPC 终态；RST_STREAM 终止单次尝试，GOAWAY 划定连接排水与安全重试边界，但两者都不能替业务层撤销已经发生的副作用。

> 下一篇：[05｜HTTP/2 多路复用、流控与队头阻塞](05_HTTP2多路复用流控与队头阻塞.md)。
