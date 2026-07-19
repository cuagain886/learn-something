# 07 · RAG 评估与可观测性

> 目标：掌握如何量化 RAG 的好坏。**这是从"玄学调参"走向"工程"的分水岭**——没有评估，所有优化都是猜。

---

## 1. 为什么评估是 RAG 工程的核心

RAG 有大量可调的东西：分块大小、嵌入模型、top-k、重排模型、Prompt、要不要上 HyDE/GraphRAG……

> 如果不能**量化**每次改动带来的影响，你就只能凭感觉调参，永远在原地打转。"我感觉换了分块好像好点"是不可接受的。

评估让你能回答：
- 我这次改动到底是变好了还是变差了？变了多少？
- 系统现在的瓶颈在**检索**还是**生成**？
- 上线后效果有没有衰退（数据漂移、新类型问题）？

---

## 2. 最重要的思想：分开评估"检索"和"生成"

[文档 01](01-RAG基础与核心原理.md) 强调过，这里再展开。RAG 答错可能有两个完全不同的原因，**必须分开诊断**：

```
                  ┌─ 检索质量差：相关资料根本没找回来  → 调检索（分块/混合/重排）
RAG 答案错了 ──────┤
                  └─ 生成质量差：资料找回来了，但模型没用好/编造 → 调 Prompt/模型
```

- 如果**检索指标**就低（资料没找回），那调 Prompt 毫无意义。
- 如果检索指标高但**生成指标**低（资料对但答错），才是生成端的问题。

**先看检索，再看生成。** 这个诊断顺序能省掉大量无效折腾。

---

## 3. RAGAS 指标（常用实现之一）

**RAGAS** 是常用 RAG 评测框架之一，可用 LLM Judge/embedding 等近似一些检索与生成指标；它不等于 ground truth，也不能让评测“无需人工标注”。正式使用仍需领域人工锚点、oracle 审计、版本钉死和误差校准。

评估需要的数据通常是四元组：`question`（问题）、`contexts`（检索到的 chunk）、`answer`（模型生成的答案）、`ground_truth`（标准答案，部分指标需要）。

### 3.1 检索侧指标

#### Context Recall（上下文召回率）⭐ 最关键的检索指标
> 回答问题所需的信息，有多少比例出现在了检索到的 chunk 里？

- 衡量：**该找回的有没有都找回来**。
- recall < 100% 意味着**有信息没被检索到**——这是漏召回，调分块/混合检索/扩大 top-k。
- 需要 ground_truth。**这是诊断"是不是检索的锅"的首要指标。**

#### Context Precision（上下文精度）
> 检索到的相关 chunk，是不是都排在了前面（而不是混在一堆噪声里）？

- 衡量：**找回的东西里，相关的排序靠不靠前**、噪声多不多。
- precision 低 → 召回里噪声多/排序差 → 该加重排、调 top-k。

> 召回和精度的关系：**Recall 管"全不全"，Precision 管"准不准/排序好不好"**。这正对应 [文档 04](04-检索策略-混合检索与重排序.md) 里"先广召回（保 recall）→ 再精排（提 precision）"的设计。

### 3.2 生成侧指标

#### Faithfulness（忠实度）⭐ 最关键的生成指标，直接对应"幻觉"
> 答案里的每个论断，是否都能在检索到的 chunk 里找到依据？

- 算法：把答案拆成若干"论断（claim）"，逐个核对能否被 context 支持，算支持比例。
- **faithfulness 低 = 模型在编造/脑补**（用了 context 之外的东西）。这是 RAG 里最该盯的反幻觉指标。
- 提升手段：强化 Prompt 约束（"只根据资料回答")、换更听话的模型、减少噪声 chunk。

#### Answer Relevancy（答案相关性）
> 答案是否切题地回应了问题（没有跑题、没有答非所问、不啰嗦）？

- 注意：相关 ≠ 正确。一个答案可以很切题但事实错误（那是 faithfulness 的问题）。

#### Answer Correctness（答案正确性，需 ground_truth）
> 答案和标准答案相比对不对。综合了语义相似和事实一致。

### 3.3 其他实用指标

- **Noise Sensitivity（噪声敏感度）**：检索里混入无关 chunk 时，答案会不会被带偏。
- **Context Entities Recall**：标准答案涉及的实体，有多少在 context 里出现（实体密集场景有用）。

---

## 4. 评估数据集怎么来（实操难点）

评估的前提是有"题库"。这往往是落地时最现实的障碍。

### 4.1 黄金测试集（Golden Dataset）
人工精心标注的"问题 - 标准答案 -（理想情况下还有）相关 chunk"集合。
- 人工集可以表达领域意图与风险，但不天然是真值：需双标/仲裁、标注指南、snapshot、证据 span 与一致性统计，并记录争议项。
- 少量高质量样本可用于启动错误发现，但样本量应由任务分层、指标方差、MDE 和风险决定；几十条通常不足以证明小幅提升或低频严重失败。

### 4.2 合成数据生成（Synthetic Data Generation）
用 LLM 从文档/世界状态生成候选问答与证据集合；生成器、prompt、模型和 source snapshot 都要版本化。
- **优点**：能定向扩充结构化切片和 hard-negative 变体。
- **缺点**：容易继承生成器偏好、产生“看到 chunk 才会问”的简单题，并遗漏真实用户表达；需人工锚点、去重、污染检查和真实流量切片。
- 合成题用于覆盖与压力测试，不能替代按目标用户分布采样的 locked holdout。

### 4.3 线上真实流量
积累真实用户的问题，结合用户反馈（点赞/点踩、是否追问、是否转人工）做评估。**最贴近真实分布**，但要做好日志和反馈采集。

---

## 5. 评估的两个层次

- **组件级评估（离线）**：单独评检索（recall/precision）或单独评生成（faithfulness）。**用于开发期定位瓶颈、对比方案**。改动一个环节就跑一遍，看指标涨跌。
- **端到端评估（离线 + 线上）**：评整个系统最终答案的质量。**用于回归测试和上线把关**。

典型工作流：改动（如换分块策略）→ 在固定评估集上跑 RAGAS → 对比指标 → 决定是否采纳。**像跑单元测试一样跑 RAG 评估**。

---

## 6. 线上可观测性（Observability）

离线评估管"上线前"，可观测性管"上线后"。生产 RAG 必须能"看见"每个请求内部发生了什么。

### 6.1 要记录什么（Tracing / 链路追踪）
对每个请求，记录完整链路：
- 原始 query、改写后的 query
- 检索召回的 chunk（含分数、来源）
- 重排后的 chunk
- 最终拼的 Prompt
- 模型输出、token 用量、各阶段延迟

> 出问题时，这条 trace 让你能精确定位是哪一环出错（漏召回？重排把对的排下去了？Prompt 拼错了？）。**没有 trace，线上问题基本无法排查。**

### 6.2 要监控什么（Metrics）
- **延迟**：各阶段（检索/重排/生成）的延迟分布（p50/p95/p99）。
- **成本**：token 消耗、API 费用、嵌入/重排调用次数。
- **质量代理指标**：用户点踩率、转人工率、"资料中未提及"的回答比例、平均检索分数。
- **检索健康度**：召回为空的比例、低分召回比例。

### 6.3 工具
LangSmith、Langfuse、Arize Phoenix 等提供开箱即用的 trace + 评估 + 监控。学习期可以先用 Phoenix（开源）或 LangSmith。

### 6.4 线上评估
- **采样 + LLM 裁判**：对线上流量抽样，用 LLM-as-judge 跑 faithfulness 等指标，持续监控质量。
- **用户反馈闭环**：点赞/点踩、追问、转人工，回流成评估数据和优化方向。

---

## 7. LLM-as-Judge 的注意事项

RAGAS 等用 LLM 当裁判，方便但有坑：
- **裁判模型有偏好**：可能偏向长答案、偏向某种风格。
- **不稳定**：同一输入多次打分可能不同（可多次取平均、设低温度）。
- **要校准**：用一小批人工标注样本校准 LLM 裁判的打分，确认它和人类判断一致，再大规模用。
- **裁判能力不是充分条件**：更强模型也可能有位置/长度/自偏好和注入风险；是否可用要看它相对人工锚点的混淆矩阵与切片误差。

---

## 8. 常见坑

- **没有评估集就开始调参** → 一切优化都是猜，无法判断好坏。
- **只看端到端、不拆检索/生成** → 答错了不知道该修哪。
- **只追求高 recall 不管 precision**（或反之）→ 召回一堆噪声，或精准但漏关键信息。
- **评估集太小或不代表真实分布** → 离线涨点、上线翻车。
- **合成数据不审核** → 题目质量差，评估结论失真。
- **线上没有 trace** → 出问题完全抓瞎。
- **盲信 LLM 裁判** → 没校准、没考虑裁判偏差。
- **评估集泄漏到优化中**（用同一批数据反复调参过拟合）→ 最好分出独立的 held-out 集。

---

## 9. 深入：不完备 Oracle、Claim 级引用与统计比较

### 9.1 先定义 RAG estimand 与 snapshot

```yaml
population: "中文企业政策问答，按近 30 天流量分层"
knowledge_snapshot: kb-2026-07-15
access_context: user/tenant ACL fixture v8
answer_outcome: claim-correct + citation-complete + no-unauthorized-evidence
retrieval_unit: source evidence span
trials: paired candidate/baseline
```

同一问题在不同知识库版本、用户权限和时间下可能有不同正确答案。评测样本必须绑定 `knowledge_snapshot + ACL + valid_time`，否则历史分数不可复现。

### 9.2 Retrieval oracle 通常不完备

对查询 `q`，全库真正相关集合 `R_q` 很难穷举。只把一条“黄金 chunk”标为 relevant，会错误惩罚其它同样有效证据；把未标注文档当 non-relevant 又会低估新系统。

构建方法：

1. 对 BM25、dense、hybrid、候选新系统做 top-depth pooling；
2. 去重并盲化系统来源；
3. 领域人员按 `irrelevant / useful / directly_supports / authoritative` 分级；
4. 对未评判文档标 `unjudged`，不自动等同负例；
5. 追加随机样本估计 pool 漏标；
6. 新系统大量返回 pool 外候选时重新 judging，避免 incumbent bias。

Oracle provenance 要记录标注者、证据 span、时间、ACL、rubric 和 adjudication。

### 9.3 标准 IR 指标及边界

\[
Precision@k=\frac{|top_k\cap R_q|}{k},\qquad
Recall@k=\frac{|top_k\cap R_q|}{|R_q|}
\]

若 `R_q` 不完备，Recall 分母不可信。还可用：

\[
MRR=\frac1{|Q|}\sum_q\frac1{rank_q(first\ relevant)}
\]

适合只需一个答案证据的任务；多跳需要全部 evidence，不应只看 first relevant。

分级相关性使用：

\[
DCG@k=\sum_{i=1}^{k}\frac{2^{rel_i}-1}{\log_2(i+1)},\qquad
nDCG@k=DCG@k/IDCG@k
\]

它奖励权威/直接支持证据排在前面。定义 relevance grade 时要纳入来源质量、时效和用户权限，不能只看主题相似。

### 9.4 多跳证据集合

若答案需 evidence set `E_q={e1,e2,e3}`，单块 recall 会掩盖缺 hop：

```text
Evidence Coverage = retrieved required hops / total required hops
All-Evidence Success = I[E_q ⊆ retrieved]
Connection Correctness = 实体/时间/关系 join 是否正确
```

一个系统召回 2/3 个 hop 可能 Context Recall 很高，却无法正确回答。应报告 all-evidence success 和每 hop 的条件召回。

### 9.5 Hard negatives 才能测出排序器差异

随机负例太容易。Hard negatives 包括：

- 主题相同但答案不同；
- 同一政策旧版本；
- 实体同名但租户/地区不同；
- 含 query 关键词但不回答；
- 能支持相反结论的冲突证据；
- 权限不允许但语义高度相关；
- 合成改写与真实文档高度相似却事实错误。

训练和测试 hard negatives 要隔离，防 reranker 记模板。权限不允许的候选应在检索前阻断，同时可作为安全负面测试，不进入模型上下文。

### 9.6 Claim-level Faithfulness 与 Citation Correctness

将答案拆为需要外部证据的原子 claims `c_i`，建立 claim–citation 矩阵：

\[
M_{ij}=\mathbb 1[source_j\ entails\ claim_i]
\]

指标：

\[
Citation\ Completeness=
\frac{\sum_iw_i\mathbb 1[\exists j:M_{ij}=1]}{\sum_iw_i}
\]

\[
Citation\ Precision=
\frac{\#\ cited\ sources\ that\ support\ associated\ claims}
{\#\ cited\ sources}
\]

还应检查：

- 引用是否能解析到固定 `doc_version/span/hash`；
- 来源是否权威、有效且用户有权访问；
- 多来源冲突是否披露；
- 一条 citation 是否被错误地挂在包含多个 claim 的长句末尾；
- 生成器是否引用了 contextual summary/HyDE 等派生提示而非原始证据。

### 9.7 Judge pipeline 的误差分解

Claim eval 常有三步：

```text
claim extraction → evidence alignment → entailment judgment
```

任何一步都可能错。用人工 anchor 分别测：claim 漏拆/过拆、citation 对齐、entailment TP/FP/FN；候选答案可能对 Judge 做 prompt injection，应作为不可信数据隔离。Judge 版本升级要做 anchor 双跑和时间序列桥接，详见 [evaluation/03](../evaluation/03-评估方法与LLM裁判.md)。

### 9.8 Paired evaluation 与不确定性

同一 query/snapshot 上运行基线 A 和候选 B，计算逐题差 `d_i`，按 query/task 聚类 bootstrap 置信区间。二元端到端成功可用 McNemar 检验，连续 nDCG/faithfulness 可用配对 bootstrap/置换；同时报告效应量与 CI，不只报 p-value。

预定义：

- primary outcome（如 claim-correct & citation-complete）；
- MDE 与功效；
- 安全/成本/p95 非劣门槛；
- 任务切片和多重比较处理；
- 每个 query 的 Agent/environment 随机重复。

### 9.9 诊断矩阵

| Oracle context | Retrieved context | Answer | 结论 |
|---|---|---|---|
| 足够 | 缺证据 | 错 | 数据/检索/过滤瓶颈 |
| 足够 | 足够 | 错 | 组装/生成/引用瓶颈 |
| 不足 | 看似足够 | 错 | 题目或 oracle 有问题 |
| 足够 | 含冲突/噪声 | 不稳 | 重排/冲突策略/鲁棒性 |
| closed-book 对 | retrieval 后错 | 错 | 检索引入有害上下文 |

### 9.10 Trace 与敏感数据

RAG trace 至少记录 query lineage、snapshot、ACL decision、候选 ranks/scores、reranker truncation、最终 selected evidence 与 citation mapping。原始 query/chunk 可能含敏感数据，应默认使用 hash/ref/分类，内容采集 opt-in；禁止将未授权候选为了“调试”写入普通 trace。

---

## 10. 本章小结

- **没有评估就没有工程**——量化是优化的前提。
- 核心思想是分开评估知识存在、检索、上下文组装和生成；closed-book/oracle-context 能定位上限与负增益。
- 检索侧：**Context Recall**（全不全）、**Context Precision**（准不准/排序好不好）。
- 生成侧：**Faithfulness**（反幻觉，最关键）、**Answer Relevancy**（切不切题）、Answer Correctness（对不对）。
- 评估集需绑定知识快照、ACL 和时间；少量样本可启动诊断，正式比较的样本量由 MDE、方差、切片和风险决定。
- 像跑单元测试一样跑 RAGAS，每次改动都对比指标。
- 线上靠**可观测性**：全链路 trace + 延迟/成本/质量监控 + 用户反馈闭环。
- LLM-as-judge 方便但要校准、防偏差。

## 11. 检验清单

- [ ] 拿到"RAG 答错"的 case，能说出"先查 Context Recall 再查 Faithfulness"的诊断流程。
- [ ] 能解释 Context Recall vs Precision、Faithfulness vs Answer Relevancy 的区别。
- [ ] 知道至少三种获取评估数据的方法及各自优缺点。
- [ ] 知道线上 trace 要记录哪些字段，以及为什么没它就无法排查。
- [ ] 了解 LLM-as-judge 的局限和校准方法。
- [ ] 能解释 relevance pool 不完备以及为什么 unjudged 不等于 irrelevant。
- [ ] 能计算/解释 MRR、nDCG、all-evidence success 与 claim-citation 矩阵。
- [ ] 能为两个 RAG 版本设计配对统计与知识 snapshot/ACL 固定。

---

> 下一步：[08-生产工程化与最佳实践](08-生产工程化与最佳实践.md) —— 真实生产环境的工程问题。
>
> 深入参考：[RAG Evaluation Survey（2025）](https://arxiv.org/abs/2504.14891) · [evaluation/](../evaluation/00-评估与可观测学习总览.md)
