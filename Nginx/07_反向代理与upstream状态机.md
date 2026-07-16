# 反向代理与 upstream 状态机

## 1. proxy_pass 不是一次阻塞调用

`ngx_http_proxy_module` 创建 `ngx_http_upstream_t`，通过事件回调推进：

```text
create request -> select peer -> nonblocking connect
-> send request headers/body -> read response header
-> process response body -> finalize/free peer
```

每一步都可能返回等待 read/write event。

## 2. upstream 对象

重要状态概念：

- peer connection 与负载均衡 callbacks。
- request_bufs：发给后端的数据链。
- buffer/bufs：响应 header/body 缓冲。
- pipe：buffered response 的双向 pipe。
- headers_in：解析后的后端响应头。
- conf：timeout、buffer、retry 配置。
- state：每次尝试的地址、status、时间和字节。

一次客户端请求可产生多个 upstream state，日志变量用逗号分隔。

## 3. 创建后端请求

proxy 模块根据 method、URI、headers 和 body 构造请求。

默认必须特别审查：

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

不能无条件信任客户端传入 X-Forwarded-For；应先由 realip 模块限定可信代理，再重新生成链。

## 4. 三类 timeout

- `proxy_connect_timeout`：完成 TCP/TLS upstream 建连。
- `proxy_send_timeout`：两次向 upstream 写操作之间的等待。
- `proxy_read_timeout`：两次从 upstream 读操作之间的等待。

它们通常不是整个请求总 deadline。

后端每 50 秒发一个字节，60 秒 read timeout 可能永不触发，但请求总时长很长。

总 deadline 需要应用、网关或额外模块设计。

## 5. 502 与 504

典型但非绝对：

- connect refused、reset、无效 header 常产生 502。
- connect/read 超时常产生 504。

必须看 error log 中 `while connecting/sending/reading response header`，以及 upstream_connect/header/response_time。

只按 status 猜根因不可靠。

## 6. upstream keepalive

请求完成后可把后端连接放入每 worker 的空闲缓存。

它不是限制 upstream 总连接数。

`keepalive 32` 通常表示每 worker 最多缓存 32 个 idle connection；高并发仍可新建更多 active connections。

需配合后端 keepalive timeout、requests 和 HTTP version/header。

## 7. 重试触发

`proxy_next_upstream` 定义哪些错误可尝试下一个 peer。

还受：

- `proxy_next_upstream_tries`。
- `proxy_next_upstream_timeout`。
- 是否已有响应发送给客户端。
- 请求是否被视为 non-idempotent。
- request body 是否可重放。

一旦响应部分字节已发给客户端，通常不能透明换后端重来。

## 8. 非幂等副作用

POST 已完整发送到后端，后端提交数据库后连接在响应前断开。

Nginx 只看到失败。

若自动重试另一个后端，业务执行两次。

因此：

- 默认不要对 non-idempotent 请求广泛重试。
- 使用业务 idempotency key。
- 后端状态机/唯一键兜底。
- 日志记录多次 upstream 地址和状态。

## 9. request buffering 与重试

开启 `proxy_request_buffering` 时，Nginx 先完整读取客户端 body，再向 upstream 发送，body 可在内存/临时文件中重放。

关闭后边收边转发：

- 降低上传首字节延迟和临时文件。
- 慢客户端长期占 upstream。
- 发送开始后通常难以重试另一后端。

## 10. upstream TLS

代理 HTTPS 后端时审查：

```nginx
proxy_ssl_server_name on;
proxy_ssl_name $proxy_host;
proxy_ssl_verify on;
proxy_ssl_trusted_certificate ...;
```

只写 `proxy_pass https://...` 不代表默认严格验证后端证书和 SNI 一定正确。

## 11. DNS

静态 upstream 域名常在配置解析时解析，IP 不会按每请求自动刷新。

使用变量或支持的 resolve 能力时需要 `resolver`，并受 DNS TTL、缓存和失败影响。

DNS 解析失败与连接失败是不同阶段，日志和重试策略应分开。

## 12. 客户端提前断开

客户端断开时 Nginx 可检测 broken connection 并决定终止 upstream 请求。

但后端可能已经完成副作用；断开不能撤销。

对于必须完成的异步任务，不能依赖客户端 HTTP 连接存活，应在业务系统持久化任务。

## 13. 源码路径

- `src/http/ngx_http_upstream.c`：核心状态机、connect、retry、finalize。
- `src/http/modules/ngx_http_proxy_module.c`：构造请求、解析 header。
- `src/event/ngx_event_connect.c`：peer 非阻塞连接。
- `src/http/ngx_http_upstream_round_robin.c`：默认 peer 选择。

关键函数搜索：`ngx_http_upstream_init`、`connect`、`send_request`、`process_header`、`next`、`finalize_request`。

## 14. 日志

至少记录：

```text
$upstream_addr
$upstream_status
$upstream_connect_time
$upstream_header_time
$upstream_response_time
$request_time
$request_length
$bytes_sent
```

多个值必须作为尝试序列解析，不能只取最后一个掩盖重试。

## 15. 面试追问

问：read timeout 是后端处理总时长吗？

答：通常是两次成功读取之间的空闲等待时间，流式后端持续发送少量数据可让总时长远超该值。

