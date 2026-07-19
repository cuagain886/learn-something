# 06 · 高级 RAG 架构

> 目标：理解当"基础 RAG（混合检索+重排）"不够用时，主流的进阶架构各自解决什么短板、原理是什么、代价多大、何时才值得上。

> ⚠️ 前置忠告：**这些是"基础 RAG 做扎实后、用评估证明了不够用"才上的方案**，不是越花哨越好。每一个都显著增加建库/推理成本。新手最常见的错误就是跳过基础直接追这些。

---

## 1. 全景：这些架构在解决什么

回顾 [文档 01](01-RAG基础与核心原理.md) 的"失败模式地图"，基础 RAG 有几个搞不定的硬骨头：

| 基础 RAG 的短板 | 升级方案 |
|------------------|----------|
| chunk 孤立、丢失全局上下文 | **Contextual Retrieval** / Late Chunking |
| 需要"全局总结"（这本书讲了什么？） | **RAPTOR**、GraphRAG 的社区摘要 |
| 关系型 / 多跳推理（A 和 B 通过 C 关联吗？） | **GraphRAG** |
| 需要动态决策、多步检索、用工具 | **Agentic RAG** |
| 答案质量不稳定、需要自我纠错 | **Self-RAG / CRAG** |
| 不该一刀切的检索策略 | **Adaptive RAG** |

---

## 2. Contextual Retrieval（上下文检索）⭐ Anthropic，2024

### 2.1 解决的问题

传统分块后，每个 chunk **孤立**，丢失了所属文档的背景。例如一个 chunk 写："该公司本季度营收增长了 3%"——但"该公司"是谁？"本季度"是哪个季度？孤立的 chunk 检索时会因为缺背景而匹配不准。

### 2.2 做法

在嵌入/索引每个 chunk **之前**，用 LLM（如 Claude）为它生成一段 **50~100 token 的上下文说明**，描述这个 chunk 在整篇文档里的位置和背景，**拼到 chunk 前面**再嵌入和建 BM25 索引。

```
原 chunk： "该公司本季度营收增长了 3%。"
            ↓ 让 LLM 看着全文，给这个 chunk 生成上下文：
上下文："本段出自 ACME 公司 2025 年 Q2 财报，讨论的是与 Q1 相比的营收表现。"
            ↓ 拼接后再嵌入：
增强 chunk："本段出自 ACME 公司 2025 年 Q2 财报...。该公司本季度营收增长了 3%。"
```

### 2.3 两个组件 + 效果

- **Contextual Embeddings**：上述增强后的 chunk 拿去嵌入。
- **Contextual BM25**：增强后的 chunk 也建一份 BM25 索引。
- Anthropic 在其特定知识库 benchmark 中报告：Contextual Embeddings 与 Contextual BM25 结合使 top-20 检索失败率下降 49%，再加重排下降 67%。这是该实验设置下的相对结果，迁移到自己的语料前必须复测。

### 2.4 成本与工程技巧

- 听起来很贵——要对**每个 chunk 都调一次 LLM**生成上下文。
- **可评估的降本技巧：Prompt Caching**。生成上下文时，每个 chunk 的 prompt 都包含相同文档前缀；若模型/供应商的缓存语义、最小前缀和 TTL 匹配，可复用前缀。实际命中、成本和延迟依 API 与文档批次而变，应记录 cache hit 和完整建库成本，不能把个案比例外推。
- 这是"用一次性的建库成本，换长期的检索质量提升"，对**高价值、相对静态**的知识库很划算。

### 2.5 与 Late Chunking 对比

两者都为解决"chunk 丢失上下文"：
- **Late Chunking**（[文档 02](02-数据处理与分块策略.md)）：靠长上下文嵌入模型，先嵌入全文再切，机制层面带入上下文。**无需额外 LLM 调用**。
- **Contextual Retrieval**：靠 LLM 显式生成上下文文字再嵌入。**更贵但更可控、可解释**，且同时增强了 BM25。

---

## 3. RAPTOR（递归摘要树）⭐

### 3.1 解决的问题

基础 RAG 检索的都是**细粒度小 chunk**，擅长回答"具体细节"，但答不了**全局/总结型问题**："这份 200 页报告的核心结论是什么？"——因为答案不在任何单个 chunk 里，而是要综合全文。

### 3.2 做法：自底向上建一棵"摘要树"

```
Level 3 (根):              [全文总摘要]
                            /         \
Level 2 (主题摘要):    [主题A摘要]   [主题B摘要]
                        /     \        /     \
Level 1 (簇摘要):   [簇摘要] [簇摘要] ...
                     /  \
Level 0 (原始 chunk): chunk chunk chunk ...
```

建库流程：
1. 把文档切成小 chunk（Level 0），嵌入。
2. **聚类**相似的 chunk，对每个簇用 LLM 生成**摘要**（Level 1）。
3. 对摘要再聚类、再摘要……递归向上，直到顶层（全文摘要）。

### 3.3 检索

把**树上所有节点**（不只是叶子 chunk，还包括各层摘要）都放进向量库一起检索。
- 问细节 → 命中底层小 chunk。
- 问全局 → 命中高层摘要节点。
- 一次检索就能同时拿到"细节"和"概览"，**适应不同抽象层次的问题**。

### 3.4 代价与适用

- **建库贵**：要做大量聚类 + LLM 摘要。
- **适用**：长文档 / 文档集、问题在"细节"和"全局总结"之间跨度大的场景（如研究报告问答、书籍问答、长技术手册）。

---

## 4. GraphRAG（图谱增强）⭐ Microsoft

### 4.1 解决的问题

向量检索只擅长"局部语义相似"，搞不定**关系型、多跳、全局型**问题：
- "X 和 Y 之间有什么联系？"（关系）
- "这个项目涉及哪些人、他们如何协作？"（多实体关系网）
- "整个数据集反映出哪几个核心主题？"（全局总结）

这些答案分散在多处、靠**实体之间的关系**串起来，纯向量检索拿不全。

### 4.2 做法

**建库阶段**：用 LLM 从文档中抽取**实体（节点）和关系（边）**，构建一个**知识图谱**；再用社区检测算法（如 Leiden）把图谱划分成"社区"，对每个社区用 LLM 生成**社区摘要**。

**检索阶段**两种模式：
- **局部检索（Local Search）**：从问题相关的实体出发，沿图谱的边游走，收集相关实体及其邻居的信息。擅长"具体实体的关系"问题。
- **全局检索（Global Search）**：用各个社区摘要来回答"全局总结"型问题（"整个语料的主要主题是什么"）。

### 4.3 优势与代价

- **优势**：能回答关系型、多跳、全局总结型问题；微软 GraphRAG 研究在其全局总结实验中报告了显著 token 差异，但范围会随数据集、查询、社区摘要层级和比较基线改变，不应外推为固定的生产节省率。
- **代价（很重）**：要对文档做实体/关系抽取、消歧、构图、社区检测和摘要。相对成本取决于语料、抽取 prompt、模型和增量策略，不能用固定倍数概括；更关键的是更新、删除和实体合并会让维护语义复杂化。
- **混合趋势**：实践中常用 **Hybrid RAG = 图谱 + 向量 + BM25**，结合结构化关系和语义检索，并提升可解释性（能看到答案是沿哪些关系推出来的）。

### 4.4 适用

实体关系密集、需要多跳推理或全局洞察的领域：尽职调查、情报分析、医疗知识、复杂法规、企业知识图谱、科研文献网络。**普通 FAQ / 文档问答不要上 GraphRAG，性价比极差。**

---

## 5. Agentic RAG（智能体式 RAG）⭐ 当前热点

### 5.1 从"固定管线"到"动态决策"

传统 RAG 是**固定流程**：query → 检索 → 生成，一条道走到黑。**Agentic RAG** 把检索决策交给一个**会推理、会规划的 Agent**：由它**自主决定**何时检索、检索什么、用哪个工具、要不要再检索一轮、对中间结果是否满意。

> 它把"检索"变成 Agent 推理循环里的一个**可选动作（tool call）**，而不是写死的步骤。

### 5.2 典型能力

- **规划（Plan）**：把复杂任务拆成多步检索计划。
- **工具选择（Tool Use）**：在多个知识库、Web 搜索、SQL 查询、计算器之间选择。
- **反思/自我批判（Reflect/Critique）**：检查中间答案够不够好，不够就**改写查询、再检索**。
- **多轮迭代**：循环"检索→推理→再检索"，直到对答案有信心。

```
用户复杂问题
   ↓
[Agent] 规划：需要先查 A，再根据 A 的结果查 B
   ↓ 检索 A → 评估"够了吗？"→ 不够，改写查询
   ↓ 检索 B → 评估 → 综合
   ↓ 反思：答案有依据吗？有矛盾吗？→ 必要时再查
   ↓ 输出最终答案
```

### 5.3 代价与适用

- **代价**：多次 LLM 调用 + 多次检索，**延迟高、成本高、行为不确定性强**（更难调试和保证稳定）。
- **适用**：复杂多跳问答、研究型任务（deep research）、需要跨多源整合、需要调用工具/实时数据的场景。
- **实现**：可用显式状态机/工作流或 Agent runtime 管理检索循环；框架不是能力来源。关键是检索接口契约、停止条件、预算、checkpoint 和中间证据评测。

---

## 6. Self-RAG / CRAG（自我纠错类）

### 6.1 Self-RAG

让模型在生成过程中产出特殊的"反思 token"，自主判断：**这一步需不需要检索？检索回来的内容相关吗？我的回答有没有被证据支持？** 用自我评判来动态控制检索和提升忠实度。

### 6.2 CRAG（Corrective RAG，纠错式 RAG）

加一个**检索质量评估器**：判断检索回来的内容质量。
- 质量好 → 直接用。
- 质量差 → **触发纠错动作**：比如改写查询重检、或**退回到 Web 搜索**兜底，避免基于差资料硬答。

这类方法的共同点：**给 RAG 加一层"质量自检 + 兜底"**，提升鲁棒性，减少"检索质量差却硬生成"导致的幻觉。

---

## 7. Adaptive RAG（自适应 RAG）

不对所有问题用同一套策略，而是**先判断问题复杂度，再决定检索强度**：

```
问题分类器 / LLM 判断复杂度
   ├─ 简单事实（"法国首都？") → 不检索 or 一次检索
   ├─ 中等            → 标准混合检索 + 重排
   └─ 复杂多跳        → 查询分解 / 迭代 / Agentic
```

- **价值**：在**质量、成本、延迟**之间动态平衡——简单问题不浪费资源，复杂问题才投入重型策略。
- 这其实是把 [文档 05](05-查询理解-改写路由与转换.md) 的"路由"思想用在检索强度上。

---

## 8. 其他工程化进阶方向

- **多模态 RAG（Multimodal RAG）**：知识库含图片、图表、表格、视频。要么用多模态嵌入模型，要么先给图片生成文字描述再走文本 RAG。适合产品图册、医学影像、设计文档等。
- **结构化 RAG（Structured RAG / Text-to-SQL）**：知识在数据库/表格里时，把自然语言问题翻译成 SQL/结构化查询去查，而不是做向量检索。适合"统计/聚合/精确数值"问题（"上季度华东区销售额是多少"）。
- **异构源 RAG（Heterogeneous-source RAG）**：同时整合关系库、Web、知识图谱等多种证据源（常配合路由 + Agentic）。
- **RAG 集成（RAG Ensembles）**：组合多个检索器/重排器/生成器的输出做融合，提升鲁棒性和准确率（代价是成本翻倍）。

---

## 9. 如何选择（决策树）

```
基础 RAG（混合检索+重排）效果够吗？
  够 → 别折腾，就用满足 SLO 的最简单基线 ✅
  不够 → 用评估定位是哪类问题失败：

    chunk 缺上下文导致检索不准      → Contextual Retrieval / Late Chunking
    答不了"全局总结"型问题          → RAPTOR
    答不了"关系/多跳"型问题         → GraphRAG（确认值得这个建库成本）
    问题复杂、需多步检索/调工具     → Agentic RAG
    检索质量不稳、需自检兜底        → CRAG / Self-RAG
    问题复杂度差异大、想省成本      → Adaptive RAG
    知识在数据库/表格里             → 结构化 RAG (Text-to-SQL)
    知识含图表/图片                 → 多模态 RAG
```

---

## 10. 深入：按错误类型、更新语义与控制复杂度选架构

### 10.1 架构不是能力名词，而是对某个错误的干预

| 观察到的错误 | 先做的诊断 | 可能干预 | 不应先做 |
|---|---|---|---|
| answer span 被分块切断 | oracle span containment | parent-child/evidence window | 直接上多 Agent |
| chunk 指代丢失 | exact retrieval + contextual ablation | contextual/late chunking | 假设所有文档需 LLM contextualize |
| 全局主题问题失败 | oracle full-doc/summary baseline | RAPTOR/GraphRAG global/LazyGraphRAG | 用局部 top-k 硬答 |
| 关系多跳失败 | 标注 hop/entity/edge | graph/local traversal/iterative retrieval | 只增加 top-k |
| 实时精确数值错 | 检查数据源与时效 | SQL/API/structured RAG | 把表格全文向量化后计算 |
| 首次检索不全 | candidate oracle + rewrite ablation | multi-query/iterative/agentic | 无界循环 |
| 检索有证据却生成错 | oracle context 与 citation eval | context selection/generator/verification | 重建所有索引 |
| 简单题成本过高 | 任务分层 | adaptive/early exit | 所有题跑 GraphRAG/Agentic |

每个高级架构都应对应一个可观测错误和一个可证伪假设。

### 10.2 Contextual/Late Chunking 的更新语义

显式 contextualization 产生派生文本：

```yaml
source_chunk_hash: ...
context_text: ...
context_generator_version: ...
full_document_version: ...
prompt_hash: ...
taints: [inherited_from_source]
```

只要原 chunk、全文、prompt 或生成模型变化，派生上下文可能需要失效/重建。LLM 生成的 context 可能引入事实，索引时应将其视为检索提示而非可引用证据；最终引用仍指向原始 source span。

Late Chunking 则把文档内其它 token 的信息编码进块向量。文档任一部分变化都可能改变多个块的表示，增量更新粒度可能接近整文档重嵌入；需按模型最大长度和长文档切窗定义边界。

### 10.3 RAPTOR 的版本、摘要误差与删除传播

摘要树是派生数据 DAG，不只是“一棵建好就不变的树”：

```text
leaf chunks v7
  → clustering v3 + seed
  → summaries level-1 v5
  → clustering level-2
  → root summary
```

风险：

- 低层摘要遗漏/扭曲后向上累积；
- 聚类变化导致大量上层节点重写；
- 新文档插入改变主题簇，局部更新不再等价于全量重建；
- 删除原文后，上层摘要仍保留其事实；
- 检索命中摘要却无法映射到具体 evidence span。

工程要求：保存 child IDs、source lineage、cluster/model/prompt 版本；摘要只用于导航/候选，关键 claim 下钻到叶子证据；删除沿 DAG 失效所有派生摘要；用局部 rebuild 与周期全量 rebuild 比较漂移。

### 10.4 GraphRAG 的图不是 ground truth

GraphRAG 建图包含多个有损步骤：实体抽取、共指消解、关系抽取、实体合并、社区检测、摘要。每一层都需置信和来源：

```yaml
edge:
  subject: entity:ACME
  predicate: acquired
  object: entity:Beta
  evidence_spans: [doc17:182-244]
  extraction_version: rel-extract-v6
  valid_time: [2025-04-01, null]
  confidence: 0.82
  status: asserted_not_verified
```

遍历到一条边不证明事实成立；答案引用应回到原始证据。实体错误合并会产生“关系幻觉”，错误拆分则断开多跳路径。

### 10.5 Graph 更新与删除

增量文档可能：

- 新增/删除实体和边；
- 改变同名实体消歧；
- 使社区结构和摘要失效；
- 与旧时间版本矛盾；
- 携带不同 ACL，不能在社区摘要中泄露。

可选策略：

| 策略 | 优点 | 风险 |
|---|---|---|
| append + 局部实体合并 | 更新快 | 图/社区逐渐漂移 |
| 局部社区重算 | 成本适中 | 边界效应、与全量结果不同 |
| 周期全量 snapshot | 一致性强 | 成本高、切换复杂 |
| bitemporal graph | 可回答历史状态 | 数据/查询/删除更复杂 |

所有派生图节点/社区摘要必须继承最严格 ACL 或按安全域分图；不能先跨租户构图再在答案末尾过滤。

### 10.6 GraphRAG 的 Local / Global / DRIFT / Lazy 路线

Microsoft GraphRAG 生态公开了 local、global，并继续出现 DRIFT（结合社区信息与局部跟进）和 LazyGraphRAG（减少昂贵的预先摘要、把更多工作推到查询时）等路线。这些说明“GraphRAG”不是一个固定算法：

- **Local**：实体中心邻域，适合具体关系；
- **Global**：社区摘要 map/reduce，适合全局主题；
- **DRIFT**：以社区信息为起点，生成细化跟进；
- **LazyGraphRAG**：权衡较低 upfront index 与更高/更动态 query 工作。

它们的比较只对具体数据、query 类型、token/延迟预算成立。2025/2026 的官方研究结果与实现更新应视作候选来源，不是跨领域 SOTA 保证。

### 10.7 Agentic RAG 的控制状态

Agentic RAG 至少维护：

```yaml
question_contract: ...
open_subquestions: [...]
evidence_ledger:
  - claim_or_hop: ...
    source_ref: ...
    supports: true
    trust: ...
    time: ...
query_history: [...]
budget:
  retrievals_left: 4
  tokens_left: 9000
  deadline: ...
stop_reason: evidence_sufficient | budget | no_progress | conflict | abstain
```

“模型觉得够了”不是稳定停止条件。可组合：所有必要 subquestion 有证据、关键 claim 至少一个权威来源、冲突已解决/披露、连续两轮无新增证据、预算/deadline 触顶。

### 10.8 Agentic RAG 的评测不能只看最终答案

按能力分层：

- 是否正确判断 retrieval necessity；
- query rewrite/decomposition 保真；
- datasource/tool route 与权限；
- evidence coverage、重复查询、无进展；
- 冲突/时效处理；
- 停止/abstain；
- cost/success 与 `pass^k`。

2025 的 Agentic RAG surveys 和 RAGCap-Bench 等工作体现了对中间能力评测的关注；新 benchmark 仍可能受领域、harness 和污染限制，生产应构建自己的 capability slices。

### 10.9 高级架构的同预算消融

```text
A0 hybrid + rerank
A1 + contextual/late chunk
A2 + hierarchy (RAPTOR-like)
A3 + graph local/global variant
A4 + iterative fixed workflow
A5 + agentic controller
A6 oracle source/router/evidence
```

固定语料 snapshot、生成器和最终 token；对全局/局部/多跳/实时/结构化任务分层，分别报告建库成本、增量更新/删除延迟、查询 p95、cost/success、citation correctness 和风险。`A6` 用于估计控制器/检索的上限。

---

## 11. 本章小结

- 高级架构都是**针对基础 RAG 的具体短板**的升级，**先用评估证明基础不够再上**。
- **Contextual Retrieval**：建库时给每个 chunk 加 LLM 生成的上下文；Anthropic 在特定 benchmark 报告 top-20 检索失败率相对下降 49%/67%，自己的语料需复测。
- **RAPTOR**：递归摘要树，让一次检索同时覆盖细节和全局总结。
- **GraphRAG**：抽实体关系建图谱，解决关系型/多跳/全局问题，但建库极贵，慎用。
- **Agentic RAG**：把检索变成 Agent 推理循环里的动态决策，强但贵且不确定。
- **Self-RAG / CRAG**：加质量自检和兜底，提鲁棒性。
- **Adaptive RAG**：按问题复杂度动态选检索强度，平衡质量/成本/延迟。
- 还有多模态、结构化(Text-to-SQL)、异构源、集成等工程方向。

## 12. 检验清单

- [ ] 能说出每种高级架构解决基础 RAG 的哪个具体短板。
- [ ] 能解释 Contextual Retrieval 的做法，以及 Prompt Caching 为什么是它工程可行的关键。
- [ ] 知道 RAPTOR 为什么能答"全局总结"问题。
- [ ] 理解 GraphRAG 的强大与昂贵，并知道它适合/不适合什么场景。
- [ ] 能区分固定管线 RAG 和 Agentic RAG。
- [ ] 拿到一个具体失败场景，能用决策树选出合适的升级方案。
- [ ] 能解释 contextual/RAPTOR/GraphRAG 的派生数据 lineage 与删除传播。
- [ ] 能区分 GraphRAG local/global/DRIFT/Lazy 路线的查询—建库权衡。
- [ ] 能为 Agentic RAG 设计 evidence ledger、停止条件和同预算消融。

---

> 下一步：[07-RAG评估与可观测性](07-RAG评估与可观测性.md) —— 从"玄学调参"走向"工程"的分水岭。
>
> 前沿参考：[Microsoft GraphRAG project](https://www.microsoft.com/en-us/research/project/graphrag/) · [DRIFT Search](https://www.microsoft.com/en-us/research/blog/introducing-drift-search-combining-global-and-local-search-methods-to-improve-quality-and-efficiency/) · [LazyGraphRAG](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/) · [RAGCap-Bench（2025 预印本）](https://arxiv.org/abs/2510.13910) · [Data-Centric Agentic RAG Survey（ACL Findings 2026）](https://aclanthology.org/2026.findings-acl.78/)
