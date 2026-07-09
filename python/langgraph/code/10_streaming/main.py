"""
═══════════════════════════════════════════════════════════════════
 10_streaming —— 流式输出与事件
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. stream() 的三种模式：values / updates / debug
  2. astream_events：细粒度事件流
  3. LLM token 级流式输出
  4. FastAPI + SSE 集成

【为什么需要流式】
  Agent 执行可能很慢（多次 LLM 调用 + 工具执行）。
  流式输出让用户实时看到：
  - LLM 正在生成什么
  - 当前执行到哪个节点
  - 工具返回了什么结果

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. stream 三种模式
# ───────────────────────────────────────────────────────────────
def demo_stream_modes():
    print("══════ 1. stream 三种模式 ══════")

    from langgraph.graph import StateGraph, START, END
    from typing import TypedDict, Annotated
    import operator

    class State(TypedDict):
        value: str
        steps: Annotated[list[str], operator.add]

    def step_a(state: State) -> dict:
        return {"value": "A处理", "steps": ["A"]}

    def step_b(state: State) -> dict:
        return {"value": "B处理", "steps": ["B"]}

    graph = StateGraph(State)
    graph.add_node("a", step_a)
    graph.add_node("b", step_b)
    graph.add_edge(START, "a")
    graph.add_edge("a", "b")
    graph.add_edge("b", END)
    app = graph.compile()

    init = {"value": "开始", "steps": []}

    # ⭐ 模式 1: "updates"（默认）—— 每步只输出变化
    print("  [updates 模式]")
    for chunk in app.stream(init, stream_mode="updates"):
        print(f"    {chunk}")

    # ⭐ 模式 2: "values" —— 每步输出完整 state
    print("\n  [values 模式]")
    for state in app.stream(init, stream_mode="values"):
        print(f"    value={state['value']}, steps={state['steps']}")

    # ⭐ 模式 3: "debug" —— 详细调试信息
    print("\n  [debug 模式]（结构示意）")
    for event in app.stream(init, stream_mode="debug"):
        event_type = event.get("type", "unknown")
        print(f"    type={event_type}")


# ───────────────────────────────────────────────────────────────
# 2. LLM token 级流式
# ───────────────────────────────────────────────────────────────
def demo_token_streaming():
    print("\n══════ 2. LLM token 流式 ══════")

    from langgraph.graph import StateGraph, START, END, MessagesState
    from langchain_openai import ChatOpenAI
    from langchain_core.messages import HumanMessage

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0, streaming=True)

    def chatbot(state: MessagesState) -> dict:
        return {"messages": [llm.invoke(state["messages"])]}

    graph = StateGraph(MessagesState)
    graph.add_node("chatbot", chatbot)
    graph.add_edge(START, "chatbot")
    graph.add_edge("chatbot", END)
    app = graph.compile()

    # ⭐ stream_mode="messages" 逐 token 输出
    print("  逐 token 输出:")
    print("  ", end="")
    for msg, metadata in app.stream(
        {"messages": [HumanMessage(content="用一句话解释什么是 LangGraph")]},
        stream_mode="messages",
    ):
        if msg.content and metadata.get("langgraph_node") == "chatbot":
            print(msg.content, end="", flush=True)
    print("\n")


# ───────────────────────────────────────────────────────────────
# 3. astream_events（异步事件流）
# ───────────────────────────────────────────────────────────────
def demo_astream_events():
    print("══════ 3. astream_events ══════")

    info = """
    import asyncio
    from langgraph.graph import StateGraph, START, END, MessagesState
    from langchain_openai import ChatOpenAI
    from langchain_core.messages import HumanMessage

    llm = ChatOpenAI(model="gpt-4o-mini", streaming=True)

    def chatbot(state: MessagesState) -> dict:
        return {"messages": [llm.invoke(state["messages"])]}

    graph = StateGraph(MessagesState)
    graph.add_node("chatbot", chatbot)
    graph.add_edge(START, "chatbot")
    graph.add_edge("chatbot", END)
    app = graph.compile()

    async def main():
        # ⭐ 最细粒度的事件流
        async for event in app.astream_events(
            {"messages": [HumanMessage(content="你好")]},
            version="v2",
        ):
            kind = event["event"]

            if kind == "on_chat_model_stream":
                # LLM token
                token = event["data"]["chunk"].content
                print(token, end="", flush=True)

            elif kind == "on_chain_start":
                # 节点开始执行
                print(f"\\n[开始] {event['name']}")

            elif kind == "on_tool_start":
                # 工具开始执行
                print(f"\\n[工具] {event['name']}: {event['data']}")

    asyncio.run(main())

    # 常用事件类型：
    # on_chain_start / on_chain_end     → 节点执行
    # on_chat_model_start / stream / end → LLM 调用
    # on_tool_start / on_tool_end       → 工具调用
    # on_retriever_start / end          → 检索器调用
    """
    print(info)


# ───────────────────────────────────────────────────────────────
# 4. FastAPI SSE 集成
# ───────────────────────────────────────────────────────────────
def demo_fastapi_sse():
    print("══════ 4. FastAPI SSE（示意） ══════")

    code = """
    from fastapi import FastAPI
    from fastapi.responses import StreamingResponse
    from langchain_openai import ChatOpenAI
    from langgraph.graph import StateGraph, START, END, MessagesState
    from langchain_core.messages import HumanMessage
    import json

    app = FastAPI()

    llm = ChatOpenAI(model="gpt-4o-mini", streaming=True)

    def chatbot(state: MessagesState) -> dict:
        return {"messages": [llm.invoke(state["messages"])]}

    graph = StateGraph(MessagesState)
    graph.add_node("chatbot", chatbot)
    graph.add_edge(START, "chatbot")
    graph.add_edge("chatbot", END)
    agent = graph.compile()

    @app.post("/chat")
    async def chat(query: str):

        async def event_generator():
            async for msg, metadata in agent.astream(
                {"messages": [HumanMessage(content=query)]},
                stream_mode="messages",
            ):
                if msg.content:
                    data = json.dumps({
                        "token": msg.content,
                        "node": metadata.get("langgraph_node", ""),
                    })
                    yield f"data: {data}\\n\\n"
            yield "data: [DONE]\\n\\n"

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
        )

    # 前端用 EventSource 接收：
    # const es = new EventSource("/chat?query=hello");
    # es.onmessage = (e) => {
    #     if (e.data === "[DONE]") { es.close(); return; }
    #     const { token } = JSON.parse(e.data);
    #     appendToUI(token);
    # };
    """
    print(code)


# ───────────────────────────────────────────────────────────────
# 5. 流式模式对比
# ───────────────────────────────────────────────────────────────
def demo_comparison():
    print("══════ 5. 流式模式对比 ══════")

    table = """
    ┌──────────────────────────────────────────────────────────────┐
    │  模式             粒度      用途                             │
    ├──────────────────────────────────────────────────────────────┤
    │  stream("updates") 节点级    看每个节点的输出                 │
    │  stream("values")  节点级    看每步的完整 state               │
    │  stream("messages") token级  逐 token 显示 LLM 生成          │
    │  stream("debug")   详细      调试：包含执行细节               │
    │  astream_events()  事件级    最细粒度：LLM/工具/节点 全部事件  │
    └──────────────────────────────────────────────────────────────┘

    ⭐ 选择建议：
    - 调试/开发     → "debug" 或 astream_events
    - 展示进度     → "updates"
    - 聊天界面     → "messages"（逐字显示）
    - 复杂 UI      → astream_events（自定义每种事件的展示）
    """
    print(table)


if __name__ == "__main__":
    demo_stream_modes()
    demo_token_streaming()
    demo_astream_events()
    demo_fastapi_sse()
    demo_comparison()
