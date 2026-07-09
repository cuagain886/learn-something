# LangGraph 状态管理深度解析

## 1. State 的本质

### 为什么 State 是 TypedDict？

```python
class State(TypedDict):
    messages: Annotated[list, add_messages]
    current_step: str
    iteration: int
```

选择 TypedDict 而非 dataclass/Pydantic 的原因：
- **序列化友好**：TypedDict 本质是 dict，JSON 序列化天然支持
- **部分更新**：节点只返回要更新的字段，不需要完整对象
- **Checkpoint 兼容**：dict 可以直接存入 SQLite/PostgreSQL
- **类型检查**：有 IDE 提示，但运行时没有验证开销

### 字段分类

```
State 字段按生命周期分：

┌─ 输入字段 ─────────────────────────────────────┐
│  用户提供，图执行期间通常不变                      │
│  如：query, user_id, config                      │
└──────────────────────────────────────────────────┘

┌─ 累积字段 ─────────────────────────────────────┐
│  多个节点逐步追加，需要 Reducer                   │
│  如：messages, tool_results, search_results      │
└──────────────────────────────────────────────────┘

┌─ 工作字段 ─────────────────────────────────────┐
│  节点间传递的临时数据，后者覆盖前者                │
│  如：current_step, draft, category               │
└──────────────────────────────────────────────────┘

┌─ 控制字段 ─────────────────────────────────────┐
│  影响路由决策的标志位                              │
│  如：should_retry, is_approved, error_count      │
└──────────────────────────────────────────────────┘
```

## 2. Reducer 深度

### 内置 Reducer

```python
import operator
from langgraph.graph import add_messages

# 1. operator.add（列表追加）
steps: Annotated[list[str], operator.add]
# ["A"] + ["B"] = ["A", "B"]
# ⚠️ 对 int 是数学加法：1 + 2 = 3

# 2. add_messages（消息智能合并）
messages: Annotated[list, add_messages]
# - 自动按 message.id 去重
# - 相同 id 的消息更新而非追加
# - 支持 RemoveMessage 删除
```

### add_messages 的智能行为

```python
from langchain_core.messages import HumanMessage, AIMessage, RemoveMessage

# 场景 1：正常追加
current = [HumanMessage(content="你好", id="1")]
new = [AIMessage(content="你好！", id="2")]
# 结果: [HumanMessage("你好"), AIMessage("你好！")]

# 场景 2：相同 id → 更新
current = [AIMessage(content="旧回答", id="ai_1")]
new = [AIMessage(content="新回答", id="ai_1")]
# 结果: [AIMessage("新回答")]  ← 更新，不追加

# 场景 3：RemoveMessage
current = [HumanMessage("1", id="h1"), AIMessage("2", id="a1")]
new = [RemoveMessage(id="h1")]
# 结果: [AIMessage("2")]  ← h1 被删除
```

### 自定义 Reducer 进阶

```python
# ⭐ 带历史窗口的 Reducer
def windowed_list(current: list, new: list, *, max_size: int = 100) -> list:
    """只保留最近 max_size 条"""
    combined = current + new
    return combined[-max_size:]

# 用法
class State(TypedDict):
    events: Annotated[list, lambda c, n: windowed_list(c, n, max_size=50)]

# ⭐ 带验证的 Reducer
def validated_update(current: str, new: str) -> str:
    if len(new) > 10000:
        raise ValueError("内容超过10000字符限制")
    return new

# ⭐ 合并字典（深度）
def deep_merge(current: dict, new: dict) -> dict:
    result = dict(current)
    for key, value in new.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result
```

## 3. 状态快照与 Checkpoint

### Checkpoint 的数据结构

每个 Checkpoint 包含：

```
Checkpoint {
    id:             唯一标识（UUID）
    thread_id:      会话标识
    parent_id:      父 Checkpoint 的 ID（形成链表）
    values:         State 的完整快照
    metadata: {
        step:       第几步
        source:     "input" | "loop" | "update"
        writes:     本步的写入内容
    }
    pending_writes: 尚未确认的写入
}
```

### 快照链

```
Checkpoint_0 (初始)
    ↓ parent_id
Checkpoint_1 (node_a 执行后)
    ↓ parent_id
Checkpoint_2 (node_b 执行后)
    ↓ parent_id
Checkpoint_3 (最终)
```

时间旅行 = 根据 checkpoint_id 加载某个快照并从那里继续。

### 存储后端对比

| 后端 | 持久性 | 并发 | 适用场景 |
|------|--------|------|----------|
| MemorySaver | 进程内存 | 单进程 | 开发/测试 |
| SqliteSaver | 文件 | 单进程 | 本地应用 |
| PostgresSaver | 数据库 | 多进程 | 生产环境 |
| RedisSaver | 内存+持久化 | 多进程 | 高性能场景 |

## 4. 状态设计模式

### 模式 1：最小 Agent 状态

```python
class SimpleAgentState(MessagesState):
    """只有消息——最简单的 Agent"""
    pass  # 继承 messages: Annotated[list, add_messages]
```

适用：简单对话、单工具 Agent。

### 模式 2：带工作区的 Agent

```python
class WorkspaceAgentState(MessagesState):
    """带工作区域的 Agent"""
    current_plan: str           # 当前计划
    draft: str                  # 工作草稿
    iteration: int              # 迭代次数
```

适用：Plan-Execute、写作 Agent。

### 模式 3：带追踪的 Agent

```python
class TrackedAgentState(MessagesState):
    """带完整追踪的 Agent"""
    tool_calls: Annotated[list[dict], operator.add]    # 工具调用记录
    decisions: Annotated[list[str], operator.add]       # 决策记录
    errors: Annotated[list[str], operator.add]          # 错误记录
    start_time: float                                   # 开始时间
```

适用：需要审计、可观测性的生产系统。

### 模式 4：多 Agent 共享状态

```python
class MultiAgentState(MessagesState):
    """多 Agent 的共享白板"""
    current_agent: str                                   # 当前活跃的 Agent
    research_notes: Annotated[list[str], operator.add]   # 研究笔记
    review_feedback: Annotated[list[str], operator.add]  # 评审反馈
    final_output: str                                    # 最终产出
    handoff_count: int                                   # 交接次数
```

## 5. 常见陷阱与解决

### 陷阱 1：直接修改 State 对象

```python
# ❌ 错误：直接修改
def node(state):
    state["messages"].append(new_msg)  # 绕过 Reducer！
    return {}

# ✅ 正确：返回更新
def node(state):
    return {"messages": [new_msg]}  # 让 Reducer 处理
```

### 陷阱 2：忘记初始值

```python
# ❌ invoke({}) → KeyError
result = app.invoke({"messages": []})  # 需要提供所有字段

# ✅ 用 Optional 或默认值
class State(TypedDict, total=False):  # 所有字段可选
    messages: Annotated[list, add_messages]
    count: int
```

### 陷阱 3：并行节点冲突

```python
# 两个并行节点都写 "result" 字段
def node_a(state): return {"result": "A"}
def node_b(state): return {"result": "B"}

# ❌ 没有 Reducer → 哪个后完成就是谁的值（不确定）
# ✅ 用 Reducer → Annotated[list, operator.add]
#    或者让两个节点写不同字段
```

### 陷阱 4：State 过大

```python
# ❌ 把整个文档内容放进 State
class State(TypedDict):
    documents: list[str]  # 每个文档可能几万字！

# ✅ 只存引用
class State(TypedDict):
    document_ids: list[str]  # 存 ID，需要时读取
```

## 面试常见问题

### Q1: LangGraph 如何处理并行节点的状态冲突？

通过 Reducer 机制。当多个并行节点写入同一个 State 字段时：
1. 每个节点独立返回自己的更新
2. LangGraph 收集所有更新
3. 按注册的 Reducer 函数依次合并

如果没有 Reducer（默认覆盖模式），并行写入的结果是**不确定的**（取决于哪个先完成）。所以并行场景必须使用 Reducer。

### Q2: Checkpoint 的存储开销大吗？

每个超步保存一个完整的 State 快照，所以：
- 如果 State 中有大量消息历史 → 开销大
- 每次调用有 N 个超步 → N 个快照

优化方式：
1. 定期裁剪消息历史（trim_messages）
2. State 只存引用，不存完整内容
3. 使用 PostgresSaver 的二进制序列化

### Q3: 如何实现跨进程的状态共享？

用共享存储后端（PostgreSQL/Redis）作为 Checkpointer：
- 进程 A 执行到一半 → 保存 Checkpoint
- 进程 B 加载同一个 thread_id 的 Checkpoint → 继续执行

这是 LangGraph Platform 水平扩展的基础。
