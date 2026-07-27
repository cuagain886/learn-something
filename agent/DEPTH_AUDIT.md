# Agent 文档深度审计台账

> 审计目标：不是判断“有没有提到某个名词”，而是判断学生在面试中被连续追问机制、边界、失败模式、实现与验证时，文档能否提供足够证据。
>
> 快照日期：2026-07-19。此文件是持续关闭差距的工作台账，不把“篇幅变长”当作完成。

---

## 1. 深度判定标准

| 等级 | 能回答的问题 | 典型表现 |
|------|--------------|----------|
| L0 · 提及 | “它是什么名词？” | 一句话定义、框架名单、流程图 |
| L1 · 解释 | “为什么有效？” | 有直觉、例子和基本取舍 |
| L2 · 工程 | “故障、并发、成本和安全怎么处理？” | 有状态机、错误语义、数据结构、评测方法 |
| L3 · 可答辩 | “假设不成立会怎样？如何证明设计更好？” | 有形式化模型、适用边界、反例、消融、统计和一手来源 |

专题正文要达到 L3，至少应覆盖：

1. **机制**：输入、状态、决策、动作、观察、终止分别是什么。
2. **形式化或算法**：公式、状态机、伪代码、数据结构或复杂度至少有一种。
3. **边界**：成立依赖什么假设，在哪些任务上会失效。
4. **失败语义**：超时、重试、部分成功、结果未知、版本变化如何处理。
5. **验证**：用什么数据集、oracle、统计量和消融证明收益。
6. **前沿状态**：稳定标准、实验功能、论文结果和产品能力必须分开。
7. **面试追问**：能回答“为什么不用更简单方案”“怎么落地”“怎么测”。

总览/索引文档可以是导航型，不要求自己承载全部推导，但必须链接到达到 L3 的正文。

状态标记：`NAV`=导航文档；`GAP`=存在实质缺口；`DEEP`=已覆盖 L3；`CAL`=主要需要时效性/来源校准。

---

## 2. 总入口与 Agent Core

| 文档 | 状态 | 审计结论 | 关闭差距的动作 |
|------|------|----------|----------------|
| `INDEX.md` | NAV | 路线完整，已加入系统工程；不负责细节推导 | 最终同步新增基础理论与面试模块 |
| `agent-core/00` | NAV | 模式路线清楚，但把 Agent 简化为“LLM+工具+循环” | 链接部分可观测决策与搜索规划正文 |
| `agent-core/01` ReAct | DEEP | 已区分论文 Thought、隐藏推理、业务理由和审计证据；加入 POMDP 映射、turn 不变量、结果未知与成功谓词 | 保持与供应商 reasoning 可见性文档同步 |
| `agent-core/02` Tool Use | DEEP | 已补结构/语义/授权三层校验、effect type、错误代数、结果未知、大工具面发现和程序化调用 | 后续只做 API 时效校准 |
| `agent-core/03` Reflection | DEEP | 已补 evaluator 相关性、无外部反馈退化、best-so-far、holdout、记忆写入门与 retry/search 区分 | 与评测专题互链 judge drift |
| `agent-core/04` Planning | DEEP | 已补结构化计划项、DAG/HTN/条件计划、语义 replan、计划验证与搜索边界 | 深层搜索推导落在 `agent-core/08` |
| `agent-core/05` Multi-Agent | DEEP | 已纠正 MCP/A2A 分层，加入 ownership、Amdahl、work item、并发一致性和 MAST 分类 | 与 orchestration 专题共享协议 envelope |
| `agent-core/06` 组合 | DEEP | 已从经验决策树升级为基线—单变量实验、paired eval、Pareto 与动作级自主分区 | 在面试题库中加入系统设计案例 |
| `agent-core/07` 形式化模型 | DEEP | POMDP、belief state、复合策略、效用/风险约束、信息价值、主动感知与三种学习 | 新增完成 |
| `agent-core/08` 搜索规划 | DEEP | Best-of-N、Self-Consistency、ToT、beam、MCTS/LATS、verifier/Goodhart、计划表示和公平消融 | 新增完成 |

### Core 缺失的独立知识

- Agent 的 **POMDP / belief-state** 视角，以及它与“聊天记录”的区别。
- 工作流与 Agent 不是二元标签，而是控制权、策略熵和可达动作集合的连续谱。
- inference-time search：Best-of-N、beam search、Tree of Thoughts、MCTS/LATS。
- 隐藏推理、reasoning item/summary、业务决策理由和审计证据的边界。
- 模型参数内学习、上下文内适应、外部记忆更新三者的区别。

---

## 3. Context Engineering

| 文档 | 状态 | 审计结论 | 关闭差距的动作 |
|------|------|----------|----------------|
| `context-engineering/00` | DEEP/NAV | 已同步 2025-11-25 MCP、context manifest、双时间记忆、compaction/checkpoint 边界 | 作为专题导航维护 |
| `context-engineering/01` MCP | DEEP | 已补 initialize/capability 状态机、Roots/Sampling/Elicitation、Streamable HTTP、OAuth audience/token passthrough 与 Tasks 实验边界 | 以规范版本和兼容性失败实验校准 |
| `context-engineering/02` 上下文基础 | DEEP | 已补 token ledger、block manifest、指令/事实/时间/范围冲突、来源/新鲜度与位置/组件消融 | 用目标模型 paired eval 校准位置效应 |
| `context-engineering/03` 记忆 | DEEP | 已补 working state/checkpoint 边界、双时间 schema、写入门、CAS/supersedes、删除 lineage、污染恢复与五层 benchmark | 跟踪 2026 预印本复现情况 |
| `context-engineering/04` 管理技巧 | DEEP | 已补工具事务原子裁剪、有损摘要误差、artifact hash/version、cache security domain 与 compaction/checkpoint 边界 | 用任务级保真测试校准压缩 |
| `context-engineering/05` 实践 | DEEP | 已重写为状态投影模型、context block 契约、确定性 assembler、症状—证据—实验矩阵、分层指标、crash/security 测试和生产数据模型 | 与 orchestration/evaluation 章节交叉验证 |

---

## 4. Orchestration

| 文档 | 状态 | 审计结论 | 关闭差距的动作 |
|------|------|----------|----------------|
| `orchestration/00` | DEEP/NAV | 已同步 ownership、join/cancel、replay/effect、A2A 1.0 和因果评测路线 | 作为专题导航维护 |
| `orchestration/01` 工作流模式 | DEEP | 已补 node contract、错路由代价、ALL/ANY/quorum/deadline join、work item schema、best-so-far 与同预算 E0-E5 消融 | 按任务分布校准组合模式 |
| `orchestration/02` 多 Agent 拓扑 | DEEP | 已纠正 Supervisor/Swarm 静态排名，补答案 owner、handoff envelope、lease/fencing/CAS、bulkhead/backpressure/cancellation | 与 `systems-engineering/06` 保持一致 |
| `orchestration/03` 状态与控制流 | DEEP | 已补 durable state/context 分层、reducer 代数、interrupt 重放、effect crash window、审批 proposal 与 graph/schema migration | 用目标框架故障注入验证 |
| `orchestration/04` 通信协议 | DEEP/CAL | 已按 A2A 1.0 重写 Agent Card、Message/Task/Artifact、状态机、多 binding、幂等、版本、push 安全，并区分 MCP Tasks 实验状态 | 生产固定 A2A/MCP 版本并跑 interop suite |
| `orchestration/05` 框架选型 | DEEP/CAL | 已删除排行榜，更新 ADK 2.0 与 Microsoft Agent Framework successor 快照，补 SDK/runtime/platform 分层、11 项故障 spike、portable control plane | 按 changelog 定期校准 |
| `orchestration/06` 生产实践 | DEEP | 已补风险 SLO、全局预算、错误代数、critical path、公平限流、取消对账、跨 Agent trace、paired ablation 与事故演练 | 与 evaluation/production 交叉验证 |

---

## 5. Evaluation

| 文档 | 状态 | 审计结论 | 关闭差距的动作 |
|------|------|----------|----------------|
| `evaluation/00` | DEEP/NAV | 已重写为闭环系统实验路线，统一 estimand、world-state、统计、trace 与渐进发布 | 作为专题导航维护 |
| `evaluation/01` 难点 | DEEP | 已补 estimand、Agent/环境随机性分离、执行世界 manifest、eval-infra 审计、漂移/污染与因果边界 | 用具体领域分布校准采样设计 |
| `evaluation/02` 指标 | DEEP | 已补 world-state oracle、pass@k/pass^k、校准与 coverage-risk、CVaR/worst-slice、cost/success 和指标契约 | 按业务损失确定风险权重与阈值 |
| `evaluation/03` LLM Judge | DEEP | 已补原子 rubric、位置/长度/自偏好、pairwise 换序、混淆矩阵、inter-rater、anchor set、注入与 judge drift gate | 每个 Judge 版本用领域人工锚点复验 |
| `evaluation/04` 数据与 CI | DEEP | 已补五类 split、provenance/近重复污染、配对 McNemar/bootstrap、CI/MDE、功效、多重与序贯检验、可复现 manifest | 结合基线方差做实际样本量计算 |
| `evaluation/05` Trace | DEEP/CAL | 已补 trace invariant、异步 links、敏感内容 opt-in、采样权重、replay/反事实边界，并校准 OTel GenAI 已迁独立仓库的成熟度 | 钉 semantic-convention 版本并做后端兼容 spike |
| `evaluation/06` 在线评估 | DEEP | 已补代理/业务结果、延迟标签、反馈选择偏差、shadow/canary/A-B、bandit propensity/OPE 风险、漂移分层和副作用回滚 | 按产品风险预注册 rollout 与 rollback gate |

---

## 6. Production & Security

| 文档 | 状态 | 审计结论 | 关闭差距的动作 |
|------|------|----------|----------------|
| `production/00` | DEEP/NAV | 已统一 proposal-not-authority 控制面、OWASP ASI01–ASI10、身份链、审批绑定与证据路线 | 作为专题导航维护 |
| `production/01` 威胁 | DEEP/CAL | 已按官方名称完整映射 ASI01–ASI10，补资产/主体/信任边界、组合攻击链、Prevent/Detect/Contain/Recover 与风险模板 | 随 OWASP 正式版本定期校准 |
| `production/02` 注入 | DEEP | 已补指令/数据不可形成硬边界的本质、provenance/taint 传播、source-to-sink、工具/A2A/memory 隔离、egress DLP 与红队矩阵 | 按领域攻击面维护隐藏 challenge 变体 |
| `production/03` 权限 | DEEP/CAL | 已补 subject/delegator/workload/audience 身份链、RBAC/ABAC/ReBAC/capability、PDP/PEP、JIT credential、confused deputy、MCP token passthrough 与 sandbox | 按 OAuth/MCP 版本校准并做对象级负面测试 |
| `production/04` 护栏/HITL | DEEP | 已补多值 guard 契约、R0–R4 风险、proposal hash/resource version/TTL、TOCTOU、审批疲劳、撤销/result-unknown 与长期恢复 | 用人因数据和故障注入校准审批策略 |
| `production/05` 部署 | DEEP | 已补 Little/Kingman 排队直觉、admission/backpressure、公平队列、deadline、全局预算/恢复预留、尾延迟、重试风暴、容量实验和在途回滚 | 用真实 workload profile 做容量与 knee-point 实验 |
| `production/06` 上线清单 | DEEP | 已重写为八类 Evidence Gate，每项绑定 claim/scope/owner/evidence/threshold/drill/rollback，并加入安全退款端到端案例 | 用 change manifest 自动重开失效证据 |

---

## 7. RAG

| 文档 | 状态 | 审计结论 | 关闭差距的动作 |
|------|------|----------|----------------|
| `rag/00` | DEEP/NAV | 已重写为证据系统与数据生命周期总览，统一四层正确性、基线矩阵、2025–2026 Agentic/Graph/数据中心趋势与毕业追问树 | 作为专题导航维护 |
| `rag/01` 基础 | DEEP | 已补 `N/R/U/G` 概率分解、closed-book/long-context/oracle/distractor 基线、retrieval necessity、拒答和四层引用语义 | 用领域 oracle evidence 校准上限 |
| `rag/02` 分块 | DEEP | 已补 query–evidence span 联合建模、containment/fragmentation/dilution、版本化 span schema、parent-child 一致性、重复成本和同预算消融 | 按文档类型和答案跨度分层调优 |
| `rag/03` 嵌入/向量库 | DEEP/CAL | 已清理静态产品排名，补 exact-vs-ANN、HNSW/IVF 曲线、量化恢复、filtered ANN、snapshot/删除与多租户隔离 | 按当前模型/数据库版本做生产 shape spike |
| `rag/04` 混合/重排 | DEEP | 已补加权 RRF、分数融合校准、candidate budget、级联证据丢失、reranker 截断、MMR/coverage 和 early exit | 固定总候选/上下文预算做消融 |
| `rag/05` 查询理解 | DEEP | 已补 intent contract、派生 query lineage、原查询并行、Multi-Query 边际收益、依赖 join、cost-sensitive route、abstain、漂移/隐私回退 | 用约束保真与路由混淆矩阵校准 |
| `rag/06` 高级架构 | DEEP/CAL | 已按错误类型重组，补 contextual/RAPTOR/GraphRAG 派生 lineage、更新删除、local/global/DRIFT/Lazy 路线、Agentic evidence ledger/停止与 2026 前沿 | 新论文/实现按预印本与具体 harness 定期校准 |
| `rag/07` 评测 | DEEP | 已补 snapshot estimand、pool 不完备 oracle、nDCG/MRR、多跳 evidence set、hard negatives、claim-citation 矩阵、Judge 误差和 paired CI | 建领域 relevance pool 与人工 claim anchor |
| `rag/08` 生产 | DEEP | 已补生命周期状态机、dense/sparse/metadata/ACL 逻辑 snapshot、幂等 CDC/CAS、蓝绿/dual-read、回填验证、cache 契约、lineage delete、RPO/RTO 与紧急 deny | 用 restore/delete/snapshot 演练验证 SLA |

---

## 8. Systems Engineering

以下文档已按 L3 标准编写；后续仍需在其他专题中交叉链接，避免深度知识孤岛化。

| 文档 | 状态 | 已覆盖的答辩深度 |
|------|------|------------------|
| `systems-engineering/00` | DEEP | 四类状态、概率决策面/确定控制面、系统不变量 |
| `systems-engineering/01` | DEEP | Harness 分层、turn lifecycle、框架边界 |
| `systems-engineering/02` | DEEP | 工具 effect/error contract、幂等、发现与四级评测 |
| `systems-engineering/03` | DEEP | 故障窗口、outbox、Saga、replay、版本迁移、fault injection |
| `systems-engineering/04` | DEEP | 长任务、工作项事务、租约、预算、跨上下文恢复 |
| `systems-engineering/05` | DEEP | Function/MCP/A2A/Skills/AGENTS/workflow/OTel 分层 |
| `systems-engineering/06` | DEEP | Amdahl、所有权、CAS、reducer、背压、MAST 失败分类 |
| `systems-engineering/07` | DEEP | 世界状态、pass@k/pass^k、Wilson、成本 Pareto、holdout |
| `systems-engineering/08` | DEEP | OWASP 2026、身份链、PDP/PEP、审批绑定、containment |
| `systems-engineering/09` | DEEP | 参考架构、表结构、SLO、部署拓扑、15 项验收测试 |
| `systems-engineering/10` | DEEP/CAL | 2026 技术雷达、成熟度区分、一手来源与数字校准 |

---

## 9. 关键主张—一手来源映射

> 校准快照：2026-07-19。表中的“可支撑主张”是证据边界，不表示来源中的实验结果可以无条件外推到其他模型、任务、预算或产品版本。规范/RFC 用于协议语义，官方实现文档用于具体产品行为，原始论文用于方法及其给定实验设置；三者不能互相替代。

| 关键主张 | 首选一手来源 | 可支撑范围与外推边界 |
|----------|--------------|----------------------|
| Workflow 与 Agent 的区别；优先选择能完成任务的最简单架构 | [Anthropic — Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) | 官方工程方法论；支撑分类与设计原则，不证明“单 Agent 在任意任务上更优” |
| ReAct 把语言推理与环境动作交错；搜索可提高部分“难生成、易验证”任务的表现 | [ReAct](https://arxiv.org/abs/2210.03629) · [Tree of Thoughts](https://arxiv.org/abs/2305.10601) · [LATS](https://arxiv.org/abs/2310.04406) | 原始论文中的算法与实验；不能把论文里的可见 thought 当作所有商用模型都会暴露的隐藏推理，也不能脱离同预算基线宣称搜索必胜 |
| OpenAI Agents SDK 的 manager/agent-as-tool、handoff 与 HITL pause/resume 是不同控制语义 | [Agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/) · [Human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/) | 只支撑该 SDK 当前公开接口；业务 exactly-once、审批权限与长期状态迁移仍由应用保证 |
| MCP 负责 host/client/server 能力连接，初始化要协商版本与 capabilities；Tasks 仍是 experimental；授权必须校验 audience，禁止 token passthrough | [MCP 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25) · [Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) · [Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices) | 正式规范与官方安全指南；不支撑“MCP 自动解决业务授权、幂等或恢复” |
| A2A 1.0 用 Agent Card、Message、Task、Artifact 和 binding 表达独立 Agent 间协作 | [A2A 1.0 Specification](https://a2a-protocol.org/latest/specification/) | 支撑协议对象与状态语义；不等于任意两个实现无需互操作、身份和扩展测试即可互信 |
| 图运行时的 checkpoint/interrupt 可以支持恢复，但恢复会重放代码，副作用仍需幂等与对账 | [LangGraph — Persistence](https://docs.langchain.com/oss/python/langgraph/persistence) · [Microsoft Agent Framework — Overview](https://learn.microsoft.com/en-us/agent-framework/overview/) | 支撑具体框架的持久化能力和当前产品定位；跨版本迁移及业务效果语义必须以目标版本故障实验确认 |
| Agent 评测应固定任务/环境/预算，评最终世界状态，并区分“至少一次成功”的 `pass@k` 与“连续 k 次全成功”的 `pass^k` | [AI Agents That Matter](https://arxiv.org/abs/2407.01502) · [τ-bench](https://arxiv.org/abs/2406.12045) | 原始论文的方法与 benchmark；不能把某 benchmark 分数直接当生产成功率 |
| LLM Judge 会受位置、长度、风格等因素影响，必须用人工锚点、换序与漂移门禁校准 | [Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685) · [Anthropic — Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | 支撑已观察到的偏差类型和 eval 工程方法；具体误差率必须在当前领域、rubric 和 Judge 版本上重测 |
| RAG 不是固定“三件套”，而是检索必要性、召回、证据使用和生成忠实度的联合系统；ANN 与 exact、索引 snapshot、claim-citation 要分别验证 | [RAG 原始论文](https://arxiv.org/abs/2005.11401) · [Self-RAG](https://arxiv.org/abs/2310.11511) · [CRAG](https://arxiv.org/abs/2401.15884) · [RAPTOR](https://arxiv.org/abs/2401.18059) | 原始方法论文只支撑对应方法与实验；HNSW/IVF 参数、量化和过滤性能依赖实际数据形状与数据库版本 |
| GraphRAG 的 local/global/DRIFT/Lazy 路线解决的错误类型、质量/成本曲线不同 | [Microsoft GraphRAG](https://www.microsoft.com/en-us/research/project/graphrag/) · [DRIFT Search](https://www.microsoft.com/en-us/research/blog/introducing-drift-search-combining-global-and-local-search-methods-to-improve-quality-and-efficiency/) · [LazyGraphRAG](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/) | 官方项目与研究复盘；结论仍需在目标语料、问题类型和更新/删除负载下复验 |
| 2025–2026 的 Agentic RAG / 数据中心 RAG 是快速演化方向，不是已稳定的统一架构 | [Agentic RAG Survey](https://arxiv.org/abs/2501.09136) · [RAG Evaluation Survey](https://arxiv.org/abs/2504.14891) · [Data-Centric Agentic RAG Survey, ACL Findings 2026](https://aclanthology.org/2026.findings-acl.78/) | 前两项是预印本综述，后一项是会议论文；用于建立问题分类和研究雷达，不作为产品收益承诺 |
| Agent 安全需要控制身份、权限、供应链、工具、记忆、Agent 间通信、级联失败和人类信任，不能只做 prompt 检测 | [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) · [Agentic Threats and Mitigations](https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/) | 支撑威胁分类与控制方向；具体风险等级仍需按资产、主体、信任边界和 blast radius 建模 |
| OAuth resource indicator、分布式 trace 传播与 workload identity 各自解决 audience、因果关联和机器身份问题 | [RFC 8707](https://datatracker.ietf.org/doc/html/rfc8707) · [W3C Trace Context](https://www.w3.org/TR/trace-context/) · [SPIFFE/SVID](https://spiffe.io/docs/latest/deploying/svids/) | 标准只定义各层语义；不能把 trace ID 当授权凭据，也不能把 workload identity 当最终用户委托 |
| OTel GenAI 语义约定已迁至独立仓库且仍在演化，生产必须 pin 版本并保留内部适配层 | [GenAI semantic conventions repository](https://github.com/open-telemetry/semantic-conventions-genai) · [OTel 迁移说明](https://opentelemetry.io/docs/specs/semconv/gen-ai/) | 支撑仓库迁移和当前成熟度；不同观测后端的字段兼容性必须实测，敏感正文不能默认采集 |

二手博客可用于发现关键词，但不再单独支撑协议状态、安全 MUST/SHOULD、精确百分比或框架优劣。全库域名扫描未发现 Medium、Substack、Towards Data Science、SEO 排行站等二手来源承担关键结论。

---

## 10. 缺失专题优先级

### P0：面试最容易被追问、当前完全缺失

1. ~~**Agent 形式化模型**：POMDP、belief state、policy、reward/cost/risk、optimal stopping。~~ 已由 `agent-core/07` 关闭。
2. ~~**测试时搜索与规划**：Best-of-N、beam、Tree of Thoughts、MCTS/LATS、verifier-guided search。~~ 已由 `agent-core/08` 关闭。
3. ~~**推理可见性边界**：隐藏推理、reasoning item/summary、业务理由、审计证据不能混为一谈。~~ 已由 `agent-core/01` 与 `07` 关闭。
4. ~~**评测的因果问题**：为什么“换框架后成功率涨了”不等于框架导致提升；如何做 paired/ablation。~~ 已由 `evaluation/01`、`04`、`06` 与 `orchestration/06` 关闭。

### P1：已有提及，但深度不足

1. ~~记忆一致性、时间性、删除与污染恢复。~~ 已由 `context-engineering/03` 与 `05` 关闭。
2. ~~MCP 生命周期、安全与实验 Tasks；MCP/A2A 的层次纠错。~~ 已由 `context-engineering/01` 关闭。
3. ~~并发 Agent 的任务所有权、取消传播和故障隔离。~~ 已由 `orchestration/02`、`03`、`06` 与 `systems-engineering/06` 关闭。
4. ~~RAG 的 ANN 参数、索引一致性和 claim-level 引用验证。~~ 已由 `rag/03`、`07`、`08` 关闭。

### P2：形成面试闭环

1. ~~每个专题增加“追问树”：定义 → 机制 → 反例 → 落地 → 评测。~~ 已在七个专题总览建立统一追问树，并由正文承载答案。
2. ~~至少一个端到端系统设计案例贯穿状态、工具、恢复、评测和安全。~~ 已由 `production/06` 的安全退款 Agent 与 `systems-engineering/09` 的参考架构关闭。
3. ~~建立主张—来源映射，清理只有二手博客支撑的结论。~~ 已由本文件第 9 节与全库来源域名扫描关闭。

---

## 11. 完成门禁

只有以下证据同时成立，才把总目标标记完成：

- [x] 所有 `GAP` 项已经关闭或被明确链接到一篇达到 L3 的正文。
- [x] P0 缺失专题全部补齐，并进入 `INDEX.md` 学习路线。
- [x] 原有文档中的过时协议状态、框架排名和无边界百分比已清理。
- [x] 每个核心专题至少有一组机制型面试追问，不只是名词解释。
- [x] 所有新增本地链接存在，代码围栏闭合，UTF-8 无损坏。
- [x] 关键前沿结论引用规范、官方文档或原始论文，并标注快照日期/外推边界。

### 11.1 最终验证记录

2026-07-19 对 `agent/` 全量执行机械审计，结果如下：

| 检查 | 结果 |
|------|------|
| Markdown 规模 | 58 个文件，16,556 行（含本验证记录） |
| 深度台账 | `GAP` 表格行 0；P0/P1/P2 未关闭项 0 |
| 面试闭环 | 7/7 个专题总览含定义→机制→反例→落地→评测追问树 |
| 结构完整性 | 本地链接缺失 0；奇数代码围栏 0；U+FFFD 乱码 0 |
| 时效/绝对化残留定向扫描 | 旧协议版本与无边界架构、任务覆盖、成本断言命中 0 |
| 来源 | 278 处外部 URL 引用；关键主张集中映射到规范、RFC、官方文档或原始论文 |
| Git 文本检查 | `git diff --check -- agent` 通过（仅提示工作区既有 LF→CRLF 策略，不是 whitespace error） |

### 11.2 2026-07-26 定期复核记录

机械与事实双向复核，方法：全量脚本校验 + 一手来源在线核查（官方仓库/官网直接抓取）。

| 检查 | 结果 |
|------|------|
| 本地链接 | 295 处全量校验，失效 0；代码围栏奇偶 0 异常；U+FFFD 0 |
| 公式抽验 | Wilson 区间、pass@k/pass^k、UCB1、Little/Kingman、扩展 Amdahl、POMDP belief 更新——全部验算正确 |
| MCP 版本 | 官方仓库确认 2025-11-25 仍为最新发布版（其后仅 draft）；Tasks 在 changelog 中确为 experimental（SEP-1686） |
| A2A 版本 | 最新发布 v1.0.1（2026-05-28），已更新雷达状态表（原写 1.0.0） |
| 外链存活 | A2A 规范、OWASP 2026、OTel 2026 博客、semconv-genai 仓库均 200；modelcontextprotocol.io 与 agentskills.io 本机网络不可达（非链接失效） |
| 新一手来源 | 纳入 5 篇 Anthropic 工程文章：eval-awareness-browsecomp（评测污染新证据，写入 evaluation/01 与 systems-engineering/07）、managed-agents（harness 假设过期原则，写入 systems-engineering/01）、harness-design-long-running-apps、agent-skills 工程实践、claude-code-sandboxing（补入对应参考区与技术雷达） |
| URL 规范化 | Building Effective Agents 的 /research/ 旧路径统一为 /engineering/ |
| MCP draft 信号 | draft changelog 显示下一版拟无状态化（移除 initialize/session）、Tasks 迁为官方扩展（SEP-2663）、MRTR 取代服务端发起请求；已按"未发布、可能再变"标注写入 context-engineering/01 §5.1.1 与雷达 |
| 框架版本快照 | ADK python v2.5.0、MS Agent Framework python 1.12.x/dotnet 1.15.x（含 hosting-a2a alpha）、OpenAI Agents SDK 0.18.x，写入 orchestration/05 §3.1；arXiv 定向扫描未发现值得引用的已验证成果（均为数天内预印本，按证据分级不纳入） |
| OWASP 命名核验 | 下载官方 57 页 PDF，ASI01–ASI10 十项命名与 production/01 映射逐字一致（官方文内 and/& 两种写法并存）；同步修正 systems-engineering/05 中残留的 A2A 1.0.0 表述 |
| Agent Skills 核验 | 官方规范仓库 agentskills/agentskills 的 specification.mdx 确认 `allowed-tools` 为 "(Experimental)、客户端支持不一" ——systems-engineering/05 表述正确 |
| rag/03 抽验 | HNSW/IVF/PQ 机制描述、参数语义（M/ef_construction/ef_search）、filtered search 权衡、exact-as-oracle 方法——全部正确 |
| 外链全量存活 | 115 个唯一外链并行探测：105 个 200；10 个 000 全部为 modelcontextprotocol.io/agentskills.io（复核网络本机不可达所致，内容已经官方 GitHub 仓库交叉确认存在）——真实失效 0 |
| 锚点校验 | 全库片段链接（#锚点）按 GitHub slug 规则验证：1 处，全部有效 |
| sitemap 补源 | 扫 OpenAI/Anthropic 全站 sitemap，新纳入 6 个未引用官方来源：A practical guide to building agents（INDEX）、safe-trustworthy agents 框架（production/00）、Agentic misalignment（production/01）、Project Vend 一/二期（systems-engineering/04）、Measuring agent autonomy（雷达评测区） |
