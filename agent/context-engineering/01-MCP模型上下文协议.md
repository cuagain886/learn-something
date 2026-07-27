# 01 · MCP（Model Context Protocol，模型上下文协议）

> 目标：搞懂已被多种 Agent 宿主和工具生态采用的开放协议 MCP——它是什么、架构（host/client/server）、三大原语、和 function calling/框架的关系、以及安全。读完能讲清“为什么需要 MCP”并能跑通一个 server+client。生产接入还应锁定协议版本并做能力协商；2025-11-25 规范中的 Tasks 仍为 experimental。

---

## 1. MCP 解决什么问题

[agent-core/02](../agent-core/02-工具使用ToolUse.md) 讲了 function calling：你把工具定义喂给模型，模型请求调用，你执行后回填。问题在于——**每接一个新工具（数据库、Slack、GitHub、内部 API）都要写一套定制的对接代码**，换个 Agent 框架又要重写。工具方和 Agent 方是 N×M 的胶水地狱。

> **MCP（Model Context Protocol）是连接模型应用与外部能力的开放协议。** “N×M 变 N+M”是目标，不是兼容性保证：真实互操作仍取决于协议版本、协商出的 capability、传输、认证、schema 子集、扩展和宿主策略。

截至 2026-07-19，规范页面标记的最新版本为 **2025-11-25**。生产系统应固定并记录协议版本，不能把“支持 MCP”当作一个无版本布尔值。

---

## 2. 架构：host / client / server 三个角色 ⭐

MCP 区分三个角色，务必分清：

```
┌──────────────────── Host（宿主：你的 AI 应用）─────────────────────┐
│   协调者：管理多个 client、控制连接权限、执行安全策略、              │
│           处理用户授权、对接 LLM —— 安全主要在这里强制执行            │
│                                                                     │
│   ┌── Client 1 ──┐   ┌── Client 2 ──┐   ┌── Client 3 ──┐           │
│   │ 维持一条连接  │   │ 维持一条连接  │   │ 维持一条连接  │           │
│   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘           │
└──────────┼──────────────────┼──────────────────┼───────────────────┘
           │                  │                  │
      ┌────▼─────┐      ┌─────▼────┐      ┌──────▼─────┐
      │ Server A │      │ Server B │      │  Server C  │
      │ (GitHub) │      │  (DB)    │      │ (文件系统)  │
      │暴露工具/  │      │暴露工具/  │      │暴露工具/    │
      │资源/提示  │      │资源/提示  │      │资源/提示    │
      └──────────┘      └──────────┘      └────────────┘
```

- **Host（宿主）**：你的 AI 应用（如 Claude 桌面端、你的 Agent 程序）。它是**协调者和安全边界**——创建/管理多个 client、控制连接权限、执行安全策略、处理用户授权、对接 LLM。**安全主要在 host 侧强制执行。**
- **Client（客户端）**：host 内部的协议组件，通常与一个 server 维持一条逻辑连接，但不必是独立操作系统进程。
- **Server（服务器）**：**暴露能力的一方**——把工具、资源、提示按 MCP 标准暴露出来。可以是本地进程，也可以是远程服务。

> 一句话：**Host 用多个 Client 连接多个 Server，Server 提供能力，Host 负责协调和安全。**

---

## 3. 两个协议层

MCP 分两层：

- **数据层（Data Layer）**：定义消息类型和**原语**（primitives，见第 4 节）。基于 JSON-RPC。这是"说什么"。
- **传输层（Transport Layer）**：定义"怎么传"，有两种：
  - **STDIO（标准输入输出）**：本地进程间通信。Server 作为本地子进程运行，最简单、最常用于本地工具。
  - **Streamable HTTP**：当前规范的远程传输；支持请求/响应以及可选 SSE 流。旧版独立 HTTP+SSE 传输属于历史兼容路径，不能和当前 Streamable HTTP 混写。

> 学习时从 **STDIO 本地 server** 起步最简单；生产对接远程服务使用当前规范的 **Streamable HTTP**。只有维护旧客户端时，才需要把历史 HTTP+SSE 当成兼容路径单独处理。

---

## 4. 三大原语（Primitives）⭐ MCP 的核心

MCP server 能暴露三类东西，理解它们的区别很关键：

| 原语 | 控制方式 | 是什么 | 例子 |
|------|----------|--------|------|
| **Tools** | 常由模型选择，host 最终批准/执行 | 有输入 schema 的可调用操作；既可以只读，也可以有副作用 | 查询数据库、提交表单、发消息 |
| **Resources** | 常由应用选择如何装入上下文 | 以 URI 标识的上下文数据，可列出、读取，部分实现支持订阅变化 | 文件、schema、数据库记录 |
| **Prompts** | 常由用户显式选择 | server 提供的可复用消息/工作流模板，可带参数 | 代码审查、生成摘要模板 |

- **Tools** 就是 [agent-core/02](../agent-core/02-工具使用ToolUse.md) 讲的可执行工具；可由模型建议调用，也可由应用工作流或用户触发，host 仍负责策略校验和执行。
- **Resources** 的协议操作用于读取上下文，但内容仍可能敏感、陈旧或带恶意指令；“读操作”不等于“可无条件安全进入模型”。
- **Prompts** 是 server 提供的现成指令模板，让 Agent 用统一方式处理某类任务。

> 关键澄清：**MCP 提供了连接和能力供给，但不规定决策者。** 工具/资源可以由模型、应用工作流或用户选择；MCP 不替应用完成规划、授权和风险决策。

更准确地说，决策权可以由用户、应用或模型承担，取决于原语和 host UX；最终授权与执行必须在 host/server 的确定性控制面完成。

### 4.1 不止三大 server primitives

2025-11-25 规范还定义了重要的 client features：

- **Roots**：client 向 server 声明可操作的文件系统边界。
- **Sampling**：server 请求 client 代表它调用模型；模型选择和凭据仍由 client/host 控制。
- **Elicitation**：server 请求 host 向用户收集结构化信息或通过 URL 完成交互。

此外还有 logging、progress、completion、ping、cancellation 等 utilities。只会背 Tools/Resources/Prompts，无法解释双向协议能力。

---

## 5. MCP vs Function Calling vs 框架（别混淆）⭐

这三个概念新手极易搞混，讲清楚：

| | 是什么 | 关系 |
|---|--------|------|
| **Function Calling** | 模型"输出结构化工具调用请求"的**能力**（模型层面） | 底层机制。MCP 工具最终也是通过模型的 function calling 能力被调用 |
| **MCP** | 工具/数据**怎么标准化地连接**给 Agent 的**协议**（集成层面） | 把工具"供给"标准化。不是框架，不替你做编排 |
| **编排框架**（LangGraph 等） | 怎么组织 Agent 的循环、状态、多步流程（编排层面） | 用 MCP 接工具，框架负责"什么时候用、怎么串" |

> 一句话理顺：**框架负责"编排流程"，MCP 负责"标准化接入工具/数据"，function calling 是模型"发起调用"的底层能力。** 三者是不同层次，互补而非替代。

再补一层：MCP 是 client-server 能力协议，不是完整 Agent-to-Agent 任务协议。独立 Agent 间的 task/message/artifact/status 互操作更接近 A2A；进程内 handoff/agent-as-tool 则可能完全不需要网络协议。

---

## 5.1 生命周期与能力协商：真正的首个面试深挖点

连接不能一上来就 `tools/list`。规范要求：

```text
Client ─ initialize(protocolVersion, capabilities, clientInfo) ─→ Server
Client ← result(protocolVersion, capabilities, serverInfo) ───── Server
Client ─ notifications/initialized ─────────────────────────────→ Server
                之后才能使用协商成功的能力
```

关键不变量：

1. `initialize` 必须是首次正常交互。
2. server 返回它支持的版本；client 不支持时应断开，而不是“尽量猜”。
3. operation 阶段只能调用双方声明并协商成功的 capability。
4. Streamable HTTP 后续请求携带 `MCP-Protocol-Version`。
5. 每个请求要有 timeout；收到 progress 可延长软超时，但仍需最大硬超时。
6. capability/list 可能变化，`listChanged`/subscription 不能被当作静态启动配置。

生产连接表至少记录：`server_identity`、`protocol_version`、`negotiated_capabilities`、`auth_subject/audience/scopes`、`tool_catalog_hash`、`connected_at`。

### 5.1.1 Draft 方向预警（2026-07-26 快照；未发布，以正式版为准）

官方仓库的 draft changelog 显示，2025-11-25 之后的下一版正在做方向性重构。学习时以 2025-11-25 为准，但升级规划要知道这些信号：

- **拟改为无状态协议**：移除 `initialize`/`notifications/initialized` 握手与协议级 session（`Mcp-Session-Id`）；每个请求在 `_meta` 里携带协议版本与 client 能力，不匹配返回 `UnsupportedProtocolVersionError`；新增 `server/discover` 供 client 预先探测版本/能力/身份（SEP-2567、SEP-2575）。
- **Tasks 拟迁出核心为官方扩展** `io.modelcontextprotocol/tasks`，重设计为 `tasks/get` 轮询 + `tasks/update` 输入、取消 `tasks/list`（SEP-2663）——“Tasks 走向什么生命周期”的当前答案是**扩展化**而非核心化。
- **服务端发起的请求拟由 MRTR 取代**：`sampling/createMessage`、`elicitation/create`、`roots/list` 不再是 server 主动请求，而是 server 返回 `input_required` 结果、client 带补充输入重试原请求（SEP-2322）。
- **拟移除 SSE 断流重续**（`Last-Event-ID`）：断流的在途请求作废，client 必须以新 request ID 重发——对有副作用的工具，这让幂等键与“结果未知”对账变成协议层面的硬需求（SEP-2575）。

这些变化不推翻本章的工程结论，反而强化它们：锁定协议版本、为能力协商写显式失败路径、把断流当 `UNCERTAIN_OUTCOME` 处理。

---

## 6. 怎么用（学习路径）

1. **跑通一个本地 MCP server**：用官方 SDK（Python/TypeScript）写一个暴露 1~2 个工具的 STDIO server（如"查天气""读文件"）。
2. **用一个 MCP client 连它**：可以用 Claude 桌面端配置连接，或写一个简单 host 程序。
3. **观察完整链路**：Agent 列出 server 暴露的 tools → LLM 决定调用 → client 转发给 server → server 执行 → 结果回到 LLM。
4. **加一个 Resource 和 Prompt**：体会三种原语的区别。
5. **接现成 server**：社区有大量现成 MCP server（GitHub、文件系统、数据库、搜索等），直接接入感受"即插即用"。

6. **做兼容性失败实验**：版本不匹配、缺 capability、tool list 变化、请求超时/取消、断线重连、OAuth token audience 错误。
7. **实现 sampling/elicitation 的拒绝路径**：server 请求模型或用户输入时，host 必须能展示、编辑、拒绝并审计，而不是静默代答。
8. **若使用 Tasks**：明确标记 experimental，设计没有 Tasks 时的同步/应用级 durable workflow 降级路径。

> 💡 **本仓库环境本身就是活教材**：飞书系列 skill、computer-use、Chrome 等都是以 MCP 形式提供的工具——你日常用的就是 MCP 在工作。

---

## 7. 安全（MCP 的重点，也是 2026 热点）⚠️

MCP 让 Agent 能连接大量外部能力，安全面随之放大。核心原则：

- **最小权限（Least Privilege）**⭐：给每个 MCP server 配最小必要权限。如果 Agent 只需"总结 CRM 数据"，就把 server 配成**严格只读的方法过滤**，绝不给写权限。
- **不要靠 LLM 的系统提示来执行安全边界**⭐：系统提示能被 prompt 注入绕过。**安全必须在 host/server 侧用代码强制**（权限过滤、方法白名单），而不是"在 prompt 里叮嘱模型别乱来"。
- **Host 是安全主战场**：连接权限、用户授权、安全策略都在 host 侧强制执行。
- **审视 Resources 的内容**：从外部 server 读回的资源内容可能含恶意指令（间接 prompt 注入），进上下文前要警惕。
- **远程 server 的认证授权**：按规范使用 OAuth 资源服务器模型；server 必须验证 token audience，client 使用 Resource Indicators 请求面向目标 MCP server 的 token。
- **禁止 token passthrough**：MCP server 不能把收到的 token 原样转给下游 API。它应为下游资源获取专用 token，防止 confused deputy、审计绕过和权限扩散。
- **Sampling/Elicitation 要可见可拒绝**：server 能反向请求模型调用或用户输入，host 必须提供审核/拒绝能力，不能假设 server 的 prompt 可信。
- **审计**：记录 Agent 调用了哪些 server 的哪些工具/资源。

> 这与 [agent-core/02](../agent-core/02-工具使用ToolUse.md) 的工具安全一脉相承，并在 [INDEX 阶段 7](../INDEX.md) 系统展开：**自主性越高、连接的能力越多，安全越关键。**

---

## 8. 常见坑

- **混淆 MCP 和框架** → 以为 MCP 能替代 LangGraph 做编排。它只管"接入"。
- **按“读/写”机械区分原语** → Tool 也可以只读，Resource 的内容也不天然安全。应按“可调用操作 / 可寻址上下文 / 可复用模板”的协议语义建模，再独立标注副作用和权限。
- **靠系统提示做安全** → 被注入轻易绕过。安全要在 server/host 侧用代码强制。
- **给 server 过大权限** → 一旦被注入或出错，破坏面巨大。最小权限。
- **远程 server 不做鉴权** → 暴露内部能力。
- **不审视 resource 内容** → 间接 prompt 注入。
- **跳过 initialize/capability negotiation** → 在不支持的 server 上调用新功能，或把实验能力当稳定能力。
- **把 tools/list 当永久目录** → server 更新后仍按旧 schema 调用；要处理 `listChanged` 和版本/hash。
- **把 MCP Tasks 当业务真相源** → Tasks 仍 experimental；核心任务状态应由应用持久执行层掌握。
- **token passthrough** → audience/权限边界失效，违反规范安全要求。

---

## 9. 本章小结

- **MCP 是开放的 client-server 能力协议**；N+M 是理想化收益，真实互操作依赖版本、capability、认证和 host 策略。
- 架构三角：**Host（协调+安全）用多个 Client 连多个 Server（暴露能力）**。
- 两层：**数据层**（JSON-RPC 消息、primitives、utilities）+ **传输层**（STDIO / Streamable HTTP）。
- server primitives 是 Tools/Resources/Prompts；client features 还有 Roots/Sampling/Elicitation，控制权不总在 LLM。
- 生命周期必须先协商版本与 capability；Tasks 在 2025-11-25 仍为 experimental。
- **MCP ≠ 框架 ≠ function calling**：框架编排、MCP 接入、function calling 是模型发起调用的底层能力，三者互补。
- 安全靠 **host/server 侧的最小权限和代码强制**，绝不靠系统提示；自主性越高安全越关键。

## 10. 检验清单

- [ ] 能解释 MCP 解决的"N×M 胶水"问题，以及"USB-C"类比。
- [ ] 能画出 host/client/server 三角并说清各自职责（尤其 host 是安全边界）。
- [ ] 能区分 Tools / Resources / Prompts 三大原语，并说明副作用不是划分三者的唯一标准。
- [ ] 能讲清 MCP、function calling、编排框架三者的层次关系。
- [ ] 知道为什么"不能靠系统提示做安全"，安全该加在哪。
- [ ] 能画出 initialize → initialized → operation 的生命周期，并解释版本/capability 不匹配如何处理。
- [ ] 能解释 Sampling、Elicitation、Roots 为什么说明 MCP 是双向协议。
- [ ] 能区分 STDIO、Streamable HTTP 和历史 HTTP+SSE。
- [ ] 能解释 OAuth audience、Resource Indicators 和禁止 token passthrough。
- [ ] 能说明 MCP Tasks 的实验状态与应用级 durable workflow 的边界。

---

> 下一步：[02-上下文工程基础](02-上下文工程基础.md) —— 理解 Agent 可靠性的头号命门。
>
> 一手资料：[MCP 2025-11-25 Specification](https://modelcontextprotocol.io/specification/2025-11-25) · [Lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) · [Sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling) · [Elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation) · [Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) · [Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices) · [Draft Changelog（未发布方向）](https://modelcontextprotocol.io/specification/draft/changelog)
