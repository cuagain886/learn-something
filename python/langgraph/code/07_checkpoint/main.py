"""
═══════════════════════════════════════════════════════════════════
 07_checkpoint —— 检查点与状态持久化
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. Checkpoint 的作用与原理
  2. MemorySaver（内存）
  3. SqliteSaver（SQLite 持久化）
  4. 状态历史与时间旅行
  5. 多线程（thread_id）管理

【Checkpoint 解决什么问题】
  - 多轮对话保持上下文
  - 长任务中断后恢复
  - 人机交互暂停/继续
  - 回溯到之前的状态（时间旅行）
  - 从某个点分叉探索不同路径

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. MemorySaver
# ───────────────────────────────────────────────────────────────
def demo_memory_saver():
    print("══════ 1. MemorySaver ══════")

    from langgraph.graph import StateGraph, START, END, MessagesState
    from langgraph.checkpoint.memory import MemorySaver
    from langchain_core.messages import HumanMessage, AIMessage

    def echo(state: MessagesState) -> dict:
        last = state["messages"][-1].content
        return {"messages": [AIMessage(content=f"Echo: {last}")]}

    graph = StateGraph(MessagesState)
    graph.add_node("echo", echo)
    graph.add_edge(START, "echo")
    graph.add_edge("echo", END)

    # ⭐ MemorySaver：内存中保存所有状态快照
    memory = MemorySaver()
    app = graph.compile(checkpointer=memory)

    config = {"configurable": {"thread_id": "demo_1"}}

    # 多次调用，状态自动累积
    app.invoke({"messages": [HumanMessage(content="第一条")]}, config)
    app.invoke({"messages": [HumanMessage(content="第二条")]}, config)
    app.invoke({"messages": [HumanMessage(content="第三条")]}, config)

    # 查看当前状态
    state = app.get_state(config)
    print(f"  消息数: {len(state.values['messages'])}")
    for msg in state.values["messages"]:
        role = "H" if isinstance(msg, HumanMessage) else "A"
        print(f"    [{role}] {msg.content}")


# ───────────────────────────────────────────────────────────────
# 2. 状态历史（时间旅行）
# ───────────────────────────────────────────────────────────────
def demo_state_history():
    print("\n══════ 2. 状态历史 ══════")

    from langgraph.graph import StateGraph, START, END
    from langgraph.checkpoint.memory import MemorySaver
    from typing import TypedDict

    class State(TypedDict):
        value: int

    def increment(state: State) -> dict:
        return {"value": state["value"] + 1}

    graph = StateGraph(State)
    graph.add_node("inc", increment)
    graph.add_edge(START, "inc")
    graph.add_edge("inc", END)

    memory = MemorySaver()
    app = graph.compile(checkpointer=memory)

    config = {"configurable": {"thread_id": "history_demo"}}

    # 执行多次
    for i in range(5):
        result = app.invoke({"value": i * 10}, config)

    # ⭐ 遍历状态历史
    print("  状态历史（最新 → 最旧）:")
    for i, state in enumerate(app.get_state_history(config)):
        print(f"    [{i}] value={state.values['value']}, "
              f"checkpoint_id={state.config['configurable']['checkpoint_id'][:8]}...")
        if i >= 4:
            break

    # ⭐ 回到某个历史状态
    history = list(app.get_state_history(config))
    if len(history) >= 3:
        old_config = history[3].config
        old_state = app.get_state(old_config)
        print(f"\n  回到第3个快照: value={old_state.values['value']}")

        # 从这个快照点继续执行（分叉）
        result = app.invoke({"value": 999}, old_config)
        print(f"  从旧快照继续: value={result['value']}")


# ───────────────────────────────────────────────────────────────
# 3. SQLite 持久化
# ───────────────────────────────────────────────────────────────
def demo_sqlite_saver():
    print("\n══════ 3. SQLite 持久化（示意） ══════")

    info = """
    from langgraph.checkpoint.sqlite import SqliteSaver

    # 文件存储（重启后数据还在）
    with SqliteSaver.from_conn_string("checkpoints.db") as saver:
        app = graph.compile(checkpointer=saver)

        config = {"configurable": {"thread_id": "persistent_1"}}
        result = app.invoke(input, config)

    # ⭐ 异步版本
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

    async with AsyncSqliteSaver.from_conn_string("checkpoints.db") as saver:
        app = graph.compile(checkpointer=saver)
        result = await app.ainvoke(input, config)

    # ⭐ PostgreSQL（生产环境推荐）
    # pip install langgraph-checkpoint-postgres
    from langgraph.checkpoint.postgres import PostgresSaver

    with PostgresSaver.from_conn_string("postgresql://...") as saver:
        app = graph.compile(checkpointer=saver)

    # 存储后端选择：
    # MemorySaver   → 开发/测试（进程退出就丢失）
    # SqliteSaver   → 单机持久化
    # PostgresSaver → 生产环境、多实例共享
    """
    print(info)


# ───────────────────────────────────────────────────────────────
# 4. thread_id 多会话
# ───────────────────────────────────────────────────────────────
def demo_multi_thread():
    print("══════ 4. 多会话管理 ══════")

    from langgraph.graph import StateGraph, START, END, MessagesState
    from langgraph.checkpoint.memory import MemorySaver
    from langchain_core.messages import HumanMessage, AIMessage

    def echo(state: MessagesState) -> dict:
        return {"messages": [AIMessage(content=f"收到: {state['messages'][-1].content}")]}

    graph = StateGraph(MessagesState)
    graph.add_node("echo", echo)
    graph.add_edge(START, "echo")
    graph.add_edge("echo", END)

    memory = MemorySaver()
    app = graph.compile(checkpointer=memory)

    # ⭐ 不同 thread_id = 不同会话 = 完全隔离的状态
    for user in ["alice", "bob"]:
        config = {"configurable": {"thread_id": f"user_{user}"}}
        app.invoke({"messages": [HumanMessage(content=f"我是{user}")]}, config)
        app.invoke({"messages": [HumanMessage(content="你记得我吗？")]}, config)

    # 查看各会话状态
    for user in ["alice", "bob"]:
        config = {"configurable": {"thread_id": f"user_{user}"}}
        state = app.get_state(config)
        msg_count = len(state.values["messages"])
        first_msg = state.values["messages"][0].content
        print(f"  {user}: {msg_count} 条消息，首条: {first_msg}")

    print("\n  ⭐ 每个 thread_id 的状态完全独立")
    print("  实际应用中：thread_id = 用户ID 或 会话ID")


if __name__ == "__main__":
    demo_memory_saver()
    demo_state_history()
    demo_sqlite_saver()
    demo_multi_thread()
