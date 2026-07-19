/**
 * ============================================================
 * 第 18 课：结构化异步控制与确定性并发证明
 * ============================================================
 *
 * 运行：npm run lesson:async
 *
 * 本课把“能并发”提升为“生命周期可证明”：
 *
 * - 所有长操作显式接受 AbortSignal，并清理 timer/listener；
 * - timeout 传播取消原因，但无法强制停止不合作的操作；
 * - retry 让取消优先于重试分类，退避时间可注入、可测试；
 * - 并发池在首个失败时 abort siblings，并等待全部 worker 收束后再抛错；
 * - AsyncGenerator 只有被 next() 拉取时才生产，提前 break 会执行 finally。
 *
 * 测试并发顺序使用 Deferred 握手，不使用“睡 20ms 应该够了”这种脆弱假设。
 */

import assert from 'node:assert/strict';

class TimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`操作超过 ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('操作已取消', 'AbortError');
}

// ------------------------------------------------------------
// 1. 可取消 delay：完成与取消都移除 retaining edge
// ------------------------------------------------------------

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(ms) || ms < 0) {
    return Promise.reject(new RangeError('delay ms 必须是非负有限数字'));
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      if (signal !== undefined) reject(abortReason(signal));
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    function cleanup(): void {
      signal?.removeEventListener('abort', onAbort);
    }
  });
}

// ------------------------------------------------------------
// 2. cooperative timeout：abort 底层并等待它真正结束
// ------------------------------------------------------------

async function withTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError('timeoutMs 必须是非负有限数字');
  }

  const controller = new AbortController();
  const timeoutError = new TimeoutError(timeoutMs);
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);

  const forwardParentAbort = (): void => {
    controller.abort(parentSignal?.reason);
  };

  if (parentSignal?.aborted === true) forwardParentAbort();
  else parentSignal?.addEventListener('abort', forwardParentAbort, { once: true });

  try {
    // 不额外 race：只有 operation 响应 signal 并结束后，本作用域才算真正收束。
    // 若 operation 无视 signal，JavaScript 没有通用机制强杀它，这是 API 契约问题。
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', forwardParentAbort);
  }
}

// ------------------------------------------------------------
// 3. retry：分类、退避、取消优先级和可测试时间
// ------------------------------------------------------------

interface RetryPolicy {
  readonly maxAttempts: number;
  readonly shouldRetry: (error: unknown, failedAttempt: number) => boolean;
  readonly delayForAttempt: (failedAttempt: number) => number;
}

interface RetryDependencies {
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

async function retry<T>(
  operation: (attempt: number, signal: AbortSignal) => Promise<T>,
  policy: RetryPolicy,
  signal: AbortSignal,
  dependencies: RetryDependencies = { sleep: delay },
): Promise<T> {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError('maxAttempts 必须是正整数');
  }

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    signal.throwIfAborted();

    try {
      return await operation(attempt, signal);
    } catch (error: unknown) {
      // operation 可能因 signal 拒绝；取消必须优先，不能被 shouldRetry 误判成暂时错误。
      signal.throwIfAborted();

      if (
        attempt === policy.maxAttempts ||
        !policy.shouldRetry(error, attempt)
      ) {
        throw error;
      }

      const backoffMs = policy.delayForAttempt(attempt);
      if (!Number.isFinite(backoffMs) || backoffMs < 0) {
        throw new RangeError('delayForAttempt 必须返回非负有限数字');
      }
      await dependencies.sleep(backoffMs, signal);
    }
  }

  throw new Error('retry 控制流不变量被破坏');
}

// ------------------------------------------------------------
// 4. structured mapConcurrent：失败取消 sibling，并等待全部 worker
// ------------------------------------------------------------

const noFailure = Symbol('noFailure');

async function mapConcurrent<Input, Output>(
  items: readonly Input[],
  concurrency: number,
  mapper: (
    item: Input,
    index: number,
    signal: AbortSignal,
  ) => Promise<Output>,
  parentSignal?: AbortSignal,
): Promise<Output[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency 必须是正整数');
  }
  parentSignal?.throwIfAborted();
  if (items.length === 0) return [];

  const controller = new AbortController();
  const forwardParentAbort = (): void => {
    controller.abort(parentSignal?.reason);
  };
  parentSignal?.addEventListener('abort', forwardParentAbort, { once: true });

  const results = new Array<Output>(items.length);
  let cursor = 0;
  let firstFailure: unknown | typeof noFailure = noFailure;

  function recordFailure(error: unknown): void {
    if (firstFailure !== noFailure) return;
    firstFailure = error;
    controller.abort(error);
  }

  async function worker(): Promise<void> {
    while (true) {
      try {
        controller.signal.throwIfAborted();

        // JS job run-to-completion 保证 cursor 的读取/递增之间没有 await 插入点。
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;

        const item = items[index];
        if (item === undefined && !(index in items)) {
          throw new TypeError(`不接受稀疏数组，缺少索引 ${index}`);
        }

        results[index] = await mapper(
          item as Input,
          index,
          controller.signal,
        );
      } catch (error: unknown) {
        recordFailure(error);
        return;
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  try {
    // worker 自己吸收并记录失败，所以 Promise.all 会等待每个 worker 真正结束。
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    parentSignal?.removeEventListener('abort', forwardParentAbort);
  }

  if (firstFailure !== noFailure) throw firstFailure;

  for (let index = 0; index < results.length; index += 1) {
    if (!(index in results)) {
      throw new Error(`worker 未写入结果索引 ${index}`);
    }
  }
  return results;
}

// ------------------------------------------------------------
// 5. AsyncGenerator：拉取背压与提前关闭
// ------------------------------------------------------------

async function* streamTokens(
  tokens: readonly string[],
  signal: AbortSignal,
  lifecycle: string[],
): AsyncGenerator<string, void, void> {
  try {
    for (const token of tokens) {
      signal.throwIfAborted();
      lifecycle.push(`produce:${token}`);
      yield token;
    }
  } finally {
    lifecycle.push('cleanup');
  }
}

// ------------------------------------------------------------
// 6. 确定性契约实验
// ------------------------------------------------------------

// timeout：底层 delay 监听 signal，因此超时原因原样传播，timer/listener 随后清理。
const timeoutResult: unknown = await withTimeout(
  5,
  (signal) => delay(100, signal),
).catch((error: unknown) => error);
assert.ok(timeoutResult instanceof TimeoutError);
assert.equal(timeoutResult.timeoutMs, 5);

// retry：注入 fake sleep，不让测试依赖真实时间。
const attempts: number[] = [];
const requestedBackoffs: number[] = [];
const retryController = new AbortController();

const retryValue = await retry(
  async (attempt) => {
    attempts.push(attempt);
    if (attempt < 3) throw new Error(`temporary-${attempt}`);
    return 'ok';
  },
  {
    maxAttempts: 4,
    shouldRetry: (error) => error instanceof Error,
    delayForAttempt: (failedAttempt) => 10 * 2 ** (failedAttempt - 1),
  },
  retryController.signal,
  {
    async sleep(ms, signal) {
      signal.throwIfAborted();
      requestedBackoffs.push(ms);
    },
  },
);

assert.equal(retryValue, 'ok');
assert.deepEqual(attempts, [1, 2, 3]);
assert.deepEqual(requestedBackoffs, [10, 20]);

// 已取消时 shouldRetry 根本不应被调用。
const cancelledRetryController = new AbortController();
const cancellationReason = new Error('stop retry');
let retryClassifierCalls = 0;

const cancelledRetry = retry(
  async (_attempt, signal) => {
    cancelledRetryController.abort(cancellationReason);
    signal.throwIfAborted();
    return 'unreachable';
  },
  {
    maxAttempts: 3,
    shouldRetry: () => {
      retryClassifierCalls += 1;
      return true;
    },
    delayForAttempt: () => 0,
  },
  cancelledRetryController.signal,
);

await assert.rejects(cancelledRetry, (error: unknown) => error === cancellationReason);
assert.equal(retryClassifierCalls, 0);

// 并发上限与输出顺序：手动决定完成顺序 1 -> 2 -> 0 -> 3。
const controls = Array.from({ length: 4 }, () => deferred<number>());
const started: number[] = [];
const completed: number[] = [];
let active = 0;
let maxActive = 0;

const mappedPromise = mapConcurrent(
  [0, 1, 2, 3],
  2,
  async (value, index) => {
    started.push(index);
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      const result = await controls[index]?.promise;
      if (result === undefined) throw new Error(`缺少 gate ${index}`);
      completed.push(index);
      return value * value;
    } finally {
      active -= 1;
    }
  },
);

assert.deepEqual(started, [0, 1]);
controls[1]?.resolve(1);
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(started, [0, 1, 2]);

controls[2]?.resolve(2);
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(started, [0, 1, 2, 3]);

controls[0]?.resolve(0);
controls[3]?.resolve(3);
const mapped = await mappedPromise;

assert.equal(maxActive, 2);
assert.deepEqual(completed, [1, 2, 0, 3]);
assert.deepEqual(mapped, [0, 1, 4, 9]);

// 失败收束：worker 1 失败后，worker 0 的 delay 收到 sibling abort；返回前 active=0。
const mapperFailure = new Error('mapper failed');
const failureLifecycle: string[] = [];
let failureActive = 0;

const failedMap = mapConcurrent(
  [0, 1, 2],
  2,
  async (value, _index, signal) => {
    failureActive += 1;
    failureLifecycle.push(`start:${value}`);
    try {
      if (value === 1) throw mapperFailure;
      await delay(10_000, signal);
      return value;
    } finally {
      failureActive -= 1;
      failureLifecycle.push(`finish:${value}`);
    }
  },
);

await assert.rejects(failedMap, (error: unknown) => error === mapperFailure);
assert.equal(failureActive, 0);
assert.deepEqual(new Set(failureLifecycle), new Set([
  'start:0',
  'start:1',
  'finish:0',
  'finish:1',
]));
assert.equal(failureLifecycle.includes('start:2'), false);

// AsyncGenerator 不会预先生产第二项；return()/break 会进入 finally。
const streamLifecycle: string[] = [];
const iterator = streamTokens(
  ['agent', 'stream', 'backpressure'],
  new AbortController().signal,
  streamLifecycle,
);

assert.deepEqual(streamLifecycle, []);
assert.deepEqual(await iterator.next(), { value: 'agent', done: false });
assert.deepEqual(streamLifecycle, ['produce:agent']);
assert.deepEqual(await iterator.next(), { value: 'stream', done: false });
assert.deepEqual(streamLifecycle, ['produce:agent', 'produce:stream']);
await iterator.return();
assert.deepEqual(streamLifecycle, ['produce:agent', 'produce:stream', 'cleanup']);

console.log('=== 第 18 课：结构化异步控制 ===');
console.log({
  timeoutMs: timeoutResult.timeoutMs,
  attempts,
  requestedBackoffs,
  maxActive,
  completed,
  mapped,
  failureLifecycle,
  streamLifecycle,
});

export {};
