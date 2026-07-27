请为我生成一套系统化、工程导向的《计算机网络学习文档》，目标读者是一名正在学习后端开发和 Agent 开发的程序员，主要使用 Go 语言，有 Java 后端基础。

## 一、总体目标

这套文档不能只是网络教材知识的简单整理，而要帮助我建立以下能力：

1. 完整回答"一个 HTTP 请求从客户端到服务器再返回，中间发生了什么"，精确到每一层。
2. 深入理解 TCP：连接管理、状态机、可靠传输、流量控制、拥塞控制，并能解释真实故障。
3. 理解 HTTP/1.1、HTTP/2、HTTP/3（QUIC）的演进动机、机制差异和选型依据。
4. 理解 TLS 握手与证书体系，能排查 HTTPS 相关问题。
5. 能够用 Go 编写正确的网络程序：处理粘包、超时、取消、重试、连接池、优雅关闭。
6. 理解 Agent 开发中的网络问题：LLM API 长耗时请求、SSE 流式输出、WebSocket 长连接、Webhook、工具网络访问的 SSRF 防护。
7. 理解代理、负载均衡、网关的工作原理，理解 Nginx 转发行为对上层应用的影响。
8. 理解容器和 Kubernetes 的网络模型，能排查"容器里不通"类问题。
9. 能够使用 tcpdump、Wireshark、ss、dig、curl、mtr 等工具定位真实的线上网络问题。
10. 学完后具备开发一个支持流式转发的 HTTP 网关/反向代理的能力。

文档需要强调"为什么这样设计""底层是如何工作的""实际项目中如何使用"和"出现问题时如何排查"。

## 二、内容范围

请按照由浅入深的顺序，覆盖以下模块。

### 模块 1：网络基础与分层模型

包括但不限于：

- 为什么需要分层，分层的代价是什么
- OSI 七层模型与 TCP/IP 四层模型的对应关系
- 封装与解封装：数据在每一层叫什么、加了什么头
- 端到端原则
- 带宽、延迟、RTT、吞吐量的区别与关系
- 一个数据包从网卡到应用程序的完整路径（内核协议栈概览）
- localhost、127.0.0.1、0.0.0.0 的区别

需要回答：

- 为什么"带宽很大"不等于"延迟很低"？
- 为什么跨洋请求再怎么优化也快不过物理极限？
- 应用层看到的"字节流"和链路上的"数据包"是什么关系？
- 监听 127.0.0.1 和监听 0.0.0.0 对可访问性意味着什么？

### 模块 2：链路层与局域网

按"够用即可"的深度讲解：

- 以太网帧结构
- MAC 地址与 IP 地址的分工
- ARP 的工作过程与 ARP 缓存
- 交换机与集线器的区别
- VLAN 的基本概念
- MTU 与 MSS，为什么 MTU 通常是 1500
- 巨型帧的概念
- 无线网络只需了解基本差异

需要回答：

- 同一局域网内两台机器通信，IP 层和链路层分别做了什么？
- 跨网段通信时，目标 MAC 地址填的是谁？
- MTU 不一致会引发什么问题？和 TCP 的 MSS 协商是什么关系？

### 模块 3：IP、路由与 NAT

深入讲解：

- IPv4 地址结构、子网掩码、CIDR
- 私有地址段（10/8、172.16/12、192.168/16）与公网地址
- 子网划分的计算方法
- 路由表的结构与最长前缀匹配
- 默认网关
- ICMP：ping 和 traceroute 的原理
- IP 分片与为什么应尽量避免分片
- TTL 的作用
- NAT 的种类（SNAT、DNAT、端口映射）与工作过程
- NAT 穿透的基本概念
- IPv6 的地址结构与迁移现状（了解即可）

结合工程场景说明：

- 为什么家里的机器没有公网 IP 也能上网？
- NAT 表项超时为什么会杀死"看似正常"的长连接？
- 云服务器的公网 IP 为什么在 `ip addr` 里看不到？
- 如何看懂 `ip route` 输出并判断流量走哪张网卡？

### 模块 4：传输层基础与 UDP

讲解：

- 端口的意义，五元组如何唯一确定一条连接
- 知名端口、临时端口范围
- UDP 报文结构
- UDP 的适用场景：DNS、QUIC、音视频、游戏
- UDP 没有连接、没有可靠性意味着应用层要承担什么
- UDP 广播与组播的基本概念
- UDP 缓冲区溢出与丢包

需要回答：

- "UDP 不可靠"具体指哪些事情可能发生？
- 为什么 DNS 主选 UDP，什么时候会退回 TCP？
- 为什么 QUIC 选择基于 UDP 重造可靠传输，而不是改进 TCP？

### 模块 5：TCP 连接管理与状态机

这是重点模块，深入讲解：

- TCP 报文头各字段的作用（序列号、确认号、标志位、窗口）
- 三次握手的完整过程，为什么是三次不是两次
- SYN 队列与 accept 队列（半连接/全连接队列），队列溢出的后果
- SYN Flood 与 SYN Cookie
- 四次挥手的完整过程，为什么是四次
- TCP 完整状态机：LISTEN、SYN_SENT、SYN_RCVD、ESTABLISHED、FIN_WAIT_1/2、CLOSE_WAIT、LAST_ACK、TIME_WAIT、CLOSED
- TIME_WAIT 存在的意义、2MSL、大量 TIME_WAIT 的影响与正确处理方式
- CLOSE_WAIT 堆积意味着什么（对端关了你没关）
- RST 的产生场景：访问未监听端口、连接已不存在、异常关闭
- 半关闭（shutdown 与 close 的区别）
- SO_REUSEADDR 与 SO_REUSEPORT
- TCP keepalive 机制及其默认参数为什么几乎不可用
- 连接建立与关闭在 Go `net` 包中的对应行为

需要回答：

- 为什么主动关闭方会进入 TIME_WAIT，服务端大量 TIME_WAIT 说明什么？
- CLOSE_WAIT 堆积通常是谁的 bug？如何定位到代码？
- "connection refused"、"connection reset by peer"、"broken pipe"、"i/o timeout" 分别对应什么底层事件？
- 全连接队列满了，客户端会看到什么现象？

### 模块 6：TCP 可靠传输与拥塞控制

深入讲解：

- 字节流抽象与序列号机制
- 确认应答、累积确认、SACK
- 超时重传与 RTO 的计算
- 快速重传
- 滑动窗口与流量控制
- 零窗口与窗口探测
- 接收方处理慢如何反压到发送方
- Nagle 算法与延迟确认，两者叠加造成的延迟问题，TCP_NODELAY
- 拥塞控制：慢启动、拥塞避免、快速恢复
- Cubic 与 BBR 的设计思想对比（不要求数学推导）
- 带宽时延积（BDP）与吞吐量上限
- 长肥管道问题与窗口缩放选项
- 队头阻塞在 TCP 层面的含义

结合工程场景说明：

- 为什么跨机房传大文件速度上不去，加带宽也没用？
- 为什么小包延迟敏感的服务要关 Nagle？
- 为什么接收端应用读得慢，最终发送端会阻塞？这与背压的关系？
- 丢包率对 TCP 吞吐量的影响为什么是灾难性的？

### 模块 7：Socket 编程与网络 I/O

深入讲解：

- socket、bind、listen、accept、connect、read、write、close 的语义
- 阻塞与非阻塞 socket
- I/O 多路复用：select、poll、epoll（与操作系统笔记互补，这里聚焦网络视角）
- C10K 问题的来龙去脉
- Go netpoller 如何把阻塞式 API 映射到 epoll
- Go `net` 包核心用法：Listener、Conn、Deadline
- 粘包与拆包：为什么 TCP 没有"消息边界"
- 常见应用层分包方案：定长、分隔符、长度前缀（Length-Prefix）
- 缓冲区：内核发送/接收缓冲区与应用层 bufio
- 优雅关闭连接的正确姿势
- 连接池的设计：为什么需要、多大合适、如何检测坏连接
- 文件描述符与连接数上限

结合 Go 与 Agent 场景说明：

- Go 里一个连接一个 goroutine 为什么是可行的？
- 读 `net.Conn` 时如何正确处理"读到一半"和 `io.EOF`？
- SetDeadline、SetReadDeadline 与 context 取消如何配合？
- Agent 并发调用大量外部 API 时，连接池、DNS 缓存、fd 上限如何规划？

请提供 Go 语言示例。

### 模块 8：DNS 与服务发现

深入讲解：

- 域名结构与解析层级：根、顶级域、权威、递归
- 一次完整的递归解析过程
- 记录类型：A、AAAA、CNAME、NS、MX、TXT、SRV
- TTL 与各级缓存（浏览器、系统、resolver、权威）
- /etc/hosts、/etc/resolv.conf、nsswitch 的作用
- dig 的使用与输出解读
- DNS 劫持与 DNS over HTTPS 的基本概念
- 负载均衡视角的 DNS：轮询、就近解析、故障切换的局限
- Go 的 DNS 解析：cgo resolver 与纯 Go resolver 的区别
- Kubernetes 内的 DNS：Service 域名、ndots 问题
- 服务发现与 DNS 的关系：注册中心模式对比

结合工程场景说明：

- 为什么改了 DNS 记录后有人生效有人不生效？
- 为什么 DNS 解析慢会拖垮整个请求，如何在超时预算中单独控制？
- 为什么容器里 DNS 查询会被放大成多次查询（ndots 陷阱）？
- 长连接场景下 DNS 变更为什么不生效，如何设计重解析？

### 模块 9：HTTP/1.1 深入

这是重点模块，深入讲解：

- 请求与响应的报文结构
- 方法语义与幂等性（GET、POST、PUT、DELETE、PATCH、HEAD、OPTIONS）
- 状态码体系与工程中最常见的误用
- 常用头部：Host、Content-Type、Content-Length、Transfer-Encoding、Connection、Cache-Control、ETag、Range
- 短连接与 keepalive，连接复用的条件
- 管道化为什么失败
- 分块传输编码（chunked）的工作方式
- Content-Length 与 chunked 的关系，两者都没有时如何界定 body
- 队头阻塞在 HTTP/1.1 的表现，浏览器 6 连接限制
- Cookie 与 Session 的机制
- 缓存体系：强缓存与协商缓存的完整决策流程
- 重定向与各状态码差异（301/302/307/308）
- 内容协商与压缩（gzip、br）
- Range 请求与断点续传
- 表单与文件上传（multipart/form-data）
- Go `net/http` 的实现要点：Server 的连接处理模型、Client 的 Transport 与连接池、必须 Close 的 Response.Body

需要回答：

- 一次 HTTP keepalive 复用的连接上，如何界定上一个响应结束、下一个请求开始？
- 为什么忘记读完并关闭 Response.Body 会导致连接泄漏？
- 反向代理后面拿到的客户端 IP 为什么是错的，X-Forwarded-For 如何正确使用？
- POST 重试为什么危险，如何设计幂等键？

### 模块 10：TLS 与 HTTPS

深入讲解：

- 对称加密、非对称加密、摘要、签名的分工（不深入数学）
- 证书与证书链：CA、中间证书、根证书、信任锚
- 证书里有什么：域名、SAN、有效期、公钥
- TLS 1.2 握手完整过程
- TLS 1.3 的改进：1-RTT、0-RTT
- 会话恢复机制
- SNI 的作用，一个 IP 上多张证书如何工作
- ALPN 与 HTTP/2 协商
- 双向认证 mTLS 及其在服务间通信的应用
- 证书校验失败的常见原因：过期、域名不匹配、链不完整、自签
- 中间人攻击与证书固定的基本概念
- Let's Encrypt 与证书自动化
- Go 中的 TLS：tls.Config、自签证书测试、跳过校验的风险

结合工程场景说明：

- "certificate signed by unknown authority" 的排查路径
- 为什么抓包看不到 HTTPS 内容，调试时有哪些合法手段（如 curl -v、SSLKEYLOGFILE、本地代理）？
- 内网服务间要不要上 TLS，mTLS 的成本与收益？

### 模块 11：HTTP/2、HTTP/3 与 QUIC

深入讲解：

- HTTP/1.1 的核心痛点回顾
- HTTP/2 二进制分帧：流、消息、帧
- 多路复用如何消除 HTTP 层队头阻塞
- 头部压缩 HPACK
- 流优先级与流量控制（流级别与连接级别）
- 服务器推送为什么被废弃
- HTTP/2 仍然存在的 TCP 层队头阻塞
- QUIC：基于 UDP 的可靠传输、内建 TLS 1.3、连接迁移
- HTTP/3 与 QUIC 的关系
- 0-RTT 的收益与重放风险
- gRPC 为什么选择 HTTP/2，四种调用模式与流的对应关系
- HTTP/2 长连接在负载均衡下的问题：连接级 LB 导致的不均匀
- Go 中启用 HTTP/2 的方式与 h2c

需要回答：

- 多路复用之后还需要连接池吗？需要考虑什么新问题？
- 丢包环境下 HTTP/2 为什么可能比 HTTP/1.1 更慢？
- Kubernetes 里 gRPC 负载不均的原因与解法（L7 代理、客户端 LB）？

### 模块 12：长连接与流式通信

这是 Agent 开发的重点模块，深入讲解：

- 轮询、长轮询、SSE、WebSocket 的对比与选型
- SSE 协议细节：事件格式、重连机制、Last-Event-ID
- SSE 在 LLM 流式输出中的应用：OpenAI/Anthropic 风格的流式 API
- WebSocket 握手升级过程、帧结构、ping/pong、关闭握手
- 心跳设计：为什么需要应用层心跳，间隔如何定
- 断线重连与指数退避
- 长连接被中间设备杀掉的各种原因：NAT 超时、LB 空闲超时、防火墙
- 反向代理对流式响应的影响：缓冲、超时、Nginx 的 proxy_buffering 与 X-Accel-Buffering
- Go 实现 SSE 服务端：Flusher、超时设置的坑（WriteTimeout 会杀长响应）
- Go 实现 SSE 客户端：逐行解析、取消传播
- WebSocket 库的使用与并发写问题
- 背压：消费者慢时流式数据如何处理

结合 Agent 场景重点讲解：

- LLM API 的超时怎么设：连接超时、首 token 超时、token 间隔超时、总超时分层设计
- 流式响应中途失败如何处理：已消费的 token、重试语义、幂等
- Agent 与工具/MCP 服务的长连接管理：保活、重连、并发请求复用
- Webhook 的可靠性设计：重试、签名校验、防重放
- 用户取消任务时如何取消进行中的上游流式请求（context 传播到 HTTP 层）

### 模块 13：代理、负载均衡与网关

深入讲解：

- 正向代理与反向代理的区别
- HTTP 代理的两种模式：普通转发与 CONNECT 隧道
- 透明代理的概念
- L4 与 L7 负载均衡的本质区别
- 负载均衡算法：轮询、加权、最少连接、一致性哈希及其适用场景
- 健康检查：主动与被动
- 会话保持
- Nginx 反向代理的关键行为：转发头处理、缓冲、超时三件套（connect/read/send）、重试
- 优雅发布：连接排空（draining）
- API 网关的职责：认证、限流、路由、可观测性
- 限流算法：计数器、滑动窗口、漏桶、令牌桶
- 熔断与降级的基本模式
- CDN 的工作原理与回源

结合工程场景说明：

- 客户端超时、Nginx 超时、后端超时三者如何协调，谁先断？
- 502、504 分别说明什么，如何逐跳定位？
- 上传大文件经过 Nginx 失败的常见原因？
- 与仓库中已有的 Nginx 笔记互补：这里讲使用与行为，Nginx 目录讲源码与实现。

### 模块 14：容器与云原生网络

深入讲解：

- 网络命名空间（netns）与 veth pair
- Docker 的网络模式：bridge、host、none、container
- docker0 网桥与 iptables NAT 规则如何配合完成端口映射
- 容器内访问外网的完整路径
- 容器间通信与 DNS
- Kubernetes 网络模型的基本约定：Pod IP 全网可达
- Service 的实现：ClusterIP、NodePort、LoadBalancer、kube-proxy 与 iptables/IPVS
- Ingress 的角色
- CNI 与 overlay 网络的基本概念（VXLAN，不深入）
- NetworkPolicy 的作用
- 服务网格 sidecar 模式的基本概念（了解即可）

结合工程场景说明：

- 容器里 curl 不通外网的排查顺序？
- 为什么容器内监听 127.0.0.1 时端口映射不生效？
- ClusterIP ping 不通是不是故障？
- Pod 之间通、Service 不通，可能出在哪一环？

### 模块 15：网络安全与 Agent 网络隔离

深入讲解：

- 常见攻击的原理与防御：中间人、DNS 劫持、DDoS、SYN Flood、反射放大
- Web 侧与网络相关的攻击：CSRF、CORS 的本质、点击劫持
- CORS 完整机制：简单请求、预检、凭据模式，为什么它保护的是用户而不是服务器
- SSRF：原理、危害（云元数据 169.254.169.254）、绕过手法（重定向、DNS rebinding、进制混淆）
- 防火墙与 iptables 基本规则阅读
- 零信任的基本理念

结合 Agent Sandbox 重点讲解：

- Agent 的工具可以发任意 HTTP 请求时，如何防 SSRF：IP 黑名单为什么不够、resolve 后校验、禁用重定向跟随或逐跳校验
- 如何限制 Sandbox 的网络访问：仅允许白名单域名、统一代理出口
- 如何防止 Agent 访问云元数据服务与内网服务
- API Key 等凭据在网络层面的保护：不落日志、不进 URL
- 出站流量审计的基本做法

请提供 Go 实现的安全 HTTP 客户端示例（含内网地址过滤的 DialContext）。

### 模块 16：网络性能与内核调优

深入讲解：

- 延迟的构成：DNS、TCP 握手、TLS 握手、TTFB、传输
- 减少 RTT 次数的手段：keepalive、连接池、TLS 会话恢复、HTTP/2、就近接入
- 内核缓冲区参数：rmem/wmem 系列
- somaxconn 与全连接队列调优
- TIME_WAIT 相关参数的正确认知（tw_reuse，以及为什么 tw_recycle 被移除）
- 文件描述符上限
- 零拷贝在网络传输中的应用：sendfile、splice
- 网卡多队列与中断亲和的概念
- 常见压测工具：wrk、hey、iperf3 的使用与结果解读
- 压测的正确姿势：找到瓶颈在哪一层，而不是只看 QPS
- Go 侧优化：复用 http.Client、Transport 参数（MaxIdleConnsPerHost 等）、避免每请求新建连接、buffer 复用

需要回答：

- QPS 上不去，如何判断瓶颈在客户端、网络、还是服务端？
- 为什么默认 MaxIdleConnsPerHost=2 会成为高并发外呼的隐形瓶颈？
- 长连接和短连接对压测结果的影响有多大？

### 模块 17：网络可观测性与排障

系统讲解以下工具：

- ping、traceroute、mtr
- dig、nslookup
- curl（-v、--resolve、-w 计时模板、重试参数）
- telnet、nc
- ss（重点：状态过滤、收发队列解读）、netstat
- tcpdump：过滤表达式、常用参数、抓包保存
- Wireshark：跟踪 TCP 流、看握手与重传、TLS 解密
- iperf3
- lsof 看连接与 fd
- /proc/net 下的关键文件
- conntrack 的基本概念

Go 相关：

- httptrace 包：测量一次请求各阶段耗时
- net/http/pprof 与连接相关指标
- 客户端与服务端的访问日志设计：慢在哪一跳要能回答

每个工具需要说明：

1. 它解决什么问题。
2. 常用命令。
3. 输出中重点关注哪些字段。
4. 常见误区。
5. 一个真实排障案例。

最后给出一份"网络不通排查决策树"：从 DNS → 连通性 → 端口 → TLS → 应用层，逐层二分。

## 三、重点问题清单

文档必须能够帮助我回答并解决以下问题：

- 浏览器输入 URL 到页面展示，完整发生了什么？
- 为什么三次握手、四次挥手？少一次会怎样？
- 大量 TIME_WAIT 要不要处理？大量 CLOSE_WAIT 说明什么？
- "connection reset by peer" 和 "broken pipe" 有什么区别？
- 为什么 telnet 端口通，但 curl 请求超时？
- 为什么改了 DNS 有的客户端一直不生效？
- 为什么 TCP 传大文件时延迟高的链路吞吐上不去？
- 粘包是谁的锅？如何正确分包？
- 为什么 Go 里忘记关 Response.Body 会连接泄漏、fd 耗尽？
- 为什么长连接放着不动就断了？
- 为什么 SSE 流式输出经过 Nginx 后变成一次性全部返回？
- 为什么 LLM 流式请求需要多层超时，单一超时会出什么事故？
- 为什么 HTTP/2 下 gRPC 在 Kubernetes 里负载不均？
- 502 和 504 分别查哪里？
- 为什么容器里服务监听 127.0.0.1 时外面访问不到？
- 为什么容器内 DNS 解析特别慢？
- SSRF 为什么只做 URL 字符串校验挡不住？
- 为什么压测时客户端先到瓶颈，QPS 数据是假的？
- 为什么高并发外呼时大量连接处于 TIME_WAIT，临时端口耗尽？
- 一次请求慢，如何证明慢在 DNS、握手、服务端处理还是传输？

## 四、文档结构要求

每个章节统一使用以下结构：

1. 本章目标
2. 核心概念
3. 底层原理
4. 关键报文结构或执行流程
5. 图解或 ASCII 时序图
6. Go 语言示例
7. 后端开发中的应用
8. Agent 开发中的应用
9. 常见问题和错误设计
10. 排障方法（含抓包实验）
11. 实验任务
12. 面试题
13. 本章总结
14. 延伸阅读（含关键 RFC 编号）

不要只罗列定义。每个核心概念都要至少包含一个具体场景，协议类章节要配抓包验证方法。

## 五、示例代码要求

代码以 Go 为主，必要时可以使用 Shell、curl 命令或伪代码辅助解释。

Go 示例必须：

- 可以独立运行或尽量接近可运行
- 包含必要的错误处理
- 使用 context 实现超时和取消
- 明确资源关闭位置（Conn、Body、Listener）
- 避免只有几行、无法体现问题的玩具代码
- 对错误示例标明问题所在
- 对正确示例解释为什么正确

重点实现以下示例：

1. TCP echo 服务器与客户端（含优雅关闭）。
2. 复现粘包现象，并实现长度前缀编解码器。
3. 复现并观察 TIME_WAIT 与 CLOSE_WAIT（配合 ss 观察）。
4. 设置与验证 TCP keepalive、应用层心跳。
5. 基于 net.Listener 手写极简 HTTP/1.1 服务器（解析请求行、头、body）。
6. http.Client 正确用法：Transport 连接池参数、分层超时、重试与幂等控制。
7. 复现 Response.Body 不关闭导致的连接泄漏，并用 pprof/lsof 验证。
8. SSE 服务端与客户端（含 Flusher、断线重连、Last-Event-ID）。
9. 模拟 LLM 流式 API：服务端逐 token 输出，客户端边收边处理并支持取消。
10. WebSocket 服务端与客户端（含心跳与并发写保护）。
11. TLS 服务器：自签证书、HTTPS、mTLS 双向认证。
12. 使用 httptrace 打印一次请求的 DNS/连接/TLS/首字节各阶段耗时。
13. 自定义 Resolver 与 DNS 查询示例。
14. httputil.ReverseProxy 定制：改写 Host、透传流式响应、注入 X-Forwarded-For。
15. 防 SSRF 的安全 HTTP 客户端：DialContext 中解析后校验内网地址、禁跟重定向。
16. 令牌桶限流中间件。
17. tcpdump + Wireshark 抓包分析任务：三次握手、重传、TLS 握手各一次。

## 六、实验项目

请在文档最后设计一个循序渐进的综合项目：

项目名称：Agent Gateway

目标是实现一个面向 Agent/LLM 场景的 HTTP 网关（简化版反向代理），支持流式转发。这是所有网络知识的综合落地。

功能包括：

- 接收 HTTP 请求并转发到上游
- 支持多上游与负载均衡
- 支持 SSE/流式响应透传（不缓冲、及时 flush）
- 分层超时：连接、首字节、空闲、总时长
- 支持用户取消并传播到上游
- 连接池管理与上游 keepalive
- 健康检查与故障摘除
- 限流与熔断
- 访问日志与各阶段耗时指标
- HTTPS 接入
- SSRF 防护与上游白名单
- 优雅关闭与连接排空

请将项目拆分为多个阶段：

1. 最小可用转发（单上游、非流式）
2. 流式透传（SSE 不缓冲，验证 LLM 流式场景）
3. 分层超时与取消传播
4. 连接池与 keepalive 调优
5. 多上游与负载均衡策略
6. 健康检查与摘除恢复
7. 限流与熔断
8. HTTPS 与证书管理
9. 安全加固（SSRF 防护、头部清洗）
10. 可观测性（日志、指标、慢请求分析）
11. 优雅发布与连接排空
12. 压测与调优复盘

每个阶段需要包含：

- 目标
- 架构设计
- 关键代码
- 容易出现的问题
- 测试方法（含用 curl/wrk/抓包验证）
- 验收标准

## 七、学习计划

最后生成一个 12 周学习计划，每周预计投入 8 到 10 小时。

每周包括：

- 学习主题
- 必读章节
- 抓包实验任务
- 编码任务
- 排障任务
- 自测问题
- 本周产出物
- 验收标准

学习顺序要优先满足后端和 Agent 开发需求：TCP、HTTP、流式通信、排障工具优先，链路层与容器网络可以靠后，不要完全照搬大学教材从物理层讲起的顺序（但分层总览须在第一周建立）。

## 八、内容深度要求

对以下主题必须深入讲解：

- TCP 状态机与连接管理
- TIME_WAIT / CLOSE_WAIT
- 滑动窗口与拥塞控制的工程含义
- 粘包与应用层协议设计
- epoll 与 Go netpoller（网络视角）
- HTTP/1.1 keepalive、chunked、缓存
- HTTP/2 多路复用与 gRPC
- TLS 握手与证书链
- DNS 解析链路与缓存
- SSE / WebSocket / 流式传输
- 超时体系设计（客户端、代理、服务端）
- Nginx 反向代理行为
- 容器与 Kubernetes 网络路径
- SSRF 与 Agent 网络隔离
- tcpdump / Wireshark / ss / curl 排障

对以下主题可以理解原理，不需要过度深入：

- 物理层编码与调制
- 路由协议（OSPF、BGP）的算法细节
- 密码学的数学证明
- 内核协议栈逐行源码
- 无线与移动网络细节
- IPv6 迁移的运营商级细节

## 九、质量要求

生成内容时遵循以下要求：

- 使用中文。
- 专业术语首次出现时给出英文名称。
- 保持概念准确，不要编造；关键协议行为标注对应 RFC（如 RFC 9293、9110-9114、8446、9000）。
- 明确区分协议标准、Linux 实现和 Go 标准库实现三个层面。
- 对随内核版本或 Go 版本变化的行为注明版本背景。
- 对不确定的实现细节不要武断下结论。
- 多使用时序图、状态图、分层对比表和报文结构图。
- 避免为了完整而堆积低价值知识。
- 强调高频工程问题和真实故障。
- 从"现象—原因—验证—解决方案"角度讲解排障，验证环节优先给出抓包或 ss/curl 证据。
- 每个模块结束后提供一份检查清单。
- 与仓库中已有的 Nginx、RPC、MQ 笔记互补：涉及 Nginx 源码、RPC 协议设计、消息队列的内容点到为止并注明参见对应目录，不做大段重复。

## 十、文件组织

请将文档拆分为多个 Markdown 文件，不要生成一个超长文件。

建议目录结构：

```text
net/
├── goal.md                          # 本文件
├── README.md
├── knowledge/
│   ├── 00_learning_map.md
│   ├── 01_network_foundations.md
│   ├── 02_link_layer_and_lan.md
│   ├── 03_ip_routing_nat.md
│   ├── 04_udp.md
│   ├── 05_tcp_connection.md
│   ├── 06_tcp_reliability_congestion.md
│   ├── 07_socket_programming_io.md
│   ├── 08_dns_service_discovery.md
│   ├── 09_http1.md
│   ├── 10_tls_https.md
│   ├── 11_http2_http3_quic.md
│   ├── 12_realtime_streaming.md
│   ├── 13_proxy_lb_gateway.md
│   ├── 14_container_cloud_network.md
│   ├── 15_network_security.md
│   ├── 16_performance_tuning.md
│   ├── 17_observability_debugging.md
│   ├── 18_interview_questions.md
│   └── 19_twelve_week_plan.md
├── code/
│   ├── README.md
│   ├── 01_tcp_echo/
│   ├── 02_sticky_packets/
│   ├── 03_tcp_states/
│   ├── 04_http_from_tcp/
│   ├── 05_http_client_pool/
│   ├── 06_sse_streaming/
│   ├── 07_websocket/
│   ├── 08_tls_mtls/
│   ├── 09_dns_httptrace/
│   ├── 10_reverse_proxy/
│   ├── 11_safe_client_ssrf/
│   └── 12_agent_gateway/
└── labs/
    ├── lab_01_handshake_capture.md
    ├── lab_02_sticky_packets.md
    ├── lab_03_time_wait_close_wait.md
    ├── lab_04_http_keepalive.md
    ├── lab_05_tls_capture.md
    ├── lab_06_dns_trace.md
    ├── lab_07_sse_through_proxy.md
    └── lab_08_gateway_benchmark.md
```

README.md 需要说明：

- 学习目标
- 适用人群
- 推荐学习顺序
- 各章节关系
- 实验运行方法（含 Windows 下抓包工具的准备）
- 环境准备
- 最终能力目标

## 十一、执行方式

请先完成以下步骤：

1. 分析目标和内容范围。
2. 输出完整目录。
3. 标注每一章的学习目标、难度和优先级。
4. 制定文档生成计划。
5. 按章节逐步生成文档和示例代码。
6. 每生成一个章节后检查是否满足结构要求。
7. 确保代码、实验和正文相互对应。
8. 最后检查是否遗漏 Agent 流式通信、超时体系、SSRF 防护和排障相关内容。

不要一开始只生成零散片段，也不要只给出目录后停止。请实际创建完整的 Markdown 文档和示例代码文件。
