# Upstream 重试、Peer 状态与事件 Handler 切换

## 1. 回调接口

负载均衡把算法封装为 peer callbacks：

```text
init_upstream   配置期初始化upstream
init_peer       请求期创建peer data
get_peer        选择地址
free_peer       按结果释放并记账
notify/set_session/save_session 等可选回调
```

upstream core不必知道round-robin/hash的全部状态。

## 2. 请求期初始化

`ngx_http_upstream_init` 最终进入初始化请求：

- 检查缓存/本地响应等。
- 构造request_bufs。
- 初始化peer data和tries。
- 决定是否先读完request body。
- 调用 connect。

request body异步未完成时不会阻塞等待。

## 3. get peer

算法选择一个未尝试/可用 peer，设置 sockaddr/name。

tries 表示还可尝试数量，但同时受 next_upstream_tries/time限制。

单请求需记录已尝试peer，避免同一轮立即重复选择失败节点。

## 4. 连接复用

keepalive模块可包装原算法：先让底层选择peer，再查该peer空闲连接缓存。

命中时跳过新socket connect，但仍保留此次peer选择与free记账。

缓存连接需检查EOF、超时和request上限。

## 5. connect handler

新连接 EINPROGRESS：

```text
pc.connection->write->handler = ngx_http_upstream_handler
u->write_event_handler = ngx_http_upstream_send_request_handler
add connect timer
```

事件层handler是通用入口，再分派到 `u->read_event_handler`/`write_event_handler`。

状态推进本质是不断替换函数指针。

## 6. write ready检查

connect完成要用 `getsockopt(SO_ERROR)` 确认。

成功：删除connect timer，发送请求。

失败：调用 `ngx_http_upstream_next`，并把失败类型映射到 FT_ERROR/FT_TIMEOUT等标志。

## 7. 发送请求

send_chain 可能只发送部分 request_bufs。

EAGAIN时保留剩余链，设置 send timeout等待下一 write-ready。

发送完成后：

- 切换 read handler等响应。
- 可清理/保留request body临时资源。
- 对升级/双向协议设置不同handler。

## 8. 响应 header

read-ready调用 proxy模块 `process_header` 增量解析。

返回 AGAIN则扩展/检查header buffer并继续。

无效/过大header触发 invalid_header 路径。

完成后运行 header processing/filter，再决定 buffered pipe或nonbuffered body handler。

## 9. next upstream 输入

触发类型可能包括：

- error。
- timeout。
- invalid_header。
- 特定 HTTP 5xx/4xx。
- non_idempotent 标志控制。

配置的 `proxy_next_upstream` 是允许集合，不意味着任何时候都能重试。

## 10. 已发送响应的屏障

如果客户端 header 已发送或body已输出，切换peer会产生两个响应拼接。

此时通常 finalize/close，不能透明next。

buffering让Nginx更可能在向客户端发出前发现upstream错误，但完整响应中途失败仍无法重新开始。

## 11. request_sent 与 body_sent

判断非幂等重试风险需要知道请求是否已发送到后端。

即使只发送部分body，后端也可能解析并执行某些操作。

不能以“没有读到响应”推断后端未处理。

## 12. free_peer 状态

结束尝试时传递：

- NGX_PEER_FAILED 等失败标志。
- 是否keepalive。
- 当前连接/请求结果。

round-robin据此更新 fails、checked、effective_weight、conns。

哪些HTTP status算失败由next_upstream语义影响。

## 13. tries 与超时预算

无限/过多 tries 在集群故障时将单请求放大为 N 次连接。

```text
backend_attempt_rate ≈ client_rate × avg_tries
```

剩余节点本就过载时，重试加速崩溃。

设置 tries + 总重试时间，并对调用方总deadline留余量。

## 14. timeout层叠

客户端deadline 2s，而Nginx可尝试3次每次connect 1s+read 2s，客户端早已断开，Nginx仍可能做无价值后端工作。

应满足近似：

```text
Nginx total attempt budget < caller deadline - network margin
```

## 15. 状态数组

每次尝试追加 upstream state：

- peer 地址。
- connect/header/response时间。
- status。
- response length等。

access log 多值是事故还原证据。

只保存最后一个值会隐藏第一个peer超时和第二个peer成功的延迟来源。

## 16. 客户端断开

broken connection handler可能 finalize upstream并free peer。

但已发送到后端的请求不会被事务性撤销。

后端应识别 cancellation/deadline，但仍必须幂等。

## 17. cache交互

cache HIT可能不创建真实upstream连接。

STALE可在upstream失败后返回旧响应，最终status与尝试status不同。

background update使用子请求，日志/状态需区分用户请求和更新请求。

## 18. upgraded连接

WebSocket/101后进入双向转发，不再按普通HTTP body完成。

read/write handler分别在client/upstream两侧搬运数据。

长连接影响reload排空、fd和upstream keepalive统计。

## 19. cleanup

finalize必须：

- 删除timer。
- free peer/决定连接缓存或close。
- 关闭temp file/pipe。
- 调模块 finalize callback。
- 解除request引用。
- 记录state。

遗漏timer会在复用connection后触发陈旧超时。

## 20. 源码路径

- `ngx_http_upstream.c`。
- `ngx_http_upstream_round_robin.c`。
- `ngx_http_upstream_keepalive_module.c`。
- `ngx_event_connect.c`。
- `ngx_event_pipe.c`。
- `ngx_http_proxy_module.c`。

## 21. 断点时间线

```text
upstream_init_request
upstream_connect
event_connect_peer
upstream_handler
send_request_handler
process_header
upstream_next
finalize_request
free_round_robin_peer
```

每次打印read/write handler地址、timer_set、peer tries、request_sent、header_sent和state数组。

## 22. 故障矩阵

| 注入点 | 可否安全重试 |
|---|---|
| connect refused | 通常尚未发送，较安全 |
| TLS handshake失败 | 通常未发HTTP body，但需看协议 |
| 发送前timeout | 较安全 |
| POST全部发送后reset | 业务结果不确定，危险 |
| 收到502 header未发客户端 | 取决配置、方法和幂等 |
| body已发客户端一半 | 不能透明重试 |

## 23. 面试追问

问：为什么 GET重试也不保证没有副作用？

答：HTTP语义定义GET应安全，但实际后端可能错误实现副作用；Nginx只能按方法和传输状态判断，端到端仍依赖应用契约与幂等。

