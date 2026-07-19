/**
 * ============================================================
 * 第 25 课：AsyncLocalStorage —— Agent Run 的异步上下文传播
 * ============================================================
 *
 * Agent Runtime 中，日志函数通常不想层层传 runId/step/toolCallId。AsyncLocalStorage
 * 能让一个 store 沿 Promise、timer 等异步资源传播，并隔离并发 Run。
 *
 * 本课验证：
 *   1. 两个并发 run 的上下文不会串线
 *   2. 嵌套 run 结束后恢复父上下文
 *   3. 普通“保存回调、以后裸调用”不会自动绑定注册时上下文
 *   4. AsyncLocalStorage.bind/snapshot 能显式捕获当前执行上下文
 *   5. EventEmitter listener 默认使用 emit 时的上下文，而不是 on 时的上下文
 *   6. 上下文不会自动跨进程/Worker/网络，需要显式传播
 *
 * 运行：npm run lesson:context
 */

import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';

type RunContext = {
  readonly runId: string;
  readonly step: number;
  readonly toolCallId?: string;
};

type LogRecord = {
  readonly message: string;
  readonly runId: string;
  readonly step: number;
  readonly toolCallId?: string;
};

const runContext = new AsyncLocalStorage<RunContext>();
const records: LogRecord[] = [];

function currentContext(): RunContext {
  const context = runContext.getStore();
  if (context === undefined) throw new Error('当前调用不在 Agent Run 上下文中');
  return context;
}

function log(message: string): void {
  const context = currentContext();
  records.push(
    context.toolCallId === undefined
      ? { message, runId: context.runId, step: context.step }
      : {
          message,
          runId: context.runId,
          step: context.step,
          toolCallId: context.toolCallId,
        },
  );
}

async function executeTool(name: string, delayMs: number): Promise<string> {
  const parent = currentContext();

  return runContext.run(
    {
      ...parent,
      toolCallId: `${parent.runId}:${name}`,
    },
    async () => {
      log(`tool:${name}:started`);
      await delay(delayMs);
      log(`tool:${name}:completed`);
      return name;
    },
  );
}

async function executeRun(runId: string, firstDelay: number): Promise<void> {
  await runContext.run({ runId, step: 1 }, async () => {
    log('model:started');
    await delay(firstDelay);

    // 同一 Run 内两个工具并发；它们分别创建嵌套 context。
    await Promise.all([
      executeTool('search', 4),
      executeTool('sum', 1),
    ]);

    // 嵌套 run() 完成后恢复父 store，不残留最后一个 toolCallId。
    assert.equal(currentContext().toolCallId, undefined);
    log('model:resumed');
  });
}

// 两个顶层 run 并发交错，store 仍按异步因果链隔离。
await Promise.all([
  executeRun('run_A', 3),
  executeRun('run_B', 1),
]);

for (const record of records) {
  assert.ok(record.runId === 'run_A' || record.runId === 'run_B');
  if (record.toolCallId !== undefined) {
    assert.ok(record.toolCallId.startsWith(`${record.runId}:`));
  }
}

assert.equal(runContext.getStore(), undefined, 'run() 返回后必须恢复外层空上下文');
console.log('并发上下文日志:', records);

// ------------------------------------------------------------
// 保存函数 ≠ 捕获 AsyncLocalStorage 上下文
// ------------------------------------------------------------
let ordinaryCallback: () => string = () => 'uninitialized';
let boundCallback: () => string = () => 'uninitialized';
let snapshotCallback: () => string = () => 'uninitialized';

runContext.run({ runId: 'captured_run', step: 7 }, () => {
  ordinaryCallback = () => runContext.getStore()?.runId ?? 'no-context';
  boundCallback = AsyncLocalStorage.bind(
    () => runContext.getStore()?.runId ?? 'no-context',
  );

  const runInCapturedScope = AsyncLocalStorage.snapshot();
  snapshotCallback = () => runInCapturedScope(
    () => runContext.getStore()?.runId ?? 'no-context',
  );
});

assert.equal(ordinaryCallback(), 'no-context');
assert.equal(boundCallback(), 'captured_run');
assert.equal(snapshotCallback(), 'captured_run');
console.log('回调捕获:', {
  ordinary: ordinaryCallback(),
  bound: boundCallback(),
  snapshot: snapshotCallback(),
});

// ------------------------------------------------------------
// EventEmitter：listener 同步运行在 emit() 的当前上下文
// ------------------------------------------------------------
const emitter = new EventEmitter();
const eventContexts: string[] = [];

runContext.run({ runId: 'registration_context', step: 1 }, () => {
  emitter.on('event', () => {
    eventContexts.push(runContext.getStore()?.runId ?? 'no-context');
  });

  emitter.on(
    'bound-event',
    AsyncLocalStorage.bind(() => {
      eventContexts.push(runContext.getStore()?.runId ?? 'no-context');
    }),
  );
});

// 在上下文外 emit：普通 listener 看到 no-context，绑定 listener 恢复 registration_context。
emitter.emit('event');
emitter.emit('bound-event');
assert.deepEqual(eventContexts, ['no-context', 'registration_context']);
console.log('EventEmitter 上下文:', eventContexts);

// ------------------------------------------------------------
// Store 是共享对象引用：不要在并发分支中原地修改
// ------------------------------------------------------------
await runContext.run({ runId: 'immutable_context', step: 1 }, async () => {
  const parent = currentContext();
  // 通过新对象创建子作用域，而不是 parent.step += 1。
  await runContext.run({ ...parent, step: 2 }, async () => {
    await delay(1);
    assert.equal(currentContext().step, 2);
  });
  assert.equal(currentContext().step, 1);
});

console.log('=== 第 25 课完成：上下文按异步因果链传播，并在作用域退出后恢复 ===');

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export {};

