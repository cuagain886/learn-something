# 02 · Agent 评估的维度与指标：世界状态、可靠性与风险

> 目标：建立一套能支持产品决策的指标体系。核心不是“指标越多越好”，而是让每个指标对应一个明确的业务问题、可验证的 oracle 和决策阈值。

---

## 1. 指标树：结果是北极星，轨迹和组件用于解释

```text
业务结果 / 世界状态（是否真的完成、是否安全）
├─ 可靠性：success、pass@k、pass^k、恢复率、重复副作用率
├─ 质量：正确性、完整性、证据忠实度、部分完成度
├─ 风险：越权、泄露、损失、CVaR / worst-slice
├─ 效率：成本/成功任务、p50/p95/p99 延迟、工具/模型调用数
└─ 诊断
   ├─ 轨迹：动作、参数、状态转移、循环、交接、等待与补偿
   └─ 组件：检索、记忆、路由、工具、grader、沙箱、审批
```

**结果级指标负责做上线决策；轨迹和组件指标负责定位与解释。** 如果组件分变好但真实世界状态没变好，它不是最终收益。

---

## 2. 结果 oracle：优先验证 world state

### 2.1 为什么不能只读最终回复

对于会行动的 Agent，文本“已完成”不是事实。应按如下优先级设计 oracle：

1. **环境/数据库最终状态**：订单状态、余额、ACL、文件 hash、工单归属；
2. **可执行验证**：单元测试、SQL 断言、浏览器 DOM 状态、API 查询；
3. **事件与收据**：带幂等键的支付/发送/审批 receipt；
4. **文本判定**：仅用于无法完全结构化的开放质量；
5. **用户反馈**：作为延迟且有选择偏差的结果信号，而非即时真值。

一个售后任务的成功函数可以写成：

\[
Y=\mathbb{1}[\text{refund.amount}=A]
\cdot\mathbb{1}[\text{order.state}=\text{REFUNDED}]
\cdot\mathbb{1}[\text{duplicate\_effects}=0]
\cdot\mathbb{1}[\text{policy\_violations}=0]
\]

这比“回复包含‘退款成功’”严格得多。

### 2.2 部分成功不要伪装成二元成功

长任务可把目标拆为带权验收项：

\[
\text{completion}=\frac{\sum_j w_j I_j}{\sum_j w_j}
\]

但必须保留**硬约束**：发生越权、重复扣款或敏感泄露时，即使其它子目标完成，也不能被平均成高分。

---

## 3. 可靠性：一次成功与持续成功是不同能力

对每个任务运行 `k` 次，令 `Y_{ij}∈{0,1}` 表示任务 `i` 的第 `j` 次是否成功。

### 3.1 普通成功率

\[
\hat p=\frac{1}{nk}\sum_{i=1}^{n}\sum_{j=1}^{k}Y_{ij}
\]

它回答“随机抽一次运行成功的概率”，但隐藏了任务难度差异与不稳定性。

### 3.2 `pass@k`：允许尝试 k 次，至少一次成功

\[
\widehat{pass@k}=\frac1n\sum_i \mathbb{1}\left[\sum_jY_{ij}\ge1\right]
\]

适合代码生成候选、搜索多个方案等**允许挑选/验证**的场景。若没有可靠 selector，却报告 pass@k，会高估真实系统。

### 3.3 `pass^k`：连续 k 次全部成功

\[
\widehat{pass^k}=\frac1n\sum_i \mathbb{1}\left[\sum_jY_{ij}=k\right]
\]

它衡量一致性，适合客服、财务动作、自动化运维等不能靠“多试几次总有一次对”的系统。

若对某个任务的重复运行独立同分布、单次成功概率为 `p_i`，理论上：

\[
pass@k_i=1-(1-p_i)^k,\qquad pass^k_i=p_i^k
\]

真实运行会共享模型故障、环境状态和缓存，未必 iid；应优先报告实测值，并按任务聚类计算不确定性。**不要先求一个全局平均 `p` 再代公式**，那会抹掉任务异质性。

### 3.4 还应报告的可靠性指标

- 首次成功率与重试后成功率；
- 恢复成功率：故障发生后最终回到正确状态的比例；
- 重复副作用率：重试造成重复发送/扣款/写入；
- 人工介入率、超时率、无法判定率；
- 连续失败簇与最差任务族，而非只给宏平均。

---

## 4. 轨迹指标：评“可观察行为”，不要评隐藏思维

| 维度 | 可计算定义示例 | 典型误用 |
|---|---|---|
| 工具/动作正确性 | 合法动作、schema、参数约束、前置条件通过率 | 要求严格匹配唯一工具序列 |
| 状态进展 | 动作后距离目标状态是否下降 | 用模型自述“进展良好” |
| 必要动作召回 | 合规所需检查/审批是否执行 | 把所有参考动作都设为必需 |
| 冗余与循环 | 无状态增益调用、重复查询、环路触顶率 | 只数步数，惩罚必要恢复 |
| 错误恢复 | 故障识别、重试分类、补偿与降级成功率 | 把任何重试都视为低效 |
| 交接质量 | 接收方能否基于 envelope 继续、上下文缺失率 | 只看是否调用了 handoff |
| 动作安全 | 权限、批准、策略、影响范围、幂等约束 | 只评最终措辞是否礼貌 |
| 证据支撑 | 可见结论是否能追溯到工具结果/来源 | 把自然语言 CoT 当成事实 |

若系统显式产出计划、证据表或行动理由，可以评其一致性与支撑度；但不要要求记录隐藏 chain-of-thought，也不要把模型生成的理由当作忠实因果解释。

### 4.1 轨迹距离不是“编辑距离”

对开放路径，更合理的是检查：

\[
score_{traj}=w_1\cdot\text{invariant-pass}
+w_2\cdot\text{key-action-recall}
-w_3\cdot\text{unsafe-actions}
-w_4\cdot\text{waste}
\]

其中安全不变量通常是硬门槛，不应被效率加分抵消。轨迹总分适合排序与诊断，不应掩盖其各组成项。

---

## 5. 组件指标：必须能连回端到端结果

| 组件 | 局部指标 | 与端到端的连接问题 |
|---|---|---|
| 检索 | Recall@k、nDCG、context precision | 召回的证据是否真正被采用且支持结果？ |
| 记忆 | 写入精确率、召回率、过期命中率、删除完整性 | 记忆是否改变了动作并改善结果？ |
| 路由 | route accuracy、abstain、错误路由成本 | 错路由是否可恢复，代价是什么？ |
| 工具 | schema valid、业务成功、延迟、幂等 | HTTP 200 是否真的产生正确状态？ |
| 多 Agent | handoff 完整率、join 正确率、冲突率 | 并行是否改善质量/延迟，还是只增加成本？ |
| 审批 | 触发召回、误拦率、批准后版本一致性 | 是否防止了高影响错误且未批准旧提案？ |

组件离线指标提高却没有端到端收益，常见原因是：切片不代表生产、局部目标错位、下游没有使用信号，或其它瓶颈主导结果。

---

## 6. 置信度与校准：Agent 知不知道自己会失败

若 Agent 输出置信度 `q_i` 或风险分，应评**校准**，而不只是准确率。

### 6.1 Brier Score

\[
BS=\frac1N\sum_i(q_i-y_i)^2
\]

越低越好。它同时惩罚过度自信和缺乏区分度。

### 6.2 ECE 与可靠性图

将预测按置信度分桶：

\[
ECE=\sum_b\frac{|B_b|}{N}\left|acc(B_b)-conf(B_b)\right|
\]

ECE 依赖分桶方式，不能单独使用；应配合 reliability diagram、Brier score 和关键风险切片。

### 6.3 Coverage–Risk

允许 Agent 在低置信时 abstain/转人工：

- `coverage(τ)=P(q≥τ)`：自动处理比例；
- `risk(τ)=P(failure | q≥τ)`：自动处理部分的失败风险。

阈值不是追求最高准确率，而是在自动化覆盖率、人工容量和错误损失之间选择工作点。

---

## 7. 风险不能只看平均值

### 7.1 风险加权损失

不同失败代价不同：

\[
L=\sum_c w_c\,P(\text{failure type}=c)
\]

例如“多问一次澄清”与“错误转账”不能等权。高风险类别还应设零容忍/上限门槛。

### 7.2 尾部风险与 CVaR

令单次执行损失为 `L`，`VaR_α` 是 `α` 分位点；常用定义下：

\[
CVaR_\alpha=\mathbb{E}[L\mid L\ge VaR_\alpha]
\]

它关注最坏 `1-α` 的平均损失。离散分布有边界细节，生产实现应使用明确的经验分位/CVaR 定义。样本不足时，直接报告 worst-slice、最大影响范围和高严重度事件数往往更诚实。

必须切片：权限等级、语言、长上下文、工具故障、复杂度、新老用户、地区/政策版本等。总体平均可能掩盖某一小群体的灾难性失败。

---

## 8. 成本与延迟：用“成功任务”归一化

只报平均每次调用成本会奖励“快速失败”。更有决策意义的是：

\[
\text{cost per success}=\frac{\sum_i cost_i}{\sum_i Y_i}
\]

同时报告：

- 首次成功成本、包含重试/人工后的总完成成本；
- p50/p95/p99 端到端延迟和关键 span 延迟；
- token、模型调用、工具调用、搜索/存储费用；
- 在成功率约束下的 Pareto frontier，而不是把所有量压成单一分数。

延迟应包含队列、外部工具、审批等待和重试。只计模型生成时间会系统性低估 Agent 用户体验。

---

## 9. 指标卡：每个指标都要有契约

```yaml
metric: safe_world_state_success
purpose: release_gate
population: zh-CN after-sales traffic, weighted by production mix
unit: task
oracle: db_assertion_v7
hard_failures: [unauthorized_action, duplicate_refund, pii_leak]
trials_per_task: 5
aggregation: traffic_weighted_mean
uncertainty: task-clustered bootstrap 95% CI
slices: [policy_version, difficulty, tool_fault, user_tier]
owner: eval-platform
decision: lower_CI >= 0.91 and no new critical failure
```

若无法填写 `purpose/oracle/population/decision`，这个指标多半只是仪表盘装饰。

---

## 10. 一个可落地的最小指标集

对“自动处理退款”的 Agent：

1. **北极星**：安全 world-state success；
2. **硬门槛**：越权、重复退款、隐私泄露、金额错误；
3. **可靠性**：单次 success、`pass^3`、故障恢复率；
4. **自动化策略**：coverage–risk、转人工率；
5. **效率**：cost/success、p95/p99 延迟；
6. **诊断**：政策检查召回、参数错误、工具故障、补偿成功、循环率；
7. **分层**：政策版本、金额区间、故障注入、复杂度和语言。

这比“最终答案 4.3/5、平均 6 步”更接近真实上线决策。

---

## 11. 检验清单

- [ ] 能解释为什么 world-state oracle 优先于最终文本。
- [ ] 能准确区分 `pass@k` 与 `pass^k`，并说明 iid 假设边界。
- [ ] 能设计 coverage–risk 曲线而不是只报置信度。
- [ ] 能说明为什么 cost/success 比 cost/request 更适合比较 Agent。
- [ ] 能报告尾部风险和关键切片，而不是只报平均分。
- [ ] 能为一个指标写出 population、oracle、聚合和 release decision。

---

> 下一步：[03-评估方法与LLM裁判](03-评估方法与LLM裁判.md) —— 讨论 oracle、LLM Judge 和人工标签怎样组合成可信测量系统。
>
> 主要参考：[τ-bench](https://arxiv.org/abs/2406.12045) · [Anthropic：Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) · [AI Agents That Matter](https://arxiv.org/abs/2407.01502)
