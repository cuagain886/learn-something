# LangGraph Agent 架构模式

## 1. 单 Agent 架构

### ReAct 模式

```
        ┌──────────────────────┐
        │                      │
  ┌─────┴─────┐       ┌───────┴──────┐
  │   Agent   │──────→│    Tools     │
  │   (LLM)  │←──────│   (执行)     │
  └─────┬─────┘       └──────────────┘
        │ 不需要工具
        ↓
    最终回答
```

**核心循环**：Reason → Act → Observe → Reason → ...

```python
from langgraph.prebuilt import create_react_agent

agent = create_react_agent(llm, tools)
```

**适用**：工具数量 < 10，任务相对简单。

**局限**：
- 工具太多时 LLM 容易选错
- 没有显式的规划步骤
- 难以处理需要多步协作的复杂任务

### Plan-and-Execute 模式

```
START → Planner → Executor → Re-Planner → END
            ↑                    │
            └────────────────────┘
```

**两阶段**：
1. **Planner**：制定完整计划（步骤列表）
2. **Executor**：逐步执行计划
3. **Re-Planner**：根据执行结果调整后续计划

```python
class State(TypedDict):
    objective: str
    plan: list[str]           # 计划步骤
    current_step: int         # 当前执行到哪步
    results: list[str]        # 执行结果
    final_answer: str

def planner(state):
    plan = llm.invoke(f"为以下目标制定计划：{state['objective']}")
    return {"plan": parse_plan(plan)}

def executor(state):
    step = state["plan"][state["current_step"]]
    result = execute_step(step)
    return {"results": [result], "current_step": state["current_step"] + 1}

def re_planner(state):
    # 根据已有结果调整剩余计划
    ...
```

**适用**：复杂任务，需要先想清楚再动手。

### Self-Refine 模式

```
START → Generate → Critique → Refine → Critique → ... → END
```

```python
def should_refine(state):
    if state["score"] >= 0.9 or state["iteration"] >= 3:
        return "end"
    return "refine"
```

**适用**：写作、代码生成等需要迭代改进的任务。

## 2. 多 Agent 架构

### Supervisor 模式

```
                ┌──────────┐
                │Supervisor│
                └────┬─────┘
            ┌────────┼────────┐
      ┌─────┴──┐ ┌──┴───┐ ┌──┴─────┐
      │Agent_A │ │Agent_B│ │Agent_C │
      └────────┘ └───────┘ └────────┘
```

**特点**：
- 中心化控制：Supervisor 决定谁来做什么
- 每个 Agent 完成后回到 Supervisor
- Supervisor 可以终止整个流程

```python
def supervisor(state):
    decision = llm.with_structured_output(RouteDecision).invoke([
        SystemMessage("你是主管..."),
        *state["messages"],
    ])
    return {"next": decision.next_agent}
```

**优势**：全局视角，容易调试。
**劣势**：Supervisor 成为瓶颈，每次都要经过它。

### Handoff 模式

```
Agent_A ──transfer──→ Agent_B ──transfer──→ Agent_C
```

**特点**：
- 去中心化：Agent 之间直接传递控制权
- 每个 Agent 自己决定交给谁
- 更接近人类团队的协作方式

```python
# LangGraph 的 Command 实现 handoff
from langgraph.types import Command

def agent_a(state):
    if need_specialist:
        return Command(goto="agent_b", update={"messages": [...]})
    return {"messages": [response]}
```

**优势**：低延迟，Agent 间直接沟通。
**劣势**：难以全局协调，可能产生循环传递。

### 分层多 Agent

```
          ┌───────────┐
          │ Top-Level │
          │ Supervisor│
          └─────┬─────┘
        ┌───────┼───────┐
   ┌────┴────┐     ┌────┴────┐
   │Research │     │ Writing │
   │  Team   │     │  Team   │
   └────┬────┘     └────┬────┘
    ┌───┼───┐      ┌────┼────┐
    │S1 │S2 │      │W1  │W2  │
    └───┘└──┘      └────┘└───┘
```

**特点**：
- 多层 Supervisor，每层管理一组专家
- 顶层 Supervisor 分配高层任务
- 子 Supervisor 协调各自团队

**适用**：大规模复杂系统（如自动化软件开发）。

### 辩论模式

```
START → Agent_A → Agent_B → Judge → END
            ↑         │
            └─────────┘ (继续辩论)
```

**特点**：
- 两个 Agent 持相反立场
- Judge 裁决是否达成共识
- 适合需要多角度分析的问题

## 3. Agent 设计决策树

```
你的任务需要...

工具调用？
├── 否 → 用 LCEL 管道
└── 是 →
    需要循环/重试？
    ├── 否 → 单次工具调用（LCEL + bind_tools）
    └── 是 →
        需要多个专家？
        ├── 否 → 单 Agent (ReAct)
        └── 是 →
            需要全局协调？
            ├── 是 → Supervisor 模式
            └── 否 →
                按类型分发？
                ├── 是 → Handoff 模式
                └── 否 → 协作/辩论模式
```

## 4. 工具设计原则

### 工具粒度

```
❌ 太粗：一个工具做所有事
@tool
def do_everything(instruction: str): ...

❌ 太细：每个操作一个工具
@tool
def open_file(path: str): ...
@tool
def read_line(line_num: int): ...
@tool
def close_file(): ...

✅ 合适：一个工具对应一个自然动作
@tool
def read_file(path: str) -> str: ...
@tool
def search_documents(query: str) -> list[str]: ...
```

### 工具描述

LLM 根据工具的 **名字 + 描述 + 参数** 决定是否调用。

```python
# ❌ 描述太模糊
@tool
def process(data: str) -> str:
    """处理数据"""

# ✅ 描述清晰
@tool
def search_knowledge_base(query: str) -> str:
    """搜索公司内部知识库。
    传入自然语言问题，返回最相关的3条结果。
    适用于查找公司政策、产品文档、技术规范。
    不适用于搜索外部互联网内容。"""
```

### 工具分组

当工具数量超过 5-10 个时，按功能域拆分到不同 Agent：

```
Research Agent: [search_web, search_docs, search_db]
Code Agent:    [read_file, write_file, run_tests]
Data Agent:    [query_sql, create_chart, export_csv]
```

## 5. 状态共享策略

### 策略 1：完全共享

所有 Agent 看到完整的 State。
- 优点：信息透明
- 缺点：State 过大、Agent 分心

### 策略 2：消息传递

Agent 只通过 messages 字段通信。
- 优点：松耦合
- 缺点：信息可能丢失在长对话中

### 策略 3：白板模式

共享一个结构化的"白板"（State 中的特定字段），Agent 往上写/读。
- 优点：结构化、可追溯
- 缺点：需要精心设计白板结构

```python
class WhiteboardState(MessagesState):
    # 白板区域
    research_findings: Annotated[list[str], operator.add]
    code_snippets: Annotated[list[str], operator.add]
    review_comments: Annotated[list[str], operator.add]
    # 控制
    current_phase: str
```

## 面试常见问题

### Q1: Supervisor vs Handoff 如何选择？

| 维度 | Supervisor | Handoff |
|------|-----------|---------|
| 控制方式 | 中心化 | 去中心化 |
| 延迟 | 高（每次经过Supervisor） | 低（直接传递） |
| 可控性 | 高 | 低 |
| 调试 | 容易 | 困难 |
| Agent 数量 | 适合 3-5 个 | 适合 2-3 个 |
| 适用场景 | 需要统一协调 | Agent 间有明确的前后关系 |

### Q2: 如何防止多 Agent 系统中的无限循环？

1. **recursion_limit**：全局步数限制
2. **handoff_count**：State 中记录传递次数
3. **visited_agents**：State 中记录已访问的 Agent，避免重复
4. **timeout**：设置总执行时间上限
5. **Supervisor 兜底**：Supervisor 强制终止异常循环

### Q3: 多 Agent 的 token 开销如何优化？

- **消息裁剪**：每个 Agent 只看到与自己相关的消息
- **摘要**：长对话定期压缩为摘要
- **专用 System Prompt**：每个 Agent 只收到自己的角色描述
- **模型分级**：简单 Agent 用小模型（gpt-4o-mini），关键 Agent 用大模型（gpt-4o）
