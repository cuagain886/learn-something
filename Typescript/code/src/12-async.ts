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

// Node 内置的严格相等断言模块：每一条“看似显然”的 Promise 行为，都用 deepEqual/equal/rejects 在运行时复核。
import assert from 'node:assert/strict';

// Deferred：把“一个 Promise + 它对应的 resolve/reject 句柄”打包暴露出来。
// 必要性：Promise 构造器只允许在 executor 内部访问 resolve/reject，
// 测试场景需要“在外部任意时机决定何时落定”，所以借助闭包把它们捕获出来。
interface Deferred<T> {
  // promise 给消费者 await；resolve/reject 给生产者控制。
  readonly promise: Promise<T>;
  // resolve 同时接受 T 和 PromiseLike<T>：传入 thenable 时按 Promise Resolution Procedure 处理。
  readonly resolve: (value: T | PromiseLike<T>) => void;
  // reject 的 reason 类型故意是 unknown：JS 允许 throw/reject 任意值。
  readonly reject: (reason?: unknown) => void;
}

/**
 * Deferred 只用于测试中显式控制完成顺序。生产代码若到处暴露 resolve/reject，
 * 会破坏“谁创建任务、谁负责完成任务”的所有权边界。
 */
function deferred<T>(): Deferred<T> {
  // definite assignment `!`：先声明后赋值。executor 同步执行，能保证此处一定会被填上。
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  // new Promise 的 executor 是“同步执行”的：构造 Promise 时立刻调用函数体。
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// ------------------------------------------------------------
// 1. executor 是同步的；then reaction 不是
// ------------------------------------------------------------
// 用一个数组当“事件日志”，再断言其内容，可以严格验证“哪一步先发生”。

// 日志数组：每一步都按发生顺序推入，断言等价于“重放执行序”。
const executionOrder: string[] = [];

// 构造 Promise：executor 立刻同步执行，因此 'start' 和 'after-resolve' 都被推入日志。
const eager = new Promise<number>((resolve) => {
  executionOrder.push('executor:start'); // 同步执行的第一步
  resolve(21); // 锁定最终值为 21，但不会中断后续同步代码
  // resolve 只锁定最终结果，不会跳出 executor。
  executionOrder.push('executor:after-resolve'); // 仍同步执行，证明 resolve 不是 return
});

// then 注册 onFulfilled 回调（reaction）：它不会被同步调用，
// 而是被排入 microtask 队列，等当前同步代码跑完才有机会执行。
const doubled = eager.then((value) => {
  executionOrder.push('then'); // 此时这行还没执行
  return value * 2;
});

// 同步代码末尾：此时 microtask 还没机会跑，日志里只有 executor 两条 + 下面这条。
executionOrder.push('sync:end');
assert.deepEqual(executionOrder, [
  'executor:start',
  'executor:after-resolve',
  'sync:end',
]);

// await 让出当前同步帧，microtask 队列得以运行；doubled 此时 fulfill 为 42。
assert.equal(await doubled, 42);
// 跑完 then 后，'then' 才被推入日志——证明 reaction 异步。
assert.deepEqual(executionOrder, [
  'executor:start',
  'executor:after-resolve',
  'sync:end',
  'then',
]);

// ------------------------------------------------------------
// 2. resolved 与 fulfilled 不同：thenable assimilation
// ------------------------------------------------------------
// Promise.resolve(thenable) 只把它“采纳”为已 resolved 状态，
// 但 thenable.then 的真正调用被排成单独的 Job，所以此刻并不立即 fulfilled。

// 计数器：用来观察 thenable.then 究竟被调用了多少次。
let thenCalls = 0;
// 一个外来的 thenable 对象：含有 then 方法但并非 Promise 实例。
// 用来证明：Promise 的 assimilation 协议不依赖 instanceof Promise。
const foreignThenable = {
  then(
    resolve: (value: number) => void,
    reject: (reason: unknown) => void,
  ): void {
    thenCalls += 1; // assimilation Job 执行时才会自增
    resolve(42);
    // CreateResolvingFunctions 保证第一次落定获胜，后续 reject 被忽略。
    reject(new Error('too late')); // 已 resolved，第二次落定被静默丢弃
  },
};

// Promise.resolve(thenable) 返回一个“已 resolved 指向 thenable”的 Promise；
// 真正调用 then 的 Job 尚未运行。
const adopted = Promise.resolve(foreignThenable);

// Promise.resolve 会读取 then，但调用 then 被安排为单独的 Job。
// 此时 thenCalls 仍是 0：这是 resolved ≠ fulfilled 的直接证据。
assert.equal(thenCalls, 0);
// await 触发 assimilation：thenable.then 被调用，resolve(42) 生效，最终值 = 42。
assert.equal(await adopted, 42);
assert.equal(thenCalls, 1); // assimilation 只调用一次 then

// Awaited 使用结构化 then 签名递归提取最终值，并不要求对象真由 Promise 构造器创建。
// 对 thenable 取 Awaited，会沿着 then 签名一路 unwrap 到 number。
type AdoptedValue = Awaited<typeof foreignThenable>; // → number
const adoptedValue: AdoptedValue = 42;
assert.equal(adoptedValue, 42);

// ------------------------------------------------------------
// 3. async 总返回 Promise，return Promise 会被递归展平
// ------------------------------------------------------------
// async 函数的返回值类型是 Promise<T>，即便函数体里 return 一个嵌套 Promise，
// 最终值也不会变成 Promise<Promise<...>>：会被 Promise Resolution Procedure 展平。

// 显式标注返回 Promise<number>；实际 return 的是嵌套两层 Promise。
async function compute(): Promise<number> {
  // 嵌套 Promise 会被递归展平，外层 async 包装再多一层也无妨。
  return Promise.resolve(Promise.resolve(42));
}

const computePromise = compute();
// 即使函数体看似同步，调用结果也一定是 Promise 实例。
assert.ok(computePromise instanceof Promise);
assert.equal(await computePromise, 42);

// Awaited<ReturnType<...>> 用来在类型层提取 async 函数最终的 fulfillment 值。
type Computed = Awaited<ReturnType<typeof compute>>; // → number
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
// 结果数组的顺序由“输入位置”决定；各输入“完成的先后”与之无关。

// 两个 deferred：first/second 此刻都未 resolve，可任意决定先后。
const first = deferred<'first'>();
const second = deferred<'second'>();
// completionOrder 记录“谁先完成”，与最终结果数组的顺序是两件事。
const completionOrder: string[] = [];

// as const 让 Promise.all 的结果保持为 readonly ['first', 'second'] 元组，
// 而不是退化成 ('first' | 'second')[]。
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

// 先 resolve second：second 的 then reaction 进入微任务队列。
second.resolve('second');
await Promise.resolve(); // 让出一个微任务轮回，让 reaction 跑完
assert.deepEqual(completionOrder, ['second']); // 此时 first 还在 pending

// 再 resolve first：两个输入都已 fulfilled，all 才整体 fulfill。
first.resolve('first');
const orderedResults = await all;
// 完成顺序 ['second','first'] 与结果数组 ['first','second'] 完全相反。
assert.deepEqual(completionOrder, ['second', 'first']);
assert.deepEqual(orderedResults, ['first', 'second']);

// `as const` 让 Promise.all 保留位置关系，而不是退化成元素联合数组。
type OrderedResults = typeof orderedResults; // readonly ['first', 'second']
const exactTuple: OrderedResults = ['first', 'second'];
assert.deepEqual(exactTuple, orderedResults);

// ------------------------------------------------------------
// 5. fail-fast 不等于 cancel-rest
// ------------------------------------------------------------
// Promise.all 一旦某个输入 reject 就立刻 reject，但它无法取消其他仍在运行的输入。
// JS 没有通用取消协议：fail-fast 描述的是“结果聚合行为”，不是“任务取消”。

const survivingTask = deferred<number>();
// 记录“幸存任务”最终是否真的产生了副作用。
let survivorSideEffect = 0;

const combined = Promise.all([
  survivingTask.promise.then((value) => {
    survivorSideEffect = value;
    return value;
  }),
  Promise.reject(new Error('one input failed')), // 同步 reject → combined 立即失败
]);

// combined fail-fast：等到的不是值，而是 reject。
await assert.rejects(combined, /one input failed/);
// 此时 survivingTask 还没 resolve，副作用未发生。
assert.equal(survivorSideEffect, 0);

// Promise.all 已经 reject，但它既没有能力也没有协议去取消另一个 Promise。
survivingTask.resolve(7); // 即使 combined 已落定，survivingTask 仍会照常走完
await survivingTask.promise;
await Promise.resolve();
// 幸存任务的副作用照常发生：fail-fast ≠ cancel-rest。
assert.equal(survivorSideEffect, 7);

// ------------------------------------------------------------
// 6. Promise.race 也不会取消败者；它本身不是“真实超时”
// ------------------------------------------------------------
// race 只关心“谁先落定”，落定后其余输入继续自然推进，其副作用不会被撤销。

const raceLoser = deferred<string>();
let loserStillRan = false;

// raceWinner 落定为 'winner'：同步 Promise 总是先赢。
const raceWinner = await Promise.race([
  Promise.resolve('winner'),
  raceLoser.promise.then((value) => {
    loserStillRan = true;
    return value;
  }),
]);

assert.equal(raceWinner, 'winner');
// race 落定时败者仍未 resolve，所以 reaction 还没跑。
assert.equal(loserStillRan, false);

// 败者最终也会 resolve，它的 then reaction 照样执行。
raceLoser.resolve('late-result');
await raceLoser.promise;
await Promise.resolve();
assert.equal(loserStillRan, true);

// 真正超时必须把 AbortSignal 等取消协议传进底层操作；详见第 18 课。

// ------------------------------------------------------------
// 7. allSettled/any 的错误类型仍从动态世界进入
// ------------------------------------------------------------
// Promise 类型没有 reject 维度，所以 reason 在 TS 中只能是 any/unknown，
// 必须靠运行时检查重新建立类型证明。

// allSettled 永不 reject：每个输入包成 { status, value?/reason? }。
const settled = await Promise.allSettled([
  Promise.resolve({ id: 1 }),
  Promise.reject('a string rejection'), // reason 是字符串，并非只能是 Error
] as const);

// status 是字面量联合：通过比较能进入对应分支。
assert.equal(settled[0].status, 'fulfilled');
assert.equal(settled[1].status, 'rejected');

// 在 rejected 分支里访问 reason；lib.d.ts 把它声明为 any，立刻收口到 unknown。
if (settled[1].status === 'rejected') {
  // lib.d.ts 为兼容 JS 把 reason 暴露为 any；立即收口到 unknown，重新建立证明义务。
  const reason: unknown = settled[1].reason;
  assert.equal(typeof reason, 'string'); // 通过运行时证明它是字符串
}

// any：只要有一个 fulfilled 就返回它的值。
assert.equal(
  await Promise.any([Promise.reject('offline'), Promise.resolve('healthy')]),
  'healthy',
);

// 全部 reject 时，Promise.any 抛 AggregateError，其 errors 收集所有 reason。
const allRejected: unknown = await Promise.any([
  Promise.reject('a'),
  Promise.reject(new Error('b')),
]).catch((error: unknown) => error);

assert.ok(allRejected instanceof AggregateError);
assert.equal(allRejected.errors.length, 2);

// Promise<T> 没有 Promise<T, E>：reject reason 在 JS 中允许任意值。
// 即使 reject 一个对象，类型上仍是 Promise<never>——T 维度上它永不 fulfill。
const arbitraryRejection: Promise<never> = Promise.reject({ code: 503 });
await assert.rejects(arbitraryRejection, (reason: unknown) => {
  return typeof reason === 'object' && reason !== null && 'code' in reason;
});

// ------------------------------------------------------------
// 8. finally 保留原结果，除非它自己失败
// ------------------------------------------------------------
// finally 不接收 value，也无法“返回新值”覆盖原结果；
// 唯一的例外是 finally 自己抛错或 reject，这时原值会被该错误替换。

const cleanupOrder: string[] = [];
// finally 回调返回 999 会被忽略；preserved 仍是 42。
const preserved = await Promise.resolve(42).finally(() => {
  cleanupOrder.push('cleanup');
  return 999; // finally 的普通返回值被忽略。
});

assert.equal(preserved, 42);
assert.deepEqual(cleanupOrder, ['cleanup']);

// 如果 finally 抛错，原结果会被替换为该错误。
const cleanupFailure: unknown = await Promise.resolve(42)
  .finally(() => {
    throw new Error('cleanup failed'); // 盖掉原来的 42
  })
  .catch((error: unknown) => error);

assert.ok(cleanupFailure instanceof Error);
assert.equal(cleanupFailure.message, 'cleanup failed');

// ------------------------------------------------------------
// 9. void 不会自动处理 fire-and-forget rejection
// ------------------------------------------------------------
// `void expr` 只是类型层面“丢弃表达式结果”，不会给未处理 rejection 自动接上 .catch；
// 想观察就必须显式挂上处理器。

const observedBackgroundErrors: string[] = [];

async function backgroundTask(): Promise<void> {
  throw new Error('background failed');
}

// `void backgroundTask()` 只丢弃表达式结果；必须显式挂 catch 才算观察 rejection。
// 这里先给 backgroundTask() 接 .catch，再用 void 标记“我故意不 await 这个观察 Promise”。
const observedBackground = backgroundTask().catch((error: unknown) => {
  observedBackgroundErrors.push(
    error instanceof Error ? error.message : String(error),
  );
});
void observedBackground; // 丢弃表达式值，表示此处不阻塞主流程

// 即便标了 void，我们仍可在之后选择 await 它，确保 catch 链已落定。
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
