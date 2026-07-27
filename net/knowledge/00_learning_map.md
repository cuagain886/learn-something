# 00 | 学习地图

> 本章回答三个问题：这套材料有哪些章、各章解决什么问题、按什么顺序学。
> 生成规格见 [../goal.md](../goal.md)，环境准备见 [../README.md](../README.md)。

## 一、全景：知识如何分层组织

整套材料围绕一条主线展开——**"一个请求的完整一生"**：

```text
应用发起请求
   │
   ▼
[08 DNS]──── 域名 → IP
   │
   ▼
[05 TCP连接]─ 三次握手建立连接        ┐
[10 TLS]───── 加密通道协商            │ 每一步都可能失败、
   │                                  │ 都有超时、都能抓包看到
   ▼                                  ┘
[09 HTTP/1.1]─ 请求/响应语义
[11 HTTP/2/3]─ 多路复用与 QUIC
[12 流式通信]─ SSE / WebSocket / LLM 流式输出
   │
   ▼
[13 代理/LB]── 中间还隔着 Nginx、网关、负载均衡
[14 容器网络]─ 以及 veth、iptables、K8s Service
   │
   ▼
[06 TCP传输]── 数据真正跑起来：窗口、重传、拥塞控制
[07 Socket]─── 应用代码如何正确收发：分包、超时、连接池
   │
   ▼
[17 排障]───── 任何一环出问题，如何逐层定位

支撑层：[01 分层模型] [02 链路层] [03 IP/路由/NAT] [04 UDP]
横切层：[15 安全/SSRF] [16 性能调优]
落地层：[18 面试题] [19 十二周计划] [综合项目 Agent Gateway]
```

## 二、章节清单：目标、难度、优先级

优先级定义——**P0**：主线，必须精读 + 完成实验；**P1**：支线，主线需要时深入；**P2**：建立概念即可。
难度 ★~★★★★★ 以"有 Java/Go 后端经验但网络较弱"为基准。

| 章 | 文件 | 一句话学习目标 | 难度 | 优先级 | 前置 |
|----|------|----------------|------|--------|------|
| 01 | `01_network_foundations.md` | 建立分层模型与"包的一生"全景；分清带宽/延迟/RTT/吞吐 | ★★ | **P0** | 无 |
| 02 | `02_link_layer_and_lan.md` | 搞懂帧/MAC/ARP/交换机/MTU，够解释"同网段与跨网段通信差异"即可 | ★★ | P2 | 01 |
| 03 | `03_ip_routing_nat.md` | 会算子网、会读路由表，说清 NAT 的完整过程和它杀长连接的原因 | ★★★ | P1 | 01 |
| 04 | `04_udp.md` | 明白"不可靠"具体指什么、UDP 的适用边界、为什么 QUIC 选它 | ★★ | P1 | 01 |
| 05 | `05_tcp_connection.md` | 背下 TCP 状态机；看到 TIME_WAIT/CLOSE_WAIT/RST 能直接推断故障方 | ★★★★ | **P0** | 01 |
| 06 | `06_tcp_reliability_congestion.md` | 说清重传/滑动窗口/拥塞控制的工程含义；能解释"加带宽没用"类问题 | ★★★★★ | **P0** | 05 |
| 07 | `07_socket_programming_io.md` | 用 Go 写正确的 TCP 程序：分包、Deadline、优雅关闭、连接池 | ★★★★ | **P0** | 05 |
| 08 | `08_dns_service_discovery.md` | 追踪一次完整递归解析；能排查"DNS 改了不生效/解析慢"类问题 | ★★★ | P1 | 01 |
| 09 | `09_http1.md` | 吃透报文结构/keepalive/chunked/缓存；掌握 Go http.Client 的正确用法 | ★★★★ | **P0** | 05,07 |
| 10 | `10_tls_https.md` | 画出 TLS 1.2/1.3 握手；独立排查证书链问题；会配 mTLS | ★★★★ | **P0** | 05,09 |
| 11 | `11_http2_http3_quic.md` | 说清多路复用解决什么、QUIC 又解决什么；理解 gRPC 负载不均问题 | ★★★★ | **P0** | 09,10 |
| 12 | `12_realtime_streaming.md` | 实现 SSE/WebSocket；设计 LLM 流式请求的分层超时与取消传播 | ★★★★ | **P0** | 09,11 |
| 13 | `13_proxy_lb_gateway.md` | 理解 L4/L7 差异、Nginx 转发行为；能逐跳定位 502/504 | ★★★ | P1 | 09,12 |
| 14 | `14_container_cloud_network.md` | 走通"容器内 → 外网"的完整路径；能排查 K8s Service 不通 | ★★★★ | P1 | 03,13 |
| 15 | `15_network_security.md` | 吃透 SSRF 攻防与 CORS 本质；给 Agent 工具设计安全出网方案 | ★★★ | P1 | 08,09 |
| 16 | `16_performance_tuning.md` | 拆解延迟构成；会调内核与 Go Transport 参数；会做正确的压测 | ★★★★ | P1 | 06,09 |
| 17 | `17_observability_debugging.md` | 熟练 tcpdump/Wireshark/ss/dig/curl；掌握"网络不通排查决策树" | ★★★ | **P0** | 05（工具可提前用） |
| 18 | `18_interview_questions.md` | 高频面试题汇总，每题给"一分钟版"和"深挖版"答案 | — | P1 | 全部 |
| 19 | `19_twelve_week_plan.md` | 12 周执行计划：每周主题/实验/编码/排障/验收 | — | **P0** | 无（第一天就读） |

## 三、代码与实验对照表

| code/ 目录 | 配套章节 | 做什么 |
|------------|----------|--------|
| `01_tcp_echo` | 05,07 | TCP echo 服务器/客户端，优雅关闭 |
| `02_sticky_packets` | 07 | 复现粘包 + 长度前缀编解码器 |
| `03_tcp_states` | 05 | 复现 TIME_WAIT / CLOSE_WAIT，配合 ss 观察 |
| `04_http_from_tcp` | 09 | 从 net.Listener 手写极简 HTTP/1.1 服务器 |
| `05_http_client_pool` | 09,16 | http.Client 连接池、分层超时、Body 泄漏复现 |
| `06_sse_streaming` | 12 | SSE 服务端/客户端 + 模拟 LLM 流式 API |
| `07_websocket` | 12 | WebSocket 心跳、并发写保护 |
| `08_tls_mtls` | 10 | 自签证书、HTTPS、mTLS |
| `09_dns_httptrace` | 08,17 | 自定义 Resolver + httptrace 分阶段计时 |
| `10_reverse_proxy` | 13 | ReverseProxy 定制：流式透传、头处理 |
| `11_safe_client_ssrf` | 15 | 防 SSRF 的安全 HTTP 客户端 |
| `12_agent_gateway` | 综合项目 | 12 阶段渐进实现流式网关 |

| labs/ 实验 | 配套章节 | 验证什么 |
|------------|----------|----------|
| `lab_01_handshake_capture` | 05 | 抓三次握手/四次挥手，对照状态机 |
| `lab_02_sticky_packets` | 07 | 抓包看"消息边界"在字节流中消失 |
| `lab_03_time_wait_close_wait` | 05 | 用 ss 观察两种状态的产生与消退 |
| `lab_04_http_keepalive` | 09 | 验证连接复用：同一连接跑多个请求 |
| `lab_05_tls_capture` | 10 | 抓 TLS 握手，SSLKEYLOGFILE 解密 |
| `lab_06_dns_trace` | 08 | dig +trace 走完整递归链路 |
| `lab_07_sse_through_proxy` | 12,13 | 复现 Nginx 缓冲杀死流式输出，再修复 |
| `lab_08_gateway_benchmark` | 16,项目 | 压测自己的网关，定位瓶颈层 |

## 四、三条学习路径

**路径 A · 主线速通（约 6 周）**：01 → 05 → 06 → 07 → 09 → 10 → 11 → 12 → 17，随后直接做 Agent Gateway 阶段 1-4。适合急需在工作中止血的场景。

**路径 B · 完整精通（12 周）**：按 [19_twelve_week_plan.md](19_twelve_week_plan.md) 执行，P0 精读、P1 全覆盖、项目 12 阶段全部完成。

**路径 C · 问题驱动**：从 [../goal.md](../goal.md) 第三节的 20 个重点问题里挑当前最痛的一个，按下表跳章：

| 你正被什么问题困扰 | 直接去 |
|--------------------|--------|
| 超时、connection reset、broken pipe | 05 → 07 |
| 大量 TIME_WAIT / CLOSE_WAIT / fd 耗尽 | 05 → 09(Body泄漏) → 17 |
| SSE 流式输出被缓冲/中断 | 12 → 13 |
| LLM API 调用超时设计 | 12 |
| 502/504、Nginx 转发问题 | 13 → 17 |
| 容器/K8s 网络不通 | 14 → 17 |
| 传输慢、QPS 上不去 | 06 → 16 |
| SSRF / Agent 工具安全 | 15 |

## 五、如何使用每一章

每章统一 14 节结构（目标 → 概念 → 原理 → 报文/流程 → 图解 → Go 示例 → 后端应用 → Agent 应用 → 常见错误 → 排障 → 实验 → 面试题 → 总结与检查清单 → 延伸阅读）。建议节奏：

1. 先读"本章目标"和"本章总结"，明确要带走什么（5 分钟）。
2. 通读正文，标记不懂的点（1-2 小时）。
3. **必做**：实验任务 + 对应 code 示例——网络知识不抓包等于没学（1-2 小时）。
4. 用检查清单自测，答不上的回头重读。
5. 面试题当"输出练习"：对着空气把答案讲一遍。
