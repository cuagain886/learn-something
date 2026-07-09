"""
═══════════════════════════════════════════════════════════════════
 03_conditional_edges —— 条件边与动态路由
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. add_conditional_edges 基本用法
  2. 路由函数的设计
  3. 循环图（重试/自我纠正）
  4. 多出口路由
  5. 图的终止条件

【条件边的意义】
  普通边 = 固定流程：A → B → C
  条件边 = 动态决策：A → 根据条件 → B 或 C 或 D
  这是 LangGraph 区别于 LCEL 的核心能力。

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. 基本条件路由
# ───────────────────────────────────────────────────────────────
def demo_basic_routing():
    print("══════ 1. 基本条件路由 ══════")

    from langgraph.graph import StateGraph, START, END
    from typing import TypedDict

    class State(TypedDict):
        query: str
        category: str
        answer: str

    def classify(state: State) -> dict:
        """分类器节点：判断查询类型"""
        q = state["query"].lower()
        if any(kw in q for kw in ["代码", "编程", "bug", "函数"]):
            return {"category": "tech"}
        elif any(kw in q for kw in ["天气", "温度", "下雨"]):
            return {"category": "weather"}
        return {"category": "general"}

    def tech_answer(state: State) -> dict:
        return {"answer": f"[技术专家] 关于'{state['query']}'的技术回答"}

    def weather_answer(state: State) -> dict:
        return {"answer": f"[天气助手] 关于'{state['query']}'的天气回答"}

    def general_answer(state: State) -> dict:
        return {"answer": f"[通用助手] 关于'{state['query']}'的回答"}

    # ⭐ 路由函数：返回字符串，决定走哪条边
    def route_by_category(state: State) -> str:
        return state["category"]

    graph = StateGraph(State)

    graph.add_node("classify", classify)
    graph.add_node("tech", tech_answer)
    graph.add_node("weather", weather_answer)
    graph.add_node("general", general_answer)

    graph.add_edge(START, "classify")

    # ⭐ 条件边：classify 之后根据 category 走不同分支
    graph.add_conditional_edges(
        "classify",              # 源节点
        route_by_category,       # 路由函数
        {                        # 路由值 → 目标节点
            "tech": "tech",
            "weather": "weather",
            "general": "general",
        }
    )

    # 所有分支汇聚到 END
    graph.add_edge("tech", END)
    graph.add_edge("weather", END)
    graph.add_edge("general", END)

    app = graph.compile()

    for query in ["Python 的装饰器怎么写？", "明天北京下雨吗？", "推荐一本好书"]:
        result = app.invoke({"query": query, "category": "", "answer": ""})
        print(f"  Q: {query}")
        print(f"  A: {result['answer']}")
        print()


# ───────────────────────────────────────────────────────────────
# 2. 循环图（重试模式）
# ───────────────────────────────────────────────────────────────
def demo_loop():
    print("══════ 2. 循环图（重试） ══════")

    from langgraph.graph import StateGraph, START, END
    from typing import TypedDict
    import random

    class State(TypedDict):
        task: str
        result: str
        quality_score: float
        attempt: int

    def execute_task(state: State) -> dict:
        attempt = state.get("attempt", 0) + 1
        # 模拟：随着重试次数增加，质量提升
        score = min(0.3 * attempt + random.uniform(0, 0.3), 1.0)
        print(f"    第 {attempt} 次尝试，质量分数: {score:.2f}")
        return {
            "result": f"结果 v{attempt}",
            "quality_score": score,
            "attempt": attempt,
        }

    def evaluate(state: State) -> dict:
        return {}  # 评估不修改 state，只用于路由决策

    # ⭐ 路由：质量达标就结束，否则重试
    def should_retry(state: State) -> str:
        if state["quality_score"] >= 0.8:
            return "done"
        if state["attempt"] >= 5:
            return "done"     # 最多重试 5 次
        return "retry"

    graph = StateGraph(State)

    graph.add_node("execute", execute_task)
    graph.add_node("evaluate", evaluate)

    graph.add_edge(START, "execute")
    graph.add_edge("execute", "evaluate")

    # ⭐ 循环边：evaluate → execute（重试）或 → END（完成）
    graph.add_conditional_edges(
        "evaluate",
        should_retry,
        {
            "retry": "execute",   # 回到 execute 重试
            "done": END,
        }
    )

    app = graph.compile()

    result = app.invoke({
        "task": "写一篇文章",
        "result": "",
        "quality_score": 0.0,
        "attempt": 0,
    })
    print(f"  最终: {result['result']}（{result['attempt']} 次尝试）")


# ───────────────────────────────────────────────────────────────
# 3. 自我纠正模式
# ───────────────────────────────────────────────────────────────
def demo_self_correction():
    print("\n══════ 3. 自我纠正 ══════")

    from langgraph.graph import StateGraph, START, END
    from typing import TypedDict, Annotated
    import operator

    class State(TypedDict):
        question: str
        answer: str
        feedback: str
        history: Annotated[list[str], operator.add]

    def generate(state: State) -> dict:
        # 模拟生成答案（实际中调用 LLM）
        if state.get("feedback"):
            answer = f"改进的答案（基于反馈：{state['feedback'][:20]}...）"
        else:
            answer = "初始答案（可能不够好）"
        return {
            "answer": answer,
            "history": [f"生成: {answer[:30]}"],
        }

    def critique(state: State) -> dict:
        # 模拟评审（实际中用 LLM 评审）
        iteration = len(state.get("history", []))
        if iteration < 3:
            return {
                "feedback": f"第{iteration}次：需要更详细的解释",
                "history": ["评审: 不通过"],
            }
        return {
            "feedback": "",  # 空 = 通过
            "history": ["评审: 通过！"],
        }

    def route_after_critique(state: State) -> str:
        if state["feedback"]:
            return "revise"
        return "accept"

    graph = StateGraph(State)
    graph.add_node("generate", generate)
    graph.add_node("critique", critique)

    graph.add_edge(START, "generate")
    graph.add_edge("generate", "critique")
    graph.add_conditional_edges("critique", route_after_critique, {
        "revise": "generate",
        "accept": END,
    })

    app = graph.compile()

    result = app.invoke({
        "question": "什么是微服务？",
        "answer": "",
        "feedback": "",
        "history": [],
    })
    print(f"  答案: {result['answer']}")
    print(f"  历程: {result['history']}")


# ───────────────────────────────────────────────────────────────
# 4. 路由设计模式
# ───────────────────────────────────────────────────────────────
def demo_patterns():
    print("\n══════ 4. 路由设计模式 ══════")

    patterns = """
    ┌──────────────────────────────────────────────────────────┐
    │  模式                图结构                 用途          │
    ├──────────────────────────────────────────────────────────┤
    │                                                          │
    │  二分支            A → B                   是/否判断     │
    │                      → C                                 │
    │                                                          │
    │  多分支            A → B                   分类路由      │
    │                      → C                                 │
    │                      → D                                 │
    │                                                          │
    │  循环              A → B → A（重试）       质量控制      │
    │                         → END                            │
    │                                                          │
    │  菱形              A → B ─┐                 并行后汇合   │
    │                      → C ─┤→ D                           │
    │                                                          │
    │  自我纠正          G → C → G（修改）        迭代改进     │
    │                         → END（通过）                     │
    │                                                          │
    └──────────────────────────────────────────────────────────┘

    ⭐ 防止无限循环的三种方式：
    1. 计数器：state["attempt"] >= max_attempts → END
    2. 质量阈值：state["score"] >= threshold → END
    3. 编译参数：recursion_limit（默认 25）
       app = graph.compile()
       app.invoke(input, config={"recursion_limit": 10})
    """
    print(patterns)


if __name__ == "__main__":
    demo_basic_routing()
    demo_loop()
    demo_self_correction()
    demo_patterns()
