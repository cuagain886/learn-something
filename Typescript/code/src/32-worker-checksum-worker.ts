// parentPort：Node Worker 线程与主线程通信的「这一端」端口。
// 主线程那边 `new Worker(url)` 拿到的 worker 对象，与本文件可见的 parentPort 是配对的一对。
// 【跨文件配合】client.ts:110 用 `new Worker(workerEntryUrl())` 启动本文件；本文件这边只看到 parentPort。
import { parentPort } from 'node:worker_threads';

// 从协议层引入（同一份 .ts 文件被两端 import）：
//   - parseWorkerRequest：把收到的 unknown message 验证成 ComputeRequest；
//   - rejectedResponse：解析失败时构造一条拒绝响应回送；
//   - WorkerResponse：post 函数的参数类型，约束所有回送消息都符合协议 union。
// 注意 import specifier 显式写 .ts：Node 24 type stripping 直接读源码；
// tsc emit 时由 rewriteRelativeImportExtensions 改写成 .js，无需手动维护两份路径。
import {
  parseWorkerRequest,
  rejectedResponse,
  type WorkerResponse,
} from './32-worker-protocol.ts';

/**
 * Worker entry：必须保持"可擦除 TypeScript"语法，因为第 32 课会直接让
 * Node 24 从 .ts 源码启动 Worker；Node 只剥离类型，不读取 tsconfig，也不转换 enum。
 */

// 防御性检查：parentPort 只在「通过 new Worker 启动」的线程里才存在。
// 如果有人直接 node 执行本文件，parentPort 是 null，立刻抛错并给出明确原因。
// 抛出的 Error 会被主线程的 worker.once('error', ...) 捕获（见 client.ts:200 注册的 onError）。
if (parentPort === null) {
  throw new Error('checksum worker 必须由 Worker 构造器启动');
}

// 把 parentPort 绑定到常量 port：TS 在闭包里就不会再认为它「可能为 null」，
// 后面 post/onmessage 等所有代码都直接享受 NonNullable 收窄，省去重复 null 检查。
// 关键：如果不拷贝这一步，TS 会因为 parentPort 是「模块级 let」而拒绝在闭包内收窄。
const port = parentPort;

// post：把任意 WorkerResponse 通过 parentPort 回送主线程。
// 封装一层的目的是让调用点只关心协议对象（kind/taskId/...），不必每次显式写 port.postMessage。
// 同时把「消息必须符合 WorkerResponse union」这件事在签名层面钉死，写错任意字段都会被 tsc 拦下。
function post(response: WorkerResponse): void {
  port.postMessage(response);
}

// once('message', ...)：本 Worker 是「一次性任务」语义——只处理一条请求。
// 处理完（无论 completed / cancelled / rejected）都 return，让线程进入空闲，
// 由主线程的 await using 触发 worker[Symbol.asyncDispose]() 终止它。
// 用 once 而不是 on：避免「同一个 worker 处理第二条请求」——本协议的设计前提就是一任务一线程。
port.once('message', (raw: unknown) => {
  // 跨线程 message 永远以 unknown 到达，必须先用 parseWorkerRequest 验证。
  // 即便主线程代码也跑过同一个 parser，Worker 这边仍要再跑一次：消息边界默认不安全。
  // 这是「信任边界」的唯一关口——任何非法字段在这里被拦截，不会污染后面的循环。
  const decoded = parseWorkerRequest(raw);
  if (!decoded.ok) {
    // 解析失败：把全部诊断打包成 rejectedResponse 回送，然后结束本次任务。
    // raw 透传给 rejectedResponse：它会尝试从 raw 里抠出 taskId，找不到就回送 null。
    post(rejectedResponse(raw, decoded.issues));
    return; // 直接退出 message 回调；线程进入空闲，等待主线程 terminate。
  }

  // 拿到已验证的请求；下面所有字段都已被 parser 证明类型安全。
  const request = decoded.value;
  // 把 ArrayBuffer 包装成 Uint32Array 视图：按 4 字节一个元素遍历。
  // 注意 values 是 transfer 过来的——此时主线程那边的 buffer 已 detached（byteLength=0）。
  // parser 已保证 byteLength % 4 === 0，这里 new Uint32Array 不会抛 RangeError。
  const values = new Uint32Array(request.values);
  // cancelFlag 是 SharedArrayBuffer：构造一个长度为 1 的 Int32 视图供 Atomics 操作。
  // 第三参数 length=1 显式只取首 4 字节，避免被 cancelFlag 整体长度影响。
  // 主线程的 cancelView（client.ts:87）操作的是同一块共享内存，写入这边能立即读到。
  const cancelFlag = new Int32Array(request.cancelFlag, 0, 1);

  // 通知主线程「Worker 已进入任务」。
  // 主线程可在 onStarted 回调里同步触发 AbortController.abort——
  // 这让测试能在 CPU 同步循环真正吃满事件循环之前完成取消设置。
  // 【时序关键】这条消息必须在 CPU 循环开始之前发送，否则取消测试来不及触发。
  post({ kind: 'started', taskId: request.taskId });

  // 累加器与已处理操作数。checksum 用普通 number，运算时再 >>>0 收敛回 uint32。
  // 用普通 number 而不是 Uint32Array：JS 的 number 是 double，能精确表示 2^53 以内的整数，
  // 而 uint32 加法最多到 2^32，远在安全范围内——临时累加器不会丢精度。
  let checksum = 0;
  let processedOperations = 0; // 既用于回送响应，也用作「轮询取消」的节拍器（见下）。

  // 双层循环：外层 rounds 轮，内层遍历整个数组。
  // 这是「CPU 同步循环」——一旦开始，事件循环就被阻塞，主线程发的 message 进不来。
  // 因此取消机制必须靠 SharedArrayBuffer + Atomics 轮询，而不是再发一条 'cancel' 消息。
  for (let round = 0; round < request.rounds; round += 1) {
    for (let index = 0; index < values.length; index += 1) {
      // CPU 同步循环占用的是 Worker 自己的事件循环；它读不到普通 cancel message。
      // SharedArrayBuffer + Atomics.load 不需要 Worker 处理另一个 message callback。
      // 每处理 0x4000=16384 次检查一次取消标志：频次足够及时（毫秒级响应），开销又可以忽略。
      // 用位与 (processedOperations & 0x3fff) === 0 判断「正好走到 16384 倍数」——
      // 位运算比 % 取模快很多，且 processedOperations 本身单调递增，没有边界陷阱。
      if ((processedOperations & 0x3fff) === 0 && Atomics.load(cancelFlag, 0) === 1) {
        // 读到 cancelFlag=1：主线程已请求中止。回送 cancelled 并直接退出。
        // Atomics.load 保证跨线程可见性：主线程 Atomics.store 之前的写入对这里也可见。
        post({
          kind: 'cancelled',
          taskId: request.taskId,
          processedOperations, // 把「中止前完成了多少」一并回送，便于主线程观测。
        });
        return; // 退出 message 回调 → 线程空闲 → 主线程 await using 触发 dispose。
      }

      // values[index] 在 noUncheckedIndexedAccess 下是 number | undefined；
      // ?? 0 是兜底，逻辑上 length 已对齐 4 字节所以不会越界，但仍保留防御。
      // 真要越界（理论不会发生）只会当成 0，不会污染 checksum。
      const value = values[index] ?? 0;
      // >>>0：无符号右移 0 位，把超过 32 位的进位截掉，等价于「按 uint32 取模」。
      // 这一行是「uint32 加法」的核心：JS 没有原生 uint32 类型，全靠 >>>0 收敛。
      checksum = (checksum + value) >>> 0;
      processedOperations += 1; // 既统计进度，又驱动上面的轮询节拍。
    }
  }

  // 正常结束：回送最终 checksum 与总操作数。主线程的 onMessage 收到后 settle(resolve)。
  // processedOperations 应等于 values.length * request.rounds；测试用此不变量做端到端校验。
  post({
    kind: 'completed',
    taskId: request.taskId,
    checksum, // 已被 >>>0 收敛到 [0, 0xffffffff]，parser 不会再拦。
    processedOperations,
  });
});

// 让本文件成为 module（否则 parentPort 等顶层副作用会被当作 script 直接执行），
// 同时给 tsc / Node type stripping 一个明确的模块边界。
// export {} 不导出任何东西，纯副作用：触发 ESM module 解析。
export {};
