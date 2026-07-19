import assert from 'node:assert/strict';
import test from 'node:test';

import { object, string, transform } from './17-schema.js';
import { addUsage, type AgentEvent, type ModelTurn, type TokenUsage } from './agent-runtime/domain.js';
import { searchDocsTool, sumTool } from './agent-runtime/example-tools.js';
import type { ModelAdapter, ModelRequest } from './agent-runtime/model.js';
import { AgentRunner, type Clock } from './agent-runtime/runner.js';
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

type Deferred<Value> = {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (cause: unknown) => void;
};

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const controlledInputSchema = object({ value: string() });

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

test('并发工具按实际完成顺序发事件，但按模型调用顺序回填消息', async (t) => {
  const slowGate = deferred<string>();
  const fastGate = deferred<string>();
  const slowFinished = deferred<void>();
  const fastFinished = deferred<void>();
  const bothStarted = deferred<void>();
  let startedCount = 0;
  const markStarted = () => {
    startedCount += 1;
    if (startedCount === 2) bothStarted.resolve(undefined);
  };

  const slowTool = controlledTool('slow_tool', slowGate, slowFinished, markStarted);
  const fastTool = controlledTool('fast_tool', fastGate, fastFinished, markStarted);
  const registry = createToolRegistry([slowTool, fastTool] as const);

  let secondRequest: ModelRequest | undefined;
  const complete = t.mock.fn(async (request: ModelRequest): Promise<ModelTurn> => {
    if (request.step === 1) {
      return {
        kind: 'tool_calls',
        calls: [
          { id: 'slow_1', name: 'slow_tool', arguments: { value: 'S' } },
          { id: 'fast_1', name: 'fast_tool', arguments: { value: 'F' } },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }

    secondRequest = request;
    return {
      kind: 'final',
      text: 'done',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });

  const runner = new AgentRunner({
    model: { complete },
    tools: registry,
    clock: incrementingClock(),
    createRunId: () => 'run_concurrency_contract',
  });
  const run = runner.start('test ordering', { maxToolConcurrency: 2 });
  const eventsPromise = collect(run.events);

  await bothStarted.promise;
  fastGate.resolve('fast-result');
  await fastFinished.promise;
  slowGate.resolve('slow-result');
  await slowFinished.promise;

  const outcome = await run.result;
  const events = await eventsPromise;
  assert.equal(outcome.status, 'completed');
  assert.equal(complete.mock.callCount(), 2);

  const completionOrder = events
    .filter((event) => event.type === 'tool_completed')
    .map((event) => event.call.name);
  assert.deepEqual(completionOrder, ['fast_tool', 'slow_tool']);

  const capturedRequest = secondRequest as ModelRequest | undefined;
  assert.ok(capturedRequest, '第二轮模型请求必须存在');
  const feedbackOrder = capturedRequest.messages
    .filter((message) => message.role === 'tool')
    .map((message) => message.toolName);
  assert.deepEqual(feedbackOrder, ['slow_tool', 'fast_tool']);
});

test('用显式握手等待模型真正进入阻塞点，再验证取消传播', async () => {
  const enteredModel = deferred<void>();
  const model: ModelAdapter = {
    complete(_request, signal): Promise<ModelTurn> {
      enteredModel.resolve(undefined);
      return new Promise<ModelTurn>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
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
  run.cancel({ code: 'TEST_CANCEL' });

  const outcome = await run.result;
  const events = await eventsPromise;
  assert.equal(outcome.status, 'cancelled');
  assert.equal(events.at(-1)?.type, 'run_finished');
});

test('动态工具边界对 unknown 做表驱动测试，非法值绝不进入 execute', async () => {
  let executeCalls = 0;
  const queryTool = defineTool({
    name: 'query',
    description: 'query documents',
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
    assert.equal(result.ok, item.expectedOk, item.label);
  }
  assert.equal(executeCalls, 1);
});

test('TokenUsage 满足结合律与零元：确定性属性测试会打印可复现 seed', () => {
  const seed = 0x5eed_2026;
  const random = xorshift32(seed);
  const zero: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  for (let sample = 0; sample < 1_000; sample += 1) {
    const left = randomUsage(random);
    const middle = randomUsage(random);
    const right = randomUsage(random);

    assert.deepEqual(
      addUsage(addUsage(left, middle), right),
      addUsage(left, addUsage(middle, right)),
      `结合律失败，seed=${seed}，sample=${sample}`,
    );
    assert.deepEqual(addUsage(left, zero), left, `右零元失败，seed=${seed}`);
    assert.deepEqual(addUsage(zero, left), left, `左零元失败，seed=${seed}`);
  }
});

function xorshift32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function randomUsage(random: () => number): TokenUsage {
  return {
    inputTokens: random() % 100_000,
    outputTokens: random() % 100_000,
  };
}

function incrementingClock(): Clock {
  let now = 10_000;
  return { now: () => ++now };
}

function testToolContext(): ToolContext {
  return {
    runId: 'run_test',
    step: 1,
    callId: 'call_test',
    signal: new AbortController().signal,
    grantedPermissions: new Set(['docs:read']),
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

// 编译期契约与运行时测试是两条独立证据链。下面的分支不会执行，但 tsc 必须检查它。
const typeContractRegistry = createToolRegistry([sumTool, searchDocsTool] as const);
if (false) {
  void typeContractRegistry.invokeKnown('sum', { values: [1, 2] }, testToolContext());

  // @ts-expect-error sum 的 values 只接受 number[]；若 API 意外变宽，本行会让 typecheck 失败。
  void typeContractRegistry.invokeKnown('sum', { values: ['not a number'] }, testToolContext());

  // @ts-expect-error 已知工具入口拒绝注册表中不存在的名字。
  void typeContractRegistry.invokeKnown('missing_tool', {}, testToolContext());
}
