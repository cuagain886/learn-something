"""
═══════════════════════════════════════════════════════════════════
 12_map_reduce —— 并行执行与 Map-Reduce
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. Send API：动态并行
  2. 扇出-汇聚模式（Fan-out / Fan-in）
  3. Map-Reduce 模式
  4. 并行节点（多出边）

【并行的价值】
  - 多个独立任务同时执行，减少总耗时
  - 对多个文档同时处理
  - 多个 Agent 同时工作
  - 从多个来源并行获取数据

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. 静态并行（多出边）
# ───────────────────────────────────────────────────────────────
def demo_static_parallel():
    print("══════ 1. 静态并行 ══════")

    from langgraph.graph import StateGraph, START, END
    from typing import TypedDict, Annotated
    import operator

    class State(TypedDict):
        topic: str
        results: Annotated[list[str], operator.add]

    def search_web(state: State) -> dict:
        return {"results": [f"[网页搜索] {state['topic']} 的结果"]}

    def search_docs(state: State) -> dict:
        return {"results": [f"[文档搜索] {state['topic']} 的结果"]}

    def search_db(state: State) -> dict:
        return {"results": [f"[数据库] {state['topic']} 的结果"]}

    def aggregate(state: State) -> dict:
        summary = f"综合 {len(state['results'])} 个来源的结果"
        return {"results": [summary]}

    graph = StateGraph(State)
    graph.add_node("web", search_web)
    graph.add_node("docs", search_docs)
    graph.add_node("db", search_db)
    graph.add_node("aggregate", aggregate)

    # ⭐ START 到多个节点 = 并行执行
    graph.add_edge(START, "web")
    graph.add_edge(START, "docs")
    graph.add_edge(START, "db")

    # 汇聚到 aggregate
    graph.add_edge("web", "aggregate")
    graph.add_edge("docs", "aggregate")
    graph.add_edge("db", "aggregate")
    graph.add_edge("aggregate", END)

    app = graph.compile()
    result = app.invoke({"topic": "LangGraph", "results": []})

    print("  并行搜索结果:")
    for r in result["results"]:
        print(f"    {r}")


# ───────────────────────────────────────────────────────────────
# 2. Send API 动态并行
# ───────────────────────────────────────────────────────────────
def demo_send_api():
    print("\n══════ 2. Send API 动态并行 ══════")

    from langgraph.graph import StateGraph, START, END
    from langgraph.types import Send
    from typing import TypedDict, Annotated
    import operator

    class OverallState(TypedDict):
        topics: list[str]
        summaries: Annotated[list[str], operator.add]

    class TopicState(TypedDict):
        topic: str

    # ⭐ 对每个 topic 并行执行的节点
    def summarize_topic(state: TopicState) -> dict:
        return {"summaries": [f"关于 '{state['topic']}' 的总结"]}

    def collect_results(state: OverallState) -> dict:
        return {"summaries": [f"=== 共收集 {len(state['summaries'])} 个总结 ==="]}

    # ⭐ 动态生成并行任务
    def fan_out(state: OverallState):
        # 返回 Send 列表，每个 Send 创建一个并行任务
        return [
            Send("summarize", {"topic": topic})
            for topic in state["topics"]
        ]

    graph = StateGraph(OverallState)
    graph.add_node("summarize", summarize_topic)
    graph.add_node("collect", collect_results)

    # ⭐ 条件边返回 Send 列表 → 动态并行
    graph.add_conditional_edges(START, fan_out, ["summarize"])
    graph.add_edge("summarize", "collect")
    graph.add_edge("collect", END)

    app = graph.compile()

    result = app.invoke({
        "topics": ["LangGraph", "LangChain", "RAG", "Agent"],
        "summaries": [],
    })

    print("  动态并行结果:")
    for s in result["summaries"]:
        print(f"    {s}")


# ───────────────────────────────────────────────────────────────
# 3. Map-Reduce 模式
# ───────────────────────────────────────────────────────────────
def demo_map_reduce():
    print("\n══════ 3. Map-Reduce ══════")

    from langgraph.graph import StateGraph, START, END
    from langgraph.types import Send
    from typing import TypedDict, Annotated
    import operator

    # ⭐ 典型场景：处理多个文档

    class OverallState(TypedDict):
        documents: list[str]
        analyses: Annotated[list[dict], operator.add]
        final_report: str

    class DocState(TypedDict):
        document: str

    # Map: 对每个文档独立分析
    def analyze_document(state: DocState) -> dict:
        doc = state["document"]
        analysis = {
            "doc": doc[:20],
            "word_count": len(doc.split()),
            "sentiment": "positive" if "好" in doc else "neutral",
        }
        return {"analyses": [analysis]}

    # 动态分发
    def distribute_docs(state: OverallState):
        return [
            Send("analyze", {"document": doc})
            for doc in state["documents"]
        ]

    # Reduce: 汇总所有分析
    def generate_report(state: OverallState) -> dict:
        total_docs = len(state["analyses"])
        total_words = sum(a["word_count"] for a in state["analyses"])

        report = f"分析报告：共 {total_docs} 篇文档，"
        report += f"共 {total_words} 词，"
        sentiments = [a["sentiment"] for a in state["analyses"]]
        report += f"情感分布: {dict((s, sentiments.count(s)) for s in set(sentiments))}"

        return {"final_report": report}

    graph = StateGraph(OverallState)
    graph.add_node("analyze", analyze_document)
    graph.add_node("report", generate_report)

    graph.add_conditional_edges(START, distribute_docs, ["analyze"])
    graph.add_edge("analyze", "report")
    graph.add_edge("report", END)

    app = graph.compile()

    result = app.invoke({
        "documents": [
            "这个产品非常好用，体验很棒",
            "功能还可以，但界面需要改进",
            "价格偏高，但质量好",
            "整体满意，推荐购买",
        ],
        "analyses": [],
        "final_report": "",
    })

    print(f"  {result['final_report']}")
    print(f"\n  各文档分析:")
    for a in result["analyses"]:
        print(f"    {a}")


# ───────────────────────────────────────────────────────────────
# 4. 模式总结
# ───────────────────────────────────────────────────────────────
def demo_summary():
    print("\n══════ 4. 并行模式总结 ══════")

    summary = """
    ┌──────────────────────────────────────────────────────────┐
    │  模式              实现方式              适用场景          │
    ├──────────────────────────────────────────────────────────┤
    │                                                          │
    │  静态并行           多条 add_edge        并行数固定       │
    │  START → A                              多个已知数据源    │
    │  START → B                                               │
    │                                                          │
    │  动态并行           Send API             并行数不固定     │
    │  fan_out →                              批量处理文档      │
    │    Send("node", state1)                                  │
    │    Send("node", state2)                                  │
    │                                                          │
    │  Map-Reduce         Send + 汇聚节点     批量分析+汇总    │
    │  分发 → 并行处理 → 汇总                  评审/评分/分析   │
    │                                                          │
    └──────────────────────────────────────────────────────────┘

    ⭐ 注意事项：
    1. 并行节点写同一字段必须用 Reducer（Annotated[list, operator.add]）
    2. Send 的第二个参数是该节点独立的输入 state
    3. 并行任务间不能直接通信，只能通过汇聚节点交汇
    4. 并行不一定更快——受限于 API 并发限制
    """
    print(summary)


if __name__ == "__main__":
    demo_static_parallel()
    demo_send_api()
    demo_map_reduce()
    demo_summary()
