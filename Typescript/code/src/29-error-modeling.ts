import assert from 'node:assert/strict';

/**
 * 第 29 课：异常、Result、cause 链和可重试失败
 *
 * JavaScript 允许 throw 任意值，所以 catch 变量在 strict 模式下是 unknown。
 * Agent 系统又必须区分取消、模型限流、非法工具参数、上游故障和代码缺陷；如果全部
 * 压成 Error.message，调用方就无法做安全的重试、状态码映射和脱敏日志。
 */

type Result<Value, Failure> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: Failure };

function ok<Value>(value: Value): Result<Value, never> {
  return { ok: true, value };
}

function err<Failure>(error: Failure): Result<never, Failure> {
  return { ok: false, error };
}

class InputValidationError extends Error {
  readonly code = 'INVALID_INPUT';

  constructor(readonly issues: readonly string[]) {
    super('输入未通过校验');
    this.name = 'InputValidationError';
  }
}

class UpstreamHttpError extends Error {
  readonly code = 'UPSTREAM_HTTP_ERROR';

  constructor(
    readonly status: number,
    readonly retryAfterMs: number | undefined,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'UpstreamHttpError';
  }
}

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

function normalizeThrown(value: unknown): Error {
  if (value instanceof Error) return value;

  let rendered: string;
  try {
    rendered = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    rendered = Object.prototype.toString.call(value);
  }

  return new Error(`捕获到非 Error 异常: ${rendered}`, { cause: value });
}

function classifyFailure(cause: unknown, signal: AbortSignal): AgentFailure {
  // 取消优先于底层异常分类。部分 API 在 abort 后会抛 DOMException，另一些会抛 signal.reason。
  // 判断 signal 状态比依赖错误类名更稳定。
  if (signal.aborted) return { kind: 'cancelled', reason: signal.reason };

  if (cause instanceof InputValidationError) {
    return { kind: 'invalid_input', issues: cause.issues };
  }

  if (cause instanceof UpstreamHttpError) {
    if (cause.status === 429) {
      return {
        kind: 'rate_limited',
        retryAfterMs: cause.retryAfterMs ?? 1_000,
        cause,
      };
    }

    if (cause.status >= 500) {
      return {
        kind: 'upstream_unavailable',
        status: cause.status,
        cause,
      };
    }
  }

  return { kind: 'bug', cause: normalizeThrown(cause) };
}

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

type RetryPolicy = {
  readonly maxAttempts: number;
  readonly delayFor: (failure: AgentFailure, attempt: number) => number;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

async function executeWithRetry<Value>(
  operation: (attempt: number, signal: AbortSignal) => Promise<Value>,
  signal: AbortSignal,
  policy: RetryPolicy,
): Promise<Result<Value, AgentFailure>> {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError('maxAttempts 必须是正整数');
  }

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    if (signal.aborted) return err({ kind: 'cancelled', reason: signal.reason });

    try {
      return ok(await operation(attempt, signal));
    } catch (cause: unknown) {
      const failure = classifyFailure(cause, signal);
      const isLastAttempt = attempt === policy.maxAttempts;
      if (!isRetryable(failure) || isLastAttempt) return err(failure);

      const delay = policy.delayFor(failure, attempt);
      if (!Number.isFinite(delay) || delay < 0) {
        return err({
          kind: 'bug',
          cause: new RangeError(`重试延迟非法: ${delay}`),
        });
      }

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

type SerializedCause =
  | { readonly kind: 'error'; readonly error: SerializedError }
  | { readonly kind: 'non_error'; readonly value: string }
  | { readonly kind: 'cycle' }
  | { readonly kind: 'truncated' };

type SerializedError = {
  readonly name: string;
  readonly message: string;
  readonly code: string | null;
  readonly cause: SerializedCause | null;
};

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
  if (!(value instanceof Error)) {
    return { kind: 'non_error', value: safelyRender(value) };
  }

  if (seen.has(value)) return { kind: 'cycle' };
  if (depth >= 5) return { kind: 'truncated' };
  seen.add(value);

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

function safelyRender(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

const observedSleeps: number[] = [];
const neverAborted = new AbortController().signal;
let modelAttempts = 0;

const retryResult = await executeWithRetry(
  async (attempt) => {
    modelAttempts = attempt;
    if (attempt === 1) {
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
      return failure.kind === 'rate_limited'
        ? failure.retryAfterMs
        : 100 * 2 ** (attempt - 1);
    },
    async sleep(milliseconds) {
      observedSleeps.push(milliseconds);
    },
  },
);

assert.equal(retryResult.ok, true);
if (retryResult.ok) assert.equal(retryResult.value.tokens, 42);
assert.equal(modelAttempts, 2);
assert.deepEqual(observedSleeps, [250]);

// 已取消的操作绝不能进入 execute，更不能被重试。
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
assert.equal(cancelledOperationCalls, 0);
assert.deepEqual(cancelledResult, {
  ok: false,
  error: { kind: 'cancelled', reason: 'user stopped the run' },
});

// Error.cause 保留抽象层次：仓储层给出业务上下文，同时不丢失底层 socket 原因。
const repositoryError = new Error('读取会话记忆失败', {
  cause: new UpstreamHttpError(503, undefined, 'vector store unavailable'),
});
const serialized = serializeError(repositoryError);
assert.equal(serialized.kind, 'error');
if (serialized.kind === 'error') {
  assert.equal(serialized.error.cause?.kind, 'error');
}

// Promise.allSettled 允许先收集全部失败，再用 AggregateError 表示“多个原因共同失败”。
const settled = await Promise.allSettled([
  Promise.resolve('memory saved'),
  Promise.reject(new Error('trace export failed')),
  Promise.reject({ code: 'AUDIT_WRITE_FAILED' }),
]);
const rejectedReasons = settled
  .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
  .map((item) => item.reason as unknown);
const aggregate = new AggregateError(rejectedReasons, 'Agent 收尾阶段存在多个失败');
assert.equal(aggregate.errors.length, 2);

// strict/useUnknownInCatchVariables 强迫我们处理“抛字符串”这类真实 JS 边界。
const normalizedString = normalizeThrown('legacy SDK failed');
assert.equal(normalizedString.cause, 'legacy SDK failed');

console.log('重试结果:', retryResult);
console.log('脱敏 cause 视图:', JSON.stringify(serialized, null, 2));
console.log('聚合失败数:', aggregate.errors.length);
console.log('=== 第 29 课完成：异常负责中断，Result 负责显式业务失败，分类决定恢复策略 ===');

