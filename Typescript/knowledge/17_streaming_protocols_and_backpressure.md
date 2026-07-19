# 17 · Agent 流式协议：字节、消息边界与背压 ⭐⭐⭐

> 流式系统最危险的错觉是“每个 chunk 就是一条消息”。网络只交付字节片段，字符、行、SSE 事件和领域事件必须逐层重建。

配套实验：[第 24 课 Web Streams 与 SSE](../code/src/24-streaming-sse.ts)。

---

## 1. 四种边界必须分开

```text
Transport Chunk Boundary    任意 Uint8Array 分块
          ↓ incremental UTF-8 decode
Character Boundary          Unicode 字符串
          ↓ line framing
Protocol Record Boundary    SSE event / NDJSON line / WebSocket message
          ↓ JSON parse + runtime validation
Domain Event Boundary       token / usage / tool_call_delta
```

任何相邻两层都不是一一对应：

- 一个中文字符的 UTF-8 字节可能分布在多个 chunk。
- 一个 chunk 可以包含半行、十行或一个 CR 但没有后续 LF。
- 一个 SSE event 可以包含多个 data 行。
- data 字符串不一定是合法 JSON。
- 合法 JSON 不一定符合 AgentEvent 领域协议。

正确架构让每层只解决一个问题，并把错误定位到具体层。

---

## 2. Chunk 是性能/传输单位，不是协议单位

TCP 是字节流，不保留 write 调用边界。HTTP 实现、TLS、代理、压缩和宿主 buffer 都可能重新分块。即使服务端一次写出完整：

```text
data: {"type":"token","delta":"你"}\n\n
```

客户端也可能收到：

```text
[64 61] [74 61 3a ... e4] [bd] [a0 22 ...]
```

测试只用“每个事件一个 chunk”会掩盖真实 bug。应随机或系统地在每个字节位置切分，同一 payload 在不同 chunking 下必须产生相同事件序列。

---

## 3. UTF-8 必须增量解码

中文“你”编码为三个字节。错误做法：

```typescript
for await (const chunk of bytes) {
  const text = new TextDecoder().decode(chunk);
}
```

每次创建 Decoder 会丢失上个 chunk 末尾的未完成序列，产生替换字符 `�` 或 fatal 错误。

正确方式保持同一个 Decoder 状态：

```typescript
const decoder = new TextDecoder('utf-8', { fatal: true });

for await (const chunk of bytes) {
  yield decoder.decode(chunk, { stream: true });
}

const tail = decoder.decode();
```

- `stream: true` 告诉 Decoder 后续还有字节，保留未完成序列。
- 最后无参数 decode flush；若 fatal 且末尾是不完整序列会失败。
- `fatal: true` 适合严格协议，避免静默替换损坏数据；是否容错由产品协议决定。

`TextDecoderStream` 封装了同一机制，可直接接入 Web Streams pipeline。

---

## 4. Web Streams 三类核心对象

- `ReadableStream<T>`：数据来源。
- `WritableStream<T>`：数据目的地。
- `TransformStream<I, O>`：连接可写输入和可读输出的转换。

```typescript
const decoded = byteStream.pipeThrough(new TextDecoderStream());
```

Web Streams 是 WHATWG 标准模型，在浏览器、Node 和多个运行时之间更容易共享。Node 传统 `stream.Readable` 仍广泛存在，可用 `Readable.toWeb/fromWeb` 等桥接，但两套背压、错误和对象模式不能随意混用。

---

## 5. ReadableStream 的状态与锁

ReadableStream 大致有 readable、closed、errored 状态。调用 `getReader()` 会锁定 stream：

```typescript
const reader = stream.getReader();
stream.locked; // true
```

锁存在时不能再获取另一个 reader 或直接 pipe。`reader.releaseLock()` 只释放读者所有权；若仍不需要剩余数据，应 `reader.cancel()`/`stream.cancel()`，让取消向底层 source 传播。

使用 `for await...of` 时，运行时通过异步迭代器读取；提前 break 会执行 iterator close，Web Stream 的迭代器通常取消底层流。是否阻止 cancel 取决于具体 API 选项，不能想当然。

---

## 6. pull、desiredSize 与 highWaterMark

Underlying source 常实现：

```typescript
new ReadableStream({
  start(controller) {},
  pull(controller) {},
  cancel(reason) {},
});
```

- start：构造后初始化。
- pull：内部队列需要更多数据时调用，可以返回 Promise。
- cancel：消费者不再需要数据时清理底层资源。

Queuing strategy 用：

- `highWaterMark`：触发背压前期望的队列容量。
- `size(chunk)`：每个 chunk 计入多少容量。

`controller.desiredSize` 表示距离高水位还可接受多少；小于等于 0 时 source 应停止主动 enqueue，等后续 pull。

### 背压不是自动限速一切

Web Stream 只能向它控制的上游传播需求。如果上游 SDK 已把整个响应读入数组，后面再包 ReadableStream 无法恢复网络级背压。要沿 pipeline 检查每层 buffer 和 pull/cancel 支持。

---

## 7. TransformStream 的错误传播

```typescript
const transform = new TransformStream<Uint8Array, Event>({
  transform(chunk, controller) {
    controller.enqueue(parse(chunk));
  },
  flush(controller) {},
  cancel(reason) {},
});
```

transform 抛错/返回 rejected Promise 会使可读侧 errored，并通常 abort 可写侧。pipeThrough/pipeTo 的 `preventAbort`、`preventCancel`、`preventClose` 可以改变传播，但这些选项会改变资源所有权，只有明确需要时才启用。

解析协议时 flush 非常重要：

- UTF-8 Decoder 要检查尾部不完整字符。
- NDJSON 可决定 EOF 的最后非空行是否有效。
- SSE 规范规定 EOF 前没有空行完成的 pending event 不 dispatch。

不同协议的 EOF 语义不同，不能写一个“统一 flush 最后一条”的工具。

---

## 8. 行解析也有跨 chunk 状态

SSE 接受三种行结束：

- CRLF (`\r\n`)
- LF (`\n`)
- 单独 CR (`\r`)

若 chunk 以 CR 结束，解析器必须等待下一个字符，才能判断它是 CRLF 还是单 CR。状态机可以维护：

```typescript
let currentLine = '';
let pendingCR = false;
```

下个字符若是 LF，CRLF 只结束一次；否则先结束上一行，再把新字符作为下一行开头处理。

简单 `buffer.split('\n')`：

- 会在 CR-only 输入失败。
- 可能留下 `\r` 污染字段值。
- 需要正确保留最后半行。
- 在超长无换行输入中可能无界增长。

生产解析器应限制最大行长/事件大小，防止恶意流耗尽内存。

---

## 9. SSE 不是“按双换行 split”这么简单

SSE `text/event-stream` 的核心状态：

- data buffer。
- event type buffer。
- last event ID。
- reconnection time。

逐行规则：

### 空行

dispatch 当前 event。若没有 data，事件不发出；data/event buffer 重置，last event ID 保留。

### `:` 开头

注释，常用 heartbeat，忽略。

### 字段和值

只在第一个冒号切分。冒号后若有一个空格，只移除这一个空格：

```text
data:test
data: test
```

两者值都为 `test`；`data:  test` 的值仍保留一个前导空格。

### `data`

每行追加到 data buffer 并加 LF；dispatch 前移除最后一个 LF。因此多行 data 用 `\n` 连接。

### `event`

设置事件类型；空则默认 `message`。

### `id`

若不含 NULL，更新 last event ID；该值跨后续事件保留，用于重连 `Last-Event-ID`。

### `retry`

只有全 ASCII 数字才更新重连毫秒数。它不是普通业务事件。

### 未知字段

忽略，保证协议向前兼容。

### EOF

EOF 不等于空行。尚未由空行 dispatch 的 data 被丢弃。

---

## 10. SSE 与 JSON 是两层协议

```text
data: {"type":"token","delta":"你"}
```

SSE parser 的输出仍是 string。后续必须：

1. `JSON.parse`，结果为 unknown。
2. 验证判别字段。
3. 验证每个字段类型和语义范围。
4. 构造领域事件。

```typescript
type AgentStreamEvent =
  | { type: 'token'; delta: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number };
```

不要让 SSE parser 直接依赖某个模型 SDK 的全部事件类型。传输层 parser 应可复用；provider adapter 再把 provider event 归一化为 AgentStreamEvent。

`[DONE]` 等 sentinel 也属于上层供应商约定，不是 SSE 标准的一部分。

---

## 11. 流式工具调用参数

模型可能逐片输出：

```text
{"query":"Type
Script","limit":
3}
```

单个 delta 不是合法 JSON，不能逐片 `JSON.parse`。需要按 provider 的 call id/index 聚合字符串，直到收到明确 finish signal，再解析和验证。

状态结构示意：

```typescript
type PendingToolCall = {
  id: string;
  nameFragments: string[];
  argumentFragments: string[];
};
```

必须限制：

- 单调用最大参数字节数。
- 同时 pending 调用数。
- 重复/乱序 index。
- finish 前连接中断如何处理。
- Unicode fragment 是否已经由正确 Decoder 处理。

不要从半截 JSON 猜测并提前执行有副作用工具。

---

## 12. 取消：停止消费必须到达网络层

消费者收到 `[DONE]`、用户点击停止或下游断开后：

```text
UI cancel
  → Agent Run AbortSignal
  → parser/adapter stop
  → reader.cancel / fetch signal
  → HTTP body/socket/provider request
```

只 break 自己写的数组循环不会自动停止 fetch。Web Stream async iterator 在提前关闭时通常会取消 stream，但若中间自定义 generator 吞掉 `return()` 或设置 preventCancel，就可能断链。

测试应在 source.cancel 中记录调用，并在 DONE 后保留额外未读字节，证明提前停止确实到达底层，而不是因为刚好把整个流读完。

---

## 13. 错误分类与部分输出

流已经输出部分 token 后失败，不能假装整个响应从未发生：

```typescript
type StreamOutcome =
  | { status: 'completed'; text: string; usage?: Usage }
  | { status: 'cancelled'; partialText: string; reason: unknown }
  | { status: 'failed'; partialText: string; cause: unknown };
```

需要决定：

- UI 是否保留 partial text。
- 是否允许重试并拼接，如何避免重复 token。
- usage 缺失时怎样计费/估算。
- 持久化 transcript 是否标记 incomplete。
- 工具参数只收到一半时必须丢弃还是可恢复。

错误可能来自不同层：UTF-8、framing、JSON、schema、provider protocol、网络、取消。保留层级才能快速定位。

---

## 14. 重连、事件 ID 与幂等性

标准 EventSource 可以依据 last event ID 重连。自定义 fetch + SSE parser 若要重连，需要自己实现：

- 保存最近成功 dispatch 的 id。
- 遵守服务器 retry 或客户端 backoff 上限。
- 发送 Last-Event-ID/供应商恢复 token。
- 对重复事件去重。
- 确认服务端是否真的支持 resume。

模型生成流通常不支持从任意 token 精确续传；盲目重发整个请求可能产生不同答案、重复工具调用和额外费用。有副作用的工具必须依赖 call id/幂等键，而不是假设重连不会重复。

---

## 15. Node Stream 与 Web Stream 互操作

Node 生态有两套常见接口：

- 传统 `node:stream` Readable/Writable/Transform。
- WHATWG `node:stream/web` Web Streams。

桥接 API 能转换，但要核对：

- objectMode 与 chunk 类型。
- highWaterMark 单位（对象数或字节近似）。
- destroy/error 和 cancel/abort 的映射。
- backpressure 是否贯穿。
- reader lock 和 Node pipe 所有权。

同一层内部尽量统一一种模型，只在适配边界转换，避免每个函数都接受两套联合类型。

---

## 16. 性能与内存

- 避免对每个 token 反复拼接超长 string 导致二次方复制；可收集 chunk 后 join，或使用 rope 优化由引擎决定但不能盲信。
- 限制单行、单 event、JSON 深度和累计响应大小。
- 不要为每个字节创建对象；选择合理 chunk。
- Decoder、parser 状态应绑定单条流，不能跨请求复用。
- UI 不必逐 token render，可按时间/字符批量刷新。
- 日志不要复制完整 prompt/response 多次。
- 消费者慢时监测队列长度和 desiredSize，而不是无界缓存。

优化前应 profile。流式的主要价值常是降低首 token 延迟和内存峰值，不一定减少总计算量。

---

## 17. 测试矩阵

### 字节切分

- 每个可能字节位置切分。
- 多字节 UTF-8 中间切分。
- BOM。
- 非法 UTF-8 与 EOF 半字符。

### 行切分

- LF、CRLF、CR 混合。
- CR 与 LF 分属两个 chunk。
- 空行跨 chunk。
- 超长行。

### SSE

- 多行 data。
- comment/heartbeat。
- data 空值。
- id 跨事件保留和清空。
- retry 合法/非法。
- 未知字段。
- EOF 未完成事件不 dispatch。

### Agent 协议

- 非法 JSON。
- 未知 type。
- 字段类型错误。
- [DONE] 后底层 cancel。
- 中途 abort。
- 部分工具参数和重复 call id。

最强测试性质是：**同一字节 payload 的任意合法 chunking，解析结果相同。** 可以用 property-based testing 随机生成切分。

MCP Streamable HTTP 会把 JSON-RPC response、request 和 notification 放进 POST response 或独立 SSE stream，并增加 event-id 恢复、session 和显式取消语义。SSE parser 只恢复 record，不能替代上层 request correlator 与 MCP 生命周期，完整分层见 [JSON-RPC 2.0 与 MCP 协议底层](26_json_rpc_mcp_protocol_internals.md)。

---

## 一句话总结

Agent 流式处理必须分层保持状态：Decoder 跨 chunk 保存 UTF-8 状态，line splitter 保存换行状态，SSE parser 保存 data/event/id，provider adapter 再验证 JSON 并构造领域事件。背压和取消只有贯穿到真实网络 source 才有意义。
