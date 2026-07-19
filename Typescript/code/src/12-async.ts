/**
 * ============================================================
 * 第 12 课：Promise 解析过程、微任务与组合器边界
 * ============================================================
 *
 * 运行：npx tsx src/12-async.ts
 *
 * Java 的 Future 类比只能帮助入门，不能解释 JavaScript Promise 的关键语义：
 *
 * - executor 同步执行，reaction (`then/catch/finally`) 通过 Promise Job 运行；
 * - resolve 一个 Promise/thenable 是“采纳其状态”，不等于立即 fulfilled；
 * - 一个 Promise 只能落定一次，但落定不等于底层 I/O 被取消；
 * - `all`/`race` 组合结果，不拥有输入任务，所以失败/胜出不会自动取消败者；
 * - `async` 返回值会按 Promise Resolution Procedure 递归展平；
 * - TypeScript 能描述 fulfillment value，却不能在 Promise 类型里表达 reject 类型。
 *
 * 取消、超时、重试和结构化并发放在第 18 课；本课先把 Promise 本身看清。
 */

import assert from 'node:assert/strict';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

/**
 * Deferred 只用于测试中显式控制完成顺序。生产代码若到处暴露 resolve/reject，
 * 会破坏“谁创建任务、谁负责完成任务”的所有权边界。
 */
function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// ------------------------------------------------------------
// 1. executor 是同步的；then reaction 不是
// ------------------------------------------------------------

const executionOrder: string[] = [];

const eager = new Promise<number>((resolve) => {
  executionOrder.push('executor:start');
  resolve(21);
  // resolve 只锁定最终结果，不会跳出 executor。
  executionOrder.push('executor:after-resolve');
});

const doubled = eager.then((value) => {
  executionOrder.push('then');
  return value * 2;
});

executionOrder.push('sync:end');
assert.deepEqual(executionOrder, [
  'executor:start',
  'executor:after-resolve',
  'sync:end',
]);

assert.equal(await doubled, 42);
assert.deepEqual(executionOrder, [
  'executor:start',
  'executor:after-resolve',
  'sync:end',
  'then',
]);

// ------------------------------------------------------------
// 2. resolved 与 fulfilled 不同：thenable assimilation
// ------------------------------------------------------------

let thenCalls = 0;
const foreignThenable = {
  then(
    resolve: (value: number) => void,
    reject: (reason: unknown) => void,
  ): void {
    thenCalls += 1;
    resolve(42);
    // CreateResolvingFunctions 保证第一次落定获胜，后续 reject 被忽略。
    reject(new Error('too late'));
  },
};

const adopted = Promise.resolve(foreignThenable);

// Promise.resolve 会读取 then，但调用 then 被安排为单独的 Job。
assert.equal(thenCalls, 0);
assert.equal(await adopted, 42);
assert.equal(thenCalls, 1);

// Awaited 使用结构化 then 签名递归提取最终值，并不要求对象真由 Promise 构造器创建。
type AdoptedValue = Awaited<typeof foreignThenable>;
const adoptedValue: AdoptedValue = 42;
assert.equal(adoptedValue, 42);

// ------------------------------------------------------------
// 3. async 总返回 Promise，return Promise 会被递归展平
// ------------------------------------------------------------

async function compute(): Promise<number> {
  return Promise.resolve(Promise.resolve(42));
}

const computePromise = compute();
assert.ok(computePromise instanceof Promise);
assert.equal(await computePromise, 42);

type Computed = Awaited<ReturnType<typeof compute>>;
const computed: Computed = 42;

if (false) {
  // @ts-expect-error async 函数的显式返回类型必须是 Promise-like。
  async function invalidAsyncReturn(): number {
    return 1;
  }
  console.log(invalidAsyncReturn);
}

// ------------------------------------------------------------
// 4. Promise.all 保持输入顺序，不保持完成顺序
// ------------------------------------------------------------

const first = deferred<'first'>();
const second = deferred<'second'>();
const completionOrder: string[] = [];

const all = Promise.all([
  first.promise.then((value) => {
    completionOrder.push(value);
    return value;
  }),
  second.promise.then((value) => {
    completionOrder.push(value);
    return value;
  }),
] as const);

second.resolve('second');
await Promise.resolve();
assert.deepEqual(completionOrder, ['second']);

first.resolve('first');
const orderedResults = await all;
assert.deepEqual(completionOrder, ['second', 'first']);
assert.deepEqual(orderedResults, ['first', 'second']);

// `as const` 让 Promise.all 保留位置关系，而不是退化成元素联合数组。
type OrderedResults = typeof orderedResults;
const exactTuple: OrderedResults = ['first', 'second'];
assert.deepEqual(exactTuple, orderedResults);

// ------------------------------------------------------------
// 5. fail-fast 不等于 cancel-rest
// ------------------------------------------------------------

const survivingTask = deferred<number>();
let survivorSideEffect = 0;

const combined = Promise.all([
  survivingTask.promise.then((value) => {
    survivorSideEffect = value;
    return value;
  }),
  Promise.reject(new Error('one input failed')),
]);

await assert.rejects(combined, /one input failed/);
assert.equal(survivorSideEffect, 0);

// Promise.all 已经 reject，但它既没有能力也没有协议去取消另一个 Promise。
survivingTask.resolve(7);
await survivingTask.promise;
await Promise.resolve();
assert.equal(survivorSideEffect, 7);

// ------------------------------------------------------------
// 6. Promise.race 也不会取消败者；它本身不是“真实超时”
// ------------------------------------------------------------

const raceLoser = deferred<string>();
let loserStillRan = false;

const raceWinner = await Promise.race([
  Promise.resolve('winner'),
  raceLoser.promise.then((value) => {
    loserStillRan = true;
    return value;
  }),
]);

assert.equal(raceWinner, 'winner');
assert.equal(loserStillRan, false);

raceLoser.resolve('late-result');
await raceLoser.promise;
await Promise.resolve();
assert.equal(loserStillRan, true);

// 真正超时必须把 AbortSignal 等取消协议传进底层操作；详见第 18 课。

// ------------------------------------------------------------
// 7. allSettled/any 的错误类型仍从动态世界进入
// ------------------------------------------------------------

const settled = await Promise.allSettled([
  Promise.resolve({ id: 1 }),
  Promise.reject('a string rejection'),
] as const);

assert.equal(settled[0].status, 'fulfilled');
assert.equal(settled[1].status, 'rejected');

if (settled[1].status === 'rejected') {
  // lib.d.ts 为兼容 JS 把 reason 暴露为 any；立即收口到 unknown，重新建立证明义务。
  const reason: unknown = settled[1].reason;
  assert.equal(typeof reason, 'string');
}

assert.equal(
  await Promise.any([Promise.reject('offline'), Promise.resolve('healthy')]),
  'healthy',
);

const allRejected: unknown = await Promise.any([
  Promise.reject('a'),
  Promise.reject(new Error('b')),
]).catch((error: unknown) => error);

assert.ok(allRejected instanceof AggregateError);
assert.equal(allRejected.errors.length, 2);

// Promise<T> 没有 Promise<T, E>：reject reason 在 JS 中允许任意值。
const arbitraryRejection: Promise<never> = Promise.reject({ code: 503 });
await assert.rejects(arbitraryRejection, (reason: unknown) => {
  return typeof reason === 'object' && reason !== null && 'code' in reason;
});

// ------------------------------------------------------------
// 8. finally 保留原结果，除非它自己失败
// ------------------------------------------------------------

const cleanupOrder: string[] = [];
const preserved = await Promise.resolve(42).finally(() => {
  cleanupOrder.push('cleanup');
  return 999; // finally 的普通返回值被忽略。
});

assert.equal(preserved, 42);
assert.deepEqual(cleanupOrder, ['cleanup']);

const cleanupFailure: unknown = await Promise.resolve(42)
  .finally(() => {
    throw new Error('cleanup failed');
  })
  .catch((error: unknown) => error);

assert.ok(cleanupFailure instanceof Error);
assert.equal(cleanupFailure.message, 'cleanup failed');

// ------------------------------------------------------------
// 9. void 不会自动处理 fire-and-forget rejection
// ------------------------------------------------------------

const observedBackgroundErrors: string[] = [];

async function backgroundTask(): Promise<void> {
  throw new Error('background failed');
}

// `void backgroundTask()` 只丢弃表达式结果；必须显式挂 catch 才算观察 rejection。
const observedBackground = backgroundTask().catch((error: unknown) => {
  observedBackgroundErrors.push(
    error instanceof Error ? error.message : String(error),
  );
});
void observedBackground;

await observedBackground;
assert.deepEqual(observedBackgroundErrors, ['background failed']);

console.log('=== 第 12 课：Promise 底层语义 ===');
console.log({
  executionOrder,
  thenCalls,
  computed,
  completionOrder,
  orderedResults,
  survivorSideEffect,
  loserStillRan,
  settled: settled.map((result) => result.status),
  backgroundErrors: observedBackgroundErrors,
});

export {};
