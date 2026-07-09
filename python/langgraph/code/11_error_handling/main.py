"""
═══════════════════════════════════════════════════════════════════
 11_error_handling —— 错误处理与容错
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. 节点级错误处理
  2. 重试策略（retry_policy）
  3. 工具错误处理
  4. Fallback 模式
  5. 超时与递归限制

【为什么 Agent 需要容错】
  Agent 系统的错误来源：
  - LLM API 暂时不可用（429/500）
  - 工具执行失败（网络、权限、格式错误）
  - LLM 输出格式不对（解析失败）
  - 无限循环（Agent 陷入死循环）

  不做错误处理的 Agent 一次失败就整个崩溃。

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. 节点级错误处理
# ───────────────────────────────────────────────────────────────
def demo_node_error_handling():
    print("══════ 1. 节点级错误处理 ══════")

    from langgraph.graph import StateGraph, START, END
    from typing import TypedDict

    class State(TypedDict):
        input: str
        result: str
        error: str

    def risky_operation(state: State) -> dict:
        """可能失败的操作"""
        try:
            # 模拟：输入为空时失败
            if not state["input"].strip():
                raise ValueError("输入不能为空")
            return {"result": f"成功处理: {state['input']}", "error": ""}
        except Exception as e:
            return {"result": "", "error": str(e)}

    def handle_result(state: State) -> dict:
        if state["error"]:
            return {"result": f"操作失败: {state['error']}，使用默认值"}
        return {}

    graph = StateGraph(State)
    graph.add_node("process", risky_operation)
    graph.add_node("handle", handle_result)
    graph.add_edge(START, "process")
    graph.add_edge("process", "handle")
    graph.add_edge("handle", END)

    app = graph.compile()

    for inp in ["hello", "", "world"]:
        result = app.invoke({"input": inp, "result": "", "error": ""})
        print(f"  输入: '{inp}' → {result['result']}")


# ───────────────────────────────────────────────────────────────
# 2. 重试策略
# ───────────────────────────────────────────────────────────────
def demo_retry():
    print("\n══════ 2. 重试策略 ══════")

    from langgraph.graph import StateGraph, START, END
    from typing import TypedDict
    import random

    class State(TypedDict):
        data: str
        attempt: int

    call_count = 0

    def unreliable_api(state: State) -> dict:
        """模拟不稳定的 API：前两次失败，第三次成功"""
        nonlocal call_count
        call_count += 1
        print(f"    第 {call_count} 次调用...")

        if call_count < 3:
            raise Exception(f"API 错误（第 {call_count} 次）")

        return {"data": "API 返回成功！"}

    # ⭐ 用 try/except + 循环实现重试
    def api_with_retry(state: State) -> dict:
        max_retries = 5
        for i in range(max_retries):
            try:
                return unreliable_api(state)
            except Exception as e:
                print(f"    重试 {i+1}/{max_retries}: {e}")
                if i == max_retries - 1:
                    return {"data": f"最终失败: {e}"}
        return {"data": "不应到达这里"}

    graph = StateGraph(State)
    graph.add_node("api", api_with_retry)
    graph.add_edge(START, "api")
    graph.add_edge("api", END)

    app = graph.compile()
    result = app.invoke({"data": "", "attempt": 0})
    print(f"  结果: {result['data']}")


# ───────────────────────────────────────────────────────────────
# 3. LangChain Retry / Fallback
# ───────────────────────────────────────────────────────────────
def demo_langchain_retry():
    print("\n══════ 3. LangChain 重试与 Fallback ══════")

    info = """
    from langchain_openai import ChatOpenAI

    # ⭐ 方法 1：with_retry（自动重试）
    llm = ChatOpenAI(model="gpt-4o-mini")
    reliable_llm = llm.with_retry(
        stop_after_attempt=3,      # 最多重试 3 次
        wait_exponential_jitter=True,  # 指数退避 + 抖动
    )

    # ⭐ 方法 2：with_fallbacks（降级）
    primary = ChatOpenAI(model="gpt-4o")
    backup = ChatOpenAI(model="gpt-4o-mini")

    llm_with_fallback = primary.with_fallbacks([backup])
    # gpt-4o 失败 → 自动切换到 gpt-4o-mini

    # ⭐ 方法 3：组合
    robust_llm = (
        ChatOpenAI(model="gpt-4o")
        .with_retry(stop_after_attempt=2)
        .with_fallbacks([
            ChatOpenAI(model="gpt-4o-mini")
            .with_retry(stop_after_attempt=3)
        ])
    )
    # gpt-4o 重试2次 → 失败 → gpt-4o-mini 重试3次
    """
    print(info)


# ───────────────────────────────────────────────────────────────
# 4. 工具错误处理
# ───────────────────────────────────────────────────────────────
def demo_tool_errors():
    print("══════ 4. 工具错误处理 ══════")

    from langgraph.graph import StateGraph, START, END, MessagesState
    from langgraph.prebuilt import ToolNode, tools_condition
    from langchain_openai import ChatOpenAI
    from langchain_core.tools import tool
    from langchain_core.messages import HumanMessage

    @tool
    def divide(a: float, b: float) -> str:
        """除法计算"""
        if b == 0:
            raise ValueError("除数不能为零！")
        return str(a / b)

    tools = [divide]

    # ⭐ handle_tool_errors=True：工具报错时返回错误消息，不崩溃
    tool_node = ToolNode(tools, handle_tool_errors=True)

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0).bind_tools(tools)

    def call_llm(state: MessagesState) -> dict:
        return {"messages": [llm.invoke(state["messages"])]}

    graph = StateGraph(MessagesState)
    graph.add_node("llm", call_llm)
    graph.add_node("tools", tool_node)
    graph.add_edge(START, "llm")
    graph.add_conditional_edges("llm", tools_condition)
    graph.add_edge("tools", "llm")

    app = graph.compile()

    # LLM 会尝试除以 0，工具报错后 LLM 看到错误信息并给出合理回复
    result = app.invoke({
        "messages": [HumanMessage(content="计算 10 除以 0")]
    })
    print(f"  AI: {result['messages'][-1].content[:100]}")


# ───────────────────────────────────────────────────────────────
# 5. 递归限制与超时
# ───────────────────────────────────────────────────────────────
def demo_limits():
    print("\n══════ 5. 递归限制与超时 ══════")

    from langgraph.graph import StateGraph, START, END
    from typing import TypedDict

    class State(TypedDict):
        count: int

    def increment(state: State) -> dict:
        return {"count": state["count"] + 1}

    def should_continue(state: State) -> str:
        return "continue" if state["count"] < 100 else "end"

    graph = StateGraph(State)
    graph.add_node("inc", increment)
    graph.add_conditional_edges("inc", should_continue, {
        "continue": "inc",
        "end": END,
    })
    graph.add_edge(START, "inc")

    app = graph.compile()

    # ⭐ 递归限制防止无限循环
    try:
        result = app.invoke(
            {"count": 0},
            config={"recursion_limit": 10},  # 最多 10 步
        )
    except Exception as e:
        print(f"  递归限制触发: {type(e).__name__}")
        print(f"  这防止了 Agent 无限循环")

    print("""
    ⭐ 防护措施总结：
    1. recursion_limit    → 限制最大步数（默认25）
    2. handle_tool_errors → 工具错误变成消息而非崩溃
    3. with_retry         → LLM API 调用自动重试
    4. with_fallbacks     → 主模型失败降级到备用模型
    5. try/except in node → 节点内部捕获并处理错误
    """)


if __name__ == "__main__":
    demo_node_error_handling()
    demo_retry()
    demo_langchain_retry()
    demo_tool_errors()
    demo_limits()
