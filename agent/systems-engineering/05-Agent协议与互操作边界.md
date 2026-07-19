# 05 · Agent 协议与互操作边界

> 目标：准确区分 MCP、A2A、Agent Skills、AGENTS.md、OpenTelemetry 与 durable workflow。它们不是相互替代的“Agent 协议”，而是覆盖不同层次的互操作拼图。

---

## 1. 一张分层图先定位

~~~text
┌──────────────── 任务/组织层 ────────────────┐
│ A2A：跨系统发现 Agent、发送任务、交换产物     │
├──────────────── 能力/过程知识层 ─────────────┤
│ Agent Skills：按需加载可复用过程知识          │
│ AGENTS.md：仓库范围的持久项目指令              │
├──────────────── 工具/数据连接层 ─────────────┤
│ MCP：发现并调用 tools/resources/prompts       │
│ Function calling：一次模型调用中的动作编码     │
├──────────────── 执行可靠性层 ────────────────┤
│ Workflow engine：重试、持久化、等待、补偿      │
├──────────────── 观测层 ─────────────────────┤
│ OpenTelemetry GenAI：trace/span/metrics 语义  │
└─────────────────────────────────────────────┘
~~~

一条典型链路可以同时使用全部层：

> A2A 接收采购任务 → Agent 激活采购 Skill → 通过 MCP 发现报价工具 → function calling 产生调用参数 → durable workflow 执行并等待审批 → OpenTelemetry 记录全链路。

---

## 2. Function calling：模型输出编码，不是网络协议

Function calling 解决：

> 模型如何用结构化形式表达“我想调用工具 X，参数是 Y”。

它通常只存在于模型 API 与应用 runtime 之间。它不规定：

- 工具从哪里发现。
- 工具服务的网络传输。
- OAuth 或跨组织身份。
- 长任务状态。
- 工具的业务幂等。
- Agent 间委托。

因此 MCP server 最终列出的工具，仍可能被 runtime 转成供应商特定的 function/tool schema 交给模型。

---

## 3. MCP：Agent 与上下文/工具的标准连接层

### 3.1 核心角色

- **Host**：面向用户的 Agent 应用，掌握安全边界和多个 client。
- **Client**：host 内与一个 server 建立会话的协议组件。
- **Server**：暴露能力。

核心 server primitives：

| Primitive | 控制者 | 用途 |
|-----------|--------|------|
| **Tools** | 模型通常可选择调用 | 可执行动作 |
| **Resources** | 应用选择如何纳入上下文 | 文件、记录、数据视图 |
| **Prompts** | 用户/应用显式选择 | 可复用提示模板 |

MCP 还定义 capability negotiation 和一组 client/server utilities，如 sampling、elicitation、logging、progress、cancellation 等。实现必须按协商能力使用，不能假设对端全部支持。

### 3.2 2025-11-25 的重要变化

当前正式版本目录为 2025-11-25。需要特别区分：

- 基础协议和既有 primitives 属于版本化规范。
- **Tasks 在该版本首次引入，规范明确标记 experimental。**
- Task 是包裹请求的 durable state machine，支持 working、input_required、completed、failed、cancelled，以及 get/result/list/cancel。
- 工具通过 execution.taskSupport 声明 required、optional 或 forbidden。

所以可以研究和试用 MCP Tasks，但生产业务状态仍应由自己的 durable runtime 掌握，并设计兼容降级。

### 3.3 Authorization 不是“把用户 token 往下传”

HTTP transport 的 MCP Authorization 基于 OAuth 体系，并要求 Resource Indicators。关键安全不变量：

- MCP server 只接受为自己签发的 token，验证 audience。
- MCP server 调下游 API 时使用独立下游 token。
- **Token passthrough 被规范明确禁止。**
- MCP proxy 要防 confused deputy。
- session ID 不能当身份凭据。
- 本地 server 继承 host 权限，要沙箱和最小化文件/网络访问。

MCP 标准化连接，不会自动使连接安全。工具效果、租户隔离、审批和审计仍是应用责任。

---

## 4. A2A 1.0：独立 Agent 系统之间的任务协议

截至 2026-07，A2A 最新发布版为 1.0.0，项目称其为首个稳定、生产就绪版本。

### 4.1 主要对象

- **Agent Card**：能力、技能、endpoint、输入输出模式、认证要求。
- **Message**：用户或 Agent 之间的内容交换。
- **Task**：有生命周期的协作任务。
- **Artifact**：Agent 产生的报告、文件、结构化结果。
- **Part**：文本、文件、结构化数据等内容组成。

核心价值是让彼此内部实现不透明的 Agent：

- 发现能力。
- 协商模态。
- 发任务并查询/订阅状态。
- 交换 artifact。
- 不暴露内部 memory、tools 和推理。

### 4.2 1.0 的工程关注点

- 请求携带 A2A-Version，以 Major.Minor 做兼容协商。
- 规范支持多个 protocol binding；语义模型与传输绑定分开。
- Agent Card 位于标准 well-known URI，可带 JWS 签名。
- SecurityScheme 可描述 API key、HTTP auth、OAuth2、OIDC、mTLS。
- 扩展用 URI 标识，并由双方协商。

协议定义“怎样通信”，不替你回答：

- 是否信任对方 Agent。
- 谁承担费用和责任。
- 子任务能访问哪些用户数据。
- 返回 artifact 是否真实、是否含恶意内容。
- 跨组织任务如何补偿。

### 4.3 MCP 与 A2A 的精确差异

| 维度 | MCP | A2A |
|------|-----|-----|
| 对端 | 工具/数据/提示服务 | 独立 Agent 系统 |
| 委托内容 | 一次能力调用或上下文读取 | 可持续任务与协作 |
| 对端自主性 | 通常较低 | 对端自行规划和用工具 |
| 结果 | tool result / resource | message / task status / artifact |
| 内部透明度 | 暴露具体工具 schema | 通常保持内部不透明 |

“A2A 连 Agent、MCP 连工具”是有用口诀，但边界并非由进程数决定，而是由 **是否委托一个自主任务** 决定。一个远程服务若只提供确定性查询，它仍更像 MCP tool；一个同进程子 Agent 若自行规划，也属于 Agent-as-Tool 语义。

---

## 5. Agent Skills：过程知识的按需打包

Agent Skills 是开放目录格式，最小包含带 YAML frontmatter 的 SKILL.md，可附带：

~~~text
skill-name/
├── SKILL.md
├── scripts/
├── references/
└── assets/
~~~

核心机制是 progressive disclosure：

1. 启动时只加载 name + description。
2. 任务匹配后加载完整 SKILL.md。
3. 执行时按需读取 reference、script、asset。

它解决“Agent 怎样获取可复用的专业流程与材料”，不解决远程调用、身份、持久化或任务协议。

安全注意：

- Skill 是代码和指令供应链的一部分。
- 从仓库加载的 Skill 可能不可信。
- allowed-tools 截至当前规范为实验字段，客户端支持不一致。
- 脚本应在最小权限沙箱执行；安装和更新要 pin 来源、版本与 hash。
- 激活 Skill 不能扩大调用者原有权限。

---

## 6. AGENTS.md：仓库局部的持久指令

AGENTS.md 是面向编码 Agent 的轻量约定，给仓库写入：

- 构建/测试命令。
- 代码风格。
- 目录边界。
- 验证与交付要求。
- 安全和禁止事项。

它与 Skill 的区别：

| | AGENTS.md | Agent Skill |
|---|---|---|
| 作用域 | 仓库/目录层级 | 跨项目复用的任务能力 |
| 触发 | Agent 进入作用域时读取 | 任务匹配后激活 |
| 内容 | 项目约束和本地事实 | 流程、脚本、参考、资产 |
| 典型版本 | 随仓库代码 | 独立包/目录版本 |

Linux Foundation 在 2025-12 成立 Agentic AI Foundation，首批项目包括 MCP、goose 和 OpenAI 的 AGENTS.md。这说明开放生态开始从“单一框架竞争”走向连接协议、运行时和项目约定的分层治理。

---

## 7. OpenTelemetry GenAI：观测语义，不是执行协议

OpenTelemetry GenAI semantic conventions 定义/推进：

- invoke_agent、invoke_workflow、chat、execute_tool、retrieval 等 operation name。
- 模型、token、finish reason 等属性。
- 工具调用参数/结果的结构。
- Agent 与 workflow 的 trace 层级。

截至快照日，多项 GenAI operation 仍标为 Development，应：

- pin 语义约定版本。
- 在内部 telemetry schema 与 OTel exporter 之间加适配层。
- 避免把 dashboard 查询直接绑死实验字段。
- 默认不记录 prompt、工具参数和结果正文；这些字段可能包含敏感信息。

OTel 让不同 runtime 的 trace 可互通，但它不定义评测分数、业务完成或审计保留策略。

---

## 8. 协议选择决策

~~~text
只是让模型调用应用内函数？
  → Function calling

希望多个 Agent host 复用工具/数据连接？
  → MCP

要把一个有自主性的长任务委托给外部 Agent 系统？
  → A2A（或业务 API；先证明需要跨系统标准）

要把专业操作流程、脚本和模板按需交给 Agent？
  → Agent Skills

要告诉编码 Agent 本仓库怎样构建、测试和修改？
  → AGENTS.md

要跨框架统一 trace/metrics？
  → OpenTelemetry GenAI

要故障恢复、长等待、重试、补偿？
  → Durable workflow/runtime
~~~

协议能叠加，但每增加一层都增加版本、身份和观测边界。单体内部不要为了“标准化”过早引入 A2A；稳定的函数接口或 Agent-as-Tool 往往足够。

---

## 9. 跨协议关联字段

建议建立内部 envelope：

~~~json
{
  "tenant_id": "t_1",
  "principal_id": "u_7",
  "run_id": "run_9",
  "task_id": "task_3",
  "trace_id": "trace_...",
  "operation_id": "op_...",
  "protocol": {"name": "a2a", "version": "1.0"},
  "peer": {"id": "agent_supplier_review", "card_hash": "..."},
  "auth_context_ref": "authctx_...",
  "data_classification": "CONFIDENTIAL"
}
~~~

不要把 auth token 本身复制进任务、trace 或 Agent messages。跨协议传播的是最小关联 ID 和可验证身份上下文引用。

---

## 10. 互操作测试

- 版本协商失败是否返回明确错误？
- 对端未声明 capability 时是否安全降级？
- 重复 message/task/tool call 是否幂等？
- A2A Agent Card 更新后，旧任务 pin 哪个版本？
- MCP tool schema 变化后，等待中的 run 怎样恢复？
- OAuth token audience 是否绑定目标 server？
- artifact 是否校验媒体类型、大小、hash 和恶意内容？
- trace context 跨边界是否保留，同时不泄露 baggage？
- 对端超时后如何查询任务，而不是创建重复任务？
- 实验能力关闭时核心流程是否仍可工作？

---

## 11. 本章小结

- Function calling 是模型动作编码；MCP 是工具/上下文连接；A2A 是独立 Agent 任务协作。
- Skills 和 AGENTS.md 解决过程知识与仓库指令，不是远程调用协议。
- Durable workflow 负责恢复语义，OTel 负责观测语义；MCP/A2A 都不能替代它们。
- MCP 2025-11-25 的 Tasks **仍是 experimental**；A2A 1.0 已发布稳定版，但“协议稳定”不等于业务信任自动成立。
- 互操作的难点不是 JSON 能否互发，而是版本、身份、效果、重试、artifact 信任与责任边界。

---

## 12. 参考资料

- [MCP 2025-11-25 Specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP 2025-11-25：Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
- [MCP 2025-11-25：Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP：Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- [A2A Protocol 1.0 Specification](https://a2a-protocol.org/latest/specification/)
- [A2A：Announcing 1.0](https://a2a-protocol.org/latest/announcing-1.0/)
- [Agent Skills Specification](https://agentskills.io/specification)
- [Linux Foundation：Agentic AI Foundation 成立](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)
- [OpenTelemetry：GenAI Attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)

