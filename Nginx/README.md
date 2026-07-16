# Nginx 深度学习手册

本目录不是配置指令词典，而是从请求进入监听 socket 开始，一直追踪到 worker 事件循环、HTTP 状态机、location 选择、upstream 建连、响应过滤、日志落盘和连接复用。

统一源码基线使用官方 Nginx 主线版本的结构与命名；具体函数和指令出现版本以部署版本为准。

## 学习主线

```mermaid
flowchart LR
    A["配置解析与 cycle"] --> B["master/worker"]
    B --> C["监听 socket 与 accept"]
    C --> D["epoll 事件循环"]
    D --> E["HTTP 请求状态机"]
    E --> F["server/location/phase"]
    F --> G["upstream 与负载均衡"]
    G --> H["buffer/filter/cache"]
    H --> I["TLS/HTTP2/HTTP3"]
    I --> J["性能、观测、事故与源码"]
```

## 文档地图

| 编号 | 文档 | 核心问题 |
|---|---|---|
| 00 | [学习计划](00_学习计划.md) | 如何从会写配置进阶到能解释请求状态机 |
| 01 | [架构、进程模型与信号](01_架构进程模型与信号.md) | master/worker 如何启动、重载和优雅退出 |
| 02 | [事件循环、epoll 与连接对象](02_事件循环_epoll与连接对象.md) | 一个 worker 如何管理成千上万连接 |
| 03 | [配置解析、模块上下文与继承](03_配置解析模块上下文与继承.md) | 指令如何变成模块配置，继承为何常被误解 |
| 04 | [HTTP 连接与请求状态机](04_HTTP连接与请求状态机.md) | 从 accept 到请求行、header、body、finalize 的路径 |
| 05 | [server 与 location 匹配](05_server与location匹配算法.md) | 虚拟主机和 location 的真实选择顺序 |
| 06 | [HTTP phases 与 rewrite](06_HTTP阶段引擎与rewrite陷阱.md) | access/content/filter 等阶段怎样串联 |
| 07 | [反向代理与 upstream 状态机](07_反向代理与upstream状态机.md) | proxy_pass 后请求如何连接、发送、读取与重试 |
| 08 | [负载均衡与健康判定](08_负载均衡算法与健康判定.md) | round-robin、least_conn、hash 的状态与边界 |
| 09 | [缓冲、流控与临时文件](09_缓冲流控临时文件与零拷贝.md) | proxy_buffering 如何隔离快慢两端 |
| 10 | [缓存底层原理](10_proxy_cache底层原理与一致性.md) | cache key、共享索引、磁盘文件和惊群怎样治理 |
| 11 | [TLS 握手与证书](11_TLS握手证书会话复用与安全.md) | SNI、证书选择、session cache 和 CPU 成本 |
| 12 | [HTTP/2 与 HTTP/3](12_HTTP2_HTTP3多路复用与队头阻塞.md) | 多路复用改变了什么，瓶颈转移到哪里 |
| 13 | [静态文件与压缩](13_静态文件_sendfile_gzip与文件缓存.md) | sendfile、open_file_cache、gzip 的内核路径 |
| 14 | [限流、限连接与安全边界](14_限流限连接访问控制与安全边界.md) | 漏桶、共享区、真实 IP 与请求走私风险 |
| 15 | [日志、变量与可观测性](15_日志变量指标与延迟拆解.md) | 如何把客户端、Nginx、upstream 延迟拆开 |
| 16 | [性能容量与内核调优](16_性能容量模型与Linux内核调优.md) | worker_connections 为何不等于最大用户数 |
| 17 | [热更新与高可用](17_配置重载热升级与高可用.md) | reload 为何可以无损，哪些情况仍会断流 |
| 18 | [Stream 四层代理](18_Stream四层代理与UDP会话.md) | TCP/UDP 代理与 HTTP 模块有哪些本质差异 |
| 19 | [源码阅读地图](19_源码阅读地图与关键结构.md) | 从 main/cycle/event/http/upstream 如何阅读源码 |
| 20 | [故障注入实验](20_故障注入与性能实验手册.md) | 如何验证超时、重试、缓存、reload 和慢客户端 |
| 21 | [生产事故推演](21_生产事故时间线与根因分析.md) | 怎样还原 502/504、连接耗尽和重试风暴 |
| 22 | [面试题](22_面试必考题与深度回答.md) | 如何回答机制、故障边界和选型问题 |
| 23 | [内存池与 Buffer 源码](23_内存池_Chain_Buffer与生命周期.md) | pool、large、cleanup、chain 与 shadow buffer 如何安全释放 |
| 24 | [HTTP Parser 与 Finalize 源码](24_HTTP解析器_Request引用计数与Finalize.md) | 增量解析、异步引用和请求终结为何容易出错 |
| 25 | [Upstream 重试源码](25_Upstream重试_Peer状态与事件Handler切换.md) | peer 选择、失败记账、next upstream 和回调切换如何发生 |

## 六条核心不变量

1. 一个 worker 的事件循环不能执行长时间阻塞任务，否则该 worker 上所有连接都会受影响。
2. `worker_connections` 包含客户端和 upstream 等所有连接，不等于可服务客户端数。
3. 配置 reload 是新旧 worker 并存与连接排空，不是原进程内直接修改所有配置对象。
4. `proxy_next_upstream` 对非幂等请求可能放大副作用，重试必须结合请求是否已发送和业务幂等。
5. `proxy_buffering` 不是简单的“开更快、关更实时”，它决定背压、内存、磁盘和 upstream 占用方式。
6. HTTP 502/504 只是结果分类，必须结合 upstream 地址、connect/header/response time 和错误日志定位阶段。

## 权威材料

- [Nginx 官方文档](https://nginx.org/en/docs/)
- [Nginx Development Guide](https://nginx.org/en/docs/dev/development_guide.html)
- [How nginx processes a request](https://nginx.org/en/docs/http/request_processing.html)
- [Nginx 官方源码](https://github.com/nginx/nginx)
