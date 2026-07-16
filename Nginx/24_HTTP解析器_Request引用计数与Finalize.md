# HTTP 解析器、Request 引用计数与 Finalize

## 1. 增量 parser

请求行和 header parser 接收 buffer 指针与保存的状态。

返回：完整、需要更多数据、非法请求。

每次 recv 后继续，不能要求 TCP 保留应用报文边界。

## 2. 请求行状态

解析 method、URI起止、schema/host可选部分、HTTP major/minor。

严格验证空格、控制字符、百分号和版本。

parser 尽量不分配，把字段先表示为原buffer切片；后续规范化才复制必要 URI。

## 3. buffer 跨读取

请求行超过当前 buffer时需要大 header buffer并复制未完成片段。

指针必须在 buffer移动后重定位。

模块过早保存原 header buffer 指针可能在大buffer切换后失效。

## 4. header 状态机

逐字符识别 name、colon、optional whitespace、value、CRLF。

header name可计算 lowercase hash，随后快速查 header handler table。

特殊 header handler更新 headers_in 快捷字段并检查重复/冲突。

## 5. CL/TE 歧义

Content-Length 与 Transfer-Encoding 冲突、多个不一致 Content-Length 必须拒绝。

前后代理解析差异是 request smuggling 根源。

不能用“后端会再校验”放松边缘解析。

## 6. Host

Host 验证域名/IP、端口、非法字符，并用于 virtual server 查找。

absolute-form URI 中 host 与 Host header 的关系也需一致处理。

默认 server 应拒绝未知 host，避免落入第一个业务站点。

## 7. request 创建

创建 request pool 和 `ngx_http_request_t`，初始化：

- main 指向自己。
- count 初始引用。
- connection/request log context。
- conf arrays来自当前 server。
- read/write event handler。

随后解析请求行/header并启动 phases。

## 8. r->count

主请求引用计数保护异步工作。

创建 subrequest、异步 body读取、某些 upstream 操作会增加计数。

完成对应工作再减少。

计数归零才允许真正 free request。

多减导致 use-after-free，少减导致连接/request泄漏。

## 9. blocked 与 aio

除 count 外还有 blocked、aio等状态阻止请求过早 finalize。

线程任务完成前 request不能销毁。

取消/客户端断开路径仍必须等待或安全取消异步任务。

## 10. subrequest

subrequest 有 parent/main关系。

主请求 count增加。

子请求经历自己的 phase/content/filter，完成后 post_subrequest callback恢复父流程。

子请求通常不直接向客户端独立发送完整响应，输出进入主请求链或被丢弃/捕获。

## 11. finalize rc 分支

`ngx_http_finalize_request(r, rc)` 不是统一销毁：

- NGX_DONE：当前异步链已处理。
- NGX_DECLINED：继续阶段。
- status/error：special response。
- subrequest：完成子请求、调 parent。
- 主请求 count仍大：只减引用/等待。
- 可 keepalive：设置空闲 handler。
- 否则 close request/connection。

## 12. special response

错误 status 可能经过 error_page 内部重定向。

这会创建新 URI处理而非立即发送内建错误页。

内部跳转仍使用同一主请求生命周期并有循环上限。

## 13. header_sent

响应 header 已发送后，不能再改 status或安全重试生成另一完整响应。

body filter错误只能关闭连接/截断。

这就是 upstream retry 必须在向客户端发送前决定。

## 14. 客户端断开

read/write event检测 EOF/error。

request可能：

- 尚未到 upstream。
- upstream处理中。
- 已完成副作用。
- 正在发送响应。

Nginx清理资源，但无法撤销外部业务。

## 15. cleanup 顺序

close request：运行 request cleanup、关闭临时文件/upstream、log phase、destroy pool。

connection 若 keepalive则不关闭；否则关闭 fd并归还 connection。

日志handler不能再安排依赖 request pool 的长期异步任务。

## 16. keepalive 重新武装

销毁旧 request 后，connection read handler改为 keepalive handler。

若 buffer已含 pipelined 下一请求字节，可posted event立即创建新request。

否则添加 keepalive timer等待。

## 17. lingering close

响应已发但请求body未读完，立即close可能RST覆盖客户端未读响应。

有限时间继续读取并丢弃数据，直到EOF/超时/最大时间。

攻击者可用慢body占连接，因此必须有上限。

## 18. HTTP/2差异

一个connection有多个stream/request。

关闭一个request不关闭整个TCP连接。

connection错误可能终止全部streams。

request引用和stream flow-control状态需共同清理。

## 19. 模块异步模板

```text
增加 request 引用/标记 blocked
保存最小必要 context到request pool
注册 event/thread/subrequest callback
返回 NGX_DONE/AGAIN
callback检查取消状态
完成业务
解除 blocked/减少引用
ngx_http_finalize_request
```

具体API按模块类型使用，不能手工随意操作 count。

## 20. 常见泄漏

- body callback未调用finalize。
- subrequest callback错误路径未恢复parent。
- upstream模块覆盖handler后不清timer。
- thread completion丢失。
- cleanup链持有循环引用的外部资源。

表现为 active connections、旧worker、RSS长期不降。

## 21. 源码路径

- `ngx_http_request.c`。
- `ngx_http_parse.c`。
- `ngx_http_request_body.c`。
- `ngx_http_special_response.c`。
- HTTP/2 request/stream实现。

## 22. 断点

```text
ngx_http_create_request
ngx_http_process_request_line
ngx_http_process_request_headers
ngx_http_process_request
ngx_http_finalize_request
ngx_http_close_request
ngx_http_set_keepalive
ngx_http_lingering_close
```

记录 r->count、blocked、main/parent、read/write handler、header_sent和pool地址。

## 23. 面试追问

问：为什么 finalize 被调用后请求可能仍未释放？

答：它是状态机终结入口，要处理子请求、引用计数、异步操作、错误页、keepalive和lingering close；只有所有引用和阻塞状态完成才销毁pool。

