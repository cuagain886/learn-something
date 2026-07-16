# HTTP 连接与请求状态机

## 1. TCP connection 不等于 HTTP request

一个 HTTP/1.1 keepalive 连接可顺序承载多个 request。

```text
ngx_connection_t lifetime
  request #1: ngx_http_request_t + request pool -> finalize
  keepalive idle
  request #2: new request + new request pool -> finalize
  close
```

连接级对象跨请求存在，请求 pool 在单请求结束后销毁。

模块把 request 内存指针缓存到连接级全局状态会造成 use-after-free。

## 2. accept 到 HTTP 初始化

监听 socket 的 handler accept 新 fd，取得 connection，设置非阻塞和日志。

HTTP listen handler 调用 `ngx_http_init_connection()`：

- 建立 HTTP connection context。
- 依据端口/地址关联 server 配置。
- HTTPS 时进入 TLS handshake handler。
- 否则设置读取请求 handler。
- 添加 client header timeout。

此时还没有完整 Host，不能最终选择 name-based server。

## 3. 请求行增量解析

客户端数据可能任意分片：

```text
GET /api HT
TP/1.1\r\nHo
st: example.com\r\n...
```

parser 是有限状态机，保存当前位置和状态，下次 read-ready 继续。

不能假设一次 recv 得到完整 header。

解析得到 method、URI、args、HTTP version 等。

## 4. URI normalization

Nginx 区分原始请求和规范化 URI。

- `$request_uri` 通常保留原始 URI 与 args。
- `$uri` 是当前规范化 URI，内部 rewrite 后可变化。

规范化涉及百分号解码、`//` 合并配置、`.`/`..` 处理等。

安全规则和 upstream 签名若分别使用不同形式，可能出现路径绕过或签名不一致。

## 5. header 解析

每行 header 解析为 `ngx_table_elt_t` 等结构，并对 Host、Content-Length、Transfer-Encoding、Connection 等建立快捷字段。

需要拒绝：

- 非法 header 字符。
- 冲突 Content-Length。
- 不支持的 transfer encoding。
- header 过大。
- Host 非法。

缓冲由 `client_header_buffer_size` 和 large header buffers 控制。

超大 Cookie 可能触发 400/414，并使每连接分配大 buffer。

## 6. 虚拟主机切换

监听地址先给出默认 server context。

TLS SNI 可能在握手期间选择 SSL server 配置。

HTTP Host 解析后再做 virtual server 查找，更新 request 的 srv/loc conf。

SNI 和 Host 不一致时需明确策略；证书已经在 HTTP header 到达前选择。

## 7. Expect: 100-continue

客户端可能先发 header，等待 `100 Continue` 后再发送大 body。

Nginx/模块决定是否发送 interim response 并读取 body。

upstream 请求缓冲、鉴权阶段和 body 读取时机决定大上传是否在拒绝前已经消耗网络/磁盘。

## 8. request body 不是自动全部读取

Content handler/upstream 模块按需调用 `ngx_http_read_client_request_body()`。

body 可能：

- 已在 header buffer 中有一部分。
- 读入内存 chain。
- 超过阈值写 client body temp file。
- chunked 解码。
- 异步读取完成后调用 post handler。

函数常返回 `NGX_DONE`/`NGX_AGAIN` 等，调用者不能继续同步假设 body 已完成。

## 9. 主请求和子请求

SSI、auth_request 等可创建 subrequest。

它共享/引用主请求部分状态，但有自己的 URI、phase 和输出处理。

主请求的 `count` 引用计数防止子请求未结束时提前释放。

错误 finalize 次数会导致请求泄漏或过早销毁。

## 10. finalize 不是简单 close

`ngx_http_finalize_request(r, rc)` 根据状态：

- 继续异步操作。
- 执行 special response。
- 结束子请求并唤醒 parent。
- 调用 log phase。
- 释放 request pool。
- 进入 keepalive。
- lingering close 读取客户端剩余数据。
- 关闭 connection。

请求结束与 TCP 关闭是两个不同决策。

## 11. lingering close

Nginx 已返回错误/响应，但客户端还在发送 body。

立即 close 可能产生 TCP RST，使客户端收不到完整响应。

lingering close 在有限时间内丢弃剩余输入，再正常关闭。

它消耗连接，因此有 timeout/max time 保护。

## 12. keepalive

请求完成且满足条件时：

- 销毁 request pool。
- 保留 connection。
- 设置 keepalive read handler。
- 添加 keepalive timeout。
- 等待下一请求首字节。

keepalive 降低 TCP/TLS 握手，但大量空闲连接消耗 fd、connection 和 TLS 状态。

`keepalive_requests`/`keepalive_time` 可限制单连接长期占用和内存累积。

## 13. pipelining

HTTP/1.1 pipelining 可在前一响应完成前发送后续请求，但响应仍按序。

Nginx 可能把额外字节保存在 buffer，当前请求结束后创建下一 request。

慢前一响应会造成应用层队头阻塞。

现代客户端更多使用 HTTP/2 多路复用。

## 14. request pool

请求小对象从 pool 分配，结束时批量销毁，减少 malloc/free。

大分配单独挂链并在 destroy 时释放。

pool cleanup 可注册关闭文件等回调。

规则：

- 不单独 free 普通小分配。
- 不在请求结束后使用其内存。
- 异步回调必须增加请求引用并保证生命周期。

## 15. 错误码与状态

内部返回码：

- `NGX_OK`：当前步骤完成。
- `NGX_AGAIN`：等待未来事件。
- `NGX_DONE`：当前层异步接管/已处理。
- `NGX_DECLINED`：本模块不处理，让后续模块继续。
- `NGX_ERROR`：内部错误。

它们不等于 HTTP status，phase engine 会按上下文解释。

## 16. 源码路径

- `src/http/ngx_http_request.c`：connection 初始化、请求解析、finalize、keepalive。
- `src/http/ngx_http_parse.c`：请求行/header parser。
- `src/http/ngx_http_request_body.c`：body。
- `src/http/ngx_http_special_response.c`：错误响应。
- `src/http/ngx_http_core_module.c`：URI、location 和 content。

## 17. 调试时间线

在 access log 增加 connection/request 标识，在 debug log 搜索同 connection number。

用客户端分别制造：

- header 分片。
- header 超限。
- body 慢传。
- body 未发完就断开。
- keepalive 多请求。
- upstream 返回前客户端断开。

追踪 request pool 何时销毁、connection 何时归还。

## 18. 面试追问

问：为什么 Nginx request body 读取需要回调？

答：socket 非阻塞，body 可能尚未到达或需要写临时文件；函数注册事件并在完成后调用 handler，不能阻塞 worker 等待。

