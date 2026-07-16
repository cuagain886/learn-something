# HTTP 阶段引擎与 rewrite 陷阱

## 1. 模块不是按配置文件顺序执行

HTTP core 在配置期构建 phase engine。

模块把 handler 注册到特定阶段。

请求运行时沿 phase handler 数组推进，返回码决定继续、跳转、异步等待或 finalize。

## 2. 主要阶段

概念顺序：

```text
POST_READ
SERVER_REWRITE
FIND_CONFIG
REWRITE
POST_REWRITE
PREACCESS
ACCESS
POST_ACCESS
PRECONTENT
CONTENT
LOG
```

模块示例：

- realip 常在早期阶段改写客户端地址。
- rewrite 模块在 server/location rewrite 阶段。
- limit_req/limit_conn 在 preaccess。
- access/auth_request 在 access。
- static/proxy/fastcgi 在 content。
- access log 在 log。

具体注册顺序以模块源码和构建顺序为准。

## 3. phase handler 返回值

handler 可返回：

- NGX_DECLINED：本模块不处理，继续。
- NGX_OK：当前检查通过，phase checker 决定下一步。
- NGX_AGAIN/NGX_DONE：异步等待或已接管。
- HTTP status：生成错误/重定向并 finalize。

同一个返回码在不同 checker 中处理细节不同。

## 4. rewrite 是小型指令 VM

rewrite 模块把 `set`、`if`、`rewrite`、`return` 等编译为脚本指令。

请求时执行 stack-based script。

它不是通用 imperative language，配置块的创建/继承与普通编程 if 不同。

## 5. `if` 的问题

location 内 `if` 可能创建独立 location configuration context。

部分指令在其中行为不直观或根本不允许。

安全用法通常限于：

- `return`。
- `rewrite ... last`。
- 简单设置变量。

路由映射优先用 `map`，文件判断用 `try_files`，访问控制用对应模块。

## 6. last 与 break

`rewrite ... last`：结束当前 rewrite 脚本，以新 URI重新做 location 查找。

`rewrite ... break`：结束当前 rewrite 脚本，通常继续使用当前 location 配置处理改变后的 URI。

误用 last 可改变 content handler，误用 break 可让 proxy_pass URI 处理与预期不同。

## 7. rewrite loop

server rewrite 后找 location，location rewrite 改 URI 后可再次找 location。

内部有 URI change 上限。

循环常来自：

- HTTP/HTTPS 重定向未识别前置代理协议。
- 尾斜杠规则相互跳转。
- error_page 回到原 URI。
- SPA try_files 与 rewrite 组合。

## 8. access 阶段组合

多个 access handler 的结果由 `satisfy all|any` 等配置组合。

例如 IP allow 与 basic auth：

- all：二者都通过。
- any：任一通过。

顺序和异步 auth subrequest 会影响错误码与挑战 header。

## 9. content handler 唯一性

最终通常由一个 content handler 生成主体：static、proxy、fastcgi、return 等。

同一 location 配置多个 content 指令，不是多个处理器串行；后设置/模块配置可能覆盖或冲突。

body filter 才是响应内容的链式处理。

## 10. filter chain

header filter 和 body filter 在配置期组成链。

模块保存 next filter，处理后调用下一个。

顺序与模块初始化顺序相关，不等同配置书写顺序。

典型 filter：

- gzip。
- chunked。
- range。
- header。
- copy/write filter。

body 可能分多次 chain 到达，filter 必须保存跨调用状态，不能假设一次收到完整响应。

## 11. subrequest 与 phases

auth_request 创建子请求访问鉴权 endpoint。

主请求暂停，子请求执行自己的 location/phases/upstream。

完成回调再恢复主请求 access 阶段。

错误配置可能递归鉴权或把大 body 意外传给鉴权服务。

## 12. internal location

`internal` location 只允许内部重定向、subrequest 等进入，外部直接请求返回 404。

适合受控错误页、X-Accel-Redirect 文件和内部 auth endpoint。

但必须验证所有进入路径和 URI normalization。

## 13. error_page

```nginx
error_page 404 = @fallback;
error_page 500 502 503 504 /50x.html;
```

可以保留/替换 status，并触发内部跳转。

upstream 错误若被 error_page 转成 200，会污染监控和 cache。

日志应同时记录最终 status 与 upstream_status。

## 14. 日志阶段

log phase 在请求结束路径执行，模块可记录最终字节、时间、upstream 尝试。

客户端提前断开、内部重定向和子请求会影响哪些请求产生 access log。

不要在 log handler 做阻塞远程调用。

## 15. 源码导航

- `src/http/ngx_http.c`：phase 数组构建。
- `src/http/ngx_http_core_module.c`：phase runner/checkers。
- `src/http/modules/ngx_http_rewrite_module.c`。
- `src/http/ngx_http_script.c`：rewrite script VM。
- `src/http/ngx_http_request.c`：phase 启动/finalize。

## 16. 调试

把 location 结果写入响应 header仅限测试：

```nginx
add_header X-Debug-Location api always;
```

配合 rewrite log/debug log，记录 `$uri $request_uri $status $upstream_status`。

为每条测试 URI画：初始 URI → server rewrite → location → location rewrite → 新 location → content。

## 17. 面试追问

问：Nginx 模块执行顺序由配置顺序决定吗？

答：通常不是。模块注册到 phase/filter chain，配置期构建运行数组；指令顺序只在少数有序列表或 rewrite script 内直接相关。

