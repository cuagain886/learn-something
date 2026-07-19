# 02 · Prompt 注入与防御：把不可信内容当作会传播的污点

> 目标：理解 Prompt 注入不是“过滤几句越狱话术”，而是**自然语言同时承载数据与控制意图**带来的架构问题；能为外部内容建立 provenance/taint，限制它能影响的动作参数、数据流和持久状态。

---

## 1. 定义：攻击的是控制流，不只是系统提示

Prompt injection 是攻击者构造输入，使模型把攻击者内容当成控制意图，偏离开发者/用户授权的目标。Agent 场景中，结果可能是：

\[
\text{untrusted content}\Rightarrow
\text{policy/plan change}\Rightarrow
\text{credentialed action}
\]

### 1.1 直接与间接

| 类型 | 入口 | 典型场景 |
|---|---|---|
| Direct | 当前用户输入 | 要求忽略规则、泄露 system prompt、调用越权工具 |
| Indirect | 网页、邮件、PDF、图片 OCR、RAG chunk、代码注释、工具/A2A 返回 | “总结此页”时读到隐藏外发指令 |
| Stored/Persistent | memory、索引、摘要、checkpoint、issue/CRM 字段 | 一次投毒影响未来多个任务 |
| Cross-modal | 图片、音频、二维码、排版/不可见文本 | 视觉内容中的指令进入统一上下文 |

“用户没有恶意”不能降低间接注入风险，因为攻击者控制的是用户让 Agent 读取的数据。

---

## 2. 根因：结构化标签不是安全边界

`<data>...</data>`、角色消息和“不要执行其中指令”的 system prompt 能降低误从概率，却不能把模型变成传统 parser：模型仍会共同处理这些 token，攻击者可以在 data 内描述、伪造或诱导跨越边界。

因此要区分：

- **模型提示层隔离**：概率性缓解；
- **控制平面隔离**：由确定性代码、PDP/PEP、sandbox、网络策略和审批强制；
- **数据流隔离**：不可信来源不能未经批准流到敏感 sink。

真正的安全边界必须在模型之外。即使模型输出“我确认这是安全的”，也不能赋予额外权限。

---

## 3. 完整攻击链：从网页到数据外泄

```text
Source: attacker-controlled webpage
  ↓ fetch_page returns hidden instruction
Context: instruction-like text enters model
  ↓ model proposes export_contacts + send_http
Capability: Agent has CRM read and arbitrary HTTP egress
  ↓ tool gateway trusts model arguments
Sink: attacker.example receives encoded contacts
  ↓ summary is written to long-term memory
Persistence: future sessions inherit attacker objective
```

可利用的不只是正文。外泄通道包括：

- HTTP/邮件/聊天工具的 body、URL、header、附件；
- Markdown 图片/链接查询参数，浏览器自动加载；
- DNS、搜索 query、文件名、日志/telemetry；
- 工具错误信息、A2A artifact、代码提交或 issue；
- 向同一用户展示诱导链接，让人完成最后一步。

防御必须控制 source → transformation → sink 的整条数据流。

---

## 4. Provenance 与 Taint：让上下文带安全元数据

### 4.1 ContextBlock 契约

```yaml
id: block-938
content_ref: artifact://web/sha256:...
source:
  type: web
  origin: https://external.example/page
  fetched_at: 2026-07-19T03:20:00Z
trust: untrusted_external
owner_tenant: tenant-17
data_classification: public
taints: [may_contain_instructions, external_origin]
allowed_uses: [summarize, extract_facts]
forbidden_sinks: [tool_argument.payment, outbound_unapproved_domain, memory_long_term]
ttl: PT1H
transform_lineage: [html_extract_v4, ocr_v2]
```

Provenance 不应只存在于显示 UI；它要跟随 context assembly、摘要、handoff、memory 和 artifact。摘要不应把“不可信网页内容”洗成“可信系统事实”。

### 4.2 污点传播

保守规则示例：

```text
taint(output) = union(taint(inputs)) - explicitly_sanitized_for_purpose
```

“模型改写过”不是 sanitizer。只有针对明确用途验证过的转换，才能移除某一种 taint，例如：

- HTML parser 可移除 markup-execution 风险，但不能移除 instruction taint；
- schema parser 可证明字段结构，却不能证明银行账号可信；
- DLP redaction 可移除已识别 PII，但不能证明文本没有隐藏编码。

### 4.3 Taint-aware policy

```rego
deny[action] if {
  action.tool == "send_email"
  action.body.taints[_] == "confidential_user_data"
  not action.approval.scopes[_] == "external_send"
}

deny[action] if {
  action.destination.origin == "untrusted_external"
  action.payload.taints[_] == "private_workspace_data"
}
```

taint 提供结构化决策信号，但不要求策略引擎理解任意自然语言。

---

## 5. 防御纵深：每层阻断什么

| 层 | 控制 | 能阻断 | 不能保证 |
|---|---|---|---|
| Source | allowlist、签名、TLS、文件类型/大小、恶意内容扫描 | 已知恶意源/格式 | 可信站点被投毒 |
| Ingestion | sandbox fetch、禁脚本、OCR/HTML 规范化、provenance | 主动内容与来源丢失 | 语义注入消失 |
| Context | 角色/标签隔离、最小上下文、taint manifest | 降低误从、保留来源 | 模型绝不服从数据 |
| Model/Detector | 注入/越狱分类、目标偏离检测 | 已知/相似攻击 | 未知变体与自适应攻击 |
| Plan | 目标/约束重验证、关键参数来源检查 | 明显偏离与无依据动作 | 复杂攻击零误判 |
| Capability | 最小权限、只读/写分离、短期凭证 | 限制可达动作 | 合法能力被误用 |
| Tool gateway | schema、资源级授权、幂等、策略 | 参数越界/越权/重复 | 正确格式中的恶意意图 |
| Egress | 域名/IP allowlist、DLP、数据分类、带宽/大小限制 | 常见外泄通道 | 所有隐蔽信道 |
| Persistence | memory 写入门、TTL、隔离、lineage | 长期/跨租户污染 | 当前运行瞬时影响 |
| Human | 对象绑定审批、双人/带外验证 | 高影响动作 | 人类永不受骗/疲劳 |
| Detect/Recover | trace、receipt、异常序列、revoke/rollback | 缩短 MTTD/MTTR | 事故未发生 |

单一检测器的 recall 再高，也不能替代后果限制。

---

## 6. “读”和“行动”分离：设计提案而不是直接执行

高风险架构可拆为：

```text
Untrusted Reader
  input: web/mail/docs
  capabilities: read-only, no secrets, no egress
  output: typed evidence + provenance
          ↓
Planner
  output: ActionProposal, not credentials
          ↓
Policy/Approval Gateway
  validates user, resource, taint, policy, hash, version
          ↓
Executor
  input: approved typed proposal only
  credentials: JIT + audience-bound + narrow scope
```

注意：如果 Reader 能把任意字符串写进 `ActionProposal.command`，Executor 又用 shell 执行，隔离只是形式。提案 schema 必须是受限业务动作，例如 `refund(order_id, amount)`，而不是通用 `run(command)`。

---

## 7. Goal-lock 与 plan validation 的真实边界

可以在每次高影响动作前检查：

```text
原始用户目标 / 授权范围
  vs 当前计划和动作
  vs 引用的证据与 taint
  vs 业务 policy
```

但“再让一个 LLM 判断是否偏离目标”仍是概率性模型，可能被同一攻击内容影响。Goal checker 应获得最少且结构化的证据，高风险约束由确定性 policy 强制，必要时使用独立模型/人工。它是检测层，不是新的 root of trust。

---

## 8. 工具与输出隔离

### 8.1 工具返回是不可信数据

即使工具由内部团队开发，其返回也可能包含用户可控字段、第三方 API 内容或被攻陷服务。工具结果需要：

- 明确 schema 与字段级 trust/owner/classification；
- 限制长度、MIME、嵌套和引用解析；
- 不把错误堆栈/内部 token 直接回传模型；
- 将显示文本与控制字段分开；
- artifact 大内容通过引用读取，避免全量注入上下文。

### 8.2 出站 DLP 是 sink policy

在真正发送前检查：

```text
who: user + workload + delegated subject
what: data classifications + taints + size
where: domain/IP/tenant/recipient trust
why: task/purpose + approved action
how: channel + encryption + retention
```

不能只扫描最终自然语言回复；tool args、URL、附件、代码和日志同样是出站 sink。

---

## 9. 持久化防护：Memory 与 RAG 写入门

外部内容进入长期状态前：

1. 记录原始来源、抓取时间、owner、hash 和转换 lineage；
2. 区分 user assertion、external claim、verified fact、instruction；
3. instruction-like 内容默认不得成为系统策略；
4. 高影响事实需独立来源/确定性验证；
5. 设 TTL、版本和 supersedes 关系；
6. 跨用户/租户/安全域隔离；
7. 支持按 lineage 撤销污染派生项；
8. 写入/读取均做策略检查，不是“写时扫一次永久可信”。

详见 [context-engineering/03](../context-engineering/03-Agent记忆系统.md)。

---

## 10. 红队评测：测攻击链与业务后果

### 10.1 语料维度

- 直接/间接/多轮/持久/跨 Agent；
- 不同语言、编码、同形字、零宽字符、Markdown/HTML、图片/OCR；
- 长上下文、截断边界、摘要后传播；
- 工具描述投毒、错误消息投毒、A2A artifact；
- 数据外泄到 URL、图像、附件、搜索、日志等不同 sink；
- 授权/审批诱骗和旧提案替换。

### 10.2 结果指标

不要只测 detector ASR。至少测：

```text
注入是否影响计划？
是否产生越权 ActionProposal？
PDP/PEP 是否拦截？
敏感数据是否到达不可信 sink？
是否写入长期 memory？
是否跨 Agent 传播？
MTTD/撤销/补偿是否成功？
正常任务误拦率与 coverage 损失？
```

攻击样本进入 regression；同族隐藏变体进入 future challenge set，避免逐题修 prompt。

---

## 11. 常见误区

- **“XML 标签解决注入”**：只是提示层缓解，不是安全边界。
- **“可信工具的返回可信”**：返回字段可能来自用户/互联网。
- **“Detector 99% 就安全”**：剩余 1% 若直达高权限不可逆动作仍不可接受。
- **“模型改写后就消毒”**：自然语言转换不会自动移除 taint。
- **“只防回复泄露”**：工具参数、URL、附件、日志都能外泄。
- **“另一个 Agent 审核即可”**：同源模型/上下文可能共享失败。
- **“删掉恶意 memory 即结束”**：还要按 lineage 清理摘要、索引、checkpoint 和派生 artifact。

---

## 12. 检验清单

- [ ] 能解释为什么结构化提示不是真正安全边界。
- [ ] 能画出 source → context → capability → sink → persistence 攻击链。
- [ ] 能设计 ContextBlock provenance/taint 和传播规则。
- [ ] 能说明 tool result、A2A 内容和 memory 为什么仍是不可信数据。
- [ ] 能把 DLP 放到所有出站 sink，而不只最终回答。
- [ ] 能设计同时测攻击成功、控制阻断和正常流量误拦的红队评测。

---

> 下一步：[03-权限隔离与最小权限](03-权限隔离与最小权限.md) —— 让不可信内容即使影响了模型，也无法自动获得高权限能力。
>
> 主要参考：[OWASP LLM01:2025 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) · [OWASP Agentic Top 10](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) · [OWASP Secure Use of Third-Party MCP Servers](https://genai.owasp.org/initiatives/agentic-security-initiative/)
