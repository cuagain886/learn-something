"""
═══════════════════════════════════════════════════════════════════
 09_multi_agent —— 多 Agent 协作
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. Supervisor 模式（主管协调）
  2. Handoff 模式（传递控制权）
  3. 多 Agent 共享状态
  4. 多 Agent 设计原则

【为什么需要多 Agent】
  单个 Agent 的局限：
  - 工具太多 → LLM 选错工具
  - 职责太广 → 提示词太长，质量下降
  - 不同任务需要不同模型/温度

  拆分为多个专家 Agent，各司其职，协作完成复杂任务。

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. Supervisor 模式
# ───────────────────────────────────────────────────────────────
def demo_supervisor():
    print("══════ 1. Supervisor 模式 ══════")

    from langgraph.graph import StateGraph, START, END, MessagesState
    from langchain_openai import ChatOpenAI
    from langchain_core.messages import HumanMessage, AIMessage, SystemMessage
    from pydantic import BaseModel, Field

    # 定义路由决策模型
    class RouteDecision(BaseModel):
        next_agent: str = Field(
            description="下一步应该找哪个专家：'researcher', 'writer', 'FINISH'"
        )
        reason: str = Field(description="选择原因")

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)

    # ── Supervisor 节点 ──
    def supervisor(state: MessagesState) -> dict:
        system = SystemMessage(content="""你是一个项目主管，协调 researcher 和 writer 两个专家完成任务。
- researcher：负责搜索和收集信息
- writer：负责根据信息撰写内容
- FINISH：任务完成

根据当前对话状态，决定下一步找谁。如果信息已收集且文章已写好，选择 FINISH。""")

        messages = [system] + state["messages"]

        decision = llm.with_structured_output(RouteDecision).invoke(messages)
        return {
            "messages": [AIMessage(content=f"[主管] 下一步: {decision.next_agent}（{decision.reason}）")]
        }

    # ── 专家节点 ──
    def researcher(state: MessagesState) -> dict:
        response = llm.invoke([
            SystemMessage(content="你是一个研究员。根据对话内容，搜索并提供相关信息。简洁回答。"),
            *state["messages"],
        ])
        return {"messages": [AIMessage(content=f"[研究员] {response.content}")]}

    def writer(state: MessagesState) -> dict:
        response = llm.invoke([
            SystemMessage(content="你是一个作者。根据研究员提供的信息，撰写简洁的内容。"),
            *state["messages"],
        ])
        return {"messages": [AIMessage(content=f"[作者] {response.content}")]}

    # ── 路由函数 ──
    def route_supervisor(state: MessagesState) -> str:
        last = state["messages"][-1].content
        if "FINISH" in last:
            return "end"
        elif "researcher" in last.lower():
            return "researcher"
        elif "writer" in last.lower():
            return "writer"
        return "end"

    # ── 构建图 ──
    graph = StateGraph(MessagesState)
    graph.add_node("supervisor", supervisor)
    graph.add_node("researcher", researcher)
    graph.add_node("writer", writer)

    graph.add_edge(START, "supervisor")
    graph.add_conditional_edges("supervisor", route_supervisor, {
        "researcher": "researcher",
        "writer": "writer",
        "end": END,
    })
    # 专家完成后回到 supervisor
    graph.add_edge("researcher", "supervisor")
    graph.add_edge("writer", "supervisor")

    app = graph.compile()

    result = app.invoke({
        "messages": [HumanMessage(content="帮我写一段关于 LangGraph 的介绍（100字以内）")]
    }, config={"recursion_limit": 15})

    print("  对话流程:")
    for msg in result["messages"]:
        if isinstance(msg, AIMessage):
            print(f"    {msg.content[:80]}")


# ───────────────────────────────────────────────────────────────
# 2. Handoff 模式（简化版）
# ───────────────────────────────────────────────────────────────
def demo_handoff():
    print("\n══════ 2. Handoff 模式 ══════")

    from langgraph.graph import StateGraph, START, END
    from typing import TypedDict, Annotated
    import operator

    class State(TypedDict):
        query: str
        category: str
        response: str
        trace: Annotated[list[str], operator.add]

    # ── 分发器：根据查询类型分配给不同 Agent ──
    def dispatcher(state: State) -> dict:
        q = state["query"].lower()
        if any(kw in q for kw in ["代码", "编程", "bug"]):
            return {"category": "tech", "trace": ["分发 → 技术Agent"]}
        elif any(kw in q for kw in ["合同", "法律", "条款"]):
            return {"category": "legal", "trace": ["分发 → 法务Agent"]}
        return {"category": "general", "trace": ["分发 → 通用Agent"]}

    def tech_agent(state: State) -> dict:
        return {
            "response": f"[技术专家] 针对'{state['query']}'的技术解答",
            "trace": ["技术Agent 处理完成"],
        }

    def legal_agent(state: State) -> dict:
        return {
            "response": f"[法务专家] 针对'{state['query']}'的法律解答",
            "trace": ["法务Agent 处理完成"],
        }

    def general_agent(state: State) -> dict:
        return {
            "response": f"[通用助手] 针对'{state['query']}'的回答",
            "trace": ["通用Agent 处理完成"],
        }

    def route(state: State) -> str:
        return state["category"]

    graph = StateGraph(State)
    graph.add_node("dispatch", dispatcher)
    graph.add_node("tech", tech_agent)
    graph.add_node("legal", legal_agent)
    graph.add_node("general", general_agent)

    graph.add_edge(START, "dispatch")
    graph.add_conditional_edges("dispatch", route, {
        "tech": "tech",
        "legal": "legal",
        "general": "general",
    })
    graph.add_edge("tech", END)
    graph.add_edge("legal", END)
    graph.add_edge("general", END)

    app = graph.compile()

    for query in ["这段代码有bug怎么修？", "合同的违约条款怎么写？", "推荐一本好书"]:
        result = app.invoke({
            "query": query, "category": "", "response": "", "trace": [],
        })
        print(f"  Q: {query}")
        print(f"  A: {result['response']}")
        print(f"  路径: {' → '.join(result['trace'])}")
        print()


# ───────────────────────────────────────────────────────────────
# 3. 多 Agent 设计原则
# ───────────────────────────────────────────────────────────────
def demo_principles():
    print("══════ 3. 多 Agent 设计原则 ══════")

    principles = """
    ┌──────────────────────────────────────────────────────────┐
    │  模式             适用场景             LangGraph 实现      │
    ├──────────────────────────────────────────────────────────┤
    │  Supervisor       需要全局协调          主管节点 + 条件边   │
    │  Handoff          按类型分发            分发器 + 专家节点   │
    │  Sequential       固定协作流程          A → B → C 顺序边  │
    │  Debate           需要对抗性思考        两个 Agent 交替辩论 │
    │  Hierarchical     三层以上的组织        主管 → 子主管 → 执行│
    └──────────────────────────────────────────────────────────┘

    ⭐ 拆分 Agent 的时机：
    1. 工具数超过 5-10 个 → 按功能域拆分
    2. 需要不同模型/温度 → 不同 Agent 用不同配置
    3. 需要不同 System Prompt → 每个 Agent 有自己的角色设定
    4. 需要独立测试 → 每个 Agent 可以单独运行验证

    ⚠️ 不要过度拆分：
    - 每多一个 Agent，就多一次 LLM 调用（成本 + 延迟）
    - 简单任务用单 Agent + 多工具就够了
    - Agent 之间的通信也消耗 token
    """
    print(principles)


if __name__ == "__main__":
    demo_supervisor()
    demo_handoff()
    demo_principles()
