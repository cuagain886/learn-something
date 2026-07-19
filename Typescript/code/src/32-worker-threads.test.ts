import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import {
  markAsUntransferable,
  MessageChannel,
} from 'node:worker_threads';

import { checksumInWorker } from './32-worker-client.ts';
import {
  parseWorkerRequest,
  parseWorkerResponse,
} from './32-worker-protocol.ts';

/**
 * 第 32 课：Worker Thread、结构化克隆、所有权转移与共享取消
 *
 * 这组测试直接由 Node 24 运行 .ts：Node 只剥离可擦除类型，真正的编译期检查仍由 tsc 完成。
 * 每个跨线程 message 都作为 unknown 解析；共享 .ts type 不会在运行时保护消息边界。
 */

test('协议解析器拒绝静态类型无法保护的跨线程输入', () => {
  const malformed = parseWorkerRequest({
    kind: 'compute',
    taskId: '',
    values: new ArrayBuffer(3),
    rounds: 0,
    cancelFlag: new SharedArrayBuffer(1),
  });

  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert.deepEqual(malformed.issues, [
      'taskId 必须是非空 string',
      'values.byteLength 必须是非零且能被 4 整除',
      'rounds 必须是 1..1000000000 的安全整数',
      'cancelFlag 至少需要 4 bytes',
    ]);
  }

  assert.deepEqual(parseWorkerResponse({ kind: 'completed', taskId: 'x', checksum: -1 }), {
    ok: false,
    issues: [
      'completed.checksum 必须是 uint32',
      'completed.processedOperations 必须是非负安全整数',
    ],
  });
});

test('ArrayBuffer transfer 是所有权移动：所有共享 view 在发送方同时 detached', async () => {
  const values = new Uint32Array([1, 2, 3, 4, 5]);
  const bytesView = new Uint8Array(values.buffer);
  const originalBuffer = values.buffer;

  const resultPromise = checksumInWorker(originalBuffer, { rounds: 3 });

  // postMessage 在第一次 await 之前同步发生；transfer 后不是“只读”，而是发送方失去 backing store。
  assert.equal(originalBuffer.byteLength, 0);
  assert.equal(values.length, 0);
  assert.equal(bytesView.length, 0);

  const result = await resultPromise;
  assert.equal(result.checksum, 45);
  assert.equal(result.processedOperations, 15);
});

test('CPU 循环用 SharedArrayBuffer + Atomics 协作取消，而不是等待 cancel message', async () => {
  const controller = new AbortController();
  const reason = new Error('parent deadline reached');
  const input = new Uint32Array([1]).buffer;

  const running = checksumInWorker(input, {
    rounds: 500_000_000,
    signal: controller.signal,
    // started message 证明 Worker 已进入任务；回调同步设置共享原子位。
    onStarted() {
      controller.abort(reason);
    },
  });

  assert.equal(input.byteLength, 0);
  await assert.rejects(running, (error: unknown) => error === reason);
});

test('已取消 signal 在 transfer 前失败，调用方仍拥有 ArrayBuffer', async () => {
  const controller = new AbortController();
  const reason = new Error('already cancelled');
  controller.abort(reason);

  const input = new Uint32Array([7, 8]).buffer;
  await assert.rejects(
    checksumInWorker(input, { signal: controller.signal }),
    (error: unknown) => error === reason,
  );
  assert.equal(input.byteLength, 8);

  // 类型为 number 仍不足以表达协议范围；运行时预算错误也必须在 transfer 前失败。
  const oversizedWork = new Uint32Array([1]).buffer;
  await assert.rejects(
    checksumInWorker(oversizedWork, { rounds: 1_000_000_001 }),
    /rounds 必须是 1\.\.1000000000/,
  );
  assert.equal(oversizedWork.byteLength, 4);
});

class DomainMessage {
  readonly visible: string;

  constructor(visible: string) {
    this.visible = visible;
  }

  get derived(): string {
    return this.visible.toUpperCase();
  }

  describe(): string {
    return `DomainMessage(${this.visible})`;
  }
}

test('structured clone 保留数据而不保留自定义原型、方法和 getter', async (t) => {
  const { port1, port2 } = new MessageChannel();
  t.after(() => {
    port1.close();
    port2.close();
  });

  const receivedPromise = once(port1, 'message');
  port2.postMessage(new DomainMessage('agent'));
  const receivedArgs = await receivedPromise;
  const received: unknown = receivedArgs[0];

  assert.equal(received instanceof DomainMessage, false);
  assert.deepEqual(received, { visible: 'agent' });
  assert.equal(
    typeof received === 'object' && received !== null && 'derived' in received,
    false,
  );
});

test('markAsUntransferable 防止共享 backing store 被意外夺走', (t) => {
  const { port1, port2 } = new MessageChannel();
  t.after(() => {
    port1.close();
    port2.close();
  });

  const buffer = new ArrayBuffer(8);
  markAsUntransferable(buffer);

  assert.throws(
    () => port1.postMessage(buffer, [buffer]),
    (error: unknown) => error instanceof DOMException && error.name === 'DataCloneError',
  );
  assert.equal(buffer.byteLength, 8);
});

export {};
