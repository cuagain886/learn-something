# 06 · LangGraph 深入 ⭐

> LangGraph 是 LangChain 团队打造的 Agent 编排框架。基于状态图（StateGraph），支持循环、条件分支、人机交互和状态持久化。

---

## 1. 核心概念

### 状态图（StateGraph）

```
LangGraph = 有限状态机 + LLM

节点（Node）：处理函数，读写 State
边（Edge）：节点间的连接
条件边（Conditional Edge）：根据 State 动态路由
状态（State）：贯穿整个图的数据结构
```

### State 的设计

```python
from typing import TypedDict, Annotated
from langgraph.graph import MessagesState
import operator

# 方式一：TypedDict（基础）
class MyState(TypedDict):
    messages: list         # 每次覆盖
    count: int

# 方式二：Annotated + Reducer（累积）
class MyState(TypedDict):
    messages: Annotated[list, operator.add]  # 每次追加，不覆盖
    count: int                                # 每次覆盖

# 方式三：使用内置的 MessagesState
# 等价于 messages: Annotated[list[AnyMessage], add_messages]
# add_messages 比 operator.add 更智能：
# - 自动处理消息 ID 去重
# - 支持 RemoveMessage 删除特定消息
```

### Reducer 函数

```python
# Reducer 决定多个节点对同一字段的更新如何合并

# operator.add：列表追加
messages: Annotated[list, operator.add]
# 节点1 返回 {"messages": ["a"]}
# 节点2 返回 {"messages": ["b"]}
# 结果: messages = ["a", "b"]

# 自定义 Reducer
def keep_latest(current, new):
    """只保留最新值"""
    return new

count: Annotated[int, keep_latest]
```

---

## 2. 节点与边

### 节点定义

```python
# 每个节点接收完整 State，返回要更新的字段
def my_node(state: MyState) -> dict:
    # 读取 state
    messages = state["messages"]
    
    # 处理逻辑...
    
    # 返回要更新的字段（不需要返回完整 state）
    return {"messages": [new_message], "count": state["count"] + 1}
```

### 边的类型

```python
from langgraph.graph import StateGraph, START, END

graph = StateGraph(MyState)

# 1. 普通边：A → B
graph.add_edge("node_a", "node_b")

# 2. 条件边：根据 state 选择下一个节点
def router(state):
    if state["count"] > 3:
        return "end"
    return "continue"

graph.add_conditional_edges(
    "node_a",           # 从哪个节点出发
    router,             # 路由函数
    {                   # 路由值 → 目标节点
        "continue": "node_b",
        "end": END,
    }
)

# 3. 入口和出口
graph.add_edge(START, "node_a")
graph.add_edge("node_b", END)
```

---

## 3. 检查点（Checkpoint）

### 为什么需要 Checkpoint

1. **中断恢复**：长任务中途失败，从上次位置继续
2. **人机交互**：暂停等待人工审核，审核后继续
3. **时间旅行**：回溯到之前的状态
4. **分支探索**：从某个状态点分叉

### 使用 Checkpointer

```python
from langgraph.checkpoint.memory import MemorySaver
from langgraph.checkpoint.sqlite import SqliteSaver

# 内存（开发用）
checkpointer = MemorySaver()

# SQLite（持久化）
checkpointer = SqliteSaver.from_conn_string("checkpoints.db")

# 编译时传入
app = graph.compile(checkpointer=checkpointer)

# ⭐ 使用时必须传 thread_id
config = {"configurable": {"thread_id": "conversation_1"}}

# 每次 invoke 后状态会自动保存
result1 = app.invoke(input1, config)
result2 = app.invoke(input2, config)  # 在 result1 的基础上继续

# 获取当前状态
state = app.get_state(config)

# 获取状态历史
for state in app.get_state_history(config):
    print(state.values, state.metadata)
```

---

## 4. Human-in-the-Loop

### interrupt_before / interrupt_after

```python
# 在指定节点之前/之后暂停执行
app = graph.compile(
    checkpointer=checkpointer,
    interrupt_before=["sensitive_action"],   # 执行前暂停
    # interrupt_after=["review_node"],       # 执行后暂停
)

# 第一次调用：会在 sensitive_action 之前暂停
result = app.invoke(input, config)
# result 是到暂停点为止的状态

# 人工审核...
# 决定继续
app.invoke(None, config)  # 传 None 继续执行

# 或者修改状态后继续
app.update_state(config, {"approved": True})
app.invoke(None, config)
```

### 实际应用

```
用户请求 → Agent 规划 → 【暂停：显示计划给用户确认】
                                    ↓ 用户确认
                          Agent 执行计划
                                    ↓
                          【暂停：显示结果给用户审核】
                                    ↓ 用户审核通过
                          提交/发送
```

---

## 5. 子图（Subgraph）

把复杂图拆分成可复用的子图：

```python
# 定义子图
def create_research_subgraph():
    subgraph = StateGraph(ResearchState)
    subgraph.add_node("search", search_node)
    subgraph.add_node("summarize", summarize_node)
    subgraph.add_edge(START, "search")
    subgraph.add_edge("search", "summarize")
    subgraph.add_edge("summarize", END)
    return subgraph.compile()

# 在主图中使用子图作为节点
main_graph = StateGraph(MainState)
main_graph.add_node("research", create_research_subgraph())
main_graph.add_node("write", write_node)
main_graph.add_edge(START, "research")
main_graph.add_edge("research", "write")
main_graph.add_edge("write", END)
```

---

## 6. 多 Agent 模式实现

### Supervisor 模式

```python
from langgraph.prebuilt import create_react_agent

# 创建专家 Agent
researcher = create_react_agent(llm, [search_tool])
coder = create_react_agent(llm, [code_tool])

# Supervisor 节点：决定下一步找谁
def supervisor(state):
    response = llm.with_structured_output(RouteDecision).invoke(
        f"根据当前对话，下一步应该找谁？选择：researcher, coder, FINISH"
    )
    return {"next": response.next_agent}

# 构建图
graph = StateGraph(TeamState)
graph.add_node("supervisor", supervisor)
graph.add_node("researcher", researcher)
graph.add_node("coder", coder)

graph.add_edge(START, "supervisor")
graph.add_conditional_edges("supervisor", lambda s: s["next"], {
    "researcher": "researcher",
    "coder": "coder",
    "FINISH": END,
})
graph.add_edge("researcher", "supervisor")
graph.add_edge("coder", "supervisor")
```

---

## 7. LangGraph 最佳实践

### State 设计

```
✅ State 应该是：
- 最小化：只包含节点间需要共享的数据
- 不可变风格：节点返回新值，不直接修改 state
- 明确类型：用 TypedDict + type hints

❌ 避免：
- 把所有数据都塞进 state
- 在节点中修改 state 的可变对象
- 忘记设置 reducer 导致数据被覆盖
```

### 调试

```python
# 1. 打印图结构
print(app.get_graph().draw_ascii())

# 2. 生成 Mermaid 图
print(app.get_graph().draw_mermaid())

# 3. LangSmith 追踪
# 设置 LANGSMITH_TRACING=true

# 4. 流式观察每个节点
for event in app.stream(input, config, stream_mode="updates"):
    print(f"节点: {list(event.keys())[0]}")
    print(f"更新: {event}")
```

---

## 面试常见问题

**Q1：LangGraph 和 AgentExecutor 的区别？**
A：AgentExecutor 是固定的线性循环（LLM → 工具 → LLM...）。LangGraph 是通用的状态图引擎，支持条件分支、循环、并行、子图，可以实现任意复杂的 Agent 逻辑。

**Q2：LangGraph 的 Checkpoint 能做什么？**
A：1) 中断恢复（长任务失败后从上次继续）；2) 人机交互（暂停等待人工审核）；3) 时间旅行（回溯到之前的状态）；4) 多线程对话（每个 thread_id 独立状态）。

**Q3：如何实现 Human-in-the-loop？**
A：使用 `interrupt_before` 或 `interrupt_after` 在指定节点暂停。暂停后可以获取当前状态展示给用户，用户确认后调用 `invoke(None, config)` 继续，或用 `update_state` 修改状态后继续。

---

## 一句话总结

LangGraph = 状态图 + Checkpoint + 条件路由，把 Agent 从黑箱的推理循环变成可视化、可控、可中断、可恢复的有向图。
