# LangGraph 持久化与恢复

## 1. Checkpoint 机制

### 什么时候保存 Checkpoint？

```
invoke(input)
    │
    ├─ Checkpoint_0: 保存初始输入
    │
    ├─ 执行 node_a
    ├─ Checkpoint_1: node_a 完成后保存
    │
    ├─ 执行 node_b
    ├─ Checkpoint_2: node_b 完成后保存
    │
    └─ 返回最终结果
```

**规则**：每个超步（Super-Step）结束后自动保存一个 Checkpoint。

### Checkpoint 内容

```python
{
    "id": "1ef7a3b...",            # 唯一标识
    "thread_id": "user_123",       # 会话标识
    "checkpoint_ns": "",            # 命名空间（子图用）
    "parent_checkpoint_id": "1ef7a2c...",  # 父检查点
    "values": {                     # 完整的 State 快照
        "messages": [...],
        "current_step": "plan",
    },
    "metadata": {
        "source": "loop",           # 来源：input/loop/update
        "step": 3,                  # 第几步
        "writes": {"plan": {...}},  # 本步写入
    },
    "pending_writes": [],           # 待确认写入（interrupt 时）
}
```

### 持久化与序列化

```python
# State 中的值必须可序列化
# ✅ 可以：str, int, float, bool, list, dict, None
# ✅ 可以：LangChain Message 对象（有内置序列化器）
# ❌ 不行：自定义类实例、函数、生成器

# 如果需要存自定义对象，转为 dict
class State(TypedDict):
    config: dict  # ✅ 而不是 config: MyConfig ❌
```

## 2. 时间旅行

### 查看历史

```python
memory = MemorySaver()
app = graph.compile(checkpointer=memory)
config = {"configurable": {"thread_id": "demo"}}

# 执行几轮
app.invoke(input1, config)
app.invoke(input2, config)

# ⭐ 遍历所有历史快照
for state in app.get_state_history(config):
    print(f"Step {state.metadata['step']}: {state.values}")
    print(f"  ID: {state.config['configurable']['checkpoint_id']}")
```

### 回到过去

```python
# 找到要回到的 Checkpoint
history = list(app.get_state_history(config))
old_checkpoint = history[3]  # 第3个快照

# ⭐ 从那个点继续执行
result = app.invoke(
    new_input,
    old_checkpoint.config,  # 使用旧快照的 config
)
```

### 分叉

```
Checkpoint_0 → Checkpoint_1 → Checkpoint_2 → Checkpoint_3
                    │
                    └──→ Fork_1 → Fork_2  (从 Checkpoint_1 分叉)
```

从同一个历史点出发，尝试不同的输入或策略：

```python
# 从 Checkpoint_1 分叉
fork_config_a = {"configurable": {
    "thread_id": "fork_a",
    "checkpoint_id": checkpoint_1_id,
}}
fork_config_b = {"configurable": {
    "thread_id": "fork_b",
    "checkpoint_id": checkpoint_1_id,
}}

result_a = app.invoke(input_a, fork_config_a)
result_b = app.invoke(input_b, fork_config_b)
```

## 3. 存储后端详解

### MemorySaver

```python
from langgraph.checkpoint.memory import MemorySaver

memory = MemorySaver()
app = graph.compile(checkpointer=memory)

# 特点：
# - 数据在内存中，进程退出就丢失
# - 速度最快
# - 适合开发/测试
# - 不支持多进程共享
```

### SqliteSaver

```python
from langgraph.checkpoint.sqlite import SqliteSaver

# 文件模式：数据持久化到文件
with SqliteSaver.from_conn_string("checkpoints.db") as saver:
    app = graph.compile(checkpointer=saver)
    result = app.invoke(input, config)

# 内存模式：和 MemorySaver 类似但有 SQL 查询能力
with SqliteSaver.from_conn_string(":memory:") as saver:
    ...

# 特点：
# - 单文件，简单
# - 重启后数据还在
# - 不支持并发写入（SQLite 限制）
# - 适合单用户/本地应用
```

### PostgresSaver

```python
from langgraph.checkpoint.postgres import PostgresSaver

# 安装：pip install langgraph-checkpoint-postgres

with PostgresSaver.from_conn_string(
    "postgresql://user:pass@host:5432/dbname"
) as saver:
    saver.setup()  # 创建必要的表
    app = graph.compile(checkpointer=saver)

# 异步版本
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

async with AsyncPostgresSaver.from_conn_string(conn_str) as saver:
    await saver.setup()
    app = graph.compile(checkpointer=saver)

# 特点：
# - 生产级持久化
# - 支持多进程/多实例并发
# - 支持事务
# - 需要运维 PostgreSQL
```

### 存储选型

```
开发环境
└── MemorySaver（快速迭代）

个人项目 / 小团队
└── SqliteSaver（简单持久化）

生产环境
├── PostgresSaver（标准选择）
└── 自定义 Checkpointer（特殊需求）
```

## 4. 中断与恢复

### 基本流程

```
1. 用户调用 invoke → 图执行到 interrupt 点 → 暂停
2. 用户查看 state → 决定操作
3. 用户调用 invoke(None) → 从暂停点继续
```

### interrupt_before vs interrupt_after

```
interrupt_before=["node_b"]
  START → node_a → [暂停] → node_b → END
                     ↑
             暂停在 node_b 执行前
             可以修改即将输入给 node_b 的 state

interrupt_after=["node_a"]
  START → node_a → [暂停] → node_b → END
                     ↑
             暂停在 node_a 执行后
             可以审核 node_a 的输出
```

### 恢复的三种方式

```python
config = {"configurable": {"thread_id": "demo"}}

# 方式 1：直接继续
app.invoke(None, config)

# 方式 2：修改 state 后继续
app.update_state(config, {"draft": "修改后的内容"})
app.invoke(None, config)

# 方式 3：以特定节点的身份更新（让图以为是该节点的输出）
app.update_state(config, {"result": "人工结果"}, as_node="reviewer")
app.invoke(None, config)
```

### as_node 的用途

```python
# 图：START → generate → review → END
# 中断在 review 之前

# 正常恢复：执行 review 节点
app.invoke(None, config)

# ⭐ 跳过 review：以 review 的身份直接写入结果
app.update_state(
    config,
    {"approved": True},
    as_node="review",  # 图认为 review 已经执行完了
)
app.invoke(None, config)  # 从 review 的下一个节点继续
```

## 5. 生产级持久化考虑

### 数据量估算

```
单条对话（20轮）：
- 每轮 2 条消息（Human + AI）× 平均 500 token
- 每个 Checkpoint 存完整消息历史
- 第 N 轮的 Checkpoint 包含 2N 条消息

存储增长：O(N²)（N = 轮数）

优化：
1. trim_messages：只保留最近 K 条
2. 消息摘要：长对话压缩
3. 定期清理旧 Checkpoint
```

### 清理策略

```python
# 只保留最近 N 个 Checkpoint
def cleanup_old_checkpoints(saver, thread_id, keep=10):
    history = list(saver.list({"configurable": {"thread_id": thread_id}}))
    to_delete = history[keep:]  # 保留前 keep 个
    for cp in to_delete:
        saver.delete(cp.config)
```

### 多租户

```python
# thread_id 的设计
config = {"configurable": {
    "thread_id": f"user_{user_id}_session_{session_id}"
}}

# 命名规范建议：
# "{user_id}_{purpose}_{timestamp}"
# "alice_chat_20240101"
# "bob_rag_research_20240315"
```

## 面试常见问题

### Q1: Checkpoint 和数据库事务有什么区别？

共同点：都是状态的一致性快照。

区别：
- 数据库事务关注**ACID**（原子性、一致性、隔离性、持久性）
- Checkpoint 关注**可恢复性**和**时间旅行**
- 数据库事务失败会回滚，Checkpoint 失败保留在最后成功的点
- Checkpoint 形成链表结构（parent_id），支持历史遍历

### Q2: 如何实现跨服务器的 Agent 恢复？

1. 使用共享存储后端（PostgreSQL）
2. 服务器 A 执行到 interrupt → 保存 Checkpoint
3. 服务器 B 加载同一个 thread_id 的最新 Checkpoint
4. 服务器 B 调用 invoke(None, config) → 从中断点继续

前提：图的定义必须一致（同样的节点和边）。

### Q3: 图定义变更后，旧的 Checkpoint 还能用吗？

取决于变更程度：
- **添加节点**：通常兼容——新节点不影响旧路径
- **删除节点**：如果暂停在被删除的节点 → 不兼容
- **修改 State**：如果新字段没有默认值 → 不兼容
- **修改 Reducer**：可能导致旧快照与新逻辑不一致

最佳实践：版本化 thread_id，重大变更时创建新会话。
