/**
 * 第 32 课的跨线程协议。
 *
 * 这里同时保留两层契约：
 *   - TypeScript union：让同一编译图中的调用方获得静态关联；
 *   - parse 函数：Worker message 在运行时仍是 unknown，必须重新验证。
 *
 * interface/type 在 emit 后消失；共享这个文件不等于共享了运行时 schema。
 */

export type DecodeResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly issues: readonly string[] };

export type ComputeRequest = {
  readonly kind: 'compute';
  readonly taskId: string;
  /** transfer 后发送方的这个 ArrayBuffer 会 detached。 */
  readonly values: ArrayBuffer;
  readonly rounds: number;
  /** 不放入 transferList；父子线程持有同一块共享内存。 */
  readonly cancelFlag: SharedArrayBuffer;
};

export type WorkerRequest = ComputeRequest;

export type WorkerStarted = {
  readonly kind: 'started';
  readonly taskId: string;
};

export type WorkerCompleted = {
  readonly kind: 'completed';
  readonly taskId: string;
  /** 所有加法都按 uint32 取模，避免超过 Number 安全整数。 */
  readonly checksum: number;
  readonly processedOperations: number;
};

export type WorkerCancelled = {
  readonly kind: 'cancelled';
  readonly taskId: string;
  readonly processedOperations: number;
};

export type WorkerRejected = {
  readonly kind: 'rejected';
  readonly taskId: string | null;
  readonly issues: readonly string[];
};

export type WorkerResponse =
  | WorkerStarted
  | WorkerCompleted
  | WorkerCancelled
  | WorkerRejected;

const MAX_ROUNDS = 1_000_000_000;
const MAX_OPERATIONS = 2_000_000_000;

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function taskIdFromUnknown(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return typeof value['taskId'] === 'string' ? value['taskId'] : null;
}

export function parseWorkerRequest(value: unknown): DecodeResult<WorkerRequest> {
  const issues: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, issues: ['request 必须是非 null object'] };
  }

  if (value['kind'] !== 'compute') {
    issues.push("kind 必须是 'compute'");
  }

  const taskId = value['taskId'];
  if (typeof taskId !== 'string' || taskId.length === 0) {
    issues.push('taskId 必须是非空 string');
  }

  const values = value['values'];
  if (!(values instanceof ArrayBuffer)) {
    issues.push('values 必须是 ArrayBuffer');
  } else if (values.byteLength === 0 || values.byteLength % Uint32Array.BYTES_PER_ELEMENT !== 0) {
    issues.push('values.byteLength 必须是非零且能被 4 整除');
  }

  const rounds = value['rounds'];
  if (!isPositiveSafeInteger(rounds) || rounds > MAX_ROUNDS) {
    issues.push(`rounds 必须是 1..${MAX_ROUNDS} 的安全整数`);
  }

  const cancelFlag = value['cancelFlag'];
  if (!(cancelFlag instanceof SharedArrayBuffer)) {
    issues.push('cancelFlag 必须是 SharedArrayBuffer');
  } else if (cancelFlag.byteLength < Int32Array.BYTES_PER_ELEMENT) {
    issues.push('cancelFlag 至少需要 4 bytes');
  }

  if (
    values instanceof ArrayBuffer
    && isPositiveSafeInteger(rounds)
    && (values.byteLength / Uint32Array.BYTES_PER_ELEMENT) * rounds > MAX_OPERATIONS
  ) {
    issues.push(`总操作数不能超过 ${MAX_OPERATIONS}`);
  }

  if (issues.length > 0) return { ok: false, issues };

  // 上面的逐字段验证是运行时证明；断言只把已证明事实交还给 checker。
  return {
    ok: true,
    value: {
      kind: 'compute',
      taskId: taskId as string,
      values: values as ArrayBuffer,
      rounds: rounds as number,
      cancelFlag: cancelFlag as SharedArrayBuffer,
    },
  };
}

export function parseWorkerResponse(value: unknown): DecodeResult<WorkerResponse> {
  if (!isRecord(value) || typeof value['kind'] !== 'string') {
    return { ok: false, issues: ['response 必须是带 string kind 的 object'] };
  }

  const taskId = value['taskId'];
  switch (value['kind']) {
    case 'started': {
      if (typeof taskId !== 'string' || taskId.length === 0) {
        return { ok: false, issues: ['started.taskId 必须是非空 string'] };
      }
      return { ok: true, value: { kind: 'started', taskId } };
    }

    case 'completed': {
      const checksum = value['checksum'];
      const processedOperations = value['processedOperations'];
      const issues: string[] = [];
      if (typeof taskId !== 'string' || taskId.length === 0) {
        issues.push('completed.taskId 必须是非空 string');
      }
      if (!isNonNegativeSafeInteger(checksum) || checksum > 0xffff_ffff) {
        issues.push('completed.checksum 必须是 uint32');
      }
      if (!isNonNegativeSafeInteger(processedOperations)) {
        issues.push('completed.processedOperations 必须是非负安全整数');
      }
      if (issues.length > 0) return { ok: false, issues };
      return {
        ok: true,
        value: {
          kind: 'completed',
          taskId: taskId as string,
          checksum: checksum as number,
          processedOperations: processedOperations as number,
        },
      };
    }

    case 'cancelled': {
      const processedOperations = value['processedOperations'];
      const issues: string[] = [];
      if (typeof taskId !== 'string' || taskId.length === 0) {
        issues.push('cancelled.taskId 必须是非空 string');
      }
      if (!isNonNegativeSafeInteger(processedOperations)) {
        issues.push('cancelled.processedOperations 必须是非负安全整数');
      }
      if (issues.length > 0) return { ok: false, issues };
      return {
        ok: true,
        value: {
          kind: 'cancelled',
          taskId: taskId as string,
          processedOperations: processedOperations as number,
        },
      };
    }

    case 'rejected': {
      const issues = value['issues'];
      if ((taskId !== null && typeof taskId !== 'string') || !isStringArray(issues)) {
        return {
          ok: false,
          issues: ['rejected.taskId 必须是 string|null，issues 必须是 string[]'],
        };
      }
      return {
        ok: true,
        value: { kind: 'rejected', taskId, issues: [...issues] },
      };
    }

    default:
      return { ok: false, issues: [`未知 response kind: ${value['kind']}`] };
  }
}

export function rejectedResponse(raw: unknown, issues: readonly string[]): WorkerRejected {
  return {
    kind: 'rejected',
    taskId: taskIdFromUnknown(raw),
    issues: [...issues],
  };
}

