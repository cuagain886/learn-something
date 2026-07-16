# 事件循环、epoll 与连接对象

## 1. readiness 不是异步完成

epoll 告诉 Nginx：某 fd 现在可能执行 read/write 而不阻塞。

它不表示完整 HTTP 请求已经读取，也不表示磁盘或 upstream 操作自动在后台完成。

handler 必须循环读写，直到：

- 完成当前协议步骤。
- 返回 EAGAIN，重新等待事件。
- 出错或超时，关闭/finalize。

## 2. 核心对象关系

```text
ngx_cycle_t
├── connections[]: ngx_connection_t
├── read_events[]: ngx_event_t
└── write_events[]: ngx_event_t

ngx_connection_t
├── fd
├── read  -> ngx_event_t
├── write -> ngx_event_t
├── data  -> 当前协议对象
├── pool
├── recv/send/recv_chain/send_chain function pointers
└── log
```

HTTP 初始阶段 `connection->data` 可指向 HTTP connection context，解析请求后关联 request。

upstream 也使用 `ngx_connection_t`，所以 worker_connections 同时被两端消耗。

## 3. 连接池不是数据库连接池

worker 启动时预分配 connection/event 数组和 free connection 链。

accept 一个 fd 后从 free list 取 `ngx_connection_t`。

关闭后清理事件、pool、fd，再归还 free list。

目的：避免每次连接频繁分配核心结构，并用索引/generation 防止陈旧事件误指向复用连接。

## 4. worker_connections 的真实上限

每个 worker 最大连接对象约为 worker_connections，但受以下更小值限制：

```text
RLIMIT_NOFILE
worker_rlimit_nofile
系统 fd 上限
可用内存
监听/日志/文件 fd
客户端 + upstream + cache/file/AIO 资源
```

反向代理粗略估算：

```text
active client ≈ worker_processes × worker_connections / 2
```

除以 2 是因为一个活跃请求常同时占 client 和 upstream 连接，只是粗略上界；keepalive、缓存命中、静态文件和 HTTP/2 会改变比例。

## 5. epoll 注册

Linux 事件模块维护 epoll fd。

典型操作：

- `epoll_ctl ADD/MOD/DEL` 注册或修改兴趣事件。
- `epoll_wait` 等待就绪。
- 将返回事件映射回 Nginx event/connection。
- 调用 read/write handler 或放入 posted queue。

使用边缘/水平触发等细节由模块实现和事件标志决定，模块 handler 必须遵守读到 EAGAIN 的协议。

## 6. 事件循环一次迭代

概念路径：

```text
计算最近 timer 的等待时间
调用 event module process_events(epoll_wait)
更新时间
处理 accept/read/write 就绪
处理 posted accept events
处理过期 timer
处理普通 posted events
检查退出/reopen 等标志
```

所有 handler 在一个 worker 主线程上串行执行。

一个 handler 做 200ms CPU 计算，该 worker 其他 fd 即使已就绪也只能等待。

## 7. timer 的红黑树

超时事件按到期时间保存在 timer rbtree。

添加 read timeout 本质是给 read event 设置 timer。

数据到达后 handler 可能删除/重置 timer。

超时回调与 I/O 就绪不会在同一 worker 真并发，但相邻循环的先后决定最终行为。

配置 `proxy_read_timeout 60s` 通常表示两次读取操作之间的等待上限，不是整个响应总耗时硬截止。

## 8. posted events

某些就绪事件不会立即深度递归调用，而是加入 posted queue 稍后统一处理。

作用：

- 控制调用栈。
- 调整 accept 与普通事件公平性。
- 在状态更新完成后执行后续 handler。

理解 posted queue 有助于读懂“函数设置 handler 后返回，实际稍后继续”的异步状态机风格。

## 9. accept 惊群与分配

多个 worker 监听同一 socket 时都可能被唤醒。

机制包括：

- accept mutex：轮流获得 accept 权。
- EPOLLEXCLUSIVE：内核减少无效唤醒。
- `reuseport`：每 worker 独立 socket，由内核 hash/调度。

现代 Linux 支持 EPOLLEXCLUSIVE 时通常不需要 accept_mutex。

reuseport 可改善 accept 分布，但连接 hash 和长短连接差异仍可能造成 worker 负载不均。

## 10. multi_accept

开启后 worker 一次就绪尽量 accept 多个等待连接。

优点：突发连接建立更快。

风险：某 worker 大量 accept，普通连接事件延迟增加，分布可能更不均。

是否开启应以连接突发、延迟和 worker 公平性压测决定。

## 11. nonblocking connect

连接 upstream：

```text
socket(nonblocking)
connect
 -> 立即成功
 -> EINPROGRESS: 注册 write event
write ready
 -> getsockopt(SO_ERROR) 检查连接结果
```

write-ready 不等于连接一定成功，必须检查 SO_ERROR。

`proxy_connect_timeout` 覆盖这个状态，不能与等待响应 header 的 read timeout 混淆。

## 12. 链式 buffer I/O

Nginx 常使用 `ngx_buf_t` + `ngx_chain_t` 描述内存、文件或特殊控制 buffer。

send_chain 可组合：

- 内存 header。
- 文件 body。
- flush/last 标志。

部分发送后更新 pos/file_pos，剩余 chain 下次 write-ready 继续。

这就是非阻塞响应不能假设一次 send 完成的原因。

## 13. 慢客户端

客户端接收窗口很小：

1. Nginx send 返回 EAGAIN。
2. 注册 write event。
3. 响应数据留在 buffer/临时文件。
4. write timeout 保护无限占用。

如果 proxy buffering 关闭，上游响应也可能被迫跟随慢客户端速度，upstream 连接长期占用。

## 14. 慢请求头攻击

客户端每隔数秒发一个字节。

Nginx 虽不为每连接创建线程，但仍消耗：

- fd 和 connection。
- request/connection pool。
- timer。
- TLS state（HTTPS）。

需要 `client_header_timeout`、header buffer 限制、连接/请求限速和边缘防护。

事件驱动不是无限连接免疫。

## 15. 线程池和 AIO

文件 I/O 或第三方阻塞操作可能阻塞 event loop。

Nginx thread pool 可把支持的文件任务提交到工作线程，完成后通过 notify/posted event 回到 worker event loop。

模块不能随意在线程中访问 request 的所有状态；必须明确所有权、生命周期和回调线程。

线程池不是把整个 Nginx 改成每请求一线程。

## 16. stall 诊断

事件循环 stall 表现：

- 所有 upstream 同时看似变慢。
- timer 批量延迟触发。
- accept 延迟。
- 单 worker CPU 100%。
- 请求 P99 出现同步尖峰。

原因：

- 正则灾难性回溯。
- 大量压缩/加密 CPU。
- 阻塞模块或磁盘调用。
- 超大响应 header/filter 循环。
- debug 日志/磁盘阻塞。

可用 perf、火焰图、strace、debug point 和 event-loop stall 指标定位。

## 17. 源码导航

- `src/event/ngx_event.c`：事件核心初始化与连接数组。
- `src/event/ngx_event_timer.c`：timer rbtree。
- `src/event/ngx_event_posted.c`：posted queues。
- `src/event/modules/ngx_epoll_module.c`：Linux epoll。
- `src/event/ngx_event_accept.c`：accept handler。
- `src/core/ngx_connection.c`：连接获取、释放、监听 socket。

## 18. 断点实验

在 debug build 对以下函数断点：

```text
ngx_process_events_and_timers
ngx_epoll_process_events
ngx_event_accept
ngx_get_connection
ngx_close_connection
ngx_add_timer
ngx_event_connect_peer
```

记录同一 `connection->number` 的 read/write handler 如何随协议阶段改变。

## 19. 面试追问

问：epoll 为什么能支持高并发？

答：避免对所有 fd 轮询并只通知就绪集合，配合非阻塞状态机减少线程和上下文切换；但业务 handler、内存和 fd 仍是上限。

问：worker_connections=65535 是否能代理 65535 个并发请求？

答：通常不能。代理请求常同时占 client/upstream 两个连接，还受 fd、监听、keepalive、HTTP/2 和内存限制。

