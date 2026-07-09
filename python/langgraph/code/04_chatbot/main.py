"""
═══════════════════════════════════════════════════════════════════
 04_chatbot —— 用 LangGraph 构建聊天机器人
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. MessagesState + ChatModel 构建对话 Agent
  2. 对话历史自动管理
  3. 历史裁剪（防止超出 token 限制）
  4. 多会话隔离（thread_id）

【为什么用 LangGraph 做聊天机器人】
  比起手动拼接消息列表，LangGraph 提供：
  - 自动管理消息历史（add_messages reducer）
  - Checkpoint 持久化（关闭后重开还记得对话）
  - 多会话隔离（不同用户不同 thread_id）
  - 可以随时加入工具调用、人工审核等节点

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. 最简单的聊天机器人
# ───────────────────────────────────────────────────────────────
def demo_simple_chatbot():
    print("══════ 1. 简单聊天机器人 ══════")

    from langgraph.graph import StateGraph, START, END, MessagesState
    from langchain_openai import ChatOpenAI
    from langchain_core.messages import HumanMessage

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)

    # ⭐ 只需要一个节点：调用 LLM
    def chatbot(state: MessagesState) -> dict:
        response = llm.invoke(state["messages"])
        return {"messages": [response]}
        # add_messages reducer 会自动追加到 messages 列表

    graph = StateGraph(MessagesState)
    graph.add_node("chatbot", chatbot)
    graph.add_edge(START, "chatbot")
    graph.add_edge("chatbot", END)

    app = graph.compile()

    # 第一轮
    result = app.invoke({
        "messages": [HumanMessage(content="你好，我叫小明")]
    })
    print(f"  AI: {result['messages'][-1].content}")

    # ⚠️ 没有 checkpoint 的话，每次调用是独立的
    # 第二轮不记得之前的对话
    result2 = app.invoke({
        "messages": [HumanMessage(content="我叫什么名字？")]
    })
    print(f"  AI: {result2['messages'][-1].content}")
    print("  ⚠️ 没有 checkpoint，AI 不记得你叫小明")


# ───────────────────────────────────────────────────────────────
# 2. 带记忆的聊天机器人
# ───────────────────────────────────────────────────────────────
def demo_chatbot_with_memory():
    print("\n══════ 2. 带记忆的聊天机器人 ══════")

    from langgraph.graph import StateGraph, START, END, MessagesState
    from langgraph.checkpoint.memory import MemorySaver
    from langchain_openai import ChatOpenAI
    from langchain_core.messages import HumanMessage, SystemMessage

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)

    def chatbot(state: MessagesState) -> dict:
        # 在消息前加入 system prompt
        system = SystemMessage(content="你是一个友好的助手，记住用户告诉你的所有信息。简洁回答。")
        messages = [system] + state["messages"]
        response = llm.invoke(messages)
        return {"messages": [response]}

    graph = StateGraph(MessagesState)
    graph.add_node("chatbot", chatbot)
    graph.add_edge(START, "chatbot")
    graph.add_edge("chatbot", END)

    # ⭐ 添加 MemorySaver 实现对话记忆
    memory = MemorySaver()
    app = graph.compile(checkpointer=memory)

    # ⭐ 使用 thread_id 标识会话
    config = {"configurable": {"thread_id": "session_001"}}

    # 多轮对话
    r1 = app.invoke({"messages": [HumanMessage(content="我叫小明，今年25岁")]}, config)
    print(f"  AI: {r1['messages'][-1].content}")

    r2 = app.invoke({"messages": [HumanMessage(content="我叫什么名字？几岁？")]}, config)
    print(f"  AI: {r2['messages'][-1].content}")

    # 不同会话是隔离的
    config2 = {"configurable": {"thread_id": "session_002"}}
    r3 = app.invoke({"messages": [HumanMessage(content="我叫什么名字？")]}, config2)
    print(f"  AI (新会话): {r3['messages'][-1].content}")


# ───────────────────────────────────────────────────────────────
# 3. 对话历史裁剪
# ───────────────────────────────────────────────────────────────
def demo_trim_history():
    print("\n══════ 3. 对话历史裁剪 ══════")

    from langgraph.graph import StateGraph, START, END, MessagesState
    from langgraph.checkpoint.memory import MemorySaver
    from langchain_openai import ChatOpenAI
    from langchain_core.messages import (
        HumanMessage, SystemMessage, trim_messages,
    )

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)

    def chatbot(state: MessagesState) -> dict:
        # ⭐ 裁剪历史：只保留最近的消息
        trimmed = trim_messages(
            state["messages"],
            max_tokens=500,          # 最多保留 500 token
            strategy="last",         # 保留最新的
            token_counter=len,       # 简化：用字符数计数
            include_system=True,     # 总是保留 system
        )

        system = SystemMessage(content="你是一个助手。简洁回答。")
        response = llm.invoke([system] + trimmed)
        return {"messages": [response]}

    graph = StateGraph(MessagesState)
    graph.add_node("chatbot", chatbot)
    graph.add_edge(START, "chatbot")
    graph.add_edge("chatbot", END)

    memory = MemorySaver()
    app = graph.compile(checkpointer=memory)
    config = {"configurable": {"thread_id": "trim_demo"}}

    # 模拟多轮对话
    for i, msg in enumerate(["你好", "1+1=?", "再加2呢？", "再乘以3呢？"]):
        result = app.invoke({"messages": [HumanMessage(content=msg)]}, config)
        print(f"  [{i+1}] 用户: {msg}")
        print(f"       AI: {result['messages'][-1].content}")

    # 查看实际存储了多少条消息
    state = app.get_state(config)
    print(f"\n  存储的消息数: {len(state.values['messages'])}")


# ───────────────────────────────────────────────────────────────
# 4. 带 System Prompt 配置的机器人
# ───────────────────────────────────────────────────────────────
def demo_configurable_chatbot():
    print("\n══════ 4. 可配置的聊天机器人 ══════")

    from langgraph.graph import StateGraph, START, END, MessagesState
    from langchain_openai import ChatOpenAI
    from langchain_core.messages import HumanMessage, SystemMessage
    from langchain_core.runnables import RunnableConfig

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)

    # ⭐ 扩展 state 添加配置字段
    class ChatState(MessagesState):
        system_prompt: str

    def chatbot(state: ChatState) -> dict:
        system = SystemMessage(content=state.get("system_prompt", "你是一个助手。"))
        response = llm.invoke([system] + state["messages"])
        return {"messages": [response]}

    graph = StateGraph(ChatState)
    graph.add_node("chatbot", chatbot)
    graph.add_edge(START, "chatbot")
    graph.add_edge("chatbot", END)

    app = graph.compile()

    # 不同 system prompt → 不同人格
    for persona, prompt in [
        ("海盗", "你是一个海盗，用海盗的语气说话，加上'嘿嘿'之类的语气词。"),
        ("诗人", "你是一个诗人，用优美的诗歌形式回答所有问题。"),
    ]:
        result = app.invoke({
            "messages": [HumanMessage(content="自我介绍一下")],
            "system_prompt": prompt,
        })
        print(f"  [{persona}] {result['messages'][-1].content[:80]}...")
        print()


if __name__ == "__main__":
    demo_simple_chatbot()
    demo_chatbot_with_memory()
    demo_trim_history()
    demo_configurable_chatbot()
