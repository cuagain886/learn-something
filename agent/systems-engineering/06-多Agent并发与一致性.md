# 06 · 多 Agent 并发与一致性

> 目标：不再只讨论 Supervisor、Swarm 等拓扑，而是回答并行系统真正困难的问题：工作如何切分、谁拥有状态、冲突如何处理、何时合并、谁验证，以及协调开销何时吞掉并行收益。

---

## 1. 多 Agent 首先是并发系统

增加 Agent 数量不会自动增加智能。它同时增加：

- 可用计算与上下文隔离。
- 调度、通信和合并成本。
- 重复工作与错误传播概率。
- 共享资源冲突。
- 身份、权限和审计主体。

因此先问：

> 任务中是否存在**彼此低耦合、可独立验证、能够同时推进**的工作？

如果没有，多 Agent 只是把一个串行推理过程变成更昂贵的消息传递。

---

## 2. 四种并行化，别混成一个概念

| 类型 | 切分方式 | 例子 | 合并方式 |
|------|----------|------|----------|
| **数据并行** | 同一操作处理不同数据分片 | 100 份文档分别抽取 | 结构化聚合 |
| **任务并行** | 不同独立子目标 | 前端、后端、测试 | 依赖图 + 集成测试 |
| **探索并行** | 多种候选策略 | 多条搜索路径、多个方案 | verifier/best-of-N |
| **流水线并行** | 不同阶段重叠 | 检索、分析、写作、审校 | 有界队列 |

每种模式的正确性条件不同：

- 数据并行要避免漏分片/重复分片。
- 任务并行要管理依赖和写冲突。
- 探索并行要有独立选择标准，否则只是多份幻觉投票。
- 流水线要有 backpressure，否则上游会淹没下游。

---

## 3. 用扩展版 Amdahl 思考收益上限

设可并行比例为 p，Agent 数为 n，协调开销占比为 c(n)：

~~~text
Speedup(n) ≈ 1 / ((1 - p) + p / n + c(n))
~~~

Agent 系统的 c(n) 通常增长很快，因为包含：

- 编排者拆解和派发。
- 每个子 Agent 的重复上下文加载。
- 交接消息和结果压缩。
- 冲突重试。
- 汇总与独立验证。

例：任务只有 60% 可并行，4 个 Agent 理想上限为 1 / (0.4 + 0.6/4) ≈ 1.82 倍；若协调占原任务时间 20%，只有约 1.33 倍。多 Agent 不应按 Agent 数线性估算提速。

成本通常也不等于 n 倍：

~~~text
总成本 =
  子任务推理
  + 重复上下文
  + 编排
  + 汇总
  + 验证
  + 冲突/失败重做
~~~

并行主要降低 wall-clock，不天然降低 token 或费用。

---

## 4. Work contract：Agent 间不要只传自然语言

编排者派发的 work item 建议包含：

~~~json
{
  "work_item_id": "wi_42",
  "objective": "核对供应商 C 的售后条款",
  "inputs": [
    {"artifact_id": "art_quote_c", "sha256": "..."}
  ],
  "allowed_tools": [
    "procurement.suppliers.get_terms",
    "web.fetch"
  ],
  "write_scope": {
    "artifacts": ["supplier_c_fact_card"],
    "state_paths": ["/facts/supplier_c"]
  },
  "constraints": {
    "deadline": "2026-07-18T12:00:00Z",
    "max_steps": 8,
    "max_cost_usd": 0.4
  },
  "acceptance": [
    "引用供应商官方条款",
    "明确保修期限、响应 SLA、排除项",
    "所有引用可访问且 observed_at 不超过 24 小时"
  ],
  "result_schema": "supplier_fact_card@2"
}
~~~

这个 contract 同时是调度、权限、合并和评测边界。子 Agent 不应默认继承父 Agent 的全部工具、历史和凭据。

---

## 5. 所有权优先于“共享记忆”

### 5.1 Single-writer 原则

对每个可变对象指定一个 writer：

- 一个 Agent 拥有一份 fact card。
- 一个集成 Agent 拥有最终报告。
- 一个 migration Agent 拥有某个数据库 schema。

其他 Agent 通过 artifact 或建议 patch 贡献，不直接覆写。Single-writer 大幅减少合并语义。

### 5.2 Shared scratchpad 为什么危险

所有 Agent 读写同一段自然语言 scratchpad 会导致：

- last-write-wins 覆盖。
- 摘要把不确定推测“洗成”事实。
- 恶意/错误上下文在多个 Agent 间传播。
- 无法知道某句话是谁、基于什么证据写的。
- 读取时看到不一致中间态。

更安全的是 append-only event + materialized view：

~~~text
FactProposed(agent, claim, evidence)
FactVerified(verifier, claim_id)
FactRejected(verifier, reason)
ArtifactCreated(agent, artifact_id, hash)
WorkItemCompleted(agent, work_item_id, evidence)
~~~

共享视图由确定性 reducer 生成；原事件保留 provenance。

---

## 6. 三种状态合并策略

### 6.1 分区所有权

各 Agent 写不相交 state path，最简单可靠：

~~~text
/research/competitor_a  ← agent A
/research/competitor_b  ← agent B
/research/competitor_c  ← agent C
~~~

### 6.2 乐观并发 + Compare-and-swap

必须改同一对象时带 base_version。版本冲突后重新读取和生成 patch，不直接覆盖。

适合低冲突、小 patch；高冲突时重试会浪费大量模型调用。

### 6.3 领域 reducer

只有能定义数学合并的状态才自动 merge：

- 集合 union。
- 计数器累加。
- 按稳定 ID 合并映射。
- 有显式优先级的状态机。

不要对任意自然语言使用“LLM merge”并宣称一致性。LLM 可以提出合并候选，但确定性约束和 verifier 必须判定。

CRDT 也不是万能答案；它能解决某些数据类型的并发收敛，不能解决两个 Agent 对同一事实作出冲突判断时谁正确。

---

## 7. 隔离工作区与集成

代码/文件类任务推荐：

~~~text
每个 Agent：
  独立 worktree / container / branch
  独立临时文件和依赖缓存
  只读共享基线
  明确写目录

集成 Agent：
  按依赖顺序读取提交
  检查 diff 与冲突
  运行全量测试
  合并或退回
~~~

不要让 16 个 Agent 同时写同一个工作目录。文件锁只能避免同时写字节，不能避免语义冲突。

Anthropic 的 C 编译器实验使用任务锁文件协调多个会话，并依赖大量测试作为收敛信号；近 2,000 个会话和约 2 万美元成本也说明，这是用极高计算换取长时并行的案例，不应被概括成“多 Agent 更省”。

---

## 8. 编排者是调度器，不是群聊主持人

一个可靠 orchestrator 应做：

1. 建立依赖图。
2. 找出 ready work items。
3. 原子认领并分配预算/权限。
4. 控制最大并发。
5. 处理超时、重试、取消。
6. 收集结构化结果。
7. 触发独立 verifier。
8. 根据证据推进依赖。

它不应不断把全部聊天历史广播给所有 Agent。广播造成上下文复制、信息污染和角色漂移。

中央编排的优点是预算、终止、验证和错误隔离更清楚；缺点是单点瓶颈。可通过分层编排扩展，但每层仍要有明确的任务所有权和预算，不要退化为自由漫游网络。

---

## 9. 验证要与生成解耦

多 Agent 最危险的错误模式之一是：

~~~text
agent A 产生错误事实
→ agent B 在摘要中接受
→ agent C 基于摘要推导
→ supervisor 看到三方一致，误以为可信
~~~

共识不等于正确，尤其当 Agent 使用相同模型、提示和来源时，错误高度相关。

建议：

- verifier 读取原始 artifact 和 evidence，不只读摘要。
- 生成 Agent 不为自己的结果做最终验收。
- 对事实使用来源级验证；对代码使用测试；对状态使用查询。
- 投票仅用于候选排序，不能替代外部 oracle。
- 记录 claim lineage，发现源事实错误时能使所有派生结论失效。

---

## 10. Backpressure 与资源治理

每个层级设置：

- max_children_per_agent。
- max_total_active_agents。
- max_handoff_depth。
- 每租户/任务 token 和费用池。
- 工具并发/速率限制。
- artifact 大小上限。
- 队列长度与超时。

当 verifier 吞吐低于 worker 产出时，应停止派生新工作，而不是让未验证结果无限堆积。流水线中可用：

- bounded queue。
- credit/token based dispatch。
- 优先验证会解锁最多依赖的 work item。
- 取消被更优候选支配的探索分支。

---

## 11. 失败隔离

多 Agent 故障至少分三层：

### 11.1 系统设计/规格失败

- 任务不可并行却强拆。
- 角色职责重叠。
- 缺接受标准。
- 工具或上下文给错。

### 11.2 Agent 间失配

- 交接丢失关键约束。
- 一个 Agent 误解另一个的 schema。
- 共享错误事实。
- 重复认领或互相等待。

### 11.3 验证/终止失败

- 没有 verifier。
- supervisor 过早停止。
- 子 Agent 无限互相转交。
- 局部成功被误报为全局成功。

MAST 研究在五类多 Agent 框架、150 多个任务上归纳出 14 种失败模式，并将其归到类似的规格/系统设计、Agent 间失配、验证与终止三组。它提醒我们：仅增强角色 prompt 或改拓扑并不能消除系统性问题。

---

## 12. 什么时候多 Agent 值得

必须同时满足大部分条件：

- 任务存在高比例可并行部分。
- 子任务输入/输出可以结构化。
- 子任务能独立验证。
- 上下文隔离确有价值。
- 单 Agent 已受上下文或 wall-clock 限制。
- 有明确集成者和全局 verifier。
- 业务能接受额外成本和复杂度。

Anthropic 的多 Agent research 系统在其内部研究 eval 上报告了显著提升，但官方也把收益归因于可并行搜索和独立上下文，并明确指出 token 成本更高。这是“适合宽度优先研究”的证据，不是所有任务的普遍结论。

---

## 13. 检验清单

- [ ] 任务属于数据、任务、探索还是流水线并行？
- [ ] 是否估算可并行比例和协调开销？
- [ ] 每个 work item 是否有结构化 contract、预算和 acceptance？
- [ ] 每份可变状态是否有明确 writer？
- [ ] 是否避免共享自然语言 scratchpad 作为 source of truth？
- [ ] 并发写是否使用分区、CAS 或确定性 reducer？
- [ ] Agent 是否使用隔离 workspace？
- [ ] verifier 是否读取原始 evidence，而不是相信多 Agent 共识？
- [ ] 是否有 backpressure、最大并发、handoff depth 和全局预算？
- [ ] 任一子 Agent 失败时，是否能隔离并返回部分结果/影响范围？

---

## 14. 参考资料

- [Anthropic：How We Built Our Multi-Agent Research System](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Anthropic：Building a C Compiler with a Team of Parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler)
- [Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657)
- [MAST：Multi-Agent Systems Failure Taxonomy](https://multi-agent-systems-failure-taxonomy.github.io/MAST/)
- [A2A Protocol 1.0 Specification](https://a2a-protocol.org/latest/specification/)
- [LangGraph：Subgraphs and Persistence](https://docs.langchain.com/oss/python/langgraph/use-subgraphs)

