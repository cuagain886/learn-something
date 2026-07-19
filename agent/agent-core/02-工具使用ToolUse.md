# 02 · 工具使用（Tool Use / Function Calling）

> 目标：把 Agent 的"手脚"装好。这是 Agent 的命根子——**工具设计的质量约等于 Agent 能力的上限**。读完能亲手实现一个完整的工具调用回合，并掌握工具设计、校验、并行、错误处理、安全。

---

## 1. 工具使用是什么

> **Function Calling / Tool Use**：你把一组"工具"（函数）连同它们的**描述和参数规范**告诉模型；模型在需要时输出"我要调用工具 X，参数是 {...}"；你的代码执行该工具，把**结果喂回**模型；模型据此继续。

这是 [文档 01](01-Agent循环与ReAct.md) 里 ReAct 的"Action（行动）"的具体实现。没有工具，LLM 只能"说"；有了工具，它能"做"——查数据、算数、调 API、读写文件、检索知识库、操作外部系统。

**关键认知**：模型本身**不执行**任何工具。它只是**输出一个"调用请求"**（结构化 JSON），真正的执行是你的代码做的。这一点决定了安全边界（见第 6 节）。

---

## 2. 一个完整的工具调用回合（必须亲手实现一遍）⭐

```
① 你 → 模型：  用户问题 + 工具定义列表（名字/描述/参数schema）
② 模型 → 你：  "请调用 get_weather，参数 {city:'北京'}"（tool_call，含一个 id）
③ 你执行：     真正调用 get_weather('北京') → 得到 {temp: 28, ...}
④ 你 → 模型：  把结果作为 tool_result 消息（带上对应的 tool_call id）回填
⑤ 模型 → 你：  基于结果生成自然语言回答，或继续请求下一个工具调用
```

```python
# 完整回合骨架（messages + tools 风格）
tools = [{
    "name": "get_weather",
    "description": "查询指定城市的当前天气。当用户询问天气、气温、是否下雨时使用。",
    "input_schema": {
        "type": "object",
        "properties": {
            "city": {"type": "string", "description": "城市名，如 '北京'"},
            "unit": {"type": "string", "enum": ["celsius", "fahrenheit"], "default": "celsius"}
        },
        "required": ["city"]
    }
}]

messages = [{"role": "user", "content": "北京今天热吗？"}]
resp = llm(messages, tools=tools)

if resp.stop_reason == "tool_use":          # ② 模型请求调工具
    messages.append(resp)                    # 先记录调用请求，再关联结果
    for call in resp.tool_calls:
        args = validate_schema_and_semantics(call.input, schema)
        authorize(call.name, args, user, task)  # schema 合法不代表有权限
        try:
            result = TOOL_BROKER.execute(call.name, args, idempotency_key=call.id)
        except OutcomeUnknown as e:
            result = reconcile(e.operation_id)       # 写超时先对账，不能盲重试
        except ToolError as e:
            result = e.to_model_safe_error()         # 不泄漏堆栈/密钥
        messages.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": call.id, "content": str(result)}  # ④ 回填
        ]})
    resp = llm(messages, tools=tools)   # ⑤ 模型基于结果继续
```

> 把这个回合在循环里跑（[文档 01](01-Agent循环与ReAct.md) 的 ReAct 骨架），就是一个能多步使用工具的 Agent。**强烈建议亲手敲一遍**，比看十篇文章都管用。

---

## 3. 工具设计：决定 Agent 能力上限的地方 ⭐⭐

工具定义是工具调用质量最重要、也最可控的变量之一。把它当成“模型可读的 API 契约”，不仅要写清名称和参数，还要声明副作用、权限、失败语义、幂等性与成功后的验证方式。生产级设计详见 [工具契约与大规模工具发现](../systems-engineering/02-工具契约与大规模工具发现.md)。

### 3.1 描述（description）要清晰
- 说清**这个工具做什么、什么时候该用、什么时候不该用**。模型靠它决定选哪个工具。
- 举例触发场景比抽象描述更有效（"当用户询问天气、气温、是否下雨时使用"）。
- 工具多了容易混淆，描述要让相近工具**边界清晰**（如 `search_web` vs `search_internal_docs` 要写明各自适用范围）。

### 3.2 Schema 要严格
- 每个参数都写 `type`、`description`、必要时 `enum`（枚举可选值）、`required`。
- 一些 API 在启用 strict/schema 约束时能保证输出满足其支持的 JSON Schema 子集；未启用严格模式、流式中间片段或不同供应商的行为可能不同。即使结构合法，`amount=1000000`、错误账户 ID 或越权资源仍可能在语义上危险。
- 参数语义要明确（`date` 要说清格式："YYYY-MM-DD"），否则模型乱传。

### 3.3 工具粒度与数量
- **粒度适中**：太粗（一个工具干十件事，参数爆炸）和太细（几十个微工具，模型选择困难）都不好。
- **数量控制**：工具太多会降低选择准确率。**按业务把工具分组、按需只给当前任务相关的工具**（动态工具集），是 2026 管理大量工具的常用手法。
- 工具命名要见名知意（`get_order_status` 而非 `func3`）。

### 3.4 返回值要"对模型友好"
- 返回模型**能直接理解和使用**的内容，去掉无关字段、冗长 ID、内部噪声。
- 太长的返回要**截断或摘要**，否则撑爆上下文（[文档 01](01-Agent循环与ReAct.md) 的"上下文爆炸"）。
- 出错时返回**模型能据此自我纠正的错误信息**（见第 5 节）。

> Anthropic 的经验：花在"打磨工具定义和返回格式"上的时间，回报极高——这是 prompt 工程在 Agent 时代的延伸（有时叫 "agent-computer interface" 设计）。

---

## 4. 并行 vs 串行工具调用

- **并行（Parallel）**⭐：一次返回里请求多个工具调用；只有它们互不依赖、资源不冲突且执行器声明并发安全时才能同时执行。例：同时查询三个城市的天气。
- **串行（Sequential）**：后一个工具依赖前一个的结果，必须排队。例：先 `search` 拿到 URL，再 `fetch` 那个 URL。

工程上不能仅因为模型一次给出多个 call 就自动并发。执行器要检查 read/write effect、资源 key、依赖和事务边界；同一订单上的两个写操作即使语法独立也可能发生 lost update。

---

## 5. 错误处理（Agent 健壮性的关键）⭐

工具一定会失败（网络超时、参数非法、外部 API 报错）。处理得好不好，直接决定 Agent 能不能在真实环境活下来。

原则：错误要进入**结构化错误代数**，由运行时决定重试、对账、换路、终止还是请求人工；模型可以参与选择替代方案，但不能决定一个有副作用的请求是否安全重放。

```python
try:
    result = broker.execute(operation)
except InvalidArgument as e:
    result = {"code": "INVALID_ARGUMENT", "field": e.field, "retryable": False}
except TransientFailure as e:
    result = retry_if_idempotent(operation, e.retry_after)
except OutcomeUnknown as e:
    result = reconcile_before_any_retry(e.operation_id)
```

要点：
- **错误信息要可操作**："city 参数必须是中文城市名，你传的 'Beijng' 拼写有误" 比 "Error 400" 有用得多。
- **设重试上限**：别让模型在同一个失败工具上死磕，N 次失败后中止或换路。
- **错误至少分五类**：`INVALID_ARGUMENT`、`TRANSIENT`、`PERMISSION_DENIED`、`CONFLICT`、`OUTCOME_UNKNOWN`。其中最后一类不是失败，而是本地不知道远端是否已提交。
- **校验先行**：执行前用 schema 校验参数（第 3.2），把一部分错误挡在执行之前。

### 5.1 三层校验不能互相替代

| 层 | 回答的问题 | 例子 |
|----|------------|------|
| 结构校验 | 字段/类型/枚举合法吗 | `currency` 是否是 enum |
| 语义校验 | 参数组合在业务上成立吗 | 退款金额不超过可退余额 |
| 策略/授权 | 当前主体能对这个资源做吗 | 用户、Agent、服务身份是否有订单权限 |

JSON Schema 只能覆盖第一层的一部分。把另外两层写进 prompt，不能形成安全边界。

### 5.2 工具 effect 决定重试语义

| effect | 例子 | 默认处理 |
|--------|------|----------|
| PURE | 计算、格式转换 | 可安全重试/并行 |
| READ | 查询订单 | 通常可重试，但要处理新鲜度/一致性 |
| IDEMPOTENT_WRITE | 带幂等键更新工单 | 可按 operation ID 重放 |
| NON_IDEMPOTENT_WRITE | 发邮件、转账 | 超时后先对账，审批后提交 |

完整工具 contract、operation state machine 与 `OUTCOME_UNKNOWN` 见 [工具契约](../systems-engineering/02-工具契约与大规模工具发现.md) 和 [持久化执行](../systems-engineering/03-持久化执行与故障恢复.md)。

---

## 6. 安全：工具是 Agent 最大的攻击面 ⚠️

工具能"采取真实世界行动"，所以是安全重灾区。这部分在 [INDEX 阶段 7](../INDEX.md) 会系统讲，这里先建立意识：

- **永远独立校验和清洗输入**：不要信任模型给的参数，**在执行前再校验一遍**（模型可能被 prompt 注入诱导传入恶意参数）。
- **最小权限**：每个工具只给完成其职责所需的最小权限。报销 Agent 的工具就不该能删库、不该能往外发数据——**即使被注入指令也做不到**。
- **校验工具返回再回填**：工具返回的内容（尤其来自外部/检索的）可能含恶意指令（间接 prompt 注入），回填进上下文前要审视。
- **高风险动作加人类确认（Human-in-the-Loop）**：转账、删数据、对外发送等不可逆/高影响操作，必须人工确认后才真正执行。
- **沙箱化**：执行代码、读写文件、访问网络的工具应在受限环境运行。

> 记住第 1 节那句：**模型只发出调用请求，执行的是你的代码。** 所有安全控制都加在"执行"这一侧——这是你能完全掌控的地方。

---

## 7. 常见工具类型（设计灵感）

| 类型 | 例子 |
|------|------|
| 信息检索 | 网络搜索、RAG 检索（[rag/](../rag/00-RAG学习计划总览.md)）、数据库查询、API 查询 |
| 计算/处理 | 计算器、代码执行（沙箱）、数据分析 |
| 读写/操作 | 文件读写、发邮件、创建工单、更新数据库 |
| 与人交互 | 向用户提问澄清（把"问人"也做成一个工具） |
| 调用其他 Agent | 把子 Agent 暴露成工具（多智能体，[文档 05](05-多智能体协作模式.md)） |

> **MCP（Model Context Protocol）** 是连接模型应用与工具/资源的开放协议之一；它不替代本地 function calling 的动作表达，也不自动解决工具授权、幂等和 Agent 间任务协作。协议分层见 [Agent 协议与互操作边界](../systems-engineering/05-Agent协议与互操作边界.md)。

### 7.1 大工具面的三种前沿手段

当工具定义多到显著占用上下文或名称相互混淆时，不应全部平铺：

1. **Namespace**：按领域/所有者分组，避免相邻工具重名和语义重叠。
2. **Deferred loading / tool search**：先给工具目录或延迟定义，模型需要时再加载完整 schema。
3. **Programmatic Tool Calling**：让模型在受控运行时写一段程序组合多个合格工具，适合中间数据量大、每一步不需要重新进行模型判断的有界流程。

第三种不是“让模型随便执行代码”。可调用工具、网络、secret、CPU/时间和输出仍要由沙箱/allowlist 控制。当前 OpenAI 工具文档已把 function calling、tool search、Programmatic Tool Calling、内置工具和远程 MCP 明确区分。

---

## 8. 常见坑

- **工具描述含糊** → 模型可能选错工具；用含混工具对、hard negative 和工具选择混淆矩阵验证，而不是凭印象归因。
- **Schema 不严格**（缺 type/required/enum）→ 参数乱传、格式错。
- **工具太多、不分组** → schema token、名称碰撞与选择歧义可能增加；用 namespace、授权过滤和按需发现控制候选面，并实测 discovery recall/precision。
- **返回值原样塞回**（含大量噪声/超长）→ 上下文爆炸、干扰决策。
- **把所有错误都交给模型重试** → 非幂等写可能重复；运行时应按错误码与 effect 决策。
- **信任模型给的参数直接执行** → 安全漏洞（注入、越权）。务必独立校验。
- **高风险动作没有匹配风险的控制** → 对不可逆/高影响动作使用参数绑定 HITL、双人审批或直接禁止；低风险动作不应一律弹窗导致疲劳。
- **靠自由文本解析工具调用** → 结构脆弱；优先用受 schema 约束的 function calling，仍需语义与授权校验。

---

## 9. 本章小结

- 工具使用 = 模型**发出**结构化调用请求、你的代码**执行**并把结果**回填**；模型从不自己执行。
- **亲手实现一遍完整回合**（请求→执行→回填→继续）是必经之路。
- 工具契约定义 Agent 的可达动作和故障面：除描述/schema 外，还要声明 effect、错误、权限、幂等、验证、取消和结果未知语义；不能把系统上限归因于单一层。
- 只有独立 work item 才适合并行；收益受 critical path、限流、join、取消与错误相关性约束。并行通常降 wall-clock，不保证降低 token、费用或尾延迟。
- **错误进入结构化错误代数**：确定错误可供模型修正，瞬时错误按幂等策略重试，结果未知先对账。
- **安全加在"执行"侧**：独立校验输入、最小权限、校验返回、高风险动作人工确认、沙箱。

## 10. 检验清单

- [ ] 能完整描述工具调用的五步回合，并说清"模型不执行工具"的含义。
- [ ] 能写出一个带 description/schema/required/enum 的合格工具定义。
- [ ] 知道为什么工具描述和返回格式如此影响 Agent 表现。
- [ ] 能说清“模型一次发出多个调用”和“执行器可以安全并发”的区别。
- [ ] 能区分结构、语义、授权三层校验。
- [ ] 能按 PURE/READ/IDEMPOTENT_WRITE/NON_IDEMPOTENT_WRITE 说明重试策略。
- [ ] 能解释 `OUTCOME_UNKNOWN` 为什么不能直接当失败重试。
- [ ] 能比较 namespace、tool search/deferred loading 与 Programmatic Tool Calling。

---

> 下一步：[03-反思模式Reflection](03-反思模式Reflection.md) —— 让 Agent 学会自我评估与纠错。
>
> 一手资料：[OpenAI — Using tools](https://developers.openai.com/api/docs/guides/tools) · [Anthropic — Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) · [MCP 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
