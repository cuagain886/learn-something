# HTTP/2、HTTP/3 多路复用与队头阻塞

## 1. HTTP/2 的改变

一个 TCP connection 内有多个逻辑 stream，frame 交错传输。

每个 stream 有独立 HTTP request 状态，但共享：

- TCP 拥塞控制。
- TLS connection。
- connection 级 flow-control。
- worker connection 和部分内存预算。

## 2. 不再需要大量浏览器连接

HTTP/1.1 为并行常开多个连接。

HTTP/2 单连接多 stream 减少 TCP/TLS 握手，但单连接故障影响更多请求。

Nginx 前端 HTTP/2 不自动意味着到 upstream 也多路复用；常见 proxy upstream 仍是 HTTP/1.1 连接池。

## 3. TCP 队头阻塞

HTTP/2 解决应用层响应顺序限制，但所有 frame 仍在一个 TCP 字节流。

一个 TCP packet 丢失后，后续不同 stream 数据也要等重传，形成传输层 HOL。

## 4. HTTP/3/QUIC

QUIC 基于 UDP，在加密连接内提供多个可靠 stream。

某 stream 丢包通常不阻塞其他 stream 的交付。

但仍共享网络拥塞和服务器资源，不是“完全没有队头阻塞”。

## 5. stream flow control

HTTP/2/3 都有 stream/connection 流控。

慢客户端不读某 stream 时，该 stream window 收缩；connection window 管理不当也可能影响其他 stream。

每个活跃 stream 消耗 request、header、buffer 和 timer，连接数少不等于请求状态少。

## 6. 并发限制

限制最大并发 streams 可防止单连接创建海量请求耗尽内存。

客户端可排队等待新 stream。

容量应按：

```text
connections × avg_active_streams × per_request_memory
```

而非只看 active connections。

## 7. HPACK/QPACK

HTTP/2 HPACK 压缩 header table，HTTP/3 QPACK适应独立 QUIC streams。

动态表降低重复 header，但增加状态和内存；实现必须防压缩炸弹和超大 header。

QPACK 仍有编码依赖相关阻塞机制，只是与 TCP HOL 不同。

## 8. 优先级

客户端优先级信号和浏览器行为复杂，服务端实现/版本可能变化。

不要假定小 CSS 一定抢占大视频；用真实浏览器和网络条件验证。

## 9. QUIC 连接迁移

QUIC connection ID 可让客户端网络地址变化后维持逻辑连接。

负载均衡需要稳定把同一 QUIC connection 路由到正确 worker/节点，部署多层四层 LB 时尤其重要。

## 10. 0-RTT 重放

HTTP/3/TLS early data 可能被重放。

只有安全幂等请求适合，写操作仍需业务 idempotency。

## 11. UDP 运维差异

- 防火墙/安全组开放 UDP 443。
- NAT timeout 与 TCP 不同。
- UDP buffer 和丢包可成为瓶颈。
- 中间设备可能阻断 QUIC，客户端回退 HTTP/2。
- 监控必须区分协议和回退率。

## 12. Alt-Svc

站点通常在 HTTP/2/1.1 响应用 Alt-Svc 告知 HTTP/3 endpoint。

错误宣告会被客户端缓存并导致一段时间失败/回退。

逐步灰度并观察成功率。

## 13. 测试

- 用 nghttp2/curl 验证 ALPN 和并发 stream。
- 注入 1% 丢包对比 HTTP/2 与 HTTP/3。
- 大下载与小 API 同连接并发。
- 限制 flow-control window 观察吞吐。
- 统计 upstream 连接是否因前端多路复用形成新的突发。

## 14. 面试追问

问：HTTP/2 是否彻底解决 HOL？

答：解决 HTTP/1.1 应用层按响应顺序的 HOL，但多个 stream 仍共享 TCP，丢包会阻塞整个字节流；HTTP/3 用 QUIC 独立 stream 缩小该问题。

