# 16 · net/http、Transport 与 runtime netpoll ⭐⭐⭐

> 对应代码：[`../code/24_http_transport_netpoll`](../code/24_http_transport_netpoll)

Go 写 HTTP 服务很短，但默认可运行不等于生产安全。连接池是否复用、超时覆盖哪一段、Body 是否正确关闭、服务如何优雅停机，以及 goroutine 为什么能高效等待大量网络连接，都是高频工程和面试问题。

---

## 1. Client、Transport 与连接池

```text
http.Client
├── redirect、cookie、请求总超时
└── RoundTripper（通常是 *http.Transport）
    ├── DNS / Dial / TLS
    ├── HTTP/1.1 keep-alive、HTTP/2
    ├── idle connection pool
    └── per-host 并发与超时
```

`http.Client` 和 `http.Transport` 都设计为可并发复用。反模式是在每次请求时创建新 Transport：它会创建独立连接池，导致连接无法复用、TLS 握手增加、文件描述符和 TIME_WAIT 增长。

通常做法是进程级或下游级复用 Client，并在测试/进程退出时调用 `CloseIdleConnections` 清理当前空闲连接。它不会中断正在使用的连接。

修改共享 Transport 配置必须发生在并发请求开始之前；运行中直接改字段会产生数据竞争和不一致行为。需要不同策略时创建不同 Client/Transport。

---

## 2. Body 与连接复用

对于 HTTP/1.1，Transport 要知道响应边界已经消费完，才能安全把连接放回 idle pool：

```go
response, err := client.Do(request)
if err != nil { ... }
defer response.Body.Close()
_, err = io.Copy(io.Discard, response.Body)
```

只 Close 但没有读到 EOF 时，连接是否能复用取决于协议、剩余数据和 Transport 实现，不能假设一定复用。若响应 Body 很大且业务决定放弃读取，关闭连接可能比为了复用而读完整个巨大响应更合理。

本章测试使用 `httptrace.GotConn` 观察：第一次请求 `Reused=false`，完整消费并关闭后第二次 `Reused=true`。

请求失败时，`Response` 有时可能与 error 同时非 nil（例如重定向策略），应遵守 `Client.Do` 文档；普通成功路径始终负责关闭非 nil Body。

---

## 3. Client 超时分层

| 配置 | 覆盖范围 |
|---|---|
| `http.Client.Timeout` | 从发起请求到读取完整响应 Body 的总时间 |
| `net.Dialer.Timeout` | 建立网络连接 |
| `TLSHandshakeTimeout` | TLS 握手 |
| `ResponseHeaderTimeout` | 请求写完后等待响应头 |
| `IdleConnTimeout` | keep-alive 连接在池中空闲多久 |
| request context deadline | 单次请求的业务生命周期，可携带取消原因 |

只设置 DialTimeout 不够：服务器连接成功后永远不发响应头，调用仍可无限等待。只设置 Client.Timeout 也可能太粗：下载大文件、流式响应需要更细的阶段策略。

推荐层次：

1. Transport 设置合理的网络阶段超时；
2. 每个请求通过 context 设置符合业务 SLO 的 deadline；
3. Client.Timeout 作为总预算兜底，流式场景谨慎使用；
4. 重试必须使用剩余预算，不能每次重置完整超时。

错误通常被 `*url.Error` 包装，使用 `errors.Is(err, context.DeadlineExceeded)` 或 `errors.As` 检查 timeout 接口，不要比较错误文本。

---

## 4. Transport 容量参数

- `MaxIdleConns`：所有 host 的最大空闲连接数；0 表示不限制总数。
- `MaxIdleConnsPerHost`：单 host 最大空闲连接数；0 使用默认值。
- `MaxConnsPerHost`：单 host 的连接总数上限，包含 dialing、active、idle；达到上限后请求等待。
- `DisableKeepAlives`：禁用复用，通常只用于特殊协议或诊断。

`MaxIdleConnsPerHost` 太小会让并发流量频繁重建连接；太大则保留更多 socket 和内存。配置必须结合下游实例数、请求并发、HTTP/1.1 或 HTTP/2、多路复用和负载测试。

---

## 5. Server 超时

| 配置 | 目的 |
|---|---|
| `ReadHeaderTimeout` | 限制读取请求头，重点防 Slowloris |
| `ReadTimeout` | 从接受连接到读取完整请求（通常含 Body）的时间 |
| `WriteTimeout` | 写响应的时间预算 |
| `IdleTimeout` | keep-alive 等待下一请求的空闲时间 |

`http.ListenAndServe(addr, handler)` 使用零值 Server，没有显式阶段超时。互联网入口应构造 `http.Server`。

超时不能脱离业务：上传、下载、SSE、WebSocket 或长轮询需要不同策略。对流式响应，统一 WriteTimeout 可能错误中断合法连接，应单独设计端点和连接控制。

限制 Body 大小同样重要：

```go
request.Body = http.MaxBytesReader(w, request.Body, maxBytes)
```

时间有界但大小无限仍可能耗尽内存或磁盘。

---

## 6. Shutdown、Close 与在途请求

`Server.Close` 立即关闭监听器和活动连接；`Server.Shutdown(ctx)`：

1. 关闭 listener；
2. 关闭空闲连接；
3. 等待活动连接回到 idle；
4. deadline 到期则返回 context 错误。

`Shutdown` 返回后，先前 `Serve`/`ListenAndServe` 通常返回 `http.ErrServerClosed`，这是正常结束信号，不应记录为服务故障。

正确进程关闭还应先把 readiness 设为 false，让负载均衡停止导流，然后 Shutdown HTTP，再停止任务队列和后台 worker。

⚠️ Shutdown 不会自动等待或关闭 hijacked 连接（如部分 WebSocket）。使用 `RegisterOnShutdown` 发通知，并由应用自己跟踪和等待这些连接。

---

## 7. httptrace 能看到什么

`net/http/httptrace` 可以为单次请求注册钩子：

- DNSStart/DNSDone；
- ConnectStart/ConnectDone；
- TLSHandshakeStart/TLSHandshakeDone；
- GotConn（是否 Reused、是否 WasIdle、IdleTime）；
- WroteRequest；
- GotFirstResponseByte。

它适合解释“慢在 DNS、连接池排队、建连、TLS，还是服务端首字节”。Hook 可能从不同 goroutine 调用，采集结构必须并发安全；本章 `TraceEvents` 用 Mutex 保护。

httptrace 是诊断钩子，不等于完整分布式追踪。跨服务因果关系还需要传播 trace context 和统一观测系统。

---

## 8. netpoll 为什么能支撑大量网络 goroutine

如果每个阻塞网络读都永久占一个 OS 线程，大量连接会让线程栈、上下文切换和内核调度成本失控。Go 的网络栈把可轮询描述符接入 runtime netpoll：

```text
goroutine 调用 Read/Write
  → 当前操作暂不可继续
  → 关联 runtime pollDesc 并 park 当前 G
  → OS poll/completion 机制报告事件
  → runtime netpoll 返回可运行 G 列表
  → 调度器把 G 放回运行队列
```

共同抽象是“让不能继续的 goroutine 停放，把获得网络进展的 goroutine 重新变为 runnable”。各平台机制不同：

- Windows：`CreateIoCompletionPort` + `GetQueuedCompletionStatusEx`，属于 IOCP 完成模型；
- Linux：`epoll_create1` + `epoll_wait`，就绪通知模型；
- BSD/macOS：`kqueue` + `kevent`，就绪/事件通知模型。

因此不要笼统说“Go 的 netpoll 就是 epoll”，也不要把 Windows IOCP 叫成 readiness API。本机 Go 1.26.4 的对应实现在 `runtime/netpoll_windows.go`、`netpoll_epoll.go` 和 `netpoll_kqueue.go`。

netpoll 只负责网络等待等可轮询 IO。阻塞文件 IO、某些系统调用和 cgo 仍可能占用 OS 线程，runtime 会通过调度 handoff 让其他 G 继续运行。

---

## 9. netpoll 与 GMP

- G：等待网络的 goroutine；
- M：执行 Go 代码的 OS 线程；
- P：执行 Go 代码需要的调度资源；
- netpoll：把网络事件转换为可运行 G。

G 在网络等待时不需要绑定一个 M。事件到达后，netpoll 把 G 交回调度器，由有 P 的 M 执行。这就是“大量 goroutine 等网络”比“大量 OS 线程阻塞”更轻的关键之一。

但 goroutine 仍会占栈和引用对象；慢连接、无限 Body、无限队列同样会耗尽内存。netpoll 提高等待效率，不提供容量治理。

---

## 10. 常见生产事故

1. 每次请求创建 Transport，连接池完全失效；
2. 忘记关闭 Body，连接与文件描述符泄漏；
3. Body 未消费就期待稳定复用；
4. Client 无 deadline，下游半开连接永久占资源；
5. Server 无 ReadHeaderTimeout，遭遇慢请求头攻击；
6. Shutdown 后没等待后台 worker，进程丢任务；
7. 把 `http.ErrServerClosed` 当严重错误触发告警；
8. Transport 参数按请求并发设置，却忽略 HTTP/2 多路复用；
9. 重试每次使用完整超时，总耗时突破上游 deadline；
10. 只因“goroutine 很轻”就允许无限连接和无限排队。

---

## 11. 高频面试题与参考答案

### Q1. http.Client 可以并发复用吗？

可以，Client 和 Transport 都应长期复用。每请求新建 Transport 会失去连接池。

### Q2. 为什么响应 Body 要关闭？

释放响应相关资源，并让 Transport 有机会回收或复用连接。HTTP/1.1 想稳定复用通常还要读到 EOF。

### Q3. Client.Timeout 覆盖响应 Body 吗？

覆盖，从发起连接（若需要）到读取完整响应 Body 的总过程。

### Q4. DialTimeout 与 ResponseHeaderTimeout 的区别？

前者限制建连，后者限制请求写完后等待响应头；连接成功不代表服务端会及时响应。

### Q5. ReadHeaderTimeout 解决什么问题？

限制慢速请求头，防止客户端逐字节发送 header 长时间占连接，典型是 Slowloris。

### Q6. Shutdown 和 Close 有什么区别？

Shutdown 停止新连接并等待活动请求在 deadline 内完成；Close 直接关闭活动连接。

### Q7. Shutdown 会处理 WebSocket 吗？

不会自动等待 hijacked 连接，应用需要自己通知、跟踪和关闭。

### Q8. Go 一个网络连接对应一个线程吗？

不对应。等待网络的 G 可以 park，OS 事件到达后由 netpoll 唤醒，再由调度器分配 M/P 执行。

### Q9. Go 的 netpoll 就是 epoll 吗？

不是。Linux 用 epoll，Windows 用 IOCP，BSD/macOS 用 kqueue；runtime 提供统一调度抽象。

### Q10. httptrace 有什么用途？

观察 DNS、连接池、建连、TLS、请求写入和首字节等阶段，定位请求延迟发生在哪一段。

### Q11. MaxIdleConnsPerHost 太小会怎样？

高并发 HTTP/1.1 流量无法保留足够空闲连接，频繁新建 TCP/TLS；太大则占更多 socket 和内存。

### Q12. netpoll 能解决过载吗？

不能。它降低网络等待成本，但连接数、请求体、队列和下游并发仍必须限流和有界。

---

## 12. 官方资料与源码

- [`net/http` package](https://pkg.go.dev/net/http)
- [`net/http/httptrace` package](https://pkg.go.dev/net/http/httptrace)
- [`net.Dialer`](https://pkg.go.dev/net#Dialer)
- [Go runtime `netpoll.go`](https://go.dev/src/runtime/netpoll.go)
- [Windows netpoll implementation](https://go.dev/src/runtime/netpoll_windows.go)
- [Linux netpoll implementation](https://go.dev/src/runtime/netpoll_epoll.go)
- [kqueue netpoll implementation](https://go.dev/src/runtime/netpoll_kqueue.go)

## 一句话总结

> 复用 Client/Transport、完整管理 Body、分层设置 deadline、按顺序优雅关闭；netpoll 让网络等待高效，但容量和过载仍必须由应用治理。
