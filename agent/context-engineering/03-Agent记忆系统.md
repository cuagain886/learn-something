# 03 · Agent 记忆系统（Memory）

> 目标：掌握 Agent 的记忆——working context、短期任务状态与长期记忆的边界，情景/语义/程序性分类，写入、冲突、检索、遗忘和恢复机制，以及不同实现路线的验证方法。

---

## 1. 为什么 Agent 需要记忆

上下文窗口是有限且短暂的（[文档 02](02-上下文工程基础.md)）。但 Agent 常常需要：
- **跨多轮**记住任务进展（这次会话里前面做了什么）。
- **跨多会话**记住用户偏好、历史事实（"用户上次说他用 Postgres"）。
- **积累经验**（"上次这么做失败了，这次换个方式"）。

这些都装不进、也不该长期占用上下文窗口。**记忆系统就是把这些信息存到窗口之外、需要时再取回**的机制。

> 核心类比：**人脑的工作记忆（当前在想的）很小，但长期记忆（存在脑子里、需要时回忆）很大。** Agent 也分这两层。

---

## 2. 短期记忆 vs 长期记忆 ⭐

### 2.1 短期记忆（Short-term / Working Memory）
- **不是只等于当前上下文窗口**。窗口是本轮送入模型的 working set；短期任务状态还可以持久化在 checkpoint、数据库和 artifact 中，在后续轮次再选择性装入。
- 受任务生命周期约束，但不一定随进程或会话结束消失。
- 典型内容：当前计划、未解决问题、最近观察、预算、等待原因、临时假设和 artifact 引用。
- 管理手段：滑动窗口、摘要（[文档 04](04-上下文管理技巧.md)）。

### 2.2 长期记忆（Long-term Memory）
- **存在窗口之外**（向量库、图谱、数据库），**跨会话持久化**。
- 需要时**检索相关片段**回填到当前上下文。
- **这就是"给上下文做的 RAG"**（见第 4 节）。

```
            ┌──────────── 当前上下文窗口 ────────────┐
短期记忆 ──→ │ 最近几轮对话 + 最近几步 + 检索回来的长期记忆 │
            └────────────────────────▲───────────────┘
                                      │ 按需检索回填
长期记忆 ──→ ┌─────────────────────────┴──────────────┐
（窗口外）   │  向量库 / 知识图谱 / 数据库（持久化）      │
            │  存：用户偏好、历史事实、过往经历、学到的规则 │
            └────────────────────────────────────────┘
```

---

## 3. 三类长期记忆（有用的认知分类，不是唯一标准）⭐

Agent 设计常借用认知科学的三类术语；不同论文/产品边界并不完全一致，工程 schema 不能只存一个 `memory_type` 就算完成：

| 类型 | 存什么 | 例子 | 类比人脑 |
|------|--------|------|----------|
| **情景记忆（Episodic）** | 具体的过往交互/事件 | "用户上周让我帮他订过去北京的票" | 回忆"我经历过的事" |
| **语义记忆（Semantic）** | 事实、偏好、知识 | "用户偏好简洁回答""用户是后端工程师" | 知道"是什么" |
| **程序性记忆（Procedural）** | 学到的行为、规则、技能 | "处理这类工单要先查 X 再做 Y""上次这么做失败了" | 会做"怎么做" |

- **情景**：发生过什么（带时间/情境）。
- **语义**：稳定的事实和偏好（去掉了具体情境）。常由情景记忆**提炼/归纳**而来。
- **程序性**：怎么做事的经验/规则，让 Agent 越用越熟。

> 从哪类记忆开始取决于任务损失：个性化可能先做语义偏好，审计/复盘需要情景记忆，重复流程优化才需要程序性记忆。每类都应先证明 closed-book/当前状态不足，再引入写入与召回风险。

---

## 4. 检索只是记忆系统的一条数据路径

长期记忆的**候选召回**可以复用 [rag/](../rag/00-RAG学习计划总览.md) 的索引与检索技术：

```
写入候选： observation → claim 提取 → policy/consent/验证 → 版本化事实或事件
派生索引： canonical memory → embedding/lexical/graph index（带 lineage）
召回候选： current decision → scope/time/ACL filter → retrieve/rerank
使用门： conflict/freshness/confidence 检查 → context block 或 abstain
```

所以 RAG 的分块、嵌入、混合检索、重排和元数据过滤适用于记忆的**派生索引与候选召回**。canonical memory 还需要身份/scope、valid time 与 record time、冲突、写入授权、同意、版本、遗忘和派生数据治理；checkpoint 又有不同的一致性与恢复语义。

记忆的难点贯穿写入、合并、召回、使用、撤销和删除，见第 5 节及后文的数据模型。

---

## 5. 记忆的关键难题：写什么、何时写、何时取、何时忘 ⭐

记忆通常由在线交互持续写入，错误还会反馈到未来决策，因此必须回答以下问题：

### 5.1 写什么（What to write）
不能把每句话都存（噪声、隐私、冲突与攻击面会累积）。LLM 可生成 claim candidate，但写入门必须校验主体同意、scope、证据、时间、敏感等级、重复/冲突和可撤销性；高影响程序性规则不能由一次模型自评直接固化。

### 5.2 何时写（When to write）
- 实时写便于保留原始 provenance，却扩大写放大和在线攻击面；批量归并可做去重/冲突审查，却可能丢失逐事件时序和遭遇摘要误差。
- 选择依据是允许的 freshness、RPO、人工/自动验证成本与撤销 SLA，不只是调用价格。

### 5.3 何时取（When/What to recall）
- 不是每步都检索记忆（贵、引噪声）。要判断"这一步需要回忆吗、回忆什么"。
- 检索回来要**重排、取最相关的少量**（呼应 [文档 02](02-上下文工程基础.md) 的"按需取少量"）。

### 5.4 何时更新/遗忘（Update & Forget）
- 事实会变（"用户从用 MySQL 改成了 Postgres"）——旧记忆要能**更新/失效**，否则检索到过时信息。
- 记忆要能"遗忘"无用/过期内容，否则越积越多、信噪比下降。
- **能追踪事实随时间变化**是高级记忆系统的关键能力（见 Zep 的时序图谱）。

### 5.5 记忆记录需要双时间与来源

“用户使用 Postgres”至少有两个时间：

- **valid time**：这个事实在现实中何时成立。
- **transaction/observed time**：系统何时得知并写入。

```yaml
memory_id: mem_778
subject: user_42
predicate: preferred_database
value: PostgreSQL
memory_type: semantic
scope: personal_preference
valid_from: 2026-07-01
valid_to: null
observed_at: 2026-07-19T11:10:00+08:00
source:
  kind: user_statement
  event_id: msg_991
status: active
supersedes: mem_612
sensitivity: personal
retention_policy: user_managed
writer: memory_policy_v5
```

只有 `timestamp` 无法回答“事实何时开始有效”与“我们何时才知道”。时间推理、审计和回放都需要区分。

### 5.6 写入不是一次 LLM 抽取

生产写入管道：

```text
原始事件
  → 候选抽取
  → 写入策略（值得记？有同意？属于哪个 subject/scope？）
  → 事实/偏好/规则分类
  → 去重与实体解析
  → 与现有 active memory 做冲突/时间合并
  → 安全与敏感级别检查
  → commit + lineage + 可撤销记录
```

LLM 可以生成候选，但 commit 由策略层决定。尤其不能把网页、工具返回或另一个用户的话直接提升成“用户长期偏好”。

### 5.7 冲突不是简单“新覆盖旧”

| 情形 | 处理 |
|------|------|
| 用户明确修改偏好 | 新记录 `supersedes` 旧记录，保留历史 |
| 两个权威系统值不同 | 标记 conflict，按 authority/version 对账 |
| 推测与确认事实冲突 | confirmed 覆盖 hypothesis，但保留证据链 |
| 规则版本升级 | 程序性记忆按 schema/tool/policy version 失效 |
| 多 Agent 并发写 | 用 subject+predicate+scope version/CAS，不能 last-write-wins |

“遗忘”也不一定物理删除：可能是标记过期、从检索索引撤除、按合规要求硬删除，并清理摘要、embedding、缓存和派生产物。

---

## 6. 框架路线（以能力验证代替排名）

| 框架 | 架构路线 | 特点/适用 |
|------|----------|-----------|
| **Mem0** | 向量/图等记忆管道 | 候选抽取、更新和检索；要用自己的时间/冲突任务验证 |
| **Zep / Graphiti** | **时序知识图谱** | 重点验证实体、关系、事实有效期与更新查询 |
| **Letta（前 MemGPT）** | 自编辑记忆块（self-editing memory blocks） | 让 Agent 自己管理/编辑自己的记忆 |
| **LangGraph / LangMem** | checkpoint + 记忆工具 | checkpoint 是执行状态，不自动等于可检索的用户长期记忆 |
| **LangChain ConversationBufferMemory** | 简单缓冲 | 入门/原型，保留对话历史 |

**选型测试必须覆盖：**写入 precision/recall、时间更新、冲突、abstention、用户隔离、删除传播、污染恢复、召回延迟和下游任务收益。框架官网的单次 recall demo 不能证明这些能力。

> 和 [rag/03](../rag/03-嵌入模型与向量数据库.md) 选向量库一样：先在自己场景小规模验证，别只看宣传。

---

## 7. 工程要点

- **canonical memory schema** 至少含 subject/tenant、claim/event、memory type、source/evidence、valid time、record time、scope/consent、confidence、version/status 与 lineage；派生索引继承 ACL 和删除范围。
- **召回后还有使用门**：相关度之外检查主体、时间、scope、冲突、置信度和 taint，再按当前决策的 token/风险预算装配（[文档 02](02-上下文工程基础.md)）。
- **写入要幂等、可合并但不抹历史**：用 stable key、CAS 与 `supersedes` 建版本链；新观察不直接物理覆盖旧事实。
- **评估记忆质量**：记忆系统也要评估——该记的有没有记住？该取的有没有取到？过时的有没有失效？（呼应 [rag/07](../rag/07-RAG评估与可观测性.md) 的检索评估。）

### 7.1 五层记忆评测

| 层 | 指标/问题 |
|----|-----------|
| 写入 | 应写事实的 recall；不该写内容的 precision；实体/作用域正确性 |
| 存储 | 去重、版本链、时间区间、租户隔离、删除完整性 |
| 检索 | evidence recall/precision、temporal filter、abstention、hard negatives |
| 阅读/推理 | 多会话、更新、时间、多跳和 premise awareness |
| 下游 | 任务成功、个性化收益、错误固化率、成本/延迟 |

LongMemEval 明确覆盖信息抽取、多 session 推理、时间推理、知识更新和 abstention。2026 的 LongMemEval-V2 进一步面向 Agent 环境经验，区分静态状态、动态跟踪、workflow knowledge、gotchas 与 premise awareness。使用这些 benchmark 时仍要注意领域和历史构造与真实产品不同。

### 7.2 记忆投毒与恢复

每条记忆要有 lineage，才能在发现恶意/错误源后：

1. 隔离源事件。
2. 找出所有派生 memory、摘要、profile 和 embedding。
3. 从 active index 撤除。
4. 重建受影响的 materialized views。
5. 回放关键任务或通知受影响用户。

只删除向量库里一个 chunk 不够，因为错误可能已经被 consolidation 写入用户画像或程序性规则。

---

## 8. 常见坑

- **把所有对话原样全存** → 噪声爆炸、检索质量崩。要提炼。
- **记忆不更新/不遗忘** → 检索到过时事实，答错。
- **每步都检索记忆** → 贵且引入噪声。按需取。
- **检索到的记忆全塞进上下文** → 上下文膨胀、迷失在中间。重排限量。
- **多租户不按用户隔离记忆** → 串户、隐私泄露。元数据过滤必做。
- **不评估记忆** → 不知道记得对不对、取得准不准。
- **把 checkpoint 当长期记忆** → checkpoint 用于恢复一次执行，长期记忆用于跨任务选择性复用，生命周期和 schema 不同。
- **新事实直接覆盖旧事实** → 丢失 valid time 和审计链；使用 version/supersedes。
- **程序性记忆无版本** → 工具 schema 更新后仍复用旧操作经验。
- **删除原文但保留摘要/embedding** → 隐私删除不完整；要沿 lineage 删除派生物。

---

## 9. 本章小结

- 记忆 = 窗口外的选择性状态；短期任务状态可在 checkpoint 中持久化，working context 只是其本轮投影。
- 长期记忆三类（认知科学分类）：**情景（发生过什么）、语义（稳定事实/偏好）、程序性（怎么做事的经验）**；通常先从语义记忆做起。
- RAG 技术适用于记忆的派生索引与候选召回，但**记忆不是 RAG 的别名**：canonical state、双时间、scope/consent、版本冲突、写入门、撤销与删除 lineage 才定义其正确性。
- 难点贯穿整个生命周期：claim 如何产生和验证、何时可用、如何处理新旧冲突、如何防污染、如何撤销并删除全部派生物。
- 框架按向量/时序图/自编辑/checkpoint 等路线选择；用写入、时间、冲突、删除、污染和下游 eval 验证，避免静态排名。
- 工程上：记忆带元数据（按用户隔离）、检索重排限量、写入去重更新、记忆也要评估。

## 10. 检验清单

- [ ] 能区分 working context、短期任务状态、checkpoint 和长期记忆，并解释为什么短期状态不等于当前窗口里的文本。
- [ ] 能说出三类长期记忆及各自存什么。
- [ ] 能解释"记忆即 RAG"，以及记忆比 RAG 多出的写入侧难题。
- [ ] 知道为什么"全存原始对话"是错的，正确做法是提炼。
- [ ] 能根据需求（如追踪事实变化）选出合适的记忆框架，并知道多租户要按用户隔离。
- [ ] 能解释 working context、短期 task state、checkpoint 与长期记忆的区别。
- [ ] 能设计包含 valid time/observed time/source/supersedes/sensitivity 的 memory schema。
- [ ] 能写出候选抽取到策略 commit 的写入管道，并处理冲突/CAS。
- [ ] 能设计写入、存储、检索、阅读和下游五层评测。
- [ ] 能沿 lineage 完成记忆投毒隔离与派生数据删除。

---

> 下一步：[04-上下文管理技巧](04-上下文管理技巧.md) —— 在有限窗口里具体怎么管。
>
> 一手资料：[MemGPT](https://arxiv.org/abs/2310.08560) · [Generative Agents](https://arxiv.org/abs/2304.03442) · [LongMemEval](https://arxiv.org/abs/2410.10813) · [LongMemEval-V2](https://arxiv.org/abs/2605.12493)（2026 预印本，注意复现与外推边界）
