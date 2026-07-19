# 第 33 课：JSON-RPC 2.0 与 MCP 协议状态机

本课不调用现成 MCP SDK，而是把 SDK 必须解决的底层问题做成透明实现：wire 值校验、stdio framing、method 泛型相关性、并发请求关联、取消竞态、服务端 dispatch、版本/能力协商和 MCP 生命周期。

规范基线：截至 2026-07-19，官方 latest revision 为 `2025-11-25`。代码实现教学子集，不宣称替代完整 MCP SDK。

深入原理见：[JSON-RPC 与 MCP 协议底层](../../../knowledge/26_json_rpc_mcp_protocol_internals.md)。

## 运行

```bash
npm run lesson:mcp-protocol
npm run lesson:mcp-protocol:dist
npm run lesson:mcp-protocol:test
npm run typecheck
```

## 分层

```text
unknown / UTF-8 bytes
  │
  ├─ StdioJsonRpcDecoder（字节 → 单行 JSON）
  └─ decodeJsonRpcMessage（unknown → 互斥消息联合）
       │
       ├─ JsonRpcClient（id → pending Promise）
       ├─ JsonRpcServer（method → schema → handler）
       └─ RpcTransport（stdio / HTTP / memory 的端口）
            │
            └─ MCP Session
                 idle → initializing → operational → closed
```

## 文件职责

| 文件 | 重点 |
|---|---|
| [jsonrpc.ts](jsonrpc.ts) | JSON-safe clone、消息代数、互斥字段、ID、错误对象、单行编码 |
| [transport.ts](transport.ts) | Transport 端口、内存进程边界、UTF-8 增量解码与 newline framing |
| [codec.ts](codec.ts) | method 的 params/result Schema 相关性，wire payload 双向验证 |
| [client.ts](client.ts) | pending Map、乱序关联、上限、超时、取消 tombstone、关闭清理 |
| [server.ts](server.ts) | 并发 dispatch、参数/结果验证、JSON-RPC error、in-flight 取消 |
| [mcp.ts](mcp.ts) | 版本/能力协商、initialized 门禁、tools/list/call 教学子集 |
| [demo.ts](demo.ts) | ping → initialize → initialized → list/call → close |
| [protocol.test.ts](protocol.test.ts) | 13 类故障与时序契约、负向类型测试 |

## 三层证据

### 1. wire 证据

Transport 收到的是 `unknown`。`decodeJsonRpcMessage` 先验证 JSON 对象图，再验证：

- `jsonrpc` 必须严格为 `"2.0"`；
- request 有 id，notification 没有 id；
- response 必须且只能有 `result` 或 `error`；
- MCP request id 是非空 string 或安全整数；
- params 只能是 object/array；
- error code 是安全整数；
- 教学实现拒绝未知顶层字段。

### 2. 静态 method 证据

```typescript
const methods = {
  multiply: {
    params: object({ left: number(), right: number() }),
    result: object({ value: number() }),
  },
} as const;

const result = await client.request('multiply', { left: 2, right: 3 });
// result: { value: number }
```

method literal 同时决定 params 与 result；`@ts-expect-error` 锁定缺字段和错误输出类型。但远端 response 仍必须再次通过 result Schema。

### 3. 时间状态证据

Schema 只能验证单个消息，不能证明 response 属于哪个历史请求。Client 维护：

- `Map<RequestId, Pending>`：关联任意到达顺序；
- pending 上限：防止无响应远端耗尽内存；
- settled tombstone：识别重复 response；
- cancelled tombstone：忽略规范允许的迟到 response；
- transport close：一次拒绝并清空全部 pending。

## 取消不是“删除 Promise”

普通 MCP request 取消需要：

1. 从 pending Map 删除；
2. 本地 Promise 以取消类型 reject；
3. 发送 `notifications/cancelled`；
4. Server 用 request id 找到 in-flight Controller；
5. Handler 观察 Signal、释放资源；
6. Server 不再发送 response；
7. Client 忽略已经在路上的迟到 response。

`initialize` 是例外：规范禁止客户端取消它。本课仍给 initialize 设置默认 10 秒超时，但超时后关闭连接，不发送取消通知。

## MCP 生命周期

Client 只允许：

```text
idle
  ├─ ping
  └─ initialize request
       → validate version/capabilities
       → notifications/initialized
       → operational
            ├─ tools/list
            ├─ tools/call
            └─ close
```

Server 也独立执行门禁，不能相信 Client 类已经检查。恶意或旧客户端在 initialization 前调用 `tools/list` 会得到 JSON-RPC application error。

## 错误分层

| 层 | 示例 | 处理 |
|---|---|---|
| JSON 文本 | 非法 JSON、残帧 | Transport/framer error |
| JSON-RPC 结构 | result 与 error 同时存在 | Invalid Request / protocol fault |
| method payload | 缺字段、结果类型漂移 | Invalid params 或单请求失败 |
| MCP 生命周期 | 未初始化就 tools/list | application error |
| tool 执行 | 数据库异常 | `isError: true`，不泄漏 cause |
| connection | 未知/重复 response id | 关闭并拒绝所有 pending |
| cancellation | 正常控制流 | tombstone + Signal，不伪装成内部错误 |

## 当前教学边界

- 不支持 JSON-RPC batch。
- 只实现 client → server request；完整 MCP 还需反向 sampling/elicitation dispatcher。
- tools/call 只建模 text content，不含 image/audio/resource/structuredContent。
- 未实现 Streamable HTTP、SSE replay、session header、Origin/auth。
- 未实现 resources、prompts、roots、progress、logging 和实验性 tasks。
- Method Schema 必须是幂等 wire schema；领域 `Date`/值对象应使用显式 encode/decode codec。
- 最近 request id 是有界防重窗口，不是持久化幂等仓库。

这些限制都在深度文档中解释了扩展方向，不能通过增加几个可选字段假装已经支持完整规范。
