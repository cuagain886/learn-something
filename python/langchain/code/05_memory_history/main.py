"""
═══════════════════════════════════════════════════════════════════
 05_memory_history —— 记忆与对话历史管理
═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 为什么需要记忆（LLM 是无状态的）
 2. ChatMessageHistory（内存中的对话历史）
 3. RunnableWithMessageHistory（给链添加记忆）
 4. 多会话管理（session_id）
 5. 历史窗口裁剪策略

【核心问题】
  LLM 每次调用都是独立的，不记得之前说过什么。
  要实现多轮对话，你需要自己管理消息历史，
  每次调用时把历史拼接到 prompt 中。

  LangChain 的 Memory 组件帮你自动化这个过程。

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. 手动管理对话历史（理解原理）
# ───────────────────────────────────────────────────────────────
def demo_manual_history():
    print("══════ 1. 手动管理对话历史 ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.messages import SystemMessage, HumanMessage, AIMessage

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)

    # 手动维护消息列表
    messages = [
        SystemMessage(content="你是一个友好的助手，记住用户告诉你的所有信息。"),
    ]

    # 第一轮
    messages.append(HumanMessage(content="我叫小明，我在学 LangChain"))
    response1 = llm.invoke(messages)
    messages.append(response1)
    print(f"  AI: {response1.content}")

    # 第二轮——AI 能记住上下文
    messages.append(HumanMessage(content="我叫什么？我在学什么？"))
    response2 = llm.invoke(messages)
    messages.append(response2)
    print(f"  AI: {response2.content}")

    # ⚠️ 问题：历史会越来越长，最终超出 token 限制
    print(f"  消息数量: {len(messages)}")


# ───────────────────────────────────────────────────────────────
# 2. ChatMessageHistory
# ───────────────────────────────────────────────────────────────
def demo_chat_history():
    print("\n══════ 2. ChatMessageHistory ══════")

    from langchain_core.chat_history import InMemoryChatMessageHistory
    from langchain_core.messages import HumanMessage, AIMessage

    # 创建内存中的历史存储
    history = InMemoryChatMessageHistory()

    # 添加消息
    history.add_user_message("你好，我是小明")
    history.add_ai_message("你好小明！很高兴认识你。")
    history.add_user_message("我今年25岁")
    history.add_ai_message("好的，已记住你25岁。")

    # 获取所有消息
    print(f"  消息数: {len(history.messages)}")
    for msg in history.messages:
        role = "人类" if isinstance(msg, HumanMessage) else "AI"
        print(f"  [{role}] {msg.content}")

    # 清空历史
    # history.clear()


# ───────────────────────────────────────────────────────────────
# 3. RunnableWithMessageHistory
# ───────────────────────────────────────────────────────────────
def demo_runnable_with_history():
    """给任何链自动添加消息历史管理"""
    print("\n══════ 3. RunnableWithMessageHistory ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
    from langchain_core.output_parsers import StrOutputParser
    from langchain_core.chat_history import InMemoryChatMessageHistory
    from langchain_core.runnables.history import RunnableWithMessageHistory

    # 步骤 1：定义带历史占位符的 prompt
    prompt = ChatPromptTemplate.from_messages([
        ("system", "你是一个有帮助的助手。简洁回答。"),
        MessagesPlaceholder(variable_name="history"),
        ("human", "{input}"),
    ])

    chain = prompt | ChatOpenAI(model="gpt-4o-mini", temperature=0) | StrOutputParser()

    # 步骤 2：创建会话存储（按 session_id 区分）
    store = {}

    def get_session_history(session_id: str) -> InMemoryChatMessageHistory:
        if session_id not in store:
            store[session_id] = InMemoryChatMessageHistory()
        return store[session_id]

    # 步骤 3：包装链
    chain_with_history = RunnableWithMessageHistory(
        chain,
        get_session_history,
        input_messages_key="input",       # 用户输入的 key
        history_messages_key="history",   # 历史消息插入的 key
    )

    # ⭐ 使用时必须传入 config 指定 session_id
    config = {"configurable": {"session_id": "user_001"}}

    # 多轮对话
    r1 = chain_with_history.invoke({"input": "我叫小明"}, config=config)
    print(f"  轮1: {r1}")

    r2 = chain_with_history.invoke({"input": "我叫什么名字？"}, config=config)
    print(f"  轮2: {r2}")

    # 不同 session 是隔离的
    config2 = {"configurable": {"session_id": "user_002"}}
    r3 = chain_with_history.invoke({"input": "我叫什么名字？"}, config=config2)
    print(f"  新会话: {r3}")


# ───────────────────────────────────────────────────────────────
# 4. 历史裁剪策略
# ───────────────────────────────────────────────────────────────
def demo_trim_history():
    print("\n══════ 4. 历史裁剪 ══════")

    from langchain_core.messages import (
        SystemMessage, HumanMessage, AIMessage,
        trim_messages,
    )

    messages = [
        SystemMessage(content="你是一个助手。"),
        HumanMessage(content="你好"),
        AIMessage(content="你好！"),
        HumanMessage(content="1+1=?"),
        AIMessage(content="等于2"),
        HumanMessage(content="再加3呢？"),
        AIMessage(content="等于5"),
        HumanMessage(content="Python 怎么学？"),
        AIMessage(content="建议从基础语法开始..."),
    ]

    # ⭐ trim_messages：按 token 数裁剪（保留最近的消息）
    trimmed = trim_messages(
        messages,
        max_tokens=100,
        strategy="last",               # "last" 保留最新的
        token_counter=len,              # 简化：按字符数计数（实际应用中用 tiktoken）
        include_system=True,            # 始终保留 system message
        allow_partial=False,            # 不截断单条消息
    )

    print(f"  原始消息: {len(messages)} 条")
    print(f"  裁剪后: {len(trimmed)} 条")
    for msg in trimmed:
        role = type(msg).__name__.replace("Message", "")
        print(f"  [{role}] {msg.content[:30]}")


# ───────────────────────────────────────────────────────────────
# 5. 持久化存储方案
# ───────────────────────────────────────────────────────────────
def demo_persistence():
    print("\n══════ 5. 持久化存储方案 ══════")

    info = """
    内存存储（InMemoryChatMessageHistory）只适合开发和测试。
    生产环境需要持久化：

    ┌──────────────────────────────────────────────────────────┐
    │  存储后端                  适用场景                       │
    ├──────────────────────────────────────────────────────────┤
    │  Redis                    高性能、TTL 自动过期            │
    │  PostgreSQL               已有关系型数据库的项目          │
    │  MongoDB                  文档型存储，灵活 schema         │
    │  SQLite                   单机小项目                     │
    │  文件系统                  最简单，适合原型                │
    └──────────────────────────────────────────────────────────┘

    安装示例：
      pip install langchain-redis    # Redis 存储
      pip install langchain-postgres # PostgreSQL 存储

    使用方式：只需替换 get_session_history 函数的实现，
    链的其他部分完全不变。这就是 LangChain 抽象的好处。

    Redis 示例：
    ```python
    from langchain_redis import RedisChatMessageHistory

    def get_session_history(session_id):
        return RedisChatMessageHistory(
            session_id=session_id,
            redis_url="redis://localhost:6379",
            ttl=3600,  # 1小时过期
        )
    ```
    """
    print(info)


if __name__ == "__main__":
    demo_manual_history()
    demo_chat_history()
    demo_runnable_with_history()
    demo_trim_history()
    demo_persistence()
