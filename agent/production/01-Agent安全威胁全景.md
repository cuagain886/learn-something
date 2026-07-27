# 01 · Agent 安全威胁全景：从资产和身份到 OWASP ASI01–ASI10

> 目标：能为一个 Agent 画出主体、资产、信任边界和攻击路径，并把风险精确映射到 OWASP Top 10 for Agentic Applications 2026，而不是把所有问题都叫作“Prompt 注入”。

---

## 1. 先区分安全、可靠性与 AI Safety

| 领域 | 典型问题 | 示例 |
|---|---|---|
| Security | 有对手主动利用系统 | 恶意网页诱导 Agent 外发联系人 |
| Reliability | 无对手也可能故障 | 工具 timeout-after-commit 导致重复退款 |
| Safety | 行为本身可能产生不可接受伤害 | 合法权限内给出危险医疗动作 |
| Privacy/Compliance | 数据处理不满足授权与法规 | trace 保存超期、跨租户检索 |

同一事故可能跨多类：攻击者通过注入劫持目标（security），工具重试又造成重复副作用（reliability），最终泄露 PII（privacy）。威胁建模不能只给一个标签，而要覆盖完整攻击链和后果。

---

## 2. Agent 为什么改变了攻击面

普通 LLM 主要产生内容；Agent 形成闭环：

\[
\text{untrusted input}\rightarrow\text{model decision}\rightarrow
\text{credentialed tool}\rightarrow\text{world state}
\]

风险放大来自：

- **权限**：模型可代表用户/服务执行真实动作；
- **多步**：攻击意图可跨计划、工具结果和交接持续传播；
- **状态**：checkpoint、memory、RAG 和 artifact 可形成持久污染；
- **组合**：多个看似低风险工具可拼成“读敏感数据 + 对外发送”；
- **不确定执行**：超时后无法知道副作用是否已提交；
- **动态供应链**：MCP server、skill、prompt、模型、插件和 Agent Card 可运行时变化；
- **人类信任**：自然语言解释会诱发过度授权或审批疲劳。

安全目标不是让模型“永远识别恶意文本”，而是让任何单点失败都难以跨越身份、权限、网络和副作用边界。

---

## 3. 威胁建模的四张表

### 3.1 资产（Assets）

```text
数据：用户内容、PII、密钥、商业数据、memory、RAG 语料、trace
能力：发送/支付/删除/部署/执行代码/改权限
状态：checkpoint、任务队列、审批、幂等记录、审计 receipt
信任：system prompt、policy、tool schema、Agent Card、模型/索引版本
资源：token 预算、工具配额、CPU/GPU、人工审批容量
```

### 3.2 主体与身份（Principals）

- 最终用户与资源所有者；
- Agent runtime/workload；
- 子 Agent、远程 A2A Agent；
- MCP client、MCP server、下游 API；
- 模型/检索/评测服务；
- 人工审批者、运维和数据标注者；
- 攻击者控制的网页、邮件、文档、工具或租户。

“Agent”不是一个身份。每一跳都要知道**谁在代表谁、对哪个资源、以哪个 audience/scope、在什么时间内行动**。

### 3.3 信任边界（Trust Boundaries）

```text
Internet / user content
  │ untrusted
  ▼
Context ingestion ──► model runtime
  │                    │ proposal, not authority
  ▼                    ▼
Policy enforcement ─► tool gateway ─► sandbox / business API
  │                         │
  ▼                         ▼
approval service       world state + receipt

跨租户、跨区域、跨组织 A2A、MCP server、队列和 artifact store
也都是独立边界，不因“都在同一 Agent 框架”而自动可信。
```

### 3.4 攻击路径与可观察点

每个威胁写成：

```text
入口 → 信任误判 → 权限/能力 → 副作用 → 持久化/传播 → 业务影响
       └ 检测点       └ 阻断点          └ 恢复/取证点
```

例如：

```text
恶意邮件
→ 被当作指令
→ Agent 读取 CRM + 调外发 HTTP
→ 联系人泄露
→ 恶意摘要写入长期 memory
→ 后续会话继续传播
```

控制必须覆盖入口、能力、出口、持久化和恢复，而不是只加一个输入分类器。

---

## 4. OWASP Top 10 for Agentic Applications 2026：精确映射

OWASP 在 2025-12 发布 2026 版 Agentic Top 10。当前十项名称如下：

| ID | 官方风险名 | 本项目中的具体攻击面 | 主要控制 |
|---|---|---|---|
| ASI01 | Agent Goal Hijack | 用户/网页/邮件/工具结果改变目标与约束 | provenance/taint、goal/plan policy、限权、动作审批 |
| ASI02 | Tool Misuse & Exploitation | 合法工具被错误组合、参数越界、SSR F/删除/外发 | tool gateway、typed schema、资源级授权、幂等/沙箱 |
| ASI03 | Identity & Privilege Abuse | 共享高权 token、token passthrough、confused deputy | workload/user identity chain、audience、JIT credential、PDP/PEP |
| ASI04 | Agentic Supply Chain Vulnerabilities | 恶意 MCP/skill/model/prompt/package/Agent Card | allowlist、签名/SBOM/attestation、版本钉死、隔离与撤销 |
| ASI05 | Unexpected Code Execution (RCE) | 模型生成 shell/SQL/模板，工具参数触发解释执行 | 无 shell 拼接、sandbox、seccomp、网络/文件限制、静态/动态检测 |
| ASI06 | Memory & Context Poisoning | RAG、memory、摘要、checkpoint 持久化恶意内容 | provenance、写入门、版本/TTL、隔离、回滚与 lineage 删除 |
| ASI07 | Insecure Inter-Agent Communication | 伪造 Agent、篡改 handoff、重放、schema confusion | mTLS/签名、身份发现、nonce/expiry、schema、授权和 receipt |
| ASI08 | Cascading Failures | 错误/取消/资源耗尽跨 Agent 放大 | bulkhead、backpressure、预算、circuit breaker、补偿、kill switch |
| ASI09 | Human-Agent Trust Exploitation | 欺骗性解释、审批疲劳、伪造来源、社会工程 | 风险透明、证据绑定、双人审批、UI 防欺骗、培训与抽检 |
| ASI10 | Rogue Agents | Agent 越过目标/策略持续行动、影子 Agent、失去控制 | inventory、租约/凭证撤销、行为策略、隔离、远程停止与取证 |

Top 10 是威胁建模起点，不是完整控制清单，也不代替传统 AppSec、云安全、隐私和供应链安全。SQL 注入、SSRF、XSS、反序列化、容器逃逸等传统漏洞仍然存在，只是可能由自然语言规划触发。

---

## 5. 三条典型组合攻击链

### 5.1 间接注入 → confused deputy → 外泄

```text
ASI01 恶意网页劫持目标
→ ASI03 Agent 持有用户/服务的广泛凭证
→ ASI02 调 CRM 导出 + HTTP 工具
→ 数据流向攻击者域名
→ ASI06 攻击内容写入 memory
```

输入检测漏掉一次不应导致全链失守。真正的阻断点可以是：CRM 行级授权、外发域名 allowlist、DLP、能力不可组合、审批对象绑定。

### 5.2 供应链 → RCE → 身份窃取

```text
恶意/被接管 MCP server 或 skill（ASI04）
→ 工具描述/结果投毒目标（ASI01）
→ 诱导代码工具解释执行（ASI05）
→ 读取长效 token（ASI03）
→ 横向访问其它服务
```

因此只扫描 prompt 不够；需要供应链 attestation、工具运行隔离、无静态凭证和出站限制。

### 5.3 Agent 间传播 → 级联故障

```text
伪造 A2A 消息（ASI07）
→ Supervisor 反复 fan-out
→ workers 共享错误 memory（ASI06）
→ 重试风暴/预算耗尽（ASI08）
→ 人类在告警洪水中误批准（ASI09）
```

控制包括消息身份与重放防护、全局预算、租户 bulkhead、取消传播和审批速率/聚合。

---

## 6. 控制类型：预防、检测、遏制、恢复

| 阶段 | 问题 | 例子 |
|---|---|---|
| Prevent | 能否阻止越过边界 | 最小权限、PDP/PEP、sandbox、egress allowlist |
| Detect | 漏过后能否迅速知道 | taint 告警、异常工具序列、receipt/trace invariant |
| Contain | 能否限制爆炸半径 | 租户隔离、预算、rate limit、bulkhead、JIT token |
| Recover | 能否撤销和恢复 | credential revoke、Saga compensation、memory rollback、用户通知 |
| Learn | 能否防止再发 | incident case、红队回归、控制 owner 与验证记录 |

很多文档只列“预防”，却没有撤销凭证、删除污染记忆和补偿已发生副作用的方案。对自主系统，恢复能力本身就是安全控制。

---

## 7. 风险量化：概率 × 影响还不够

基本风险可以写为：

\[
Risk=P(attack\ succeeds)\times Impact
\]

但 Agent 还需显式考虑：

- `Reachability`：攻击输入能否到达有权限的动作路径；
- `Privilege`：当前/可升级权限；
- `Blast radius`：单次、单用户、单租户、全局影响；
- `Reversibility`：是否可补偿；
- `Persistence`：是否进入 memory/checkpoint；
- `Detectability/MTTD`：多久才能发现；
- `Propagation`：是否跨 Agent/工具/组织扩散。

优先级应由“可达高权、不可逆、可持久/传播、难检测”的路径主导，而不只是注入分类器的攻击成功率。

---

## 8. 威胁模型模板

```yaml
system: invoice-agent
assets: [invoice_db, vendor_bank_account, oauth_tokens, audit_receipts]
principals: [employee, agent_runtime, approval_service, erp_mcp, bank_api]
trust_boundaries: [user_to_host, host_to_mcp, mcp_to_erp, approval_to_executor]
entry_points: [email, pdf, user_prompt, vendor_portal, a2a_message]
high_impact_actions: [change_bank_account, approve_payment, export_vendors]
attack_path:
  entry: malicious_pdf
  taint_flow: pdf_text -> context -> proposal.bank_account
  required_privilege: vendor.write
  impact: payment diversion
controls:
  preventive: [untrusted_data_label, bank_change_requires_out_of_band_verification]
  containment: [single_vendor_scope, amount_limit, jit_token]
  detective: [proposal_hash_trace, new_destination_alert]
  recovery: [revoke_token, freeze_payment, incident_notification]
evidence: [red_team_case_34, policy_test_18, drill_2026q2]
owner: payments-security
```

---

## 9. 面试追问

**问：Agent 最大风险是不是 Prompt 注入？**

它是重要入口和 ASI01 常见机制，但严重后果通常依赖 ASI02/03 的工具与权限、egress、memory 和审批缺陷。安全设计应建模完整攻击链，而不是只提高注入识别率。

**问：为什么传统 IAM 还不够？**

传统 IAM 仍是基础，但 Agent 需要表达“用户授权 + workload 身份 + 当前任务 + 目标资源 + 动作参数 + 风险/批准”的动态委托，并处理多 Agent/工具的 confused deputy 和 token audience。

**问：如何证明控制有效？**

每个控制需要 threat → control → test → telemetry → owner：用对抗用例、故障注入、策略单测、trace invariant、canary 和事故演练给出证据，而不是只说“已加护栏”。

---

## 10. 检验清单

- [ ] 能列出 ASI01–ASI10 的准确名称和一个具体例子。
- [ ] 能画出资产、主体、信任边界和完整攻击路径。
- [ ] 能区分 Security、Reliability、Safety 与 Privacy 的交叉。
- [ ] 能为攻击链设计 Prevent/Detect/Contain/Recover 控制。
- [ ] 能解释为什么安全控制要覆盖传统 AppSec 与 Agentic 风险。

---

> 下一步：[02-Prompt注入与防御](02-Prompt注入与防御.md) —— 从攻击入口深入 provenance/taint、跨工具传播与出站数据控制。
>
> 主要参考：[OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) · [OWASP Agentic Security Initiative](https://genai.owasp.org/initiatives/agentic-security-initiative/) · [OWASP Agentic AI Threats and Mitigations](https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/) · [Anthropic：Agentic misalignment](https://www.anthropic.com/research/agentic-misalignment)（2025-06，内部威胁式行为压力测试，ASI10 威胁建模的模型侧输入）
