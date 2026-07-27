# Agent 开发学习索引

> 本仓库的**总入口与学习路线图**。面向「应用层 / Agent 开发者」，聚焦如何**构建**能规划、调用工具、使用记忆、自主完成任务的 AI Agent。
> 不深入 Transformer 内部，所有内容停留在"如何工程化地搭出可用、可靠、可上线的 Agent"层面。
> 最近更新：2026-07-26（定期复核：确认 MCP 2025-11-25 仍为最新规范、A2A 更新至 1.0.1，纳入 eval awareness 等 5 篇新一手工程文章）。2026-07-19 完成 L3 深度审计：补齐形式化模型、测试时搜索、持久执行、协议边界、评测统计、安全控制平面与 RAG 数据生命周期，并用一手规范/论文校准时效性结论。审计证据见 [DEPTH_AUDIT](DEPTH_AUDIT.md)。

---

## 0. 这份文档是什么

这是整个 `agent/` 学习项目的**索引文档**。它把“Agent 开发”拆成若干学习阶段，每个阶段说明：**学什么、为什么学、最新进展、推荐资源/动手项目**。深入某个主题时，会指向对应专题子目录。

```text
agent/
├── INDEX.md                 ← 你在这里：总学习索引
├── agent-core/              ← 循环、工具、反思、规划、形式化与搜索（9 篇）
├── rag/                     ← RAG 工程化（9 篇）
├── context-engineering/     ← MCP、上下文与记忆（6 篇）
├── orchestration/           ← 工作流、多 Agent 编排与状态（7 篇）
├── evaluation/              ← 评测与可观测（7 篇）
├── production/              ← 安全、护栏与上线（7 篇）
└── systems-engineering/     ← 运行时、持久执行、协议与控制平面（11 篇）
```

---

## 1. 先建立的核心认知（最重要，先读这节）

### 1.1 Agent 是什么

> **入门实现：Agent = 模型 + 状态 + 工具 + 闭环决策 + 运行时控制。形式化地，它是在部分可观测环境中，根据 belief/state 选择动作、接收观察并决定继续、回退或停止的策略。**

“LLM + 工具 + 循环”只描述最小外形；生产正确性还取决于状态所有权、工具副作用、权限、预算、恢复和验证。详见 [形式化模型](agent-core/07-Agent形式化模型与决策理论.md) 与 [Agent Harness](systems-engineering/01-Agent运行时与Harness工程.md)。

对比一下三种东西，避免概念混淆（这是 Anthropic《Building Effective Agents》的关键区分）：

| 形态 | 定义 | 例子 |
|------|------|------|
| **单次 LLM 调用** | 给 prompt、拿一次输出 | 翻译、摘要、分类 |
| **工作流（Workflow）** | LLM 和工具被**预先写死的代码路径**编排 | "先分类→再按类走不同分支→最后汇总" |
| **智能体（Agent）** | LLM **自己动态决定**流程和用什么工具，运行多轮 | "帮我调研竞品并写报告"——步骤数事先不可知 |

### 1.2 黄金法则：从简单开始，按需增加复杂度 ⭐

一个可检验的工程原则是：先建立最简单的可行基线，再用失败证据决定是否增加自主性。

> **对很多应用，"优化单次 LLM 调用 + 检索（RAG）+ 少量示例"就够了，根本不需要 Agent。**
> 当路径确实依赖中间观察、无法可靠预编排，并且动态决策的收益经同预算评测超过额外成本与风险时，才上 Agent。
> 加任何复杂模式（多智能体、反思、规划）之前，先问：**它解决的是我已经观察到的失败，还是我臆想的需求？**

新手最大的陷阱就是一上来堆多智能体。先做单次调用/固定 workflow 基线，再做单 Agent + 好工具；只有观测到上下文、权限边界、任务分区或关键路径并行瓶颈，才增加 Agent 数量。

---

## 2. 学习路线（分阶段）

整体类比：先学会"让模型用好工具和资料"，再学会"让模型自己编排这些能力"，最后学会"让它在生产里稳、安全、可观测"。

```
阶段0 前置基础 ─→ 阶段1 LLM应用基础 ─→ 阶段2 RAG ─→ 阶段3 Agent核心循环
                                                          │
阶段8 系统工程 ←─ 阶段7 生产化 ←─ 阶段6 评估&可观测 ←─ 阶段5 编排 ←─ 阶段4 MCP/上下文
```

> 不给出脱离背景和投入强度的统一“几个月学会”承诺。更可靠的完成标准是：能交付一个有**状态、工具副作用、故障恢复、评测门禁与安全边界**的系统，并用故障注入证明它在异常路径上也成立。

---

### 阶段 0 · 前置基础（按需补，别卡太久）

- **Python**：能熟练写异步、调 API、处理 JSON 即可。
- **LLM 是什么（应用视角）**：知道什么是 token、上下文窗口、temperature、为什么会幻觉、知识截止。**不需要懂 Transformer 内部。**
- **会调一个大模型 API**：Claude / OpenAI 的 messages API、流式输出、错误处理。

> 本仓库有 `claude-api` 速查技能，涉及 Claude 模型/参数/工具调用时可随时查。

---

### 阶段 1 · LLM 应用基础（Agent 的原材料）⭐

Agent 的每一步本质都是"调一次 LLM"，所以先把单次调用玩明白。

- **Prompt / context 基础**：明确目标、约束、成功谓词、可用证据和 few-shot 示例。不要把“要求模型输出完整思维链”当作可靠性或审计方案；系统应记录可见输入、动作、状态转换、证据和业务理由。
- **结构化输出**：让模型稳定输出 JSON（用于程序解析）。这是 Agent 把"自然语言决策"变成"可执行动作"的桥梁。
- **Function Calling / Tool Use**⭐：**这是 Agent 的命根子**。让模型输出"我要调用工具 X，参数是 Y"，你的代码执行后把结果喂回去。务必亲手实现一遍完整回合：模型请求调用 → 你执行 → 回填结果 → 模型继续。

> 这一阶段产出："给模型几个工具，它能正确选择并调用"。这就是 Agent 的最小内核。

---

### 阶段 2 · RAG（给 Agent 接外部知识）⭐

让 Agent 能基于"可更新、可检索、可溯源"的知识库回答，是绝大多数实用 Agent 的基础能力。

> 📂 **本仓库已有完整 RAG 工程化文档集**，直接学：[rag/00-RAG学习计划总览](rag/00-RAG学习计划总览.md)
> 覆盖：检索必要性与四层正确性 → evidence-span 分块 → exact/ANN 与索引 snapshot → 混合检索/重排的候选预算 → 查询 lineage 与路由 → RAPTOR/GraphRAG/Agentic RAG 的错误边界 → claim-citation 评测 → CDC、回填、删除与灾备。

要点回顾：先用 `closed-book → long-context → oracle evidence → distractor` 判断检索是否必要，再分解 `N/R/U/G`（检索必要性、召回、证据利用、生成忠实度）。向量+词法、RRF 和重排是常见候选基线，不是所有语料的默认最优解；必须在固定候选数、上下文和延迟预算下做消融。RAG 既可以是固定检索管线，也可以成为 Agent 主动查询、维护 evidence ledger 并基于边际价值停止的工具。

---

### 阶段 3 · Agent 核心循环与设计模式 ⭐⭐

这是从"调工具"到"真 Agent"的关键一跃。核心是**Agentic 循环**和几个经典模式。

> 📂 **本仓库已有完整专题文档集**，直接学：[agent-core/00-Agent核心学习总览](agent-core/00-Agent核心学习总览.md)
> 覆盖：循环与 ReAct → 工具使用 → 反思 → 规划 → 多智能体 → 模式选择 → **POMDP/belief state 形式化 → ToT/MCTS/LATS 测试时搜索**。

#### Agentic 循环（以 ReAct 为代表）

> **ReAct（Reasoning + Acting）**：模型交替进行决策、行动（调工具）和观察，直到命中成功/失败/预算终止条件。它是未知步骤任务的重要基线，但不保证优于确定性 workflow；应与单次调用、固定工作流和同预算搜索做 paired eval。

```
循环：  思考(Reason) → 行动(Act/调工具) → 观察(Observe结果) → 再思考 → ... → 完成
```

#### 五大 Agentic 设计模式（必须掌握）

| 模式 | 一句话 | 何时用 |
|------|--------|--------|
| **ReAct** | 决策→行动→观察的闭环 | 路径依赖中间观察，且优于单次/固定 workflow 基线 |
| **Reflection（反思）** | 生成→外部/独立评估→修订 | 有能区分候选的反馈；无新证据的同模型自评容易错误相关 |
| **Planning（规划）** | 用 DAG/HTN/条件分支表示依赖并执行 | 长依赖或资源约束需要全局结构，并有计划验证/replan 语义 |
| **Tool Use（工具使用）** | 读取外部状态或产生真实动作 | 已定义 schema、effect/error、授权、幂等与结果验证契约 |
| **Multi-Agent（多智能体）** | 多个专职 Agent 协作 | 单 Agent 上下文/角色明显不够时**才**用 |

> 生产系统往往是这些模式的**组合**（规划 + 工具 + 反思 + 必要时多智能体）。但**先单个掌握、按需组合**，不要一开始全堆上。

---

### 阶段 4 · 工具连接（MCP）与记忆/上下文工程 ⭐⭐

> 📂 **本仓库已有完整专题文档集**，直接学：[context-engineering/00-MCP与上下文工程学习总览](context-engineering/00-MCP与上下文工程学习总览.md)
> 覆盖：MCP initialize/capability/auth/Tasks 边界 → context block 契约与 token ledger → working state/checkpoint 与情景/语义/程序性记忆 → provenance、双时间、CAS、失效、删除与污染恢复 → 确定性 assembler、artifact、压缩保真与安全域缓存。

#### 4.1 MCP（Model Context Protocol，模型上下文协议）

> MCP 是一个已被多种宿主、SDK 和工具生态采用的开放协议，但“开放标准”不等于“所有框架默认启用”，更不意味着接入后自动获得安全性。当前规范版本为 **2025-11-25**；其中用于长任务的 **Tasks 仍是 experimental**，生产接入应锁定协议版本并做能力协商。

- **它是什么**：一个**标准化的"Agent ↔ 工具/数据源"连接协议**。以前每接一个工具都要写一套定制胶水，MCP 让工具以统一接口暴露给任意 Agent。
- **关键澄清**：MCP **不是** Agent 框架，而是**能力连接层**，和编排运行时互补。模型可以提出调用哪个工具；授权视图、schema/语义校验、预算与实际执行必须由 host/控制平面决定。
- **怎么学**：跑通一个 MCP server（暴露几个工具）+ 一个 MCP client（Agent 调用它）。理解它和 function calling 的关系（MCP 是把工具标准化地"供给"模型调用）。

> 学习时不要只验证“能连上”：还要故意测试版本不兼容、capability 缺失、断流重连、OAuth audience 错误、token passthrough、工具超时和降级路径。

#### 4.2 记忆（Memory）与上下文工程（Context Engineering）⭐

> 上下文工程不是“把窗口填满”，而是把有限 token 预算分给当前决策真正需要的指令、状态、证据与工具。长轨迹会持续产生观察结果，摘要又可能丢失约束，因此必须把可恢复的任务状态放在上下文窗口之外。

- **为什么重要**：上下文窗口有限，长任务里塞不下所有历史；塞太多又触发"迷失在中间"、涨成本、降准确。**给模型喂"恰到好处的上下文"是 Agent 可靠性的命门。**
- **必须分开的状态**：
  - **working state / checkpoint**：当前任务的计划、工作项、预算、审批与 effect receipt；它要求确定性恢复，不能只存在消息窗口。
  - **长期记忆**：跨任务事实、经历或过程知识；向量检索只是候选召回方式之一，还必须有来源、有效/记录时间、scope、版本、置信度、冲突和删除语义。
- **上下文工程核心技巧**：
  - **状态投影**：从持久状态按当前决策生成最小 context blocks，而非重放全部聊天。
  - **分层摘要/压缩**：必须以约束、数字、否定、引用和 unresolved item 的保真测试决定是否可用。
  - **artifact offloading**：大结果存不可变 artifact，context 只放 hash/version/ref 与所需切片。
  - **安全域缓存**：cache key 必须绑定 tenant、权限视图、模型/prompt/tool 版本和数据 snapshot。
- **实现选择**：框架/数据库只是候选；用写入门、时间旅行、冲突并发、删除传播、污染恢复和跨版本 replay spike 选型。
- `AGENTS.md` / `CLAUDE.md` 属于有作用域的仓库指令，不应与用户长期记忆或可恢复任务状态混为一谈。

---

### 阶段 5 · 多智能体与工作流编排 ⭐

先以单 Agent 和等预算搜索为基线；当上下文/权限/组织边界或关键路径并行带来可测收益时，再用**编排**组织多个调用或 Agent。

> 📂 **本仓库已有完整专题文档集**，直接学：[orchestration/00-多智能体与编排学习总览](orchestration/00-多智能体与编排学习总览.md)
> 覆盖：节点契约与 join/cancel → 拓扑与 ownership/lease/backpressure → checkpoint/replay/effect/HITL/migration → Agent-as-Tool/Handoff/A2A 1.0 → 框架故障 spike（含 ADK 2.0、Microsoft Agent Framework）→ SLO、跨 Agent trace、因果评测与事故演练。

#### Anthropic 的五种工作流模式（组合模板，收益需评测）

| 工作流模式 | 做法 | 适用 |
|------------|------|------|
| **Prompt Chaining（提示链）** | 拆成清晰的顺序步骤，串起来 | 能明确分步的流程 |
| **Routing（路由）** | 先分类，不同输入走不同处理 | 输入类型差异大 |
| **Parallelization（并行）** | 多个子任务并行跑再聚合 | 可拆分、可并行的任务 |
| **Orchestrator-Workers（编排者-工人）** | 一个主 Agent 动态拆任务派给子 Agent | 步骤无法预先确定的复杂任务 |
| **Evaluator-Optimizer（评估-优化）** | 一个 LLM 生成、另一个评估反馈，循环改进 | 有明确评估标准、要迭代提质 |

#### 多智能体（Multi-Agent）

- manager-style 委派保留最终答案 owner；handoff 转移当前回复 owner；跨系统长任务可用 A2A 1.0 的 Task/Message/Artifact。MCP 主要解决 host 与能力 server 的接入，不能替代完整 Agent 任务协议。
- **框架**：LangGraph、OpenAI Agents SDK、Google ADK 2.0、Microsoft Agent Framework、CrewAI、AutoGen、LlamaIndex Workflows 等。不要按热度选；用 crash、outcome unknown、长审批、取消、迁移和可移植状态 spike 验证。
- **再次提醒**：多智能体引入巨大的协调成本和不确定性，**只在单 Agent 明显扛不住时才上**。

---

### 阶段 6 · 评估与可观测性 ⭐⭐（决定能不能上线）

> 📂 **本仓库已有完整专题文档集**，直接学：[evaluation/00-评估与可观测学习总览](evaluation/00-评估与可观测学习总览.md)
> 覆盖：estimand 与 Agent/环境随机性 → world-state oracle、`pass@k`/`pass^k`、校准与尾部风险 → Judge 偏差/锚点/漂移 → provenance、配对统计、MDE 与序贯检验 → trace invariant、异步 links、隐私采样与 replay 边界 → shadow/canary/A-B、延迟标签和回滚。

> 本项目采用的工程结论是：**把 Agent 当闭环系统对待——定义严格的工具契约、让控制面状态转换可确定、加链路级可观测，并把版本化评估与故障演练放进发布门禁。**

- **可观测性（Observability）**：记录模型可见输入/上下文 manifest、结构化业务理由、工具参数/结果、状态版本、证据、token、延迟和 effect receipt。隐藏 chain-of-thought 不是可靠审计证据，也不应作为系统必须暴露的接口。
- **评估（Evals）**：
  - 先声明要估计的量、任务/环境分布、预算和版本，再选择结果、轨迹与组件指标。
  - 优先用最终世界状态、工具 receipt 或可执行测试作 oracle；LLM Judge 是需校准的测量仪器，不是天然真值。
  - 每次变更用配对样本、置信区间和风险切片判断回归，不能只比较两个平均分。
- **实现选择**：商业或开源 tracing/eval 平台都可以；关键是可导出 trace、固定 schema/版本、保护敏感正文，并能回到原始样本和世界状态复核。
- **核心心法**：**没有评估和 trace，就没有可迭代的 Agent**，只能玄学调参。这与 RAG 那套评估理念一脉相承。

---

### 阶段 7 · 生产化、安全与护栏 ⭐⭐（上线硬门槛）

> 📂 **本仓库已有完整专题文档集**，直接学：[production/00-生产化安全与护栏学习总览](production/00-生产化安全与护栏学习总览.md)
> 覆盖：OWASP ASI01–ASI10 与组合攻击链 → provenance/taint、source-to-sink 和出站控制 → subject/delegator/workload/audience 身份链、PDP/PEP 与 JIT credential → 参数/资源版本绑定审批和 TOCTOU → 排队、deadline、全局预算与重试风暴 → Evidence Gates 和安全退款端到端案例。

Agent 能"采取真实世界行动"（发邮件、改数据库、转账），所以安全比纯聊天严肃得多。

#### 安全：把 Prompt 注入视为控制平面问题 ⚠️

> 对 Agent 而言，Prompt 注入的严重性来自**可达工具、身份权限与副作用半径**：模型被误导本身只是一个环节；若运行时仍允许它带着高权限执行不可逆动作，才会升级为安全事故。OWASP 2026 Agentic Top 10 还同时覆盖工具滥用、身份权限、供应链、记忆污染、Agent 间通信和级联失败等问题。

防御要点（多层）：
- **最小权限 / 权限隔离**⭐：控制平面按主体、对象、动作、条件和 audience 生成授权视图；报销 Agent 不应持有无关数据或任意出站能力。检测可能漏报，确定性的权限边界负责限制后果。
- **人类介入检查点（Human-in-the-Loop）**⭐：高风险动作按风险分层，并让审批绑定规范化参数、资源版本、策略版本和 TTL；审批后换参或对象已变化必须重新批准。
- **运行时策略**：模型只提交 proposal，PDP/PEP、schema/语义校验、egress DLP、速率/预算和 effect receipt 在模型外强制执行。
- **把检索/外部内容当不可信**：文档里可能藏恶意指令，用标签隔离、清洗、输出审查。

#### 其他生产关注点

- **成本/延迟**：用 admission control、deadline 传播、全局预算、关键路径和恢复预留治理，不要让每个节点各自重试到耗尽总预算。
- **可靠性**：区分 transient/permanent/invalid/`UNCERTAIN_OUTCOME`；有副作用的工具需幂等键、receipt、对账和补偿，不能把超时直接当失败重试。
- **部署**：和 RAG 一样，离线/在线分离、监控 p95 延迟与成本、用户反馈闭环（见 [rag/08](rag/08-生产工程化与最佳实践.md)，理念通用）。

---

### 阶段 8 · Agent 系统工程 ⭐⭐⭐（本次深入补充）

> 📂 **完整专题入口**：[systems-engineering/00-Agent系统工程学习总览](systems-engineering/00-Agent系统工程学习总览.md)

前七个阶段解释“Agent 有哪些能力”；这一阶段回答生产系统更难的问题：**一次模型调用成功以后，怎样保证整个业务任务在超时、重试、崩溃、人工等待、版本升级和并发写入下仍然正确？**

核心能力包括：

- **Harness / 运行时**：把 Agent loop、模型适配、工具执行、策略、状态、评测和追踪分层，明确控制平面与数据平面。
- **工具契约**：为每个工具声明副作用、幂等键、超时、可重试错误、权限、前置条件、后置验证和不确定结果的对账流程。
- **持久化执行**：用 checkpoint、事务 outbox、Saga、事件恢复和版本迁移处理“请求已经发出，但进程在记录结果前崩溃”等灰区。
- **长任务连续性**：把目标、计划、工作项、决策、证据和产物外置为结构化状态；压缩上下文不能替代任务状态机。
- **协议边界**：分清 function calling、MCP、A2A、Agent Skills、`AGENTS.md`、工作流引擎和 OTel 分别解决哪一层问题。
- **多 Agent 一致性**：把编排者视为调度器，用单写者、分区所有权、CAS、租约、背压和确定性 reducer 管理并发。
- **评测科学**：评最终世界状态，区分 `pass@k` 与 `pass^k`，报告置信区间、成本/成功和回归门禁，而不是只看一次 demo。
- **安全控制平面**：把身份、能力票据、策略决策、参数绑定审批、沙箱、网络出口与审计证据放在模型之外。

推荐先通读总览，再按“运行时 → 工具契约 → 持久执行 → 长任务 → 评测 → 安全 → 参考架构”的顺序推进。

---

## 3. 最新进展速览（2025–2026）

把握"现在和一两年前有什么不同"，避免学过时的东西：

1. **协议开始分层**：MCP 负责模型应用与工具/资源的连接；A2A 1.0 负责独立 Agent 间的任务、消息与产物；Skills/`AGENTS.md` 负责可移植能力包与仓库级指令。它们互补，不是替代关系。
2. **长任务进入协议和运行时层**：MCP 2025-11-25 引入 experimental Tasks；Agents SDK 与工作流引擎更重视可序列化运行状态、人工审批和跨进程恢复。
3. **工具面从“全塞进 prompt”转向按需发现**：命名空间、延迟加载、工具搜索和程序化工具调用开始用于控制 token、选择歧义与中间数据搬运。
4. **Harness 成为真正的产品差异**：上下文装配、工具契约、文件/产物管理、压缩、恢复、验证与权限边界共同决定长任务表现，不能只比较底座模型。
5. **评测从答案相似度走向环境状态与可靠性统计**：`pass^k`、多次试验、置信区间、成本/成功和 holdout 回归集比单次成功率更能反映可上线性。
6. **安全从 prompt 护栏走向控制平面**：OWASP 2026 Agentic Top 10 把工具、身份、供应链、记忆、Agent 间通信、级联失败和人类信任都纳入威胁模型。
7. **开放治理增强**：MCP、goose 与 `AGENTS.md` 成为 Linux Foundation 旗下 Agentic AI Foundation 的创始项目，协议与工程约定正从单厂生态走向跨组织治理。

更完整的采用/试验/观望清单见 [systems-engineering/10-2026技术雷达与资料校准](systems-engineering/10-2026技术雷达与资料校准.md)。

---

## 4. 能力选型图（2026-07 快照，不是排行榜）

| 环节 | 选项 |
|------|------|
| 模型 | 按任务评测选择，并固定可复现的模型快照/版本；不要把学习文档绑定到易过时的型号排行 |
| 编排/运行时 | LangGraph、各家 Agents SDK、LlamaIndex、CrewAI、AutoGen；长任务可结合 Temporal、Dapr、DBOS、Restate 等持久执行层 |
| 工具连接 | 各家 function calling；需要跨宿主互操作时使用 MCP，并锁定协议版本与能力 |
| RAG | 按语料/查询形状评测 exact/ANN、词法/向量、重排与图检索；必须支持 snapshot、ACL、lineage delete 和 claim-citation 复核 |
| 记忆 | 选择支持 provenance、双时间、版本/CAS、失效、删除 lineage 与污染恢复的存储；向量库只是召回层 |
| 上下文优化 | 确定性 context assembler、token ledger、artifact 引用、分层摘要/压缩与安全域绑定缓存 |
| 评估/可观测 | 可执行/world-state oracle + 配对统计 + 可导出 trace；平台只是实现选择，不替代指标契约 |
| 安全护栏 | PDP/PEP、最小权限/JIT credential、沙箱、egress、参数绑定 HITL、审计与恢复演练 |
| 协议/能力包 | A2A（Agent 间互操作）、Agent Skills（渐进披露的能力包）、`AGENTS.md`（仓库指令） |
| 遥测 | 自有 trace schema + OpenTelemetry GenAI 语义约定（仍需关注字段稳定性和敏感数据） |

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
8. **故障注入项目**：给一个有副作用的采购/工单 Agent 加幂等键、outbox、checkpoint、审批参数绑定与对账；在超时、重复投递、进程崩溃、审批后改参和版本升级下验证。（阶段 8）

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
- 为什么“模型说工具失败了”不等于工具没有产生副作用？如何处理 `UNCERTAIN_OUTCOME`？
- `pass@k` 与 `pass^k` 各回答什么问题？为什么生产可靠性不能只报一次成功率？
- MCP、A2A、Agent Skills、`AGENTS.md`、工作流引擎分别位于哪一层？
- 长任务从 checkpoint 恢复时，哪些代码会重放？工具副作用怎样做到幂等、可对账？
- 人工批准的究竟是“动作类型”还是“动作 + 参数 + 资源版本”？如何防止批准后换参？

---

## 7. 参考来源（2025–2026）

- [Anthropic — Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)（workflows vs agents、从简单开始）
- [Anthropic — Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)（上下文作为有限资源）
- [Anthropic — Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)（跨上下文长任务）
- [Model Context Protocol — 2025-11-25 Specification](https://modelcontextprotocol.io/specification/2025-11-25) · [Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [A2A Protocol — v1.0 Specification](https://a2a-protocol.org/latest/specification/) · [A2A v1.0 announcement](https://a2a-protocol.org/latest/announcing-1.0/)
- [Agent Skills — Specification](https://agentskills.io/specification) · [AAIF — Linux Foundation announcement](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)
- [OpenAI Agents SDK — Running agents](https://openai.github.io/openai-agents-python/running_agents/) · [Human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/) · [A practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/)（官方入门导向指南）
- [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)
- [AI Agents That Matter](https://arxiv.org/abs/2407.01502) · [τ-bench](https://arxiv.org/abs/2406.12045) · [MAST](https://arxiv.org/abs/2503.13657)
- [OpenTelemetry — GenAI semantic conventions 独立仓库](https://github.com/open-telemetry/semantic-conventions-genai) · [核心站迁移说明](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [关键主张—一手来源映射与外推边界](DEPTH_AUDIT.md#9-关键主张一手来源映射)

---

> 下一步建议：已有 Agent 基础时，直接从 [系统工程总览](systems-engineering/00-Agent系统工程学习总览.md) 开始；刚入门则先完成单 Agent + 好工具，再用阶段 8 的故障注入项目检验是否真正达到生产级。
