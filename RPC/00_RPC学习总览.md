# 00｜RPC 深度学习总览：从函数调用幻觉到线上字节与失败语义

> RPC（Remote Procedure Call）最有吸引力的地方，是让远程调用看起来像本地函数；最危险的地方，也正是它看起来像本地函数。

## 1. 学习终点：拆掉“远程函数调用”这层幻觉

本地函数调用通常共享进程、内存和命运：调用方能直接传递语言对象，返回时通常可以确认函数已经执行完毕。RPC 则跨越进程、机器和不可靠网络，至少多出以下事实：

- 参数必须从语言对象变成字节，再从字节恢复成另一种语言的对象；
- 请求与响应可能丢失、重复、乱序到达，连接也可能在任意字节处中断；
- 客户端超时只说明“没有及时得到结果”，不说明服务端“没有执行”；
- 客户端、服务端、注册中心、代理和网络可能各自看到不同状态；
- 协议只能传播 deadline/cancel 信号，不能撤销已经发生的数据库提交或外部副作用；
- 重试会把一次逻辑调用变成多次物理尝试，负载均衡还可能让这些尝试落到不同实例。

所以本专题的学习终点不是 API 熟练度，而是四层能力：

1. **协议层**：能从 IDL 追到字段编码、消息边界、帧、stream、连接和 TLS 上的真实字节。
2. **语义层**：能严格定义一次调用的完成、失败、取消、重试、幂等与交付语义。
3. **运行时层**：能解释 stub、拦截器、名称解析、负载均衡、连接池、流控和线程模型如何协作。
4. **诊断层**：能从 deadline exceeded、reset、GOAWAY、连接风暴或尾延迟建立证据链，而不是盲目增加超时和重试。

### 毕业验收

面对下面场景，答案必须画出事件顺序，而不是只给配置建议：

> 客户端调用 `CreateOrder`，100 ms 后收到 deadline exceeded；服务端日志显示请求已进入 handler，但客户端没有拿到响应。客户端能否重试？如何保证不重复创建订单？如果请求经两层代理，deadline、取消和 trace 应如何传播？

合格答案至少覆盖：业务幂等键、服务端去重记录、事务边界、客户端剩余时间预算、重试条件、响应丢失导致的未知结果、代理缓冲与取消传播、指标和 trace 证据。

---

## 2. RPC 到底由哪些层组成

“gRPC 比 REST 快”“Dubbo 是 RPC 框架”“Protobuf 是 RPC 协议”这类说法经常把不同层混在一起。一个可用的 RPC 栈至少包含以下层：

```text
业务语义          CreateOrder(request) -> response / domain error
    ↓
服务契约          service、method、request/response type、兼容性规则
    ↓
客户端运行时      stub、interceptor、deadline、retry、resolver、load balancer
    ↓
消息编码          Protobuf / Thrift Binary|Compact / JSON / Hessian
    ↓
RPC 分帧          message length、request id、flags、metadata、status
    ↓
应用层传输映射    gRPC over HTTP/2 / Triple / Thrift Transport / JSON-RPC binding
    ↓
连接与安全        HTTP/2 stream、TCP/QUIC、TLS/mTLS、keepalive、flow control
    ↓
服务端运行时      accept/read、decode、dispatch、handler、encode/write
    ↓
服务治理          discovery、LB、限流、熔断、观测、发布、健康检查
```

关键边界：

- **Protobuf 是序列化格式与 IDL 生态，不负责连接、请求关联或超时。** 它的二进制消息本身不自带消息总长度，因此不能只把多条 Protobuf 连续写进 TCP 后期待接收方自动切分。
- **HTTP/2 是复用的传输承载，不定义 `CreateOrder` 的参数类型和业务错误。**
- **gRPC 定义服务模型及其到 HTTP/2 的映射**，包括路径、metadata、长度前缀消息和 trailers 中的最终状态。
- **Dubbo 是框架，Dubbo2 与 Triple 才是它的主要通信协议。** 框架还包含服务发现、路由、集群容错等治理能力。
- **JSON-RPC 2.0 主要规定 JSON 请求/响应对象及关联规则，并且与具体传输解耦。** 仅说“用了 JSON-RPC”并不能推导 HTTP 状态映射、鉴权、超时或背压策略。

这也是后面进行协议选型时的第一原则：**先比较同一层，不要拿序列化格式和完整框架直接比较。**

---

## 3. 一次 RPC 的完整调用路径

以一元 gRPC 调用为例，调用不是从 stub 直接“跳”到服务端函数，而是经历一组可观测状态转换：

```text
业务 goroutine/thread
  │ 1. 调用生成的 Client Stub
  ▼
Client Interceptors
  │ 2. 注入认证、trace、deadline；决定是否短路
  ▼
Resolver + Load Balancer
  │ 3. 名称解析得到地址；picker 选择 Subchannel/连接
  ▼
Serializer + gRPC Framer
  │ 4. 对消息编码；加 1B 压缩标志 + 4B 大端长度
  ▼
HTTP/2 Stream
  │ 5. HEADERS 声明 path/content-type/timeout/metadata
  │ 6. DATA 携带一条或多条长度前缀消息
  ▼
TCP + TLS
  │ 7. 字节分段、重传、拥塞控制、加密；边界可能重新切割
  ▼
Server HTTP/2 + gRPC Runtime
  │ 8. 按 stream 重组帧，按长度重组消息，解码并 dispatch
  ▼
Server Interceptors → Handler → DB/下游 RPC
  │ 9. 执行业务；反向编码响应
  ▼
Response HEADERS + DATA + Trailers
    10. trailers 中 grpc-status 才是 gRPC 调用的最终协议状态
```

这条路径上有三个不同的“边界”：

1. TCP 是无消息边界的字节流；一次 `write` 不对应一次 `read`。
2. HTTP/2 用 9 字节 frame header 给 HEADERS、DATA 等 frame 定界，并用 stream ID 复用多个交换。
3. gRPC 在 HTTP/2 DATA 字节流内部再用 5 字节前缀给每条消息定界。

因此 **HTTP/2 DATA frame 边界与 gRPC message 边界没有对齐要求**：一条 gRPC 消息可以跨多个 DATA frame，一个 DATA frame 也可以携带多条 gRPC 消息。实现必须按长度累积和拆分，不能按一次网络读取直接反序列化。

---

## 4. 从字段到 DATA：逐字节看一次最小消息

假设 IDL 中有：

```proto
message Request {
  int32 value = 1;
}
```

当 `value = 150` 时，Protobuf payload 是：

```text
08 96 01
│  └───┘
│   150 的 Varint：0x96 0x01
└──── tag = (field_number << 3) | wire_type
      = (1 << 3) | 0 = 8 = 0x08
```

`150` 不能放进一个 7-bit Varint 组：

```text
150 = 二进制 10010110
低 7 位 0010110 = 22，后面还有数据，所以首字节最高位置 1 → 10010110 = 0x96
剩余值 1，最后一组最高位置 0                         → 00000001 = 0x01
```

gRPC 不会把这 3 个字节裸写到 HTTP/2 stream，而是增加消息前缀：

```text
00 00 00 00 03 08 96 01
│  └─────────┘ └──────┘
│   payload 长度=3     Protobuf payload
└── compressed flag=0
```

注意这其实嵌套了两种“长度”：

- Protobuf 的 LEN wire type 只给某个 string/bytes/submessage 字段定界；它不是整条消息长度。
- gRPC 的 4 字节大端长度给整条 RPC message 定界；它不解释消息内部字段。

再往下，HTTP/2 DATA frame 还会有自己的 9 字节 frame header；再往下，TLS record、TCP segment 和 IP packet 又可能按各自规则切分。**抓包时必须先识别所在层，再解释长度字段。**

---

## 5. gRPC over HTTP/2 的最小协议骨架

一次典型 unary 调用可以抽象为：

```text
客户端                                              服务端
  │ HEADERS                                           │
  │ :method = POST                                    │
  │ :path = /package.Service/Method                   │
  │ content-type = application/grpc+proto             │
  │ te = trailers                                     │
  │ grpc-timeout = ...                                │
  ├──────────────────────────────────────────────────>│
  │ DATA: [compressed:1][length:4][message:N]          │
  │ END_STREAM                                        │
  ├──────────────────────────────────────────────────>│
  │                                                   │ handler
  │                         HEADERS :status=200        │
  │<──────────────────────────────────────────────────┤
  │                         DATA: response message     │
  │<──────────────────────────────────────────────────┤
  │                         HEADERS(trailers)          │
  │                         grpc-status=0, END_STREAM  │
  │<──────────────────────────────────────────────────┤
```

几个必须建立的精确认识：

- HTTP `:status = 200` 只表示 HTTP 层成功承载了 gRPC 响应，业务/RPC 仍可能在 trailers 中返回非零 `grpc-status`。
- `grpc-timeout` 是调用预算的线协议表示；若省略，协议层可被理解为没有 deadline，但生产客户端通常应设置业务预算。
- metadata 放在 HTTP/2 headers/trailers 中；以 `-bin` 结尾的二进制 metadata 在线路上需要 Base64 表示。
- HTTP/2 stream ID 只在当前连接内标识调用，不是全局 request ID，更不能替代 trace ID 或业务幂等键。
- 客户端取消通常映射为 `RST_STREAM`；这能通知对端停止协议流，但 handler 是否及时响应取消取决于运行时和业务代码。
- 服务端优雅退出会使用 GOAWAY 告知最后接受的 stream。客户端要区分“已被接受的调用”和“在 last-stream-id 之后未被接受的调用”。

---

## 6. HTTP/2 解决了什么，又没解决什么

HTTP/2 允许一条连接上同时打开多个双向 stream，frame 可以按 stream ID 交错发送。相较 HTTP/1.1 的串行复用，这减少了应用层队头阻塞和连接数量，但不等于“所有调用互不影响”。

### 6.1 双层流控

HTTP/2 DATA 同时受两个信用窗口限制：

```text
可发送字节数 = min(stream_window, connection_window)
```

- stream window 耗尽：只阻塞该 stream 的 DATA。
- connection window 耗尽：同一连接上的所有 DATA 都无法继续，即使其他 stream 自己还有额度。
- WINDOW_UPDATE 是接收方归还信用，不是应用已经完成业务处理的确认。

如果客户端持续读取网络但把消息无限堆进内存队列，HTTP/2 会认为信用可归还，背压就停在了错误的位置。真正的流式系统必须让“业务消费速度”反馈到“何时继续读取/归还窗口”。

### 6.2 TCP 层队头阻塞仍存在

不同 HTTP/2 stream 最终共享一条有序 TCP 字节流。某个 TCP segment 丢失时，内核必须先重传并补齐字节序列，上层才能看到后续字节；因此多个 stream 仍会共同受到 TCP 丢包阻塞。HTTP/2 消除的是 HTTP/1.1 请求级队头阻塞，不是 TCP 层队头阻塞。

### 6.3 一条连接也可能成为故障域

单连接复用会共享：

- 拥塞窗口与 RTT；
- connection-level flow-control window；
- TLS/session 与 socket 生命周期；
- GOAWAY、连接 reset、NAT/代理空闲超时的影响。

所以“HTTP/2 支持多路复用”不能直接推出“每个目标永远只用一条连接”。连接数需要结合并发 stream 上限、大消息流、丢包、CPU 核数、服务端策略和负载测试决定。

---

## 7. RPC 最核心的难题：失败发生在哪个时间点

一次写操作可以被分成以下事件：

```text
T0 客户端创建逻辑调用
T1 请求字节离开客户端
T2 服务端完整收到并解码
T3 handler 开始
T4 数据库事务提交
T5 服务端生成成功响应
T6 响应到达客户端
```

如果连接在 T4 与 T6 之间断开，客户端看到的可能只是 `UNAVAILABLE` 或 deadline exceeded，但副作用已经发生。这种状态叫**结果未知（unknown outcome）**：

- 直接报告失败，可能让用户误以为订单没创建；
- 自动重试，可能创建第二个订单；
- RPC 协议无法通过网络魔法判断数据库是否已经提交。

因此“至多一次调用”通常不是传输层自动给出的端到端保证。可靠写 RPC 需要业务参与：

```text
client_request_id（稳定幂等键）
  + 服务端唯一约束/去重记录
  + 业务结果持久化
  + 重复请求返回同一逻辑结果
```

重试还必须同时受四个条件约束：

1. 操作本身是只读或具备业务幂等机制；
2. 错误码和协议证据表明重试有意义；
3. 总 deadline 仍有剩余预算，而不是每次尝试重新获得完整超时；
4. 重试次数、退避、抖动与全局重试预算能阻止故障时流量放大。

取消也不是回滚：客户端 deadline 到期后发送取消信号，服务端可能在收到取消前已经提交，也可能收到后没有检查 context。**deadline 限制等待时间，不自动限制副作用生命周期。**

---

## 8. 主流 RPC 协议的机制坐标

下面比较的是协议族的典型形态，不把某个语言 SDK 的偶然实现当成协议保证。

| 协议/协议族 | 契约与编码 | 传输与分帧 | 调用模型 | 核心优势 | 主要代价/边界 |
|---|---|---|---|---|---|
| **gRPC** | 通常使用 `.proto` + Protobuf；生成强类型 stub | 标准形态为 HTTP/2；5 字节消息前缀；headers/data/trailers | unary、client stream、server stream、bidi stream | 多语言、强契约、流式、标准状态码、成熟代理与治理生态 | 浏览器原生限制；协议调试比 JSON 复杂；HTTP/2 连接与流控需要专门治理 |
| **Apache Thrift** | Thrift IDL；Binary/Compact/JSON 等 Protocol | Protocol 与 Transport 正交；Buffered/Framed/HTTP 等可组合 | 经典请求/响应与 oneway，能力随实现而异 | 跨语言；编码与传输可替换；适合既有基础设施和定制栈 | 组合多意味着互操作必须精确约定；流式与现代网关生态通常不如 gRPC 统一 |
| **Dubbo2** | Java 接口为主；Hessian2 等多种序列化 | 私有 TCP 二进制协议；header 含 flags、request ID、body length | 经典 unary/oneway | Java 体系内性能和治理集成成熟；协议头紧凑 | 跨语言、浏览器和通用网关穿透成本较高；框架能力与线协议容易混淆 |
| **Dubbo Triple** | Protobuf IDL 或 Java 接口；Protobuf binary/JSON 等 | HTTP/1 或 HTTP/2 的 unary 子协议；流式部分兼容 gRPC over HTTP/2 | unary + 三种 streaming | gRPC 互操作、网关友好，同时接入 Dubbo 治理体系 | 需明确使用的是普通 HTTP unary 还是 gRPC-compatible 子协议；不同 SDK 能力可能不齐 |
| **JSON-RPC 2.0** | 无强制 IDL；JSON 对象，按名/位置传参 | 规范与传输无关；请求 `id` 关联响应 | request/response、notification、batch | 简单、可读、易嵌入 WebSocket/HTTP/进程间通道 | 规范不定义 discovery、deadline、流控、HTTP 映射和强类型演进；notification 无法确认失败 |
| **Connect** | Protobuf schema；支持 binary/JSON | 基于标准 HTTP，Connect 协议同时面向普通 HTTP 客户端；服务端通常也支持 gRPC/gRPC-Web | unary 与 streaming（能力取决于协议和环境） | curl/浏览器友好，保留 Protobuf 契约，并能与 gRPC 生态互操作 | 需区分 Connect、gRPC、gRPC-Web 三种线上协议；中间设施对 streaming 的支持仍是约束 |
| **Avro RPC** | JSON protocol 声明；Avro binary；schema 随数据参与解析 | 定义握手、message 与 framing | request/response、one-way | 动态 schema、数据平台生态、协议握手 | 在通用微服务 RPC 中生态小于 gRPC/Thrift；团队常只使用 Avro 数据格式而非其 RPC 层 |
| **RMI/Hessian/XML-RPC** | 语言对象或较早期跨语言编码 | Java 序列化/TCP 或 HTTP | 以 unary 为主 | 遗留系统中仍有现实价值；概念演进史清晰 | 语言耦合、安全历史包袱、现代网关/流式/跨语言能力有限；通常不是新系统首选 |

### 8.1 不应只用“性能”选协议

真实延迟可以近似拆成：

```text
T_total = T_queue
        + T_encode
        + T_wait_for_connection_or_stream
        + T_network
        + T_server_queue
        + T_handler
        + T_decode
        + T_retry
```

对小消息和轻 handler，连接复用、排队与网络 RTT 可能占主导；对大消息，拷贝、压缩与流控更重要；对重业务，序列化差异可能淹没在数据库时间里。只拿单机短连接 benchmark 的 QPS 选生产协议，通常忽略了：

- P99/P999 而非平均延迟；
- schema 演进和跨语言成本；
- 网关、浏览器、Service Mesh 的识别能力；
- deadline/cancel/retry 是否标准化；
- 观测、鉴权和错误模型；
- 连接故障半径与过载行为。

---

## 9. 各协议真正值得深挖的原理

### 9.1 gRPC：不要停在“HTTP/2 + Protobuf”

需要继续追到：

- `.proto service` 如何映射为 `/:service/:method`；
- Protobuf 字段号如何决定线格式和兼容性；
- gRPC message prefix 与 HTTP/2 frame 的两层定界；
- `grpc-status` 为什么在 trailers，代理丢 trailers 时客户端如何合成错误；
- stream/connection flow control 如何把慢消费者传播回生产者；
- `RST_STREAM`、GOAWAY 与连接失败分别允许怎样的重试判断；
- name resolver、subchannel、picker 与连接状态机如何影响负载均衡。

### 9.2 Thrift：核心不是“另一种 IDL”，而是正交抽象

Thrift 将对象编码的 **Protocol** 与字节搬运/定界的 **Transport** 分开。比如 Compact Protocol 可以与 Framed Transport 组合，Binary Protocol 也可跑在 Buffered Transport 上。学习重点是：

- Protocol 如何写入 field begin/type/id、value、field stop；
- Compact Protocol 如何用 field-id delta、type nibble、ZigZag/Varint 缩小消息；
- TCP 没有边界时为什么 nonblocking server 通常需要 framed transport；
- 客户端与服务端只要任一组合参数不同，为何就不是“性能下降”而是无法互操作。

### 9.3 Dubbo：分清框架治理与协议字节

Dubbo2 的学习主线应从固定 header 入手，理解 magic、flags、status、request ID、body length 如何完成识别、关联与定界，再追踪 exchange、transport、codec 和 serialization 的分层。Triple 则要对比：

- 私有 TCP 协议为何高效，却让通用代理难以理解；
- HTTP/2 复用和标准 metadata 为何改善跨语言与网关接入；
- “兼容 gRPC”具体指哪部分 wire protocol，而不是把整个 Dubbo 治理面都等同于 gRPC。

### 9.4 JSON-RPC：简单规范留下的空白必须由系统补齐

JSON-RPC 2.0 明确定义 `jsonrpc`、`method`、`params`、`id`、`result/error`、notification 和 batch，但没有统一规定：

- HTTP path/method/status 的映射；
- deadline、cancel 与 streaming；
- schema/IDL 和字段演进；
- 鉴权、服务发现、负载均衡、重试与背压。

它适合边界清晰、需要轻量和可读性的控制面协议；但“规范短”意味着生产系统必须自行定义更多约束，而不是复杂性消失了。

---

## 10. 学习路线：先纵向打穿，再横向比较

### 第一阶段：语义、契约与字节（01～03）

先回答 RPC 为什么不等价于本地调用，再学习 IDL 演进和 Protobuf 编码。产出：

- 一张正常、请求丢失、响应丢失三种时序图；
- 手算包含 Varint、sint32、string、repeated、submessage 的 Protobuf 十六进制；
- 为 schema 变更判断 wire-safe、source-safe、behavior-safe 是否分别成立。

### 第二阶段：gRPC/HTTP2 完整主线（04～08）

沿一次调用追踪 HEADERS → DATA → trailers，随后进入流控、deadline、重试、resolver/LB 和四种调用模型。产出：

- 抓取并解释一次 unary 与一次 bidi stream；
- 制造 trailers 丢失、RST_STREAM、GOAWAY、连接 reset；
- 证明慢消费者何时会阻塞单 stream，何时会拖住整条连接；
- 用同一总 deadline 对比无重试、串行重试和 hedging 的尾延迟与负载。

### 第三阶段：Thrift、Dubbo、JSON-RPC、Connect（09～11）

此时不再背特性表，而是把每个协议投影到统一问题：IDL、编码、消息定界、请求关联、连接复用、错误、取消、流控、演进、网关。产出：

- 同一 `CreateOrder` 分别写成 Proto、Thrift IDL 和 JSON-RPC 请求；
- 对比相同字段在线路上的字节开销与可演进性；
- 写出从 Dubbo2 迁移 Triple 时的双协议暴露、灰度与回滚边界。

### 第四阶段：生产治理与证据链（12～14）

把协议机制映射到 SLO、容量和事故。产出：

- deadline budget、retry budget、concurrency limit 的联合模型；
- 一份含 client/server/proxy 三侧指标的 RPC dashboard；
- 一次“P99 激增但平均延迟稳定”的故障注入与根因报告；
- 基于真实组织约束的协议选型 ADR，而不是通用排行榜。

---

## 11. 起点测验

先独立作答，课程结束后再答一次。判断标准是能画字节或事件顺序：

1. Protobuf 已有 LEN 类型，为什么 gRPC 还需要 4 字节 message length？
2. 一个 HTTP/2 DATA frame 是否对应一条 gRPC message？反过来呢？
3. 收到 HTTP 200 能否判定 gRPC 调用成功？为什么？
4. 客户端 deadline exceeded 能否判定服务端 handler 没有执行？
5. HTTP/2 已经多路复用，为什么某个大流仍可能影响其他 RPC？
6. 请求已经写入 socket 但尚未收到响应，哪些条件下可以自动重试？
7. Protobuf 删除字段后，为什么字段号不能给新字段复用？
8. JSON-RPC 的 `id` 能否直接充当业务幂等键或分布式 trace ID？
9. Thrift Protocol 与 Transport 分别负责什么？Framed Transport 为什么不是序列化格式？
10. Dubbo 是协议还是框架？Dubbo2 与 Triple 的网络边界有何根本差异？
11. 取消一个 RPC 后，为什么数据库事务仍可能提交？
12. gRPC stream ID 为什么不能作为跨连接的请求唯一标识？

---

## 12. 每章固定分析模板

```markdown
### 目标问题
这个机制解决了哪一种歧义、边界或成本？

### 稳定语义
协议/规范保证什么，不保证什么？

### 线上表示
字段、字节序、长度、flags、状态机和帧序列是什么？

### 状态所有者
状态位于 client、proxy、server、registry 还是业务存储？

### 正常路径
逐事件写出调用时序与关键状态变化。

### 失败窗口
在每两个事件之间失败，调用方和服务端分别看到什么？

### 资源与背压
消耗连接、stream、线程、内存、队列还是流控窗口？

### 观测证据
抓包、日志、metric、trace 和业务表如何相互印证？

### 反例与版本边界
什么条件变化后，当前结论不再成立？
```

---

## 13. 常见错误心智模型

1. **“RPC 能保证 exactly once。”** 网络超时无法消除结果未知；端到端去重必须进入业务状态。
2. **“Protobuf 小，所以 gRPC 一定快。”** 排队、RTT、handler、流控和重试常比编码成本更大。
3. **“HTTP/2 多路复用后没有队头阻塞。”** TCP 丢包和 connection window 仍是共享阻塞点。
4. **“deadline 就是服务端执行时限。”** 它是预算和取消信号；业务代码不响应或副作用已提交时无法回滚。
5. **“重试只会提高成功率。”** 无幂等、无退避、无预算的重试会制造重复副作用与重试风暴。
6. **“连接成功等于实例健康。”** TCP/TLS/HTTP2 可用不代表 handler、线程池或依赖有容量。
7. **“框架选定后协议问题就被屏蔽了。”** 抽象会隐藏字节，不会消除流控、半关闭、GOAWAY 和失败歧义。
8. **“JSON 可读，所以兼容性天然更好。”** 没有 schema 约束时，不兼容变化往往更晚才在运行期暴露。
9. **“取消会撤销请求。”** 取消只能尽力停止后续工作，不能逆转已经提交的外部状态。
10. **“一个错误码对应一个根因。”** `UNAVAILABLE` 可能来自连接、GOAWAY、代理、无健康地址或服务端主动拒绝，必须结合阶段证据。

---

## 14. 官方规范与后续阅读入口

- [gRPC over HTTP/2 protocol](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md)：请求/响应 grammar、5 字节消息前缀、trailers、RST_STREAM 与 GOAWAY 映射。
- [gRPC Introduction](https://grpc.io/docs/what-is-grpc/introduction/)：服务定义、生成代码和四种调用模型。
- [Protocol Buffers Encoding](https://protobuf.dev/programming-guides/encoding/)：tag、wire type、Varint、ZigZag、LEN 与未知字段跳过机制。
- [Protocol Buffers Techniques](https://protobuf.dev/programming-guides/techniques/)：Protobuf 消息为何不自定界。
- [RFC 9113 — HTTP/2](https://www.rfc-editor.org/rfc/rfc9113.html)：frame、stream 状态、多路复用和 stream/connection 流控。
- [Apache Thrift Concepts](https://thrift.apache.org/docs/concepts)：Transport 与 Protocol 的职责边界。
- [Apache Dubbo Protocol Overview](https://dubbo.apache.org/en/overview/mannual/java-sdk/reference-manual/protocol/overview/)：Dubbo2、Triple 的传输、序列化和适用边界。
- [Dubbo Triple Specification](https://dubbo.apache.org/en/overview/reference/protocols/triple-spec/)：普通 HTTP unary 子协议与 gRPC-compatible streaming 子协议。
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)：request、notification、response、error 与 batch 的规范语义。
- [Connect Protocol Reference](https://connectrpc.com/docs/protocol/)：面向普通 HTTP、浏览器与 gRPC 互操作的 Protobuf RPC 线协议。
- [Apache Avro Specification](https://avro.apache.org/docs/current/specification/)：Avro protocol、握手与 RPC message 定义。

## 一句话总结

> RPC 的本质不是“把函数搬到远端”，而是用契约、编码、分帧、传输状态机和治理机制，在不可靠网络上尽量维持一次调用的语义；真正的深度，体现在你能说明每个保证由哪一层提供、在哪个失败窗口失效，以及用什么证据验证。
