"""
═══════════════════════════════════════════════════════════════════
 15_langgraph —— LangGraph 入门
═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. LangGraph 是什么（vs AgentExecutor）
 2. StateGraph：状态图的基本结构
 3. 节点（Node）、边（Edge）、条件边
 4. 用 LangGraph 构建 ReAct Agent
 5. 人机交互（Human-in-the-loop）
 6. 检查点与状态持久化

【为什么需要 LangGraph】
  AgentExecutor 是简单的线性循环：LLM → 工具 → LLM → 工具 → ...
  真实场景需要：
  - 条件分支（根据结果走不同路径）
  - 循环（重试、自我纠正）
  - 并行执行
  - 人工审核节点
  - 状态持久化（中断后恢复）

  LangGraph 用有向图来编排这些复杂流程。

【安装】pip install langgraph

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. 最简单的 StateGraph
# ───────────────────────────────────────────────────────────────
def demo_basic_graph():
    print("══════ 1. 最简单的 StateGraph ══════")

    from langgraph.graph import StateGraph, START, END
    from typing import TypedDict

    # ⭐ 第一步：定义状态（State）
    # 状态是一个 TypedDict，贯穿整个图的执行
    class MyState(TypedDict):
        input: str
        steps: list[str]
        output: str

    # ⭐ 第二步：定义节点（Node）
    # 每个节点是一个函数，接收 state，返回状态更新
    def step_one(state: MyState) -> dict:
        return {
            "steps": state.get("steps", []) + ["step_one 已执行"],
        }

    def step_two(state: MyState) -> dict:
        return {
            "steps": state["steps"] + ["step_two 已执行"],
            "output": f"处理完成: {state['input']}",
        }

    # ⭐ 第三步：构建图
    graph = StateGraph(MyState)

    # 添加节点
    graph.add_node("step_one", step_one)
    graph.add_node("step_two", step_two)

    # 添加边（定义执行顺序）
    graph.add_edge(START, "step_one")      # 入口 → step_one
    graph.add_edge("step_one", "step_two") # step_one → step_two
    graph.add_edge("step_two", END)        # step_two → 结束

    # 编译图
    app = graph.compile()

    # 执行
    result = app.invoke({"input": "Hello LangGraph", "steps": []})
    print(f"  步骤: {result['steps']}")
    print(f"  输出: {result['output']}")

    # 查看图结构
    print(f"\n  图结构: {app.get_graph().draw_ascii()}")


# ───────────────────────────────────────────────────────────────
# 2. 条件边（Conditional Edge）
# ───────────────────────────────────────────────────────────────
def demo_conditional_edge():
    print("\n══════ 2. 条件边 ══════")

    from langgraph.graph import StateGraph, START, END
    from typing import TypedDict

    class ReviewState(TypedDict):
        code: str
        review_result: str
        attempt: int

    def write_code(state: ReviewState) -> dict:
        attempt = state.get("attempt", 0) + 1
        code = f"def hello(): print('Hello v{attempt}')"
        print(f"  [写代码] 第 {attempt} 次尝试")
        return {"code": code, "attempt": attempt}

    def review_code(state: ReviewState) -> dict:
        # 模拟：前两次审核不通过，第三次通过
        if state["attempt"] < 3:
            print(f"  [审核] ❌ 不通过（第 {state['attempt']} 次）")
            return {"review_result": "rejected"}
        else:
            print(f"  [审核] ✅ 通过！")
            return {"review_result": "approved"}

    # ⭐ 条件边的路由函数
    def should_continue(state: ReviewState) -> str:
        if state["review_result"] == "approved":
            return "end"
        elif state["attempt"] >= 5:
            return "end"    # 防止无限循环
        else:
            return "rewrite"

    graph = StateGraph(ReviewState)

    graph.add_node("write", write_code)
    graph.add_node("review", review_code)

    graph.add_edge(START, "write")
    graph.add_edge("write", "review")

    # ⭐ 条件边：根据审核结果决定下一步
    graph.add_conditional_edges(
        "review",                          # 从哪个节点出发
        should_continue,                   # 路由函数
        {
            "rewrite": "write",            # 路由值 → 目标节点
            "end": END,
        }
    )

    app = graph.compile()
    result = app.invoke({"code": "", "review_result": "", "attempt": 0})
    print(f"  最终: 第 {result['attempt']} 次通过审核")


# ───────────────────────────────────────────────────────────────
# 3. LangGraph ReAct Agent
# ───────────────────────────────────────────────────────────────
def demo_react_agent():
    print("\n══════ 3. ReAct Agent ══════")

    from langgraph.prebuilt import create_react_agent
    from langchain_openai import ChatOpenAI
    from langchain_core.tools import tool

    @tool
    def search(query: str) -> str:
        """搜索知识库"""
        data = {
            "langchain": "LangChain 是 LLM 应用开发框架",
            "langgraph": "LangGraph 是基于图的 Agent 编排框架",
            "python": "Python 是最流行的 AI 编程语言",
        }
        for key, val in data.items():
            if key in query.lower():
                return val
        return f"没有找到关于 '{query}' 的信息"

    @tool
    def calculator(expression: str) -> str:
        """计算数学表达式"""
        try:
            return str(eval(expression, {"__builtins__": {}}))
        except:
            return "计算失败"

    # ⭐ 一行创建 ReAct Agent（LangGraph 版）
    agent = create_react_agent(
        ChatOpenAI(model="gpt-4o-mini", temperature=0),
        [search, calculator],
    )

    # 执行
    result = agent.invoke({
        "messages": [("human", "LangGraph 是什么？然后算 42 * 58")]
    })

    # 打印对话过程
    for msg in result["messages"]:
        role = type(msg).__name__
        if hasattr(msg, 'content') and msg.content:
            print(f"  [{role}] {str(msg.content)[:80]}")
        if hasattr(msg, 'tool_calls') and msg.tool_calls:
            for tc in msg.tool_calls:
                print(f"  [工具调用] {tc['name']}({tc['args']})")


# ───────────────────────────────────────────────────────────────
# 4. 状态 Annotation（Reducer 模式）
# ───────────────────────────────────────────────────────────────
def demo_annotation():
    print("\n══════ 4. Annotation 与 Reducer ══════")

    from langgraph.graph import StateGraph, START, END
    from typing import Annotated
    import operator

    # ⭐ Annotated + operator.add = 自动追加而不是覆盖
    class ChatState:
        messages: Annotated[list[str], operator.add]
        # 每个节点返回的 messages 会自动追加到列表，而不是替换

    info = """
    # Reducer 模式
    # 默认行为：节点返回的值会覆盖 state 中的对应字段
    # 使用 Annotated[type, reducer_fn] 可以自定义合并逻辑

    from typing import Annotated
    import operator

    class State(TypedDict):
        # 追加模式：每个节点的 messages 追加到列表
        messages: Annotated[list, operator.add]

        # 覆盖模式（默认）：每个节点的 count 覆盖旧值
        count: int

    # operator.add 用于列表：list1 + list2 = 合并列表
    # 也可以自定义：Annotated[int, lambda a, b: a + b]  # 累加

    # ⭐ 这就是 LangGraph 内置的 MessagesState 的原理：
    from langgraph.graph import MessagesState
    # 等价于: class MessagesState(TypedDict):
    #           messages: Annotated[list[AnyMessage], add_messages]
    """
    print(info)


# ───────────────────────────────────────────────────────────────
# 5. LangGraph 概念总结
# ───────────────────────────────────────────────────────────────
def demo_summary():
    print("══════ 5. LangGraph 概念总结 ══════")

    summary = """
    ┌──────────────────────────────────────────────────────────┐
    │                  LangGraph 核心概念                       │
    ├──────────────────────────────────────────────────────────┤
    │                                                          │
    │  State（状态）                                            │
    │    TypedDict，贯穿整个图的数据容器                        │
    │    节点读取和更新 state                                   │
    │                                                          │
    │  Node（节点）                                             │
    │    处理函数，接收 state 返回更新                           │
    │    可以是普通函数或 Runnable                              │
    │                                                          │
    │  Edge（边）                                               │
    │    连接节点，定义执行顺序                                  │
    │    普通边：A → B                                         │
    │    条件边：A → 路由函数 → B 或 C                          │
    │                                                          │
    │  Checkpointer（检查点）                                   │
    │    持久化 state，支持中断恢复                              │
    │    MemorySaver（内存）、SqliteSaver（SQLite）              │
    │                                                          │
    │  Human-in-the-loop（人机交互）                             │
    │    interrupt_before / interrupt_after                     │
    │    在关键节点暂停，等待人工审核                            │
    │                                                          │
    └──────────────────────────────────────────────────────────┘

    ⭐ 何时用 LangGraph vs AgentExecutor：
    - 简单 Agent（1-2 个工具，线性推理）→ AgentExecutor
    - 复杂 Agent（多步骤、条件分支、循环、人工审核）→ LangGraph
    - 多 Agent 协作 → LangGraph
    - 需要状态持久化 → LangGraph
    """
    print(summary)


if __name__ == "__main__":
    demo_basic_graph()
    demo_conditional_edge()
    demo_react_agent()
    demo_annotation()
    demo_summary()
