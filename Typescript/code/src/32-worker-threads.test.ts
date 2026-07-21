// node:assert/strict：使用严格相等（===）语义的断言库，测试的核心断言入口。
// strict 模式让 assert.equal 走 ===，避免 1 == '1' 这类隐式转换的迷惑行为。
import assert from 'node:assert/strict';
// once：把 EventEmitter 的某事件转成 Promise，await 后拿到事件参数数组。
// 适合「只等一次事件」的场景，比手动 on/off 配对更简洁。
import { once } from 'node:events';
// node:test：Node 内置测试运行器；test 注册一个测试用例。
// 不需要 jest/mocha，node --test 直接跑；测试失败会以 TAP 格式报告。
import test from 'node:test';
// markAsUntransferable：把某个 ArrayBuffer 标记为「禁止被 transfer」，
//   即便放进 transferList，也会被强制走克隆路径而不是所有权转移。
// MessageChannel：创建一对互相连通的 port1/port2，
//   用于在不启动 Worker 的情况下测试结构化克隆 / transfer 行为。
// 用 MessageChannel 测试克隆语义：避免起线程的开销，更适合隔离验证纯机制。
import {
  markAsUntransferable,
  MessageChannel,
} from 'node:worker_threads';

// 引入主线程入口 checksumInWorker；测试通过它驱动真实的 Worker 线程跑端到端流程。
// 注意：本测试文件不直接 import Worker，所有线程管理都封装在 checksumInWorker 内部。
import { checksumInWorker } from './32-worker-client.ts';
// 引入协议层 parser：在不需要真正起 Worker 的用例里直接验证解析行为。
// 这层 import 让测试同时覆盖「静态协议」与「运行时 parser」两条独立路径。
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

// 用例 1：协议解析器是「跨线程边界的运行时守卫」。
// 静态 ComputeRequest 类型只能证明字段存在/类型对，但保护不了「taskId 非空」「ArrayBuffer 长度对齐」
// 「rounds 在 1..1e9」「cancelFlag 至少 4 字节」这类业务约束——这些只能靠运行时 parser。
// 本用例把所有典型错误一次性塞进去，验证 parser 能把它们全部列出来。
// 【跨文件配合】parser 实现见 32-worker-protocol.ts:138；本用例验证 issues 累积顺序与文案。
test('协议解析器拒绝静态类型无法保护的跨线程输入', () => {
  // 故意构造一条「静态 ComputeRequest 看起来合法、但运行时处处违规」的请求：
  //   - taskId 空字符串；
  //   - values 是 3 字节 ArrayBuffer（不对齐 uint32）；
  //   - rounds=0（非正）；
  //   - cancelFlag 只有 1 字节（不够 Int32）。
  // 注意 kind:'compute' 是对的——本用例只验证其它字段的拒绝，不测 kind。
  const malformed = parseWorkerRequest({
    kind: 'compute',
    taskId: '', // 空字符串：违反「非空 string」约束。
    values: new ArrayBuffer(3), // 3 字节：无法按 uint32(4 字节) 对齐。
    rounds: 0, // 0：非正整数，违反 1..MAX_ROUNDS 范围。
    cancelFlag: new SharedArrayBuffer(1), // 1 字节：装不下一个 Int32。
  });

  // ok=false，issues 应按 parser 内部检查顺序列出全部四个字段问题。
  // 顺序对应 parseWorkerRequest 里的 if 顺序：taskId → values → rounds → cancelFlag。
  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    // deepEqual 比较整个数组：任何一条文案或顺序变化都会让测试失败，相当于锁定诊断契约。
    assert.deepEqual(malformed.issues, [
      'taskId 必须是非空 string',
      'values.byteLength 必须是非零且能被 4 整除',
      'rounds 必须是 1..1000000000 的安全整数',
      'cancelFlag 至少需要 4 bytes',
    ]);
  }

  // 同样验证响应方向：completed 响应里 checksum=-1（非 uint32）、且缺 processedOperations 字段，
  // parser 必须把这两个问题一起报出，而不是只挑一个。
  // 验证「累积式 issues」模式：哪怕两个字段同时非法，也要一次返回全部诊断。
  assert.deepEqual(parseWorkerResponse({ kind: 'completed', taskId: 'x', checksum: -1 }), {
    ok: false,
    issues: [
      'completed.checksum 必须是 uint32', // -1 是负数，违反「非负」约束。
      'completed.processedOperations 必须是非负安全整数', // 字段缺失，typeof === 'undefined'。
    ],
  });
});

// 用例 2：transfer 语义——ArrayBuffer 一旦被 transfer，原 buffer 和所有 view 同时失效。
// 这是「所有权移动」，不是「复制」也不是「只读」。
// 【跨文件配合】transfer 触发于 client.ts:217 的 worker.postMessage(req, [input])；
// 行为本身是 Node runtime 提供的，本测试只是把它观测出来。
test('ArrayBuffer transfer 是所有权移动：所有共享 view 在发送方同时 detached', async () => {
  // values 与 bytesView 共享同一个底层 buffer（values.buffer）；originalBuffer 也指向它。
  // 三个引用都指向同一块 backing store——这是验证「同时 detached」的前提。
  const values = new Uint32Array([1, 2, 3, 4, 5]);
  const bytesView = new Uint8Array(values.buffer); // 同一块内存的 byte-level 视图。
  const originalBuffer = values.buffer; // 直接拿到底层 buffer 的引用。

  // 调用 checksumInWorker：内部 postMessage 在第一次同步执行时就把 buffer transfer 给 Worker。
  // 不 await：下一行就要立刻观测「transfer 后的失效状态」，必须在 await 之前。
  const resultPromise = checksumInWorker(originalBuffer, { rounds: 3 });

  // postMessage 在第一次 await 之前同步发生；transfer 后不是"只读"，而是发送方失去 backing store。
  // 三处断言全部为 0：buffer.byteLength、Uint32Array.length、Uint8Array.length 都失效，
  // 说明「共享同一块 backing store 的所有 view」都被一次性 detached，而不是只 detach 主 buffer。
  // 这是 transfer 与 clone 的核心差异：clone 只复制数据，view 仍可用；transfer 直接搬走所有权。
  assert.equal(originalBuffer.byteLength, 0); // 主 buffer 已 detached。
  assert.equal(values.length, 0); // Uint32Array view 也失效（底层空了，length 变 0）。
  assert.equal(bytesView.length, 0); // Uint8Array view 同样失效。

  // 5 个 uint32 × 3 轮 = 15 次累加；sum(1..5)=15，三轮共 45。
  // >>>0 保证 checksum 始终落在 uint32 范围，这里 45 没有溢出，原样返回。
  // 至此 await 才解锁——对应 client.ts:160 收到 completed 后的 settle(resolve)。
  const result = await resultPromise;
  assert.equal(result.checksum, 45); // 1+2+3+4+5=15，三轮共 45。
  assert.equal(result.processedOperations, 15); // 5 个元素 × 3 轮 = 15 次累加。
});

// 用例 3：协作取消——CPU 同步循环不会响应 message，必须用 SharedArrayBuffer + Atomics 让 Worker 自己轮询。
// 关键机制：onStarted 在 Worker 回送 started 时同步触发 AbortController.abort，
// 主线程的 abort 监听器立刻 Atomics.store(cancelFlag, 1)，Worker 下一轮 Atomics.load 读到后中止。
// 【跨文件配合】涉及 client.ts:155 (onStarted 分发) → client.ts:206 (abort 监听写入 cancelFlag)
// → checksum-worker.ts:73 (轮询读到 1 后发送 cancelled) → client.ts:165 (reject 透传 reason)。
test('CPU 循环用 SharedArrayBuffer + Atomics 协作取消，而不是等待 cancel message', async () => {
  const controller = new AbortController();
  const reason = new Error('parent deadline reached'); // 自定义 reason，测试用它做 === 严格比较。
  // 只有 1 个 uint32 元素的 input；但 rounds 高达 5 亿，保证「来得及取消」（不然任务早就跑完了）。
  // 大 rounds 是为了让 CPU 循环跑得足够久，使得取消能在循环中途命中（而不是任务早完成）。
  const input = new Uint32Array([1]).buffer;

  const running = checksumInWorker(input, {
    rounds: 500_000_000, // 5 亿次循环：单线程跑完要好几秒，足够让取消路径命中。
    signal: controller.signal, // 关联 AbortSignal，让 abort 能写入 cancelFlag。
    // started message 证明 Worker 已进入任务；回调同步设置共享原子位。
    onStarted() {
      // 此时 Worker 已进入 CPU 循环——普通 cancel message 它根本读不到。
      // 但 cancelFlag 是 SharedArrayBuffer，主线程 abort 监听器会 Atomics.store(1)，
      // Worker 轮询中 Atomics.load 读到 1 即回送 cancelled 并退出。
      // 关键：这里同步 abort——回调还没返回，cancelFlag 就已经被写为 1。
      controller.abort(reason); // 用同一个 reason，下游断言 error === reason 才成立。
    },
  });

  // input 已被 transfer 给 Worker，主线程这边 byteLength=0（即使最后是 cancelled，所有权也不会还回来）。
  // 注意：transfer 是单向移动——cancelled 路径并不会把 buffer 还回来，它已经在 Worker 那边 detached。
  assert.equal(input.byteLength, 0);
  // 预期被同一个 reason 拒绝：abortReason 透传 signal.reason，让上层捕获到一致的语义。
  // === 严格相等：测试用例 3 依赖 abortReason 透传的「同身份」reason，而不是新建一个 Error。
  await assert.rejects(running, (error: unknown) => error === reason);
});

// 用例 4：边界——已取消的 signal 必须在 transfer 之前就抛错，调用方仍拥有 ArrayBuffer。
// 同一个用例还验证「rounds 超预算」也属于 transfer 前的运行时校验：失败时 input 不会被夺走。
// 【跨文件配合】两条 early-return 都在 client.ts:79-81 / 101-105，发生在 worker.postMessage 之前。
test('已取消 signal 在 transfer 前失败，调用方仍拥有 ArrayBuffer', async () => {
  const controller = new AbortController();
  const reason = new Error('already cancelled'); // 提前定义 reason，下面断言用 === 比较。
  // 提前 abort，模拟「任务派发时已被外部取消」。
  controller.abort(reason);

  const input = new Uint32Array([7, 8]).buffer; // 8 bytes = 2 个 uint32。
  await assert.rejects(
    checksumInWorker(input, { signal: controller.signal }),
    // 必须抛出同一个 reason，且 input 还属于主线程（未 transfer）。
    // === 比较：client.ts:80 直接 throw options.signal.reason，保留引用身份。
    (error: unknown) => error === reason,
  );
  // 8 bytes = 2 个 uint32，仍可访问——signal.aborted 检查发生在 transfer 前。
  // 这条断言是「调用方仍持有所有权」的客观证据：byteLength 没变成 0。
  assert.equal(input.byteLength, 8);

  // 类型为 number 仍不足以表达协议范围；运行时预算错误也必须在 transfer 前失败。
  // rounds=1_000_000_001 超出 MAX_ROUNDS=1e9：parseWorkerRequest 在 transfer 前把它拦下。
  // 静态类型 number 装得下 1e9+1，但 parser 的范围检查会拦下——这是「类型 ≠ 业务约束」的典型例子。
  const oversizedWork = new Uint32Array([1]).buffer;
  await assert.rejects(
    checksumInWorker(oversizedWork, { rounds: 1_000_000_001 }), // 比 MAX_ROUNDS 大 1。
    /rounds 必须是 1\.\.1000000000/, // 正则匹配：诊断 message 里嵌入 MAX_ROUNDS 字面值。
  );
  // 同样 input 没被夺走。
  // parser 失败 → throw RangeError → 还没走到 worker.postMessage，所有权仍在主线程。
  assert.equal(oversizedWork.byteLength, 4);
});

// DomainMessage：自定义类，用于验证「结构化克隆」的边界。
//   - 有实例字段 visible；
//   - 有 getter derived；
//   - 有原型方法 describe。
// 用例 5 把它的实例通过 MessageChannel 发送，验证接收端拿到的是「纯数据副本」而非「同原型对象」。
// 这是「跨线程消息只能传纯数据」的客观证据——任何类的方法/getter 都无法跨线程保留。
class DomainMessage {
  readonly visible: string;

  constructor(visible: string) {
    this.visible = visible; // 实例字段：会被结构化克隆保留（作为普通 own property）。
  }

  get derived(): string { // getter：在原型上，不在 own property 表里——克隆时被丢弃。
    return this.visible.toUpperCase();
  }

  describe(): string { // 原型方法：克隆后不存在，因为原型链不被复制。
    return `DomainMessage(${this.visible})`;
  }
}

// 用例 5：结构化克隆算法「保留数据」但「不保留原型、方法、getter」。
// 这是为什么 Worker 协议里我们只传纯数据（kind/taskId/values/...）——任何类方法跨线程后都会丢失。
// 【跨文件配合】这也是为什么 protocol.ts 里所有响应类型都是「纯字面量字段」，
// 没有任何类实例或方法——跨线程后它们全部会失效。
test('structured clone 保留数据而不保留自定义原型、方法和 getter', async (t) => {
  // 用 MessageChannel 直接测试 port-to-port，不需要起 Worker 线程，更适合隔离验证克隆语义。
  // MessageChannel 用的是与 Worker 同一套结构化克隆算法，结论可以无损外推。
  const { port1, port2 } = new MessageChannel();
  t.after(() => {
    // 测试结束关闭两端 port，避免 active handle 残留导致进程不退出。
    // t.after 注册的钩子在测试结束时无条件执行——成功失败都会跑。
    port1.close();
    port2.close();
  });

  // once(port1, 'message') 返回 Promise，等下一条 message 事件触发后 resolve。
  // 必须在 postMessage 之前 once：错过事件就拿不到了。
  const receivedPromise = once(port1, 'message');
  // 从 port2 发送一个 DomainMessage 实例到 port1。
  // 发送瞬间结构化克隆算法就开始工作：遍历 own properties，忽略原型链。
  port2.postMessage(new DomainMessage('agent'));
  const receivedArgs = await receivedPromise;
  // once 返回的是事件参数数组；message 事件第一个参数才是消息体本身。
  // 注意：事件参数可能不止一个（某些事件有多个参数），这里 message 只有一个。
  const received: unknown = receivedArgs[0];

  // 三项断言对照「克隆前后丢失了什么」：
  //   1. instanceof 不成立 → 原型链丢失（已不是 DomainMessage 类的实例）；
  //   2. deepEqual 只剩 { visible } → 实例字段被保留为纯数据；
  //   3. 'derived' in received 为 false → getter 没有被「调用并把结果写入对象」，而是直接被丢弃。
  // 这三条共同证明：跨线程边界只能传「纯数据」，类的方法/getter 不会被复制过去。
  assert.equal(received instanceof DomainMessage, false); // 原型链丢失，已不是 DomainMessage 实例。
  assert.deepEqual(received, { visible: 'agent' }); // 只剩实例字段 visible，作为 own property 被克隆。
  assert.equal(
    // 这里的 typeof 守卫是为了让 'derived' in received 通过类型检查（in 操作符要求左侧是 object）。
    typeof received === 'object' && received !== null && 'derived' in received,
    false, // getter 不在 own property 表里，结构化克隆不会把它「调用并写入」。
  );
});

// 用例 6：markAsUntransferable 把 ArrayBuffer 标记为「禁止 transfer」。
// 即便把它放进 transferList，postMessage 也会直接抛 DataCloneError，并保留原 buffer 不变。
// 这是反向防御：当你明确不希望某个 buffer 被夺走所有权时，可以主动加锁（例如共享只读资源）。
// 与用例 2 形成对照：用例 2 验证「正常 transfer 行为」，本用例验证「主动禁止 transfer」。
test('markAsUntransferable 防止共享 backing store 被意外夺走', (t) => {
  const { port1, port2 } = new MessageChannel();
  t.after(() => {
    // 测试结束关闭两端 port，避免 active handle 残留导致进程不退出。
    port1.close();
    port2.close();
  });

  const buffer = new ArrayBuffer(8);
  // 把 buffer 标记为不可转移：后续即便放进 transferList，Node 也会强制走克隆路径并抛错。
  // 这是「反向锁」：调用方主动声明「这个 buffer 不允许被夺走所有权」。
  markAsUntransferable(buffer);

  // 显式把 buffer 放进 transferList：期望 Node 抛 DataCloneError，而不是真去转移它。
  // 注意 throws 的第二个参数是 matcher：可以是 Error 类、正则、或断言函数。
  assert.throws(
    () => port1.postMessage(buffer, [buffer]), // 这里同步抛错，不会真的发消息。
    // 断言错误类型：必须是 DOMException 且 name === 'DataCloneError'。
    // DOMException 是 Web 标准异常类型，Node 在结构化克隆边界上沿用。
    (error: unknown) => error instanceof DOMException && error.name === 'DataCloneError',
  );
  // buffer 没被夺走，主线程这边仍可访问。
  // markAsUntransferable 让抛错路径上 buffer 完好无损——这正是它存在的意义。
  assert.equal(buffer.byteLength, 8);
});

// 让本文件成为 module（与 script 区分），并给 tsc / Node type stripping 明确的模块边界。
// 测试文件本身不导出任何 API，export {} 只是触发 ESM 解析。
export {};
