# LangChain 进阶 & 原理深入文档

> 适用对象：已掌握 LangChain 基础用法（见 code/ 目录 01–15 教程），想深入**架构原理**、掌握**生产最佳实践**的同学。
>
> 每篇文档结构统一：**原理讲解 → 架构剖析 → 代码示例 → 最佳实践 → 常见面试题 → 一句话总结**。

---

## 📚 章节索引

### 第一部分：核心架构

| # | 文档 | 核心内容 |
|---|------|---------|
| 01 | [架构与设计理念](01_architecture.md) | ⭐ 分层架构、Runnable 协议、组件关系、v0.1→v0.3 演进 |
| 02 | [LCEL 深入](02_lcel_deep_dive.md) | ⭐ Runnable 生命周期、管道组合原理、流式传播机制、自定义 Runnable |

### 第二部分：RAG 体系

| # | 文档 | 核心内容 |
|---|------|---------|
| 03 | [RAG 架构模式](03_rag_patterns.md) | ⭐⭐ Naive RAG → Advanced RAG → Modular RAG 演进、各种优化技术 |
| 04 | [嵌入与检索原理](04_embedding_retrieval.md) | ⭐ 向量空间模型、ANN 索引结构、混合检索、重排序 |

### 第三部分：Agent 体系

| # | 文档 | 核心内容 |
|---|------|---------|
| 05 | [Agent 架构模式](05_agent_patterns.md) | ⭐⭐ ReAct、Plan-and-Execute、Self-Refine、多 Agent 协作 |
| 06 | [LangGraph 深入](06_langgraph_deep_dive.md) | ⭐ 状态图理论、Checkpoint、Human-in-the-loop、子图、Supervisor 模式 |

### 第四部分：生产化

| # | 文档 | 核心内容 |
|---|------|---------|
| 07 | [生产部署](07_production.md) | ⭐ LangServe/FastAPI 部署、缓存、限流、错误处理、安全 |
| 08 | [可观测性与评估](08_observability_eval.md) | ⭐ LangSmith 追踪、评估框架、指标设计、A/B 测试 |

---

## 🎯 推荐学习路线

```
快速掌握（1 周）           系统深入（3 周）
───────────               ───────────
Day 1-2: 01 02（架构核心）  Week 1: 01 02（架构）
Day 3-4: 03 04（RAG 体系）  Week 2: 03 04 05 06（RAG + Agent）
Day 5-7: 05 06（Agent）    Week 3: 07 08（生产化）
```

---

## 🆚 与 agent/ 目录的关系

```
agent/ 目录      → Agent 的通用理论（框架无关）
langchain/knowledge/ → LangChain 的具体实现原理
```

两者互补：先读 `agent/` 理解 Agent 的设计模式，再读本目录看 LangChain 怎么实现这些模式。
