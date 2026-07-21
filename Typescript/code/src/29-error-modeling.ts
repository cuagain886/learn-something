import assert from 'node:assert/strict';

/**
 * 第 29 课：异常、Result、cause 链和可重试失败
 *
 * JavaScript 允许 throw 任意值，所以 catch 变量在 strict 模式下是 unknown。
 * Agent 系统又必须区分取消、模型限流、非法工具参数、上游故障和代码缺陷；如果全部
 * 压成 Error.message，调用方就无法做安全的重试、状态码映射和脱敏日志。
 */

// Result：用判别联合表达「成功或失败」的结果。
// 关键设计点：用 ok 标志位做判别，使调用方必须先收窄（if result.ok）再访问 value/error。
type Result<Value, Failure> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: Failure };

// ok 是 Result 的成功构造器：never 作为 Failure 类型，表示「不会失败」。
function ok<Value>(value: Value): Result<Value, never> {
  return { ok: true, value };
}

// err 是 Result 的失败构造器：never 作为 Value 类型，表示「没有成功值」。
function err<Failure>(error: Failure): Result<never, Failure> {
  return { ok: false, error };
}

// InputValidationError：业务侧「输入校验失败」的领域错误。
// 继承 Error 让它仍可被 throw，但带 code 字段方便统一分类。
class InputValidationError extends Error {
  // readonly + 字面量 = 每个实例共享同一常量 code，便于运行时识别错误类型。
  readonly code = 'INVALID_INPUT';

  constructor(readonly issues: readonly string[]) {
    super('输入未通过校验');
    // 修复原型链：编译目标低于 ES2022 时，子类 super 后还需手动设定 name。
    this.name = 'InputValidationError';
  }
}

// UpstreamHttpError：上游 HTTP 调用失败的领域错误。
// 携带 status / retryAfterMs，让分类层判断是否可重试。
class UpstreamHttpError extends Error {
  readonly code = 'UPSTREAM_HTTP_ERROR';

  constructor(
    readonly status: number,
    readonly retryAfterMs: number | undefined,
    message: string,
    // ErrorOptions 让调用方可以把原始 cause 链接进来（保留底层 stack）。
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'UpstreamHttpError';
  }
}

// AgentFailure：把任意抛出的值归一化成「带 kind 的判别联合」。
// 这样调用方在 switch 上能得到穷举性检查（增删 kind 时编译器会指出未处理的分支）。
type AgentFailure =
  | {
      readonly kind: 'cancelled';
      readonly reason: unknown;
    }
  | {
      readonly kind: 'invalid_input';
      readonly issues: readonly string[];
    }
  | {
      readonly kind: 'rate_limited';
      readonly retryAfterMs: number;
      readonly cause: UpstreamHttpError;
    }
  | {
      readonly kind: 'upstream_unavailable';
      readonly status: number;
      readonly cause: UpstreamHttpError;
    }
  | {
      readonly kind: 'bug';
      readonly cause: Error;
    };

// normalizeThrown：把任意被 throw 的值（包括非 Error）包成一个真正的 Error。
// 同时用 cause 链接原始值，避免丢失信息；这是 useUnknownInCatchVariables 下的兜底。
function normalizeThrown(value: unknown): Error {
  if (value instanceof Error) return value;

  let rendered: string;
  try {
    // 非 Error 值可能是字符串、对象等；尝试渲染成可读字符串。
    rendered = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    // 极端情况下 JSON.stringify 会抛错（环、BigInt），回落到 Object.prototype.toString。
    rendered = Object.prototype.toString.call(value);
  }

  // 用 cause 把原始非 Error 值保留下來，便于后续诊断。
  return new Error(`捕获到非 Error 异常: ${rendered}`, { cause: value });
}

// classifyFailure：把任意 cause + signal 组合，归一化成 AgentFailure。
// 这一步是「业务恢复策略」与「具体异常类型」之间的解耦层。
function classifyFailure(cause: unknown, signal: AbortSignal): AgentFailure {
  // 取消优先于底层异常分类。部分 API 在 abort 后会抛 DOMException，另一些会抛 signal.reason。
  // 判断 signal 状态比依赖错误类名更稳定。
  if (signal.aborted) return { kind: 'cancelled', reason: signal.reason };

  // 已知领域错误：直接映射成 invalid_input。
  if (cause instanceof InputValidationError) {
    return { kind: 'invalid_input', issues: cause.issues };
  }

  // 上游 HTTP 错误：进一步按 status 区分限流 vs 不可用。
  if (cause instanceof UpstreamHttpError) {
    // 429 表示限流，可重试；retryAfterMs 缺省时给一个保守的 1 秒默认值。
    if (cause.status === 429) {
      return {
        kind: 'rate_limited',
        retryAfterMs: cause.retryAfterMs ?? 1_000,
        cause,
      };
    }

    // 5xx 表示上游不可用，可重试。
    if (cause.status >= 500) {
      return {
        kind: 'upstream_unavailable',
        status: cause.status,
        cause,
      };
    }
  }

  // 既不是已知领域错误，也不是已知上游错误，统一当作代码缺陷（不应重试）。
  return { kind: 'bug', cause: normalizeThrown(cause) };
}

// isRetryable：根据 kind 判断是否值得重试。
// switch 不写 default，TS 会强制所有 kind 都有返回值（穷尽性检查）。
function isRetryable(failure: AgentFailure): boolean {
  switch (failure.kind) {
    case 'rate_limited':
    case 'upstream_unavailable':
      return true;
    case 'cancelled':
    case 'invalid_input':
    case 'bug':
      return false;
  }
}

// RetryPolicy：把「重试行为」抽象成可注入的策略，便于测试时用 fake sleep。
// delayFor 由 failure + attempt 共同决定延迟（不同失败类型可以有不同的退避策略）。
type RetryPolicy = {
  readonly maxAttempts: number;
  readonly delayFor: (failure: AgentFailure, attempt: number) => number;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

// executeWithRetry：通用重试执行器。
// 把「业务 operation、取消信号、重试策略」解耦，调用方拿到的永远是 Result，不再抛业务异常。
async function executeWithRetry<Value>(
  operation: (attempt: number, signal: AbortSignal) => Promise<Value>,
  signal: AbortSignal,
  policy: RetryPolicy,
): Promise<Result<Value, AgentFailure>> {
  // 入参校验：maxAttempts 必须是正整数，否则用 RangeError 直接抛（参数错误，不是业务失败）。
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError('maxAttempts 必须是正整数');
  }

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    // 每轮开始前再次检查 signal：取消信号可能在 sleep 期间到达。
    if (signal.aborted) return err({ kind: 'cancelled', reason: signal.reason });

    try {
      // 成功路径：把返回值包成 Result.ok。
      return ok(await operation(attempt, signal));
    } catch (cause: unknown) {
      // 捕获到的 cause 是 unknown（strict 模式默认行为），交给 classifyFailure 归一化。
      const failure = classifyFailure(cause, signal);
      const isLastAttempt = attempt === policy.maxAttempts;
      // 不可重试或最后一次尝试：直接把失败返回。
      if (!isRetryable(failure) || isLastAttempt) return err(failure);

      // 计算延迟；非法延迟（负数、NaN、Infinity）应当作为 bug 失败，而不是继续重试。
      const delay = policy.delayFor(failure, attempt);
      if (!Number.isFinite(delay) || delay < 0) {
        return err({
          kind: 'bug',
          cause: new RangeError(`重试延迟非法: ${delay}`),
        });
      }

      // sleep 本身也可能被取消（例如等待时调用方 abort），它的失败同样要走分类。
      try {
        await policy.sleep(delay, signal);
      } catch (sleepCause: unknown) {
        return err(classifyFailure(sleepCause, signal));
      }
    }
  }

  // 循环边界已经由 maxAttempts 校验证明不可到达。
  throw new Error('unreachable');
}

// SerializedCause：错误序列化后的 cause 节点形状。
// 必须支持四种情况：真正的错误 / 非 Error 值 / 检测到环 / 超过深度限制。
type SerializedCause =
  | { readonly kind: 'error'; readonly error: SerializedError }
  | { readonly kind: 'non_error'; readonly value: string }
  | { readonly kind: 'cycle' }
  | { readonly kind: 'truncated' };

// SerializedError：对外暴露的错误结构。
// 刻意只暴露 name/message/code/cause，不暴露 stack 等敏感或冗长字段。
type SerializedError = {
  readonly name: string;
  readonly message: string;
  readonly code: string | null;
  readonly cause: SerializedCause | null;
};

// readStringCode：从任意 Error 上安全读取 code 字段。
// 因为不是所有 Error 都有 code，且可能为非字符串，需要做 typeof 检查。
function readStringCode(error: Error): string | null {
  const candidate: unknown = Reflect.get(error, 'code');
  return typeof candidate === 'string' ? candidate : null;
}

/**
 * 日志序列化边界：不直接 JSON.stringify(Error)，也不把 stack/请求密钥暴露给模型。
 * cause 的类型是 unknown，并且可能形成环，所以必须同时做类型检查、深度限制和环检测。
 */
function serializeError(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): SerializedCause {
  // 非 Error 值走 non_error 分支：尽力渲染成字符串。
  if (!(value instanceof Error)) {
    return { kind: 'non_error', value: safelyRender(value) };
  }

  // 环检测：当前 Error 已经在祖先链上出现过，避免无限递归。
  if (seen.has(value)) return { kind: 'cycle' };
  // 深度限制：cause 嵌套过深时截断，避免日志膨胀。
  if (depth >= 5) return { kind: 'truncated' };
  seen.add(value);

  // 递归处理 cause 字段；depth + 1 表示深入一层。
  const cause = 'cause' in value && value.cause !== undefined
    ? serializeError(value.cause, depth + 1, seen)
    : null;

  return {
    kind: 'error',
    error: {
      name: value.name,
      message: value.message,
      code: readStringCode(value),
      cause,
    },
  };
}

// safelyRender：把任意 unknown 值安全渲染成字符串。
// 多层 try 防御：JSON.stringify 失败时回落到 Object.prototype.toString。
function safelyRender(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value);
    // JSON.stringify 对 undefined 返回 undefined（字符串意义上），需回落到 String(value)。
    return json ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

// observedSleeps 收集重试过程中实际使用的延迟值，用来断言只发生了一次重试并使用了正确退避。
const observedSleeps: number[] = [];
// neverAborted 是一个永远不会被 abort 的 signal，用来跑「正常重试」实验。
const neverAborted = new AbortController().signal;
// modelAttempts 记录 operation 被实际调用的次数（包括失败那次）。
let modelAttempts = 0;

// 重试实验：第一次调用抛 429（限流），第二次成功；验证 executeWithRetry 走对了路径。
const retryResult = await executeWithRetry(
  async (attempt) => {
    modelAttempts = attempt;
    if (attempt === 1) {
      // 用 cause 把底层 socket 失败链接到 UpstreamHttpError，保留完整因果链。
      const socketFailure = new Error('socket closed by upstream');
      throw new UpstreamHttpError(429, 250, '模型供应商限流', { cause: socketFailure });
    }
    return { text: 'TypeScript failure model explained', tokens: 42 };
  },
  neverAborted,
  {
    maxAttempts: 3,
    delayFor(failure, attempt) {
      // 真实系统还应加入带上限的指数退避和 jitter；这里使用 fake sleep 保持实验瞬时、确定。
      // rate_limited 时使用服务器建议的 retryAfterMs；否则用 2 的幂做简单退避。
      return failure.kind === 'rate_limited'
        ? failure.retryAfterMs
        : 100 * 2 ** (attempt - 1);
    },
    // fake sleep：不真的等待，只把延迟值记录下来，方便断言。
    async sleep(milliseconds) {
      observedSleeps.push(milliseconds);
    },
  },
);

// 断言：最终成功，且值是第二次调用的返回；attempt 计数 = 2（第一次失败、第二次成功）。
assert.equal(retryResult.ok, true);
if (retryResult.ok) assert.equal(retryResult.value.tokens, 42);
assert.equal(modelAttempts, 2);
// 只 sleep 了一次（250ms = 服务器建议的 retryAfterMs）。
assert.deepEqual(observedSleeps, [250]);

// 已取消的操作绝不能进入 execute，更不能被重试。
// 先 abort 再调用，验证循环入口的 signal 检查确实生效。
const cancelledController = new AbortController();
cancelledController.abort('user stopped the run');
let cancelledOperationCalls = 0;
const cancelledResult = await executeWithRetry(
  async () => {
    cancelledOperationCalls += 1;
    return 'should not run';
  },
  cancelledController.signal,
  {
    maxAttempts: 3,
    delayFor: () => 0,
    async sleep() {},
  },
);
// 关键断言：operation 一次都没被调用。
assert.equal(cancelledOperationCalls, 0);
assert.deepEqual(cancelledResult, {
  ok: false,
  error: { kind: 'cancelled', reason: 'user stopped the run' },
});

// Error.cause 保留抽象层次：仓储层给出业务上下文，同时不丢失底层 socket 原因。
// 外层错误是「读会话记忆失败」，cause 指向上游 503，再下层是 socket 层细节。
const repositoryError = new Error('读取会话记忆失败', {
  cause: new UpstreamHttpError(503, undefined, 'vector store unavailable'),
});
const serialized = serializeError(repositoryError);
assert.equal(serialized.kind, 'error');
if (serialized.kind === 'error') {
  // 断言 cause 也被序列化为 error 类型，证明递归序列化工作正常。
  assert.equal(serialized.error.cause?.kind, 'error');
}

// Promise.allSettled 允许先收集全部失败，再用 AggregateError 表示“多个原因共同失败”。
// 与 Promise.all 不同：allSettled 不会因为某个 reject 而短路。
const settled = await Promise.allSettled([
  Promise.resolve('memory saved'),
  Promise.reject(new Error('trace export failed')),
  // 故意 reject 一个非 Error 值（普通对象），验证序列化层能处理任意类型。
  Promise.reject({ code: 'AUDIT_WRITE_FAILED' }),
]);
const rejectedReasons = settled
  // 类型守卫：把联合结果收窄成 PromiseRejectedResult（带 reason 字段）。
  .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
  .map((item) => item.reason as unknown);
// AggregateError 把多个原因合并成一个错误，errors 数组保留全部原始 reason。
const aggregate = new AggregateError(rejectedReasons, 'Agent 收尾阶段存在多个失败');
assert.equal(aggregate.errors.length, 2);

// strict/useUnknownInCatchVariables 强迫我们处理“抛字符串”这类真实 JS 边界。
// normalizeThrown 把字符串包成 Error，并用 cause 保留原始字符串。
const normalizedString = normalizeThrown('legacy SDK failed');
assert.equal(normalizedString.cause, 'legacy SDK failed');

console.log('重试结果:', retryResult);
console.log('脱敏 cause 视图:', JSON.stringify(serialized, null, 2));
console.log('聚合失败数:', aggregate.errors.length);
console.log('=== 第 29 课完成：异常负责中断，Result 负责显式业务失败，分类决定恢复策略 ===');

