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

const registry = createToolRegistry([sumTool, searchDocsTool] as const);

test('完整运行：校验模型 turn，授权并发工具，并累计安全整数 usage', async () => {
  const runner = createRunner(new DeterministicModel(), 'run_success');
  const run = runner.start('demo', {
    grantedPermissions: new Set(['docs:read']),
  });
  const eventsPromise = collect(run.events);

  const outcome = await run.result;
  const events = await eventsPromise;

  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;

  assert.equal(outcome.steps, 2);
  assert.equal(outcome.usage.inputTokens, 32);
  assert.equal(outcome.usage.outputTokens, 18);
  assert.match(outcome.text, /sum=6/u);
  assert.deepEqual(
    events.map((event) => event.seq),
    Array.from({ length: events.length }, (_, index) => index + 1),
  );
  assert.equal(events.filter((event) => event.type === 'tool_completed').length, 2);
  assert.equal(events.at(-1)?.type, 'run_finished');
});

test('非法工具参数形成带 JSON Pointer 的结构化错误，且不进入 execute', async () => {
  const model: ModelAdapter = {
    async complete(request): Promise<ModelTurn> {
      if (request.step === 1) {
        return {
          kind: 'tool_calls',
          calls: [{ id: 'bad_1', name: 'sum', arguments: { values: [1, 'two'] } }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }

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
  if (outcome.status === 'completed') assert.equal(outcome.text, '模型收到参数错误');

  const toolCompleted = events.find((event) => event.type === 'tool_completed');
  assert.ok(toolCompleted?.type === 'tool_completed');
  assert.equal(toolCompleted.result.ok, false);
  if (!toolCompleted.result.ok) {
    assert.equal(toolCompleted.result.error.code, 'INVALID_ARGUMENTS');
    if (toolCompleted.result.error.code === 'INVALID_ARGUMENTS') {
      assert.equal(toolCompleted.result.error.issues[0]?.pointer, '/values/1');
    }
  }
});

test('权限检查先于参数解析：未授权请求不会泄漏字段级校验结果', async () => {
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

  const run = createRunner(model, 'run_forbidden').start('demo');
  const eventsPromise = collect(run.events);
  const outcome = await run.result;
  const events = await eventsPromise;

  assert.equal(outcome.status, 'completed');
  assert.match(feedback, /FORBIDDEN/u);
  assert.doesNotMatch(feedback, /INVALID_ARGUMENTS|docs:read|query/u);
  const completed = events.find((event) => event.type === 'tool_completed');
  assert.ok(completed?.type === 'tool_completed' && !completed.result.ok);
  if (completed?.type === 'tool_completed' && !completed.result.ok) {
    assert.equal(completed.result.error.code, 'FORBIDDEN');
  }
});

test('工具输出即使静态满足 JsonValue，也要拒绝 NaN、循环和 getter', async () => {
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
        output['self'] = output;
        return output;
      }
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
  const context = testToolContext();

  for (const kind of ['nan', 'cycle', 'getter'] as const) {
    const result = await unsafeRegistry.invokeDynamic(
      'unsafe_output',
      { kind },
      context,
    );
    assert.equal(result.ok, false, kind);
    if (!result.ok) assert.equal(result.error.code, 'INVALID_OUTPUT');
  }
  assert.equal(getterCalls, 0, '验证器必须检查 descriptor，不能执行不可信 getter');
});

test('不符合 normalized ModelTurn 的返回值在状态机入口被拒绝', async () => {
  const invalidModel: ModelAdapter = {
    async complete() {
      return {
        kind: 'tool_calls',
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
  if (outcome.status === 'failed') assert.ok(outcome.cause instanceof ModelProtocolError);
  assert.equal(events.some((event) => event.type === 'model_completed'), false);
  assert.equal(events.some((event) => event.type === 'tool_started'), false);
});

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
  assert.equal(events.some((event) => event.type === 'tool_started'), false);
});

test('tool call id 在整个 run 内唯一，跨轮复用会在第二次执行前失败', async () => {
  const model: ModelAdapter = {
    async complete(request): Promise<ModelTurn> {
      return {
        kind: 'tool_calls',
        calls: [{
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
  assert.equal(events.filter((event) => event.type === 'tool_completed').length, 1);
});

test('有界 worker pool 限制在途工具数，并按原调用顺序回填结果', async () => {
  const release = deferred<void>();
  const twoStarted = deferred<void>();
  const started: string[] = [];
  const gateTool = defineTool({
    name: 'gate',
    description: '用于观察并发上限',
    inputSchema: object({}),
    async execute(_input, context) {
      started.push(context.callId);
      if (started.length === 2) twoStarted.resolve(undefined);
      await release.promise;
      return { callId: context.callId };
    },
  });
  const gateRegistry = createToolRegistry([gateTool] as const);
  let secondRequest: ModelRequest | undefined;
  const model: ModelAdapter = {
    async complete(request): Promise<ModelTurn> {
      if (request.step === 1) {
        return {
          kind: 'tool_calls',
          calls: [1, 2, 3].map((id) => ({
            id: `gate_${id}`,
            name: 'gate',
            arguments: {},
          })),
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
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

  await twoStarted.promise;
  assert.deepEqual(started, ['gate_1', 'gate_2']);
  release.resolve(undefined);

  const outcome = await run.result;
  await eventsPromise;
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(started, ['gate_1', 'gate_2', 'gate_3']);
  const captured = secondRequest as ModelRequest | undefined;
  assert.ok(captured);
  assert.deepEqual(
    captured.messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.toolCallId),
    ['gate_1', 'gate_2', 'gate_3'],
  );
});

test('取消从 AgentRun 传播到正在等待的模型调用', async () => {
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
  run.cancel('test requested cancellation');

  const outcome = await run.result;
  const events = await eventsPromise;

  assert.equal(outcome.status, 'cancelled');
  if (outcome.status === 'cancelled') {
    assert.equal(outcome.reason, 'test requested cancellation');
  }
  assert.equal(events.at(-1)?.type, 'run_finished');
});

test('模型持续请求工具时由 maxSteps 明确终止', async () => {
  const loopingModel: ModelAdapter = {
    async complete(request): Promise<ModelTurn> {
      return {
        kind: 'tool_calls',
        calls: [{
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
  assert.equal(outcome.steps, 2);
});

test('AsyncQueue 明确执行单消费者协议，观察者提前退出不会取消 Run', async () => {
  const queue = new AsyncQueue<number>();
  const iterator = queue[Symbol.asyncIterator]();
  assert.throws(
    () => queue[Symbol.asyncIterator](),
    /只支持一个事件消费者/u,
  );
  queue.push(1);
  queue.close();
  assert.deepEqual(await iterator.next(), { done: false, value: 1 });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });

  const run = createRunner(new DeterministicModel(), 'run_detached_observer').start(
    'demo',
    { grantedPermissions: new Set(['docs:read']) },
  );
  for await (const event of run.events) {
    assert.equal(event.type, 'run_started');
    break;
  }
  const outcome = await run.result;
  assert.equal(outcome.status, 'completed');
});

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

function incrementingClock(): Clock {
  let now = 1_000;
  return { now: () => ++now };
}

function testToolContext(): ToolContext {
  return {
    runId: 'run_test',
    step: 1,
    callId: 'call_test',
    signal: new AbortController().signal,
    grantedPermissions: new Set(),
  };
}

type Deferred<Value> = {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
};

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}
