# LangGraph 学习指南

## 目录结构

| 序号 | 目录 | 主题 | 核心概念 |
|------|------|------|----------|
| 01 | quickstart | 快速上手 | StateGraph, Node, Edge, START/END, compile |
| 02 | state_reducer | State 与 Reducer | TypedDict, Annotated, operator.add, 自定义 reducer |
| 03 | conditional_edges | 条件边与路由 | add_conditional_edges, 循环图, 自我纠正 |
| 04 | chatbot | 聊天机器人 | MessagesState, MemorySaver, thread_id, trim_messages |
| 05 | tool_agent | 工具 Agent | Tool Calling, ToolNode, create_react_agent |
| 06 | human_in_the_loop | 人机交互 | interrupt_before/after, update_state, 审批流程 |
| 07 | checkpoint | 检查点持久化 | MemorySaver, SqliteSaver, 状态历史, 时间旅行 |
| 08 | subgraph | 子图与模块化 | 子图嵌入, State 转换, 子图工厂 |
| 09 | multi_agent | 多 Agent 协作 | Supervisor, Handoff, 专家分工 |
| 10 | streaming | 流式输出 | stream modes, astream_events, SSE |
| 11 | error_handling | 错误处理 | 重试, Fallback, handle_tool_errors, recursion_limit |
| 12 | map_reduce | 并行执行 | Send API, Fan-out/Fan-in, Map-Reduce |

## 学习路线

```
第一阶段：基础（1-3）
  01 快速上手 → 理解 StateGraph 三要素
  02 State/Reducer → 掌握状态管理核心
  03 条件边 → 理解图的动态路由

第二阶段：应用（4-6）
  04 聊天机器人 → 用 LLM 构建对话
  05 工具 Agent → ReAct 模式
  06 人机交互 → 人工审核与确认

第三阶段：工程化（7-9）
  07 检查点 → 状态持久化
  08 子图 → 模块化设计
  09 多 Agent → 复杂协作系统

第四阶段：进阶（10-12）
  10 流式输出 → 实时用户体验
  11 错误处理 → 生产级容错
  12 并行执行 → 性能优化
```

## 环境准备

```bash
pip install langgraph langchain-openai langchain-core python-dotenv
```

创建 `.env` 文件：
```
OPENAI_API_KEY=your-api-key
```

## 与 LangChain 的关系

```
langchain-core   →  基础抽象（Runnable, Messages, Tools）
langchain        →  组件库（Models, Prompts, Parsers）
langgraph        →  编排框架（StateGraph, 条件边, 持久化）
```

LangGraph 建立在 langchain-core 之上，是构建复杂 Agent 的推荐方式。

## 与 agent/ 目录的关系

- `agent/` → 框架无关的 Agent 理论（架构、评估、编排模式）
- `langchain/` → LangChain 框架的使用（LCEL, RAG, Tools）
- `langgraph/` → LangGraph 编排框架（状态图, 持久化, 多 Agent）
