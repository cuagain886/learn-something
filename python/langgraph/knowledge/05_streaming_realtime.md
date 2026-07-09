# LangGraph 流式与实时交互

## 1. 流式架构概览

### 为什么 Agent 需要流式？

Agent 执行一个任务可能需要：
- 3-5 次 LLM 调用（每次 1-5 秒）
- 多次工具执行（每次 0.5-10 秒）
- 总耗时可能 10-60 秒

**不流式** = 用户盯着空白屏幕 30 秒。
**流式** = 用户实时看到 Agent 在做什么。

### 流式层次

```
                    用户界面
                       ↑
    ─────────────── 传输层 ──────────────
    │  SSE / WebSocket / HTTP Streaming  │
    ──────────────────────────────────────
                       ↑
    ─────────── LangGraph 流式 ──────────
    │  stream() / astream()              │
    │  stream_mode: values/updates/...   │
    ──────────────────────────────────────
                       ↑
    ─────────── LLM 流式 ───────────────
    │  ChatModel(streaming=True)         │
    │  on_llm_new_token                  │
    ──────────────────────────────────────
```

## 2. stream() 模式详解

### updates 模式

```python
for chunk in app.stream(input, stream_mode="updates"):
    # chunk = {"node_name": {"field": value}}
    # 每个节点完成后输出一次
    print(chunk)

# 输出示例：
# {"agent": {"messages": [AIMessage(...)]}}
# {"tools": {"messages": [ToolMessage(...)]}}
# {"agent": {"messages": [AIMessage(...)]}}
```

- 每个节点完成后输出一个 chunk
- chunk 内容是该节点的**更新**（不是完整 State）
- 用于：追踪执行进度

### values 模式

```python
for state in app.stream(input, stream_mode="values"):
    # state = 完整的 State 对象
    print(state["messages"][-1])

# 输出示例：
# {"messages": [HumanMessage(...)], "step": 0}
# {"messages": [..., AIMessage(...)], "step": 1}
# {"messages": [..., ToolMessage(...)], "step": 2}
```

- 每个节点完成后输出**完整 State**
- 用于：需要完整上下文的 UI

### messages 模式

```python
for msg, metadata in app.stream(input, stream_mode="messages"):
    # msg = 消息对象（可能是部分内容）
    # metadata = {"langgraph_node": "agent", ...}
    if msg.content:
        print(msg.content, end="", flush=True)
```

- **逐 token** 输出 LLM 生成的内容
- 前提：ChatModel 需要启用 streaming=True
- 用于：聊天界面的逐字显示

### 组合模式

```python
# ⭐ 同时获取多种流
for event in app.stream(input, stream_mode=["messages", "updates"]):
    mode, data = event
    if mode == "messages":
        msg, meta = data
        # 处理 token 级输出
    elif mode == "updates":
        # 处理节点级输出
```

## 3. astream_events

### 最细粒度的事件流

```python
async for event in app.astream_events(input, version="v2"):
    kind = event["event"]
    name = event["name"]
    data = event["data"]

    # 事件类型：
    # on_chain_start      → 节点开始
    # on_chain_end        → 节点结束
    # on_chat_model_start → LLM 调用开始
    # on_chat_model_stream → LLM token
    # on_chat_model_end   → LLM 调用结束
    # on_tool_start       → 工具调用开始
    # on_tool_end         → 工具调用结束
    # on_retriever_start  → 检索器开始
    # on_retriever_end    → 检索器结束
```

### 过滤事件

```python
# 只看 LLM token
async for event in app.astream_events(input, version="v2"):
    if event["event"] == "on_chat_model_stream":
        token = event["data"]["chunk"].content
        yield token

# 只看特定节点
async for event in app.astream_events(input, version="v2"):
    if event["event"] == "on_chain_end" and event["name"] == "research_agent":
        result = event["data"]["output"]
        yield f"Research complete: {result}"
```

### 事件用途

```
事件                    UI 动作
────────────────────────────────────
on_chain_start          显示"正在思考..."
on_chat_model_stream    逐字显示 AI 回复
on_tool_start           显示"正在搜索..."
on_tool_end             显示搜索结果
on_chain_end            显示"步骤完成 ✓"
```

## 4. 传输层实现

### FastAPI + SSE

```python
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
import json

app = FastAPI()

@app.post("/chat/stream")
async def chat_stream(query: str):
    async def event_generator():
        async for msg, metadata in agent.astream(
            {"messages": [("human", query)]},
            stream_mode="messages",
        ):
            if msg.content:
                data = json.dumps({
                    "type": "token",
                    "content": msg.content,
                    "node": metadata.get("langgraph_node"),
                })
                yield f"data: {data}\n\n"

        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )
```

### 前端接收

```javascript
// EventSource（SSE）
const eventSource = new EventSource('/chat/stream?query=hello');

eventSource.onmessage = (event) => {
    if (event.data === '[DONE]') {
        eventSource.close();
        return;
    }
    const { type, content, node } = JSON.parse(event.data);

    if (type === 'token') {
        appendToChat(content);
    } else if (type === 'status') {
        updateStatusBar(node);
    }
};

eventSource.onerror = () => {
    eventSource.close();
    showError('连接断开');
};
```

### WebSocket（双向通信）

```python
from fastapi import WebSocket

@app.websocket("/ws/chat")
async def websocket_chat(ws: WebSocket):
    await ws.accept()

    while True:
        query = await ws.receive_text()

        async for msg, metadata in agent.astream(
            {"messages": [("human", query)]},
            stream_mode="messages",
        ):
            if msg.content:
                await ws.send_json({
                    "type": "token",
                    "content": msg.content,
                })

        await ws.send_json({"type": "done"})
```

SSE vs WebSocket：
- SSE：单向（服务器→客户端），简单，HTTP 兼容
- WebSocket：双向，复杂，需要连接管理
- 大多数聊天场景 SSE 就够了

## 5. 背压与性能

### 生产者-消费者问题

```
LLM 生成 token 速度：~50 token/s
网络传输速度：取决于带宽
前端渲染速度：取决于 DOM 操作

如果消费者跟不上生产者 → 内存堆积
```

### 缓冲策略

```python
# 方案 1：批量发送
buffer = []
async for token in stream:
    buffer.append(token)
    if len(buffer) >= 5 or time_elapsed > 0.1:
        yield "".join(buffer)
        buffer = []

# 方案 2：节流
import asyncio

last_send = 0
async for token in stream:
    now = asyncio.get_event_loop().time()
    if now - last_send > 0.05:  # 最多 20 次/秒
        yield token
        last_send = now
```

### 超时处理

```python
import asyncio

async def stream_with_timeout(agent, input, timeout=60):
    try:
        async for chunk in asyncio.wait_for(
            agent.astream(input, stream_mode="messages").__aiter__(),
            timeout=timeout,
        ):
            yield chunk
    except asyncio.TimeoutError:
        yield {"type": "error", "message": "执行超时"}
```

## 面试常见问题

### Q1: stream_mode 各模式的区别和选择？

| 模式 | 粒度 | 输出内容 | 适用场景 |
|------|------|----------|----------|
| updates | 节点级 | 节点的更新 | 追踪执行进度 |
| values | 节点级 | 完整 State | 需要全局状态 |
| messages | token级 | 消息片段 | 聊天逐字显示 |
| debug | 详细 | 调试信息 | 开发调试 |

### Q2: SSE 连接断开怎么处理？

1. 前端设置重连逻辑（EventSource 自带自动重连）
2. 后端使用 Checkpoint，断开后从上次位置恢复
3. 给每个事件加序号，重连后跳过已接收的事件

### Q3: 如何实现"停止生成"功能？

```python
import asyncio

cancel_event = asyncio.Event()

async def stream_handler():
    async for chunk in agent.astream(input, stream_mode="messages"):
        if cancel_event.is_set():
            break
        yield chunk

# 用户点击"停止"时
cancel_event.set()
```

结合 Checkpoint，即使中途停止，State 也保存在最后一个完成的节点。
