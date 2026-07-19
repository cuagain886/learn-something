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

const lifecycle: string[] = [];

class SyncResource implements Disposable {
  #disposed = false;

  constructor(readonly name: string) {
    lifecycle.push(`acquire:${name}`);
  }

  use(): void {
    if (this.#disposed) throw new Error(`${this.name} 已释放`);
    lifecycle.push(`use:${this.name}`);
  }

  [Symbol.dispose](): void {
    // dispose 最好具备幂等性；复杂资源还应记录“正在关闭/已关闭”状态。
    if (this.#disposed) return;
    this.#disposed = true;
    lifecycle.push(`dispose:${this.name}`);
  }
}

// ------------------------------------------------------------
// 1. using 在离开当前词法作用域时自动调用 Symbol.dispose
// ------------------------------------------------------------
function runSyncScope(throwInside: boolean): void {
  using outer = new SyncResource('outer');
  using inner = new SyncResource('inner');

  outer.use();
  inner.use();

  if (throwInside) throw new Error('scope body failed');
}

try {
  runSyncScope(true);
} catch (error: unknown) {
  lifecycle.push(`caught:${error instanceof Error ? error.message : String(error)}`);
}

console.log('同步资源生命周期:', lifecycle);
// acquire outer → acquire inner → ... → dispose inner → dispose outer
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
class AsyncConnection implements AsyncDisposable {
  #closed = false;

  constructor(readonly name: string, readonly log: string[]) {
    log.push(`connect:${name}`);
  }

  async query(sql: string): Promise<string> {
    if (this.#closed) throw new Error(`${this.name} 已关闭`);
    await delay(2);
    this.log.push(`query:${this.name}:${sql}`);
    return 'ok';
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.log.push(`close-start:${this.name}`);
    await delay(2); // 模拟 flush/commit/close handshake
    this.log.push(`close-end:${this.name}`);
  }
}

async function runAsyncScope(): Promise<readonly string[]> {
  const log: string[] = [];
  await using primary = new AsyncConnection('primary', log);
  await using audit = new AsyncConnection('audit', log);

  await primary.query('select memory');
  await audit.query('insert trace');
  return log;
  // return 之前先按 audit → primary 顺序 await 异步释放，然后 Promise 才完成。
}

const asyncLifecycle = await runAsyncScope();
console.log('异步资源生命周期:', asyncLifecycle);
assert.deepEqual(asyncLifecycle.slice(-4), [
  'close-start:audit',
  'close-end:audit',
  'close-start:primary',
  'close-end:primary',
]);

// ------------------------------------------------------------
// 3. DisposableStack：动态数量、不同清理协议统一进入 LIFO 栈
// ------------------------------------------------------------
function createOwnedBundle(log: string[]): DisposableStack {
  const stack = new DisposableStack();

  stack.use(new SyncResource('stack-resource'));
  stack.adopt('lease_42', (lease) => log.push(`release:${lease}`));
  stack.defer(() => log.push('deferred-cleanup'));

  // move 把清理责任转给新 Stack；原 stack 变为 disposed 且不再拥有这些资源。
  return stack.move();
}

const stackLog: string[] = [];
{
  using bundle = createOwnedBundle(stackLog);
  stackLog.push(`bundle-disposed-inside:${bundle.disposed}`);
}
stackLog.push('scope-left');
console.log('DisposableStack:', stackLog);

// ------------------------------------------------------------
// 4. AsyncDisposableStack 可以混合 AsyncDisposable、adopt 和异步 defer
// ------------------------------------------------------------
async function runAsyncStack(): Promise<readonly string[]> {
  const log: string[] = [];
  await using stack = new AsyncDisposableStack();

  stack.use(new AsyncConnection('stack-connection', log));
  stack.adopt('remote-lease', async (lease) => {
    await delay(1);
    log.push(`async-release:${lease}`);
  });
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
class FailingCleanup implements Disposable {
  [Symbol.dispose](): void {
    throw new Error('cleanup failed');
  }
}

try {
  using _resource = new FailingCleanup();
  throw new Error('body failed');
} catch (error: unknown) {
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
async function executeAgentStep(): Promise<string> {
  const log: string[] = [];
  await using modelConnection = new AsyncConnection('model-stream', log);

  const result = await modelConnection.query('stream completion');
  if (result === 'ok') return `step completed; before return log=${log.join(',')}`;
  return 'unreachable';
}

console.log('Agent step:', await executeAgentStep());

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log('=== 第 23 课完成：资源所有权已经与词法作用域绑定 ===');

export {};
