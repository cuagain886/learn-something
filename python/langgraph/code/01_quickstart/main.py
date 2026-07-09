"""
═══════════════════════════════════════════════════════════════════
 01_quickstart —— LangGraph 快速上手
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. LangGraph 是什么、解决什么问题
  2. StateGraph 的三要素：State / Node / Edge
  3. 第一个图的构建与执行
  4. 图的编译与可视化
  5. invoke / stream 两种执行方式

【LangGraph vs LangChain LCEL】
  LCEL：线性管道 A | B | C，数据单向流动
  LangGraph：有向图，支持循环、条件分支、并行

  什么时候从 LCEL 升级到 LangGraph？
  - 需要条件判断（根据结果走不同路径）
  - 需要循环（重试、自我纠正）
  - 需要人工介入（审核节点）
  - 需要状态持久化（中断恢复）
  - 多 Agent 协作

【安装】
  pip install langgraph langchain-openai python-dotenv

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. 最小的 StateGraph
# ───────────────────────────────────────────────────────────────
def demo_minimal():
    print("══════ 1. 最小的 StateGraph ══════")

    from langgraph.graph import StateGraph, START, END
    from typing import TypedDict

    # ⭐ 步骤一：定义 State（贯穿整个图的数据结构）
    class State(TypedDict):
        message: str
        count: int

    # ⭐ 步骤二：定义 Node（处理函数）
    # 每个节点接收完整 state，返回要更新的字段
    def greet(state: State) -> dict:
        return {"message": f"你好！你说的是：{state['message']}"}

    def count_chars(state: State) -> dict:
        return {"count": len(state["message"])}

    # ⭐ 步骤三：构建图
    graph = StateGraph(State)

    # 添加节点
    graph.add_node("greet", greet)
    graph.add_node("count", count_chars)

    # 添加边（执行顺序）
    graph.add_edge(START, "greet")       # 入口 → greet
    graph.add_edge("greet", "count")     # greet → count
    graph.add_edge("count", END)         # count → 结束

    # ⭐ 编译图（得到可执行的 app）
    app = graph.compile()

    # 执行
    result = app.invoke({"message": "LangGraph", "count": 0})
    print(f"  消息: {result['message']}")
    print(f"  字数: {result['count']}")


# ───────────────────────────────────────────────────────────────
# 2. 图的可视化
# ───────────────────────────────────────────────────────────────
def demo_visualization():
    print("\n══════ 2. 图的可视化 ══════")

    from langgraph.graph import StateGraph, START, END
    from typing import TypedDict

    class State(TypedDict):
        value: str

    def step_a(state: State) -> dict:
        return {"value": state["value"] + " → A"}

    def step_b(state: State) -> dict:
        return {"value": state["value"] + " → B"}

    graph = StateGraph(State)
    graph.add_node("a", step_a)
    graph.add_node("b", step_b)
    graph.add_edge(START, "a")
    graph.add_edge("a", "b")
    graph.add_edge("b", END)

    app = graph.compile()

    # ASCII 图
    print("  ASCII 图:")
    print(f"  {app.get_graph().draw_ascii()}")

    # Mermaid 图（可以粘贴到 https://mermaid.live 查看）
    print("\n  Mermaid 图:")
    print(f"  {app.get_graph().draw_mermaid()}")


# ───────────────────────────────────────────────────────────────
# 3. stream 执行方式
# ───────────────────────────────────────────────────────────────
def demo_stream():
    print("\n══════ 3. 流式执行 ══════")

    from langgraph.graph import StateGraph, START, END
    from typing import TypedDict

    class State(TypedDict):
        value: str
        steps: list[str]

    def step_1(state: State) -> dict:
        return {"steps": ["step_1 完成"]}

    def step_2(state: State) -> dict:
        return {"steps": ["step_2 完成"]}

    def step_3(state: State) -> dict:
        return {
            "value": f"处理完毕: {state['value']}",
            "steps": ["step_3 完成"],
        }

    graph = StateGraph(State)
    graph.add_node("step_1", step_1)
    graph.add_node("step_2", step_2)
    graph.add_node("step_3", step_3)
    graph.add_edge(START, "step_1")
    graph.add_edge("step_1", "step_2")
    graph.add_edge("step_2", "step_3")
    graph.add_edge("step_3", END)

    app = graph.compile()

    # ⭐ stream：逐节点输出，可以观察每一步的状态变化
    print("  逐节点流式输出:")
    for event in app.stream({"value": "hello", "steps": []}):
        # event 是 dict，key 是节点名，value 是该节点的输出
        node_name = list(event.keys())[0]
        node_output = event[node_name]
        print(f"    [{node_name}] {node_output}")

    # ⭐ stream_mode 选项：
    # "values"  → 每步输出完整的 state（默认）
    # "updates" → 每步只输出变化的部分
    # "debug"   → 包含详细的调试信息

    print("\n  values 模式（完整 state）:")
    for state in app.stream({"value": "hello", "steps": []}, stream_mode="values"):
        print(f"    steps={state.get('steps', [])}")


# ───────────────────────────────────────────────────────────────
# 4. 核心概念总结
# ───────────────────────────────────────────────────────────────
def demo_concepts():
    print("\n══════ 4. 核心概念 ══════")

    concepts = """
    ┌──────────────────────────────────────────────────────────┐
    │               LangGraph 核心概念                          │
    ├──────────────────────────────────────────────────────────┤
    │                                                          │
    │  State（状态）                                            │
    │    TypedDict，图执行期间的共享数据容器                      │
    │    每个节点读取 state，返回要更新的字段                      │
    │                                                          │
    │  Node（节点）                                             │
    │    处理函数：def node(state) -> dict                      │
    │    可以是普通函数、Runnable、子图                           │
    │                                                          │
    │  Edge（边）                                               │
    │    add_edge(A, B)：A 执行后执行 B                         │
    │    add_conditional_edges(A, fn, mapping)：动态路由        │
    │                                                          │
    │  START / END                                             │
    │    特殊节点：图的入口和出口                                 │
    │                                                          │
    │  compile()                                               │
    │    编译图为可执行的 CompiledGraph（Runnable）              │
    │    可以传入 checkpointer、interrupt_before 等参数          │
    │                                                          │
    │  invoke(input) / stream(input)                           │
    │    invoke：运行完返回最终 state                            │
    │    stream：逐节点返回中间 state                            │
    │                                                          │
    └──────────────────────────────────────────────────────────┘
    """
    print(concepts)


if __name__ == "__main__":
    demo_minimal()
    demo_visualization()
    demo_stream()
    demo_concepts()
