/**
 * ============================================================
 * 第 15 课：可重入、可取消的类型安全事件系统
 * ============================================================
 *
 * 运行：npx tsx src/15-practice.ts
 *
 * "事件名关联 payload"只是起点。真实事件系统还必须回答：
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

// node:assert/strict 既是运行时断言库，也让本课在每个 console 输出背后有等价 assert 兜底。
import assert from 'node:assert/strict';

// EmitArgs 把"事件是否携带 payload"编码成 emit 的可变参数元组形状：
//   - void 事件 → []：调用方写 emit('ready')，不必显式传 undefined；
//   - 非 void 事件 → [payload: Payload]：必须恰好传一个。
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

// ErasedListener：所有不同 payload 类型的 listener 进入私有 Map 时被擦除成这个统一签名。
// payload 用 unknown 而不是 any：强制实现内部在使用前先做类型收窄，禁止直接调用 payload 的方法。
type ErasedListener = (payload: unknown) => undefined;

// Unsubscribe：on/once 的返回值；boolean 表示"本次调用是否真的移除了一个 listener"，重复调用幂等。
type Unsubscribe = () => boolean;

// ListenOptions：目前只暴露 AbortSignal；外部信号一旦 abort，本总线自动联动取消订阅。
interface ListenOptions {
  readonly signal?: AbortSignal;
}

// TypedEmitter：同步、类型安全、可重入、可取消的事件总线。
// 类型参数 Events 是"事件名 → payload"的有限映射表；普通 interface 即可作为入参，无需 Record。
class TypedEmitter<Events extends object> {
  /**
   * 不使用 `Record<string, unknown>` 约束：普通 interface 没有隐式字符串索引签名，
   * 但这不妨碍它作为有限事件表。keyof object 类型天然仍属于 PropertyKey。
   */
  readonly #listeners = new Map<keyof Events, Set<ErasedListener>>();

  // on：订阅事件，返回取消函数。Key 同时约束"事件名"和"listener 的 payload 类型"，
  // 因此调用点无法写出"事件名/payload 不匹配"的组合。
  on<Key extends keyof Events>(
    event: Key,
    listener: SyncListener<Events[Key]>,
    options: ListenOptions = {},
  ): Unsubscribe {
    // signal 已经 abort：视为本次订阅从未生效，避免往 Set 里塞一个永不触发的 listener。
    if (options.signal?.aborted === true) {
      return () => false;
    }

    // 懒初始化：第一次有人订阅某事件时才创建对应 Set。
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
    // erased：把强类型 listener 适配成"以 unknown 为参数"的存储形态；
    // 运行时 emit 传入的就是 Events[Key]，断言 payload as Events[Key] 在该闭包内是安全的。
    const erased: ErasedListener = (payload) => {
      return listener(payload as Events[Key]);
    };

    // active 标记当前订阅是否仍然存活；unsubscribe 后置为 false，使重复调用幂等。
    let active = true;

    // unsubscribe：从 bucket 中删除 erased，并清理 abort 监听器，避免悬挂引用。
    const unsubscribe: Unsubscribe = () => {
      if (!active) {
        return false;
      }
      active = false;

      // 同步从 signal 上摘掉 onAbort；否则一次订阅被取消后还会挂在 signal 上直到 signal abort。
      options.signal?.removeEventListener('abort', onAbort);
      const removed = bucket.delete(erased);
      // bucket 空了顺手删掉 Map 项，避免持有一个空 Set。
      if (bucket.size === 0) {
        this.#listeners.delete(event);
      }
      return removed;
    };

    // onAbort：signal abort 时等价于调用一次 unsubscribe，达到"被动取消"效果。
    const onAbort = (): void => {
      unsubscribe();
    };

    bucket.add(erased);
    // once: true 作为双保险：即使我们没及时摘除，运行时也会在触发后自动回收。
    options.signal?.addEventListener('abort', onAbort, { once: true });

    return unsubscribe;
  }

  // once：注册"只触发一次"的监听器；返回 unsubscribe 仍可提前手动取消。
  // 关键顺序：触发时先 unsubscribe 自己，再调用用户代码——
  // 即便用户代码同步重入 emit 同一事件，监听器已经不在 bucket 中，不会被二次命中。
  once<Key extends keyof Events>(
    event: Key,
    listener: SyncListener<Events[Key]>,
    options: ListenOptions = {},
  ): Unsubscribe {
    // 先用一个 no-op 占位，wrapper 闭包要捕获它才能在触发时调用；
    // 紧接着被 on 返回的真正 unsubscribe 覆盖。
    let unsubscribe: Unsubscribe = () => false;

    // wrapper：先摘掉自己，再转发 payload 给用户 listener。
    const wrapper: SyncListener<Events[Key]> = (payload) => {
      // 必须先移除再调用用户代码；否则用户代码同步重入 emit 会再次命中 once。
      unsubscribe();
      return listener(payload);
    };

    unsubscribe = this.on(event, wrapper, options);
    return unsubscribe;
  }

  // emit：触发事件并返回本轮执行的 listener 数量。
  // void 事件省略 payload；本轮按"起始快照"执行，listener 抛错不中断后续，全部跑完后再聚合抛出。
  emit<Key extends keyof Events>(
    event: Key,
    ...args: EmitArgs<Events[Key]>
  ): number {
    const bucket = this.#listeners.get(event);
    // 无人订阅：本轮返回 0，不视为错误。
    if (bucket === undefined) {
      return 0;
    }

    // 快照语义：本轮开始时存在的监听器都会运行；本轮新增的留到下一次。
    // 因此某 listener 在 dispatch 中移除另一个 listener，不影响当前快照。
    const snapshot = [...bucket];
    const payload: unknown = args[0]; // void 事件 args 是 []，这里取到 undefined。
    const failures: unknown[] = []; // 收集本轮所有抛错的错误对象，跑完再统一处理。

    for (const listener of snapshot) {
      try {
        listener(payload);
      } catch (error: unknown) {
        // 保证观测/审计 listener 不会因前一个业务 listener 失败而被跳过。
        failures.push(error);
      }
    }

    // 本轮结束后再决定如何抛错：单个直接重抛，多个包成 AggregateError。
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

  // listenerCount：查询某事件当前的订阅数量；未订阅返回 0。
  listenerCount<Key extends keyof Events>(event: Key): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  // clear：清空某事件的全部 listener，返回被移除的数量（仍受 Key 约束，无法写错事件名）。
  clear<Key extends keyof Events>(event: Key): number {
    const count = this.listenerCount(event);
    this.#listeners.delete(event);
    return count;
  }
}

// interface 可以直接作为事件表；不需要为了满足 Record 而改写成 type alias。
// 每个 key 是事件名，value 是该事件的 payload 类型；void 表示无载荷事件。
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

// 实例化一个事件总线，后续所有 on/emit 都受 AppEvents 约束。
const bus = new TypedEmitter<AppEvents>();

// ------------------------------------------------------------
// 1. payload 相关性与 void 事件调用体验
// ------------------------------------------------------------
// 验证：监听器签名受 payload 类型驱动；void 事件可省略 payload 直接 emit('ready')。

// readyCalls：累计 'ready' 持久监听器的触发次数，用于验证多轮 dispatch 的运行计数。
let readyCalls = 0;
bus.on('ready', () => {
  readyCalls += 1;
  // TS 5.1+ 允许上下文返回 undefined 的函数省略显式 return。
});

// void 事件无需 payload；返回 1 表示本轮执行了 1 个监听器。
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
// 验证：once 监听器内部同步重入 emit 同一事件，once 也只算被触发 1 次。

// onceCalls：核对 once 监听器是否真的只触发 1 次（即便内部重入 emit）。
let onceCalls = 0;
bus.once('ready', () => {
  onceCalls += 1;
  bus.emit('ready'); // 重入：此时 once 自身已被摘除，不会再命中自己。
  return undefined;
});

// 外层 emit('ready') 触发 once；once 内部又 emit 一次，命中持久监听器但不再命中自己。
bus.emit('ready');
assert.equal(onceCalls, 1);

// ready 的持久 listener：第一次外层、一次重入，共运行两次；加上前面的首次 emit。
assert.equal(readyCalls, 3);
// once 已自动取消，剩余订阅里只有最初那个持久监听器。
assert.equal(bus.listenerCount('ready'), 1);

// ------------------------------------------------------------
// 3. dispatch 使用起始快照
// ------------------------------------------------------------
// 验证：本轮 listener 集合在 emit 调用瞬间就被锁定；本轮新增/删除都影响下一轮。

// dispatchLog：按顺序记录每次监听器触发的内容，用来核对快照边界。
const dispatchLog: string[] = [];
// removeSecond 由外部持有，让"第一个监听器"在运行时能取消"第二个监听器"。
let removeSecond: Unsubscribe = () => false;

// 第一个 token 监听器：记录 sequence、取消 second、再注册一个 late。
bus.on('token', (event) => {
  dispatchLog.push(`first:${event.sequence}`);
  removeSecond();

  // 本轮运行中新增的 late 不会在当前 emit 中执行，留到下一轮。
  bus.on('token', (laterEvent) => {
    dispatchLog.push(`late:${laterEvent.sequence}`);
    return undefined;
  });
  return undefined;
});

// 保存第二个监听器的 unsubscribe，供第一个监听器在运行时调用。
removeSecond = bus.on('token', (event) => {
  dispatchLog.push(`second:${event.sequence}`);
  return undefined;
});

// 第一轮 snapshot=[first, second]：first 调用 removeSecond() 把 second 从 Set 删除，
// 但 second 已在 snapshot 里照常运行；late 是本轮新增不运行。
assert.equal(bus.emit('token', { sequence: 1, text: 'A' }), 2);
assert.deepEqual(dispatchLog, ['first:1', 'second:1']);
// 本轮结束时 Set 里只剩 first（second 已删），但下一轮 late 才会出现。
assert.equal(bus.listenerCount('token'), 2);

// 第二轮开始时有 first 与第一轮新增的 late；first 在本轮新增的第二个 late 不运行。
assert.equal(bus.emit('token', { sequence: 2, text: 'B' }), 2);
assert.deepEqual(dispatchLog, [
  'first:1',
  'second:1',
  'first:2',
  'late:2',
]);
// 本轮又新增一个 late，所以 Set 里现在有 3 个 listener。
assert.equal(bus.listenerCount('token'), 3);

// ------------------------------------------------------------
// 4. AbortSignal 自动删除 retaining edge，unsubscribe 幂等
// ------------------------------------------------------------
// 验证：AbortSignal abort 时自动联动取消订阅；之后再手动 unsubscribe 是幂等的。

// controller：用来在测试里手动触发 abort 信号。
const controller = new AbortController();
// failureCalls：核对 abort 之后 emit 不再回调到该监听器。
let failureCalls = 0;

// 订阅 failure 并绑定 controller.signal；signal abort 后订阅应自动失效。
const unsubscribeFailure = bus.on(
  'failure',
  () => {
    failureCalls += 1;
    return undefined;
  },
  { signal: controller.signal },
);

assert.equal(bus.listenerCount('failure'), 1);
// 触发 abort：onAbort 联动调用 unsubscribe，把 listener 从 Set 中移除。
controller.abort();
assert.equal(bus.listenerCount('failure'), 0);
// abort 已经移除了监听器；再次手动调用 unsubscribe 是幂等的，返回 false。
assert.equal(unsubscribeFailure(), false);
// 此时 emit 不会再命中已被取消的监听器；返回 0 表示无人执行。
assert.equal(
  bus.emit('failure', { runId: 'run-1', cause: new Error('ignored') }),
  0,
);
assert.equal(failureCalls, 0);

// alreadyAborted：传入一个一开始就 aborted 的 signal，on 直接返回 no-op 取消函数。
const alreadyAborted = AbortSignal.abort();
const inactive = bus.on(
  'failure',
  () => undefined,
  { signal: alreadyAborted },
);
// never-active 订阅调用 unsubscribe 同样返回 false。
assert.equal(inactive(), false);
assert.equal(bus.listenerCount('failure'), 0);

// ------------------------------------------------------------
// 5. 所有同步 listener 都执行，之后再聚合失败
// ------------------------------------------------------------
// 验证：单个 listener 抛错不会跳过后续 listener；多个错误会被包成 AggregateError。

// failureOrder：记录两个故意抛错的 listener 是否都被触发（验证"不中断后续"）。
const failureOrder: string[] = [];

// 第一个 failure 监听器：先记下顺序，再抛 Error。
bus.on('failure', () => {
  failureOrder.push('first');
  throw new Error('first listener failed');
});

// 第二个 failure 监听器：即使前一个抛错也会执行；这里抛一个非 Error 对象。
bus.on('failure', () => {
  failureOrder.push('second');
  throw { code: 'SECOND_FAILURE' };
});

// emit 期望抛出 AggregateError（两个失败）；errors 数组按抛出顺序保留两个错误对象。
assert.throws(
  () => bus.emit('failure', { runId: 'run-2', cause: 'root cause' }),
  (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    return true;
  },
);
// 两个监听器都触发了，证明"一个抛错不会跳过后续"。
assert.deepEqual(failureOrder, ['first', 'second']);

// 收尾：清空 token 事件的全部 listener（前面累积了 3 个），返回被移除数量。
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

// 导出公共 API：TypedEmitter 类与相关辅助类型，供其它模块复用。
export { TypedEmitter };
export type { AppEvents, EmitArgs, ListenOptions, SyncListener, Unsubscribe };
