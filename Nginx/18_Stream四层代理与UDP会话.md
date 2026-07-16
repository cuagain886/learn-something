# Stream 四层代理与 UDP 会话

## 1. 与 HTTP 模块的区别

Stream 模块处理 TCP/UDP session，不理解 HTTP method、URI、header、status 和 cache。

阶段概念：post-accept、pre-access、access、SSL、preread、content、log。

## 2. TCP 代理

accept client 后选择 upstream，非阻塞 connect，再双向转发字节流。

超时分 connect、proxy idle/session 等。

应用协议边界不被 Nginx理解，重试能力通常只在尚未形成不可重放字节流的早期。

## 3. ssl_preread

不终止 TLS，通过 ClientHello 预读 SNI/ALPN 分流：

```text
client TLS -> Nginx L4 reads ClientHello -> choose upstream -> passthrough
```

私钥留在后端，但 Nginx 无法做 HTTP header 路由、WAF和内容缓存。

ClientHello 分片和超大输入受 preread buffer/timeout 约束。

## 4. PROXY protocol

四层 LB 到 Nginx或 Nginx 到后端可携带原客户端地址。

接收端必须明确配置 PROXY protocol；普通客户端连到要求 PROXY 的端口会被视为非法。

只信任受控网络，防止伪造源 IP。

## 5. TCP half-close

客户端关闭写方向不一定希望立即关闭读方向，例如请求已发完仍等响应。

`proxy_half_close` 等能力决定是否独立处理两个方向 FIN，需按应用协议验证。

## 6. UDP 无连接但有 session

UDP 本身无连接，Nginx按客户端地址等建立逻辑 session 映射到 upstream，并以 timeout 回收。

`proxy_requests`/`proxy_responses` 等参数帮助判断一次逻辑会话的报文数量。

NAT、乱序、丢包、响应来自不同地址都会影响映射。

## 7. UDP 负载均衡

同一客户端报文是否稳定到同一后端取决于 hash/session 状态。

DNS、游戏、QUIC 等协议需求不同。

UDP 无内建重传，Nginx不能把丢包自动变可靠。

## 8. Stream 日志

记录 session time、bytes sent/received、upstream addr/connect time 和 protocol。

没有 HTTP status，错误分类来自连接/超时和 upstream session。

## 9. 使用场景

- MySQL/Redis/TLS passthrough。
- SMTP 等 TCP 服务。
- DNS UDP/TCP。
- 基于 SNI 的 TLS 四层分流。

数据库代理还需考虑长连接、事务、主从路由和健康检查，Nginx只看连接层不理解 SQL。

## 10. 面试追问

问：Stream 能否按 URL 路由 HTTPS？

答：TLS passthrough时只能预读 ClientHello 的 SNI/ALPN，URL在加密 HTTP 内不可见；要按 URL 必须终止 TLS进入 HTTP 层。

