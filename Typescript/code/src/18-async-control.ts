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

// Node 内置的严格相等断言模块，运行时验证异步控制流的实际行为与契约一致。
import assert from 'node:assert/strict';

// TimeoutError：专用于“超时”的错误子类型。
// 携带触发超时的 timeoutMs，使调用方能按错误类型分支处理（区别于普通业务错误或取消错误）。
class TimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`操作超过 ${timeoutMs}ms`);
    // 修正原型链：在 Error 子类中显式设置 name，便于 instanceof 与错误日志归类。
    this.name = 'TimeoutError';
  }
}

// Deferred<T>：把 Promise 的 resolve / reject 句柄“外部化”的握手原语。
// 测试时用于“手动决定某个 Promise 何时完成”，避免依赖真实定时器、保持确定性。
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

// deferred<T>()：构造一个 Deferred，把内部 resolve/reject 通过闭包泄漏给调用方。
// 调用方拿到 resolve 后可以“随时”兑现 promise，从而精确编排并发完成顺序。
function deferred<T>(): Deferred<T> {
  // definite assignment：构造 Promise 时 executor 同步运行，resolve/reject 必然被赋值。
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// abortReason(signal)：统一提取“取消原因”的适配器。
// signal.reason 是 ES2025 新增字段；老环境没有时退回构造一个标准 AbortError DOMException，
// 让下游 catch 始终拿到一个非空 reason，避免 undefined 在错误处理路径里穿透。
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('操作已取消', 'AbortError');
}

// ------------------------------------------------------------
// 1. 可取消 delay：完成与取消都移除 retaining edge
// ------------------------------------------------------------
// delay(ms, signal)：返回在 ms 毫秒后 resolve 的 promise；signal abort 时立即 reject。
// 关键点是“对称清理”：无论完成还是取消，都要把 abort listener 从 signal 上摘掉，
// 否则 signal 会长期持有对 onAbort 闭包（以及其中 timer 变量）的引用（retaining edge），
// 造成内存驻留。这是结构化并发最基本的一条契约。

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  // 入口参数校验：拒绝 NaN / Infinity / 负数，防止“等负 3 毫秒”这种无意义调用进入 Promise。
  if (!Number.isFinite(ms) || ms < 0) {
    return Promise.reject(new RangeError('delay ms 必须是非负有限数字'));
  }

  return new Promise((resolve, reject) => {
    // 快速路径：进入时 signal 已 aborted，直接以现有 reason reject，不挂任何 listener。
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }

    // 正常路径：定时器到期 → cleanup → resolve。
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    // 取消路径：signal abort 时清掉 timer、摘掉 listener、以 signal 的 reason reject。
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      // 此分支必然因 signal 触发，故 signal 一定存在；判空只是为了取悦类型系统。
      if (signal !== undefined) reject(abortReason(signal));
    };

    // { once: true } 保证 listener 自动只触发一次；但为彻底切断引用，cleanup 仍显式 remove。
    signal?.addEventListener('abort', onAbort, { once: true });

    // cleanup：把 onAbort 从 signal 上摘下来，切断 signal → onAbort → 闭包(timer) 的引用链。
    // 闭包提升到外层是为了让 timer 触发路径和 abort 路径都能调用同一份清理逻辑。
    function cleanup(): void {
      signal?.removeEventListener('abort', onAbort);
    }
  });
}

// ------------------------------------------------------------
// 2. cooperative timeout：abort 底层并等待它真正结束
// ------------------------------------------------------------
// withTimeout：给一个“接受 signal”的 operation 套上超时罩。
// 与朴素 Promise.race 的区别：本实现只 resolve 一次（来自 operation），但会通过 signal
// 主动 abort operation，并 await operation 的真正收束后才返回 / 抛错 ——
// 这就是“协作式超时”：能否真停下来取决于 operation 是否响应 signal，
// JavaScript 语言本身没有“从外部杀掉 promise”的能力。

async function withTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  // 参数校验，与 delay 保持一致的语义。
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError('timeoutMs 必须是非负有限数字');
  }

  // 独立的 controller：把“超时”和“父级取消”统一映射成对底层 operation 的 abort。
  const controller = new AbortController();
  // 用 TimeoutError 作为 abort reason，让下游能通过 reason 区分“超时取消” vs “用户取消”。
  const timeoutError = new TimeoutError(timeoutMs);
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);

  // forwardParentAbort：把父级 signal 的取消“转发”给本作用域的 controller，
  // 保持取消原因透传（不替换成 timeoutError），让上游能识别是自己触发的取消。
  const forwardParentAbort = (): void => {
    controller.abort(parentSignal?.reason);
  };

  // 若父级进入时已 aborted，立即转发；否则订阅一次。
  if (parentSignal?.aborted === true) forwardParentAbort();
  else parentSignal?.addEventListener('abort', forwardParentAbort, { once: true });

  try {
    // 不额外 race：只有 operation 响应 signal 并结束后，本作用域才算真正收束。
    // 若 operation 无视 signal，JavaScript 没有通用机制强杀它，这是 API 契约问题。
    return await operation(controller.signal);
  } finally {
    // 无论成功 / 失败 / 取消，都要清掉定时器和父级 listener，避免悬空回调。
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', forwardParentAbort);
  }
}

// ------------------------------------------------------------
// 3. retry：分类、退避、取消优先级和可测试时间
// ------------------------------------------------------------
// RetryPolicy：描述重试策略的“纯数据 + 纯函数”集合。
// 把 maxAttempts / shouldRetry / delayForAttempt 抽象成可注入字段，
// 是为了让 retry 的“决策”与“等待时间”都能被测试替换，无需真实 setTimeout。
interface RetryPolicy {
  // 最大尝试次数（含首次），到达上限后直接抛最后一次错误。
  readonly maxAttempts: number;
  // 错误分类器：返回 true 才认为这是“值得重试的暂时性错误”。
  // failedAttempt 是已失败的尝试序号（从 1 开始），方便实现指数退避或上限判定。
  readonly shouldRetry: (error: unknown, failedAttempt: number) => boolean;
  // 退避时间计算器：根据已失败次数返回下一次重试前应 sleep 的毫秒数。
  readonly delayForAttempt: (failedAttempt: number) => number;
}

// RetryDependencies：把 sleep 这个“副作用”显式声明为依赖，
// 测试时注入 fake sleep 即可断言“请求了哪些退避时间”，无需真实等待。
interface RetryDependencies {
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

// retry：循环执行 operation 直到成功 / 用尽次数 / 被取消。
// 取消优先级：每次循环开头与 catch 后都先 throwIfAborted，
// 保证被取消的错误不会被 shouldRetry 误判为“可重试”，从而无谓地继续重试。
async function retry<T>(
  operation: (attempt: number, signal: AbortSignal) => Promise<T>,
  policy: RetryPolicy,
  signal: AbortSignal,
  // 默认依赖 = 真实 delay；测试可注入 fake。
  dependencies: RetryDependencies = { sleep: delay },
): Promise<T> {
  // maxAttempts 必须是正整数，否则策略本身就不合法。
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError('maxAttempts 必须是正整数');
  }

  // 经典的 for 循环（而非递归）：每轮一次 attempt，状态显式可读。
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    // 进入循环先检查取消：避免在已取消的状态下还执行一次 operation。
    signal.throwIfAborted();

    try {
      // 正常路径：把 attempt 序号透传给 operation（常用于日志 / 指数退避决策）。
      return await operation(attempt, signal);
    } catch (error: unknown) {
      // operation 可能因 signal 拒绝；取消必须优先，不能被 shouldRetry 误判成暂时错误。
      signal.throwIfAborted();

      // 到达上限或分类器认为不可重试：原样抛出，不吞错。
      if (
        attempt === policy.maxAttempts ||
        !policy.shouldRetry(error, attempt)
      ) {
        throw error;
      }

      // 计算退避时间并校验，防止策略返回 NaN/负值进入 sleep 造成“永不兑现”的 promise。
      const backoffMs = policy.delayForAttempt(attempt);
      if (!Number.isFinite(backoffMs) || backoffMs < 0) {
        throw new RangeError('delayForAttempt 必须返回非负有限数字');
      }
      // 通过注入的 sleep 等待退避；它本身也响应 signal，被取消时立刻抛出。
      await dependencies.sleep(backoffMs, signal);
    }
  }

  // 理论不可达：循环要么 return、要么 throw。这里是人类阅读时的不变量断言。
  throw new Error('retry 控制流不变量被破坏');
}

// ------------------------------------------------------------
// 4. structured mapConcurrent：失败取消 sibling，并等待全部 worker
// ------------------------------------------------------------
// noFailure：用唯一 Symbol 作为“尚未发生失败”的哨兵值。
// 用 Symbol 而不是 undefined，是为了让“真正的 undefined 错误原因”也能被区分记录。
const noFailure = Symbol('noFailure');

// mapConcurrent：对 items 做有界并发 map，输出数组保持原顺序。
// 结构化语义：一旦某个 mapper 抛错，立即 abort 其它 worker，并 await 全部 worker 结束后再抛出，
// 保证函数返回时调用栈里没有“还在飞的 mapper” —— 这是它和 Promise.all + 切片写法的关键差异。
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
  // 参数校验：concurrency 必须是正整数。
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency 必须是正整数');
  }
  // 父级已取消则直接抛，避免无意义地启动 worker。
  parentSignal?.throwIfAborted();
  // 空输入快速返回空数组，且不分配 controller / worker。
  if (items.length === 0) return [];

  // 内部 controller：把“mapper 失败”与“父级取消”都翻译成对全体 worker 的 abort。
  const controller = new AbortController();
  const forwardParentAbort = (): void => {
    controller.abort(parentSignal?.reason);
  };
  parentSignal?.addEventListener('abort', forwardParentAbort, { once: true });

  // 预分配结果数组：长度与输入相同，按 index 写入，保证输出顺序与输入对齐。
  const results = new Array<Output>(items.length);
  // 共享游标：worker 从中“领取”下一个待处理索引，实现有界并发的工作窃取式调度。
  let cursor = 0;
  // firstFailure：记录首个失败原因；后续失败被丢弃，保证最终抛出的是“最早的”错误。
  let firstFailure: unknown | typeof noFailure = noFailure;

  // recordFailure：记录首个错误并 abort 其余 worker。
  // 用函数封装保证“只记录第一个”的不变量在多处调用点一致。
  function recordFailure(error: unknown): void {
    if (firstFailure !== noFailure) return;
    firstFailure = error;
    // 触发 abort：其余 worker 会在下一次 throwIfAborted / await 处收到取消。
    controller.abort(error);
  }

  // worker：不断从 cursor 领取下一个 index 并执行 mapper，直到领不到或失败。
  // 失败被 try/catch 吸收并记录 —— 这是 Promise.all 能“等齐”所有 worker 的前提。
  async function worker(): Promise<void> {
    while (true) {
      try {
        // 每轮开头检查取消：失败发生后第一个 await 之前就能尽早退出。
        controller.signal.throwIfAborted();

        // JS job run-to-completion 保证 cursor 的读取/递增之间没有 await 插入点。
        const index = cursor;
        cursor += 1;
        // 全部任务领完 → 本 worker 退出。
        if (index >= items.length) return;

        // 取出当前任务；注意 readonly Input[] 允许稀疏数组，下面显式拒绝这种输入。
        const item = items[index];
        if (item === undefined && !(index in items)) {
          throw new TypeError(`不接受稀疏数组，缺少索引 ${index}`);
        }

        // 把 mapper 的结果按 index 写回：保证输出顺序由“输入位置”决定，而非“完成顺序”。
        results[index] = await mapper(
          item as Input,
          index,
          controller.signal,
        );
      } catch (error: unknown) {
        // 任何错误（含 mapper 抛出、signal abort）都记录并退出本 worker。
        recordFailure(error);
        return;
      }
    }
  }

  // worker 数量 = min(concurrency, items.length)：任务比并发上限少时不多开空 worker。
  const workerCount = Math.min(concurrency, items.length);
  try {
    // worker 自己吸收并记录失败，所以 Promise.all 会等待每个 worker 真正结束。
    // 即使首个失败已发生，其余 worker 也会被 abort 唤醒并尽快退出，不会被“卡住”。
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    // 无论结果如何，都摘掉父级 listener，避免父 signal 长期持有本作用域闭包。
    parentSignal?.removeEventListener('abort', forwardParentAbort);
  }

  // 若发生过失败，抛出最早记录到的那个。
  if (firstFailure !== noFailure) throw firstFailure;

  // 防御性检查：理论上每个 index 都应被写入，否则说明 worker 调度出错（不变量被破坏）。
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
// streamTokens：演示“拉取式”异步生产者。
// 关键性质：
//   1) 背压 —— yield 之后会暂停，直到消费方再次 next()，不会无脑把整个数组跑完；
//   2) 结构化释放 —— 提前 return() / for-of break / 抛错都会进入 finally，执行清理。
// lifecycle 数组用于把“生产了什么、何时清理”外部化，便于断言执行轨迹。

async function* streamTokens(
  tokens: readonly string[],
  signal: AbortSignal,
  lifecycle: string[],
): AsyncGenerator<string, void, void> {
  try {
    for (const token of tokens) {
      // 每生产一项前都先检查取消：被取消时立即以 AbortError 抛出，进入 finally。
      signal.throwIfAborted();
      // 记录“即将产出 token”这一事件，配合断言验证“只产出了被 next 拉取过的项”。
      lifecycle.push(`produce:${token}`);
      // yield 把控制权交还消费方；消费方不调 next，循环就停在这里（背压的本质）。
      yield token;
    }
  } finally {
    // 无论正常结束、提前 return() 还是抛错，finally 都会执行：清理钩子放在这里最安全。
    lifecycle.push('cleanup');
  }
}

// ------------------------------------------------------------
// 6. 确定性契约实验
// ------------------------------------------------------------
// 下面是用前面定义的原语做的一组“可复现实验”：通过 Deferred / fake sleep 控制时间，
// 而不是 sleep(20) 这种“大概率够”的脆弱写法。每段实验都断言一条具体的契约。

// timeout：底层 delay 监听 signal，因此超时原因原样传播，timer/listener 随后清理。
// 用 .catch 把错误“收集”成值，便于后续 instanceof 断言。
const timeoutResult: unknown = await withTimeout(
  5,
  (signal) => delay(100, signal),
).catch((error: unknown) => error);
// 断言 1：超时确实以 TimeoutError 形态抛出（不是普通 Error，也不是裸 AbortError）。
assert.ok(timeoutResult instanceof TimeoutError);
// 断言 2：携带的 timeoutMs 正是触发超时的那个值（5ms），原因未被覆盖。
assert.equal(timeoutResult.timeoutMs, 5);

// retry：注入 fake sleep，不让测试依赖真实时间。
// attempts 记录每次尝试序号；requestedBackoffs 记录 fake sleep 收到的退避毫秒数。
const attempts: number[] = [];
const requestedBackoffs: number[] = [];
const retryController = new AbortController();

const retryValue = await retry(
  async (attempt) => {
    attempts.push(attempt);
    // 前 2 次抛“暂时错误”，第 3 次成功 —— 用于验证重试会按策略进行。
    if (attempt < 3) throw new Error(`temporary-${attempt}`);
    return 'ok';
  },
  {
    maxAttempts: 4,
    // 分类器：所有 Error 都视为可重试（这里只为演示，真实策略应更严格）。
    shouldRetry: (error) => error instanceof Error,
    // 指数退避：第 1 次失败后 10ms，第 2 次后 20ms，第 3 次后 40ms（本例只用到前两次）。
    delayForAttempt: (failedAttempt) => 10 * 2 ** (failedAttempt - 1),
  },
  retryController.signal,
  {
    // fake sleep：不真睡，只记录请求的毫秒数，但仍尊重 signal —— 这是测试可确定性的关键。
    async sleep(ms, signal) {
      signal.throwIfAborted();
      requestedBackoffs.push(ms);
    },
  },
);

// retry 最终返回了第 3 次的 'ok'。
assert.equal(retryValue, 'ok');
// 尝试序号恰好是 [1, 2, 3]，证明没有多余重试。
assert.deepEqual(attempts, [1, 2, 3]);
// 退避请求恰好是 [10, 20]，证明指数退避被正确计算并只用于失败的那两次。
assert.deepEqual(requestedBackoffs, [10, 20]);

// 已取消时 shouldRetry 根本不应被调用。
// 这个实验专门验证“取消优先于错误分类”这一不变量。
const cancelledRetryController = new AbortController();
const cancellationReason = new Error('stop retry');
// 计数器：分类器被调用的次数。期望始终为 0。
let retryClassifierCalls = 0;

const cancelledRetry = retry(
  async (_attempt, signal) => {
    // 在 operation 内部主动取消自己，然后立刻 throwIfAborted —— 模拟“运行中被外部取消”。
    cancelledRetryController.abort(cancellationReason);
    signal.throwIfAborted();
    return 'unreachable';
  },
  {
    maxAttempts: 3,
    shouldRetry: () => {
      // 如果分类器被调用，说明取消优先级被破坏 —— 测试应失败。
      retryClassifierCalls += 1;
      return true;
    },
    delayForAttempt: () => 0,
  },
  cancelledRetryController.signal,
);

// 抛出的应当正好是 cancellationReason（即调用方 abort 时给的原因），而不是被包装或替换。
await assert.rejects(cancelledRetry, (error: unknown) => error === cancellationReason);
// 关键断言：分类器从未被调用，证明“取消优先于错误分类”。
assert.equal(retryClassifierCalls, 0);

// 并发上限与输出顺序：手动决定完成顺序 1 -> 2 -> 0 -> 3。
// 这里用 4 个 Deferred 作为每个 mapper 的“完成闸门”，让测试可以精确控制时序。
// 同时用 started / completed / maxActive 三个轨迹变量把执行顺序外部化以便断言。
const controls = Array.from({ length: 4 }, () => deferred<number>());
const started: number[] = [];
const completed: number[] = [];
let active = 0;
let maxActive = 0;

// 启动一次 concurrency = 2 的 map，但暂不 await：让它在后台跑到每个 mapper 的 await 处。
const mappedPromise = mapConcurrent(
  [0, 1, 2, 3],
  2,
  async (value, index) => {
    started.push(index);
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      // 等待测试代码主动 resolve 对应的 control —— 这就是“手动时序”的实现。
      const result = await controls[index]?.promise;
      if (result === undefined) throw new Error(`缺少 gate ${index}`);
      completed.push(index);
      return value * value;
    } finally {
      // 确保无论成功 / 失败，活跃计数都减回去（用于验证 worker 收尾干净）。
      active -= 1;
    }
  },
);

// 进入时只有前 2 个 index 被 start（concurrency = 2 的直接证据）。
assert.deepEqual(started, [0, 1]);
// 释放 index=1：worker 1 完成 → worker 领取 index=2。
controls[1]?.resolve(1);
// 两个 microtask 轮次：让 mapper 的 await 链、worker 的下一次循环都跑完。
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(started, [0, 1, 2]);

controls[2]?.resolve(2);
await Promise.resolve();
await Promise.resolve();
// 此时 index=0、1、2、3 都已 start（index=0 一直阻塞在自己的 control 上）。
assert.deepEqual(started, [0, 1, 2, 3]);

// 一次性释放剩下的两个，等待整个 map 结束。
controls[0]?.resolve(0);
controls[3]?.resolve(3);
const mapped = await mappedPromise;

// 峰值并发恰好为 2：从未超过 concurrency 上限。
assert.equal(maxActive, 2);
// 完成顺序正好是手动编排的 1 → 2 → 0 → 3。
assert.deepEqual(completed, [1, 2, 0, 3]);
// 输出数组仍按输入顺序 [0,1,4,9]（即 value*value），不受完成顺序影响。
assert.deepEqual(mapped, [0, 1, 4, 9]);

// 失败收束：worker 1 失败后，worker 0 的 delay 收到 sibling abort；返回前 active=0。
// 这组实验专门验证“首个失败 → abort sibling → 等待全部 worker 退出”的结构化语义。
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
      // value=1 的 mapper 直接抛错，触发首个失败。
      if (value === 1) throw mapperFailure;
      // 其它 mapper 阻塞在一个长 delay 上；signal 被 abort 后 delay 会立即抛出。
      await delay(10_000, signal);
      return value;
    } finally {
      failureActive -= 1;
      failureLifecycle.push(`finish:${value}`);
    }
  },
);

// 抛出的应当正好是 mapperFailure（首个失败原因，未被包装）。
await assert.rejects(failedMap, (error: unknown) => error === mapperFailure);
// 返回时所有 mapper 都已退出：没有“还在飞的 mapper”残留。
assert.equal(failureActive, 0);
// 生命周期集合恰好包含 start:0/1 与 finish:0/1 —— 说明 index=2 根本没启动（abort 已发生）。
assert.deepEqual(new Set(failureLifecycle), new Set([
  'start:0',
  'start:1',
  'finish:0',
  'finish:1',
]));
// 直接断言“start:2 从未出现”：首个失败后剩余任务被取消，不会启动新 worker。
assert.equal(failureLifecycle.includes('start:2'), false);

// AsyncGenerator 不会预先生产第二项；return()/break 会进入 finally。
// lifecycle 数组外部化执行轨迹，用于验证“拉取式生产 + 结构化清理”。
const streamLifecycle: string[] = [];
const iterator = streamTokens(
  ['agent', 'stream', 'backpressure'],
  new AbortController().signal,
  streamLifecycle,
);

// 创建迭代器后还没调 next：producer 应尚未执行任何代码。
assert.deepEqual(streamLifecycle, []);
// 第一次 next：产出 'agent'，且仅记录了 'produce:agent'，证明“第二项尚未生产”。
assert.deepEqual(await iterator.next(), { value: 'agent', done: false });
assert.deepEqual(streamLifecycle, ['produce:agent']);
// 第二次 next：产出 'stream'，依然只多了一条 produce 记录（背压的直接证据）。
assert.deepEqual(await iterator.next(), { value: 'stream', done: false });
assert.deepEqual(streamLifecycle, ['produce:agent', 'produce:stream']);
// iterator.return()：等价于 for-of 中提前 break；触发 finally，记录 cleanup。
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
