# RPC 深度学习笔记

> 目标不是学会调用某个框架的 `client.call()`，而是建立一套能从接口定义一路追到线上字节、连接状态与失败语义的因果模型。

## 当前进度

| 阶段 | 文档 | 状态 | 学完后必须能回答 |
|---|---|---|---|
| 00 | [RPC 学习总览](00_RPC学习总览.md) | 已完成 | 一次 RPC 穿过哪些层；主流协议的本质差异是什么；为什么超时后无法仅凭客户端异常判断服务端是否执行 |
| 01 | [RPC 语义、调用链与失败模型](01_RPC语义调用链与失败模型.md) | 已完成 | “像本地调用”在哪些地方失效；请求丢失、响应丢失与结果未知如何区分 |
| 02 | [IDL、代码生成与 Schema 演进](02_IDL代码生成与Schema演进.md) | 已完成 | 字段号、未知字段、默认值和兼容性规则如何约束发布顺序 |
| 03 | [Protobuf 线格式逐字节拆解](03_Protobuf线格式逐字节拆解.md) | 已完成 | tag、wire type、Varint、ZigZag、LEN 如何编码；为什么 Protobuf 本身不分帧 |
| 04 | [gRPC over HTTP/2 协议与状态机](04_gRPC_over_HTTP2协议与状态机.md) | 已完成 | HEADERS、消息前缀、DATA、Trailers、RST_STREAM、GOAWAY 如何组成一次调用 |
| 05 | [HTTP/2 多路复用、流控与队头阻塞](05_HTTP2多路复用流控与队头阻塞.md) | 已完成 | stream/connection 双窗口怎样背压；为何 HTTP/2 仍受 TCP 丢包影响 |
| 06 | [Deadline、取消、重试与幂等](06_Deadline取消重试与幂等.md) | 已完成 | 哪些失败可安全重试；deadline 如何沿调用链递减；hedging 如何放大负载 |
| 07 | 名称解析、负载均衡与连接管理 | 待生成 | pick_first、round_robin、客户端负载均衡与代理负载均衡如何改变故障行为 |
| 08 | gRPC 四种调用模式与流式背压 | 待生成 | unary、client/server/bidi streaming 的半关闭、顺序与资源生命周期 |
| 09 | Apache Thrift：IDL、Protocol 与 Transport 解耦 | 待生成 | Binary/Compact Protocol 与 Framed/Buffered Transport 为什么是正交维度 |
| 10 | Dubbo2 与 Triple：私有 TCP 到开放 HTTP RPC | 待生成 | Dubbo2 header、序列化与请求 ID 如何工作；Triple 如何兼容 gRPC 并扩展普通 HTTP |
| 11 | JSON-RPC、Connect 与浏览器边界 | 待生成 | JSON-RPC 只规定了什么、没规定什么；Connect 如何兼顾浏览器与 gRPC 生态 |
| 12 | 服务治理、可观测性与安全 | 待生成 | metadata、认证、授权、限流、熔断、trace context 分别在哪一层实现 |
| 13 | 抓包、故障注入与协议实验 | 待生成 | 如何用 grpcurl、Wireshark、tcpdump、代理故障和指标验证协议结论 |
| 14 | 协议选型、迁移与生产排障 | 待生成 | 如何从语言栈、网络边界、SLO、演进成本与治理能力反推协议选择 |

## 学习规则

每一章都必须回答五类问题：

1. **线上字节**：消息如何定界，字段如何编码，请求与响应如何关联？
2. **状态所有者**：连接、stream、deadline、重试次数、负载均衡状态由谁维护？
3. **不变量**：正常与故障时始终必须成立的约束是什么？
4. **失败窗口**：进程崩溃、网络断开、响应丢失分别会留下什么歧义？
5. **观测证据**：用哪段抓包、日志、状态码、指标或 trace 证明判断？

只会背“gRPC 使用 HTTP/2 + Protobuf”不算学会；最低验收标准是能从一段十六进制数据、一次超时或一个 `UNAVAILABLE`，反向定位它属于序列化、RPC 分帧、HTTP/2、传输还是业务层。

## 推荐顺序

```text
语义与失败模型（01）
  → 契约与编码（02～03）
    → gRPC/HTTP2 主线（04～08）
      → 横向协议实现（09～11）
        → 治理、实验与选型（12～14）
```

不要一开始并列背协议特性。先用 gRPC 建立完整纵向模型，再把 Thrift、Dubbo、JSON-RPC、Connect 放到同一组机制坐标中比较。
