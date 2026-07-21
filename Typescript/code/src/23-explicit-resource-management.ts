/**
 * ============================================================
 * 第 23 课：显式资源管理 —— using / await using / DisposableStack
 * ============================================================
 *
 * Java 的 try-with-resources 与 TypeScript/JavaScript 的 Explicit Resource Management
 * 目标相似：让资源所有权和词法作用域绑定。但协议是基于 Symbol 的结构类型：
 *   - Disposable:      [Symbol.dispose](): void
 *   - AsyncDisposable: [Symbol.asyncDispose](): PromiseLike<void>
 *
 * 本课覆盖：
 *   1. 正常返回和异常路径都会清理
 *   2. 多个资源严格按后进先出顺序释放
 *   3. await using 会等待异步清理完成
 *   4. DisposableStack/AsyncDisposableStack 组合异构资源
 *   5. move() 显式转移所有权
 *   6. 业务错误与清理错误同时发生时使用 SuppressedError 保存两者
 *
 * 运行：npm run lesson:resources
 */

import assert from 'node:assert/strict';

// 生命周期事件全局收集器：把每个 acquire/use/dispose 按发生顺序记录下来，便于断言 LIFO。
const lifecycle: string[] = [];

// SyncResource：实现 Disposable 协议的最小同步资源。
// 「实现 Disposable」在运行时表现为「对象上有 [Symbol.dispose] 方法」。
class SyncResource implements Disposable {
  // #disposed 是运行时私有状态，用来保证 dispose 幂等（重复释放不会重复执行副作用）。
  #disposed = false;

  constructor(readonly name: string) {
    // 构造即视为 acquire，记录到 lifecycle。
    lifecycle.push(`acquire:${name}`);
  }

  // use 模拟正常使用资源的业务代码；若已释放则抛错，强制 fail-fast。
  use(): void {
    if (this.#disposed) throw new Error(`${this.name} 已释放`);
    lifecycle.push(`use:${this.name}`);
  }

  // [Symbol.dispose] 是协议入口：using 离开作用域时由运行时调用此方法。
  // 计算属性键 [Symbol.dispose] 让方法绑定到全局唯一的 dispose symbol。
  [Symbol.dispose](): void {
    // dispose 最好具备幂等性；复杂资源还应记录「正在关闭/已关闭」状态。
    if (this.#disposed) return;
    this.#disposed = true;
    lifecycle.push(`dispose:${this.name}`);
  }
}

// ------------------------------------------------------------
// 1. using 在离开当前词法作用域时自动调用 Symbol.dispose
// ------------------------------------------------------------
// runSyncScope 演示 using 的最基础语义：在函数结束时（无论正常返回或抛出）调用 dispose。
function runSyncScope(throwInside: boolean): void {
  // using 声明的变量在离开 { ... } 作用域时被自动释放，顺序与声明相反（LIFO）。
  using outer = new SyncResource('outer');
  using inner = new SyncResource('inner');

  outer.use();
  inner.use();

  // 即使中途抛错，outer/inner 仍会被 dispose——这就是与 try/finally 等价的保障。
  if (throwInside) throw new Error('scope body failed');
}

try {
  runSyncScope(true);
} catch (error: unknown) {
  // 抛出后被外层 catch 捕获；此时 dispose 已经在 runSyncScope 内部按 LIFO 跑完。
  lifecycle.push(`caught:${error instanceof Error ? error.message : String(error)}`);
}

console.log('同步资源生命周期:', lifecycle);
// acquire outer → acquire inner → ... → dispose inner → dispose outer
// 关键断言：dispose 顺序严格是 inner 在前、outer 在后，证明释放是栈式（LIFO）。
assert.deepEqual(lifecycle.slice(0, 6), [
  'acquire:outer',
  'acquire:inner',
  'use:outer',
  'use:inner',
  'dispose:inner',
  'dispose:outer',
]);

// ------------------------------------------------------------
// 2. await using 等待异步清理；适合连接、流、锁和遥测 span
// ------------------------------------------------------------
// AsyncConnection：实现 AsyncDisposable 协议，模拟一条需要异步关闭的网络连接。
class AsyncConnection implements AsyncDisposable {
  #closed = false;

  constructor(readonly name: string, readonly log: string[]) {
    log.push(`connect:${name}`);
  }

  // query 模拟一次异步 IO；已关闭则直接拒绝，避免在 closed 状态下发送请求。
  async query(sql: string): Promise<string> {
    if (this.#closed) throw new Error(`${this.name} 已关闭`);
    await delay(2);
    this.log.push(`query:${this.name}:${sql}`);
    return 'ok';
  }

  // [Symbol.asyncDispose]：await using 离开作用域时，运行时会 await 这个 Promise。
  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.log.push(`close-start:${this.name}`);
    await delay(2); // 模拟 flush/commit/close handshake
    this.log.push(`close-end:${this.name}`);
  }
}

// runAsyncScope 演示 await using：函数返回的 Promise 在所有异步 dispose 完成之前不会 resolve。
async function runAsyncScope(): Promise<readonly string[]> {
  const log: string[] = [];
  // await using 声明：作用域结束时不仅调用 asyncDispose，还会等它真正完成。
  await using primary = new AsyncConnection('primary', log);
  await using audit = new AsyncConnection('audit', log);

  await primary.query('select memory');
  await audit.query('insert trace');
  return log;
  // return 之前先按 audit → primary 顺序 await 异步释放，然后 Promise 才完成。
}

const asyncLifecycle = await runAsyncScope();
console.log('异步资源生命周期:', asyncLifecycle);
// 断言最后 4 条记录：audit 先关闭（start+end），再到 primary——再次验证 LIFO，
// 且每条 close-start 都有对应的 close-end（证明 await 真的等到了异步清理完成）。
assert.deepEqual(asyncLifecycle.slice(-4), [
  'close-start:audit',
  'close-end:audit',
  'close-start:primary',
  'close-end:primary',
]);

// ------------------------------------------------------------
// 3. DisposableStack：动态数量、不同清理协议统一进入 LIFO 栈
// ------------------------------------------------------------
// DisposableStack 像一个「装清理动作的栈」：use/adopt/defer 都把「要怎么做清理」压入栈，
// 栈本身被 dispose 时（通过 using 触发）按 LIFO 顺序执行它们。
function createOwnedBundle(log: string[]): DisposableStack {
  const stack = new DisposableStack();

  // use：把一个 Disposable 压入栈，栈 dispose 时调用它的 [Symbol.dispose]。
  stack.use(new SyncResource('stack-resource'));
  // adopt：把「不属于协议的对象 + 自定义释放函数」一起登记进栈。
  stack.adopt('lease_42', (lease) => log.push(`release:${lease}`));
  // defer：直接登记一个无参数的清理函数（类似 Go 的 defer）。
  stack.defer(() => log.push('deferred-cleanup'));

  // move 把清理责任转给新 Stack；原 stack 变为 disposed 且不再拥有这些资源。
  return stack.move();
}

const stackLog: string[] = [];
{
  // 把 stack.move() 的结果作为 using 变量：作用域结束时这些清理动作才会执行。
  using bundle = createOwnedBundle(stackLog);
  // 此时 bundle 尚未 disposed——证明 move() 只是转移所有权，不触发清理。
  stackLog.push(`bundle-disposed-inside:${bundle.disposed}`);
}
// 离开块作用域后 bundle 被 dispose，所有登记的清理动作按 LIFO 执行。
stackLog.push('scope-left');
console.log('DisposableStack:', stackLog);

// ------------------------------------------------------------
// 4. AsyncDisposableStack 可以混合 AsyncDisposable、adopt 和异步 defer
// ------------------------------------------------------------
// AsyncDisposableStack 是异步版本：可以装同步/异步资源、同步/异步清理函数，
// await using 整个栈时按 LIFO 顺序 await 全部清理动作。
async function runAsyncStack(): Promise<readonly string[]> {
  const log: string[] = [];
  await using stack = new AsyncDisposableStack();

  // 装一个 AsyncDisposable：栈释放时会 await 它的 asyncDispose。
  stack.use(new AsyncConnection('stack-connection', log));
  // adopt 接收一个异步释放回调（返回 Promise）。
  stack.adopt('remote-lease', async (lease) => {
    await delay(1);
    log.push(`async-release:${lease}`);
  });
  // defer 也可以是 async 函数；栈释放时会逐个 await。
  stack.defer(async () => {
    await delay(1);
    log.push('async-defer');
  });

  log.push('work-completed');
  return log;
}

console.log('AsyncDisposableStack:', await runAsyncStack());

// ------------------------------------------------------------
// 5. SuppressedError：清理失败不能抹掉原始业务失败
// ------------------------------------------------------------
// FailingCleanup 的 dispose 总会抛错，用来演示「业务异常 + 清理异常」同时发生的语义。
class FailingCleanup implements Disposable {
  [Symbol.dispose](): void {
    throw new Error('cleanup failed');
  }
}

try {
  // 进入块时 acquire，块结束时 dispose 抛错；但块内已经先抛了 'body failed'。
  // 此时运行时把「业务异常」作为主因，把「清理异常」作为 suppressed 包进去。
  using _resource = new FailingCleanup();
  throw new Error('body failed');
} catch (error: unknown) {
  // 当 body 与清理同时抛错，运行时抛出的是 SuppressedError：
  //   error.error       = 清理时抛的错（cleanup failed）
  //   error.suppressed  = 业务原本的错（body failed）
  if (error instanceof SuppressedError) {
    console.log('同时保留两个错误:', {
      cleanup: error.error instanceof Error ? error.error.message : error.error,
      body: error.suppressed instanceof Error ? error.suppressed.message : error.suppressed,
    });
  } else {
    throw error;
  }
}

// ------------------------------------------------------------
// 6. Agent 场景：谁创建连接，谁在同一作用域声明所有权
// ------------------------------------------------------------
// 典型用法：连接的「所有权」与「使用它的代码」放在同一个 async 函数作用域内，
// 由 await using 兜底释放，调用方无需关心资源生命周期。
async function executeAgentStep(): Promise<string> {
  const log: string[] = [];
  await using modelConnection = new AsyncConnection('model-stream', log);

  const result = await modelConnection.query('stream completion');
  // return 后才会触发 asyncDispose；通过 log 看出「业务先完成、再异步释放」。
  if (result === 'ok') return `step completed; before return log=${log.join(',')}`;
  return 'unreachable';
}

console.log('Agent step:', await executeAgentStep());

// delay 是一个简单的 Promise 等待工具，用于让异步清理更可观察。
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log('=== 第 23 课完成：资源所有权已经与词法作用域绑定 ===');

export {};
