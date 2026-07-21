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

// RunContext：一次 Agent Run 在整个异步链上需要携带的“执行上下文”。
// readonly 表示它应被视为不可变 —— 子作用域通过新对象派生，而不是原地修改。
type RunContext = {
  readonly runId: string;
  readonly step: number;
  readonly toolCallId?: string;
};

// LogRecord：日志记录结构。它把上下文“快照”进每条日志，
// 这样后续聚合/排查时不需要再去回放 AsyncLocalStorage 的状态。
type LogRecord = {
  readonly message: string;
  readonly runId: string;
  readonly step: number;
  readonly toolCallId?: string;
};

// AsyncLocalStorage<RunContext>：每个异步资源（Promise then、timer 回调等）会被
// Node 的 async_hooks 关联到“建立它时的那个 store”，从而 run() 内部任意深度的
// await/setTimeout 都能取回同一个 context。不同的并发 run 各自走自己的因果链。
const runContext = new AsyncLocalStorage<RunContext>();
// records 把所有日志集中起来，便于后面的断言和打印检查。
const records: LogRecord[] = [];

// currentContext：取出当前异步链上的 context；没有就抛错。
// 这是“全局可访问、但实际按异步因果链隔离”的关键 —— 同步全局变量做不到这点。
function currentContext(): RunContext {
  const context = runContext.getStore();
  if (context === undefined) throw new Error('当前调用不在 Agent Run 上下文中');
  return context;
}

// log：演示“日志函数不接收 runId 参数也能拿到正确的上下文”。
// 它根据当前 store 拼出 LogRecord，toolCallId 缺省时省略该字段以保持记录精简。
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

// executeTool：在一个 run 内执行工具，并进入“子作用域”。
// 关键模式：读取父 context → 派生新 store（追加 toolCallId）→ 用 run() 进入新作用域。
async function executeTool(name: string, delayMs: number): Promise<string> {
  // 在父作用域里读取父 store，作为派生子 store 的基础。
  const parent = currentContext();

  // runContext.run(newStore, callback)：在 newStore 之下执行 callback，
  // callback 内部（含它 await 出去的所有异步链）都能 getStore() 拿到 newStore。
  return runContext.run(
    {
      // 不可变派生：拷贝父字段再追加 toolCallId，不修改 parent。
      ...parent,
      toolCallId: `${parent.runId}:${name}`,
    },
    async () => {
      // 此时 currentContext() 拿到的是“带 toolCallId 的子作用域”。
      log(`tool:${name}:started`);
      await delay(delayMs);
      log(`tool:${name}:completed`);
      return name;
    },
  );
}

// executeRun：模拟一次完整的 Agent Run —— 进入 run 作用域，调用两个并发工具。
async function executeRun(runId: string, firstDelay: number): Promise<void> {
  // 顶层 run：建立本次 Run 的根 store。await 仍然在它的作用域内，
  // 即使后面并发启动两个工具，工具的子作用域也都派生自这个根 store。
  await runContext.run({ runId, step: 1 }, async () => {
    log('model:started');
    await delay(firstDelay);

    // 同一 Run 内两个工具并发；它们分别创建嵌套 context。
    // 两个工具各跑各的 run()，互不影响 —— 各自的 toolCallId 不会串。
    await Promise.all([
      executeTool('search', 4),
      executeTool('sum', 1),
    ]);

    // 嵌套 run() 完成后恢复父 store，不残留最后一个 toolCallId。
    // 这验证了 run() 的“作用域栈”语义：进入子作用域不会污染父作用域。
    assert.equal(currentContext().toolCallId, undefined);
    log('model:resumed');
  });
}

// 两个顶层 run 并发交错，store 仍按异步因果链隔离。
// 即使 run_A 的工具恰好和 run_B 的工具同时在 event loop 上跑，
// 各自 log() 出来的 runId 仍然准确。
await Promise.all([
  executeRun('run_A', 3),
  executeRun('run_B', 1),
]);

// 校验所有日志记录：runId 必须属于 A/B；toolCallId 必须以自己的 runId 为前缀，
// 不会出现 run_A 的工具日志里写着 run_B 这种串线。
for (const record of records) {
  assert.ok(record.runId === 'run_A' || record.runId === 'run_B');
  if (record.toolCallId !== undefined) {
    assert.ok(record.toolCallId.startsWith(`${record.runId}:`));
  }
}

// 顶层 run() 全部返回后，外层没有任何 store —— 这是“作用域退出后必须还原”的语义。
assert.equal(runContext.getStore(), undefined, 'run() 返回后必须恢复外层空上下文');
console.log('并发上下文日志:', records);

// ------------------------------------------------------------
// 保存函数 ≠ 捕获 AsyncLocalStorage 上下文
// ------------------------------------------------------------
// 普通闭包只“记住”变量名，并不“记住”当时的异步执行上下文。
// 要在以后裸调用时还原当时的 store，必须显式 bind 或 snapshot。
let ordinaryCallback: () => string = () => 'uninitialized';
let boundCallback: () => string = () => 'uninitialized';
let snapshotCallback: () => string = () => 'uninitialized';

// 在 run() 内部注册三种回调，分别验证：什么都不做、bind、snapshot 的差别。
runContext.run({ runId: 'captured_run', step: 7 }, () => {
  // 普通闭包：函数体里在“调用时”才 getStore()。离开 run() 后再调用，
  // 拿到的就是调用点的当前 store（这里是 undefined）。
  ordinaryCallback = () => runContext.getStore()?.runId ?? 'no-context';

  // AsyncLocalStorage.bind(fn)：返回一个新函数，它无论在哪里调用，
  // 都会强制把“bind 时的当前 store”挂回去再执行原 fn。
  boundCallback = AsyncLocalStorage.bind(
    () => runContext.getStore()?.runId ?? 'no-context',
  );

  // AsyncLocalStorage.snapshot()：捕获“snapshot 调用瞬间的整套 ALS 状态”，
  // 返回一个 runner：runner(fn) 会把这套状态恢复后再跑 fn。
  // 适合需要同时携带多个 AsyncLocalStorage 实例状态的场景。
  const runInCapturedScope = AsyncLocalStorage.snapshot();
  snapshotCallback = () => runInCapturedScope(
    () => runContext.getStore()?.runId ?? 'no-context',
  );
});

// 离开 run() 后再调用：
//   普通回调读到 no-context；bind / snapshot 都成功还原 captured_run。
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
// Node 把 EventEmitter listener 视为“在 emit 时同步调用”的代码，
// 因此 listener 看到的是 emit 时的 store，不是 on() 注册时的 store。
// 如果要按“注册时上下文”跑 listener，需要手动 bind(listener)。
const emitter = new EventEmitter();
const eventContexts: string[] = [];

runContext.run({ runId: 'registration_context', step: 1 }, () => {
  // 普通 listener：在 emit 时执行 → 读到的是 emit 时的 store。
  emitter.on('event', () => {
    eventContexts.push(runContext.getStore()?.runId ?? 'no-context');
  });

  // 绑定 listener：listener 被 ALS.bind 包装过，
  // 不管 emit 时上下文如何，都会先恢复 registration_context 再执行。
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
// 父作用域的 store 被多个并发子分支读取时，原地修改会造成“分支间互相污染”。
// 正确做法：每个子作用域用 { ...parent, ...overrides } 派生新对象。
await runContext.run({ runId: 'immutable_context', step: 1 }, async () => {
  const parent = currentContext();
  // 通过新对象创建子作用域，而不是 parent.step += 1。
  // 即使并发执行多个这种子作用域，也不会互相干扰，因为它们读的都是各自的副本。
  await runContext.run({ ...parent, step: 2 }, async () => {
    await delay(1);
    assert.equal(currentContext().step, 2);
  });
  // 子作用域退出后，父作用域的 step 仍然是 1。
  assert.equal(currentContext().step, 1);
});

console.log('=== 第 25 课完成：上下文按异步因果链传播，并在作用域退出后恢复 ===');

// delay：唯一一个会被 await 的“异步边界”工具。
// 真正的 setTimeout 回调会被 Node 关联到“设置定时器时的执行上下文”，
// 这就是为什么 await delay(...) 之后 getStore() 仍然能拿到正确的 context。
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export {};
