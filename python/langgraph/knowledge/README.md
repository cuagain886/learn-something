# LangGraph 深度知识

## 文档索引

| 文档 | 主题 | 关键词 |
|------|------|--------|
| 01_graph_theory.md | 图计算模型 | 有向图, 状态机, 数据流, Pregel |
| 02_state_management.md | 状态管理深度 | Reducer, 快照, 持久化, CQRS |
| 03_agent_architectures.md | Agent 架构模式 | ReAct, Plan-Execute, 多 Agent, Orchestrator |
| 04_persistence_recovery.md | 持久化与恢复 | Checkpoint, 时间旅行, 分叉, 存储后端 |
| 05_streaming_realtime.md | 流式与实时 | SSE, WebSocket, 事件系统, 背压 |
| 06_production.md | 生产部署 | LangGraph Platform, 可观测性, 扩缩容, 安全 |

## 学习路线

```
理论基础  → 01 图计算模型
状态精通  → 02 状态管理
架构选型  → 03 Agent 架构
工程能力  → 04 持久化 → 05 流式 → 06 生产
```

## 与其他目录的互补

- `agent/` 讲 Agent 的**框架无关理论**
- `langchain/knowledge/` 讲 LangChain **组件实现细节**
- `langgraph/knowledge/` 讲 LangGraph **编排层的设计与实践**

三者结合 = 从理论到框架到工程的完整知识体系。
