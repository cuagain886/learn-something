# 01 · Agent 运行时与 Harness 工程

> 目标：把“模型能力”和“Agent 系统能力”分开。模型负责提出下一步，Harness 负责准备上下文、执行工具、保存状态、施加策略、恢复故障和生成证据。

---

## 1. Harness 到底是什么

同一个模型接到同一个任务，在不同 Agent 产品中的表现可能相差很大。差异经常不在模型权重，而在模型外部的 **Harness（运行时外骨骼）**：

~~~text
Harness =
  循环控制
  + 上下文组装
  + 工具目录与执行代理
  + 状态/产物持久化
  + 权限与审批
  + 预算/调度/取消
  + 观测与评测钩子
  + 故障恢复
~~~

“Agent = 模型 + 工具 + 循环”适合入门；进入生产后更准确的表达是：

> **Agent system = 不确定的策略模型 + 确定性的 Harness + 有副作用的环境。**

Anthropic 对长任务的实验表明，具备上下文压缩的强模型仍会尝试一次做太多、留下半成品，或在后续会话过早宣告完成。解决方法不是单纯增加上下文，而是让 Harness 规定初始化、增量推进、进度文件和验证方式。

---

## 2. 八个核心组件

### 2.1 Run API：任务入口

Run API 把一次请求转成持久化 run，而不是把 HTTP 连接本身当作任务生命周期。

建议的最小输入：

~~~json
{
  "run_id": "run_...",
  "tenant_id": "tenant_...",
  "principal": {"type": "user", "id": "u_123"},
  "goal": "采购 20 台开发机",
  "constraints": {
    "deadline": "2026-07-20T10:00:00Z",
    "max_cost_usd": 5.0,
    "max_steps": 40,
    "allowed_data_domains": ["procurement"]
  },
  "agent_version": "procurement-agent@17"
}
~~~

run_id 应贯穿任务状态、工具调用、审批、产物和 trace。不要用易变的 conversation_id 代替业务 run_id。

### 2.2 Context Assembler：上下文编译器

它不是简单拼接 messages，而是每个 turn 都重新编译：

~~~text
系统不变量
+ 当前目标/约束
+ 任务状态摘要
+ 本步可用工具
+ 按需检索的事实/记忆
+ 最近观察
+ 未解决错误
- 过期信息
- 与本步无关的大输出
- 不可信内容中的指令
~~~

输出应带来源和信任标签。例如来自用户、策略库、网页、工具结果的内容不能被视为同一权限等级。上下文组装器还要执行 token 预算、去重、截断、敏感字段过滤和缓存布局。

### 2.3 Policy Model：模型决策适配层

这一层负责把供应商模型输出统一成内部动作，而不是把供应商响应对象散落在业务代码里：

~~~text
Decision =
  FinalAnswer(text, citations)
  | ToolIntent(tool, arguments, rationale_ref)
  | DelegateIntent(agent, task_contract)
  | AskUser(question, required_fields)
  | Yield(reason, wake_condition)
  | Fail(class, message)
~~~

供应商 API、reasoning effort、并行 tool calls 都应被适配层封装。这样才能：

- 固定内部状态机，不被 API 版本牵着走。
- 在评测中替换模型而不改业务控制流。
- 统一记录模型输入输出的 hash、token 和延迟。
- 对非法输出做显式失败，而不是隐式容错后继续。

### 2.4 Tool Registry：工具目录

目录保存的不只是 name、description、JSON Schema，还应有：

- 工具版本与所有者。
- 读/写/不可逆效果分类。
- 所需权限与数据域。
- 超时、重试和并发限制。
- 是否支持 dry-run、幂等键、取消和补偿。
- 返回 schema 与最大 payload。
- 适用/不适用示例。

工具目录是“能力目录”；MCP 可以是目录的一个来源，但不会替你定义业务幂等和授权策略。

### 2.5 Tool Broker：执行代理

模型不能直接持有密钥或绕过控制面调用外部 API。所有动作先进入 Broker：

~~~text
ToolIntent
  → schema 校验
  → 解析调用者身份
  → 策略判定
  → 必要时 dry-run / 审批
  → 分配 operation_id
  → 执行 / 重试
  → 验证后置条件
  → 记录审计
  → 返回受限 observation
~~~

Broker 要区分“原始结果”和“给模型看的 observation”。原始结果可存加密对象存储；模型只得到必要字段、分页摘要和 artifact 引用，避免大输出污染上下文。

### 2.6 State Store 与 Artifact Store

两者不要混：

| 存储 | 保存什么 | 访问模式 |
|------|----------|----------|
| **State Store** | 小而结构化的当前状态、checkpoint、版本、锁 | 高频读写、条件更新 |
| **Artifact Store** | 报告、代码、网页快照、日志、大型工具结果 | 不可变对象、按 hash/URI 引用 |

状态中只保存 artifact_id、hash、媒体类型、来源和摘要。把大文件直接塞进状态会让 checkpoint、复制、查询和加密都变重。

### 2.7 Scheduler：调度、等待与取消

Scheduler 负责：

- ready run 的队列和优先级。
- worker lease 与 heartbeat。
- 并发上限和租户公平性。
- 定时唤醒、外部事件唤醒。
- deadline、取消传播和僵尸任务回收。

“等待人工”不应占用线程或模型调用。run 进入 WAITING 状态，保存 wake_condition；收到审批事件后再排队。

### 2.8 Verifier 与 Telemetry

Verifier 是独立于生成策略的完成判定器：

- 确定性断言：目标数据库状态、测试、schema、hash、引用。
- 规则判定：预算、权限、不变量。
- LLM judge：仅处理无法客观判断的部分，并记录 rubric 和 judge 版本。

Telemetry 同时服务三件事：在线排障、离线评测、合规审计。三者保留期和敏感级别不同，不应共用“把所有 prompt 全记下来”的粗放策略。

---

## 3. 控制平面与数据平面

借鉴分布式系统，把 Agent 拆成：

| 平面 | 职责 | 典型数据 |
|------|------|----------|
| **控制平面** | 策略、身份、工具目录、版本、预算、调度、审批、配置 | 小、强一致、可审计 |
| **数据平面** | 模型推理、检索、工具 I/O、文件处理、代码执行 | 大、弹性、可并行 |

好处：

1. 控制规则不依赖模型是否“记得”。
2. 工具 worker 可独立扩容，调度器仍掌握全局预算。
3. 更换模型不会绕过已有审批和审计。
4. 多 Agent 可以共享能力目录，但使用不同权限视图。

反例是把所有规则写进 system prompt：模型可能遵守，但这不是安全边界，也无法阻止一个被攻陷的工具客户端。

---

## 4. 一次 turn 的精确生命周期

~~~text
1. acquire(run_id, expected_version)
2. load task state + pending events
3. assemble bounded context
4. call model
5. normalize output into Decision
6. validate decision against run state
7. if tool intent:
     authorize → maybe approve → execute idempotently → verify
     append event + observation
8. if final:
     run completion verifier
9. checkpoint(new_state, compare_and_swap version)
10. release lease / schedule next wake-up
~~~

这里有两个关键顺序：

- **先持久化动作意图，再执行副作用**，或使用能把业务写入与 outbox 记账放进同一事务的实现。
- **先验证并持久化工具结果，再把 observation 交还模型**，否则进程可能在模型已看到结果、状态却没保存时崩溃。

具体原子性方案见 [03](03-持久化执行与故障恢复.md)。

---

## 5. 状态机必须显式

建议最少包含：

~~~text
CREATED
  → READY
  → RUNNING
  → WAITING_INPUT
  → WAITING_APPROVAL
  → RETRY_SCHEDULED
  → VERIFYING
  → SUCCEEDED | FAILED | CANCELLED | EXPIRED
~~~

每个转换都应定义：

- 允许的前置状态。
- 触发事件。
- 必须写入的字段。
- 是否消耗预算。
- 是否允许重放。
- 谁能执行该转换。

不要只用 status 字符串加大量 if/else；至少把转换集中在一个 reducer 或 transition table 中，并用属性测试验证非法转换不可达。

---

## 6. 框架与 Harness 的边界

截至 2026-07，常见框架已覆盖不少运行时能力：

- OpenAI Agents SDK：loop、tools、handoff、sessions、HITL、tracing，并提供 Temporal、Dapr、Restate、DBOS 等 durable execution 集成入口。
- LangGraph：图状态、checkpoint、interrupt、replay、fork 和 pending writes。
- 各类工作流引擎：durable timer、activity retry、signals/events、历史重放。

但“用了框架”仍不等于具备业务正确性。你仍要定义：

- 幂等键的业务作用域。
- 工具效果分类和补偿语义。
- 审批绑定的参数 hash。
- 任务/产物/身份数据模型。
- 版本升级与旧 run 迁移策略。
- 什么证据才算完成。

框架解决机制，应用定义语义。

---

## 7. 三种常见错误架构

### 7.1 HTTP 请求就是任务

长推理阻塞 HTTP；连接断开就不知道是否取消；重试 HTTP 又创建重复任务。

**改法**：创建 run 后立即返回 run_id；通过轮询、SSE 或 webhook 获取状态。取消是带身份的显式命令。

### 7.2 messages 就是全部状态

从自然语言历史推断“哪个工具已执行、哪个审批仍有效”，既贵又不可靠。

**改法**：事实进入结构化状态；messages 只是模型视图。工具执行记录、审批、预算、版本不能只存在文本里。

### 7.3 模型是策略执行点

Prompt 写“金额超过 1 万请审批”，然后直接把支付工具给模型。

**改法**：Broker 根据结构化金额和策略做强制判定；模型只决定是否提出支付意图。

---

## 8. 最小可生产 Harness

如果暂时不引入重型框架，最小实现也应有：

~~~text
PostgreSQL:
  runs / run_events / tool_operations / approvals / artifacts

Worker:
  lease run
  → assemble context
  → model decision
  → tool broker
  → compare-and-swap checkpoint

Policy:
  deterministic allow/deny/require_approval

Queue:
  only carries run_id; database remains source of truth

Object storage:
  immutable artifacts keyed by content hash

Observability:
  trace_id + run_id + operation_id，正文默认不入 trace
~~~

队列消息可以重复，worker 可以崩，模型可以超时；只要数据库中的状态转换和工具操作是幂等的，系统仍可恢复。

---

## 9. 设计评审问题

- [ ] run_id、conversation_id、trace_id、operation_id 是否分开？
- [ ] 对话状态、任务状态、世界状态、证据状态是否分开？
- [ ] 模型输出是否先归一成内部 Decision，再进入执行？
- [ ] 所有工具是否经过统一 Broker，模型是否永远拿不到长期密钥？
- [ ] 状态机和非法转换是否可测试？
- [ ] 等待人工时是否释放计算资源，并可跨进程恢复？
- [ ] 大型结果是否进入 Artifact Store，而不是 checkpoint/messages？
- [ ] 完成是否由 verifier 判定，而不是模型自报？
- [ ] prompt、工具、策略、工作流和模型版本是否随 run 固化？

---

## 10. 本章小结

- Harness 是模型之外的运行时外骨骼；同一模型的实际 Agent 能力高度依赖 Harness。
- **概率决策平面负责提出意图，确定性控制平面负责授权和执行。**
- 生产 runtime 至少包含入口、上下文组装、模型适配、工具目录、执行代理、状态/产物存储、调度、验证和观测。
- conversation、task、world、evidence 是四种不同状态；messages 不能替代结构化事实。
- 框架提供 checkpoint/HITL/tracing 等机制，业务仍必须定义幂等、补偿、审批绑定和完成证据。

---

## 11. 参考资料

- [Anthropic：Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Anthropic：Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [OpenAI Agents SDK：Overview](https://openai.github.io/openai-agents-python/)
- [OpenAI Agents SDK：Running Agents / Durable Integrations](https://openai.github.io/openai-agents-python/running_agents/)
- [LangGraph：Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [Dapr Workflow：Architecture](https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-architecture/)

