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

// observeQueuePriority：在同一个 setImmediate 回调内注册多种任务，
// 观察微任务（nextTick / queueMicrotask / Promise.then）一定早于下一轮宏任务。
async function observeQueuePriority(): Promise<readonly string[]> {
  // trace 记录每条回调实际执行的顺序，是后续断言的对象。
  const trace: string[] = [];

  // 用 await new Promise 把内部回调的执行时序与外层 await 同步起来。
  await new Promise<void>((resolve) => {
    // 从一个明确的 check 阶段回调内部注册所有任务，避免顶层 ESM 求值上下文
    // 干扰 nextTick 与 Promise job 的教学观察。
    setImmediate(() => {
      trace.push('callback:start');

      // 三种微任务源：nextTick 队列优先级最高，其次 queueMicrotask，再其次 Promise then job。
      process.nextTick(() => trace.push('nextTick'));
      queueMicrotask(() => trace.push('queueMicrotask'));
      Promise.resolve().then(() => trace.push('promise.then'));

      // 计数器：等本轮 timer + immediate 两个宏任务都跑完后再 resolve。
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

      // 同步部分先打印 end，再让出当前回调——之后才会进入微任务清空阶段。
      trace.push('callback:end');
    });
  });

  // 断言 1：同步部分先跑完，然后三种微任务按 nextTick > queueMicrotask > promise.then 排列。
  assert.deepEqual(trace.slice(0, 5), [
    'callback:start',
    'callback:end',
    'nextTick',
    'queueMicrotask',
    'promise.then',
  ]);
  // 断言 2：剩下的两条是 timer 和 immediate，但相对顺序不保证，因此先排序再比较。
  assert.deepEqual([...trace.slice(5)].sort(), ['immediate', 'timer']);

  return trace;
}

// observeAwaitSegmentation：证明 await 会把 async 函数「切成两段」。
// 即使 await 的是已 fulfilled 的 Promise，后半段也不会同步继续，而是排入微任务队列。
async function observeAwaitSegmentation(): Promise<readonly string[]> {
  const trace: string[] = [];

  async function oneTurn(): Promise<void> {
    trace.push('async:before-await');
    // 即使等待的是已经 fulfilled 的 Promise，await 后半段也不会同步继续。
    // await 在语义上等价于「return 一个 Promise，并把后续代码注册为 .then 回调」。
    await Promise.resolve('ready');
    trace.push('async:after-await');
  }

  // 调用 async 函数会立即同步执行到第一个 await，然后返回 pending Promise。
  trace.push('caller:before-call');
  const pending = oneTurn();
  trace.push('caller:after-call');
  // await pending 触发调用方的让步，等微任务阶段才继续。
  await pending;
  trace.push('caller:after-promise');

  // 关键观察：'async:before-await' 在 'after-call' 之前（同步段先跑），
  // 但 'async:after-await' 在 'after-call' 之后（被 await 推迟到微任务）。
  assert.deepEqual(trace, [
    'caller:before-call',
    'async:before-await',
    'caller:after-call',
    'async:after-await',
    'caller:after-promise',
  ]);

  return trace;
}

// observeNextTickStarvation：用有限递归 nextTick 复现「nextTick 饥饿 timer」的现象。
async function observeNextTickStarvation(): Promise<number> {
  const limit = 5_000;
  let processed = 0;

  // 当 timer 终于能跑时，processed 应该已经被 nextTick 链全部填满。
  const processedWhenTimerRan = await new Promise<number>((resolve) => {
    // 把 resolve 排进 timer 队列；只有当 nextTick 队列被清空后才会被调度。
    setTimeout(() => resolve(processed), 0);

    // pump 通过递归 process.nextTick 不断把自身重新入队，形成「不让出控制权」的链。
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

// doCpuChunk：模拟一小段同步 CPU 工作，让主线程短暂繁忙。
// 真实 Agent 中这可能是大 JSON 变换、token 后处理或排序。
function doCpuChunk(seed: number): number {
  // 一小块同步 CPU 工作。真实 Agent 中可能是大 JSON 变换、token 后处理或排序。
  let checksum = seed;
  for (let index = 0; index < 40_000; index += 1) {
    // Math.imul 是 32 位整数乘法，避免 JS number 精度溢出影响哈希序列。
    checksum = Math.imul(checksum ^ index, 1_664_525) + 1_013_904_223;
  }
  return checksum;
}

// observeCooperativeYield：证明 scheduler.yield() 能让 timer/I/O 在 CPU chunk 之间插入运行。
// 关键点：yield 不把工作搬到其他线程，只是「让出当前事件循环轮次」。
async function observeCooperativeYield(): Promise<{
  readonly heartbeatAfterChunk: number;
  readonly checksum: number;
}> {
  const totalChunks = 8;
  let chunksFinished = 0;
  let heartbeatAfterChunk = -1;

  // heartbeat 是一个 0ms 定时器，用来探测「它最早能在第几个 chunk 完成后运行」。
  const heartbeat = new Promise<void>((resolve) => {
    setTimeout(() => {
      heartbeatAfterChunk = chunksFinished;
      resolve();
    }, 0);
  });

  let checksum = 17;
  while (chunksFinished < totalChunks) {
    // 每个 chunk 是同步 CPU 工作，期间事件循环无法插入任何其他回调。
    checksum = doCpuChunk(checksum);
    chunksFinished += 1;

    // scheduler.yield() 把继续执行安排到未来的事件循环轮次，让 timer/I/O 获得机会。
    // 它不是把 CPU 工作自动送到 Worker Thread；每个 chunk 仍然在主线程同步执行。
    await scheduler.yield();
  }

  // 等 heartbeat 跑完，确认它确实在某个中途 chunk 完成后被调度到了（而不是等到全部 chunk 完成）。
  await heartbeat;
  assert.ok(heartbeatAfterChunk >= 1 && heartbeatAfterChunk < totalChunks);

  return { heartbeatAfterChunk, checksum };
}

// observeAbortIsNotPreemption：证明 AbortSignal 是「协作式」的，不会抢占正在运行的同步代码。
// 即：定时器回调要等到主线程同步循环跑完、并主动 await/yield 后才能进入。
async function observeAbortIsNotPreemption(): Promise<void> {
  const controller = new AbortController();
  // 用 definite assignment 断言：resolveAbortCallback 在 Promise executor 内一定会被赋值。
  let resolveAbortCallback!: () => void;
  const abortCallbackRan = new Promise<void>((resolve) => {
    resolveAbortCallback = resolve;
  });

  // 0ms 后触发 abort；但回调必须等当前同步循环让出主线程后才能跑。
  setTimeout(() => {
    controller.abort(new Error('deadline exceeded'));
    resolveAbortCallback();
  }, 0);

  // 事件循环无法在这段同步循环中间插入 timer 回调。AbortSignal 是协作式取消信号，
  // 并不会像 Thread.interrupt 的错误想象那样强行终止正在运行的 JavaScript。
  let checksum = 0;
  // 这个 for 循环跑完之前，abort 回调无法插入——证明 abort 不是抢占式。
  for (let index = 0; index < 200_000; index += 1) checksum ^= index;
  // 此刻定时器回调尚未运行，因此 signal 还没被标记为 aborted。
  assert.equal(checksum, 0);
  assert.equal(controller.signal.aborted, false);

  // 主动让出主线程：scheduler.yield() 给 timer 回调一个被调度的机会。
  await scheduler.yield();
  await abortCallbackRan;
  // 此时定时器回调已经把 signal 标记为 aborted。
  assert.equal(controller.signal.aborted, true);
  // throwIfAborted 在已 aborted 时抛出 abort 时传入的 reason。
  assert.throws(
    () => controller.signal.throwIfAborted(),
    (cause: unknown) => cause instanceof Error && cause.message === 'deadline exceeded',
  );
}

// 顶层执行五个观察函数，把结果汇总到日志。
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
