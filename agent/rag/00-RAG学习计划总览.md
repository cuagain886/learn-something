# RAG 学习计划总览：证据系统与数据生命周期

> 面向 Agent / 应用工程师的系统化路线。目标不是背“向量库 + top-k”，而是能构造一个按用户权限和知识版本检索证据、逐 claim 引用、可评测、可更新且可删除的生产系统。

---

## 0. RAG 的更准确定位

RAG 不是给模型外挂一个无条件可信的“长期记忆”，而是一个**有损证据选择系统**：

\[
C\sim p_{\eta}(C\mid q,K_v,user,time),\qquad
y\sim p_{\theta}(y\mid q,C)
\]

- `K_v`：带版本、权限、有效时间和来源的知识快照；
- `C`：经过过滤、检索、融合、重排和预算选择的证据；
- `y`：基于证据生成的答案或下一步行动。

它可以提高知识可更新性、可溯源性和私域访问能力，但不保证：

- 知识库一定包含正确证据；
- 检索一定找到；
- 模型一定忠实使用；
- 引用一定蕴含 claim；
- 权限/删除/时间版本一定正确；
- 比长上下文、SQL/API 或 closed-book 更便宜/准确。

这套文档围绕这些可失败假设展开。

---

## 1. 九篇文档与答辩能力

| 编号 | 文档 | 学完应能回答 |
|---|---|---|
| 01 | [基础与核心原理](01-RAG基础与核心原理.md) | 如何用 `N/R/U/G` 分解失败？closed-book/oracle-context 有什么用？ |
| 02 | [数据处理与分块](02-数据处理与分块策略.md) | Chunk 如何和 query/evidence span 联合设计？parent-child 有何一致性风险？ |
| 03 | [嵌入与向量数据库](03-嵌入模型与向量数据库.md) | 表示错误与 ANN 近似损失如何区分？过滤、删除和多租户怎样测？ |
| 04 | [混合检索与重排](04-检索策略-混合检索与重排序.md) | RRF、score fusion、candidate budget、reranker 截断怎样影响 evidence？ |
| 05 | [查询理解与路由](05-查询理解-改写路由与转换.md) | 如何保证改写不丢实体/时间/否定/权限，低置信路由怎样 abstain？ |
| 06 | [高级架构](06-高级RAG架构.md) | RAPTOR/GraphRAG/Agentic RAG 分别修什么错误，更新和删除代价是什么？ |
| 07 | [评估与可观测](07-RAG评估与可观测性.md) | relevance oracle 不完备时怎样标注？claim-citation 与配对统计怎么做？ |
| 08 | [生产工程化](08-生产工程化与最佳实践.md) | 如何原子切 snapshot、dual-read、回填验证、传播删除并做灾备？ |

---

## 2. 完整管线：离线派生图 + 在线证据决策

```text
离线 / 增量
Source of truth
  → fetch + provenance
  → parse/OCR + structural validation
  → chunk + parent/span/ACL
  → dense embedding + sparse index
  → optional contextual/summary/graph derivatives
  → cross-index validation
  → immutable knowledge snapshot
  → atomic publish

在线
query + conversation + user/tenant/time
  → intent contract / conservative rewrite / route
  → ACL/time/source pre-filter
  → sparse + dense + structured/API candidates
  → fusion / rerank / coverage selection
  → context manifest + evidence IDs
  → answer / retrieve_more / clarify / abstain
  → claim–citation mapping + guard
  → trace + delayed feedback
```

Deletion 是反向管线：source tombstone 必须沿 lineage 到 chunks、vectors、postings、parent/context、summary/graph、cache、trace/eval artifacts 和备份策略。

---

## 3. 四层正确性

### 3.1 Knowledge correctness

- source 是否权威、完整、当前有效；
- 冲突/时间版本是否建模；
- 解析/OCR 是否保真；
- ACL、owner、tenant 与数据分类是否正确。

### 3.2 Retrieval correctness

- 必要 evidence 是否可达/被召回；
- ANN 是否找回 exact neighbors；
- fusion/rerank 是否把 evidence 保留到 context；
- hard negatives、旧版本和未授权内容是否排除。

### 3.3 Generation correctness

- 关键 claim 是否正确；
- citation 是否存在、蕴含、完整且来源合适；
- 证据不足时是否澄清/拒答；
- 冲突是否披露而非随意选择。

### 3.4 Lifecycle correctness

- dense/sparse/metadata/ACL 是否同 snapshot；
- 增量更新是否无空窗/双版本；
- cache 是否绑定安全域与知识版本；
- 删除、回滚、恢复是否传播所有派生物。

端到端回答分高不能替代后三层的可审计性。

---

## 4. 学习顺序

```text
阶段 A · 证据与基线
01 概率管线、closed-book、oracle-context、引用语义

阶段 B · 离线表示
02 parse/chunk/evidence span
03 embedding/exact-vs-ANN/index consistency

阶段 C · 在线选择
04 sparse+dense/fusion/rerank/candidate budget
05 rewrite/decomposition/route/fidelity

阶段 D · 仅按错误升级
06 hierarchy/graph/agentic/structured/multimodal

阶段 E · 证明与运营
07 incomplete oracle/claim-citation/paired eval
08 snapshot/CDC/cache/security/delete/DR
```

每一阶段都以 artifact 收尾：

1. task taxonomy + oracle evidence；
2. versioned chunk manifest；
3. exact vs ANN curve；
4. candidate-loss trace；
5. query lineage 与 route confusion matrix；
6. 高级架构同预算消融；
7. claim-citation eval report；
8. snapshot release + deletion receipt + restore drill。

---

## 5. 最小但严谨的基线

不要固定某个 vendor/参数；用以下实验矩阵建立本领域基线：

```text
B0 closed-book
B1 full/long-context（可承受的同一语料）
B2 sparse BM25
B3 dense exact → dense ANN
B4 hybrid rank fusion
B5 B4 + rerank
B6 oracle context
```

固定：

- knowledge/ACL snapshot；
- query 分层与用户权限；
- 最终 context token 和候选预算；
- generator/prompt/grader 版本；
- 候选/基线相同 query 与环境。

报告：

```text
knowledge coverage
evidence Recall@k / all-evidence success / nDCG
claim correctness / citation correctness & completeness
abstain coverage–risk
cost/success + p95/p99
worst slices + security failures
```

若 B0 已达标，检索可能没有必要；若 B6 仍低，先修生成/任务；只有 B6 高而 B5 低时，检索/数据升级才有明确空间。

---

## 6. 2025–2026 的前沿变化：从固定 RAG 到数据与控制循环

近两年值得关注的不是“又多一个 RAG 缩写”，而是四个方向：

1. **Agentic / reasoning RAG**：迭代选择数据源、拆解、多跳、证据充分性和停止；代价是随机性、成本与评测复杂度。
2. **Graph/hierarchical retrieval 的查询—建库权衡**：GraphRAG local/global、DRIFT、LazyGraphRAG、RAPTOR 等把局部/全局检索和 upfront/query-time 成本放到同一设计空间。
3. **Capability-level evaluation**：不仅评最终答案，还评 retrieval necessity、改写/路由保真、evidence coverage、冲突处理和停止；2025 的 RAGCap-Bench 是这一趋势的研究示例。
4. **Data-centric Agentic RAG**：2026 ACL Findings 的 survey 强调数据收集、任务构建、评测和训练生命周期；这与生产中的 provenance/snapshot/delete 直接对应。

这些研究/benchmark 是候选与启发，不是生产 SOTA 证明。应注明论文/预印本状态、harness、数据和成本，再在自己的分层任务上复验。

---

## 7. 工具选择原则

框架和产品变化很快。选择 parser、embedding、vector/search store、reranker、eval 和 observability 时，验证：

| 类别 | 关键 spike |
|---|---|
| Parser | 布局/表格/OCR/坐标保真、增量与许可证 |
| Embedding | 领域 exact retrieval、prefix/截断、吞吐、版本钉死 |
| Store | ANN recall–p99、过滤选择率、更新/删除、snapshot/restore |
| Reranker | 长文截断、语言/hard negatives、candidate cost |
| Framework | 状态/错误语义、可观测、版本迁移、能否绕过抽象 |
| Eval | oracle 数据结构、Judge 校准、逐样本导出、统计复现 |
| Trace | 内容 opt-in、ACL、artifact refs、schema 版本、删除 |

工具表可以帮助建立候选集，但不应写成长期排行榜。关键业务契约要由自己的代码/测试掌握。

---

## 8. 常见反模式

- 把 RAG 当作“加了就不幻觉”；
- 没有 closed-book/long-context/oracle baseline 就追 GraphRAG；
- 用固定 512 token、top-5 作为跨语料真理；
- 只看向量相似度，不标最小 evidence span；
- 只报 Recall@k，不区分 relevance oracle 是否完整；
- 只检查答案有引用，不检查 claim–citation entailment；
- query rewrite 改掉时间/地区/否定却不可追踪；
- 为召回先跨租户搜索再 post-filter；
- 更新时先删后插，或 dense/sparse 各自最新；
- 删除源文档但保留摘要、图节点和语义 cache；
- Agentic RAG 无全局预算、证据 ledger、no-progress 与 abstain。

---

## 9. 毕业追问树

**定义**：RAG 选择的到底是“相关文本”还是“能支持 claim 的证据”？

**机制**：query 如何经过 rewrite、ACL、retrieval、fusion、rerank 到 context？

**假设**：知识存在吗？oracle 完整吗？ANN/截断/生成各自上限是什么？

**反例**：旧政策语义最相似、引用真实却不支持结论、更新双版本、删除残留会怎样？

**落地**：chunk/index/query/evidence/snapshot 的 schema 是什么？

**评测**：如何做 pooled relevance、hard negatives、claim-citation、paired CI 与 cost/success？

**运营**：如何 dual-read、原子切 alias、回滚、紧急 deny、lineage delete 和 restore？

能沿这棵追问树答到底，才算掌握生产 RAG，而不只是会调用向量库。

---

> 下一步：[01-RAG基础与核心原理](01-RAG基础与核心原理.md)。
>
> 2025–2026 延伸：[Agentic RAG Survey（2025）](https://arxiv.org/abs/2501.09136) · [RAG Evaluation Survey（2025）](https://arxiv.org/abs/2504.14891) · [Data-Centric Agentic RAG Survey（ACL Findings 2026）](https://aclanthology.org/2026.findings-acl.78/) · [Microsoft GraphRAG](https://www.microsoft.com/en-us/research/project/graphrag/)
