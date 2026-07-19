import assert from 'node:assert/strict';
import { scheduler } from 'node:timers/promises';

/**
 * 第 28 课：Node.js 事件循环、微任务与协作式调度
 *
 * Java 的线程池模型容易让人形成一个错误直觉：异步函数似乎在另一条线程上执行。
 * 实际上，普通 JavaScript 回调仍在同一条事件循环线程上运行；I/O 完成通知、线程池任务
 * 和定时器只是把“以后要执行的回调”排入相应队列。
 *
 * 本课只断言规范/Node 契约保证的局部顺序。setTimeout(0) 与 setImmediate 的全局先后
 * 会受它们从哪个阶段被注册、libuv 版本等因素影响，不应写成业务契约。
 */

async function observeQueuePriority(): Promise<readonly string[]> {
  const trace: string[] = [];

  await new Promise<void>((resolve) => {
    // 从一个明确的 check 阶段回调内部注册所有任务，避免顶层 ESM 求值上下文
    // 干扰 nextTick 与 Promise job 的教学观察。
    setImmediate(() => {
      trace.push('callback:start');

      process.nextTick(() => trace.push('nextTick'));
      queueMicrotask(() => trace.push('queueMicrotask'));
      Promise.resolve().then(() => trace.push('promise.then'));

      let macrotasksFinished = 0;
      const finishOneMacrotask = () => {
        macrotasksFinished += 1;
        if (macrotasksFinished === 2) resolve();
      };

      // 这里有意不假定二者的相对顺序，只证明它们都晚于当前回调后的微任务检查点。
      setTimeout(() => {
        trace.push('timer');
        finishOneMacrotask();
      }, 0);
      setImmediate(() => {
        trace.push('immediate');
        finishOneMacrotask();
      });

      trace.push('callback:end');
    });
  });

  assert.deepEqual(trace.slice(0, 5), [
    'callback:start',
    'callback:end',
    'nextTick',
    'queueMicrotask',
    'promise.then',
  ]);
  assert.deepEqual([...trace.slice(5)].sort(), ['immediate', 'timer']);

  return trace;
}

async function observeAwaitSegmentation(): Promise<readonly string[]> {
  const trace: string[] = [];

  async function oneTurn(): Promise<void> {
    trace.push('async:before-await');
    // 即使等待的是已经 fulfilled 的 Promise，await 后半段也不会同步继续。
    await Promise.resolve('ready');
    trace.push('async:after-await');
  }

  trace.push('caller:before-call');
  const pending = oneTurn();
  trace.push('caller:after-call');
  await pending;
  trace.push('caller:after-promise');

  assert.deepEqual(trace, [
    'caller:before-call',
    'async:before-await',
    'caller:after-call',
    'async:after-await',
    'caller:after-promise',
  ]);

  return trace;
}

async function observeNextTickStarvation(): Promise<number> {
  const limit = 5_000;
  let processed = 0;

  const processedWhenTimerRan = await new Promise<number>((resolve) => {
    setTimeout(() => resolve(processed), 0);

    const pump = () => {
      processed += 1;
      if (processed < limit) process.nextTick(pump);
    };
    pump();
  });

  // Node 会在进入后续事件循环阶段前持续清空 nextTick 队列。因此无界递归 nextTick
  // 可以让 I/O 和 timer 永远没有运行机会。这里用有限次数安全复现该现象。
  assert.equal(processedWhenTimerRan, limit);
  return processedWhenTimerRan;
}

function doCpuChunk(seed: number): number {
  // 一小块同步 CPU 工作。真实 Agent 中可能是大 JSON 变换、token 后处理或排序。
  let checksum = seed;
  for (let index = 0; index < 40_000; index += 1) {
    checksum = Math.imul(checksum ^ index, 1_664_525) + 1_013_904_223;
  }
  return checksum;
}

async function observeCooperativeYield(): Promise<{
  readonly heartbeatAfterChunk: number;
  readonly checksum: number;
}> {
  const totalChunks = 8;
  let chunksFinished = 0;
  let heartbeatAfterChunk = -1;

  const heartbeat = new Promise<void>((resolve) => {
    setTimeout(() => {
      heartbeatAfterChunk = chunksFinished;
      resolve();
    }, 0);
  });

  let checksum = 17;
  while (chunksFinished < totalChunks) {
    checksum = doCpuChunk(checksum);
    chunksFinished += 1;

    // scheduler.yield() 把继续执行安排到未来的事件循环轮次，让 timer/I/O 获得机会。
    // 它不是把 CPU 工作自动送到 Worker Thread；每个 chunk 仍然在主线程同步执行。
    await scheduler.yield();
  }

  await heartbeat;
  assert.ok(heartbeatAfterChunk >= 1 && heartbeatAfterChunk < totalChunks);

  return { heartbeatAfterChunk, checksum };
}

async function observeAbortIsNotPreemption(): Promise<void> {
  const controller = new AbortController();
  let resolveAbortCallback!: () => void;
  const abortCallbackRan = new Promise<void>((resolve) => {
    resolveAbortCallback = resolve;
  });

  setTimeout(() => {
    controller.abort(new Error('deadline exceeded'));
    resolveAbortCallback();
  }, 0);

  // 事件循环无法在这段同步循环中间插入 timer 回调。AbortSignal 是协作式取消信号，
  // 并不会像 Thread.interrupt 的错误想象那样强行终止正在运行的 JavaScript。
  let checksum = 0;
  for (let index = 0; index < 200_000; index += 1) checksum ^= index;
  assert.equal(checksum, 0);
  assert.equal(controller.signal.aborted, false);

  await scheduler.yield();
  await abortCallbackRan;
  assert.equal(controller.signal.aborted, true);
  assert.throws(
    () => controller.signal.throwIfAborted(),
    (cause: unknown) => cause instanceof Error && cause.message === 'deadline exceeded',
  );
}

const queueTrace = await observeQueuePriority();
const awaitTrace = await observeAwaitSegmentation();
const starvedTicks = await observeNextTickStarvation();
const cooperative = await observeCooperativeYield();
await observeAbortIsNotPreemption();

console.log('队列局部顺序:', queueTrace);
console.log('await 分段:', awaitTrace);
console.log('timer 运行前处理的 nextTick 数:', starvedTicks);
console.log('协作式让步:', cooperative);
console.log('=== 第 28 课完成：异步是调度与协作，不等于 JavaScript 并行执行 ===');
