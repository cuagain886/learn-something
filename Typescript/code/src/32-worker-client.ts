import { addAbortListener } from 'node:events';
import { Worker } from 'node:worker_threads';

import {
  parseWorkerRequest,
  parseWorkerResponse,
  type ComputeRequest,
  type WorkerCompleted,
} from './32-worker-protocol.ts';

/** 主线程可传入的运行选项；signal 在 postMessage 前已取消时不会转移 input。 */
export type WorkerChecksumOptions = {
  readonly rounds?: number;
  readonly signal?: AbortSignal;
  readonly onStarted?: () => void;
};

let nextTaskSequence = 0;

function workerEntryUrl(): URL {
  // 源码由 Node type stripping 运行时需要 .ts；tsc build 后则需要 .js。
  // URL 构造器里的字符串不是 import specifier，不受 rewriteRelativeImportExtensions 改写。
  const entry = import.meta.url.endsWith('.ts')
    ? './32-worker-checksum-worker.ts'
    : './32-worker-checksum-worker.js';
  return new URL(entry, import.meta.url);
}

function nextTaskId(): string {
  nextTaskSequence += 1;
  return `checksum_${nextTaskSequence}`;
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new Error('worker task cancelled');
}

export async function checksumInWorker(
  input: ArrayBuffer,
  options: WorkerChecksumOptions = {},
): Promise<WorkerCompleted> {
  if (input.byteLength === 0 || input.byteLength % Uint32Array.BYTES_PER_ELEMENT !== 0) {
    throw new RangeError('input 必须是非零且能被 4 整除的 ArrayBuffer');
  }

  const rounds = options.rounds ?? 1;
  if (!Number.isSafeInteger(rounds) || rounds <= 0) {
    throw new RangeError('rounds 必须是正安全整数');
  }

  // 先检查再创建/转移资源：已取消任务不得让调用方意外失去 input 所有权。
  if (options.signal?.aborted === true) {
    throw options.signal.reason;
  }

  const taskId = nextTaskId();
  const cancelFlag = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const cancelView = new Int32Array(cancelFlag);

  const request: ComputeRequest = {
    kind: 'compute',
    taskId,
    values: input,
    rounds,
    cancelFlag,
  };

  // 静态 ComputeRequest 只能证明字段类型；同一个运行时 parser 还负责范围、
  // byteLength 和总操作数预算。必须在 transfer 前完成，否则参数失败也会夺走 input。
  const checkedRequest = parseWorkerRequest(request);
  if (!checkedRequest.ok) {
    throw new RangeError(`worker request 非法: ${checkedRequest.issues.join('; ')}`);
  }

  // Node 24 的 Worker 实现 AsyncDisposable；正常、协议错误和取消都会 terminate/join。
  await using worker = new Worker(workerEntryUrl(), {
    name: 'ts-course-checksum',
  });

  let abortSubscription: Disposable | undefined;

  try {
    return await new Promise<WorkerCompleted>((resolve, reject) => {
      let settled = false;

      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        finish();
      };

      const onMessage = (raw: unknown): void => {
        const decoded = parseWorkerResponse(raw);
        if (!decoded.ok) {
          settle(() => reject(new Error(
            `worker 返回非法协议: ${decoded.issues.join('; ')}`,
          )));
          return;
        }

        const response = decoded.value;
        if (response.taskId !== taskId) {
          settle(() => reject(new Error(
            `worker taskId 不匹配: expected ${taskId}, actual ${response.taskId}`,
          )));
          return;
        }

        switch (response.kind) {
          case 'started':
            options.onStarted?.();
            return;

          case 'completed':
            settle(() => resolve(response));
            return;

          case 'cancelled':
            settle(() => reject(abortReason(options.signal)));
            return;

          case 'rejected':
            settle(() => reject(new Error(
              `worker 拒绝请求: ${response.issues.join('; ')}`,
            )));
            return;
        }
      };

      const onError = (error: Error): void => {
        settle(() => reject(error));
      };

      const onMessageError = (error: Error): void => {
        settle(() => reject(new Error('worker message 反序列化失败', { cause: error })));
      };

      const onExit = (code: number): void => {
        if (!settled) {
          settle(() => reject(new Error(
            `worker 在 terminal response 前退出，exit code=${code}`,
          )));
        }
      };

      worker.on('message', onMessage);
      worker.once('error', onError);
      worker.once('messageerror', onMessageError);
      worker.once('exit', onExit);

      if (options.signal !== undefined) {
        abortSubscription = addAbortListener(options.signal, () => {
          Atomics.store(cancelView, 0, 1);
          // 当前 Worker 采用轮询；notify 对它不是必需，但若以后改成 Atomics.wait，
          // 这条通知可以唤醒等待者。
          Atomics.notify(cancelView, 0);
        });
      }

      // transferList 移动 backing store；调用返回时 input 以及共享它的所有 view 已 detached。
      worker.postMessage(checkedRequest.value, [input]);
    });
  } finally {
    abortSubscription?.[Symbol.dispose]();
    // await using 在此函数退出时继续调用 worker[Symbol.asyncDispose]()；
    // 它会终止仍存活的线程并等待 exit，避免测试/CLI 遗留 active handle。
  }
}
