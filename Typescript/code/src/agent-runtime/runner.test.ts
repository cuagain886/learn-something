// runner.test.ts：运行时行为测试（node:test runner）。
//
// 覆盖目标：
//   - happy path（双工具并发、usage 累加、事件顺序）；
//   - 协议安全（INVALID_ARGUMENTS 带 JSON Pointer / FORBIDDEN 不泄漏字段 issue）；
//   - 状态机终止（max_steps / cancelled / failed）；
//   - worker pool 并发上限与回填顺序；
//   - AsyncQueue 单消费者协议。
//
// 测试不依赖真实 LLM：用内联 ModelAdapter / DeterministicModel 注入，让所有路径完全确定性。
import assert from 'node:assert/strict';
import test from 'node:test';

import { literal, object, union } from '../17-schema.js';
import { AsyncQueue } from './async-queue.js';
import type {
  AgentEvent,
  JsonValue,
  ModelTurn,
} from './domain.js';
import { searchDocsTool, sumTool } from './example-tools.js';
import { DeterministicModel } from './mock-model.js';
import {
  ModelProtocolError,
  type ModelAdapter,
  type ModelRequest,
} from './model.js';
import {
  AgentRunner,
  DuplicateToolCallIdError,
  ToolCallLimitError,
  type Clock,
} from './runner.js';
import {
  createToolRegistry,
  defineTool,
  type ToolContext,
} from './tool.js';

// 全局共享的注册表：sum 无权限，search_docs 需 'docs:read'。
// 大多数测试用例复用这个 registry；个别测试（如 gate / unsafe_output）单独构造。
const registry = createToolRegistry([sumTool, searchDocsTool] as const);

/**
 * Test 1：完整 happy path。
 *
 * 验证点：
 *   - outcome.status === 'completed'，steps === 2（第一步工具 + 第二步 final）；
 *   - usage 累加 = 12+20 input / 8+10 output，证明 addUsage 把两轮都算上；
 *   - 事件 seq 严格从 1 递增到 length（顺序正确，没有跳号或回退）；
 *   - 工具完成事件恰好 2 条（sum + search_docs）；
 *   - 最后一条事件是 run_finished。
 */
test('完整运行：校验模型 turn，授权并发工具，并累计安全整数 usage', async () => {
  const runner = createRunner(new DeterministicModel(), 'run_success');
  const run = runner.start('demo', {
    grantedPermissions: new Set(['docs:read']),
  });
  // 并行收集事件：与 await run.result 同时进行，模拟真实观察者。
  const eventsPromise = collect(run.events);

  const outcome = await run.result;
  const events = await eventsPromise;

  assert.equal(outcome.status, 'completed');
  // 类型收窄守卫：让后续访问 outcome.text/steps/usage 在 TS 层面合法。
  if (outcome.status !== 'completed') return;

  assert.equal(outcome.steps, 2);
  assert.equal(outcome.usage.inputTokens, 32);
  assert.equal(outcome.usage.outputTokens, 18);
  // final 文本必须包含 sum=6，证明 sum 工具被正确执行并把结果回到模型。
  assert.match(outcome.text, /sum=6/u);
  // seq 自增检查：events[i].seq === i+1，即从 1 开始连续。
  assert.deepEqual(
    events.map((event) => event.seq),
    Array.from({ length: events.length }, (_, index) => index + 1),
  );
  // 两个工具各产生一条 tool_completed 事件，证明并发调度跑完两个工具。
  assert.equal(events.filter((event) => event.type === 'tool_completed').length, 2);
  // 最后一条必须是 run_finished——确保事件流以终态结束。
  assert.equal(events.at(-1)?.type, 'run_finished');
});

/**
 * Test 2：非法工具参数被 schema 拒绝，形成带 JSON Pointer 的结构化错误，且不进入 execute。
 *
 * 关键点：
 *   - sum 的 values 数组第 1 位是字符串 'two'，会被 inputSchema 拒绝；
 *   - 错误进入 tool message（isError=true），模型在第 2 步可见 'INVALID_ARGUMENTS'；
 *   - 错误 issue 的 pointer 是 '/values/1'，能精确定位到字段+下标。
 */
test('非法工具参数形成带 JSON Pointer 的结构化错误，且不进入 execute', async () => {
  // 内联模型：第 1 步故意传错参；第 2 步根据“是否有错误回填”选择不同 final 文本。
  const model: ModelAdapter = {
    async complete(request): Promise<ModelTurn> {
      if (request.step === 1) {
        return {
          kind: 'tool_calls',
          calls: [{ id: 'bad_1', name: 'sum', arguments: { values: [1, 'two'] } }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }

      // 检查上一轮的 tool message 是否回填了 INVALID_ARGUMENTS——
      // 这是“错误信息是否回到模型 prompt”的关键断言。
      const errorWasReturned = request.messages.some(
        (message) => message.role === 'tool'
          && message.isError
          && message.content.includes('INVALID_ARGUMENTS'),
      );
      return {
        kind: 'final',
        text: errorWasReturned ? '模型收到参数错误' : '错误未回填',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };

  const run = createRunner(model, 'run_invalid').start('demo');
  const eventsPromise = collect(run.events);
  const outcome = await run.result;
  const events = await eventsPromise;

  assert.equal(outcome.status, 'completed');
  // 文本是“模型收到参数错误”——证明错误已回填，模型在第 2 步能看见。
  if (outcome.status === 'completed') assert.equal(outcome.text, '模型收到参数错误');

  // 找到那条 tool_completed，断言它是 INVALID_ARGUMENTS 且 pointer 指向 /values/1。
  const toolCompleted = events.find((event) => event.type === 'tool_completed');
  assert.ok(toolCompleted?.type === 'tool_completed');
  assert.equal(toolCompleted.result.ok, false);
  if (!toolCompleted.result.ok) {
    assert.equal(toolCompleted.result.error.code, 'INVALID_ARGUMENTS');
    if (toolCompleted.result.error.code === 'INVALID_ARGUMENTS') {
      // JSON Pointer '/values/1' 精确定位到数组下标——这是 17-schema.ts 提供的能力。
      assert.equal(toolCompleted.result.error.issues[0]?.pointer, '/values/1');
    }
  }
});

/**
 * Test 3：权限检查先于参数解析，未授权请求不泄漏字段级校验结果。
 *
 * 故意让模型同时触发两条失败：
 *   - search_docs 缺权限（应该被 FORBIDDEN 拒绝）；
 *   - query=42 类型错（如果走到 parse 阶段就会触发 INVALID_ARGUMENTS）。
 *
 * 期望：最终回填给模型的是 FORBIDDEN，而不是 INVALID_ARGUMENTS。
 * 这是反“权限探测”的关键不变量——模型不能通过反复试探推断字段定义。
 */
test('权限检查先于参数解析：未授权请求不会泄漏字段级校验结果', async () => {
  // feedback：捕获第 2 步看到的 tool message content，用于做“什么被泄露了”的断言。
  let feedback = '';
  const model: ModelAdapter = {
    async complete(request): Promise<ModelTurn> {
      if (request.step === 1) {
        return {
          kind: 'tool_calls',
          calls: [{
            id: 'forbidden_1',
            name: 'search_docs',
            arguments: { query: 42, limit: 100 },
          }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      // 第 2 步：把所有 tool 消息的内容拼起来，看模型到底“看见”了什么。
      feedback = request.messages
        .filter((message) => message.role === 'tool')
        .map((message) => message.content)
        .join('\n');
      return {
        kind: 'final',
        text: 'handled',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };

  // 注意：这里没传 grantedPermissions，因此 search_docs 缺 'docs:read' 权限。
  const run = createRunner(model, 'run_forbidden').start('demo');
  const eventsPromise = collect(run.events);
  const outcome = await run.result;
  const events = await eventsPromise;

  assert.equal(outcome.status, 'completed');
  // 正向断言：模型看到了 FORBIDDEN。
  assert.match(feedback, /FORBIDDEN/u);
  // 反向断言：模型没有看到 INVALID_ARGUMENTS、权限名 'docs:read'、字段名 'query'——
  // 这是反探测安全策略的核心证明。
  assert.doesNotMatch(feedback, /INVALID_ARGUMENTS|docs:read|query/u);
  const completed = events.find((event) => event.type === 'tool_completed');
  assert.ok(completed?.type === 'tool_completed' && !completed.result.ok);
  if (completed?.type === 'tool_completed' && !completed.result.ok) {
    assert.equal(completed.result.error.code, 'FORBIDDEN');
  }
});

/**
 * Test 4：工具输出即使静态满足 JsonValue，运行时也要拒绝 NaN / 循环 / getter。
 *
 * 这个测试是“为什么需要 validateJsonValue”的最佳说明：
 *   - return Number.NaN 在 TS 层面是合法的 JsonValue（number）；
 *   - output['self'] = output 在 TS 层面也合法；
 *   - getter 通过 Object.defineProperty 定义后，TS 看不见它的副作用。
 * 三种情况都应在工具层被 INVALID_OUTPUT 拒绝，绝不让它进入 tool message。
 */
test('工具输出即使静态满足 JsonValue，也要拒绝 NaN、循环和 getter', async () => {
  // getterCalls：用来证明 validateJsonValue 不执行不可信 getter——
  // 如果验证器用普通 JSON.stringify 跑，会调一次 getter，这个计数会非零。
  let getterCalls = 0;
  const unsafeOutputTool = defineTool({
    name: 'unsafe_output',
    description: '构造静态类型无法排除的非法 JSON 输出',
    inputSchema: object({
      kind: union(literal('nan'), literal('cycle'), literal('getter')),
    }),
    async execute(input): Promise<JsonValue> {
      if (input.kind === 'nan') return { value: Number.NaN };
      const output: Record<string, JsonValue> = {};
      if (input.kind === 'cycle') {
        // 自引用：JSON.stringify 会报 TypeError；validateJsonValue 也要拒绝。
        output['self'] = output;
        return output;
      }
      // getter：JSON.stringify 会调用 getter（执行不可信代码）；validateJsonValue 应识别 descriptor。
      Object.defineProperty(output, 'value', {
        enumerable: true,
        get() {
          getterCalls += 1;
          return 1;
        },
      });
      return output;
    },
  });
  const unsafeRegistry = createToolRegistry([unsafeOutputTool] as const);
  // 共享一个空的 ToolContext：测试中不需要授权，也不需要真实 signal。
  const context = testToolContext();

  // 三种非法输出轮流测，每种都必须 ok=false + INVALID_OUTPUT。
  for (const kind of ['nan', 'cycle', 'getter'] as const) {
    const result = await unsafeRegistry.invokeDynamic(
      'unsafe_output',
      { kind },
      context,
    );
    assert.equal(result.ok, false, kind);
    if (!result.ok) assert.equal(result.error.code, 'INVALID_OUTPUT');
  }
  // 关键不变量：getter 从未被调用——验证器只读 descriptor，不读 value。
  assert.equal(getterCalls, 0, '验证器必须检查 descriptor，不能执行不可信 getter');
});

/**
 * Test 5：不符合 normalized ModelTurn 的返回值在状态机入口就被拒绝。
 *
 * 故意让模型返回 calls=[] 且 usage.inputTokens=-1，两者都违反 schema。
 * parseModelTurn 会抛 ModelProtocolError；Runner 把它转成 'failed' outcome，
 * 且事件流里不应该出现 model_completed（在发出之前就抛了）。
 */
test('不符合 normalized ModelTurn 的返回值在状态机入口被拒绝', async () => {
  const invalidModel: ModelAdapter = {
    async complete() {
      return {
        kind: 'tool_calls',
        // 空 calls：minItems:1 拦截；inputTokens=-1：minimum:0 拦截。两条都触发 schema 失败。
        calls: [],
        usage: { inputTokens: -1, outputTokens: 0 },
      };
    },
  };

  const run = createRunner(invalidModel, 'run_bad_protocol').start('demo');
  const eventsPromise = collect(run.events);
  const outcome = await run.result;
  const events = await eventsPromise;

  assert.equal(outcome.status, 'failed');
  // cause 必须是 ModelProtocolError——证明是 parse 阶段拒绝的，不是其它运行时错。
  if (outcome.status === 'failed') assert.ok(outcome.cause instanceof ModelProtocolError);
  // 反向证明：model_completed 没有发出（在 push 之前就抛了）。
  assert.equal(events.some((event) => event.type === 'model_completed'), false);
  // 自然也没有 tool_started——状态机从未推进到工具调度。
  assert.equal(events.some((event) => event.type === 'tool_started'), false);
});

/**
 * Test 6：单轮工具调用数量有硬上限，超限时一个工具也不启动。
 *
 * 故意把 maxToolCallsPerTurn 设为 1，模型却请求 2 个 sum 工具。
 * 期望：抛 ToolCallLimitError，事件流里没有任何 tool_started。
 */
test('单轮工具调用数量有硬上限，超限时一个工具也不启动', async () => {
  const model: ModelAdapter = {
    async complete(): Promise<ModelTurn> {
      return {
        kind: 'tool_calls',
        calls: [
          { id: 'limit_1', name: 'sum', arguments: { values: [1] } },
          { id: 'limit_2', name: 'sum', arguments: { values: [2] } },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };

  const run = createRunner(model, 'run_call_limit').start('demo', {
    maxToolCallsPerTurn: 1,
  });
  const eventsPromise = collect(run.events);
  const outcome = await run.result;
  const events = await eventsPromise;

  assert.equal(outcome.status, 'failed');
  if (outcome.status === 'failed') assert.ok(outcome.cause instanceof ToolCallLimitError);
  // 关键不变量：超限检查发生在调用工具之前，所以不会有任何 tool_started 事件。
  assert.equal(events.some((event) => event.type === 'tool_started'), false);
});

/**
 * Test 7：tool call id 在整个 run 内唯一，跨轮复用会在第二次执行前失败。
 *
 * 模型每轮都用 'reused_id'。第 1 轮成功；第 2 轮触发 DuplicateToolCallIdError。
 * 期望：outcome.failed，且只有 1 条 tool_completed（第 2 轮的执行前校验拦截了它）。
 */
test('tool call id 在整个 run 内唯一，跨轮复用会在第二次执行前失败', async () => {
  const model: ModelAdapter = {
    async complete(request): Promise<ModelTurn> {
      return {
        kind: 'tool_calls',
        calls: [{
          // 故意用固定 id，不复用 request.step——这样第 1 轮和第 2 轮 id 都相同。
          id: 'reused_id',
          name: 'sum',
          arguments: { values: [request.step] },
        }],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };

  const run = createRunner(model, 'run_duplicate_id').start('demo');
  const eventsPromise = collect(run.events);
  const outcome = await run.result;
  const events = await eventsPromise;

  assert.equal(outcome.status, 'failed');
  if (outcome.status === 'failed') {
    assert.ok(outcome.cause instanceof DuplicateToolCallIdError);
  }
  // 第 1 轮成功了，所以有 1 条 tool_completed；第 2 轮在执行前抛错，没机会产生。
  assert.equal(events.filter((event) => event.type === 'tool_completed').length, 1);
});

/**
 * Test 8：worker pool 限制在途工具数，且按原调用顺序回填。
 *
 * 用 gate 工具 + release/deferred 人为卡住 worker：
 *   - maxToolConcurrency=2，但模型请求 3 个 gate 工具；
 *   - 第 1、2 个 worker 立刻开始（started=['gate_1','gate_2']），第 3 个被排队；
 *   - release 后第 3 个才开始（started 追加 'gate_3'）；
 *   - 最终 tool messages 必须按 [gate_1, gate_2, gate_3] 原顺序回填到下一轮请求。
 */
test('有界 worker pool 限制在途工具数，并按原调用顺序回填结果', async () => {
  // deferred：手写 Promise 控制——release.resolve 之后 worker 才会往下走。
  const release = deferred<void>();
  const twoStarted = deferred<void>();
  const started: string[] = [];
  const gateTool = defineTool({
    name: 'gate',
    description: '用于观察并发上限',
    inputSchema: object({}),
    async execute(_input, context) {
      // 记录自己已启动；第 2 个 worker 启动时解开 twoStarted，让外部断言可以触发。
      started.push(context.callId);
      if (started.length === 2) twoStarted.resolve(undefined);
      // 阻塞在 release 上，模拟长工具调用。
      await release.promise;
      return { callId: context.callId };
    },
  });
  const gateRegistry = createToolRegistry([gateTool] as const);
  // secondRequest：捕获第 2 轮的 ModelRequest，用来断言 tool messages 的顺序。
  let secondRequest: ModelRequest | undefined;
  const model: ModelAdapter = {
    async complete(request): Promise<ModelTurn> {
      if (request.step === 1) {
        return {
          kind: 'tool_calls',
          // 同时请求 3 个工具——超出 maxToolConcurrency=2，第 3 个会被排队。
          calls: [1, 2, 3].map((id) => ({
            id: `gate_${id}`,
            name: 'gate',
            arguments: {},
          })),
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      // 第 2 轮：记录请求，给个 final 让 Run 收尾。
      secondRequest = request;
      return {
        kind: 'final',
        text: 'done',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const runner = new AgentRunner({
    model,
    tools: gateRegistry,
    clock: incrementingClock(),
    createRunId: () => 'run_bounded_pool',
  });
  const run = runner.start('demo', { maxToolConcurrency: 2 });
  const eventsPromise = collect(run.events);

  // 等“前 2 个 worker 已启动”——此时第 3 个还没开始（并发上限为 2）。
  await twoStarted.promise;
  // 关键断言：只有 gate_1/gate_2 在 started 中，gate_3 还在排队。
  assert.deepEqual(started, ['gate_1', 'gate_2']);
  // 解开 release：3 个 worker 全部往下走，gate_3 也开始。
  release.resolve(undefined);

  const outcome = await run.result;
  await eventsPromise;
  assert.equal(outcome.status, 'completed');
  // release 后 3 个工具全部执行完——证明 worker pool 最终把所有任务跑完。
  assert.deepEqual(started, ['gate_1', 'gate_2', 'gate_3']);
  // 关键断言：尽管 worker 并发执行顺序不定，回填给模型的 tool messages 必须是原调用顺序。
  const captured = secondRequest as ModelRequest | undefined;
  assert.ok(captured);
  assert.deepEqual(
    captured.messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.toolCallId),
    ['gate_1', 'gate_2', 'gate_3'],
  );
});

/**
 * Test 9：取消从 AgentRun 传播到正在等待的模型调用。
 *
 * 模型在 complete 内挂起（监听 signal 的 abort），等待外部取消。
 * 调用 run.cancel 后：信号传播到模型，模型 reject，Runner 把 outcome 转成 cancelled。
 */
test('取消从 AgentRun 传播到正在等待的模型调用', async () => {
  // blockingModel：进入 complete 后挂起，直到 signal abort 才 reject——
  // 这模拟“长 LLM 调用被中途取消”的真实场景。
  const blockingModel: ModelAdapter = {
    complete(_request: ModelRequest, signal: AbortSignal): Promise<unknown> {
      return new Promise<unknown>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };

  const run = createRunner(blockingModel, 'run_cancelled').start('demo');
  const eventsPromise = collect(run.events);
  // 调用 cancel：触发 controller.abort，信号一路传到模型。
  run.cancel('test requested cancellation');

  const outcome = await run.result;
  const events = await eventsPromise;

  assert.equal(outcome.status, 'cancelled');
  if (outcome.status === 'cancelled') {
    // reason 透传：用户传给 cancel() 的字符串原样到达 outcome。
    assert.equal(outcome.reason, 'test requested cancellation');
  }
  // 事件流仍然以 run_finished 收尾——即使是 cancelled 也会发出终止事件。
  assert.equal(events.at(-1)?.type, 'run_finished');
});

/**
 * Test 10：模型持续请求工具时由 maxSteps 明确终止。
 *
 * loopingModel 永远返回 tool_calls，永远不给 final。
 * maxSteps=2 让 Run 在第 2 步之后明确归一为 'max_steps' outcome——
 * 而不是无限循环或默默 truncate。
 */
test('模型持续请求工具时由 maxSteps 明确终止', async () => {
  const loopingModel: ModelAdapter = {
    async complete(request): Promise<ModelTurn> {
      return {
        kind: 'tool_calls',
        calls: [{
          // 每轮 id 不同（带 step），避免触发 DuplicateToolCallIdError 提前失败。
          id: `call_${request.step}`,
          name: 'sum',
          arguments: { values: [request.step] },
        }],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };

  const run = createRunner(loopingModel, 'run_max_steps').start('demo', { maxSteps: 2 });
  const eventsPromise = collect(run.events);
  const outcome = await run.result;
  await eventsPromise;

  assert.equal(outcome.status, 'max_steps');
  // steps 恰好等于 maxSteps——证明“循环用完了所有步骤”。
  assert.equal(outcome.steps, 2);
});

/**
 * Test 11：AsyncQueue 单消费者协议；观察者提前退出（for-await break）不会取消 Run。
 *
 * 两部分：
 *   1) 直接测队列原语——第二次取 [Symbol.asyncIterator] 应抛；push/close/next 顺序正确；
 *   2) 测 Runner 的事件流——只消费一条事件就 break 后，Run 应当继续跑完到 completed。
 */
test('AsyncQueue 明确执行单消费者协议，观察者提前退出不会取消 Run', async () => {
  const queue = new AsyncQueue<number>();
  const iterator = queue[Symbol.asyncIterator]();
  // 单消费者协议：第二次取 asyncIterator 必须抛错（消息验证文案匹配）。
  assert.throws(
    () => queue[Symbol.asyncIterator](),
    /只支持一个事件消费者/u,
  );
  queue.push(1);
  queue.close();
  // push 之后再 next：能拿到值；再 next：close 后返回 done=true。
  assert.deepEqual(await iterator.next(), { done: false, value: 1 });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });

  // 与 Runner 集成：故意在第一条事件（run_started）就 break——
  // 这会触发 AsyncQueue.return()，让观察者脱离；但 Run 不受影响。
  const run = createRunner(new DeterministicModel(), 'run_detached_observer').start(
    'demo',
    { grantedPermissions: new Set(['docs:read']) },
  );
  for await (const event of run.events) {
    assert.equal(event.type, 'run_started');
    break;
  }
  // 关键不变量：观察者提前退出 ≠ 取消 Run。outcome 仍然应该是 completed。
  const outcome = await run.result;
  assert.equal(outcome.status, 'completed');
});

/**
 * createRunner：所有 happy/异常测试共享的 Runner 工厂。
 *
 * 关键设计：
 *   - 用同一个全局 registry（sum + search_docs），保持“测试在工具集上的一致性”；
 *   - 注入 incrementingClock：让事件 at 字段可断言（不用等墙钟）；
 *   - createRunId 注入固定值，便于日志和断言。
 *
 * 返回类型 AgentRunner<typeof registry.tools> 让调用方能拿到精确泛型实例。
 */
function createRunner(
  model: ModelAdapter,
  runId: string,
): AgentRunner<typeof registry.tools> {
  return new AgentRunner({
    model,
    tools: registry,
    clock: incrementingClock(),
    createRunId: () => runId,
  });
}

/**
 * incrementingClock：每次 now() 返回递增整数。
 *
 * 让测试不依赖墙钟：
 *   - 事件 at 字段顺序 = 事件产生顺序，断言时可以直接比对；
 *   - 不存在“两次调用拿到相同时间戳”的偶发问题。
 */
function incrementingClock(): Clock {
  let now = 1_000;
  return { now: () => ++now };
}

/**
 * testToolContext：构造一个最小可用的 ToolContext，用于直接 invoke 工具的测试（Test 4）。
 *
 * 故意用空 Set 作为 grantedPermissions——测试期望的就是“无权限”场景。
 */
function testToolContext(): ToolContext {
  return {
    runId: 'run_test',
    step: 1,
    callId: 'call_test',
    signal: new AbortController().signal,
    grantedPermissions: new Set(),
  };
}

/**
 * Deferred：暴露 resolve 的 Promise——测试用它能“等一个未来事件”或“解开一个卡点”。
 *
 * 让“测试代码”能从外部控制异步流的进度，是写并发测试的标准技巧。
 */
type Deferred<Value> = {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
};

/**
 * deferred：Deferred 工厂。
 *
 * 利用了 TS 的 definite assignment（let resolve!: ...）：Promise 构造器同步执行，
 * resolve 一定会在 return 之前被赋值，所以非空断言是安全的。
 */
function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/**
 * collect：把整个事件流读到一个数组，返回 Promise。
 *
 * 调用方在 await run.result 之前先调 collect(run.events) 拿到 promise，
 * 然后并行 await 两个 promise——这样既能拿到完整事件序列，又能拿到终态 outcome。
 * await 结束意味着事件队列已 close（for-await 自然退出）。
 */
async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}
