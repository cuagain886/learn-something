# 第 21 课：多模块 Agent Runtime

这一课把第 17～19 课组合成一个可运行、可取消、可测试的 Agent Runtime。重点不是接入某个模型 SDK，而是建立 SDK 背后的协议边界：`unknown` 模型响应如何获得证据、工具怎样授权与验证、并发怎样有界、transcript 怎样保持确定、失败怎样脱敏。

深入设计推导见：[多模块 Agent Runtime 架构案例](../../../knowledge/14_agent_runtime_case_study.md)。

## 运行

```bash
npm run lesson:agent-runtime
npm run lesson:agent-runtime:dist
npm test
npm run typecheck
```

`lesson:agent-runtime` 用 `tsx` 直接运行源码；`:dist` 先由 `tsc` 构建，再让 Node 执行真实 ESM 产物。两条路径都通过，才能同时证明开发期和发布期模块语义。

## 数据流与信任边界

```text
ModelAdapter.complete(): Promise<unknown>
  │
  ├─ parseModelTurn ──失败──> ModelProtocolError / failed outcome
  │
  ▼
validated ModelTurn
  │
  ├─ final ────────────────> completed outcome
  │
  └─ tool_calls
       ├─ 单轮数量上限
       ├─ 全 Run call-id 唯一性
       └─ bounded worker pool
            └─ ToolRegistry.invokeDynamic(name, unknown)
                 ├─ cancel + permission
                 ├─ Schema.safeParse
                 ├─ execute(parsed input)
                 └─ JSON-safe output validation + clone
                      └─ 稳定、脱敏的 tool message
```

所有进入模型或工具执行的外部值都从 `unknown` 开始。TypeScript 类型只保护已经进入可信内部的代码；模型、SDK、JavaScript 插件和类型断言都能制造与声明不符的运行时值。

## 文件职责

| 文件 | 职责 | 关键机制 |
|---|---|---|
| [domain.ts](domain.ts) | 消息、turn、事件、结果与失败协议 | 判别联合、只读数据、usage 溢出检查 |
| [model.ts](model.ts) | 模型端口与 normalized turn 解析 | `Promise<unknown>`、Schema、协议错误 |
| [tool.ts](tool.ts) | 工具定义、授权、注册表与输出验证 | const 泛型、phantom type、JSON-safe clone |
| [async-queue.ts](async-queue.ts) | 单消费者事件队列 | AsyncIterator、waiter、detach 语义 |
| [runner.ts](runner.ts) | Agent 状态机和有界调度 | 多维预算、call-id、worker pool、cancel + join |
| [example-tools.ts](example-tools.ts) | sum/search 示例 | Schema 复用、transform、权限 |
| [mock-model.ts](mock-model.ts) | 确定性模型 Fake | 端口替换、无网络测试 |
| [demo.ts](demo.ts) | 完整入口 | 事件/结果双通道、穷尽事件格式化 |
| [runner.test.ts](runner.test.ts) | 运行时契约 | 故障路径、并发握手、输出攻击面 |
| [type-contracts.ts](type-contracts.ts) | 编译期契约 | `@ts-expect-error`、名称与 I/O 相关性 |

## 五个不能只靠类型声明保证的事实

### 1. `Promise<ModelTurn>` 不是证据

接口实现者可以来自旧 JavaScript、SDK 包装、流式组装器或测试替身。它承诺返回 `ModelTurn` 不代表真实数据符合协议。因此 `ModelAdapter` 返回 `unknown`；Runner 只消费 `parseModelTurn` 成功后的值。

模型 Schema 还验证非空 calls、非空白 ID/name、单轮 ID 唯一以及非负安全整数 usage。跨轮 ID 唯一则由 Runner 的历史状态检查。

### 2. Schema 是 wire 与 domain 的桥，不只是 validator

工具只声明一次 `inputSchema`，它同时提供：

- 给模型的 JSON Schema；
- 对动态 arguments 的运行时解析；
- `execute` 输入的静态推断。

`search_docs` 的 wire input 可省略 limit；`transform` 后 execute 总能拿到默认值 3。`invokeKnown` 接收的是领域值，不能再走 wire parse，否则 transform 可能重复执行。

### 3. 授权必须早于解析

`search_docs` 需要 `docs:read`。未授权调用即使参数也错误，只返回 `FORBIDDEN`，不泄漏字段路径、范围或权限名。Run 启动时复制权限 Set，避免外部在异步执行中途修改授权状态。

### 4. `JsonValue` 静态类型仍允许非法 JSON

以下值都可能静态通过：

- `NaN`、`Infinity`；
- 循环对象图；
- getter/accessor；
- symbol key、自定义原型；
- 稀疏数组和数组额外属性。

工具输出因此要深度验证并安全复制。实现用 property descriptor 避免执行 getter，用 active `WeakSet` 区分循环与合法共享引用，用 `defineProperty` 避免特殊键 setter。

### 5. 数量、并发和轮数是不同预算

| 选项 | 默认值 | 约束 |
|---|---:|---|
| `maxSteps` | 8 | 整个模型/工具循环最多多少轮 |
| `maxToolCallsPerTurn` | 16 | 单个模型 turn 最多制造多少工具工作 |
| `maxToolConcurrency` | 4 | 同时在途的工具执行数 |

只限制 step 不能阻止一轮创建几百个调用；只限制调用数量不能保护数据库连接池；只降低并发也不会减少总成本。

## 并发顺序

Runner 有意保留两个顺序：

- `tool_completed` 事件按真实完成顺序发出；
- 下一轮模型消息按原 calls 数组顺序回填。

前者反映真实性能，后者保证相同输入生成相同 transcript。worker pool 最多启动 `maxToolConcurrency` 个 worker，结果写回固定 index 槽位，因此无需牺牲确定性来换吞吐。

如果调度器内部出现意外 reject，它会 abort sibling、等待所有 worker settle，再传播第一个失败。工具的普通业务失败是 `ToolExecutionResult`，不会误伤兄弟任务。

## 失败分层

| ToolFailure | 内部保留 | 回填模型 |
|---|---|---|
| `UNKNOWN_TOOL` | name | code + name |
| `INVALID_ARGUMENTS` | ValidationIssue[] | code + issues |
| `FORBIDDEN` | requiredPermission | 只有 code |
| `INVALID_OUTPUT` | ValidationIssue[] | 只有 code |
| `CANCELLED` | reason | 只有 code |
| `EXECUTION_FAILED` | cause | 只有 code |

原始 cause、stack、权限名与输出实现细节不能直接序列化给模型。`serializeToolResult` 使用穷尽 switch；新增失败分支未处理时 typecheck 会失败。

## 测试证据

`runner.test.ts` 不只测 happy path，还证明：

1. 非法参数带 JSON Pointer 且不会进入 execute。
2. 未授权时先拒绝，不泄漏参数结构。
3. NaN、循环和 getter 输出被拒绝，getter 从未执行。
4. 非法 ModelTurn 在发 `model_completed` 和启动工具前失败。
5. 单轮 calls 超限时零工具启动。
6. call id 跨轮复用时第二次执行前失败。
7. worker pool 不超过并发上限，反馈仍按原顺序。
8. 取消 reason 能传播到阻塞模型。
9. maxSteps 产生明确终态。
10. AsyncQueue 拒绝第二消费者；观察者 break 不取消 Run。

并发测试使用 deferred Promise 握手，不用 sleep 猜测时序。

`type-contracts.ts` 另外锁定工具 literal name、名称与 I/O 的相关性、错误输入、未知工具名和重复工具名。这些性质无法由运行时测试证明。

## 推荐阅读顺序

1. `domain.ts`：先认识所有合法状态。
2. `model.ts`：观察外部 `unknown` 如何归一化。
3. `example-tools.ts`：观察一个 Schema 如何同时服务 wire/domain。
4. `tool.ts`：跟踪授权、解析、execute、输出 clone。
5. `runner.ts`：逐条标注状态机不变量和预算扣减点。
6. `runner.test.ts`：从失败测试反推每个设计决定。
7. `type-contracts.ts`：确认运行时证据和静态证据的分工。

## 有意保留的生产缺口

- 模型流式 delta 的协议组装与重试/fallback；
- Run deadline、单工具 timeout、token/费用/字节预算；
- tenant rate limit、bulkhead 和不配合取消的进程隔离；
- 写工具审批、幂等键、响应丢失后的副作用去重；
- 事件持久化、版本迁移、崩溃恢复与多实例 lease；
- 有界事件 buffer 与背压策略；
- principal/tenant、脱敏、审计与 trace/span。

这些能力应通过新端口或策略注入，不能让核心 Runner 直接依赖某个云 SDK、数据库或 Web 框架。

## 建议实验

1. 给 Run 和单工具分别加入 deadline，写测试区分两个超时来源。
2. 把 AsyncQueue 改成有界队列，证明消费者 break 后 producer 能退出。
3. 加入审批状态，并让审批绑定 principal 与规范化参数摘要。
4. 持久化事件后重放，拒绝 seq 缺口、重复终态和未知版本。
5. 随机生成对象图攻击输出 validator，验证 getter 不执行且循环不挂死。
6. 将工具数量扩到数百，观察类型实例化成本与运行时注册成本。
