"""
═══════════════════════════════════════════════════════════════════
 05_tool_agent —— Tool Calling Agent
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. 手动构建 Tool Calling Agent（理解原理）
  2. 用 create_react_agent 快速创建
  3. 工具节点（ToolNode）
  4. Agent 的推理循环可视化

【Agent = LLM + 工具 + 循环】
  ┌─────────┐       ┌──────────┐
  │  Agent  │──────→│  Tools   │
  │  (LLM)  │←──────│  (执行)  │
  └────┬────┘       └──────────┘
       │ 不需要工具时
       ↓
    最终回答

  这个循环就是 LangGraph 的图结构。

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. 手动构建 Tool Agent
# ───────────────────────────────────────────────────────────────
def demo_manual_agent():
    print("══════ 1. 手动构建 Tool Agent ══════")

    from langgraph.graph import StateGraph, START, END, MessagesState
    from langchain_openai import ChatOpenAI
    from langchain_core.messages import HumanMessage, ToolMessage
    from langchain_core.tools import tool

    # 定义工具
    @tool
    def add(a: int, b: int) -> int:
        """两个数相加"""
        return a + b

    @tool
    def multiply(a: int, b: int) -> int:
        """两个数相乘"""
        return a * b

    tools = [add, multiply]
    tool_map = {t.name: t for t in tools}

    # ⭐ LLM 绑定工具
    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0).bind_tools(tools)

    # 节点 1：调用 LLM
    def call_llm(state: MessagesState) -> dict:
        response = llm.invoke(state["messages"])
        return {"messages": [response]}

    # 节点 2：执行工具
    def call_tools(state: MessagesState) -> dict:
        last_message = state["messages"][-1]
        tool_messages = []

        for tc in last_message.tool_calls:
            result = tool_map[tc["name"]].invoke(tc["args"])
            tool_messages.append(
                ToolMessage(content=str(result), tool_call_id=tc["id"])
            )

        return {"messages": tool_messages}

    # ⭐ 路由：有 tool_calls → 执行工具，没有 → 结束
    def should_call_tools(state: MessagesState) -> str:
        last_message = state["messages"][-1]
        if hasattr(last_message, "tool_calls") and last_message.tool_calls:
            return "tools"
        return "end"

    # 构建图
    graph = StateGraph(MessagesState)
    graph.add_node("llm", call_llm)
    graph.add_node("tools", call_tools)

    graph.add_edge(START, "llm")
    graph.add_conditional_edges("llm", should_call_tools, {
        "tools": "tools",
        "end": END,
    })
    graph.add_edge("tools", "llm")   # ⭐ 工具执行后回到 LLM

    app = graph.compile()

    # 测试
    result = app.invoke({
        "messages": [HumanMessage(content="先算 3+5，再把结果乘以 10")]
    })

    print("  对话过程:")
    for msg in result["messages"]:
        role = type(msg).__name__
        if hasattr(msg, 'content') and msg.content:
            print(f"    [{role}] {str(msg.content)[:80]}")
        if hasattr(msg, 'tool_calls') and msg.tool_calls:
            for tc in msg.tool_calls:
                print(f"    [ToolCall] {tc['name']}({tc['args']})")


# ───────────────────────────────────────────────────────────────
# 2. 用 create_react_agent（推荐方式）
# ───────────────────────────────────────────────────────────────
def demo_prebuilt_agent():
    print("\n══════ 2. create_react_agent ══════")

    from langgraph.prebuilt import create_react_agent
    from langchain_openai import ChatOpenAI
    from langchain_core.tools import tool

    @tool
    def search(query: str) -> str:
        """搜索知识库"""
        kb = {
            "python": "Python 是动态类型的解释型语言",
            "go": "Go 是静态类型的编译型语言",
            "rust": "Rust 是注重安全性的系统编程语言",
        }
        for key, val in kb.items():
            if key in query.lower():
                return val
        return f"未找到关于 '{query}' 的信息"

    @tool
    def calculator(expression: str) -> str:
        """计算数学表达式"""
        try:
            return str(eval(expression, {"__builtins__": {}}))
        except Exception as e:
            return f"计算错误: {e}"

    # ⭐ 一行创建 ReAct Agent
    agent = create_react_agent(
        ChatOpenAI(model="gpt-4o-mini", temperature=0),
        [search, calculator],
        # 可选：自定义 system prompt
        # prompt="你是一个有帮助的助手。用中文回答。",
    )

    # 执行
    result = agent.invoke({
        "messages": [("human", "Python 和 Go 分别是什么类型的语言？然后算 42*58")]
    })

    # 只打印最终回答
    final = result["messages"][-1]
    print(f"  最终回答: {final.content[:150]}")


# ───────────────────────────────────────────────────────────────
# 3. ToolNode 详解
# ───────────────────────────────────────────────────────────────
def demo_tool_node():
    print("\n══════ 3. ToolNode ══════")

    info = """
    from langgraph.prebuilt import ToolNode, tools_condition

    # ToolNode 封装了工具执行逻辑
    tool_node = ToolNode([add, multiply, search])

    # tools_condition 封装了路由逻辑
    # 等价于：
    # def tools_condition(state):
    #     if state["messages"][-1].tool_calls:
    #         return "tools"
    #     return "__end__"

    graph = StateGraph(MessagesState)
    graph.add_node("llm", call_llm)
    graph.add_node("tools", tool_node)        # ⭐ 替代手写的 call_tools

    graph.add_edge(START, "llm")
    graph.add_conditional_edges(
        "llm",
        tools_condition,                       # ⭐ 替代手写的 should_call_tools
    )
    graph.add_edge("tools", "llm")

    # ⚠️ ToolNode 的错误处理
    tool_node = ToolNode(
        tools,
        handle_tool_errors=True,  # 工具报错时返回错误消息而不是崩溃
    )
    """
    print(info)


# ───────────────────────────────────────────────────────────────
# 4. Agent 带记忆
# ───────────────────────────────────────────────────────────────
def demo_agent_with_memory():
    print("══════ 4. Agent 带记忆 ══════")

    from langgraph.prebuilt import create_react_agent
    from langgraph.checkpoint.memory import MemorySaver
    from langchain_openai import ChatOpenAI
    from langchain_core.tools import tool

    @tool
    def get_user_info(name: str) -> str:
        """查询用户信息"""
        db = {"小明": "25岁，Python工程师", "小红": "28岁，产品经理"}
        return db.get(name, "未找到该用户")

    agent = create_react_agent(
        ChatOpenAI(model="gpt-4o-mini", temperature=0),
        [get_user_info],
    )

    # ⭐ 加上 checkpointer 实现多轮记忆
    memory = MemorySaver()
    agent = create_react_agent(
        ChatOpenAI(model="gpt-4o-mini", temperature=0),
        [get_user_info],
        checkpointer=memory,
    )

    config = {"configurable": {"thread_id": "agent_session_1"}}

    r1 = agent.invoke({"messages": [("human", "帮我查一下小明的信息")]}, config)
    print(f"  AI: {r1['messages'][-1].content[:100]}")

    r2 = agent.invoke({"messages": [("human", "他比小红大几岁？")]}, config)
    print(f"  AI: {r2['messages'][-1].content[:100]}")


if __name__ == "__main__":
    demo_manual_agent()
    demo_prebuilt_agent()
    demo_tool_node()
    demo_agent_with_memory()
