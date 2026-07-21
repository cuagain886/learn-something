// node:assert/strict：断言失败立刻抛 AssertionError，杜绝"忽略错误继续跑"。
import assert from 'node:assert/strict';
// node:test：提供 test/t.mock；t.mock.fn 把被注入函数包成可断言 callCount/calls 的伪函数。
import test from 'node:test';

// schema 构造器：声明式写出入参形状，运行时仍执行真正的校验逻辑。
import { object, string, transform } from './17-schema.js';
// 领域类型与 addUsage 纯函数：本文件断言"事件流顺序"和"token 累计不变量"两条独立线索。
import { addUsage, type AgentEvent, type ModelTurn, type TokenUsage } from './agent-runtime/domain.js';
// 业务侧具体工具：在"已知入口"和"动态入口"两类测试中被复用。
import { searchDocsTool, sumTool } from './agent-runtime/example-tools.js';
// 端口类型：ModelAdapter 是被注入的副作用边界，ModelRequest 是每轮请求的快照。
import type { ModelAdapter, ModelRequest } from './agent-runtime/model.js';
// AgentRunner 是被测主体；Clock 被抽出便于注入自增时钟，避免依赖 wall clock。
import { AgentRunner, type Clock } from './agent-runtime/runner.js';
// 工具注册表：invokeKnown（编译期校验）和 invokeDynamic（运行期校验）两条入口都被覆盖。
import {
  createToolRegistry,
  defineTool,
  type ToolContext,
} from './agent-runtime/tool.js';

/**
 * 第 30 课：测试 TypeScript Agent 的多层契约
 *
 * 这个文件本身由 node:test 执行。测试全部使用握手 Promise、注入端口和确定性伪随机数，
 * 不依赖 sleep 猜测异步是否“差不多完成”，所以即使机器变慢也不会产生时间型 flaky。
 */

// ---------------------------------------------------------------------------
// 测试基础设施：用 Deferred 把异步时序交到测试手里
// ---------------------------------------------------------------------------
// 核心想法是"测试不靠延时"：被测进入阻塞点时 resolve 一个握手 Promise，
// 测试 await 它就能确定地推进到下一步——无论机器快慢都不 flaky。

// Deferred 把 Promise 的 resolve/reject 控制器外移，让外部决定它何时落定。
type Deferred<Value> = {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (cause: unknown) => void;
};

// deferred() 构造一个尚未落定的 Promise 并交出控制器。
// `let resolve!:` 的 definite assignment 表示构造器内一定会赋值，外部通过闭包持有。
function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// 所有 controlledTool 共享同一个最小 schema：只校验 value 是字符串。
const controlledInputSchema = object({ value: string() });

// controlledTool：构造一个"执行时序可控"的工具。
//   gate：决定 execute 何时返回；只有外部 resolve gate，工具才完成。
//   finished：工具读到 gate 后用它通知测试"我已把结果送回"。
//   onStarted：execute 一进入就触发，用来证明并发确实打开了。
function controlledTool<const Name extends string>(
  name: Name,
  gate: Deferred<string>,
  finished: Deferred<void>,
  onStarted: () => void,
) {
  return defineTool({
    name,
    description: `${name} controlled test tool`,
    inputSchema: controlledInputSchema,
    async execute(input) {
      onStarted();
      const suffix = await gate.promise;
      finished.resolve(undefined);
      return `${input.value}:${suffix}`;
    },
  });
}

// ---------------------------------------------------------------------------
// 契约一：并发工具的"完成顺序"与"回填顺序"是两条独立轨道
// ---------------------------------------------------------------------------
// 验证两个互不耦合的不变量：
//   1) 事件流里 tool_completed 按真实完成顺序（fast_tool 在前）。
//   2) 反馈给模型的 tool 消息按 tool_calls 的原始顺序（slow_tool 在前）。
// 解耦原因：事件流描述运行时观察事实，模型上下文必须稳定可重放。
test('并发工具按实际完成顺序发事件，但按模型调用顺序回填消息', async (t) => {
  // 两套握手 (gate + finished)，分别控制 slow/fast 的开始与结束时机。
  const slowGate = deferred<string>();
  const fastGate = deferred<string>();
  const slowFinished = deferred<void>();
  const fastFinished = deferred<void>();
  // bothStarted：两个工具都已进入 execute，证明 maxToolConcurrency=2 真的并发了。
  const bothStarted = deferred<void>();
  let startedCount = 0;
  const markStarted = () => {
    startedCount += 1;
    if (startedCount === 2) bothStarted.resolve(undefined);
  };

  const slowTool = controlledTool('slow_tool', slowGate, slowFinished, markStarted);
  const fastTool = controlledTool('fast_tool', fastGate, fastFinished, markStarted);
  // `as const` 锁定工具名联合类型，让 invokeKnown 在编译期知道合法工具集合。
  const registry = createToolRegistry([slowTool, fastTool] as const);

  // secondRequest：捕获第二轮请求快照，事后用它断言 tool 消息顺序。
  let secondRequest: ModelRequest | undefined;
  // t.mock.fn：被注入的伪函数可断言 callCount 等，作用域只在本 test 内。
  const complete = t.mock.fn(async (request: ModelRequest): Promise<ModelTurn> => {
    if (request.step === 1) {
      // 第一轮：要求并行调用 slow 与 fast，调用顺序为 slow → fast。
      return {
        kind: 'tool_calls',
        calls: [
          { id: 'slow_1', name: 'slow_tool', arguments: { value: 'S' } },
          { id: 'fast_1', name: 'fast_tool', arguments: { value: 'F' } },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }

    // 第二轮：模型已收到工具结果，给出最终文本；同时把请求快照留下供断言。
    secondRequest = request;
    return {
      kind: 'final',
      text: 'done',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });

  // 注入 incrementingClock 让事件时间戳是确定性的 10001、10002、...
  const runner = new AgentRunner({
    model: { complete },
    tools: registry,
    clock: incrementingClock(),
    createRunId: () => 'run_concurrency_contract',
  });
  const run = runner.start('test ordering', { maxToolConcurrency: 2 });
  const eventsPromise = collect(run.events);

  // 等两个工具都进入 execute 后再依次 resolve：fast 先完成、slow 后完成，
  // 故意制造"完成顺序与调用顺序相反"的反例，用来检验回填顺序不被完成顺序带偏。
  await bothStarted.promise;
  fastGate.resolve('fast-result');
  await fastFinished.promise;
  slowGate.resolve('slow-result');
  await slowFinished.promise;

  const outcome = await run.result;
  const events = await eventsPromise;
  // 契约：run 顺利结束，且模型恰好被调用两次（一轮 tool_calls，一轮 final）。
  assert.equal(outcome.status, 'completed');
  assert.equal(complete.mock.callCount(), 2);

  // 不变量一：事件流里 tool_completed 按真实完成顺序——fast_tool 在前。
  const completionOrder = events
    .filter((event) => event.type === 'tool_completed')
    .map((event) => event.call.name);
  assert.deepEqual(completionOrder, ['fast_tool', 'slow_tool']);

  // 不变量二：第二轮请求里 tool 消息按调用顺序——slow_tool 在前。
  const capturedRequest = secondRequest as ModelRequest | undefined;
  assert.ok(capturedRequest, '第二轮模型请求必须存在');
  const feedbackOrder = capturedRequest.messages
    .filter((message) => message.role === 'tool')
    .map((message) => message.toolName);
  assert.deepEqual(feedbackOrder, ['slow_tool', 'fast_tool']);
});

// ---------------------------------------------------------------------------
// 契约二：取消传播必须基于真实握手，而不是"差不多开始"的延时猜测
// ---------------------------------------------------------------------------
// 验证：模型正在 await Promise 中阻塞时，run.cancel 能让 complete 立刻 reject，
// 并把最终 outcome 变成 cancelled。关键是不用 setTimeout(10) 猜模型是否启动——
// 只有 complete 真正进入函数体后才推进，保证取消信号一定能命中 abort listener。
test('用显式握手等待模型真正进入阻塞点，再验证取消传播', async () => {
  // enteredModel：complete 一被调用就 resolve，握手证明"我已经到阻塞点"。
  const enteredModel = deferred<void>();
  const model: ModelAdapter = {
    complete(_request, signal): Promise<ModelTurn> {
      enteredModel.resolve(undefined);
      // 这条 Promise 永不主动 resolve，只在 AbortSignal 触发时 reject。
      return new Promise<ModelTurn>((_resolve, reject) => {
        if (signal.aborted) {
          // 已被取消（race 场景）就直接 reject，避免泄漏 listener。
          reject(signal.reason);
          return;
        }
        // 注册一次性的 abort listener；signal.reason 是取消原因（Error 对象）。
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };

  const registry = createToolRegistry([sumTool, searchDocsTool] as const);
  const runner = new AgentRunner({
    model,
    tools: registry,
    clock: incrementingClock(),
    createRunId: () => 'run_handshake_cancel',
  });
  const run = runner.start('wait forever');
  const eventsPromise = collect(run.events);

  // 不用 setTimeout(10) 猜模型是否启动；只有 complete 已执行，握手才会完成。
  await enteredModel.promise;
  // 此时模型确实在 await Promise 中阻塞，取消信号能直接命中 abort listener。
  run.cancel({ code: 'TEST_CANCEL' });

  const outcome = await run.result;
  const events = await eventsPromise;
  // 契约一：outcome 是 cancelled（而非 completed/error），原因透传到 status。
  assert.equal(outcome.status, 'cancelled');
  // 契约二：事件流以 run_finished 结尾，证明关闭流程被确定性触发。
  assert.equal(events.at(-1)?.type, 'run_finished');
});

// ---------------------------------------------------------------------------
// 契约三：动态入口对 unknown 必须在 schema 层过滤，绝不污染 execute
// ---------------------------------------------------------------------------
// invokeDynamic 的入参类型是 unknown（LLM 输出本质不可信）。本 test 用表驱动覆盖
// 各种非法形状，断言它们都返回 ok=false 且 execute 一次都不被调用——
// executeCalls 的唯一一次自增只能来自那个合法 case。
test('动态工具边界对 unknown 做表驱动测试，非法值绝不进入 execute', async () => {
  // executeCalls 是观察点：执行了 execute 等于"边界被穿透"。
  let executeCalls = 0;
  const queryTool = defineTool({
    name: 'query',
    description: 'query documents',
    // transform 再做一层 trim/lowercase，证明即便有后处理，schema 校验仍先发生。
    inputSchema: transform(
      object({ query: string() }),
      (input) => ({ query: input.query.trim().toLowerCase() }),
    ),
    async execute(input) {
      executeCalls += 1;
      return { normalized: input.query };
    },
  });
  const registry = createToolRegistry([queryTool] as const);
  const context = testToolContext();

  // 表驱动用例：从 null、数组、缺字段、错误标量到合法字符串，覆盖常见 LLM 误用。
  const cases: readonly {
    readonly label: string;
    readonly raw: unknown;
    readonly expectedOk: boolean;
  }[] = [
    { label: 'null', raw: null, expectedOk: false },
    { label: 'array', raw: [], expectedOk: false },
    { label: 'missing key', raw: {}, expectedOk: false },
    { label: 'wrong scalar', raw: { query: 42 }, expectedOk: false },
    { label: 'valid', raw: { query: '  TypeScript  ' }, expectedOk: true },
  ];

  for (const item of cases) {
    const result = await registry.invokeDynamic('query', item.raw, context);
    // 每个 case 单独断言 ok；label 作为消息便于失败时定位具体行。
    assert.equal(result.ok, item.expectedOk, item.label);
  }
  // 不变量：4 个非法用例不应触发 execute；只允许 1 个合法用例进入。
  assert.equal(executeCalls, 1);
});

// ---------------------------------------------------------------------------
// 契约四：TokenUsage 的"+"在代数上是幺半群（结合律 + 零元）
// ---------------------------------------------------------------------------
// 属性测试：随机生成 1000 组三元组 (left, middle, right)，断言：
//   1) (a+b)+c === a+(b+c)：累计顺序无关，多步聚合不会"先后影响结果"。
//   2) a+zero === a 和 zero+a === a：零 usage 不影响累计，便于"空开始/空结束"边界。
// 用固定 seed 的 xorshift32 让失败可复现——报错信息会带 seed 与 sample 序号。
test('TokenUsage 满足结合律与零元：确定性属性测试会打印可复现 seed', () => {
  const seed = 0x5eed_2026;
  const random = xorshift32(seed);
  // zero：两路都为 0 的 TokenUsage，作为幺半群的单位元。
  const zero: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  for (let sample = 0; sample < 1_000; sample += 1) {
    const left = randomUsage(random);
    const middle = randomUsage(random);
    const right = randomUsage(random);

    // 结合律失败信息带 seed+sample，便于按原顺序复现。
    assert.deepEqual(
      addUsage(addUsage(left, middle), right),
      addUsage(left, addUsage(middle, right)),
      `结合律失败，seed=${seed}，sample=${sample}`,
    );
    assert.deepEqual(addUsage(left, zero), left, `右零元失败，seed=${seed}`);
    assert.deepEqual(addUsage(zero, left), left, `左零元失败，seed=${seed}`);
  }
});

// xorshift32：极简确定性 PRNG。状态在闭包里，每次调用吐出一个 uint32。
// 关键性质是"同 seed 必出同序列"，这正是属性测试可复现的基础。
function xorshift32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

// randomUsage：把 PRNG 输出收敛到 [0, 100_000) 区间，避免极大数掩盖实现 bug。
function randomUsage(random: () => number): TokenUsage {
  return {
    inputTokens: random() % 100_000,
    outputTokens: random() % 100_000,
  };
}

// incrementingClock：每次 now() 自增，返回 10001、10002、...，保证事件时间戳可比且唯一。
// 替代 Date.now() 是为了让断言不依赖真实时钟、也不受系统时间跳变影响。
function incrementingClock(): Clock {
  let now = 10_000;
  return { now: () => ++now };
}

// testToolContext：构造一个最小合法的 ToolContext，供 invokeDynamic 测试使用。
// signal 来自全新 AbortController（不会被外部 abort）；权限仅授予 docs:read。
function testToolContext(): ToolContext {
  return {
    runId: 'run_test',
    step: 1,
    callId: 'call_test',
    signal: new AbortController().signal,
    grantedPermissions: new Set(['docs:read']),
  };
}

// collect：把 async iterable 的事件流收成数组，便于事后按 type 过滤、按顺序断言。
async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

// 编译期契约与运行时测试是两条独立证据链。下面的分支不会执行，但 tsc 必须检查它。
const typeContractRegistry = createToolRegistry([sumTool, searchDocsTool] as const);
if (false) {
  // 合法调用：values 是 number[]，名字存在于注册表；这条调用编译通过、永不执行。
  void typeContractRegistry.invokeKnown('sum', { values: [1, 2] }, testToolContext());

  // @ts-expect-error sum 的 values 只接受 number[]；若 API 意外变宽，本行会让 typecheck 失败。
  void typeContractRegistry.invokeKnown('sum', { values: ['not a number'] }, testToolContext());

  // @ts-expect-error 已知工具入口拒绝注册表中不存在的名字。
  void typeContractRegistry.invokeKnown('missing_tool', {}, testToolContext());
}
