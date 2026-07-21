/**
 * 第 32 课的跨线程协议。
 *
 * 这里同时保留两层契约：
 *   - TypeScript union：让同一编译图中的调用方获得静态关联；
 *   - parse 函数：Worker message 在运行时仍是 unknown，必须重新验证。
 *
 * interface/type 在 emit 后消失；共享这个文件不等于共享了运行时 schema。
 */

// DecodeResult<Value>：所有 parser 的统一返回值，用「ok 字段」做可辨识联合（discriminated union）。
//   - 成功分支携带 value：已通过运行时验证的具体值；
//   - 失败分支携带 issues：人类可读的诊断字符串列表。
// 调用方先用 if (!decoded.ok) 收窄类型，再访问对应分支的字段，TS 会保证不会取错。
// 这层包装让「跨线程数据」也拥有「Try/Result」式的安全通道。
// 【跨文件配合】checksum-worker.ts:42 与 client.ts:101/134 都把这个返回值当作
// 「跨线程边界的唯一可信来源」——只有 .ok === true 时才允许继续访问 .value。
// Value 是延迟参数：parser 把「输入 unknown」收窄为「输出 Value」的具体类型。
export type DecodeResult<Value> =
  // 成功分支：value 的类型就是调用方声明的 Value（如 WorkerRequest / WorkerResponse）。
  | { readonly ok: true; readonly value: Value }
  // 失败分支：issues 是 readonly string[]，调用方可以直接拼进 Error message 或回送诊断。
  | { readonly ok: false; readonly issues: readonly string[] };

// ===== 主线程 → Worker：请求方向 =====

// ComputeRequest：唯一的请求形态——一次「对 values 做 rounds 轮 uint32 加法并取校验和」的任务。
// 注意 values 与 cancelFlag 的内存语义截然不同（下面两个字段分别说明）。
// 【跨文件配合】client.ts:90 构造此对象并交给 postMessage；checksum-worker.ts:50 在
// port.once('message') 回调里消费它。两端共享同一个 .ts 类型定义，但运行时各自独立解析。
export type ComputeRequest = {
  // 字面量 'compute' 作为请求标识；将来若新增 kind，主线程与 Worker 都用同一份 union 区分。
  readonly kind: 'compute';
  // 任务唯一 id：主线程生成，用来把异步响应（started/completed/...）匹配回这一次调用。
  readonly taskId: string; // client.ts:48 通过自增序列生成 `checksum_<n>`；Worker 不解析也不修改它。
  /** transfer 后发送方的这个 ArrayBuffer 会 detached。 */
  // values 是「被转移所有权」的载荷：放进 postMessage 的 transferList 后，
  // 主线程这边的 buffer.byteLength 立刻变为 0，所有共享 view 同时失效。
  readonly values: ArrayBuffer; // Worker 端用 new Uint32Array(values) 包装消费，见 checksum-worker.ts:53。
  // rounds：对整个数组重复累加多少轮；和 values.length 一起决定总操作数（受预算上限约束）。
  readonly rounds: number; // 范围 1..MAX_ROUNDS；越界会被 parseWorkerRequest 在 transfer 前拦下。
  /** 不放入 transferList；父子线程持有同一块共享内存。 */
  // cancelFlag 是「协作取消」的载体：主线程 Atomics.store(1) 后，
  // Worker 在 CPU 循环里 Atomics.load 读到 1 就主动中止。它不是复制，而是真正共享物理内存。
  readonly cancelFlag: SharedArrayBuffer; // client.ts:85 创建，长度刚好 4 字节 = 1 个 Int32。
};

// WorkerRequest：当前协议只有一种请求，直接等于 ComputeRequest。
// 单独留一层 alias 是为日后扩展（如 query / abort 等新 kind）保留出口。
export type WorkerRequest = ComputeRequest; // 「请求 union」的当前形态；扩展时只需把它改成 `| QueryRequest | ...`。

// ===== Worker → 主线程：响应方向 =====
// 四种响应合成 WorkerResponse union，每种都以字面量 kind 区分。
// 【顺序约定】started 先于 terminal（completed/cancelled/rejected）；terminal 之后不再有消息。

// WorkerStarted：Worker 收到合法请求并已开始处理时回送。
// 主线程可借此触发 onStarted 回调（测试用它在「Worker 刚进入任务」时刻同步触发 abort）。
// 【跨文件配合】checksum-worker.ts:61 是唯一发送点；client.ts:155 在 onMessage 里消费。
export type WorkerStarted = {
  readonly kind: 'started';
  readonly taskId: string; // 与请求的 taskId 完全一致；client.ts:145 据此做防御性匹配。
};

// WorkerCompleted：任务正常完成的最终回送。
// 【跨文件配合】checksum-worker.ts:93 在循环正常结束后发送；client.ts:160 据此 resolve Promise。
export type WorkerCompleted = {
  readonly kind: 'completed';
  readonly taskId: string;
  /** 所有加法都按 uint32 取模，避免超过 Number 安全整数。 */
  // checksum 是 uint32 范围内的最终校验和；超出 2^32 的进位会被 >>>0 截掉。
  readonly checksum: number; // 主线程断言 checksum === 期望值，见 32-worker-threads.test.ts:92。
  // processedOperations：Worker 实际累加了多少次。
  // 正常完成时 = values.length * rounds；被取消时小于这个值，可观测「跑到哪中止了」。
  readonly processedOperations: number; // 期望值 = values.length * rounds；测试用它做端到端校验。
};

// WorkerCancelled：Worker 在轮询中读到 cancelFlag=1，按协作约定中止。
// 【跨文件配合】checksum-worker.ts:75 在 CPU 循环中检测到取消标志后发送；client.ts:165 据此 reject。
export type WorkerCancelled = {
  readonly kind: 'cancelled';
  readonly taskId: string;
  // 中止前的累加次数；让主线程知道「在收到取消前完成了多少」。
  readonly processedOperations: number; // 与 completed 不同，这里没有 checksum（任务没算完）。
};

// WorkerRejected：请求在协议层非法（字段缺失/类型错/范围越界等）。
// 【跨文件配合】checksum-worker.ts:45 在 parseWorkerRequest 失败时通过 rejectedResponse 发送；
// client.ts:170 据此 reject 并把诊断拼进 Error message。
export type WorkerRejected = {
  readonly kind: 'rejected';
  // taskId 允许 null：极端情况下 raw 请求根本没有 taskId 字段，但仍要回送一条诊断响应。
  readonly taskId: string | null; // null 仅出现在「请求里压根没有 taskId」的极端情况。
  // 全部诊断字符串；与 DecodeResult 的 issues 同构，便于主线程直接拼进 Error message。
  readonly issues: readonly string[]; // 通常来自 parseWorkerRequest 收集的 issues 列表。
};

// WorkerResponse：四种响应合成的可辨识联合。
// 主线程拿到 message 后通过 parseWorkerResponse 收窄到其中一种。
// 【关键】四种 kind 互斥；client.ts:152 的 switch 依赖 response.kind 做穷尽分发。
export type WorkerResponse =
  | WorkerStarted
  | WorkerCompleted
  | WorkerCancelled
  | WorkerRejected;

// ===== 运行时验证：解析器与守卫 =====
// 上面的 union 只存在于编译期；postMessage 接收端拿到的是 unknown，必须用运行时代码重新证明。

// 两道「预算上限」防止恶意或手滑参数把 Worker 跑死：
//   - MAX_ROUNDS：单次请求允许的最大轮数（1e9）；
//   - MAX_OPERATIONS：「数组长度 × 轮数」的联合上限（2e9），用于拦截「轮数小但数组巨大」这类组合攻击。
const MAX_ROUNDS = 1_000_000_000; // 单独约束 rounds 字段；超出会被 parser 拒绝（client.ts:144 的测试用例覆盖此路径）。
const MAX_OPERATIONS = 2_000_000_000; // values/4 * rounds 的联合上限；防止「小轮数 × 巨大数组」的组合攻击。

// isRecord：最外层守卫，把 unknown 收窄成「非 null 的 object」。
// 关键点：typeof null === 'object'，所以必须显式排除 null，否则后面 value['key'] 会爆。
// 用 Record<PropertyKey, unknown> 让后续索引访问既能通过类型检查，又不丢 unknown 性质。
// 返回类型是 `value is Record<PropertyKey, unknown>`：调用方拿到 true 后即可安全索引任意 key。
function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null; // typeof 对 array/object 都返回 'object'，后续字段校验自会区分。
}

// isNonNegativeSafeInteger：判断值是否为「非负安全整数」。
// Number.isSafeInteger 保证整数且在 ±2^53-1 范围内，再叠加 >= 0 用于 processedOperations / checksum 等无符号量。
// 「SafeInteger」意味着它能在 IEEE754 double 里精确表示；超过 2^53 的字面量已经丢精度了。
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value) // 拦住 NaN / Infinity / 小数 / 超出 2^53 的整数。
    && value >= 0; // 拦住负数；processedOperations / checksum 都是无符号量。
}

// isPositiveSafeInteger：在非负基础上要求 > 0，专给 rounds 这种「至少 1 轮」的字段。
function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0; // 复用非负校验，再叠加 > 0。
}

// isStringArray：判断值是否为 readonly string[]。
// 不仅 Array.isArray，还要 every 元素都是 string，用于 WorkerRejected.issues。
// 用 every 而不是直接断言：跨线程 message 的 array 元素仍是 unknown，必须逐个验证。
function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string'); // every 短路：遇到非 string 立即 false。
}

// taskIdFromUnknown：从「无法解析的 raw 请求」里尽量抠出 taskId。
// 用于 rejectedResponse——即使请求整体非法，也尽量回送一个能匹配的 taskId，找不到就给 null。
// 注意只看类型，不看空字符串：这里只是「尽量还原」，真正的非空校验在 parseWorkerRequest 里。
function taskIdFromUnknown(value: unknown): string | null {
  if (!isRecord(value)) return null; // 连 object 都不是 → 没法取字段 → null。
  return typeof value['taskId'] === 'string' ? value['taskId'] : null; // 是 string 就原样回送；否则 null。
}

// parseWorkerRequest：Worker 端接收主线程 message 时调用。
// 设计要点：不是遇到第一个错误就 return，而是把所有字段问题收集到 issues 一次性返回，
// 让调用方一次看到全部诊断（与典型的表单校验风格一致）。
// 返回 value 是「已被运行时证明」的 WorkerRequest，TS 据此接受后续使用。
// 【跨文件配合】checksum-worker.ts:42 调用此函数；client.ts:101 在 transfer 前也跑一遍做自检。
export function parseWorkerRequest(value: unknown): DecodeResult<WorkerRequest> {
  // issues 是「累积式」错误收集器：每个字段的检查都把问题 push 进来，最后一次性返回。
  // 这样调用方可以一次看到全部问题，而不是反复试错。
  const issues: string[] = [];
  if (!isRecord(value)) {
    // 非 object / null：连字段都没法看，直接返回单条诊断。
    return { ok: false, issues: ['request 必须是非 null object'] };
  }

  // kind 校验：当前协议只接受 'compute' 这一种请求 kind。
  // 字面量严格比较（!==）：将来加新 kind 时，这里就是 union 扩展点。
  if (value['kind'] !== 'compute') {
    issues.push("kind 必须是 'compute'");
  }

  // taskId 校验：必须是非空 string；空字符串会被拒，避免日志无法定位任务。
  // 注意只 push 一条诊断，不在这里 return——后面字段也要继续看。
  const taskId = value['taskId'];
  if (typeof taskId !== 'string' || taskId.length === 0) {
    issues.push('taskId 必须是非空 string');
  }

  // values 校验：必须是 ArrayBuffer（不是 TypedArray view，而是底层 buffer）。
  // 同时校验长度非零、且按 uint32(4 bytes) 对齐——否则 Worker 端 Uint32Array(values) 会抛 RangeError。
  // 用 instanceof 而不是 typeof：ArrayBuffer 是真实对象，typeof 只会告诉你 'object'。
  const values = value['values'];
  if (!(values instanceof ArrayBuffer)) {
    issues.push('values 必须是 ArrayBuffer');
  } else if (values.byteLength === 0 || values.byteLength % Uint32Array.BYTES_PER_ELEMENT !== 0) {
    // byteLength === 0：空 buffer 没意义；% 4 !== 0：uint32 视图无法对齐。
    issues.push('values.byteLength 必须是非零且能被 4 整除');
  }

  // rounds 校验：必须是 1..MAX_ROUNDS 的安全整数。
  // 先校验「是正安全整数」再校验上界，避免 NaN 与 MAX_ROUNDS 比较时的怪异行为。
  const rounds = value['rounds'];
  if (!isPositiveSafeInteger(rounds) || rounds > MAX_ROUNDS) {
    issues.push(`rounds 必须是 1..${MAX_ROUNDS} 的安全整数`);
  }

  // cancelFlag 校验：必须是 SharedArrayBuffer（普通 ArrayBuffer 不能跨线程共享内存）。
  // 长度至少 4 bytes 才能装一个 Int32，供 Atomics.load/store 操作。
  // 注意：这里只认 SharedArrayBuffer，普通 ArrayBuffer 即便放进 transferList 也不是「共享内存」。
  const cancelFlag = value['cancelFlag'];
  if (!(cancelFlag instanceof SharedArrayBuffer)) {
    issues.push('cancelFlag 必须是 SharedArrayBuffer');
  } else if (cancelFlag.byteLength < Int32Array.BYTES_PER_ELEMENT) {
    // 至少要能装下一个 Int32；否则 Atomics.load(view, 0) 越界。
    issues.push('cancelFlag 至少需要 4 bytes');
  }

  // 联合预算校验：单看 rounds / 数组长度都不超标，但乘起来可能爆掉。
  // 仅在 values 是 ArrayBuffer 且 rounds 合法时才计算，避免用 NaN 做无意义比较。
  // 这条防御专门针对「每项都合格，但乘积把 Worker 跑死」的组合攻击。
  if (
    values instanceof ArrayBuffer
    && isPositiveSafeInteger(rounds)
    && (values.byteLength / Uint32Array.BYTES_PER_ELEMENT) * rounds > MAX_OPERATIONS
  ) {
    issues.push(`总操作数不能超过 ${MAX_OPERATIONS}`);
  }

  // 任意字段有问题：整体失败；issues 里是上面累积的全部诊断。
  if (issues.length > 0) return { ok: false, issues };

  // 上面的逐字段验证是运行时证明；断言只把已证明事实交还给 checker。
  // 每一个 as 都对应前面具体的 instanceof / typeof 检查，并非凭空断言，可以安全收窄。
  // 这里的对象字面量是「重新构造」而不是「直接返回原 value」：避免把 raw 上未知字段透传出去。
  return {
    ok: true,
    value: {
      kind: 'compute', // 已通过字面量比较证明 === 'compute'。
      taskId: taskId as string, // 已通过 typeof + length 校验。
      values: values as ArrayBuffer, // 已通过 instanceof + byteLength 校验。
      rounds: rounds as number, // 已通过 isPositiveSafeInteger + 上界校验。
      cancelFlag: cancelFlag as SharedArrayBuffer, // 已通过 instanceof + 长度校验。
    },
  };
}

// parseWorkerResponse：主线程端接收 Worker 回送 message 时调用。
// 先做「必须是带 string kind 的 object」的外层校验，再按 kind 分发到不同字段的细校验。
// 【跨文件配合】client.ts:134 在 worker.on('message') 回调里调用；switch 与 WorkerResponse union 对齐。
export function parseWorkerResponse(value: unknown): DecodeResult<WorkerResponse> {
  if (!isRecord(value) || typeof value['kind'] !== 'string') {
    // 第一道闸：必须是 object，且 kind 必须是 string（不能是 number / undefined / null）。
    // 把它放在 switch 之前，否则 switch value['kind'] 会落入不可预测分支。
    return { ok: false, issues: ['response 必须是带 string kind 的 object'] };
  }

  // taskId 提前取一次：所有分支都需要它；下面 switch 内按需做进一步校验。
  // 注意这里 taskId 仍是 unknown——各 case 自己决定是否允许 null。
  const taskId = value['taskId'];
  // switch on kind：每个 case 都对应 WorkerResponse union 的一个成员，互斥分发。
  switch (value['kind']) {
    case 'started': {
      // started 只额外要求 taskId 非空 string，没有其他载荷。
      if (typeof taskId !== 'string' || taskId.length === 0) {
        return { ok: false, issues: ['started.taskId 必须是非空 string'] };
      }
      // 直接构造合法 WorkerStarted；taskId 已被证明是 string。
      return { ok: true, value: { kind: 'started', taskId } };
    }

    case 'completed': {
      // completed 要校验三个字段：taskId / checksum(uint32) / processedOperations。
      // 走「累积 issues」模式而不是一次 return，便于诊断「同时缺几个字段」。
      const checksum = value['checksum'];
      const processedOperations = value['processedOperations'];
      const issues: string[] = [];
      if (typeof taskId !== 'string' || taskId.length === 0) {
        issues.push('completed.taskId 必须是非空 string');
      }
      // checksum 必须落在 [0, 0xffffffff]：uint32 上界。
      // 用 > 0xffff_ffff 字面量比较（带数字分隔符便于读出 4 个 f）。
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
          taskId: taskId as string, // 已被上面 typeof 校验证明。
          checksum: checksum as number, // 已被 isNonNegativeSafeInteger + uint32 上界证明。
          processedOperations: processedOperations as number, // 已被 isNonNegativeSafeInteger 证明。
        },
      };
    }

    case 'cancelled': {
      // cancelled 与 completed 类似，但少了 checksum（任务没算完，校验和没意义）。
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
      // rejected 的 taskId 允许 string | null；issues 必须是 string[]。
      // 这是唯一允许 taskId === null 的分支：raw 请求可能根本没有 taskId。
      const issues = value['issues'];
      if ((taskId !== null && typeof taskId !== 'string') || !isStringArray(issues)) {
        return {
          ok: false,
          issues: ['rejected.taskId 必须是 string|null，issues 必须是 string[]'],
        };
      }
      // 用 [...issues] 复制成普通 mutable[]：避免把 Worker 侧传来的 readonly 引用直接暴露给外部。
      // 复制还隔离了「外部修改不影响内部 / 内部修改不污染外部」的边界。
      return {
        ok: true,
        value: { kind: 'rejected', taskId, issues: [...issues] },
      };
    }

    default:
      // 出现 union 之外的 kind：协议被破坏（或两端版本不一致），把未知 kind 写进诊断。
      // 走到这里说明 static switch 不穷尽——加新 kind 时要同步更新这个 default。
      return { ok: false, issues: [`未知 response kind: ${value['kind']}`] };
  }
}

// rejectedResponse：把任意 raw 请求转成一条 WorkerRejected。
// Worker 入口解析失败时用它把诊断送回主线程；尽量保留原 taskId（找不到给 null）。
// 【跨文件配合】checksum-worker.ts:45 在 parseWorkerRequest 返回 !ok 时调用。
export function rejectedResponse(raw: unknown, issues: readonly string[]): WorkerRejected {
  // 用 [...issues] 复制：parser 传来的 readonly string[] 不会被外部 mutate。
  return {
    kind: 'rejected',
    taskId: taskIdFromUnknown(raw), // 尽量还原 raw 里的 taskId；找不到给 null。
    issues: [...issues], // 防御性拷贝，避免外部与 parser 共享同一引用。
  };
}
