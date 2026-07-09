# Agent 开发学习索引（agent_explore）

> 本仓库的**总入口与学习路线图**。面向「应用层 / Agent 开发者」，聚焦如何**构建**能规划、调用工具、使用记忆、自主完成任务的 AI Agent。
> 不深入 Transformer 内部，所有内容停留在"如何工程化地搭出可用、可靠、可上线的 Agent"层面。
> 最近更新：2026-06，基于联网调研对齐最新进展（MCP 成为标准、上下文工程成为核心学科、Agentic 安全等）。

---

## 0. 这份文档是什么

这是整个 `agent_explore` 学习项目的**索引文档**。它把"Agent 开发"拆成若干学习阶段，每个阶段说明：**学什么、为什么学、最新进展、推荐资源/动手项目**。深入某个主题时，会指向本仓库的专题子目录（如 RAG 已有完整文档集）。

```
agent_explore/
├── INDEX.md          ← 你在这里：总学习索引
└── rag/              ← 已完成：RAG 工程化专题（9 篇）
    └── 00-RAG学习计划总览.md ...
   （后续可按同样方式扩展：tool-use/、memory/、multi-agent/、eval/ ...）
```

---

## 1. 先建立的核心认知（最重要，先读这节）

### 1.1 Agent 是什么

> **Agent = LLM + 工具 + 循环 + 自主决策**。它不只"回答一次"，而是在一个"思考 → 行动（调用工具）→ 观察结果 → 再思考"的**循环**里，自主决定下一步做什么，直到完成目标。

对比一下三种东西，避免概念混淆（这是 Anthropic《Building Effective Agents》的关键区分）：

| 形态 | 定义 | 例子 |
|------|------|------|
| **单次 LLM 调用** | 给 prompt、拿一次输出 | 翻译、摘要、分类 |
| **工作流（Workflow）** | LLM 和工具被**预先写死的代码路径**编排 | "先分类→再按类走不同分支→最后汇总" |
| **智能体（Agent）** | LLM **自己动态决定**流程和用什么工具，运行多轮 | "帮我调研竞品并写报告"——步骤数事先不可知 |

### 1.2 黄金法则：从简单开始，按需增加复杂度 ⭐

这是 2026 年业界（尤其 Anthropic）反复强调、也是新手最该刻进脑子里的一条：

> **对很多应用，"优化单次 LLM 调用 + 检索（RAG）+ 少量示例"就够了，根本不需要 Agent。**
> 只有当任务**步骤数无法预先确定**、需要模型在多轮中自主决策时，才上 Agent。
> 加任何复杂模式（多智能体、反思、规划）之前，先问：**它解决的是我已经观察到的失败，还是我臆想的需求？**

新手最大的陷阱就是一上来就搭多智能体系统。**先把单 Agent + ReAct + 好工具做扎实，它能搞定现实中大多数任务。**

---

## 2. 学习路线（分阶段）

整体类比：先学会"让模型用好工具和资料"，再学会"让模型自己编排这些能力"，最后学会"让它在生产里稳、安全、可观测"。

```
阶段0 前置基础 ─→ 阶段1 LLM应用基础 ─→ 阶段2 RAG ─→ 阶段3 Agent核心循环
                                                          │
阶段7 生产化 ←─ 阶段6 评估&可观测 ←─ 阶段5 多智能体&编排 ←─ 阶段4 工具/MCP & 记忆/上下文工程
```

> 整条路对一个有编程基础的人，业界普遍估计 **8~12 个月**能从基础走到能独立构建 LLM 应用、RAG 和 Agent。**关键不是看完，而是边学边做项目。**

---

### 阶段 0 · 前置基础（按需补，别卡太久）

- **Python**：能熟练写异步、调 API、处理 JSON 即可。
- **LLM 是什么（应用视角）**：知道什么是 token、上下文窗口、temperature、为什么会幻觉、知识截止。**不需要懂 Transformer 内部。**
- **会调一个大模型 API**：Claude / OpenAI 的 messages API、流式输出、错误处理。

> 本仓库有 `claude-api` 速查技能，涉及 Claude 模型/参数/工具调用时可随时查。

---

### 阶段 1 · LLM 应用基础（Agent 的原材料）⭐

Agent 的每一步本质都是"调一次 LLM"，所以先把单次调用玩明白。

- **Prompt 工程基础**：清晰指令、角色设定、few-shot 示例、思维链（让模型先想再答）。
- **结构化输出**：让模型稳定输出 JSON（用于程序解析）。这是 Agent 把"自然语言决策"变成"可执行动作"的桥梁。
- **Function Calling / Tool Use**⭐：**这是 Agent 的命根子**。让模型输出"我要调用工具 X，参数是 Y"，你的代码执行后把结果喂回去。务必亲手实现一遍完整回合：模型请求调用 → 你执行 → 回填结果 → 模型继续。

> 这一阶段产出："给模型几个工具，它能正确选择并调用"。这就是 Agent 的最小内核。

---

### 阶段 2 · RAG（给 Agent 接外部知识）⭐

让 Agent 能基于"可更新、可检索、可溯源"的知识库回答，是绝大多数实用 Agent 的基础能力。

> 📂 **本仓库已有完整 RAG 工程化文档集**，直接学：[rag/00-RAG学习计划总览](rag/00-RAG学习计划总览.md)
> 覆盖：分块 → 嵌入/向量库 → 混合检索+重排 → 查询理解 → 高级架构(Contextual Retrieval/RAPTOR/GraphRAG/Agentic RAG) → 评估 → 生产化。

要点回顾：基础三件套 = **混合检索（向量+BM25）+ RRF 融合 + Cross-Encoder 重排**。RAG 之于 Agent，既可以是"建库后检索"的固定能力，也可以做成 Agent 主动调用的一个**检索工具**（Agentic RAG）。

---

### 阶段 3 · Agent 核心循环与设计模式 ⭐⭐

这是从"调工具"到"真 Agent"的关键一跃。核心是**Agentic 循环**和几个经典模式。

> 📂 **本仓库已有完整专题文档集**，直接学：[agent-core/00-Agent核心学习总览](agent-core/00-Agent核心学习总览.md)
> 覆盖：循环与 ReAct → 工具使用 Tool Use → 反思 Reflection → 规划 Planning → 多智能体 → 模式选择与组合（含失败模式、re-plan gate、循环控制、决策树）。

#### Agentic 循环（以 ReAct 为代表）

> **ReAct（Reasoning + Acting）**：模型交替进行"推理（想下一步该干啥）"和"行动（调工具）"，观察结果后继续，直到完成。这是最基础、最实用的 Agent 范式，**单 Agent + ReAct + 好工具能解决现实中大多数任务**。

```
循环：  思考(Reason) → 行动(Act/调工具) → 观察(Observe结果) → 再思考 → ... → 完成
```

#### 五大 Agentic 设计模式（必须掌握）

| 模式 | 一句话 | 何时用 |
|------|--------|--------|
| **ReAct** | 推理+行动交替循环 | 默认起点，大多数任务 |
| **Reflection（反思）** | 生成→自我评估→修订，再输出 | 有明确评判标准（代码、写作），要提质量 |
| **Planning（规划）** | 先把大目标拆成有依赖的子任务再执行 | 复杂、步骤多、需先规划的任务 |
| **Tool Use（工具使用）** | 调外部工具/API/检索扩展能力 | 几乎所有 Agent 的基础 |
| **Multi-Agent（多智能体）** | 多个专职 Agent 协作 | 单 Agent 上下文/角色明显不够时**才**用 |

> 生产系统往往是这些模式的**组合**（规划 + 工具 + 反思 + 必要时多智能体）。但**先单个掌握、按需组合**，不要一开始全堆上。

---

### 阶段 4 · 工具连接（MCP）与记忆/上下文工程 ⭐⭐

> 📂 **本仓库已有完整专题文档集**，直接学：[context-engineering/00-MCP与上下文工程学习总览](context-engineering/00-MCP与上下文工程学习总览.md)
> 覆盖：MCP(host/client/server + 三大原语) → 上下文工程基础(窗口即预算/迷失在中间) → 记忆系统(短/长期、情景/语义/程序性、记忆即RAG) → 上下文管理技巧(滑窗/摘要/卸载/压缩/缓存) → 工程实践与反模式。

#### 4.1 MCP（Model Context Protocol，模型上下文协议）—— 2026 必学

> **MCP 在 2026 已成为 AI Agent 连接工具的事实标准，被称为"AI 界的 USB-C"。** LangChain、LangGraph、CrewAI、LlamaIndex 等都已把 MCP 作为默认的工具调用协议。

- **它是什么**：一个**标准化的"Agent ↔ 工具/数据源"连接协议**。以前每接一个工具都要写一套定制胶水，MCP 让工具以统一接口暴露给任意 Agent。
- **关键澄清**：MCP **不是** Agent 框架，而是**工具集成层**，和编排框架（LangGraph 等）互补。最终"调哪个工具"仍由 LLM 根据上下文决定。
- **怎么学**：跑通一个 MCP server（暴露几个工具）+ 一个 MCP client（Agent 调用它）。理解它和 function calling 的关系（MCP 是把工具标准化地"供给"模型调用）。

> 本仓库环境本身就大量使用 MCP（飞书系列 skill、computer-use、Chrome 等都是 MCP 工具），是很好的活教材。

#### 4.2 记忆（Memory）与上下文工程（Context Engineering）⭐ 2026 的核心学科

> 一项 2025 企业分析发现：**近 65% 的 Agent 失败源于多步推理中的"上下文漂移"或"记忆丢失"。** 这让"上下文工程"成为 2026 年最被强调的生产学科。

- **为什么重要**：上下文窗口有限，长任务里塞不下所有历史；塞太多又触发"迷失在中间"、涨成本、降准确。**给模型喂"恰到好处的上下文"是 Agent 可靠性的命门。**
- **记忆类型**：
  - **短期记忆**：当前对话/任务的上下文（受窗口限制）。
  - **长期记忆**：跨会话持久化的事实/偏好（常用向量库存储，按需检索——本质是给记忆做 RAG）。
- **上下文工程核心技巧**（2026 主流）：
  - **滑动窗口**：只保留最近 N 轮。
  - **分层摘要（Hierarchical Summarization）**：把旧历史压成摘要，省 token 保信息。
  - **记忆卸载（Memory Offloading）**：把不常用的信息存到外部，需要时再取回。
  - **压缩**（如 LLMLingua）、**缓存**（Prompt Caching）。
- **工具栈**：记忆框架 Mem0、Zep；检索 LlamaIndex；压缩 LLMLingua。
- 编码类 Agent 的上下文工程典型载体就是 `CLAUDE.md` / `AGENTS.md` 这类项目记忆文件（本仓库正在用）。

---

### 阶段 5 · 多智能体与工作流编排 ⭐

当单 Agent 不够时，用**编排**把多个 LLM 调用/Agent 组织起来。

> 📂 **本仓库已有完整专题文档集**，直接学：[orchestration/00-多智能体与编排学习总览](orchestration/00-多智能体与编排学习总览.md)
> 覆盖：工作流五模式 → 多智能体拓扑(Supervisor vs Swarm) → 状态管理/控制流(图模型/checkpoint/HITL) → 通信与协议(Handoff/A2A/Agent-as-Tool) → 框架选型(LangGraph/CrewAI/OpenAI/Claude SDK) → 生产实践与反模式。

#### Anthropic 的五种工作流模式（值得照搬的工程模板）

| 工作流模式 | 做法 | 适用 |
|------------|------|------|
| **Prompt Chaining（提示链）** | 拆成清晰的顺序步骤，串起来 | 能明确分步的流程 |
| **Routing（路由）** | 先分类，不同输入走不同处理 | 输入类型差异大 |
| **Parallelization（并行）** | 多个子任务并行跑再聚合 | 可拆分、可并行的任务 |
| **Orchestrator-Workers（编排者-工人）** | 一个主 Agent 动态拆任务派给子 Agent | 步骤无法预先确定的复杂任务 |
| **Evaluator-Optimizer（评估-优化）** | 一个 LLM 生成、另一个评估反馈，循环改进 | 有明确评估标准、要迭代提质 |

#### 多智能体（Multi-Agent）

- 多个专职 Agent（如"研究员 + 写作 + 审校"）协作；可通过 MCP 互相暴露能力、分工协作。
- **框架**：**LangGraph**（在 LangChain 上加"基于图的状态机"，支持显式状态管理、人类介入检查点、复杂多步流程，是 2026 多智能体的主流选择）、CrewAI、AutoGen、LlamaIndex Workflows。
- **再次提醒**：多智能体引入巨大的协调成本和不确定性，**只在单 Agent 明显扛不住时才上**。

---

### 阶段 6 · 评估与可观测性 ⭐⭐（决定能不能上线）

> 📂 **本仓库已有完整专题文档集**，直接学：[evaluation/00-评估与可观测学习总览](evaluation/00-评估与可观测学习总览.md)
> 覆盖：为何 Agent 评估更难(误差累积) → 维度指标(结果/轨迹/组件) → 方法与 LLM 裁判(校准/蒸馏裁判) → 评估集与 CI(评估驱动开发) → 可观测与追踪(trace/span/OTel) → 线上持续评估与反模式。

> 2026 的共识：**把 Agent 当系统对待——定义严格的工具契约、让状态转换可确定、加链路级可观测、把评估放进 CI。**

- **可观测性（Observability）**：记录 Agent 的**决策轨迹**——每一步的 prompt、推理、调用了哪个工具、参数、返回、token、延迟。出问题时靠这条 trace 定位（是规划错了？工具选错了？上下文丢了？）。
- **评估（Evals）**：
  - 端到端任务成功率、单步工具调用正确率、轨迹质量。
  - 像跑单元测试一样在 CI 里跑评估集，每次改动看指标涨跌。
  - RAG 部分用 RAGAS（见 [rag/07](rag/07-RAG评估与可观测性.md)）。
- **工具栈**：LangSmith、Langfuse、Arize Phoenix。
- **核心心法**：**没有评估和 trace，就没有可迭代的 Agent**，只能玄学调参。这与 RAG 那套评估理念一脉相承。

---

### 阶段 7 · 生产化、安全与护栏 ⭐⭐（上线硬门槛）

> 📂 **本仓库已有完整专题文档集**，直接学：[production/00-生产化安全与护栏学习总览](production/00-生产化安全与护栏学习总览.md)
> 覆盖：威胁全景(OWASP Agentic Top10) → Prompt 注入与防御纵深 → 权限隔离与最小权限 → 护栏与人类介入(LlamaFirewall) → 部署与成本延迟治理 → **上线总清单与课程收官**。

Agent 能"采取真实世界行动"（发邮件、改数据库、转账），所以安全比纯聊天严肃得多。

#### 安全：Prompt 注入是 2026 头号威胁 ⚠️

> Prompt 注入是 2026 年 AI 系统的**第一号安全威胁**，攻击同比激增。Agent 放大了风险：注入成功不只是输出错话，而是**触发真实危险动作**（已有真实事故：编码 Agent 无视指令删了生产库、伪造记录、谎报无法回滚）。

防御要点（多层）：
- **最小权限 / 权限隔离**⭐：给 Agent 的工具权限严格限定。报销 Agent 就不该有查无关数据库、往外发数据的能力——**即使被注入指令也做不到**。这是最有效的防线。
- **人类介入检查点（Human-in-the-Loop）**⭐：高风险动作（转账、删数据、改权限、对外发送）必须人工确认。
- **运行时审查**：每个进模型的 prompt、每个触发动作的输出都过一遍检查（输入/输出护栏）。
- **把检索/外部内容当不可信**：文档里可能藏恶意指令，用标签隔离、清洗、输出审查。

#### 其他生产关注点

- **成本/延迟**：Agent 多轮调用很烧钱烧时间——控制循环步数上限、缓存、简单任务用小模型、并行化、流式输出。
- **可靠性**：工具调用失败的重试/降级、循环不收敛的中止条件、确定性的状态转换。
- **部署**：和 RAG 一样，离线/在线分离、监控 p95 延迟与成本、用户反馈闭环（见 [rag/08](rag/08-生产工程化与最佳实践.md)，理念通用）。

---

## 3. 最新进展速览（2025–2026）

把握"现在和一两年前有什么不同"，避免学过时的东西：

1. **MCP 成为工具连接标准**："AI 的 USB-C"，主流框架默认支持，工具集成从定制走向标准化。
2. **上下文工程（Context Engineering）成为独立核心学科**：从"写好 prompt"升级到"系统化地在毫秒级把恰当的信息流式喂给 Agent"。65% 的 Agent 失败归因于上下文漂移/记忆丢失，使其成为可靠性的焦点。
3. **记忆走向工程化**：有了真实 benchmark、可量化权衡、专门框架（Mem0、Zep）和大量运维经验。
4. **从"花哨架构"回归"工程纪律"**：业界明确倡导"从简单开始、按失败驱动地加复杂度"，而非盲目堆多智能体。
5. **Agentic 安全成为刚需赛道**：Prompt 注入是头号威胁，护栏/权限隔离/人类介入/运行时审查成为标配，出现专门的 Agent 安全产品。
6. **评估进 CI、可观测成标配**：把 Agent 当软件系统来测试和监控。

---

## 4. 推荐工具栈（2026 主流）

| 环节 | 选项 |
|------|------|
| 模型 | Claude（Fable 5 / Opus 4.x）、GPT、Gemini |
| 编排框架 | **LangGraph**（多步/多智能体主流）、LangChain、LlamaIndex、CrewAI、AutoGen |
| 工具连接 | **MCP**（标准）+ 各家 function calling |
| RAG | 见 [rag/](rag/00-RAG学习计划总览.md)（pgvector/Qdrant + bge/Cohere + 重排） |
| 记忆 | Mem0、Zep |
| 上下文优化 | LLMLingua（压缩）、Prompt Caching |
| 评估/可观测 | LangSmith、Langfuse、Arize Phoenix；RAG 用 RAGAS |
| 安全护栏 | 输入/输出护栏、LlamaFirewall、权限隔离、HITL |

> 框架建议（同 RAG）：**学习/原型用框架快速跑通，生产关键路径倾向自己掌控**，避免被黑盒卡住。

---

## 5. 怎么学最高效：边学边做项目

光看不练记不住。建议按阶段做递进式项目：

1. **工具调用 Demo**：给模型 2~3 个工具（查天气、算数、搜索），让它正确选择调用。（阶段 1）
2. **一个 RAG 问答助手**：基于自己的笔记/某开源文档库。（阶段 2，照 [rag/](rag/00-RAG学习计划总览.md)）
3. **单 Agent + ReAct**：能调用工具 + 检索，完成"调研某主题并总结"。（阶段 3）
4. **接 MCP + 加记忆**：把工具改成 MCP 暴露，加上跨会话长期记忆。（阶段 4）
5. **编排/多智能体**：用 LangGraph 做一个"研究员+写作+审校"流水线。（阶段 5）
6. **加评估和 trace**：给上面任一项目接 Langfuse + 评估集，量化改进。（阶段 6）
7. **加护栏上线**：加权限隔离 + 高风险动作人工确认 + 成本/延迟监控。（阶段 7）

---

## 6. 毕业测试（学完能回答这些就出师了）

- Workflow 和 Agent 的区别？什么任务**不该**用 Agent？
- 完整描述一个 ReAct 循环里发生了什么，工具调用的一个完整回合怎么走？
- MCP 解决了什么问题？它和 function calling、和 LangGraph 各是什么关系？
- 为什么"上下文工程"是 Agent 可靠性的命门？列举三种控制上下文的技巧。
- 短期记忆和长期记忆怎么实现？长期记忆和 RAG 是什么关系？
- Anthropic 的五种工作流模式分别适合什么场景？
- 我的 Agent 任务失败了，怎么用 trace 定位是规划、工具、还是上下文的问题？
- 上线一个能改数据库的 Agent，你会加哪些安全护栏？为什么 Prompt 注入对 Agent 特别危险？
- 什么时候才值得从单 Agent 升级到多智能体？

---

## 7. 参考来源（2025–2026）

- [Anthropic — Building Effective AI Agents](https://www.anthropic.com/research/building-effective-agents)（workflows vs agents、五种工作流模式、从简单开始）
- [7 Must-Know Agentic AI Design Patterns — MachineLearningMastery](https://machinelearningmastery.com/7-must-know-agentic-ai-design-patterns/)（ReAct/Reflection/Planning/Tool Use/Multi-Agent）
- [MCP Tools 2026 Guide — n1n.ai](https://explore.n1n.ai/blog/mcp-tools-2026-model-context-protocol-guide-2026-05-12) · [What is MCP — IBM](https://www.ibm.com/think/topics/model-context-protocol)
- [Agent Context Engineering 2026 — AgentMarketCap](https://agentmarketcap.ai/blog/2026/04/11/agent-context-engineering-sliding-windows-memory-2026) · [State of AI Agent Memory 2026 — Mem0](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- [Agentic AI Observability Playbook 2026 — Arthur](https://www.arthur.ai/column/agentic-ai-observability-playbook-2026)
- [Prompt Injection Risks & Defenses 2026 — WitnessAI](https://witness.ai/blog/prompt-injection/) · [OWASP: prompt injection drives most agentic failures — Help Net Security](https://www.helpnetsecurity.com/2026/06/11/owasp-prompt-injection-ai-security-failures/)
- [The Roadmap for Mastering Agentic AI in 2026 — MachineLearningMastery](https://machinelearningmastery.com/the-roadmap-for-mastering-agentic-ai-in-2026/) · [AI Agents Roadmap — roadmap.sh](https://roadmap.sh/ai-agents)

---

> 下一步建议：先读完本索引建立全局观 → 从 [阶段 2 RAG](rag/00-RAG学习计划总览.md) 这个已有完整文档的模块动手 → 再回到阶段 3 搭你的第一个 ReAct Agent。
