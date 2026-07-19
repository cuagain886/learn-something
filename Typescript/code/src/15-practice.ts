/**
 * ============================================================
 * 第 15 课：可重入、可取消的类型安全事件系统
 * ============================================================
 *
 * 运行：npx tsx src/15-practice.ts
 *
 * “事件名关联 payload”只是起点。真实事件系统还必须回答：
 *
 * - void 事件能否写成 emit('ready')，而不是被迫传 undefined？
 * - once 回调里同步重入 emit 时，会不会执行两次？
 * - dispatch 期间新增/删除 listener，本轮快照如何定义？
 * - 一个 listener 抛错，是否阻止其它 listener？
 * - AbortSignal 取消后，事件集合是否仍保留 listener 强引用？
 * - async 函数为何能偷偷赋给 `() => void`，怎样在同步总线中拒绝它？
 *
 * 本实现用一处局部断言跨过异构 Map 的存储边界，公共 API 保持完整相关性。
 */

import assert from 'node:assert/strict';

/** `[T]` 阻止条件类型对 union payload 分发。 */
type EmitArgs<Payload> = [Payload] extends [void]
  ? []
  : [payload: Payload];

/**
 * 返回 `undefined` 而不是 `void` 是刻意的：
 *
 * - 普通无返回值回调在现代 TS 中可以上下文类型化为 undefined；
 * - async 回调返回 Promise<void>，不能赋给 undefined；
 * - 若写 `void`，TS 的特殊回调规则会允许调用方返回任意值，包括 Promise。
 *
 * 这个事件总线是同步的，因此不接受它无法观察 rejection 的 async listener。
 */
type SyncListener<Payload> = (payload: Payload) => undefined;
type ErasedListener = (payload: unknown) => undefined;

type Unsubscribe = () => boolean;

interface ListenOptions {
  readonly signal?: AbortSignal;
}

class TypedEmitter<Events extends object> {
  /**
   * 不使用 `Record<string, unknown>` 约束：普通 interface 没有隐式字符串索引签名，
   * 但这不妨碍它作为有限事件表。keyof object 类型天然仍属于 PropertyKey。
   */
  readonly #listeners = new Map<keyof Events, Set<ErasedListener>>();

  on<Key extends keyof Events>(
    event: Key,
    listener: SyncListener<Events[Key]>,
    options: ListenOptions = {},
  ): Unsubscribe {
    if (options.signal?.aborted === true) {
      return () => false;
    }

    let bucket = this.#listeners.get(event);
    if (bucket === undefined) {
      bucket = new Set();
      this.#listeners.set(event, bucket);
    }

    /**
     * 唯一的类型断言位于私有存储适配器中。
     * 证明依据：闭包同时捕获同一个 Key 和 SyncListener<Events[Key]>；唯一调用入口
     * emit<Key> 又把同一个 Key 与 Events[Key] 绑定。外部无法直接写 #listeners。
     */
    const erased: ErasedListener = (payload) => {
      return listener(payload as Events[Key]);
    };

    let active = true;

    const unsubscribe: Unsubscribe = () => {
      if (!active) {
        return false;
      }
      active = false;

      options.signal?.removeEventListener('abort', onAbort);
      const removed = bucket.delete(erased);
      if (bucket.size === 0) {
        this.#listeners.delete(event);
      }
      return removed;
    };

    const onAbort = (): void => {
      unsubscribe();
    };

    bucket.add(erased);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    return unsubscribe;
  }

  once<Key extends keyof Events>(
    event: Key,
    listener: SyncListener<Events[Key]>,
    options: ListenOptions = {},
  ): Unsubscribe {
    let unsubscribe: Unsubscribe = () => false;

    const wrapper: SyncListener<Events[Key]> = (payload) => {
      // 必须先移除再调用用户代码；否则用户代码同步重入 emit 会再次命中 once。
      unsubscribe();
      return listener(payload);
    };

    unsubscribe = this.on(event, wrapper, options);
    return unsubscribe;
  }

  emit<Key extends keyof Events>(
    event: Key,
    ...args: EmitArgs<Events[Key]>
  ): number {
    const bucket = this.#listeners.get(event);
    if (bucket === undefined) {
      return 0;
    }

    // 快照语义：本轮开始时存在的监听器都会运行；本轮新增的留到下一次。
    // 因此某 listener 在 dispatch 中移除另一个 listener，不影响当前快照。
    const snapshot = [...bucket];
    const payload: unknown = args[0];
    const failures: unknown[] = [];

    for (const listener of snapshot) {
      try {
        listener(payload);
      } catch (error: unknown) {
        // 保证观测/审计 listener 不会因前一个业务 listener 失败而被跳过。
        failures.push(error);
      }
    }

    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `${String(event)} 的 ${failures.length} 个监听器失败`,
      );
    }

    return snapshot.length;
  }

  listenerCount<Key extends keyof Events>(event: Key): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  clear<Key extends keyof Events>(event: Key): number {
    const count = this.listenerCount(event);
    this.#listeners.delete(event);
    return count;
  }
}

// interface 可以直接作为事件表；不需要为了满足 Record 而改写成 type alias。
interface AppEvents {
  ready: void;
  token: {
    readonly sequence: number;
    readonly text: string;
  };
  failure: {
    readonly runId: string;
    readonly cause: unknown;
  };
}

const bus = new TypedEmitter<AppEvents>();

// ------------------------------------------------------------
// 1. payload 相关性与 void 事件调用体验
// ------------------------------------------------------------

let readyCalls = 0;
bus.on('ready', () => {
  readyCalls += 1;
  // TS 5.1+ 允许上下文返回 undefined 的函数省略显式 return。
});

assert.equal(bus.emit('ready'), 1);
assert.equal(readyCalls, 1);

if (false) {
  // @ts-expect-error void 事件的参数元组是 []，不应再传显式 payload。
  bus.emit('ready', undefined);

  // @ts-expect-error token payload 缺少 sequence。
  bus.emit('token', { text: 'partial' });

  // @ts-expect-error 不存在的事件名在编译期被拒绝。
  bus.emit('unknown', { value: 1 });

  // @ts-expect-error 同步总线拒绝 Promise<void>，避免产生无人观察的 rejection。
  bus.on('token', async (_event) => {});
}

// ------------------------------------------------------------
// 2. once 先取消，再执行用户回调，因此同步重入仍只运行一次
// ------------------------------------------------------------

let onceCalls = 0;
bus.once('ready', () => {
  onceCalls += 1;
  bus.emit('ready');
  return undefined;
});

bus.emit('ready');
assert.equal(onceCalls, 1);

// ready 的持久 listener：第一次外层、一次重入，共运行两次；加上前面的首次 emit。
assert.equal(readyCalls, 3);
assert.equal(bus.listenerCount('ready'), 1);

// ------------------------------------------------------------
// 3. dispatch 使用起始快照
// ------------------------------------------------------------

const dispatchLog: string[] = [];
let removeSecond: Unsubscribe = () => false;

bus.on('token', (event) => {
  dispatchLog.push(`first:${event.sequence}`);
  removeSecond();

  bus.on('token', (laterEvent) => {
    dispatchLog.push(`late:${laterEvent.sequence}`);
    return undefined;
  });
  return undefined;
});

removeSecond = bus.on('token', (event) => {
  dispatchLog.push(`second:${event.sequence}`);
  return undefined;
});

assert.equal(bus.emit('token', { sequence: 1, text: 'A' }), 2);
assert.deepEqual(dispatchLog, ['first:1', 'second:1']);
assert.equal(bus.listenerCount('token'), 2);

// 第二轮开始时有 first 与第一轮新增的 late；first 在本轮新增的第二个 late 不运行。
assert.equal(bus.emit('token', { sequence: 2, text: 'B' }), 2);
assert.deepEqual(dispatchLog, [
  'first:1',
  'second:1',
  'first:2',
  'late:2',
]);
assert.equal(bus.listenerCount('token'), 3);

// ------------------------------------------------------------
// 4. AbortSignal 自动删除 retaining edge，unsubscribe 幂等
// ------------------------------------------------------------

const controller = new AbortController();
let failureCalls = 0;

const unsubscribeFailure = bus.on(
  'failure',
  () => {
    failureCalls += 1;
    return undefined;
  },
  { signal: controller.signal },
);

assert.equal(bus.listenerCount('failure'), 1);
controller.abort();
assert.equal(bus.listenerCount('failure'), 0);
assert.equal(unsubscribeFailure(), false);
assert.equal(
  bus.emit('failure', { runId: 'run-1', cause: new Error('ignored') }),
  0,
);
assert.equal(failureCalls, 0);

const alreadyAborted = AbortSignal.abort();
const inactive = bus.on(
  'failure',
  () => undefined,
  { signal: alreadyAborted },
);
assert.equal(inactive(), false);
assert.equal(bus.listenerCount('failure'), 0);

// ------------------------------------------------------------
// 5. 所有同步 listener 都执行，之后再聚合失败
// ------------------------------------------------------------

const failureOrder: string[] = [];

bus.on('failure', () => {
  failureOrder.push('first');
  throw new Error('first listener failed');
});

bus.on('failure', () => {
  failureOrder.push('second');
  throw { code: 'SECOND_FAILURE' };
});

assert.throws(
  () => bus.emit('failure', { runId: 'run-2', cause: 'root cause' }),
  (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    return true;
  },
);
assert.deepEqual(failureOrder, ['first', 'second']);

assert.equal(bus.clear('token'), 3);
assert.equal(bus.listenerCount('token'), 0);

console.log('=== 第 15 课：生产级同步事件系统 ===');
console.log({
  readyCalls,
  onceCalls,
  dispatchLog,
  failureOrder,
  tokenListenersAfterClear: bus.listenerCount('token'),
});

export { TypedEmitter };
export type { AppEvents, EmitArgs, ListenOptions, SyncListener, Unsubscribe };
