import { parentPort } from 'node:worker_threads';

import {
  parseWorkerRequest,
  rejectedResponse,
  type WorkerResponse,
} from './32-worker-protocol.ts';

/**
 * Worker entry：必须保持“可擦除 TypeScript”语法，因为第 32 课会直接让
 * Node 24 从 .ts 源码启动 Worker；Node 只剥离类型，不读取 tsconfig，也不转换 enum。
 */

if (parentPort === null) {
  throw new Error('checksum worker 必须由 Worker 构造器启动');
}

const port = parentPort;

function post(response: WorkerResponse): void {
  port.postMessage(response);
}

port.once('message', (raw: unknown) => {
  const decoded = parseWorkerRequest(raw);
  if (!decoded.ok) {
    post(rejectedResponse(raw, decoded.issues));
    return;
  }

  const request = decoded.value;
  const values = new Uint32Array(request.values);
  const cancelFlag = new Int32Array(request.cancelFlag, 0, 1);

  post({ kind: 'started', taskId: request.taskId });

  let checksum = 0;
  let processedOperations = 0;

  for (let round = 0; round < request.rounds; round += 1) {
    for (let index = 0; index < values.length; index += 1) {
      // CPU 同步循环占用的是 Worker 自己的事件循环；它读不到普通 cancel message。
      // SharedArrayBuffer + Atomics.load 不需要 Worker 处理另一个 message callback。
      if ((processedOperations & 0x3fff) === 0 && Atomics.load(cancelFlag, 0) === 1) {
        post({
          kind: 'cancelled',
          taskId: request.taskId,
          processedOperations,
        });
        return;
      }

      const value = values[index] ?? 0;
      checksum = (checksum + value) >>> 0;
      processedOperations += 1;
    }
  }

  post({
    kind: 'completed',
    taskId: request.taskId,
    checksum,
    processedOperations,
  });
});

export {};

