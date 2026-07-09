"""
═══════════════════════════════════════════════════════════════════
 08_subgraph —— 子图与模块化
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. 子图的概念与用途
  2. 将子图作为节点嵌入主图
  3. 子图与主图的状态传递
  4. 可复用的子图模块

【为什么需要子图】
  - 复杂图太大 → 拆分为可管理的模块
  - 复用 → 同一个子图在多处使用
  - 团队协作 → 不同人负责不同子图
  - 测试 → 子图可以独立测试

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. 子图作为节点
# ───────────────────────────────────────────────────────────────
def demo_subgraph_as_node():
    print("══════ 1. 子图作为节点 ══════")

    from langgraph.graph import StateGraph, START, END
    from typing import TypedDict, Annotated
    import operator

    class State(TypedDict):
        topic: str
        research: str
        article: str
        log: Annotated[list[str], operator.add]

    # ── 定义研究子图 ──
    def search_web(state: State) -> dict:
        return {
            "research": f"搜索结果：关于 {state['topic']} 的三个要点...",
            "log": ["[研究] 搜索完成"],
        }

    def summarize(state: State) -> dict:
        return {
            "research": f"摘要：{state['research'][:30]}（已总结）",
            "log": ["[研究] 总结完成"],
        }

    research_graph = StateGraph(State)
    research_graph.add_node("search", search_web)
    research_graph.add_node("summarize", summarize)
    research_graph.add_edge(START, "search")
    research_graph.add_edge("search", "summarize")
    research_graph.add_edge("summarize", END)
    research_subgraph = research_graph.compile()

    # ── 定义写作节点 ──
    def write_article(state: State) -> dict:
        return {
            "article": f"基于研究'{state['research'][:20]}...'写的文章",
            "log": ["[写作] 文章完成"],
        }

    # ── 主图：嵌入子图 ──
    main_graph = StateGraph(State)
    main_graph.add_node("research", research_subgraph)  # ⭐ 子图作为节点
    main_graph.add_node("write", write_article)
    main_graph.add_edge(START, "research")
    main_graph.add_edge("research", "write")
    main_graph.add_edge("write", END)

    app = main_graph.compile()

    result = app.invoke({
        "topic": "LangGraph",
        "research": "",
        "article": "",
        "log": [],
    })

    print(f"  研究: {result['research'][:50]}")
    print(f"  文章: {result['article'][:50]}")
    print(f"  日志: {result['log']}")


# ───────────────────────────────────────────────────────────────
# 2. 不同 State 的子图
# ───────────────────────────────────────────────────────────────
def demo_different_states():
    print("\n══════ 2. 不同 State 的子图 ══════")

    from langgraph.graph import StateGraph, START, END
    from typing import TypedDict

    # 子图有自己的 state 结构
    class InnerState(TypedDict):
        data: str
        processed: bool

    def process(state: InnerState) -> dict:
        return {
            "data": state["data"].upper(),
            "processed": True,
        }

    inner_graph = StateGraph(InnerState)
    inner_graph.add_node("process", process)
    inner_graph.add_edge(START, "process")
    inner_graph.add_edge("process", END)
    inner_compiled = inner_graph.compile()

    # 主图的 state
    class OuterState(TypedDict):
        input_text: str
        result: str

    # ⭐ 转换函数：主图 state ↔ 子图 state
    def call_subgraph(state: OuterState) -> dict:
        # 主图 → 子图
        inner_input = {"data": state["input_text"], "processed": False}
        inner_result = inner_compiled.invoke(inner_input)
        # 子图 → 主图
        return {"result": inner_result["data"]}

    outer_graph = StateGraph(OuterState)
    outer_graph.add_node("process", call_subgraph)
    outer_graph.add_edge(START, "process")
    outer_graph.add_edge("process", END)

    app = outer_graph.compile()
    result = app.invoke({"input_text": "hello langgraph", "result": ""})
    print(f"  输入: hello langgraph")
    print(f"  输出: {result['result']}")


# ───────────────────────────────────────────────────────────────
# 3. 可复用的子图模块
# ───────────────────────────────────────────────────────────────
def demo_reusable():
    print("\n══════ 3. 可复用子图 ══════")

    from langgraph.graph import StateGraph, START, END
    from typing import TypedDict, Annotated
    import operator

    class PipelineState(TypedDict):
        text: str
        steps: Annotated[list[str], operator.add]

    # ⭐ 子图工厂函数：参数化创建子图
    def create_validation_subgraph(rules: list[str]):
        """创建可配置的验证子图"""

        def validate(state: PipelineState) -> dict:
            errors = []
            for rule in rules:
                if rule == "non_empty" and not state["text"].strip():
                    errors.append("文本不能为空")
                elif rule == "min_length" and len(state["text"]) < 10:
                    errors.append("文本太短（至少10字符）")
                elif rule == "no_special" and any(c in state["text"] for c in "!@#$"):
                    errors.append("不能包含特殊字符")

            status = "验证通过" if not errors else f"验证失败: {errors}"
            return {"steps": [f"[验证] {status}"]}

        g = StateGraph(PipelineState)
        g.add_node("validate", validate)
        g.add_edge(START, "validate")
        g.add_edge("validate", END)
        return g.compile()

    # 创建不同配置的验证器
    strict_validator = create_validation_subgraph(["non_empty", "min_length", "no_special"])
    loose_validator = create_validation_subgraph(["non_empty"])

    # 在主图中复用
    def transform(state: PipelineState) -> dict:
        return {
            "text": state["text"].strip().title(),
            "steps": ["[转换] 完成"],
        }

    main = StateGraph(PipelineState)
    main.add_node("validate", strict_validator)  # 可以换成 loose_validator
    main.add_node("transform", transform)
    main.add_edge(START, "validate")
    main.add_edge("validate", "transform")
    main.add_edge("transform", END)

    app = main.compile()

    for text in ["hello world, this is a test", "hi", ""]:
        result = app.invoke({"text": text, "steps": []})
        print(f"  输入: '{text}'")
        print(f"  步骤: {result['steps']}")
        print()


if __name__ == "__main__":
    demo_subgraph_as_node()
    demo_different_states()
    demo_reusable()
