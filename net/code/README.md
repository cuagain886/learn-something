# net/code — 可运行的 Go 网络示例

每个编号目录**自包含、可独立运行**，不依赖其他目录。注释即教材：每个文件开头有本节概览（学什么、要观察什么、运行方式），常见坑用 ⚠️ 标注。

## 学习地图

| 目录 | 配套知识章节 | 学什么 | 状态 |
|------|--------------|--------|------|
| `01_tcp_echo/` | 05, 07 | TCP 服务端/客户端骨架、优雅关闭 | 待生成 |
| `02_sticky_packets/` | 07 | 复现粘包 → 长度前缀编解码器修复 | 待生成 |
| `03_tcp_states/` | 05 | 复现 TIME_WAIT / CLOSE_WAIT / RST / 半关闭，配合 ss 观察状态机 | ✅ 已完成 |
| `04_http_from_tcp/` | 09 | 从 net.Listener 手写极简 HTTP/1.1 服务器 | 待生成 |
| `05_http_client_pool/` | 09, 16 | http.Client 连接池参数、分层超时、Body 泄漏复现与修复 | 待生成 |
| `06_sse_streaming/` | 12 | SSE 服务端/客户端、模拟 LLM 流式 API、取消传播 | 待生成 |
| `07_websocket/` | 12 | WebSocket 握手、心跳、并发写保护 | 待生成 |
| `08_tls_mtls/` | 10 | 自签证书生成、HTTPS 服务、mTLS 双向认证 | 待生成 |
| `09_dns_httptrace/` | 08, 17 | 自定义 Resolver、httptrace 分阶段计时 | 待生成 |
| `10_reverse_proxy/` | 13 | ReverseProxy 定制：流式透传、X-Forwarded-For | 待生成 |
| `11_safe_client_ssrf/` | 15 | 防 SSRF 客户端：DialContext 内网地址过滤 | 待生成 |
| `12_agent_gateway/` | 综合项目 | 流式网关，12 阶段渐进实现 | 待生成 |

## 环境配置

- Go 1.22+，无第三方依赖优先；确需依赖的目录（如 WebSocket）各自带 `go.mod`。
- Windows 上运行监听 `0.0.0.0` 的示例，首次会弹防火墙授权——必须允许，否则局域网实验结论会失真。
- 涉及 `ss`/`tcpdump` 观察的示例建议在 WSL2 里跑；纯 Go 部分双平台均可。

## 运行方式

```bash
cd net/code/01_tcp_echo
go run .            # 单文件目录
# server/client 分离的目录，看目录内 README 或文件头注释，通常是：
go run ./server &
go run ./client
```

## 通用约定

- 所有网络操作**必须**有超时或 Deadline；所有 Conn/Body/Listener 明确 Close 位置。
- 错误示例文件名带 `_bad`，正确示例带 `_good`，对照阅读。
- 每个示例的"预期观察"写在文件头注释里——跑之前先读，跑之后对照。
