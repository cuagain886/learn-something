import assert from 'node:assert/strict';
import {
  addAbortListener,
  EventEmitter,
  getEventListeners,
} from 'node:events';
import test from 'node:test';

/**
 * 第 31 课：内存生命周期、强引用边与确定性泄漏契约
 *
 * 这组实验刻意不使用 `global.gc()`，也不对 `heapUsed` 的精确下降做断言。
 * GC 的调度、JIT 和测试框架自身分配都会让这种断言 flaky。
 *
 * 我们改为验证真正由业务控制的 retaining edge：
 *   1. 长期容器有明确 byte budget；
 *   2. active run 在成功、失败和取消后都会从 Map 删除；
 *   3. EventEmitter / AbortSignal listener 在 scope 结束后回到基线；
 *   4. WeakMap 只承载附属 metadata，不承担可枚举注册表职责；
 *   5. Node 的 heap / external / ArrayBuffer 指标必须分开解释。
 */

// ---------------------------------------------------------------------------
// 1. 用品牌避免把“字节、条数、毫秒”误传，但运行时构造仍必须验证
// ---------------------------------------------------------------------------

declare const bytesBrand: unique symbol;
type Bytes = number & { readonly [bytesBrand]: true };

function bytes(value: number): Bytes {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`bytes 必须是非负安全整数，实际为 ${value}`);
  }
  return value as Bytes;
}

type CacheEntry<Value> = {
  readonly value: Value;
  readonly size: Bytes;
};

/**
 * 一个教学用 byte-budget LRU。
 *
 * Map 保持插入顺序：get 命中时通过 delete + set 把 entry 移到末尾；
 * 超预算时从最旧 entry 开始淘汰。生产实现还应加入 maxEntries、TTL、
 * 并发控制、淘汰指标和更准确的 size estimator。
 */
class ByteBudgetLru<Key, Value> {
  readonly #entries = new Map<Key, CacheEntry<Value>>();
  #usedBytes = 0;

  constructor(readonly maxBytes: Bytes) {
    if (maxBytes === 0) {
      throw new RangeError('maxBytes 必须大于 0');
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  get usedBytes(): Bytes {
    return bytes(this.#usedBytes);
  }

  get(key: Key): Value | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;

    // 刷新最近使用顺序；value 本身没有被复制。
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: Key, value: Value, size: Bytes): boolean {
    // replace 的语义是先移除旧 entry。若新值单条就超预算，最终 key 不存在，
    // 避免调用者误以为缓存中仍是刚传入的新值。
    this.delete(key);
    if (size > this.maxBytes) return false;

    this.#entries.set(key, { value, size });
    this.#usedBytes += size;
    this.#evictUntilWithinBudget();
    return true;
  }

  delete(key: Key): boolean {
    const existing = this.#entries.get(key);
    if (existing === undefined) return false;

    this.#entries.delete(key);
    this.#usedBytes -= existing.size;
    return true;
  }

  snapshot(): {
    readonly keysFromOldestToNewest: readonly Key[];
    readonly usedBytes: Bytes;
    readonly maxBytes: Bytes;
  } {
    return {
      keysFromOldestToNewest: [...this.#entries.keys()],
      usedBytes: this.usedBytes,
      maxBytes: this.maxBytes,
    };
  }

  #evictUntilWithinBudget(): void {
    while (this.#usedBytes > this.maxBytes) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) {
        throw new Error('缓存记账不变量损坏：有使用字节但没有 entry');
      }
      this.delete(oldest.value);
    }
  }
}

type ToolResult = { readonly output: string };

function cacheToolResult(
  cache: ByteBudgetLru<string, ToolResult>,
  key: string,
  output: string,
): boolean {
  // string.length 是 UTF-16 code unit 数，不是网络/Buffer 字节数。
  // 对“你”，length 为 1，而 UTF-8 byteLength 为 3。
  return cache.set(key, { output }, bytes(Buffer.byteLength(output, 'utf8')));
}

test('byte-budget LRU 按 UTF-8 成本记账并维持硬上限', () => {
  const cache = new ByteBudgetLru<string, ToolResult>(bytes(9));

  assert.equal(cacheToolResult(cache, 'a', 'aaaa'), true); // 4 B
  assert.equal(cacheToolResult(cache, 'b', '你'), true);   // 3 B
  assert.equal(cache.usedBytes, 7);

  // 命中 a 后，a 比 b 更新；插入 c 使总量达到 10 B，应淘汰最旧的 b。
  assert.deepEqual(cache.get('a'), { output: 'aaaa' });
  assert.equal(cacheToolResult(cache, 'c', 'ccc'), true); // 3 B
  assert.deepEqual(cache.snapshot(), {
    keysFromOldestToNewest: ['a', 'c'],
    usedBytes: 7,
    maxBytes: 9,
  });
  assert.equal(cache.get('b'), undefined);

  // 单条比整个 budget 还大：拒绝，而不是先撑爆内存再等待 TTL。
  assert.equal(cacheToolResult(cache, 'huge', 'x'.repeat(10)), false);
  assert.equal(cache.get('huge'), undefined);
  assert.ok(cache.usedBytes <= cache.maxBytes);

  // replace 必须先减旧 size，再加新 size，否则计数会不断漂移。
  assert.equal(cacheToolResult(cache, 'a', 'z'), true);
  assert.equal(cache.usedBytes, 4);
});

// ---------------------------------------------------------------------------
// 2. Run registry：把 register/unregister 封装进同一个 try/finally 边界
// ---------------------------------------------------------------------------

class RunRegistry<Value> {
  readonly #active = new Map<string, Value>();

  get size(): number {
    return this.#active.size;
  }

  has(id: string): boolean {
    return this.#active.has(id);
  }

  async withRun<Result>(
    id: string,
    value: Value,
    operation: (value: Value) => Promise<Result>,
  ): Promise<Result> {
    if (this.#active.has(id)) {
      throw new Error(`duplicate run id: ${id}`);
    }

    this.#active.set(id, value);
    try {
      return await operation(value);
    } finally {
      // Promise resolve/reject、throw、AbortError 都汇合到同一删除点。
      this.#active.delete(id);
    }
  }
}

type Deferred<Value> = {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (reason: unknown) => void;
};

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForAbort(
  signal: AbortSignal,
  onSubscribed: () => void,
): Promise<never> {
  if (signal.aborted) throw signal.reason;

  const aborted = deferred<never>();

  // Node 的 addAbortListener 返回 Disposable。using 的 scope 跨过 await：
  // Promise reject 后离开函数，listener 会被确定性移除。
  using subscription = addAbortListener(signal, () => {
    aborted.reject(signal.reason);
  });

  onSubscribed();
  return await aborted.promise;
}

test('active run 在成功、失败与取消后都从强 Map 删除', async () => {
  const registry = new RunRegistry<{ readonly transcript: string[] }>();

  const value = await registry.withRun(
    'run_ok',
    { transcript: ['hello'] },
    async (state) => state.transcript.length,
  );
  assert.equal(value, 1);
  assert.equal(registry.size, 0);

  await assert.rejects(
    registry.withRun(
      'run_error',
      { transcript: ['will fail'] },
      async () => {
        throw new Error('tool failed');
      },
    ),
    /tool failed/,
  );
  assert.equal(registry.size, 0);

  const controller = new AbortController();
  const subscribed = deferred<void>();
  const cancelling = registry.withRun(
    'run_cancel',
    { transcript: ['large state would be retained by the Map'] },
    async () => waitForAbort(controller.signal, () => subscribed.resolve(undefined)),
  );

  await subscribed.promise;
  assert.equal(registry.has('run_cancel'), true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);

  const reason = new Error('cancelled by parent');
  controller.abort(reason);
  await assert.rejects(cancelling, (error: unknown) => error === reason);

  assert.equal(registry.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

// ---------------------------------------------------------------------------
// 3. EventEmitter：监听器数组是一条强引用边，订阅必须是资源
// ---------------------------------------------------------------------------

class TokenSubscription implements Disposable {
  #disposed = false;

  constructor(
    private readonly bus: EventEmitter,
    private readonly listener: (token: string) => void,
  ) {
    bus.on('token', listener);
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.bus.off('token', this.listener);
  }
}

function observeWithinScope(
  bus: EventEmitter,
  transcript: readonly string[],
  shouldThrow: boolean,
): number {
  let observedLength = 0;

  // listener 闭包捕获 transcript。如果忘记 dispose，global bus 会通过 listener
  // 保活整份 transcript；函数返回、局部变量离开源码作用域都无济于事。
  using subscription = new TokenSubscription(bus, (token) => {
    observedLength = transcript.join('').length + token.length;
  });

  assert.equal(bus.listenerCount('token'), 1);
  bus.emit('token', '!');
  if (shouldThrow) throw new Error('scope failed');
  return observedLength;
}

test('Disposable 订阅在正常和 throw 路径都移除 retaining edge', () => {
  const bus = new EventEmitter();
  const transcript = ['prompt', 'tool output'];

  assert.equal(observeWithinScope(bus, transcript, false), 18);
  assert.equal(bus.listenerCount('token'), 0);

  assert.throws(() => observeWithinScope(bus, transcript, true), /scope failed/);
  assert.equal(bus.listenerCount('token'), 0);
});

// ---------------------------------------------------------------------------
// 4. WeakMap / FinalizationRegistry：只能做附属关联和非关键诊断
// ---------------------------------------------------------------------------

type RunObject = { readonly id: string };
type DebugMetadata = { readonly createdAt: number };

test('WeakMap 适合对象 metadata，但故意不能枚举或统计容量', () => {
  const metadata = new WeakMap<RunObject, DebugMetadata>();
  const run = { id: 'run_weak' };
  metadata.set(run, { createdAt: 123 });

  assert.deepEqual(metadata.get(run), { createdAt: 123 });

  // WeakMap 没有 size/keys：若能枚举，结果会受不可预测的 GC 时机影响。
  // @ts-expect-error -- 这是有意保留的负向类型契约。
  assert.equal(metadata.size, undefined);

  // Finalization callback 不能作为业务清理契约；这里仅验证显式 unregister。
  // 我们绝不写“等待 N ms 后 callback 必须执行”这种 flaky 测试。
  const finalizer = new FinalizationRegistry<string>(() => {
    throw new Error('本测试已 unregister，finalizer 不应承担业务逻辑');
  });
  const unregisterToken = {};
  finalizer.register(run, run.id, unregisterToken);
  assert.equal(finalizer.unregister(unregisterToken), true);
});

// ---------------------------------------------------------------------------
// 5. 指标是不同内存层的观测值，不是一个可以互换的“已用内存”数字
// ---------------------------------------------------------------------------

test('memoryUsage 同时暴露 V8 heap、外部内存、ArrayBuffer 与 RSS', (t) => {
  const sample = process.memoryUsage();

  for (const [name, value] of Object.entries(sample)) {
    assert.equal(Number.isSafeInteger(value), true, `${name} 应是安全整数 byte`);
    assert.ok(value >= 0, `${name} 不应为负数`);
  }

  // Node 文档定义 arrayBuffers 包含所有 Node Buffer，并计入 external。
  assert.ok(sample.arrayBuffers <= sample.external);
  assert.ok(sample.heapUsed <= sample.heapTotal);

  // 数字只用于观测，不对具体大小做断言；机器、Node/V8 版本和并行负载都会影响它。
  t.diagnostic(JSON.stringify({
    rss: sample.rss,
    heapUsed: sample.heapUsed,
    external: sample.external,
    arrayBuffers: sample.arrayBuffers,
  }));
});

export {};
