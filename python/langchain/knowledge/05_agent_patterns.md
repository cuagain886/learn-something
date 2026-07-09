# 05 · Agent 架构模式 ⭐⭐

> Agent 是让 LLM 从"回答问题"升级到"完成任务"的关键。理解主流的 Agent 模式及其在 LangChain 中的实现。

---

## 1. Agent 核心循环

所有 Agent 模式都基于这个基本循环：

```
         ┌─────────────────────────┐
         │      用户输入            │
         └────────┬────────────────┘
                  ↓
         ┌─────────────────────────┐
    ┌───→│  LLM 推理（思考下一步）   │←──┐
    │    └────────┬────────────────┘    │
    │             ↓                     │
    │    ┌─────────────────────────┐    │
    │    │  决定：需要工具？         │    │
    │    └────┬────────────┬───────┘    │
    │    需要  ↓            ↓ 不需要     │
    │    ┌──────────┐  ┌──────────┐    │
    │    │ 调用工具  │  │ 最终回答  │    │
    │    └────┬─────┘  └──────────┘    │
    │         ↓                         │
    │    ┌──────────┐                   │
    │    │ 观察结果  │                   │
    │    └────┬─────┘                   │
    └─────────┘
```

---

## 2. ReAct 模式（最经典）

**Re**asoning + **Act**ing：让 LLM 交替执行推理和行动。

```
Thought: 用户问的是北京天气，我需要调用天气工具
Action: weather_search(city="北京")
Observation: 北京今天晴，25°C
Thought: 已经拿到天气信息了，可以回答了
Final Answer: 北京今天天气晴朗，温度25°C。
```

### LangChain 实现

```python
from langchain.agents import create_tool_calling_agent, AgentExecutor

# 现代 LangChain 使用 tool calling 而非文本解析
# LLM 通过 API 结构化地调用工具，而不是生成文本格式的 Action
agent = create_tool_calling_agent(llm, tools, prompt)
executor = AgentExecutor(agent=agent, tools=tools)
```

### 优缺点

| 优点 | 缺点 |
|------|------|
| 简单直观 | 容易卡在循环中 |
| 灵活性高 | 推理步骤多时 token 消耗大 |
| 适合简单任务 | 复杂任务容易出错 |

---

## 3. Plan-and-Execute 模式

先制定完整计划，再逐步执行。适合复杂的多步骤任务。

```
┌────────────────┐
│  Planner (LLM) │  输入: "帮我分析这个项目的代码质量"
│  制定计划       │  输出:
│                │    1. 扫描项目结构
│                │    2. 运行代码检查工具
│                │    3. 分析测试覆盖率
│                │    4. 生成报告
└───────┬────────┘
        ↓
┌────────────────┐
│  Executor      │  逐步执行计划
│  执行每个步骤   │  每步可以调用工具
│                │  将结果反馈给下一步
└───────┬────────┘
        ↓
┌────────────────┐
│  Re-planner    │  根据执行结果调整剩余计划
│  （可选）       │  处理意外情况
└────────────────┘
```

### 适用场景
- 多步骤、有依赖的任务
- 需要全局规划的场景
- 需要可控性和可预测性

---

## 4. Self-Refine 模式（自我纠正）

LLM 生成初始输出 → 自我评估 → 改进 → 再评估 → 直到满意。

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│ Generator │──→│ Critic   │──→│ Refiner  │──→ 循环直到通过
│ 生成初稿  │    │ 评估质量  │    │ 改进输出  │
└──────────┘    └──────────┘    └──────────┘
```

```python
# LangGraph 实现
def generate(state):
    return {"draft": llm.invoke("写一篇关于...的文章")}

def critique(state):
    return {"feedback": llm.invoke(f"评估以下文章的质量：{state['draft']}")}

def should_refine(state):
    if "通过" in state["feedback"]:
        return "end"
    return "refine"

def refine(state):
    return {"draft": llm.invoke(f"根据反馈改进：{state['feedback']}\n原文：{state['draft']}")}
```

---

## 5. 多 Agent 协作

### Supervisor 模式

一个"主管" Agent 协调多个"专家" Agent。

```
         ┌──────────────┐
         │  Supervisor  │  决定下一步该找哪个专家
         │  主管 Agent   │
         └──┬───┬───┬───┘
            ↓   ↓   ↓
    ┌───────┐ ┌──────┐ ┌──────┐
    │Coder  │ │Writer│ │Tester│
    │写代码  │ │写文档 │ │测试  │
    └───────┘ └──────┘ └──────┘
```

### Debate 模式（辩论）

多个 Agent 持不同立场辩论，最终得出更好的结论。

### Handoff 模式

Agent 之间传递控制权：
```
用户 → 分类 Agent → 技术 Agent → 回答
                  → 销售 Agent → 回答
```

---

## 6. Tool Calling vs Text Parsing

### 旧方式：文本解析

```
LLM 输出: "Action: search\nAction Input: Python 教程"
正则表达式解析 → 提取工具名和参数
⚠️ 容易解析失败
```

### 新方式：Tool Calling（推荐）

```
LLM 通过 API 结构化返回：
{
  "tool_calls": [{
    "name": "search",
    "args": {"query": "Python 教程"},
    "id": "call_abc123"
  }]
}
✅ 结构化、可靠、支持并行调用
```

⭐ 所有主流 LLM 都支持 tool calling（OpenAI、Anthropic、Google...）。
LangChain 的 `create_tool_calling_agent` 使用 tool calling API。

---

## 7. Agent 设计原则

### 工具设计

```
✅ 好的工具描述：
@tool
def search_docs(query: str, max_results: int = 5) -> str:
    """在知识库中搜索文档。
    当用户问技术问题时使用此工具。
    query 应该是简洁的搜索关键词。
    """

❌ 差的工具描述：
@tool
def search(q: str) -> str:
    """搜索"""
```

### 防止 Agent 失控

1. **max_iterations**：限制最大推理步数
2. **超时设置**：限制总执行时间
3. **工具白名单**：只暴露必要的工具
4. **沙箱执行**：代码执行工具必须沙箱化
5. **人工审核**：关键操作前暂停等待确认
6. **成本控制**：监控 token 使用量

### 何时用 Agent，何时用 Chain

| 场景 | 推荐 |
|------|------|
| 流程固定、步骤确定 | Chain |
| 需要根据情况动态决策 | Agent |
| 可能不需要工具 | Agent |
| 安全性要求高 | Chain（更可控）|
| 复杂多步骤 | LangGraph |

---

## 面试常见问题

**Q1：ReAct Agent 的工作原理？**
A：交替执行 Reasoning（推理）和 Acting（行动）。LLM 先思考需要什么信息，调用工具获取，观察结果，再决定下一步，直到能给出最终答案。

**Q2：Tool Calling 和 Function Calling 的区别？**
A：Tool Calling 是 Function Calling 的升级版。Function Calling 一次只能调用一个函数；Tool Calling 支持一次调用多个工具（并行调用）。LangChain 统一使用 Tool Calling 接口。

**Q3：多 Agent 系统的常见架构？**
A：1) Supervisor（主管协调专家）；2) Debate（多 Agent 辩论）；3) Handoff（传递控制权）；4) Hierarchical（分层管理）。LangGraph 是实现这些模式的推荐框架。

---

## 一句话总结

Agent 模式从简单到复杂：ReAct（单步推理循环）→ Plan-and-Execute（先规划后执行）→ Self-Refine（自我纠正）→ 多 Agent 协作（Supervisor/Debate），选择取决于任务复杂度和可控性需求。
