// node:assert/strict：断言失败立刻抛 AssertionError。
import assert from 'node:assert/strict';
// node:events：EventEmitter 是常见强引用边来源；addAbortListener 返回 Disposable，
// getEventListeners 用来在测试中"数"还挂着多少 listener，作为泄漏的硬证据。
import {
  addAbortListener,
  EventEmitter,
  getEventListeners,
} from 'node:events';
// node:test：提供 test/t.diagnostic 等接口。
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

// bytesBrand：唯一品牌 symbol。品牌是编译期标记，运行时不存在；用来把"普通 number"
// 和"已通过校验的 Bytes"在类型层面区分，避免把毫秒/条数当成字节传进 LRU。
declare const bytesBrand: unique symbol;
// Bytes：number + 品牌属性。只有经过 bytes() 校验的值才能拿到这个类型。
type Bytes = number & { readonly [bytesBrand]: true };

// bytes：唯一的 Bytes 构造器。品牌不能在调用点手搓，只能走这里——
// 因此"非负安全整数"的运行时不变量被强制收敛在一个函数里。
function bytes(value: number): Bytes {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`bytes 必须是非负安全整数，实际为 ${value}`);
  }
  return value as Bytes;
}

// CacheEntry：缓存条目。value 与它声明的 size 绑定，避免 size 与真实大小脱钩。
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
  // #entries：Map 的插入顺序即 LRU 顺序（最旧在最前）。
  readonly #entries = new Map<Key, CacheEntry<Value>>();
  // #usedBytes：当前已用字节，必须始终与所有 entry.size 之和相等（记账不变量）。
  #usedBytes = 0;

  constructor(readonly maxBytes: Bytes) {
    // maxBytes === 0 会让"任何 entry 都超预算"，缓存永远空——属于配置错误，直接抛。
    if (maxBytes === 0) {
      throw new RangeError('maxBytes 必须大于 0');
    }
  }

  // size getter：暴露条目数，便于测试断言"几条"。
  get size(): number {
    return this.#entries.size;
  }

  // usedBytes getter：返回带品牌的字节计数；走 bytes() 是为了对外只暴露合法 Bytes。
  get usedBytes(): Bytes {
    return bytes(this.#usedBytes);
  }

  // get：命中后把 entry 移到 Map 末尾（最近使用），返回 value。
  get(key: Key): Value | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;

    // 刷新最近使用顺序；value 本身没有被复制。
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  // set：写入或替换 entry；返回 false 表示"单条就超预算，被拒绝"。
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

  // delete：删除 entry 时同步扣减 usedBytes，保证记账不变量不被破坏。
  delete(key: Key): boolean {
    const existing = this.#entries.get(key);
    if (existing === undefined) return false;

    this.#entries.delete(key);
    this.#usedBytes -= existing.size;
    return true;
  }

  // snapshot：返回测试可断言的快照——keys 按从旧到新排列，外加两个字节计数。
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

  // #evictUntilWithinBudget：从最旧 entry 开始淘汰，直到 usedBytes 回到预算内。
  // 每淘汰一条走 delete()，确保 usedBytes 同步扣减。
  #evictUntilWithinBudget(): void {
    while (this.#usedBytes > this.maxBytes) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) {
        // 有字节却没有 entry：记账不变量已被破坏，这是 bug，立即抛错而不是静默。
        throw new Error('缓存记账不变量损坏：有使用字节但没有 entry');
      }
      this.delete(oldest.value);
    }
  }
}

// ToolResult：教学用的工具结果形状，仅一个 output 字符串字段。
type ToolResult = { readonly output: string };

// cacheToolResult：把"算字符串字节数"和"写入缓存"绑在一起，避免调用点漏算 size。
function cacheToolResult(
  cache: ByteBudgetLru<string, ToolResult>,
  key: string,
  output: string,
): boolean {
  // string.length 是 UTF-16 code unit 数，不是网络/Buffer 字节数。
  // 对“你”，length 为 1，而 UTF-8 byteLength 为 3。
  return cache.set(key, { output }, bytes(Buffer.byteLength(output, 'utf8')));
}

// ---------------------------------------------------------------------------
// Test 1：byte-budget LRU 在三种语义（写入、淘汰、replace）下都维持硬上限
// ---------------------------------------------------------------------------
// 这个 test 同时验证多条不变量：
//   1) size 用 UTF-8 字节数（不是 UTF-16 code unit 数）记账。
//   2) get 命中会刷新顺序，使下一次淘汰跳过被命中的 entry。
//   3) 单条超过 maxBytes 的写入被拒绝，而不是先撑爆再清理。
//   4) replace 先减旧 size 再加新 size，usedBytes 不漂移。
test('byte-budget LRU 按 UTF-8 成本记账并维持硬上限', () => {
  // maxBytes=9：刚好能放下后续实验所需的几条小数据。
  const cache = new ByteBudgetLru<string, ToolResult>(bytes(9));

  assert.equal(cacheToolResult(cache, 'a', 'aaaa'), true); // 4 B
  assert.equal(cacheToolResult(cache, 'b', '你'), true);   // 3 B
  // 不变量：4 + 3 = 7，记账与人类手算一致；'你' 按 3 字节而非 1 code unit 计。
  assert.equal(cache.usedBytes, 7);

  // 命中 a 后，a 比 b 更新；插入 c 使总量达到 10 B，应淘汰最旧的 b。
  assert.deepEqual(cache.get('a'), { output: 'aaaa' });
  assert.equal(cacheToolResult(cache, 'c', 'ccc'), true); // 3 B
  // 不变量：淘汰后剩 a(4) + c(3) = 7；顺序 a 在前（较旧）、c 在后（最新）。
  assert.deepEqual(cache.snapshot(), {
    keysFromOldestToNewest: ['a', 'c'],
    usedBytes: 7,
    maxBytes: 9,
  });
  // 被淘汰的 b 已经查不到。
  assert.equal(cache.get('b'), undefined);

  // 单条比整个 budget 还大：拒绝，而不是先撑爆内存再等待 TTL。
  assert.equal(cacheToolResult(cache, 'huge', 'x'.repeat(10)), false);
  assert.equal(cache.get('huge'), undefined);
  // 不变量：拒绝后 usedBytes 仍 <= maxBytes，硬上限永远成立。
  assert.ok(cache.usedBytes <= cache.maxBytes);

  // replace 必须先减旧 size，再加新 size，否则计数会不断漂移。
  assert.equal(cacheToolResult(cache, 'a', 'z'), true);
  // 不变量：a 旧值 4B 被先扣、新值 1B 再加，最终 usedBytes = 7 - 4 + 1 = 4。
  assert.equal(cache.usedBytes, 4);
});

// ---------------------------------------------------------------------------
// 2. Run registry：把 register/unregister 封装进同一个 try/finally 边界
// ---------------------------------------------------------------------------

// RunRegistry：active run 的强引用容器。
// 关键设计：注册与注销被收进 withRun 这一个 try/finally——业务侧无法"忘了注销"。
class RunRegistry<Value> {
  // #active：唯一强引用边来源。只要 id 还在 Map 里，Value 就被 retain。
  readonly #active = new Map<string, Value>();

  get size(): number {
    return this.#active.size;
  }

  has(id: string): boolean {
    return this.#active.has(id);
  }

  // withRun：把 register → operation → unregister 收进一个边界。
  // 无论 operation 正常 resolve、reject 还是抛出，finally 都会执行 delete。
  async withRun<Result>(
    id: string,
    value: Value,
    operation: (value: Value) => Promise<Result>,
  ): Promise<Result> {
    if (this.#active.has(id)) {
      // 重复 id 是配置错误，立即抛——避免静默覆盖造成"幽灵 run"。
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

// Deferred：与 30 课同构——把 Promise 控制器外移，用来做"等被测到达某点"的握手。
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

// waitForAbort：把"等待 signal 被 abort"封装成 awaitable。
// onSubscribed 是握手回调——一注册完 listener 就触发，让调用方知道"我已经在监听了"。
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

// ---------------------------------------------------------------------------
// Test 2：active run 在三种结束路径（成功、失败、取消）下都从强 Map 删除
// ---------------------------------------------------------------------------
// 这个 test 是 RunRegistry 的"边界完备性"测试。三种路径任一漏掉 finally 都会让
// registry.size 永久 > 0，表现为内存泄漏。同时验证 AbortSignal listener 在取消
// 完成后真的回落到 0（避免"取消完仍挂着 listener"的二阶泄漏）。
test('active run 在成功、失败与取消后都从强 Map 删除', async () => {
  const registry = new RunRegistry<{ readonly transcript: string[] }>();

  // 路径一：operation 正常 resolve。
  const value = await registry.withRun(
    'run_ok',
    { transcript: ['hello'] },
    async (state) => state.transcript.length,
  );
  assert.equal(value, 1);
  // 不变量：成功结束后 Map 已清空。
  assert.equal(registry.size, 0);

  // 路径二：operation 抛错。assert.rejects 同时验证 rejection 与错误消息。
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
  // 不变量：抛错路径也走了 finally，Map 仍清空。
  assert.equal(registry.size, 0);

  // 路径三：operation 被 AbortSignal 取消。这是最易漏的路径——
  // 取消本质是 rejection，必须走同一个 finally。
  const controller = new AbortController();
  const subscribed = deferred<void>();
  const cancelling = registry.withRun(
    'run_cancel',
    { transcript: ['large state would be retained by the Map'] },
    async () => waitForAbort(controller.signal, () => subscribed.resolve(undefined)),
  );

  // 握手：等 listener 真的注册好再 abort，否则可能 race 出"已 abort 才注册"。
  await subscribed.promise;
  // 此时 run 还在进行：Map 里仍 retain 着大状态，AbortSignal 上有 1 个 listener。
  assert.equal(registry.has('run_cancel'), true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);

  // 用对象身份作为取消原因，下面断言 reject 出来的就是同一个对象。
  const reason = new Error('cancelled by parent');
  controller.abort(reason);
  // 断言：reject 出来的 error 严格 === 我们传入的 reason（identity 相等）。
  await assert.rejects(cancelling, (error: unknown) => error === reason);

  // 不变量：取消路径也清空了 Map，且 AbortSignal 上的 listener 回落到 0。
  assert.equal(registry.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

// ---------------------------------------------------------------------------
// 3. EventEmitter：监听器数组是一条强引用边，订阅必须是资源
// ---------------------------------------------------------------------------

// TokenSubscription：把"订阅 + 清理"封装成 Disposable。
// 关键点：listener 闭包会捕获外部状态（如 transcript），只要 listener 还在 bus 上，
// 那些状态就被 retain——必须用 [Symbol.dispose] 把清理绑定到作用域生命周期。
class TokenSubscription implements Disposable {
  #disposed = false;

  constructor(
    private readonly bus: EventEmitter,
    private readonly listener: (token: string) => void,
  ) {
    // 构造即订阅：把 listener 挂到 bus 上，建立一条强引用边。
    bus.on('token', listener);
  }

  // 幂等 dispose：多次调用安全；首次调用时把 listener 从 bus 上摘下来。
  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.bus.off('token', this.listener);
  }
}

// observeWithinScope：演示 using 语法如何把订阅生命周期绑到函数作用域。
// 无论函数正常返回还是中途 throw，subscription 都会被确定性 dispose。
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

  // scope 内：listener 已挂上，listenerCount 必为 1。
  assert.equal(bus.listenerCount('token'), 1);
  bus.emit('token', '!');
  // shouldThrow=true 模拟 scope 中途失败，用来验证 throw 路径也触发 dispose。
  if (shouldThrow) throw new Error('scope failed');
  return observedLength;
}

// ---------------------------------------------------------------------------
// Test 3：Disposable 订阅在正常返回与 throw 两条路径都摘除 retaining edge
// ---------------------------------------------------------------------------
// 这是 using 语法的核心契约：作用域结束（无论怎么结束）都必须 dispose。
// 失败模式是"忘记 removeListener"——会让全局 bus 长期 retain 闭包数据。
test('Disposable 订阅在正常和 throw 路径都移除 retaining edge', () => {
  const bus = new EventEmitter();
  const transcript = ['prompt', 'tool output'];

  // 正常路径：observeWithinScope 返回 18 = 'prompttool output'.length + '!'.length。
  // 'prompt'(6) + 'tool output'(11) + '!'(1) = 18。
  assert.equal(observeWithinScope(bus, transcript, false), 18);
  // 不变量：函数返回后 listener 被摘除，listenerCount 回到 0。
  assert.equal(bus.listenerCount('token'), 0);

  // 异常路径：scope 中途 throw，using 仍要 dispose。
  assert.throws(() => observeWithinScope(bus, transcript, true), /scope failed/);
  // 不变量：throw 路径也清零了 listener——这就是 using 相比手动 try/finally 的价值。
  assert.equal(bus.listenerCount('token'), 0);
});

// ---------------------------------------------------------------------------
// 4. WeakMap / FinalizationRegistry：只能做附属关联和非关键诊断
// ---------------------------------------------------------------------------

// RunObject：业务对象身份（仅 id 字段就足以作为 WeakMap 的 key）。
type RunObject = { readonly id: string };
// DebugMetadata：附属诊断信息，与 RunObject 的核心生命周期解耦。
type DebugMetadata = { readonly createdAt: number };

// ---------------------------------------------------------------------------
// Test 4：WeakMap 故意不可枚举，FinalizationRegistry 不能承担业务清理
// ---------------------------------------------------------------------------
// 验证两点：
//   1) WeakMap 没有 size/keys（类型层面也拒绝），否则 GC 时机会让结果不可预测。
//   2) FinalizationRegistry 的 callback 不应承载业务逻辑——只能显式 unregister。
test('WeakMap 适合对象 metadata，但故意不能枚举或统计容量', () => {
  const metadata = new WeakMap<RunObject, DebugMetadata>();
  const run = { id: 'run_weak' };
  metadata.set(run, { createdAt: 123 });

  // 不变量：WeakMap 能按对象身份取到附属 metadata。
  assert.deepEqual(metadata.get(run), { createdAt: 123 });

  // WeakMap 没有 size/keys：若能枚举，结果会受不可预测的 GC 时机影响。
  // @ts-expect-error -- 这是有意保留的负向类型契约。
  assert.equal(metadata.size, undefined);

  // Finalization callback 不能作为业务清理契约；这里仅验证显式 unregister。
  // 我们绝不写“等待 N ms 后 callback 必须执行”这种 flaky 测试。
  // 如果未来代码意外依赖 finalizer 做清理，下面的 throw 会在它触发时暴露。
  const finalizer = new FinalizationRegistry<string>(() => {
    throw new Error('本测试已 unregister，finalizer 不应承担业务逻辑');
  });
  const unregisterToken = {};
  finalizer.register(run, run.id, unregisterToken);
  // 不变量：显式 unregister 返回 true，callback 永远不会因为 run 被 GC 而触发。
  assert.equal(finalizer.unregister(unregisterToken), true);
});

// ---------------------------------------------------------------------------
// 5. 指标是不同内存层的观测值，不是一个可以互换的“已用内存”数字
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test 5：memoryUsage 暴露的是分层指标，必须分开解释
// ---------------------------------------------------------------------------
// 这个 test 不对"具体多少字节"做断言（机器、Node 版本、并行负载都会变），
// 只验证"每个字段都是合法 byte 值"以及"已知包含关系（arrayBuffers ⊆ external）"。
test('memoryUsage 同时暴露 V8 heap、外部内存、ArrayBuffer 与 RSS', (t) => {
  const sample = process.memoryUsage();

  // 不变量一：所有字段都是非负安全整数 byte；否则后续比较无意义。
  for (const [name, value] of Object.entries(sample)) {
    assert.equal(Number.isSafeInteger(value), true, `${name} 应是安全整数 byte`);
    assert.ok(value >= 0, `${name} 不应为负数`);
  }

  // Node 文档定义 arrayBuffers 包含所有 Node Buffer，并计入 external。
  // 不变量二：arrayBuffers 是 external 的子集。
  assert.ok(sample.arrayBuffers <= sample.external);
  // 不变量三：heapUsed 不超过 heapTotal（已用 ≤ 总分配）。
  assert.ok(sample.heapUsed <= sample.heapTotal);

  // 数字只用于观测，不对具体大小做断言；机器、Node/V8 版本和并行负载都会影响它。
  // t.diagnostic 把当前数值作为诊断信息打印，便于人眼对照而非机器断言。
  t.diagnostic(JSON.stringify({
    rss: sample.rss,
    heapUsed: sample.heapUsed,
    external: sample.external,
    arrayBuffers: sample.arrayBuffers,
  }));
});

export {};
