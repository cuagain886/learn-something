# 性能容量模型与 Linux 内核调优

## 1. 容量四个上限

```text
连接上限 = min(connection objects, fd, memory, kernel/network)
吞吐上限 = min(worker CPU, network, upstream, disk)
延迟上限 = 排队 + 事件循环 stall + upstream + 客户端
可用性上限 = N-1容量、重试和依赖故障模式
```

只调 sysctl 不会突破 upstream 数据库瓶颈。

## 2. fd 预算

```text
fd ≈ client connections + upstream active/idle
   + listen + logs + cached files + temp/AIO + module extras
```

`worker_rlimit_nofile`、进程 RLIMIT 和系统 file-max 同时检查。

## 3. 内存预算

```text
RSS ≈ worker base
 + connections × conn_state
 + active requests × request_pool
 + proxy buffers/temp metadata
 + TLS state
 + HTTP2 streams/header tables
 + shared zones mapped
 + allocator fragmentation
```

配置每请求 256KB buffer，10k 并发理论上就是 GiB 级。

## 4. Little's Law

稳定系统：

```text
concurrency ≈ throughput × average_latency
```

10k RPS、平均 200ms，约 2000 个 in-flight 请求；若代理需两端连接，活跃 connection 更高。

尾延迟/突发需安全系数。

## 5. accept 队列

区分：

- SYN backlog：半连接握手。
- accept queue：已完成握手等待 accept。
- listen backlog 参数与内核 somaxconn 的共同限制。

队列满可能丢 SYN、重传或连接失败。

增大队列只是吸收短突发，持续过载仍需限流/扩容。

## 6. TIME_WAIT 与端口

Nginx 作为 upstream 客户端大量新建短连接，会消耗本地临时端口并产生 TIME_WAIT。

优先 upstream keepalive，扩展端口/IP，检查 conntrack；不要盲目启用危险的 TCP reuse 参数。

## 7. CPU

消耗：TLS、gzip、regex、日志 JSON、Lua/njs/第三方模块、copy、HTTP/2/3。

worker CPU 100% 时更多连接只增加排队。

用 perf 火焰图区分加密、压缩、syscall 和模块代码。

## 8. worker affinity

绑定 CPU 可改善 cache locality，但容器 quota、NUMA、IRQ和邻居负载会改变结果。

`auto` 是起点，不是所有机器最优答案。

## 9. reuseport

内核把连接分到每 worker socket，减少 accept 竞争。

长连接 hash 分布、滚动 reload 和 BPF/内核实现会影响公平性。

压测看每 worker CPU/连接，而非总平均。

## 10. upstream 容量

Nginx 能接受 100k 连接不代表后端能处理。

需要 limit_req/conn、短超时、有界重试和熔断把压力限制在后端安全范围。

故障后剩余实例要有 N-1容量；否则重试造成级联故障。

## 11. 压测方法

逐阶段：静态基线 → mock upstream → 真实 upstream → TLS → 缓冲/cache → 故障。

保持连接复用、消息大小、响应大小、慢客户端比例和协议与生产一致。

寻找延迟拐点：负载加10%，P99倍增而吞吐不增即接近饱和。

## 12. 内核观测

```text
ss -s / socket states
sar -n TCP,ETCP
/proc/net/netstat
pidstat/perf
file-nr
softnet_stat
NIC drops/errors
conntrack usage
```

将 retransmit、listen overflow、softirq、CPU与 Nginx 指标时间对齐。

## 13. 面试追问

问：为什么 worker_connections×workers 不是最大并发用户？

答：它计所有 connection，对代理请求常有 client+upstream，且还受 fd、内存、HTTP/2 stream 和系统队列限制。

