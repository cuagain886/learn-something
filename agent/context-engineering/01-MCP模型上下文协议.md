# 01 · MCP（Model Context Protocol，模型上下文协议）

> 目标：搞懂 2026 已成事实标准的 MCP——它是什么、架构（host/client/server）、三大原语、和 function calling/框架的关系、以及安全。读完能讲清"为什么需要 MCP"并能跑通一个 server+client。

---

## 1. MCP 解决什么问题

[agent-core/02](../agent-core/02-工具使用ToolUse.md) 讲了 function calling：你把工具定义喂给模型，模型请求调用，你执行后回填。问题在于——**每接一个新工具（数据库、Slack、GitHub、内部 API）都要写一套定制的对接代码**，换个 Agent 框架又要重写。工具方和 Agent 方是 N×M 的胶水地狱。

> **MCP（Model Context Protocol）是一个开放协议，把"Agent ↔ 工具/数据源"的连接标准化。** 被称为"**AI 界的 USB-C**"：工具方按 MCP 实现一次，任何支持 MCP 的 Agent 都能即插即用；Agent 方支持 MCP 一次，就能接入所有 MCP 工具。N×M 变成 N+M。

到 2026，MCP 已**成为行业标准**：LangChain、LangGraph、CrewAI、LlamaIndex 等已把它从"实验性支持"变成"默认的工具调用协议"。

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
- **Client（客户端）**：host 内部的一个进程，**维持与某一个 server 的一条连接**。一个 host 可同时连多个 server（每个 server 一个 client）。
- **Server（服务器）**：**暴露能力的一方**——把工具、资源、提示按 MCP 标准暴露出来。可以是本地进程，也可以是远程服务。

> 一句话：**Host 用多个 Client 连接多个 Server，Server 提供能力，Host 负责协调和安全。**

---

## 3. 两个协议层

MCP 分两层：

- **数据层（Data Layer）**：定义消息类型和**原语**（primitives，见第 4 节）。基于 JSON-RPC。这是"说什么"。
- **传输层（Transport Layer）**：定义"怎么传"，有两种：
  - **STDIO（标准输入输出）**：本地进程间通信。Server 作为本地子进程运行，最简单、最常用于本地工具。
  - **HTTP + SSE（Server-Sent Events）**：远程通信。Server 跑在远端，通过 HTTP 连接。用于远程/云端工具。

> 学习时从 **STDIO 本地 server** 起步最简单；生产对接远程服务用 HTTP+SSE。

---

## 4. 三大原语（Primitives）⭐ MCP 的核心

MCP server 能暴露三类东西，理解它们的区别很关键：

| 原语 | 是什么 | 有无副作用 | 类比 | 例子 |
|------|--------|------------|------|------|
| **Tools（工具）** | LLM 可**调用执行**的函数 | **有**（会改变状态/触发动作） | POST 请求 | 跑数据库查询、提交表单、发消息 |
| **Resources（资源）** | **只读**的数据源，提供上下文 | **无**（纯读取，无副作用） | GET 请求 | 文件内容、API 响应、数据库记录 |
| **Prompts（提示）** | 可复用的、server 定义的**指令模板** | 无 | 模板 | "代码审查"提示模板、"总结"模板 |

- **Tools** 就是 [agent-core/02](../agent-core/02-工具使用ToolUse.md) 讲的可执行工具，由 LLM 决定何时调用。
- **Resources** 是**纯读取的上下文数据**——这正是它和本专题"上下文工程"的连接点：resources 是标准化地把外部数据**作为上下文**供给模型，无副作用、可安全读取。
- **Prompts** 是 server 提供的现成指令模板，让 Agent 用统一的方式approach某类任务。

> 关键澄清：**MCP 提供了"连接和供给"，但"调哪个工具/读哪个资源"仍由 LLM 根据上下文决定。** MCP 不替模型做决策，它只是把能力标准化地摆上桌。

---

## 5. MCP vs Function Calling vs 框架（别混淆）⭐

这三个概念新手极易搞混，讲清楚：

| | 是什么 | 关系 |
|---|--------|------|
| **Function Calling** | 模型"输出结构化工具调用请求"的**能力**（模型层面） | 底层机制。MCP 工具最终也是通过模型的 function calling 能力被调用 |
| **MCP** | 工具/数据**怎么标准化地连接**给 Agent 的**协议**（集成层面） | 把工具"供给"标准化。不是框架，不替你做编排 |
| **编排框架**（LangGraph 等） | 怎么组织 Agent 的循环、状态、多步流程（编排层面） | 用 MCP 接工具，框架负责"什么时候用、怎么串" |

> 一句话理顺：**框架负责"编排流程"，MCP 负责"标准化接入工具/数据"，function calling 是模型"发起调用"的底层能力。** 三者是不同层次，互补而非替代。

---

## 6. 怎么用（学习路径）

1. **跑通一个本地 MCP server**：用官方 SDK（Python/TypeScript）写一个暴露 1~2 个工具的 STDIO server（如"查天气""读文件"）。
2. **用一个 MCP client 连它**：可以用 Claude 桌面端配置连接，或写一个简单 host 程序。
3. **观察完整链路**：Agent 列出 server 暴露的 tools → LLM 决定调用 → client 转发给 server → server 执行 → 结果回到 LLM。
4. **加一个 Resource 和 Prompt**：体会三种原语的区别。
5. **接现成 server**：社区有大量现成 MCP server（GitHub、文件系统、数据库、搜索等），直接接入感受"即插即用"。

> 💡 **本仓库环境本身就是活教材**：飞书系列 skill、computer-use、Chrome 等都是以 MCP 形式提供的工具——你日常用的就是 MCP 在工作。

---

## 7. 安全（MCP 的重点，也是 2026 热点）⚠️

MCP 让 Agent 能连接大量外部能力，安全面随之放大。核心原则：

- **最小权限（Least Privilege）**⭐：给每个 MCP server 配最小必要权限。如果 Agent 只需"总结 CRM 数据"，就把 server 配成**严格只读的方法过滤**，绝不给写权限。
- **不要靠 LLM 的系统提示来执行安全边界**⭐：系统提示能被 prompt 注入绕过。**安全必须在 host/server 侧用代码强制**（权限过滤、方法白名单），而不是"在 prompt 里叮嘱模型别乱来"。
- **Host 是安全主战场**：连接权限、用户授权、安全策略都在 host 侧强制执行。
- **审视 Resources 的内容**：从外部 server 读回的资源内容可能含恶意指令（间接 prompt 注入），进上下文前要警惕。
- **远程 server 的认证授权**：HTTP+SSE 远程连接要做好鉴权（OAuth 等）、传输加密。
- **审计**：记录 Agent 调用了哪些 server 的哪些工具/资源。

> 这与 [agent-core/02](../agent-core/02-工具使用ToolUse.md) 的工具安全一脉相承，并在 [INDEX 阶段 7](../INDEX.md) 系统展开：**自主性越高、连接的能力越多，安全越关键。**

---

## 8. 常见坑

- **混淆 MCP 和框架** → 以为 MCP 能替代 LangGraph 做编排。它只管"接入"。
- **混淆三个原语** → 把只读数据做成有副作用的 Tool，或反过来。读数据用 Resource，执行动作用 Tool。
- **靠系统提示做安全** → 被注入轻易绕过。安全要在 server/host 侧用代码强制。
- **给 server 过大权限** → 一旦被注入或出错，破坏面巨大。最小权限。
- **远程 server 不做鉴权** → 暴露内部能力。
- **不审视 resource 内容** → 间接 prompt 注入。

---

## 9. 本章小结

- **MCP = 工具/数据接入 Agent 的标准化协议**（"AI 的 USB-C"），把 N×M 胶水变成 N+M，2026 已成行业标准。
- 架构三角：**Host（协调+安全）用多个 Client 连多个 Server（暴露能力）**。
- 两层：**数据层**（消息+原语，JSON-RPC）+ **传输层**（本地 STDIO / 远程 HTTP+SSE）。
- 三大原语：**Tools（可执行、有副作用）、Resources（只读上下文、无副作用）、Prompts（指令模板）**；调用决策仍由 LLM 做。
- **MCP ≠ 框架 ≠ function calling**：框架编排、MCP 接入、function calling 是模型发起调用的底层能力，三者互补。
- 安全靠 **host/server 侧的最小权限和代码强制**，绝不靠系统提示；自主性越高安全越关键。

## 10. 检验清单

- [ ] 能解释 MCP 解决的"N×M 胶水"问题，以及"USB-C"类比。
- [ ] 能画出 host/client/server 三角并说清各自职责（尤其 host 是安全边界）。
- [ ] 能区分 Tools / Resources / Prompts 三大原语及"有无副作用"。
- [ ] 能讲清 MCP、function calling、编排框架三者的层次关系。
- [ ] 知道为什么"不能靠系统提示做安全"，安全该加在哪。

---

> 下一步：[02-上下文工程基础](02-上下文工程基础.md) —— 理解 Agent 可靠性的头号命门。
>
> 参考：[MCP Architecture Explained 2026 (Clarifai)](https://www.clarifai.com/blog/mcp-architecture-explained) · [MCP Security Checklist 2026](https://www.networkintelligence.ai/blogs/model-context-protocol-mcp-security-checklist/) · [What is MCP — IBM](https://www.ibm.com/think/topics/model-context-protocol)
