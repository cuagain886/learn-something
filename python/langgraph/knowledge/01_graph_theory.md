# LangGraph 的图计算模型

## 1. 为什么用图来编排 Agent？

### 线性管道的局限

LCEL（LangChain Expression Language）本质是**线性管道**：

```
A | B | C | D
```

- 数据单向流动，不能回退
- 不能根据中间结果选择路径
- 不能循环（重试/自我纠正）

### 图的表达能力

有向图 (Directed Graph) 天然支持：
- **分支**：一个节点的输出可以根据条件流向不同节点
- **循环**：节点的输出可以流回之前的节点
- **并行**：多个节点可以同时接收同一个输入
- **汇聚**：多个节点的输出可以合流

这恰好是 Agent 系统需要的四种控制流。

### 对比

| 特性 | LCEL 管道 | LangGraph 图 |
|------|-----------|-------------|
| 线性流程 | ✅ 简洁 | ✅ 可以 |
| 条件分支 | ❌ | ✅ add_conditional_edges |
| 循环 | ❌ | ✅ 边可以指回之前的节点 |
| 并行 | 有限(RunnableParallel) | ✅ 多出边 / Send API |
| 状态持久化 | ❌ | ✅ Checkpoint |
| 人工介入 | ❌ | ✅ interrupt |

## 2. LangGraph 的图模型

### 基本概念

```
StateGraph = (State, Nodes, Edges)

State:  TypedDict  — 全局共享数据
Node:   函数       — 读取 State，返回更新
Edge:   连接       — 定义执行顺序
```

### 执行模型：超步 (Super-Step)

LangGraph 的执行借鉴了 Google Pregel 论文的**超步**概念：

```
超步 1: 执行所有就绪节点（入边已满足的节点）
        ↓ 收集所有输出
        ↓ 合并到 State（通过 Reducer）
超步 2: 重新检查哪些节点就绪
        ↓ 执行
        ...
直到: 到达 END 或没有就绪节点
```

关键特性：
- **同一超步内的节点并行执行**（如果有多个就绪节点）
- **每个超步结束后保存一个 Checkpoint**
- **节点之间不直接通信，只通过 State 交换数据**

### 状态更新机制

```python
# 节点函数签名
def node(state: State) -> dict:
    # 只返回要更新的字段
    return {"field": new_value}

# 更新规则：
# 1. 没有 Reducer → 覆盖
# 2. 有 Reducer → reducer(current, new)
```

## 3. 与其他图框架的对比

### vs Apache Airflow

| 维度 | Airflow | LangGraph |
|------|---------|-----------|
| 定位 | 数据管道编排 | AI Agent 编排 |
| 图类型 | DAG（无环） | 有向图（支持循环） |
| 状态 | 任务间传递 XCom | 全局 State + Reducer |
| 触发 | 定时/事件 | 实时调用 |
| 人工介入 | 有限 | 原生 interrupt |

### vs Prefect / Dagster

这些都是**数据工程**框架，核心假设是：
- 任务是确定性的（给定输入，输出固定）
- 图是 DAG（无循环）
- 不需要与人实时交互

LangGraph 的假设不同：
- 节点输出不确定（LLM 生成）
- 需要循环（重试、自我纠正）
- 需要人工介入（审核、确认）

### vs LangChain AgentExecutor

AgentExecutor 是一个固定的循环：

```
while True:
    action = llm(messages)
    if action == "finish": break
    result = tool(action)
    messages.append(result)
```

LangGraph 把这个循环**图化**了：
- 每一步都是可观测的节点
- 可以在任意节点暂停
- 可以保存和恢复状态
- 可以自定义循环逻辑

## 4. 图的类型学

### 线性图

```
START → A → B → C → END
```
等价于 LCEL 管道。最简单，适合固定流程。

### 分支图

```
START → Classify → Tech → END
                 → Legal → END
                 → General → END
```
条件路由。适合按类型分发。

### 循环图

```
START → Generate → Evaluate → END (通过)
                            → Generate (重试)
```
自我纠正的核心模式。

### 菱形图（Fan-out / Fan-in）

```
START → Search_Web ──┐
      → Search_DB ───┤→ Aggregate → END
      → Search_API ──┘
```
并行收集，集中处理。

### 层次图（子图）

```
START → [SubGraph_A] → [SubGraph_B] → END
         ├ a1 → a2      ├ b1 → b2
```
模块化。每个子图可以独立开发和测试。

## 5. 确定性 vs 非确定性

### 传统图：确定性

```python
# 给定输入，输出固定
def add(a, b): return a + b
```

### LangGraph：非确定性

```python
# 同样的输入，LLM 可能给出不同的输出
def agent(state):
    response = llm.invoke(state["messages"])
    return {"messages": [response]}
```

非确定性带来的挑战：
- **测试困难** → 需要 LLM-as-Judge 评估
- **调试困难** → 需要 Tracing（LangSmith）
- **不可预测** → 需要防护栏（递归限制、超时、验证）

## 面试常见问题

### Q1: LangGraph 和状态机有什么关系？

LangGraph 可以看作一个**有状态的有向图执行引擎**，和有限状态机 (FSM) 有相似之处：
- 都有状态（State）
- 都有转移（Edge）
- 都可以有条件转移

但不同于经典 FSM：
- FSM 的状态是**离散的标签**（idle, running, done），LangGraph 的状态是**结构化数据**（TypedDict）
- FSM 的转移是原子的，LangGraph 的节点可以执行复杂计算（LLM 调用）
- LangGraph 支持并行（多个节点同时执行），FSM 通常不支持

### Q2: 为什么 LangGraph 的节点不能直接修改 State？

设计原因：
1. **可追溯性**：返回更新而不是直接修改，每一步的变化都是可观测的
2. **Reducer 机制**：并行节点写同一字段时，需要 Reducer 合并，直接修改会造成竞态条件
3. **Checkpoint**：需要在每步之后保存完整快照，直接修改破坏了这个机制
4. **时间旅行**：要回到之前的状态，需要有不可变的历史记录

### Q3: LangGraph 的 Reducer 和 Redux 的 Reducer 有什么关系？

灵感相同，都来自函数式编程的 reduce 概念：
- Redux: `(state, action) → newState`
- LangGraph: `(currentValue, nodeOutput) → mergedValue`

区别：
- Redux 的 Reducer 处理整个 State，LangGraph 的 Reducer 是字段级别的
- Redux 有 Action 的概念，LangGraph 没有——节点输出就是"Action"
- Redux 是同步的，LangGraph 的节点可以是异步的

### Q4: 什么时候该用 LCEL，什么时候该用 LangGraph？

**用 LCEL 的场景：**
- Prompt → LLM → Parser，简单的线性流程
- RAG 链（retriever → prompt → llm → parser）
- 没有循环和条件分支的需求

**用 LangGraph 的场景：**
- 需要 Agent（LLM 决定下一步做什么）
- 需要循环（重试、自我纠正）
- 需要人工介入
- 需要持久化（多轮对话、长任务恢复）
- 多 Agent 协作
