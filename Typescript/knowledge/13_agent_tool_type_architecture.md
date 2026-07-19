# 13 · Agent 工具系统的类型架构与边界 ⭐⭐⭐

> LLM 生成的工具调用只是“建议执行的外部数据”，不是可信函数调用。工具系统要把动态协议收敛到静态、可观测、可取消的执行核心。

配套代码：[第 19 课类型安全工具注册表](../code/src/19-typed-tool-system.ts)。

---

## 1. 工具调用跨越三种世界

```text
模型/网络世界              边界适配层                   业务执行世界
unknown JSON  ──解析──>  Validation Result  ──构造──>  ToolInput
动态 tool name            注册表查找                    强类型 execute
不稳定错误格式             统一错误分类                  ToolOutput
```

常见错误是直接跳过中间层：

```typescript
const args = JSON.parse(call.arguments) as SearchArgs;
await search(args);
```

这里同时相信了 JSON 语法、对象结构、字段类型和业务不变量。`as` 不会生成任何检查，工具真正执行时才可能以难以定位的方式失败。

---

## 2. 一个工具定义至少包含五类契约

```typescript
type ToolDefinition<Name, Input, Output> = {
  name: Name;
  description: string;
  inputSchema: RuntimeSchema<Input>;
  execute(input: Input, context: ToolContext): Promise<Output>;
  policy: ToolPolicy;
};
```

除了名称、描述和执行函数，还应显式考虑：

- 输入运行时 schema。
- 输出 schema 或可信构造边界。
- 权限/副作用等级。
- 超时与重试策略。
- 幂等性与审批要求。
- 日志脱敏策略。

类型只能保证“实现与声明一致”；能否执行这个工具是运行时授权问题，不能靠泛型解决。

---

## 3. Schema 应成为输入类型的单一事实源

手写两份契约容易漂移：

```typescript
interface SearchInput { query: string; limit: number }
const schema = { /* 忘了 limit，或把它写成 string */ };
```

更好的方向是从 schema 推导类型：

```typescript
const searchSchema = object({
  query: string(),
  limit: integer().min(1).max(20),
});

type SearchInput = Infer<typeof searchSchema>;
```

但“单一事实源”不等于 schema 能表达全部业务规则。跨字段约束、权限、数据库存在性仍需语义验证。可以把验证分为：

1. JSON/协议语法。
2. 结构 schema。
3. 领域不变量。
4. 授权和外部状态。

每层返回可定位错误，不要最终只剩 `invalid arguments`。

---

## 4. 工具名与输入/输出必须保持相关性

错误设计：

```typescript
type ToolName = 'search' | 'weather';
type ToolInput = SearchInput | WeatherInput;
type ToolOutput = SearchOutput | WeatherOutput;

function invoke(name: ToolName, input: ToolInput): Promise<ToolOutput>;
```

类型允许 `invoke('weather', searchInput)`，返回后也不知道是哪种输出。正确模型使用映射或工具定义联合：

```typescript
type Tools = {
  search: { input: SearchInput; output: SearchOutput };
  weather: { input: WeatherInput; output: WeatherOutput };
};

function invoke<Name extends keyof Tools>(
  name: Name,
  input: Tools[Name]['input'],
): Promise<Tools[Name]['output']>;
```

相关性是高级 TS API 的核心：不是把所有可能类型塞进联合，而是保留“选择了哪个键，就对应哪个值”。

---

## 5. 动态注册表为何常需要一个局部断言

运行时通常用：

```typescript
const tool = map.get(call.name);
```

JavaScript `Map<string, Tool>` 会把 tuple 中每个工具的精确 name/input/output 擦成统一基类。Checker 无法自动证明：构造 Map 时每个键恰好等于工具自己的 `name`，且之后未被错误修改。

成熟做法不是声称“绝对不用断言”，而是：

1. 构造器只接受保留字面量的只读工具 tuple。
2. Map 私有且不可由调用方修改。
3. 所有写入都来自 `[tool.name, tool]`。
4. 在 `get` 后的单一位置恢复相关类型。
5. 用编译期与运行时测试证明这个封装不变量。

这叫**局部化不安全性**。和操作系统/标准库内部使用 unsafe 类似，目标是把无法静态证明的桥接缩小并审计，而不是把 `as` 散到业务代码。

---

## 6. 外部调用与内部调用应有不同入口

外部 LLM 调用：

```typescript
invokeRaw(name: string, raw: unknown, context: ToolContext)
```

必须查名字、验证参数、检查权限。内部已知调用可以提供：

```typescript
invokeKnown<Name extends ToolName>(
  name: Name,
  input: ToolInput<Name>,
  context: ToolContext,
)
```

后者改善编译期体验，但仍可复用运行时验证路径，避免“内部强类型调用”和“外部解析调用”出现两套行为。类型安全不等于绕过验证，因为内部值也可能来自数据库、缓存或旧版本消息。

---

## 7. 工具错误需要稳定的可辨识联合

```typescript
type ToolFailure =
  | { code: 'UNKNOWN_TOOL'; name: string }
  | { code: 'INVALID_ARGUMENTS'; issues: readonly Issue[] }
  | { code: 'FORBIDDEN'; policy: string }
  | { code: 'TIMEOUT'; timeoutMs: number }
  | { code: 'RATE_LIMITED'; retryAfterMs?: number }
  | { code: 'EXECUTION_FAILED'; cause: unknown };
```

错误分类驱动 Agent 决策：

- UNKNOWN/INVALID：把结构化反馈给模型，请它修正调用。
- FORBIDDEN：不能让模型靠重试绕过。
- TIMEOUT/RATE_LIMITED：依据预算和幂等性决定重试。
- EXECUTION_FAILED：记录 cause，可能降级或终止。

不要把原始 stack、数据库错误或密钥相关信息原样回传模型。面向模型的错误、面向用户的错误、面向运维的诊断应是不同视图。

---

## 8. 工具执行上下文不应塞进输入 Schema

```typescript
type ToolContext = {
  runId: string;
  signal: AbortSignal;
  deadline: number;
  principal: Principal;
  trace: TraceWriter;
};
```

模型只产生业务参数，不应决定：

- 当前用户身份。
- 授权范围。
- 超时时间上限。
- 租户 ID。
- 审批结果。
- 追踪上下文。

这些可信环境数据由宿主注入 `ToolContext`。如果把 `userId` 同时放在模型参数中，可能形成典型的 confused deputy：模型要求工具代表另一个用户执行。

---

## 9. 副作用与审批是运行时状态机

工具可按风险建模：

```typescript
type Effect = 'read' | 'reversible-write' | 'irreversible-write';

type ExecutionState =
  | { status: 'validated'; call: ValidatedCall }
  | { status: 'awaiting_approval'; call: ValidatedCall; requestId: string }
  | { status: 'executing'; call: ValidatedCall; startedAt: number }
  | { status: 'succeeded'; output: unknown }
  | { status: 'failed'; error: ToolFailure };
```

类型能防止代码直接从“未验证”跳到某些执行 API，但审批是否真实存在、是否过期、是否匹配参数哈希必须运行时检查。批准 `sendEmail(to=A)` 后不能静默把参数改为 `to=B`；审批应绑定规范化调用内容。

---

## 10. JSON Schema 与 TypeScript 类型不是一一对应

JSON Schema 描述 JSON 数据；TypeScript 还可以描述函数、class、symbol、递归条件类型等编译期概念。映射时常见损失：

- `undefined` 不是 JSON 值。
- `Date` 通常在线上是字符串，需要格式和语义解析。
- `bigint` 不能直接 JSON.stringify。
- 品牌类型运行时仍是底层字符串/数字。
- `Map`/`Set` 需要自定义编码。
- `additionalProperties` 与 TS 结构兼容/多余属性检查语义不同。
- 联合若没有清晰判别字段，模型生成和错误定位都会变差。

工具输入应优先选择 JSON 友好的明确对象、字面量枚举和可辨识联合。不要把复杂 TS 类型“自动转 schema”当成无损编译。

---

## 11. 输出同样需要边界设计

工具返回内部对象不代表可以直接交给模型：

- 循环引用无法 JSON 序列化。
- 大结果会挤占上下文窗口。
- Error、Buffer、Stream 需要转换。
- 内部字段可能包含隐私或密钥。
- 时间、金额和 ID 需要稳定编码。

推荐分层：

```text
Domain Output → Tool Result DTO → 截断/脱敏/序列化 → Model Message
```

输出 schema 可以在测试和插件生态中防止实现漂移。超大结果应写入对象存储/检索系统，只把句柄、摘要和可引用片段交给模型。

---

## 12. 工具协议的版本演进

修改工具 schema 会影响：模型提示、缓存中的历史调用、持久化 run、回放测试和第三方插件。常见策略：

- 新增可选字段并在边界设置默认值。
- 新增工具版本名，如 `search_v2`，逐步迁移。
- 工具调用 envelope 带 protocol version。
- 旧输入先 normalize 到最新领域模型。
- 保存原始调用和规范化调用，便于审计。

删除字段、改变单位、收窄枚举、修改 null/缺失语义都可能是破坏性变更。只看 TypeScript 源码能否编译不足以判断线上兼容性。

---

## 13. 注册表不变量、动态结果联合与鉴权顺序

### known-call 和 unknown-call 不应伪装成一个 API

```typescript
registry.invokeKnown("sum", { values: [1, 2] }, context);
registry.invokeUnknown(modelName, modelArguments, context);
```

第一条路径服务于仓库内 TypeScript 代码：工具名是有限联合，name 决定精确 input/output。第二条路径才是 LLM/HTTP 真实边界：name 必须接受任意 string，arguments 必须是 unknown，并在运行时处理 NOT_FOUND。

若所谓“动态入口”把 name 参数写成 `keyof Registry`，它只是把不可信 string 的问题推给上游断言，没有解决边界。动态成功结果可以重新附加实际 toolName，构造成判别联合：

```typescript
type DynamicSuccess =
    | { ok: true; toolName: "sum"; value: SumOutput }
    | { ok: true; toolName: "weather"; value: WeatherOutput };
```

这样解析完成后仍能通过 switch 恢复 name/value 相关性。

### 唯一名称需要静态和运行时两道门禁

const tuple 可以用递归条件类型在编译期找出重复 name，但插件数组、配置加载、`any` 和反射仍能绕过它。构造注册表时必须再次用 Map 检查重复，否则后注册覆盖前注册会静默改变授权与执行目标。

Map 抹掉异构工具间的相关性是正常现象。安全实现应满足：

1. Map 私有且只能由已检查的工具 tuple 构造；
2. key 永远取自 `tool.name`；
3. 重复 key 被拒绝；
4. 唯一断言位于 name lookup 后的封闭 adapter；
5. 调用方永远不需要 `as any`。

### 先鉴权还是先解析不是无关紧要的实现细节

受保护工具通常应先做“工具存在/调用者是否有权访问”的粗粒度判断，再返回详细字段校验错误。否则未授权调用者可利用 expected enum、字段路径和长度限制探测内部工具协议。执行前还要再次检查 cancellation；parser 成功不代表等待期间授权和 run 状态不会变化。

模型 manifest 应返回深复制或不可变快照，避免调用方改写嵌套 JSON Schema 后污染后续请求。模型看见的 schema、服务端 parser 和 execute input 最好来自同一个 Schema 值，但 transform 后的领域值不应再次当 wire input 重复解析。

完整证明见 [第 19 课：工具系统静态/动态双入口](../code/src/19-typed-tool-system.ts)。

---

## 14. 类型与运行时测试矩阵

### 编译期

- 工具名能否精确推断。
- 名称是否关联正确 Input/Output。
- 错误输入是否用 `@ts-expect-error` 被拒绝。
- 新增工具后联合和注册表是否自动扩展。
- 公共 `.d.ts` 是否没有泄漏内部辅助类型。

### 运行时

- 非对象、缺字段、错误枚举、超长字符串、NaN 等边界输入。
- 未知工具名。
- Schema 成功后 execute 接收的确是规范化值。
- 超时/取消向下传播。
- 审批与调用参数绑定。
- 日志脱敏。
- 输出序列化、大小限制和版本兼容。

### 回放/E2E

- 保存真实模型调用样本并离线回放。
- 协议升级时用旧样本验证兼容层。
- 故障注入：429、连接中断、部分结果、重复 delivery。

当工具通过 MCP 暴露时，本章的 Schema/授权/执行边界位于 `tools/list` 与 `tools/call` 的领域层；request id、取消竞态、初始化和 transport 则是另一层协议责任。不要把两层揉进一个 Tool interface，详见 [JSON-RPC 2.0 与 MCP 协议底层](26_json_rpc_mcp_protocol_internals.md)。

---

## 一句话总结

类型安全的 Agent 工具系统不是给 `execute` 加一个 interface，而是建立完整证据链：`unknown 调用 → schema 验证 → 领域构造 → 权限/审批 → 可取消执行 → 稳定结果协议`。TypeScript 的任务是保存这些阶段之间的相关性，并把无法静态证明的部分压缩到可审计边界。
