# server 与 location 匹配算法

## 1. 先选 listen，再选名字

连接先由目标 local address:port 命中监听 socket。

该 listen 集合有一个 default server，它是端口属性，不是 `server_name _` 自动产生。

随后：

- TLS 握手阶段用 SNI 查 SSL server。
- HTTP 阶段用 Host 查 virtual server。
- 无匹配/无 Host 时回到该 listen 的 default server或拒绝非法请求。

## 2. server_name 优先级

概念顺序：

1. 精确名字。
2. 以 `*.` 开头的最长 wildcard。
3. 以 `.*` 结尾的最长 wildcard。
4. 按配置顺序第一个匹配 regex。
5. default server。

regex server_name 性能和可维护性较差，capture 生命周期也需注意。

## 3. SNI 与 Host

TLS certificate 在加密 HTTP 请求到达前选择。

因此不能用 Host 决定最初证书。

如果 SNI=foo、Host=bar：

- TLS 可能使用 foo 的证书/协议配置。
- HTTP request 可能切换到 bar 的 server 配置。
- 某些 SSL 参数只能来自握手时上下文。

高安全场景应校验两者一致或用 default server `ssl_reject_handshake` 拒绝未知 SNI。

## 4. location 基本算法

对规范化 URI：

1. 查找最具体 prefix location。
2. exact `=` 命中立即使用。
3. 最长 prefix 带 `^~` 时跳过当前层 regex。
4. 否则按配置顺序检查 regex，首个命中胜出。
5. 无 regex 命中，使用最长 prefix。

“prefix 按书写顺序”是错误的；regex 才有显著顺序语义。

## 5. 嵌套 location 的细节

嵌套 prefix 会逐层查找。

regex 的检查与上升过程容易产生反直觉结果，尤其外层 prefix、内层 `^~` 和外层 regex 混用。

生产配置优先扁平、可预测的结构；不要用复杂嵌套来展示技巧。

## 6. exact location

```nginx
location = /healthz { return 200; }
```

完全相等直接结束搜索，性能和语义明确。

`/healthz?x=1` 的 location 匹配只看 URI path，不看 args。

## 7. prefix 与尾斜杠

`location /api/` 不匹配 `/api`。

某些 proxy/fastcgi location 对无尾斜杠 URI会自动 301 到带斜杠形式，但不能依赖模糊记忆，需实测具体 content handler。

常显式增加：

```nginx
location = /api { return 301 /api/; }
```

## 8. regex location

`~` 区分大小写，`~*` 不区分。

regex 按出现顺序首个命中，不比较“更具体”。

灾难性回溯可阻塞 worker；PCRE JIT 能改善部分性能但不能修复坏表达式。

捕获变量可能被后续 regex 覆盖，不要跨复杂阶段依赖隐式 capture。

## 9. named location

`location @fallback` 不由外部 URI直接匹配。

它由 `try_files`、`error_page` 或内部跳转进入。

适合定义 fallback upstream，避免重新做普通 URI location 匹配。

## 10. 内部重定向

rewrite、index、try_files、error_page 等可改变 URI并重新进入 location 查找。

每次可能获得新的 loc_conf 和 content handler。

Nginx限制 URI changes 次数，防止无限循环。

```text
/a -> rewrite /b -> error_page -> /a
```

最终会报 rewrite/internal redirection cycle。

## 11. proxy_pass URI 替换

prefix location：

```nginx
location /api/ {
    proxy_pass http://backend/v1/;
}
```

匹配的规范化 location 前缀 `/api/` 被 `/v1/` 替换。

不带 URI：

```nginx
proxy_pass http://backend;
```

通常传递原始或当前完整规范化 URI，具体取决于 URI 是否被 rewrite。

regex/named/变量 proxy_pass 中无法总能确定要替换的前缀，规则不同。

必须用表驱动测试，而不是凭斜杠直觉。

## 12. try_files

`try_files` 按当前 root/alias 构造文件路径并检查存在性，最后参数可内部重定向到 URI、named location 或返回状态码。

```nginx
try_files $uri $uri/ @app;
```

它不是简单的 shell 文件测试；会结合 location 配置、URI 和内部跳转。

SPA 配置若错误可能把不存在静态资源也返回 index.html，隐藏 404 和缓存问题。

## 13. 安全 default server

公网端口应显式定义 default：

```nginx
server {
    listen 80 default_server;
    server_name "";
    return 444;
}
```

HTTPS 可按版本使用拒绝握手。

目的：未知 Host 不落入第一个业务 server，减少 Host header 攻击和错误证书暴露。

## 14. 测试矩阵

每次修改 location，至少测试：

```text
精确 path
有/无尾斜杠
大小写
percent encoding
重复斜杠
query string
不存在文件
rewrite 前后
错误页内部跳转
不同 Host/SNI
```

记录 `$server_name $host $uri $request_uri $document_root $request_filename`。

## 15. 面试追问

问：`^~` 是否意味着全局最高优先级？

答：它让选中的 prefix 在相应层级跳过 regex 检查；exact `=` 仍可更早结束，复杂嵌套也需按层级算法分析。

