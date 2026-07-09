"""
═══════════════════════════════════════════════════════════════════
 02_state_reducer —— State 设计与 Reducer 模式
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. State 的字段更新机制（覆盖 vs 累积）
  2. Annotated + Reducer 自定义合并逻辑
  3. MessagesState（内置的对话状态）
  4. add_messages reducer 的智能行为
  5. State 设计最佳实践

【核心问题】
  多个节点修改同一个 state 字段时，值是覆盖还是追加？
  默认是覆盖——后执行的节点覆盖前面的值。
  用 Annotated[type, reducer] 可以自定义合并逻辑。

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. 默认行为：覆盖
# ───────────────────────────────────────────────────────────────
def demo_overwrite():
    print("══════ 1. 默认行为：覆盖 ══════")

    from langgraph.graph import StateGraph, START, END
    from typing import TypedDict

    class State(TypedDict):
        value: str     # 默认：后写入的覆盖前面的

    def node_a(state: State) -> dict:
        return {"value": "A wrote this"}

    def node_b(state: State) -> dict:
        return {"value": "B overwrote this"}  # 覆盖 A 的值

    graph = StateGraph(State)
    graph.add_node("a", node_a)
    graph.add_node("b", node_b)
    graph.add_edge(START, "a")
    graph.add_edge("a", "b")
    graph.add_edge("b", END)

    result = graph.compile().invoke({"value": ""})
    print(f"  最终值: {result['value']}")  # "B overwrote this"
    # ⚠️ A 的值被 B 覆盖了


# ───────────────────────────────────────────────────────────────
# 2. Reducer 模式：累积
# ───────────────────────────────────────────────────────────────
def demo_reducer():
    print("\n══════ 2. Reducer 模式 ══════")

    from langgraph.graph import StateGraph, START, END
    from typing import TypedDict, Annotated
    import operator

    class State(TypedDict):
        # ⭐ Annotated[type, reducer_fn]
        # operator.add 对 list：列表追加
        messages: Annotated[list[str], operator.add]
        # 普通字段：覆盖
        count: int

    def node_a(state: State) -> dict:
        return {
            "messages": ["A: 你好"],    # 追加到列表
            "count": 1,                 # 覆盖
        }

    def node_b(state: State) -> dict:
        return {
            "messages": ["B: 再见"],    # 继续追加
            "count": 2,                 # 覆盖为 2
        }

    graph = StateGraph(State)
    graph.add_node("a", node_a)
    graph.add_node("b", node_b)
    graph.add_edge(START, "a")
    graph.add_edge("a", "b")
    graph.add_edge("b", END)

    result = graph.compile().invoke({"messages": [], "count": 0})
    print(f"  messages: {result['messages']}")  # ["A: 你好", "B: 再见"]
    print(f"  count: {result['count']}")        # 2


# ───────────────────────────────────────────────────────────────
# 3. 自定义 Reducer
# ───────────────────────────────────────────────────────────────
def demo_custom_reducer():
    print("\n══════ 3. 自定义 Reducer ══════")

    from langgraph.graph import StateGraph, START, END
    from typing import TypedDict, Annotated

    # ⭐ Reducer 就是一个二参数函数：(current_value, new_value) -> merged_value
    def keep_max(current: int, new: int) -> int:
        """保留最大值"""
        return max(current, new)

    def merge_dicts(current: dict, new: dict) -> dict:
        """深度合并字典"""
        merged = {**current, **new}
        return merged

    def dedup_list(current: list, new: list) -> list:
        """去重追加"""
        seen = set(current)
        result = list(current)
        for item in new:
            if item not in seen:
                result.append(item)
                seen.add(item)
        return result

    class State(TypedDict):
        max_score: Annotated[int, keep_max]
        metadata: Annotated[dict, merge_dicts]
        tags: Annotated[list[str], dedup_list]

    def scorer_a(state: State) -> dict:
        return {
            "max_score": 85,
            "metadata": {"model": "gpt-4o"},
            "tags": ["rag", "search"],
        }

    def scorer_b(state: State) -> dict:
        return {
            "max_score": 92,
            "metadata": {"temperature": 0},
            "tags": ["search", "agent"],   # "search" 已存在，会去重
        }

    graph = StateGraph(State)
    graph.add_node("a", scorer_a)
    graph.add_node("b", scorer_b)
    graph.add_edge(START, "a")
    graph.add_edge("a", "b")
    graph.add_edge("b", END)

    result = graph.compile().invoke({
        "max_score": 0, "metadata": {}, "tags": []
    })
    print(f"  max_score: {result['max_score']}")  # 92
    print(f"  metadata: {result['metadata']}")     # {"model": "gpt-4o", "temperature": 0}
    print(f"  tags: {result['tags']}")              # ["rag", "search", "agent"]


# ───────────────────────────────────────────────────────────────
# 4. MessagesState（内置对话状态）
# ───────────────────────────────────────────────────────────────
def demo_messages_state():
    print("\n══════ 4. MessagesState ══════")

    from langgraph.graph import StateGraph, START, END, MessagesState
    from langchain_core.messages import HumanMessage, AIMessage, RemoveMessage

    # ⭐ MessagesState 等价于：
    # class MessagesState(TypedDict):
    #     messages: Annotated[list[AnyMessage], add_messages]
    #
    # add_messages 比 operator.add 更智能：
    # 1. 自动根据 message.id 去重
    # 2. 相同 id 的消息会更新而不是追加
    # 3. 支持 RemoveMessage 删除指定消息

    def user_turn(state: MessagesState) -> dict:
        return {"messages": [HumanMessage(content="什么是 LangGraph？")]}

    def ai_turn(state: MessagesState) -> dict:
        # 模拟 AI 回复
        return {"messages": [AIMessage(content="LangGraph 是基于图的 Agent 框架。")]}

    graph = StateGraph(MessagesState)
    graph.add_node("user", user_turn)
    graph.add_node("ai", ai_turn)
    graph.add_edge(START, "user")
    graph.add_edge("user", "ai")
    graph.add_edge("ai", END)

    result = graph.compile().invoke({"messages": []})

    for msg in result["messages"]:
        role = "用户" if isinstance(msg, HumanMessage) else "AI"
        print(f"  [{role}] {msg.content}")

    # ⭐ RemoveMessage 演示
    print("\n  RemoveMessage 用法（示意）:")
    print("  返回 RemoveMessage(id=msg.id) 可以从历史中删除指定消息")
    print("  常用于：裁剪过长的对话历史，只保留最近 N 条")


# ───────────────────────────────────────────────────────────────
# 5. 扩展 MessagesState
# ───────────────────────────────────────────────────────────────
def demo_extended_state():
    print("\n══════ 5. 扩展 MessagesState ══════")

    from langgraph.graph import MessagesState
    from typing import Annotated
    import operator

    # ⭐ 可以在 MessagesState 基础上添加自定义字段
    class AgentState(MessagesState):
        # 继承了 messages: Annotated[list, add_messages]
        current_tool: str                                   # 覆盖模式
        tool_results: Annotated[list[str], operator.add]    # 追加模式
        iteration: int                                      # 覆盖模式

    # 这是最常见的 Agent 状态设计：
    # messages 记录对话历史
    # 额外字段记录 Agent 的工作状态

    print("  AgentState 字段:")
    print("    messages:     对话历史（add_messages reducer）")
    print("    current_tool: 当前使用的工具（覆盖）")
    print("    tool_results: 工具返回结果（追加）")
    print("    iteration:    当前迭代轮次（覆盖）")


# ───────────────────────────────────────────────────────────────
# 6. State 设计最佳实践
# ───────────────────────────────────────────────────────────────
def demo_best_practices():
    print("\n══════ 6. State 设计最佳实践 ══════")

    tips = """
    ⭐ State 设计原则：

    1. 最小化——只放节点间需要共享的数据
       ✓ messages, current_step, result
       ✗ 把所有临时变量都塞进 state

    2. 明确选择 Reducer
       - 需要历史记录 → Annotated[list, operator.add]
       - 只要最新值 → 普通字段（覆盖）
       - 对话消息 → 用 MessagesState（add_messages）

    3. 不要在节点中修改可变对象
       ✗ state["list"].append(x)  # 直接修改
       ✓ return {"list": [x]}     # 返回新值，让 reducer 处理

    4. 类型标注完整
       - 用 TypedDict + type hints
       - 方便 IDE 提示和 LangSmith 追踪

    ⚠️ 常见陷阱：

    1. 忘记设置 reducer → 多节点写同一字段时只有最后一个生效
    2. operator.add 对 int 是相加（不是追加）
       Annotated[int, operator.add] → 1 + 2 = 3
       如果想追加到列表，类型必须是 list
    3. 初始值不能省 → invoke({}) 时缺少字段会报错
    """
    print(tips)


if __name__ == "__main__":
    demo_overwrite()
    demo_reducer()
    demo_custom_reducer()
    demo_messages_state()
    demo_extended_state()
    demo_best_practices()
