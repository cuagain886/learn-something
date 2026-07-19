# 01 · Agent 循环与 ReAct

> 目标：把 Agent 核心循环拆成策略、状态、动作、观察、控制与终止语义，并用 ReAct 作为可实验的闭环基线。读完能写出一个 Agent turn 的不变量，也能解释它何时不该替代固定 workflow。

---

## 1. 从"一问一答"到"循环"

普通 LLM 调用是无状态的一次性映射：给 prompt → 得到一次输出 → 结束。它做不了"需要多步、且步数事先不确定"的任务，比如"帮我查清楚 A 公司最近的融资情况并对比竞品"——这需要先搜、再读、再判断够不够、可能再搜。

**Agent 的核心创新就是把 LLM 放进一个循环**，让它在循环里**反复决策**，直到任务完成：

```
while 任务未完成 and 未超出预算:
    thought = LLM 思考("当前状态下，下一步该做什么？")
    if thought 决定"调用工具":
        observation = 执行工具(工具名, 参数)   # 真实世界发生的事
        把 observation 加入上下文
    else if thought 决定"已完成":
        return 最终答案
```

注意两个关键点：
1. **任务状态在演化，但不应等同于消息堆积**：目标、工作项、预算、effect receipt 和 artifact 应外置持久化；每轮只把当前决策所需的状态投影进上下文。
2. **模型提出下一动作或 finish proposal，控制面决定是否允许执行/结束**：结束前仍要验证成功谓词、安全不变量、预算和未决副作用。Agent 与固定 workflow 的差异是策略对路径拥有更大动态控制权，而不是模型天然拥有最终 authority（见 [INDEX 1.1](../INDEX.md)）。

---

## 2. ReAct：Reasoning + Acting ⭐

**ReAct（推理 + 行动）** 是 2022 年提出的经典闭环范式，也是“路径依赖中间观察”任务的重要实验基线。核心思想是：

> **让策略决策与环境行动交替进行**：模型基于当前 belief/context 提出动作（通常是工具调用），运行时执行后返回观察，再更新状态并重新决策。论文中的自然语言 Thought 是一种实现，不是生产 API 必须暴露的字段。

### 2.1 一个 ReAct turn 的解剖

经典的 ReAct 把每一轮组织成三段：

```
Thought:    我需要知道 A 公司最新一轮融资金额。我应该搜索它。
Action:     web_search(query="A公司 最新融资 2026")
Observation: [搜索返回] A公司于2026年3月完成B轮融资，金额…
Thought:    拿到了融资信息。但还要对比竞品 B，我再搜一下 B。
Action:     web_search(query="B公司 融资情况")
Observation: …
Thought:    信息齐了，可以总结回答。
Action:     finish(answer="…")
```

- **Thought（推理）**：在 ReAct 论文里是可见的语言推理轨迹；在现代推理模型/API 中，内部推理可能隐藏、加密或只提供摘要。生产系统不应把“要求模型吐出完整思维链”当作可靠性或审计方案。真正应记录的是**输入证据、候选动作、最终动作、简短业务理由、工具结果和验证证据**。
- **Action（行动）**：一个结构化的工具调用（工具名 + 参数）。现代 API 的 strict schema 可约束结构；语义、授权、前置条件和副作用仍要由运行时验证（见 [文档 02](02-工具使用ToolUse.md)）。
- **Observation（观察）**：工具执行的真实返回，被喂回上下文。

### 2.2 为什么 ReAct 有效

- **决策与反馈闭环**：策略可以依据观察修正下一步；只有当观察可信、时效/范围匹配且模型正确使用证据时，它才会减少无根据生成，恶意或陈旧 observation 反而会误导。
- **动态适应**：不像写死的流程，ReAct 每一步都基于最新观察重新决策，能应对"事先不知道要几步"的开放任务。
- **最小原型简单**：一个循环 + 一组只读工具即可跑通；生产实现仍需外部状态、策略、幂等、预算、恢复、观测和验证。

> 结论：先以单次调用/固定 workflow 为 E0，再把单 Agent ReAct 作为 E1；只有 E1 在同任务、同环境、同预算的 paired eval 中解决了路径适应问题，才保留新增复杂度。

### 2.3 现代实现：用 Function Calling 承载 Action

早期 ReAct 靠解析模型输出的文本（`Action: xxx`），脆弱易错。现代做法是用原生 function calling / tool use API 承载动作。启用严格 schema 时，平台可以约束**结构**；它仍不能证明参数语义正确、调用被授权或动作值得执行。内部推理、reasoning item、reasoning summary 和普通文本的可见性又依供应商而异，不能写成统一字段假设。

```python
# 供应商无关的 ReAct 运行时骨架。具体 item/message 顺序遵循所用 API。
state = load_task_state(task_id)
for step in range(MAX_STEPS):
    assert_budget_and_deadline(state)
    model_turn = llm(build_context(state), tools=discover_tools(state))
    append_model_turn_before_results(state, model_turn)

    if model_turn.tool_calls:
        for call in model_turn.tool_calls:
            intent = validate_schema_semantics_and_policy(call, state)
            result = execute_via_tool_broker(intent)  # 内含幂等、超时和审计
            append_tool_result(state, call.id, result)
        checkpoint(state)
        continue

    if verify_success_predicate(state, model_turn.output):
        return commit_final_output(state, model_turn.output)
    append_feedback(state, "未满足成功条件，请补充证据或转人工")

return terminate_with_partial_result(state, reason="budget_exhausted")
```

---

## 3. ReAct 的失败模式（必须知道，否则 Agent 会"跑飞"）⭐

ReAct 把局部推理和执行交织在同一条不断增长的轨迹里；任务变长后，目标约束、旧观察和新证据会竞争上下文预算，控制器可能偏离原计划。具体发生率高度依赖模型、任务和 harness，不能用一个脱离评测集的统一百分比概括。常见失败模式：

| 失败模式 | 现象 | 缓解 |
|----------|------|------|
| **无限循环 / 重复调用** | 反复调同一个工具、查同样的东西 | 步数上限、检测重复动作、把"已经查过 X"写进上下文 |
| **计划放弃（Plan Abandonment）** | 随着上下文变长，忘了最初要干啥，半途跑偏 | 周期性"重申目标"、用 Planning 模式固定计划 |
| **过早停止（Premature Stopping）** | 没查全就以为答完了 | 加完成度检查、用 Reflection 自评是否充分 |
| **错误的工具选择 / 幻觉工具调用** | 调了不存在的工具、传了错参数 | 工具描述清晰、Schema 严格、参数校验（[文档 02](02-工具使用ToolUse.md)） |
| **工具失败后误重试** | 超时后不知道写操作是否成功，却再次执行 | 读/幂等动作按策略重试；写动作进入 `OUTCOME_UNKNOWN`，先对账 |
| **上下文爆炸（Context Explosion）** | 多轮累积，observation 太长塞爆窗口 | 截断/摘要 observation、上下文工程（INDEX 阶段4） |

> 这些失败正是后面几篇（规划、反思）存在的理由：
> - 老"放弃计划/跑偏" → [Planning](04-规划模式Planning.md) 把计划固定下来。
> - 老"答得不对/不全" → [Reflection](03-反思模式Reflection.md) 加自我评估。
> - 调用太多太贵 → [ReWOO 等](04-规划模式Planning.md) 减少 LLM 往返。

---

## 4. 循环控制：工程上最关键的部分 ⭐

让 Agent 跑起来不难，让它**优雅地停下来**才是工程重点。一个生产级循环必须有：

### 4.1 停止条件（Stop Conditions）
- **任务完成**：代码验证成功谓词、必要证据和后置条件；“模型不再请求工具”只是候选终止信号，不是完成证明。
- **步数上限（Max Steps/Iterations）**：硬性循环次数上限，到了就停。**必备的兜底**，否则一旦跑飞就无限烧钱。
- **预算上限**：token 预算、时间预算、成本预算，任一超限即停。
- **无进展检测**：连续 N 步在重复、或没有产生新信息 → 中止或换策略。

### 4.2 防重复 / 防循环
- 记录已执行的"动作指纹"（工具名+参数），若重复出现就提示模型"你已经做过这个了"。
- 把关键状态（已知信息、已尝试路径）显式维护在上下文里，减少模型"健忘"。

### 4.3 失败处理
- 参数错误、权限拒绝等确定失败可以作为结构化 observation 反馈；瞬时错误只在工具幂等且策略允许时重试。
- 写请求超时可能是“远端成功、本地没收到响应”，必须记录 operation 并查询/对账，不能简单让模型再试一次。
- 设置重试上限、总 deadline 和熔断，避免在一个依赖上死磕。

### 4.4 超限后的兜底
- 到达步数/预算上限时，不要静默失败：返回"已尽力收集的中间结果 + 说明未完成的原因"，或降级到人工。

> 口诀：**没有步数上限的 Agent 不能上线。** 这是新手最常忘、后果最严重的一点。

---

## 5. ReAct 的几个变体（了解即可，详见后续）

- **ReWOO（Reasoning WithOut Observation）**：先一次性把所有推理和工具调用计划好，再批量执行，减少 LLM 往返 → **省成本**。代价是不能根据中间结果调整。详见 [文档 04](04-规划模式Planning.md)。
- **Plan-and-Execute**：先规划完整步骤，再逐步执行（带 re-plan）。适合复杂多步任务。[文档 04](04-规划模式Planning.md)。
- **Reflexion**：在 ReAct 上加"失败后反思并记住教训"，提升正确性。[文档 03](03-反思模式Reflection.md)。

它们都是为 ReAct 的某个失败模式打的补丁。**默认仍从 ReAct 起步。**

### 5.1 从 POMDP 看 ReAct 的局限

ReAct 可理解为根据当前历史/工作上下文近似选择下一动作的在线策略：

\[
a_t\sim\pi_{LLM}(a\mid h_t, tools, instructions)
\]

但 `h_t` 不等于真实世界状态。工具只返回部分观察，观察还可能陈旧、截断或对抗性。可靠实现必须把已确认事实、假设、未知项、资源版本和证据来源维护为结构化 belief approximation，再把当前所需投影进上下文。完整推导见 [Agent 形式化模型与决策理论](07-Agent形式化模型与决策理论.md)。

### 5.2 一个 turn 必须守住的不变量

1. 每个 tool call ID 最终只能进入一个确定结果或 `OUTCOME_UNKNOWN`，不能悬空或重复结算。
2. 模型输出的调用意图必须先记录，再执行工具并关联结果。
3. 模型只能提议动作；schema、语义、授权、审批和预算由模型外控制面判定。
4. 世界改变型动作必须有 operation ID、幂等键、调用前/后状态与 verifier。
5. observation 必须携带 provenance、时间和必要的资源版本，不能只回填一段无来源文本。
6. 已消耗步数、token、费用和 deadline 单调推进，checkpoint 恢复不能把预算重置。

这些不变量比“prompt 里要求谨慎”更接近生产正确性的定义。

---

## 6. 使用场景

| 场景 | ReAct 是否适合 |
|------|----------------|
| 开放式、步数不确定的任务（调研、排查、多步问答） | ✅ 非常适合 |
| 需要边做边看、根据中间结果调整 | ✅ ReAct 的强项 |
| 步骤完全固定、可预测 | ❌ 用写死的工作流更稳更省（不需要 Agent） |
| 对成本极敏感、调用要尽量少 | ⚠️ 考虑 ReWOO 减少往返 |
| 对正确性要求极高、有明确评判标准 | ⚠️ ReAct 之上叠加 Reflection |

---

## 7. 常见坑

- **没设步数上限** → 跑飞时无限循环烧钱。**头号大坑。**
- **把完整 Thought 当成审计日志** → 内部推理未必可见，也不等于事实证据；记录可验证的动作理由、输入证据和结果。
- **靠正则解析文本动作** → 脆弱，改用原生 function calling。
- **所有工具失败都自动重试** → 写操作可能重复产生副作用；结果未知时先对账。
- **observation 原样塞回、不加处理** → 上下文爆炸。长结果要截断/摘要。
- **不维护"已做过什么"** → 模型健忘、重复劳动、跑偏。
- **指望纯局部反应自动解决长依赖规划** → 可能短视或反复 replan；应比较显式计划、搜索或确定性 workflow，并验证计划在新观察下的失效语义。

---

## 8. 本章小结

- Agent loop = **策略提议动作 → 控制面校验/执行 → 环境返回观察 → 更新任务状态**；真实状态不应只累积在上下文里。
- **ReAct 是路径依赖任务的重要基线**：行动引入环境观察，但观察本身也有可信度、时间和注入风险；是否优于固定 workflow 必须实测。
- 现代实现用 **function calling 承载 Action**，它改善结构可靠性，但不保证语义、授权或业务正确性。
- ReAct 有明确失败模式（无限循环、计划放弃、过早停止、工具失败崩溃、上下文爆炸），**后续模式都是针对这些失败的补丁**。
- **循环控制是工程重点**：停止条件、步数上限（必备）、防重复、失败喂回、超限兜底。
- 变体（ReWOO/Plan-and-Execute/Reflexion）按已观测失败选择，并与更简单基线做同预算消融。

## 9. 检验清单

- [ ] 能默画 Agent 循环，并说清状态如何在上下文累积。
- [ ] 能解释论文中的可见 Thought 与现代隐藏推理/业务理由/审计证据的区别。
- [ ] 能列出至少 4 种 ReAct 失败模式及缓解手段。
- [ ] 能说出一个生产级循环必须有的停止条件，并解释"为什么没有步数上限的 Agent 不能上线"。
- [ ] 能区分确定失败、瞬时失败和结果未知，并说明为什么写超时不能直接重试。
- [ ] 能列出一个 turn 的调用关联、权限、预算、状态和副作用不变量。

---

> 下一步：[02-工具使用ToolUse](02-工具使用ToolUse.md) —— 给 Agent 装上手脚。
>
> 一手资料：[ReAct 原论文](https://arxiv.org/abs/2210.03629) · [OpenAI Agents SDK](https://developers.openai.com/api/docs/guides/agents) · [OpenAI Using tools](https://developers.openai.com/api/docs/guides/tools) · [Anthropic — Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
