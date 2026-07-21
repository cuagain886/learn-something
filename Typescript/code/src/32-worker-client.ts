// addAbortListener：把 AbortSignal 的 abort 事件挂上回调，返回 Disposable。
// 可用 using / 手动 [Symbol.dispose]() 取消订阅，避免 worker 已退出后还挂着回调。
// 这是 ESNext.Disposable 提供的「资源管理」模式，对应 lib 中的 Disposable 类型。
import { addAbortListener } from 'node:events';
// Worker：主线程侧构造 worker 线程的入口。
// 它实例化后会 fork 出一条新线程，加载本文件 workerEntryUrl() 指向的入口模块。
import { Worker } from 'node:worker_threads';

// 从协议层引入（同一份协议文件被两端 import）：
//   - parseWorkerRequest：在 transfer 前自检请求，避免失败请求把调用方 input 抢走；
//   - parseWorkerResponse：把 Worker 回送的 unknown message 验证成具体响应；
//   - ComputeRequest：构造请求时的静态类型；
//   - WorkerCompleted：成功时的返回值类型（也是 checksumInWorker 的 Promise 元素）。
// type-only import：运行时不会出现在 emit 后的 .js 里，纯粹供 tsc 检查。
import {
  parseWorkerRequest,
  parseWorkerResponse,
  type ComputeRequest,
  type WorkerCompleted,
} from './32-worker-protocol.ts';

/** 主线程可传入的运行选项；signal 在 postMessage 前已取消时不会转移 input。 */
export type WorkerChecksumOptions = {
  // rounds：对整个数组的重复累加轮数；省略时默认 1 轮。
  readonly rounds?: number; // 可选；省略走 checksumInWorker 内部默认 1。
  // signal：可选 AbortSignal；触发 abort 时主线程写 cancelFlag=1，Worker 在轮询中读到即中止。
  readonly signal?: AbortSignal; // 不传时表示「不可取消」——cancelFlag 仍然存在但不会被置 1。
  // onStarted：Worker 回送 started 消息时同步调用；测试用它精确地在「任务刚开始」时刻触发 abort。
  readonly onStarted?: () => void; // 在 client.ts:155 由 onMessage 分发调用；不传则忽略 started 消息。
};

// 任务 id 自增序列：模块级单例，多次调用 checksumInWorker 共享这一个计数器。
// 用来给每次调用分配唯一 taskId，便于把异步响应匹配回请求。
// 模块级 let：进程生命周期内单调递增；不暴露给外部，纯内部协调用。
let nextTaskSequence = 0;

// workerEntryUrl：动态决定 Worker 入口是 .ts 还是 .js。
// 直接由 Node 24 type stripping 跑 .ts 源码时，import.meta.url 以 .ts 结尾；
// 走 tsc build 后产物是 .js，相对路径也必须随之改写，否则 dist 跑不起来。
// 【关键】这条判断只看「当前文件本身」是 .ts 还是 .js，与 worker 文件名硬编码绑定。
function workerEntryUrl(): URL {
  // 源码由 Node type stripping 运行时需要 .ts；tsc build 后则需要 .js。
  // URL 构造器里的字符串不是 import specifier，不受 rewriteRelativeImportExtensions 改写。
  // 必须在这里手动挑扩展名，否则要么源码运行时找不到 .js，要么 dist 运行时找不到 .ts。
  const entry = import.meta.url.endsWith('.ts')
    ? './32-worker-checksum-worker.ts'
    : './32-worker-checksum-worker.js';
  // new URL(entry, import.meta.url) 把相对路径解析成绝对 file:// URL，传给 Worker 构造器。
  // 用绝对 URL 而不是相对字符串：Worker 内部对相对路径的解析基准可能与预期不同。
  return new URL(entry, import.meta.url);
}

// nextTaskId：拼出一个可读的任务 id（如 checksum_3），便于日志/调试定位。
// 自增在前、拼接在后：保证第一次调用拿到 checksum_1（而不是 checksum_0）。
function nextTaskId(): string {
  nextTaskSequence += 1; // 先自增，避免出现 checksum_0。
  return `checksum_${nextTaskSequence}`;
}

// abortReason：把 abort 的真实原因透传给 Promise.reject。
// signal.reason 可能是 undefined（AbortController 默认无 reason），统一兜底成 Error 文本。
// 测试用例依赖此函数返回「同一个 reason」做严格相等断言（见 32-worker-threads.test.ts:120）。
function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new Error('worker task cancelled'); // ?? 兜底：reason 可能是 undefined。
}

// checksumInWorker：本文件的主入口，也是主线程调用 Worker 的公共 API。
// 把一段 ArrayBuffer 喂给 Worker 做 rounds 轮 uint32 校验和，返回 WorkerCompleted。
// 注意：input 会被 transfer 给 Worker，调用方在本函数 resolve/reject 之前不得再使用 input。
// 【跨文件配合】测试 32-worker-threads.test.ts:17 直接 import 此函数驱动端到端流程。
export async function checksumInWorker(
  input: ArrayBuffer,
  options: WorkerChecksumOptions = {},
): Promise<WorkerCompleted> {
  // 静态入口校验：必须非零、按 uint32 对齐；否则 Worker 端 Uint32Array(input) 会抛 RangeError。
  // 这一步在 transfer 前完成，调用方失败时仍拥有 input。
  // 提前抛 RangeError 而不是发请求再被 Worker 拒绝：失败路径上 input 没有被夺走。
  if (input.byteLength === 0 || input.byteLength % Uint32Array.BYTES_PER_ELEMENT !== 0) {
    throw new RangeError('input 必须是非零且能被 4 整除的 ArrayBuffer');
  }

  // rounds 兜底与校验：默认 1；必须是正安全整数。
  // 这一步在创建 Worker 之前，避免「起线程 → 立刻被协议层拒绝」的资源浪费。
  const rounds = options.rounds ?? 1; // 省略时默认单轮，常见用法就是算一次校验和。
  if (!Number.isSafeInteger(rounds) || rounds <= 0) {
    throw new RangeError('rounds 必须是正安全整数');
  }

  // 先检查再创建/转移资源：已取消任务不得让调用方意外失去 input 所有权。
  // 若 signal 已 aborted，立刻抛出 reason——此时 input 还没被 transfer，调用方仍持有。
  // 这条 early-return 对应用例 4（已取消 signal 在 transfer 前失败）。
  if (options.signal?.aborted === true) {
    throw options.signal.reason; // 直接透传 reason，保留调用方的 Error 身份用于 === 比较。
  }

  // 生成任务 id；创建协作取消用的 SharedArrayBuffer（4 字节 = 1 个 Int32）。
  const taskId = nextTaskId();
  // SharedArrayBuffer 是「真正共享物理内存」的 buffer：父子线程各持有引用，
  // 一端写入另一端立即可见，不需要 postMessage 来回搬运。
  const cancelFlag = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT); // 长度恰好 4 字节，足够装一个 Int32。
  // cancelView 是主线程侧的写入视图：Atomics.store(cancelView, 0, 1) 即把 cancelFlag 置为 1。
  // Worker 侧的 cancelFlag view（checksum-worker.ts:56）指向同一块内存，能立即读到。
  const cancelView = new Int32Array(cancelFlag);

  // 组装静态 ComputeRequest：结构合法，但范围/预算还没经过运行时 parser。
  // 此时 TypeScript 认为它是合法请求，但跨线程消息边界仍要求运行时再证一次。
  const request: ComputeRequest = {
    kind: 'compute',
    taskId,
    values: input, // 引用同一块 ArrayBuffer；transfer 后此变量名仍指向原（已 detached）buffer。
    rounds,
    cancelFlag, // 引用 SharedArrayBuffer；不放进 transferList，因为本来就是共享的。
  };

  // 静态 ComputeRequest 只能证明字段类型；同一个运行时 parser 还负责范围、
  // byteLength 和总操作数预算。必须在 transfer 前完成，否则参数失败也会夺走 input。
  // 这里复用 Worker 端的同一个 parser，等价于「主线程先自检一遍」。
  // 双端共享 parser 还保证「主线程能过的，Worker 端一定也过」，不会出现误拒绝。
  const checkedRequest = parseWorkerRequest(request);
  if (!checkedRequest.ok) {
    // 这里失败通常意味着本文件自身的构造逻辑 bug（不是外部输入）；仍按协议诊断格式抛出便于排查。
    throw new RangeError(`worker request 非法: ${checkedRequest.issues.join('; ')}`);
  }

  // Node 24 的 Worker 实现 AsyncDisposable；正常、协议错误和取消都会 terminate/join。
  // await using：函数退出时自动调用 worker[Symbol.asyncDispose]()，
  // 它会终止仍存活的线程并等待 exit，避免测试/CLI 遗留 active handle。
  // 关键：放在 transfer 之前声明，是为了即便后续抛错也能保证 worker 被回收。
  await using worker = new Worker(workerEntryUrl(), {
    // name 给 Worker 线程命名，便于诊断工具（如 inspector）识别。
    name: 'ts-course-checksum', // inspector / ps 里会显示这个名字，方便定位。
  });

  // 持有 abort 监听器的 Disposable；在 finally 里手动 dispose 取消订阅，
  // 避免 worker 已退出后 abort 回调还试图操作已无效的 cancelView。
  // undefined 是「未注册」标志：只有 options.signal !== undefined 时才会赋值。
  let abortSubscription: Disposable | undefined;

  try {
    // 用一个 Promise 把 Worker 的回送事件转成可 await 的异步结果。
    // 这是「事件回调 → Promise」的标准转换：把多次触发的 message 事件封装成单值 resolve。
    return await new Promise<WorkerCompleted>((resolve, reject) => {
      // settled 防止「同一次任务被多次 settle」（例如 exit 与 message 几乎同时到达）。
      // 闭包变量，所有回调共享：第一次 finish 之后，再调用 settle 会被忽略。
      let settled = false;

      // settle：包装一次 resolve/reject，确保只有第一次调用真正生效。
      // 接收 finish 函数而不是直接传 value：保持 resolve/reject 的调用点灵活。
      const settle = (finish: () => void): void => {
        if (settled) return; // 已 settle：丢弃后续触发，避免「resolve 后又 reject」的怪异状态。
        settled = true;
        finish(); // 实际执行 resolve 或 reject。
      };

      // onMessage：每条 Worker 消息都先经 parseWorkerResponse 收窄，再按 kind 分发。
      // 注册在 worker.on('message', ...)：可能多次触发（典型顺序 started → completed）。
      const onMessage = (raw: unknown): void => {
        // raw 仍是 unknown——postMessage 边界默认不安全，必须先 parse。
        const decoded = parseWorkerResponse(raw);
        if (!decoded.ok) {
          // 协议层非法：直接拒绝，并附上 parser 给出的诊断。
          settle(() => reject(new Error(
            `worker 返回非法协议: ${decoded.issues.join('; ')}`,
          )));
          return;
        }

        const response = decoded.value;
        // taskId 不匹配：理论上不会发生（一个 worker 只跑一个任务），仍是防御性检查。
        // 一旦发生说明协议被破坏（例如 worker 跨任务复用），直接拒绝。
        if (response.taskId !== taskId) {
          settle(() => reject(new Error(
            `worker taskId 不匹配: expected ${taskId}, actual ${response.taskId}`,
          )));
          return;
        }

        // switch on response.kind：与 WorkerResponse union 一一对应，穷尽分发。
        switch (response.kind) {
          case 'started':
            // started 只是「Worker 已进入任务」的通知；触发可选的 onStarted 回调后继续等下一条。
            // 测试用例 3 依赖此回调在「任务刚开始」时刻同步 abort，触发取消路径。
            options.onStarted?.(); // 可选链：未提供 onStarted 时静默忽略。
            return; // 不 settle——继续等待后续的 terminal 消息。

          case 'completed':
            // 任务正常完成：settle 把结果交给 Promise，外层 await 解锁。
            settle(() => resolve(response)); // response 已被 parser 收窄为 WorkerCompleted。
            return;

          case 'cancelled':
            // Worker 在轮询中读到 cancelFlag=1：用原 abort reason 拒绝，让上层捕获到一致的语义。
            // 关键：reject 的是同一个 reason（abortReason 透传 signal.reason），
            // 测试用例 3 据此做 error === reason 的严格相等断言。
            settle(() => reject(abortReason(options.signal)));
            return;

          case 'rejected':
            // Worker 解析请求失败：把诊断拼进 Error message，便于排查协议层问题。
            // 这种情况说明「主线程自检过、但 Worker 端 parser 拒绝」——大概率是协议版本不一致。
            settle(() => reject(new Error(
              `worker 拒绝请求: ${response.issues.join('; ')}`,
            )));
            return;
        }
      };

      // onError：Worker 线程抛出未捕获异常（例如 worker.ts 顶部的 parentPort null 检查）时触发。
      // once：error 事件只会触发一次，且通常意味着 worker 即将退出。
      const onError = (error: Error): void => {
        settle(() => reject(error)); // 直接透传原始 Error，保留 stack。
      };

      // onMessageError：postMessage 的值无法被结构化克隆（例如含函数）时触发。
      // 这里方向是「Worker → 主线程」，所以一般是 Worker 那边 post 了不可序列化的对象。
      // cause 链：把底层序列化错误作为外层 Error 的 cause，保留原始信息。
      const onMessageError = (error: Error): void => {
        settle(() => reject(new Error('worker message 反序列化失败', { cause: error })));
      };

      // onExit：Worker 线程退出（正常结束或崩溃）。如果此时还没 settle，
      // 说明它在 terminal response（completed/cancelled/rejected）之前就退了，必须转成错误。
      // 注意：先检查 settled——正常流程里 completed 之后 worker 也会 exit，那时不应再 reject。
      const onExit = (code: number): void => {
        if (!settled) {
          settle(() => reject(new Error(
            `worker 在 terminal response 前退出，exit code=${code}`,
          )));
        }
      };

      // 注册四个监听器：message 会多次触发（started → completed 之类），其余三个用 once。
      // 顺序不影响逻辑：事件回调在事件实际触发时才执行，注册顺序只是代码可读性。
      worker.on('message', onMessage);
      worker.once('error', onError);
      worker.once('messageerror', onMessageError);
      worker.once('exit', onExit);

      // 信号监听：signal 一旦 abort，立即把共享原子位置 1，并 notify 唤醒可能正在 wait 的线程。
      // addAbortListener 返回 Disposable：在 finally 里手动 dispose，避免对已退出 worker 触发回调。
      if (options.signal !== undefined) {
        abortSubscription = addAbortListener(options.signal, () => {
          // 关键一步：写共享内存里的取消标志。Worker 在 CPU 循环中 Atomics.load 读到 1 即中止。
          // 这是「协作取消」的核心写入点：跨线程无需 postMessage，直接改共享内存。
          Atomics.store(cancelView, 0, 1); // 第二参数是索引（0），第三参数是值（1=已取消）。
          // 当前 Worker 采用轮询；notify 对它不是必需，但若以后改成 Atomics.wait，
          // 这条通知可以唤醒等待者。
          Atomics.notify(cancelView, 0); // 唤醒所有在 index 0 上 wait 的线程；本 Worker 不 wait，所以是空操作。
        });
      }

      // transferList 移动 backing store；调用返回时 input 以及共享它的所有 view 已 detached。
      // 把 checkedRequest.value（已运行时证明的请求对象）发给 Worker，并把 input 所有权一并转移。
      // 关键：第二个参数 [input] 才是「转移列表」，cancelFlag 不在里面——它本来就是共享的。
      // postMessage 是同步执行的：调用返回前 input.byteLength 就已经变成 0（见 test 用例 2）。
      worker.postMessage(checkedRequest.value, [input]);
    });
  } finally {
    // 不管成功还是失败，都先取消 abort 订阅，避免对已终止的 worker 还触发回调。
    // ?. 链：abortSubscription 可能仍是 undefined（options.signal 没传时）。
    abortSubscription?.[Symbol.dispose]();
    // await using 在此函数退出时继续调用 worker[Symbol.asyncDispose]()；
    // 它会终止仍存活的线程并等待 exit，避免测试/CLI 遗留 active handle。
    // finally 之后才会触发 await using 的 dispose——顺序是：先解绑 abort，再 terminate worker。
  }
}
