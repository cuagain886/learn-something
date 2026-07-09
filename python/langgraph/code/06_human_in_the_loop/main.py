"""
═══════════════════════════════════════════════════════════════════
 06_human_in_the_loop —— 人机交互
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. interrupt_before / interrupt_after
  2. 获取暂停时的状态
  3. 人工修改状态后继续
  4. 工具调用前的人工确认
  5. 审批流程设计

【为什么需要人机交互】
  Agent 自主行动虽好，但某些操作需要人工把关：
  - 发送邮件/消息前确认
  - 修改数据库前审核
  - 大额交易前审批
  - Agent 不确定时请求帮助

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. interrupt_before 基础
# ───────────────────────────────────────────────────────────────
def demo_interrupt_before():
    print("══════ 1. interrupt_before ══════")

    from langgraph.graph import StateGraph, START, END
    from langgraph.checkpoint.memory import MemorySaver
    from typing import TypedDict

    class State(TypedDict):
        request: str
        plan: str
        result: str
        approved: bool

    def plan_action(state: State) -> dict:
        return {"plan": f"计划：对'{state['request']}'执行操作"}

    def execute_action(state: State) -> dict:
        return {"result": f"已执行：{state['plan']}"}

    graph = StateGraph(State)
    graph.add_node("plan", plan_action)
    graph.add_node("execute", execute_action)

    graph.add_edge(START, "plan")
    graph.add_edge("plan", "execute")
    graph.add_edge("execute", END)

    # ⭐ 在 execute 之前暂停
    memory = MemorySaver()
    app = graph.compile(
        checkpointer=memory,
        interrupt_before=["execute"],   # 执行前暂停
    )

    config = {"configurable": {"thread_id": "approval_1"}}

    # 第一次调用：执行到 execute 之前暂停
    result = app.invoke(
        {"request": "删除所有数据", "plan": "", "result": "", "approved": False},
        config
    )
    print(f"  计划: {result['plan']}")
    print(f"  状态: 已暂停，等待人工确认")

    # 查看当前状态
    current = app.get_state(config)
    print(f"  下一步将执行: {current.next}")  # ('execute',)

    # 模拟人工确认：继续执行
    print("\n  [人工确认] 批准执行")
    final = app.invoke(None, config)  # ⭐ 传 None 继续
    print(f"  结果: {final['result']}")


# ───────────────────────────────────────────────────────────────
# 2. 修改状态后继续
# ───────────────────────────────────────────────────────────────
def demo_modify_state():
    print("\n══════ 2. 修改状态后继续 ══════")

    from langgraph.graph import StateGraph, START, END
    from langgraph.checkpoint.memory import MemorySaver
    from typing import TypedDict

    class State(TypedDict):
        draft: str
        final: str

    def write_draft(state: State) -> dict:
        return {"draft": "这是AI生成的初稿，可能有错误。"}

    def publish(state: State) -> dict:
        return {"final": f"已发布: {state['draft']}"}

    graph = StateGraph(State)
    graph.add_node("write", write_draft)
    graph.add_node("publish", publish)
    graph.add_edge(START, "write")
    graph.add_edge("write", "publish")
    graph.add_edge("publish", END)

    memory = MemorySaver()
    app = graph.compile(
        checkpointer=memory,
        interrupt_before=["publish"],
    )

    config = {"configurable": {"thread_id": "edit_1"}}

    # 执行到 publish 前暂停
    result = app.invoke({"draft": "", "final": ""}, config)
    print(f"  初稿: {result['draft']}")

    # ⭐ 人工编辑 state
    print("  [人工] 修改初稿内容")
    app.update_state(
        config,
        {"draft": "这是人工修改后的稿件，确认无误。"},
    )

    # 继续执行
    final = app.invoke(None, config)
    print(f"  发布: {final['final']}")


# ───────────────────────────────────────────────────────────────
# 3. 工具调用前确认
# ───────────────────────────────────────────────────────────────
def demo_tool_approval():
    print("\n══════ 3. 工具调用前确认 ══════")

    from langgraph.graph import StateGraph, START, END, MessagesState
    from langgraph.prebuilt import ToolNode, tools_condition
    from langgraph.checkpoint.memory import MemorySaver
    from langchain_openai import ChatOpenAI
    from langchain_core.tools import tool
    from langchain_core.messages import HumanMessage

    @tool
    def send_email(to: str, subject: str, body: str) -> str:
        """发送邮件"""
        return f"邮件已发送给 {to}，主题：{subject}"

    @tool
    def search(query: str) -> str:
        """搜索信息"""
        return f"搜索结果：关于 '{query}' 的信息..."

    tools = [send_email, search]
    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0).bind_tools(tools)

    def call_llm(state: MessagesState) -> dict:
        return {"messages": [llm.invoke(state["messages"])]}

    graph = StateGraph(MessagesState)
    graph.add_node("llm", call_llm)
    graph.add_node("tools", ToolNode(tools))
    graph.add_edge(START, "llm")
    graph.add_conditional_edges("llm", tools_condition)
    graph.add_edge("tools", "llm")

    memory = MemorySaver()
    app = graph.compile(
        checkpointer=memory,
        # ⭐ 在 tools 节点前暂停——让人确认工具调用
        interrupt_before=["tools"],
    )

    config = {"configurable": {"thread_id": "tool_approval_1"}}

    # Agent 想发邮件
    result = app.invoke({
        "messages": [HumanMessage(content="帮我给 alice@example.com 发一封邮件，主题是会议通知")]
    }, config)

    # 暂停了——查看 Agent 准备调用什么工具
    last_msg = result["messages"][-1]
    if hasattr(last_msg, "tool_calls") and last_msg.tool_calls:
        for tc in last_msg.tool_calls:
            print(f"  Agent 准备调用: {tc['name']}")
            print(f"  参数: {tc['args']}")

        # 人工确认后继续
        print("  [人工] 确认发送")
        final = app.invoke(None, config)
        print(f"  结果: {final['messages'][-1].content[:80]}")


# ───────────────────────────────────────────────────────────────
# 4. 设计模式总结
# ───────────────────────────────────────────────────────────────
def demo_patterns():
    print("\n══════ 4. 人机交互模式 ══════")

    patterns = """
    ┌──────────────────────────────────────────────────────────┐
    │  模式                 实现方式                            │
    ├──────────────────────────────────────────────────────────┤
    │                                                          │
    │  执行前审批            interrupt_before=["action_node"]   │
    │  → 人看到计划后决定是否继续                                │
    │                                                          │
    │  结果审核              interrupt_after=["generate_node"]  │
    │  → 人看到结果后决定接受还是重做                            │
    │                                                          │
    │  修改并继续            update_state() + invoke(None)      │
    │  → 人修改 state 中的内容后继续                             │
    │                                                          │
    │  工具白名单            检查 tool_calls，不在白名单的暂停    │
    │  → 安全工具自动执行，敏感工具需人工确认                     │
    │                                                          │
    │  拒绝并终止            update_state() 设置 "rejected"     │
    │  → 人不同意，修改 state 导致路由到 END                     │
    │                                                          │
    └──────────────────────────────────────────────────────────┘

    ⭐ 关键 API：
    - app.compile(interrupt_before=["node"])
    - app.compile(interrupt_after=["node"])
    - app.get_state(config)           → 查看暂停时的状态
    - app.update_state(config, values) → 修改状态
    - app.invoke(None, config)        → 继续执行
    """
    print(patterns)


if __name__ == "__main__":
    demo_interrupt_before()
    demo_modify_state()
    demo_tool_approval()
    demo_patterns()
