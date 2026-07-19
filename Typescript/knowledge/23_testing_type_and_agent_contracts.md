# 23 · TypeScript 与 Agent 的多层契约测试 ⭐⭐⭐

“测试通过”只有在测试覆盖了正确契约时才有意义。TypeScript Agent 同时包含静态类型、运行时解析、异步状态机、工具副作用、流式协议和非确定模型输出；单靠几个 happy-path 单元测试无法证明系统可靠。

配套实验：[`../code/src/30-testing-contracts.test.ts`](../code/src/30-testing-contracts.test.ts)。运行：

```bash
npm run lesson:testing
```

实验使用 Node 内置 test runner，通过端口注入、握手 Promise、mock function、表驱动边界和确定性属性测试，验证现有多模块 Agent Runtime。

---

## 1. 先问“需要哪条证据链”

TypeScript 项目的契约至少分六层：

| 层 | 要证明什么 | 典型方法 |
|---|---|---|
| 编译期类型 | 非法调用无法编译，推断保持关联 | `tsc --noEmit`、`@ts-expect-error`、Equal/Expect |
| 运行时边界 | unknown 输入被验证，非法值不进入领域层 | 表驱动、fuzz、schema contract |
| 纯领域逻辑 | 状态转换、预算、聚合满足不变量 | example-based、property-based |
| 异步编排 | 顺序、并发、取消、清理正确 | deferred handshake、fake clock、事件断言 |
| 端口适配 | SDK/HTTP/存储协议映射正确 | contract test、录制响应、受控本地 server |
| 系统行为 | 真实模型和工具共同完成用户目标 | sandbox E2E、evaluation、人工审阅 |

上层测试不能替代下层：一次真实模型 E2E 成功，不能证明非法 JSON 永远进不了 execute；类型检查通过，也不能证明网络响应符合类型断言。

---

## 2. 编译期测试不是运行时测试

```ts
registry.invokeKnown("sum", { values: [1, 2] }, context);

// @ts-expect-error values 必须是 number[]
registry.invokeKnown("sum", { values: ["wrong"] }, context);
```

`@ts-expect-error` 是负向断言：下一行必须存在类型错误。如果 API 意外变宽，注释本身会报“没有预期错误”，从而让 CI 失败。

### 它能证明什么

- 工具名与输入/输出关联；
- 非法字段被静态拒绝；
- 泛型推断没有退化成 any；
- 判别联合收窄结果正确；
- 发布 API 的预期调用方式。

### 它不能证明什么

- JavaScript 调用方传入的值；
- JSON/LLM 参数真实结构；
- 类型断言是否说谎；
- 运行时分支和副作用；
- 异步时序；
- 错误/取消/资源清理。

类型测试和 runtime test 必须并存。

### 不要只写正向类型测试

一个退化为 `any` 的 API 几乎所有正向示例都会“通过”。负向测试才会发现边界消失。

---

## 3. 类型等价测试也有陷阱

常见工具：

```ts
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? true
    : false;

type Expect<T extends true> = T;
```

它适合普通类型比较，但 `any`、条件类型、交叉类型、重载和 readonly 的某些边界可能表现意外。必要时拆开测试：

- `A extends B`；
- `B extends A`；
- 具体合法值可赋值；
- 具体非法值被拒绝；
- `IsAny<T>` / `IsNever<T>` 单独检测。

不要把一个 Equal 实现当成类型系统的完整证明器。

---

## 4. 从 `unknown` 开始测试运行时边界

模型参数、HTTP body、环境变量和数据库 JSON 都是 unknown。测试不能只传 TypeScript 已经证明正确的对象：

```ts
const cases: readonly unknown[] = [
  null,
  [],
  {},
  { query: 42 },
  { query: "TypeScript" },
];
```

要同时断言：

- 每个非法值返回稳定 issue；
- parser 自己不会因 `null`、getter、深对象崩溃；
- 非法输入绝不调用 execute；
- 合法值经过归一化后类型正确；
- 额外字段是拒绝、剥离还是保留；
- 错误路径不会泄漏原始敏感值。

### 表驱动测试比复制测试更清晰

把输入、标签和预期放入表格，在失败信息中打印 case label。新增边界只加一行数据，验证逻辑保持一致。

### 恶意对象边界

普通 JSON 没有 getter 和循环，但进程内插件可以传：

```ts
const hostile = {
  get query() {
    throw new Error("getter side effect");
  },
};
```

若 parser 声称接收任意 unknown，就要决定是否防御这类对象。JSON.parse 后的普通数据边界则可明确缩小威胁模型。

---

## 5. 用六边形端口替代模块级大 Mock

```ts
interface ModelAdapter {
  complete(request: ModelRequest, signal: AbortSignal): Promise<unknown>;
}
```

AgentRunner 依赖接口而不是具体 SDK，使测试可以注入 deterministic fake：

```ts
const model: ModelAdapter = {
  async complete(request) {
    return request.step === 1 ? toolCalls : finalAnswer;
  },
};
```

端口返回 `unknown` 是测试设计的一部分：真实 SDK 和 fake 都位于 Runner 的协议边界外。若端口直接写成 `Promise<ModelTurn>`，测试替身只是在静态层承诺自己正确，无法验证 Runner 面对空 calls、负 usage、重复 call id 或漂移字段时真的会拒绝。正常 fake 可返回合法对象；故障测试则有意返回畸形对象，并断言失败发生在 `model_completed` 和工具副作用之前。

优势：

- 测试不需要 patch ESM import；
- 请求和响应仍受完整类型约束；
- 可以显式模拟取消、限流和非法响应；
- 生产适配器与 Runner 边界清楚；
- fake 行为只服务当前测试，不产生全局污染。

### 测试替身术语

| 名称 | 作用 |
|---|---|
| Dummy | 只是满足参数，从不使用 |
| Stub | 返回预设结果 |
| Fake | 有简化但可工作的实现，如内存仓储 |
| Spy | 记录调用供断言 |
| Mock | 预先定义调用期望并验证 |

术语不是重点，重点是替身是否保留你要验证的契约。一个总是成功的 fake 不能测试重试和取消。

---

## 6. 异步测试不要用 sleep 猜状态

脆弱写法：

```ts
const run = runner.start();
await delay(10);
run.cancel();
```

测试假设模型在 10ms 内已经进入阻塞点。CI 慢时可能在模型启动前取消，测试通过却验证了另一条路径。

### 使用握手 Promise

```ts
const entered = deferred<void>();

const model = {
  complete(_request, signal) {
    entered.resolve();
    return rejectWhenAborted(signal);
  },
};

const run = runner.start();
await entered.promise;
run.cancel();
```

这里 `entered` 是可观察事实：只有 complete 真正执行，测试才继续。机器速度不影响语义。

### Deferred 要只用于测试协调

过度暴露生产内部步骤会让测试与实现耦合。优先等待公开事件、Promise 或端口调用；只有缺少可观察协议时才增加测试钩子。

---

## 7. 并发测试要主动控制完成顺序

“启动两个 Promise，然后希望快任务先结束”仍依赖 timer。更确定的做法是给每个工具一扇手动 gate：

```text
Runner 启动 slow 与 fast
        ↓
测试等待 bothStarted
        ↓
测试 resolve fastGate
        ↓
等待 fastFinished
        ↓
测试 resolve slowGate
```

配套实验验证了两个不同不变量：

1. `tool_completed` 事件按实际完成时间出现：fast → slow；
2. 回填下一轮模型的 tool messages 仍按原 call 顺序：slow → fast。

如果只断言最终输出 `done`，这两个重要顺序契约都可能悄悄坏掉。

### 事件日志是状态机测试表面

事件应该能验证：

- `seq` 严格单调；
- run_started 只出现一次且最先；
- 每个 started 有且只有一个 completed；
- finished 只出现一次且最后；
- finished outcome 与 result Promise 一致；
- 取消后不再产生新工具副作用；
- runId/step/toolCallId 始终关联正确。

但事件日志不是内部状态的任意 dump，应保持稳定领域协议。

---

## 8. 时间也是依赖

直接调用 `Date.now()` 和真实 `setTimeout` 会让测试：

- 变慢；
- 依赖机器调度；
- 难以覆盖 deadline 临界值；
- 很难验证退避序列。

至少注入：

```ts
interface Clock {
  now(): number;
}

interface Sleeper {
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}
```

测试 fake 可立即推进逻辑时间，并记录 sleep 参数。

Node test runner 也提供 mock timers，但使用时要理解：

- 哪些 timer API 被替换；
- 从模块提前解构的 timer 是否受影响；
- Promise microtask 是否需要额外 flush；
- 测试结束是否自动 restore；
- 当前 Node 版本中 API 的稳定级别。

依赖注入通常更可移植，fake timers 更适合测试直接使用 timer 的薄适配层。

---

## 9. 属性测试验证不变量，而不只验证几个例子

例子测试：

```ts
addUsage({ input: 1, output: 2 }, { input: 3, output: 4 });
```

属性测试：对大量生成值验证：

```text
结合律：add(add(a, b), c) = add(a, add(b, c))
零元：add(a, zero) = a = add(zero, a)
```

配套实验用固定 seed 的 xorshift32 生成 1000 组 TokenUsage。若失败，seed 和 sample index 可复现。

### Seed 不是完整 shrinking

成熟 property-based 框架还会把失败输入缩小成最小反例。手写生成器适合教学和简单不变量；复杂递归 schema、Unicode 或状态命令序列应考虑带 shrinker 的专用库。

### Agent 适合验证的属性

- usage 聚合非负且满足结合律；
- 事件 seq 单调且唯一；
- JSON encode/decode 保留领域事件；
- 任意非法工具参数都不触发 execute；
- 任意取消点最终只产生一次 finished；
- 并发工具反馈顺序与模型 calls 一致；
- token/step 预算永不超上限；
- 权限集合收窄后不会增加可用工具。

属性必须是业务真不变量，不能为了好写而证明无关数学性质。

---

## 10. 模糊测试要瞄准解析边界

对 `unknown → Domain` 的 parser，随机生成：

- null、boolean、number、空字符串；
- 深/宽数组；
- 缺字段、错字段、额外字段；
- 极大数、NaN、Infinity（进程内）；
- Unicode、组合字符、无效业务长度；
- 超深嵌套，验证复杂度/深度限制；
- 重复 tool call ID；
- 巨大 JSON body。

至少验证 parser：

- 不崩溃；
- 在资源预算内结束；
- 成功输出满足领域不变量；
- 失败输出大小有界；
- 不回显敏感原始输入。

Fuzz 发现一个反例后，应把最小反例加入常规回归测试。

---

## 11. 状态机测试比逐行实现测试稳定

不要断言私有字段在每一行之后的值；断言公开状态转换：

```text
idle --start--> running
running --model_final--> completed
running --abort--> cancelled
running --max_steps--> max_steps
terminal --任何事件--> 非法
```

可以生成命令序列并验证：

- terminal 状态不可再次迁移；
- run 只有一个 terminal outcome；
- step 不倒退；
- usage 只增加；
- 工具必须位于对应 model turn 内。

这样重构内部循环、队列或类结构时，测试仍围绕领域协议。

---

## 12. Snapshot 适合什么，不适合什么

适合：

- 稳定、较小、人工可审阅的公开事件；
- 生成的 JSON Schema；
- `.d.ts` 公共 API；
- 脱敏后的模型请求形状。

危险：

- 整个 SDK response；
- stack、时间戳、UUID、请求 ID；
- 数百 KB prompt；
- 不稳定属性顺序；
- 无人审阅的“更新全部 snapshot”。

Snapshot 证明“和上次一样”，不证明“语义正确”。关键字段仍应使用精确断言。

### `.d.ts` API snapshot

库项目可以对声明产物做 diff，发现：

- 导出意外消失；
- 推断泄漏巨大内部类型；
- readonly/optional 改变；
- 公共 API 引用私有模块路径。

但声明文本可能因 TS 版本变化，应固定版本并人工判断变化。

---

## 13. 供应商适配器需要 contract test

纯 fake 只能证明 Runner 按接口工作，不能证明真实 SDK 映射正确。模型适配器 contract test 应覆盖：

- 请求中的 system/user/tool messages 映射；
- JSON Schema 方言和限制；
- tool call ID/name/arguments 恢复；
- usage 缺失或分段累计；
- SSE 任意字节分块；
- `[DONE]`、EOF、半截事件；
- 429/5xx/abort/网络中断分类；
- response body 关闭；
- 供应商 request ID 提取。

### 录制响应的规则

录制真实 HTTP fixture 前必须脱敏：

- Authorization/API key；
- prompt 与用户文档；
- cookie；
- request ID 是否敏感；
- 时间戳和动态 usage。

fixture 要保留协议边界，例如原始 SSE 字节，而不是只保存已经被 SDK 解析后的理想对象，否则无法测试解析器。

### 本地假服务优于每次访问真实 API

真实 API 适合少量 smoke/E2E；日常 contract test 用本地 server 精确模拟分块、延迟、断连和状态码，速度更快且无费用。

---

## 14. LLM 非确定性不能用普通精确字符串断言

真实模型可能因采样、模型版本、服务端更新和上下文变化产生不同文本。不要把完整自然语言答案 snapshot 当主要正确性证据。

分层验证：

### 确定性软件层

- schema 合法；
- 工具调用权限；
- 预算和状态机；
- 引用/来源协议；
- PII 过滤；
- 取消和资源清理。

这些应由普通自动化测试严格断言。

### 模型行为层

- 任务成功率；
- 工具选择质量；
- groundedness；
- 拒答与安全；
- 延迟和成本分布。

使用固定数据集、多次采样、评分器与置信区间。模型评估是统计证据，不是一次 pass/fail。

### 不要让 LLM judge 成为唯一 oracle

能由程序验证的事实应程序验证，例如 JSON Schema、SQL result、引用 URL、数学结果。Judge 适合主观质量维度，并要校准偏差和一致性。

---

## 15. Node test runner 的执行模型

`node:test` 支持同步测试、返回 Promise 的异步测试和 callback 测试。异步测试必须 return/await 所有工作。

### 子测试所有权

父测试不会无条件等待所有未 await 子测试；未完成 subtest 可能被取消并记为失败。显式 await：

```ts
test("parent", async t => {
  await t.test("child", async () => {});
});
```

### 文件隔离

默认进程级隔离下，不同测试文件可在不同子进程执行。关闭隔离后，全局状态可能跨文件相互污染。不要让测试依赖文件运行顺序。

### TestContext mock

使用 `t.mock` 创建的替身会在测试结束时自动恢复，通常比全局 mock tracker 更安全。但 ESM 模块 mock 有版本和启动 flag 限制，端口注入仍是长期更稳定的架构。

### 测试结束后的异步活动

测试完成后才发生的 uncaught exception/unhandled rejection 会被 runner 报告。不要用 force exit 掩盖泄漏；找出未关闭的 server、timer、stream 或未拥有 Promise。

---

## 16. 资源清理也是断言

测试不只断言返回值，还应证明：

- AbortSignal listener 被移除；
- timer/interval 被清理；
- stream reader lock 被释放；
- HTTP response body 被取消/消费；
- server/port 关闭；
- 临时目录删除；
- AsyncLocalStorage 上下文没有串 run；
- pool lease 归还。

使用 `t.after`、`try/finally` 或 `using` 注册清理，使测试中途失败时也执行。

若必须 `--force-exit` 才能结束套件，通常说明资源所有权有缺口。

---

## 17. Coverage 不是正确性的代理

100% 行覆盖可能只跑 happy path；关键取消竞态、非法输入和不变量完全没测。反过来，防御性不可达分支可能降低行覆盖，却不代表风险更高。

更有价值的组合：

- 分支覆盖；
- 状态转换覆盖；
- mutation testing：修改条件看测试是否失败；
- 类型负向测试；
- parser fuzz；
- property test；
- 真实 adapter contract；
- 关键任务 evaluation。

Coverage 用来找“完全没执行的区域”，不用于证明行为正确。

---

## 18. CI 中的测试矩阵

库或基础设施建议至少考虑：

- 最低支持 Node 与当前 LTS；
- 最低支持 TypeScript 与当前版本；
- Linux，必要时 Windows 路径/大小写；
- ESM 与声明 emit；
- `npm pack` 后从消费者项目导入；
- strict 消费者配置；
- 测试随机 seed 记录；
- flake 重跑只用于诊断，不能把首次失败隐藏成绿色。

应用项目可缩小矩阵，但生产 runtime、CI runtime 和本地 runtime 应明确固定。

### 不要在无意中测试 node_modules 源码

审计 tsconfig include/exclude、test glob 和构建输出，避免把 `dist` 的重复测试或 fixture 当测试文件再次执行。

---

## 19. Agent Runtime 的推荐测试金字塔

```text
                 少量真实模型 E2E / evaluation
              ───────────────────────────────
               SDK adapter contract / 本地假服务
            ───────────────────────────────────
             Runner + fake model/tool 集成测试
          ───────────────────────────────────────
          状态机、parser、预算、序列化单元/属性测试
       ───────────────────────────────────────────
       TypeScript 编译期正向/负向契约 + .d.ts 检查
```

越靠下越快、越确定、定位越清楚；越靠上越接近真实集成，但更慢、更昂贵、更不稳定。不是只保留底层，而是让每层回答不同问题。

---

## 20. 生产测试检查表

- 每个静态契约是否同时有负向用例？
- unknown 边界是否包含 null、数组、缺字段和错类型？
- 非法参数是否证明未进入副作用？
- 异步测试是否用握手/事件，不用 sleep？
- 并发完成顺序是否由 gate 主动控制？
- 时间和随机性是否可注入/重放？
- 取消能否覆盖每个重要等待点？
- 状态机是否验证单一 terminal outcome？
- Schema/usage/预算是否有属性测试？
- SDK adapter 是否有原始协议 fixture？
- 真实 API 测试是否隔离费用、速率和密钥？
- LLM 质量是否使用数据集与统计指标？
- snapshot 是否小、稳定、脱敏且人工审阅？
- 测试结束是否仍有活动 handle？
- active run、listener、inflight registry、queue 和 cache byte 是否回到基线？详见[内存生命周期契约](24_memory_gc_and_leak_diagnostics.md)。
- CI 是否覆盖实际发布产物和最低版本？

---

## 21. 建议动手实验

1. 故意让 AgentRunner 的有界 worker pool 按完成顺序回填而不是写固定 index 槽位，确认第 30 课顺序测试失败。
2. 删除工具 `Schema.safeParse` 调用，确认负向边界测试和 `executeCalls` 断言失败。
3. 把属性测试 seed 改为 CLI 参数，并在失败输出中打印可复制命令。
4. 写状态命令生成器，随机在 model/tool 等待点取消，验证只出现一次 run_finished。
5. 给 retry 注入 fake clock，验证 deadline 临界值而不等待真实时间。
6. 为 SSE parser 建立随机字节分块属性：任何分块方式都恢复相同事件。
7. 构建本地 HTTP server，分别模拟 429、半截 SSE 和 socket reset。
8. 生成声明文件并在一个临时消费者 tsconfig 中验证公共 API。

## 延伸阅读

- [Node.js：Test runner](https://nodejs.org/api/test.html)
- [Node.js：Assertions](https://nodejs.org/api/assert.html)
- [TypeScript：Project References](https://www.typescriptlang.org/docs/handbook/project-references.html)
- [TypeScript：`@ts-expect-error`](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-9.html#ts-expect-error-comments)
