# LangChain 从零到实战 —— 代码教程

> 每个 `main.py` 既是**可运行的代码**，也是**详细注释的教材**。
>
> 环境要求：Python 3.10+，需设置 `OPENAI_API_KEY` 环境变量（推荐用 `.env` 文件）。

---

## 🚀 快速开始

```bash
# 1. 安装核心依赖
pip install langchain langchain-openai langchain-community langchain-text-splitters
pip install python-dotenv faiss-cpu pydantic

# 2. 配置 API Key
echo "OPENAI_API_KEY=sk-xxx" > .env

# 3. 运行任意教程
cd 01_quickstart && python main.py
```

---

## 📚 章节索引

### 第一阶段：基础核心（必学）

| # | 目录 | 主题 | 核心知识点 |
|---|------|------|-----------|
| 01 | [01_quickstart](01_quickstart/) | 快速上手 | 安装配置、第一个调用、LCEL 语法、核心概念全景 |
| 02 | [02_models_prompts](02_models_prompts/) | 模型与提示词 | ChatModel 配置切换、PromptTemplate、FewShot、MessagesPlaceholder |
| 03 | [03_output_parsers](03_output_parsers/) | 输出解析 | StrOutputParser、JsonOutputParser、PydanticOutputParser、with_structured_output |
| 04 | [04_lcel_chains](04_lcel_chains/) | LCEL 深入 | Runnable 协议、Passthrough、Parallel、Lambda、Branch |
| 05 | [05_memory_history](05_memory_history/) | 记忆与对话 | ChatMessageHistory、RunnableWithMessageHistory、历史裁剪 |

### 第二阶段：RAG 检索增强（重点）

| # | 目录 | 主题 | 核心知识点 |
|---|------|------|-----------|
| 06 | [06_document_loaders](06_document_loaders/) | 文档加载 | Document 对象、TextLoader、CSVLoader、PDF、网页、自定义 Loader |
| 07 | [07_text_splitters](07_text_splitters/) | 文本分割 | RecursiveCharacterTextSplitter、代码分割、参数调优 |
| 08 | [08_embeddings_vectorstores](08_embeddings_vectorstores/) | 嵌入与向量库 | OpenAIEmbeddings、FAISS、Chroma、向量数据库对比 |
| 09 | [09_retrievers](09_retrievers/) | 检索器 | 基本检索、MMR、MultiQuery、ContextualCompression、自定义 |
| 10 | [10_rag](10_rag/) | RAG 实战 | 端到端 RAG 链、来源引用、对话式 RAG、优化方向 |

### 第三阶段：Agent 与工具

| # | 目录 | 主题 | 核心知识点 |
|---|------|------|-----------|
| 11 | [11_tools](11_tools/) | 工具 | @tool 装饰器、StructuredTool、bind_tools、工具调用循环 |
| 12 | [12_agents](12_agents/) | 智能体 | create_tool_calling_agent、AgentExecutor、推理循环、最佳实践 |
| 13 | [13_callbacks_streaming](13_callbacks_streaming/) | 回调与流式 | 自定义回调、Token 计数、stream/astream_events、FastAPI 流式 |

### 第四阶段：进阶技术

| # | 目录 | 主题 | 核心知识点 |
|---|------|------|-----------|
| 14 | [14_structured_output](14_structured_output/) | 结构化输出 | 枚举/嵌套/可选、信息提取、分类、Union 路由 |
| 15 | [15_langgraph](15_langgraph/) | LangGraph | StateGraph、条件边、ReAct Agent、Annotation/Reducer |

---

## 🎯 推荐学习路线

```
快速入门（3 天）           完整学习（2 周）
───────────               ───────────
Day 1: 01 02 03           Week 1: 01-10（基础 + RAG）
Day 2: 04 10              Week 2: 11-15（Agent + LangGraph）
Day 3: 11 12              ★ 每个文件都要跑一遍，改参数看效果
```

---

## ⚠️ 常见问题

| 问题 | 解决方案 |
|------|---------|
| `OPENAI_API_KEY` 未设置 | 创建 `.env` 文件或 `export OPENAI_API_KEY=sk-xxx` |
| `ModuleNotFoundError` | `pip install` 对应的包（每个文件开头都有安装说明） |
| API 调用超时 | 检查网络代理设置，或设置 `OPENAI_API_BASE` |
| 中文输出乱码 | Windows 用 PowerShell 而非 Git Bash |

---

## 📦 依赖一览

```bash
# 核心（必装）
pip install langchain langchain-core langchain-openai python-dotenv

# RAG 相关
pip install langchain-community langchain-text-splitters faiss-cpu

# Agent / LangGraph
pip install langgraph

# 可选
pip install chromadb pypdf beautifulsoup4 pydantic
```
