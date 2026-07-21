# 22. HTTP、Servlet、Spring MVC 与 WebFlux：一条请求穿过哪些队列

> 优先级：S｜难度：★★★★★｜基线：Spring Boot 4.1.0、Framework 7.0.8、Servlet 6.1｜前置：[18 并发](18-thread-pool-and-virtual-thread.md)、[21 NIO](21-java-io-nio-network.md)

## 1. 本章目标

能从 socket/TLS/HTTP frame 一直追到 Controller、序列化和响应写回；能列出连接池、accept backlog、容器 worker、业务池、连接池和下游的所有排队点；能比较 Servlet 平台线程、Servlet 虚拟线程与 WebFlux，而不宣称某一种天然更快；能为 Agent 的 SSE、上传和模型调用设计 deadline、取消与幂等。

## 2. HTTP 是应用语义，不是一次方法调用

请求至少包含 method、target、headers 和可选 body；响应包含 status、headers、body。method 的 safe/idempotent 是协议语义：GET 应只读，PUT/DELETE 设计上幂等，POST 默认不幂等，但真实业务仍需用幂等键/状态机实现，代理不会替你保证。

Header 有语义和尺寸上限：`Content-Type` 描述 body 格式，`Accept` 做响应协商，`Content-Length` 给确定长度，HTTP/1.1 chunked transfer 编码允许未知总长度。代理层应拒绝冲突/歧义的 framing，防 request smuggling；不要信任任意 `X-Forwarded-*`，只接受受信代理注入并覆盖外来值。

Body 应流式且有上限。JSON parser、multipart、压缩解码都可能放大数据；同时限制 wire bytes、解压后 bytes、嵌套深度、字段/数组数量和处理时间。

## 3. HTTP/1.1、HTTP/2 与 HTTP/3

### HTTP/1.1

文本首部、同连接顺序请求。keep-alive 复用 TCP/TLS，避免每次握手；但一个连接上普通 pipeline 的响应顺序形成 head-of-line，客户端池通常开多个连接。连接空闲超时、最大请求数与对端关闭竞态必须由池处理。

### HTTP/2

二进制 frame，一个 TCP 连接复用多个 stream，HPACK 压缩 headers，有 stream/connection flow control。应用并发不能只看“连接数”：一条连接可承载许多 stream，但受对端 `MAX_CONCURRENT_STREAMS`、流控窗口、CPU 和下游限制。TCP 丢包仍会暂停该连接内后续字节，形成 transport HOL。

### HTTP/3

运行于 QUIC/UDP，TLS 1.3 集成，不同 stream 的丢包恢复更独立；连接迁移等能力改善移动网络。它没有消除拥塞控制、握手、证书、服务器资源和应用排队。Java server/client 支持取决于具体版本/库，不能从“HTTP/3 标准存在”推断当前容器已启用。

ALPN 在 TLS 握手中协商 h2/http1.1 等；抓包、client protocol 和 server 日志要共同确认实际协议。

## 4. TLS、连接池与 timeout budget

TLS 建立信任链、主机名校验、密钥协商和加密完整性。禁用证书校验不是开发环境小技巧进入生产；内部服务也需证书轮换、SNI/hostname、trust store 和时钟正确。

客户端连接池容量按目标 route/protocol 管理。池满时获取连接也会等待，所以 timeout 至少分：pool acquisition、DNS、connect、TLS、request write、response headers、body idle、overall deadline。每层重新给固定 30 秒会让总预算失控。

重试只在剩余 deadline 足够、错误可重试、attempt 有限且有退避/jitter 时进行。即使连接在读响应前断开，远端也可能已提交；POST/tool call 必须带稳定 idempotency key，服务端存请求摘要与终态，参数不同的同 key 应冲突而非复用结果。

## 5. 从网卡到 Servlet 容器

以 Tomcat NIO connector 的典型 HotSpot/Linux/Windows 实现为例，而非 Servlet 规范保证：Acceptor 接受 socket，Poller/selector 关注 readiness，解析 HTTP 后把可处理请求交 executor worker。具体类名、数量和 handoff 随 Tomcat 版本/协议实现改变。

```text
NIC/kernel backlog
 → server socket accept
 → connector poller + HTTP parser
 → executor queue / worker
 → Filter chain
 → Servlet / DispatcherServlet
 → response buffer / socket send buffer
```

每一箭头都可能排队。worker 数增加但 DB 连接仍 20，只会让更多线程等连接并抬高尾延迟。诊断要同时看 busy/max threads、executor queue、connections、accept count、request duration 与下游池。

## 6. Servlet 契约与生命周期

容器加载/实例化 Servlet，调用一次 `init`，并发调用 `service`，停机时 `destroy`。Servlet 实例通常共享，实例可变字段需线程安全；request/response 只在本请求生命周期使用，不能保存到 singleton 或异步越界后继续访问，除非按 async API 契约。

Filter 包围 chain，可做认证、trace、压缩等；顺序决定语义，必须 finally 清理 MDC/ThreadLocal。Listener 观察 context/session/request 生命周期，不应在 callback 阻塞启动/关闭。Session 是服务端/分布式状态，cookie 只携 session id；集群需 sticky 或共享 store，并防 fixation、过期与大对象。

response commit 后 status/header 通常不能再可靠修改；流式输出中途失败也不能重新返回一份 JSON 500。协议需在事件流里定义 error terminal，观测记录 client disconnect 与 server error。

## 7. 异步 Servlet

`startAsync` 让原容器 worker 返回，稍后在其他 executor/回调中完成 response；它减少“一个平台 worker 持续等 I/O”，却不自动让业务库非阻塞。必须：配置 async timeout；监听 complete/error/timeout；所有路径只 complete 一次；取消下游；不要无限持有 request body/buffer。

异步 Servlet 和虚拟线程解决不同层面：前者显式 callback 生命周期，后者让顺序阻塞代码以廉价线程等待。两者都不增加 DB/API 容量。

## 8. DispatcherServlet 主链

Spring MVC 是 front controller：

```text
DispatcherServlet
 → HandlerMapping 找 handler + interceptors
 → HandlerAdapter 选择调用方式
 → argument resolvers 解析 path/query/header/body/context
 → controller method
 → return value handlers
 → HttpMessageConverter / ViewResolver
 → HandlerExceptionResolver（异常路径）
```

HandlerMapping 解决“谁处理”；HandlerAdapter 解决“怎样调用”。把两者混称反射会漏掉参数解析、数据绑定、验证、异步返回类型和内容协商。

`HandlerInterceptor` 位于 MVC handler 链，Servlet Filter 更外层；security 常需在 Filter 层尽早拒绝。`@ControllerAdvice`/ExceptionResolver 把已分类异常映射 status/problem body；不要用 catch-all 永远返回 200。

## 9. 参数绑定与 JSON 边界

`@RequestParam/@PathVariable` 多来自字符串转换；`@RequestBody` 由 HttpMessageConverter 按 Content-Type 读取。DTO 不直接复用 JPA entity/内部 Agent state，避免 mass assignment、lazy graph 与敏感字段泄露。

校验分三层：语法（JSON 能解码）、结构（字段/类型/大小）、业务（状态转移/权限/唯一性）。绑定错误通常 400；认证 401、授权 403、冲突 409、过载 429/503。错误 body 带稳定 code/correlation id，不回显秘密和内部栈。

Jackson 等序列化会访问 getter/field、递归对象图并分配；双向关系可无限递归，lazy 属性可触发 N+1，超大集合可占 worker 很久。限制 response size，预构造 API DTO，并用 profiling 观察而非只调线程。

## 10. WebFlux 与 Reactive Streams

WebFlux handler 返回 Mono/Flux，描述稍后产生的结果，不应在方法内先 `block()`。Reactive Streams 协议由 Publisher、Subscriber、Subscription、`request(n)` 和 cancel 构成；生产者不得超过 demand 发送。

```text
Netty EventLoop read
 → WebFilter / HandlerMapping
 → handler builds Publisher
 → subscription + demand
 → operators
 → codec writes DataBuffer
 → channel writability / cancel
```

背压只在支持协议的链内传播。远端 SDK 若先把整个响应缓存在 byte[]，返回 Flux 也不恢复流式；数据库 JDBC 是阻塞 API，放进 `map` 会卡 EventLoop。临时可 `boundedElastic`/专用 scheduler 隔离，长期应选真实异步驱动或使用更简单的虚拟线程 MVC。

Reactor `Context` 随订阅链传递，不是普通 ThreadLocal；线程可在 operator 间切换。事务、trace、安全上下文需要相应 reactive integration。错误是 terminal signal；`onErrorResume` 会改变失败语义，不能为了“流不断”吞掉授权/一致性错误。

## 11. SSE 与 WebSocket

SSE 是 HTTP 单向 server→client 文本事件流，支持 event/id/retry/data，多行 data 合并。proxy buffering、idle timeout 与心跳会影响实时性；`Last-Event-ID` 只是重连提示，服务端仍需 sequence 存储和重放策略。浏览器 EventSource 认证/header 能力有约束。

WebSocket 握手后双向 frame，应用自己定义 request/response/event correlation、授权续期、flow control 和 reconnect。它不是可靠消息队列：断线期间事件是否保留、顺序、重复和 cursor 由应用协议实现。

两者对慢客户端都需 byte high watermark；不能让每个 Agent run 的 token 无限堆在 server memory。

## 12. 三种执行模型的比较

| 模型 | 优势 | 主要风险 | 适合 |
|---|---|---|---|
| Servlet + 平台池 | 生态成熟、顺序代码、ThreadLocal 兼容 | 阻塞请求占昂贵 worker，池/队列调参 | 并发可控、现有阻塞库 |
| Servlet + 虚拟线程 | 顺序代码承载大量 I/O 等待 | 下游无界冲击、JDK 21 pinning/ThreadLocal 内存 | 大量独立阻塞 I/O、库支持良好 |
| WebFlux + Reactor | 少量 event loops、端到端 demand/cancel、流组合 | 阻塞污染、Context/调试/错误链复杂 | 全链异步、流式、高连接数团队有经验 |

CPU-bound 吞吐都受核数限制；DB-bound 都受连接/数据库能力限制。比较时固定下游并发、payload、TLS、连接池和 correctness，测 p50/p99、CPU、内存、context switch、队列年龄，不只测峰值 QPS。

## 13. 可运行对照

[spring-runtime](labs/spring-runtime) 的 `WebStackLab` 不启动真实端口：MockMvc 验证 `/mvc/{id}` 经 MVC mapping 返回 `mvc:42`；WebTestClient 绑定 functional router，验证 Flux `one,two` 被订阅并完整返回。

```powershell
cd labs\spring-runtime
.\run.ps1
```

它证明 handler/codec 两条框架路径，不证明真实 Tomcat/Reactor Netty 网络性能。下一步实验应启动两个独立应用，在固定连接/并发/下游 semaphore 下压测，并注入 100 ms 阻塞，观察 MVC worker 与 WebFlux event-loop lag 的不同。

## 14. Agent HTTP 设计

入口先生成 run id 并做 tenant/global admission；request body 流式校验后持久化请求摘要；返回 202 + status URL，或 SSE 流。同步等待只适合短任务且同一 deadline 内。

模型 client：连接池、stream 上限、首 token/body idle/总 deadline 分开；429 尊重 retry hints + jitter；每 attempt 记录 token/cost；取消关闭 subscription/body。Tool HTTP 用 invocation id，超时记 UNKNOWN 而不是自动当失败；查询/对账后才重试副作用。

流事件经过单 owner 排序，写有界 replay log；SSE disconnect 触发 subscriber cancel，但是否取消整个 run 由产品语义决定，不能把“用户暂时掉线”必然等同“终止后台任务”。

## 15. 常见误区与检查清单

1. **keep-alive 没有成本**：占连接槽、内核 buffer 和 idle 管理。
2. **HTTP/2 一个连接无限并发**：受 stream/flow control/CPU/下游限制。
3. **Servlet 一个请求必然一个 socket 线程**：connector poller 与 worker 有 handoff，async/虚拟线程又改变等待。
4. **WebFlux 返回 Flux 就非阻塞**：链内任何 JDBC/block/大 CPU 都能阻塞 EventLoop。
5. **重试 GET/POST 只看 method**：还要看业务副作用、结果未知和幂等实现。
6. **SSE chunk 等于 event**：网络 chunk 可任意切分，需按 SSE grammar 解析。

- [ ] 能画完整请求链和所有队列。
- [ ] 能为每阶段定义 timeout/指标。
- [ ] 能解释 MVC 参数/返回/异常策略链。
- [ ] 能用 demand/cancel 描述 WebFlux。
- [ ] 能在三种模型间用负载证据选型。
- [ ] 能处理流已 commit 后的错误。

## 16. 延伸阅读

- [RFC 9110：HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)
- [Jakarta Servlet 6.1 Specification](https://jakarta.ee/specifications/servlet/6.1/)
- [Spring MVC Reference](https://docs.spring.io/spring-framework/reference/web/webmvc.html)
- [Spring WebFlux Reference](https://docs.spring.io/spring-framework/reference/web/webflux.html)
- [Reactive Streams Specification](https://www.reactive-streams.org/)

下一章：[23 Spring IoC 与 Bean 生命周期](23-spring-ioc.md)。
