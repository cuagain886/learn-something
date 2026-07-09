# 01 · Agent 循环与 ReAct

> 目标：彻底搞懂 Agent 的"引擎"——核心循环，以及最基础最实用的 ReAct 范式。读完能默写出一个 Agent turn 的解剖，并知道循环怎么控制、会怎么跑飞。

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
1. **状态在累积**：每一轮的思考、行动、观察都被加进上下文，下一轮 LLM 能看到全部历史。这就是 Agent 的"工作记忆"。
2. **是 LLM 自己决定下一步**，包括"是否结束"。这正是 Agent 和"写死的工作流"的本质区别（见 [INDEX 1.1](../INDEX.md)）。

---

## 2. ReAct：Reasoning + Acting ⭐

**ReAct（推理 + 行动）** 是最经典、最实用的 Agent 范式（2022 年提出，至今是默认起点）。核心思想极简：

> **让模型把"推理"和"行动"交替进行**：先用自然语言"想"一下（Thought），再决定一个"动作"（Action，通常是调工具），看到结果（Observation）后再"想"，如此循环。

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

- **Thought（思考）**：把"为什么这么做"显式写出来。这一步看似多余，其实极重要——**让模型"先想再做"显著提升决策质量**，也让你能在 trace 里看懂它的推理（可调试）。
- **Action（行动）**：一个结构化的工具调用（工具名 + 参数）。现代 API 用 function calling 保证它是合法 JSON（见 [文档 02](02-工具使用ToolUse.md)）。
- **Observation（观察）**：工具执行的真实返回，被喂回上下文。

### 2.2 为什么 ReAct 有效

- **推理与行动相互增强**：推理帮模型规划和调整"该用哪个工具、查什么"；行动（观察真实结果）又把外部世界的事实拉进来，**纠正模型的臆想**，减少幻觉。
- **动态适应**：不像写死的流程，ReAct 每一步都基于最新观察重新决策，能应对"事先不知道要几步"的开放任务。
- **简单**：不需要复杂的规划器或多个 Agent，一个循环 + 一组工具就能跑。

> 结论：**ReAct + 好工具是 Agent 的默认起点，能解决现实中大多数任务。** 先把它做扎实，再考虑别的模式。

### 2.3 现代实现：用 Function Calling 承载 Action

早期 ReAct 靠解析模型输出的文本（`Action: xxx`），脆弱易错。**现代做法是用原生 function calling / tool use API**：模型直接输出结构化的工具调用，框架/API 保证格式合法。Thought 则放在模型回复的文本部分或专门的 reasoning 字段里。本质还是 ReAct，只是工程上更稳。

```python
# 现代 ReAct 循环骨架（伪代码，以 messages + tools API 为例）
messages = [{"role": "user", "content": 用户目标}]
for step in range(MAX_STEPS):                  # 步数上限：防跑飞
    resp = llm(messages, tools=工具列表)
    if resp.tool_calls:                        # 模型决定调工具（Action）
        for call in resp.tool_calls:           # 可能并行多个
            result = 执行工具(call.name, call.args)   # Observation
            messages.append(工具结果消息(call.id, result))
        messages.append(resp)                  # 把模型的思考+调用也存进历史
    else:                                      # 模型给出了最终回答
        return resp.content
raise 超出最大步数            # 兜底：见第 4 节循环控制
```

---

## 3. ReAct 的失败模式（必须知道，否则 Agent 会"跑飞"）⭐

ReAct 把推理和执行混在一起，规模一大就暴露出"控制器不稳定"。**研究显示即使很强的模型也会在超过 50% 的情况下"中途放弃原计划"。** 常见失败模式：

| 失败模式 | 现象 | 缓解 |
|----------|------|------|
| **无限循环 / 重复调用** | 反复调同一个工具、查同样的东西 | 步数上限、检测重复动作、把"已经查过 X"写进上下文 |
| **计划放弃（Plan Abandonment）** | 随着上下文变长，忘了最初要干啥，半途跑偏 | 周期性"重申目标"、用 Planning 模式固定计划 |
| **过早停止（Premature Stopping）** | 没查全就以为答完了 | 加完成度检查、用 Reflection 自评是否充分 |
| **错误的工具选择 / 幻觉工具调用** | 调了不存在的工具、传了错参数 | 工具描述清晰、Schema 严格、参数校验（[文档 02](02-工具使用ToolUse.md)） |
| **工具失败后崩溃** | 工具报错后不会处理，整个任务挂掉 | 把错误信息作为 Observation 喂回，让模型重试/换路 |
| **上下文爆炸（Context Explosion）** | 多轮累积，observation 太长塞爆窗口 | 截断/摘要 observation、上下文工程（INDEX 阶段4） |

> 这些失败正是后面几篇（规划、反思）存在的理由：
> - 老"放弃计划/跑偏" → [Planning](04-规划模式Planning.md) 把计划固定下来。
> - 老"答得不对/不全" → [Reflection](03-反思模式Reflection.md) 加自我评估。
> - 调用太多太贵 → [ReWOO 等](04-规划模式Planning.md) 减少 LLM 往返。

---

## 4. 循环控制：工程上最关键的部分 ⭐

让 Agent 跑起来不难，让它**优雅地停下来**才是工程重点。一个生产级循环必须有：

### 4.1 停止条件（Stop Conditions）
- **任务完成**：模型显式调用 `finish` / 不再请求工具 → 正常结束。
- **步数上限（Max Steps/Iterations）**：硬性循环次数上限，到了就停。**必备的兜底**，否则一旦跑飞就无限烧钱。
- **预算上限**：token 预算、时间预算、成本预算，任一超限即停。
- **无进展检测**：连续 N 步在重复、或没有产生新信息 → 中止或换策略。

### 4.2 防重复 / 防循环
- 记录已执行的"动作指纹"（工具名+参数），若重复出现就提示模型"你已经做过这个了"。
- 把关键状态（已知信息、已尝试路径）显式维护在上下文里，减少模型"健忘"。

### 4.3 失败处理
- 工具抛错：**把错误信息当 Observation 喂回**（"工具调用失败：参数 X 无效"），让模型自我纠正，而不是直接崩。
- 设置重试上限，避免在一个失败工具上死磕。

### 4.4 超限后的兜底
- 到达步数/预算上限时，不要静默失败：返回"已尽力收集的中间结果 + 说明未完成的原因"，或降级到人工。

> 口诀：**没有步数上限的 Agent 不能上线。** 这是新手最常忘、后果最严重的一点。

---

## 5. ReAct 的几个变体（了解即可，详见后续）

- **ReWOO（Reasoning WithOut Observation）**：先一次性把所有推理和工具调用计划好，再批量执行，减少 LLM 往返 → **省成本**。代价是不能根据中间结果调整。详见 [文档 04](04-规划模式Planning.md)。
- **Plan-and-Execute**：先规划完整步骤，再逐步执行（带 re-plan）。适合复杂多步任务。[文档 04](04-规划模式Planning.md)。
- **Reflexion**：在 ReAct 上加"失败后反思并记住教训"，提升正确性。[文档 03](03-反思模式Reflection.md)。

它们都是为 ReAct 的某个失败模式打的补丁。**默认仍从 ReAct 起步。**

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
- **不写 Thought / 不让模型先推理** → 决策质量下降、无法调试。
- **靠正则解析文本动作** → 脆弱，改用原生 function calling。
- **工具失败直接抛异常终止** → 应把错误喂回让模型自愈。
- **observation 原样塞回、不加处理** → 上下文爆炸。长结果要截断/摘要。
- **不维护"已做过什么"** → 模型健忘、重复劳动、跑偏。
- **指望 ReAct 处理超复杂规划** → 它会中途放弃计划；这时该上 Planning。

---

## 8. 本章小结

- Agent 的本质 = **把 LLM 放进"思考→行动→观察"的循环**，由它自主决策何时停止；状态在上下文里累积。
- **ReAct（推理+行动交替）是默认起点**：先想再做，行动拉回真实世界事实、纠正臆想，能解决大多数任务。
- 现代实现用 **function calling 承载 Action**，比解析文本稳。
- ReAct 有明确失败模式（无限循环、计划放弃、过早停止、工具失败崩溃、上下文爆炸），**后续模式都是针对这些失败的补丁**。
- **循环控制是工程重点**：停止条件、步数上限（必备）、防重复、失败喂回、超限兜底。
- 变体（ReWOO/Plan-and-Execute/Reflexion）按失败模式按需选用，默认仍从 ReAct 起。

## 9. 检验清单

- [ ] 能默画 Agent 循环，并说清状态如何在上下文累积。
- [ ] 能解释 ReAct 里 Thought / Action / Observation 各自的作用，以及"先想再做"为何重要。
- [ ] 能列出至少 4 种 ReAct 失败模式及缓解手段。
- [ ] 能说出一个生产级循环必须有的停止条件，并解释"为什么没有步数上限的 Agent 不能上线"。
- [ ] 知道工具失败时正确的处理方式（喂回错误而非崩溃）。

---

> 下一步：[02-工具使用ToolUse](02-工具使用ToolUse.md) —— 给 Agent 装上手脚。
>
> 参考：[ReAct, Plan-and-Execute, or Reflection (DEV)](https://dev.to/gabrielanhaia/react-plan-and-execute-or-reflection-the-three-agent-patterns-every-engineer-needs-in-2026-355p) · [The Agent Loop: ReAct and Its Descendants](https://jatinbansal.com/ai-engineering/agent-loop/) · [Anthropic — Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
