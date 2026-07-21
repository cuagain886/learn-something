// client.ts：JSON-RPC 关联器（半双工“只发请求”的一侧）。
//
// 分层定位：
//   - 持有一个 RpcTransport（来自 transport.ts），订阅它的 onMessage/onClose；
//   - 发 request 时分配 id、注册 pending、关联 AbortSignal/timeout；
//   - 收到 response 时按 id 找回 pending，resolve 或 reject；
//   - 通过 codec.ts 做 params/result 的 Schema 编解码；
//   - 通过 jsonrpc.ts 做 wire message 的结构验证。
//
// 本类是“半双工”：只发送 request/notification、只接收 response。
// MCP 的 server→client sampling/elicitation 需要在同一 transport 上再组合反向 dispatcher。
import type { Infer, Schema } from '../17-schema.js';
import {
  RpcPayloadValidationError,
  decodeResult,
  encodeParams,
  type RpcSchemaConstraint,
} from './codec.js';
import {
  decodeJsonValue,
  decodeJsonRpcMessage,
  isJsonObject,
  isResponse,
  type JsonRpcError,
  type JsonRpcMessage,
  type JsonValue,
  type RequestId,
} from './jsonrpc.js';
import type { RpcTransport, Unsubscribe } from './transport.js';

// RequestOptions：每次 request 的可选控制项。
// signal 用于取消；timeoutMs 用于超时；sendCancellation 由 MCP session 设置（initialize 禁止发 cancel）。
type RequestOptions = {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** initialize 不能发送 MCP cancellation；Session 会把它设为 false。 */
  readonly sendCancellation?: boolean;
};

// Pending：一个在途请求的完整状态——resolve/reject 让 transport 回包时能唤醒 caller Promise。
// cleanup 在 settle/取消/关闭时统一清理 timer 与 abort 监听器，避免资源泄漏。
type Pending = {
  readonly method: string;
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (reason: unknown) => void;
  readonly cleanup: () => void;
};

// Tombstone：已 settle/取消 的 id 墓碑。
// 用途：MCP 取消有竞态——取消通知到达前 server 可能已发 response。
// 没有墓碑的话，迟到的 response 会被当成“未知 id”升级成协议错误。
type Tombstone = {
  readonly id: RequestId;
  readonly kind: 'cancelled' | 'settled';
};

// 下面四个 Error 子类把“失败原因”分类，调用方可以按 instanceof 精确处理。
// RpcRemoteError：server 返回了 error response（带 JSON-RPC error code）。
export class RpcRemoteError extends Error {
  constructor(
    readonly method: string,
    readonly rpcError: JsonRpcError,
  ) {
    super(`${method} 远端失败 [${rpcError.code}]: ${rpcError.message}`);
    this.name = 'RpcRemoteError';
  }
}

// RpcRequestCancelledError：本地 AbortSignal 触发或 timeout 到期导致请求取消。
export class RpcRequestCancelledError extends Error {
  constructor(
    readonly method: string,
    readonly requestId: RequestId,
    readonly reason: unknown,
  ) {
    super(`${method} 请求 ${String(requestId)} 已取消`, { cause: reason });
    this.name = 'RpcRequestCancelledError';
  }
}

// RpcRequestTimeoutError：超过 timeoutMs 仍未收到 response。
// 作为 cancel 的 reason 传入，最终抛出的是 RpcRequestCancelledError。
export class RpcRequestTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`${method} 超过 ${timeoutMs}ms 未响应`);
    this.name = 'RpcRequestTimeoutError';
  }
}

// RpcProtocolViolationError：对端发了不符合 wire 协议的消息（重复 response、未知 id 等）。
// 一旦出现就视为连接级故障：关闭整条 transport。
export class RpcProtocolViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcProtocolViolationError';
  }
}

// RpcConnectionClosedError：transport 已关闭，所有 pending 都用它 reject。
export class RpcConnectionClosedError extends Error {
  constructor(readonly reason: unknown) {
    super('JSON-RPC connection 已关闭', { cause: reason });
    this.name = 'RpcConnectionClosedError';
  }
}

/**
 * 只实现“本端发 request/notification，远端回 response”的半双工角色。
 * MCP 的 server-to-client sampling/elicitation 应在同一 transport 上再组合反向 dispatcher。
 */
export class JsonRpcClient<
  const Methods extends RpcSchemaConstraint<Methods>,
> {
  // #pending：id → Pending，关联表的核心。response 回来时按 id 取出对应 Pending。
  readonly #pending = new Map<RequestId, Pending>();
  // #tombstones / #tombstoneOrder：已结束请求的 id 墓碑 + 插入顺序。
  // tombstoneOrder 是个简单队列，用于超过上限时按 FIFO 淘汰最老墓碑。
  readonly #tombstones = new Map<RequestId, Tombstone['kind']>();
  readonly #tombstoneOrder: RequestId[] = [];
  // 两个 unsubscribe：构造时订阅 transport，close 时统一撤销，避免 transport 复活后收到旧消息。
  readonly #unsubscribeMessage: Unsubscribe;
  readonly #unsubscribeClose: Unsubscribe;
  // #nextId：自增 id 计数器。client 只用一个连接，单调整数 id 足够。
  #nextId = 1;
  // #closedReason：undefined 表示未关闭；一旦赋值（含 undefined reason 被 sentinel 包裹）即为终态。
  #closedReason: unknown;

  constructor(
    readonly transport: RpcTransport,
    readonly methods: Methods,
    readonly options: {
      readonly maxPending?: number;
      readonly maxTombstones?: number;
    } = {},
  ) {
    // 构造时校验数值选项，fail-fast 避免运行时才暴露配置错误。
    positiveInteger(options.maxPending ?? 128, 'maxPending');
    positiveInteger(options.maxTombstones ?? 256, 'maxTombstones');
    // 订阅 transport 的两类事件：消息与关闭。把回调绑到实例方法上。
    this.#unsubscribeMessage = transport.onMessage((raw) => this.#onMessage(raw));
    this.#unsubscribeClose = transport.onClose((reason) => this.#onClose(reason));
  }

  // pendingCount：暴露当前在途请求数，供 demo/test 观察资源占用。
  get pendingCount(): number {
    return this.#pending.size;
  }

  // closed：是否已进入终态。用 #closedReason !== undefined 判定，配合 #onClose 里的 sentinel 保证稳定。
  get closed(): boolean {
    return this.#closedReason !== undefined;
  }

  // request：核心方法——发一个 request，等对应的 response。
  // 类型签名让 method name 同时决定 params 与 result 的领域类型（keyof Methods & string 的精妙之处）。
  async request<Name extends keyof Methods & string>(
    method: Name,
    params: Infer<Methods[Name]['params']>,
    options: RequestOptions = {},
  ): Promise<Infer<Methods[Name]['result']>> {
    this.#ensureOpen();
    // 容量检查：防止对端不发响应时 pending 表无限增长。
    if (this.#pending.size >= (this.options.maxPending ?? 128)) {
      throw new RangeError('pending request 已达到上限');
    }
    // 早期 abort 检查：signal 已 abort 就不要分配 id、不要发包。
    if (options.signal?.aborted) {
      throw new RpcRequestCancelledError(method, 'not-sent', options.signal.reason);
    }
    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined) positiveInteger(timeoutMs, 'timeoutMs');

    // 查表拿到该方法的 codec；没有 schema 说明 Methods 类型与运行时不一致。
    const codec = this.methods[method];
    if (codec === undefined) throw new Error(`没有 method schema: ${method}`);
    // 出口编码：Schema 校验 + JSON 安全化。
    const wireParams = encodeParams(codec.params, params);
    // 分配 id 必须在 encodeParams 成功之后——避免 encode 失败却占用了一个 id。
    const id = this.#allocateId();

    let timer: ReturnType<typeof setTimeout> | undefined;
    let detachAbort: () => void = () => undefined;
    // rawResult 是“等 transport 回包”的 Promise。resolve/reject 由 #onMessage 调用。
    const rawResult = new Promise<JsonValue>((resolve, reject) => {
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        detachAbort();
      };
      this.#pending.set(id, { method, resolve, reject, cleanup });

      // cancel：取消一个在途请求的统一路径——删除 pending、记墓碑、reject caller、可选发通知。
      const cancel = (reason: unknown) => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        pending.cleanup();
        this.#remember(id, 'cancelled');
        pending.reject(new RpcRequestCancelledError(method, id, reason));
        // sendCancellation !== false 时才发 notifications/cancelled（initialize 禁止发）。
        if (options.sendCancellation !== false) {
          void this.notify('notifications/cancelled', {
            requestId: id,
            ...(typeof reason === 'string' ? { reason } : {}),
          }).catch(() => undefined);
        }
      };

      // 把 AbortSignal 接到 cancel 上：signal abort 时立即触发取消流程。
      if (options.signal !== undefined) {
        const onAbort = () => cancel(options.signal?.reason);
        options.signal.addEventListener('abort', onAbort, { once: true });
        detachAbort = () => options.signal?.removeEventListener('abort', onAbort);
      }
      // timeout 本质上也是一种 cancel，只是 reason 换成 RpcRequestTimeoutError。
      if (timeoutMs !== undefined) {
        timer = setTimeout(
          () => cancel(new RpcRequestTimeoutError(method, timeoutMs)),
          timeoutMs,
        );
      }
    });

    try {
      // 真正写入 transport。如果 send 失败（对端关闭等），把 pending 清掉并 reject。
      await this.transport.send({
        jsonrpc: '2.0',
        id,
        method,
        params: wireParams,
      });
    } catch (cause: unknown) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        this.#pending.delete(id);
        pending.cleanup();
        pending.reject(cause);
      }
    }

    // 等待 #onMessage 把 rawResult resolve（或 cancel/close 把它 reject）。
    const result = await rawResult;
    // 入口解码：用 method 的 result schema 再次校验 wire 值——静态类型不能替代运行时证据。
    const resultSchema = codec.result as Schema<Infer<Methods[Name]['result']>>;
    return decodeResult(resultSchema, result);
  }

  // notify：发单向通知（无 id，不期待 response）。
  // 与 request 一样走 decodeJsonValue：调用方传的对象可能含 getter/symbol，必须在出口拦下。
  async notify(
    method: string,
    params?: Record<string, JsonValue>,
  ): Promise<void> {
    this.#ensureOpen();
    let wireParams: Record<string, JsonValue> | undefined;
    if (params !== undefined) {
      const decoded = decodeJsonValue(params);
      if (!decoded.ok) throw new RpcPayloadValidationError('params', decoded.issues);
      if (!isJsonObject(decoded.value)) {
        throw new RpcPayloadValidationError('params', [{
          path: [],
          pointer: '',
          message: 'notification params 必须是 JSON object',
        }]);
      }
      wireParams = decoded.value;
    }
    const message: JsonRpcMessage = {
      jsonrpc: '2.0',
      method,
      ...(wireParams === undefined ? {} : { params: wireParams }),
    };
    await this.transport.send(message);
  }

  // close：主动关闭。先标记本端终态（拒绝后续 request、reject 全部 pending），再关 transport。
  async close(reason: unknown = new Error('client 主动关闭')): Promise<void> {
    if (this.closed) return;
    this.#onClose(reason);
    await this.transport.close(reason);
  }

  // #allocateId：分配下一个 request id。
  // Number.isSafeInteger 检查防止 id 溢出——超过 2^53 后无法安全比较，必须断开重连。
  #allocateId(): number {
    if (!Number.isSafeInteger(this.#nextId)) {
      throw new RangeError('JSON-RPC request id 已耗尽；必须建立新 connection');
    }
    const id = this.#nextId;
    this.#nextId += 1;
    return id;
  }

  // #onMessage：transport 收到消息的总入口。
  // 只接受 response；任何 request/notification/decode 失败都视为协议错误。
  #onMessage(raw: unknown): void {
    if (this.closed) return;
    const decoded = decodeJsonRpcMessage(raw);
    if (!decoded.ok) {
      this.#protocolFault(new RpcProtocolViolationError(
        `收到非法 JSON-RPC：${decoded.issues
          .map((item) => `${item.pointer || '/'} ${item.message}`)
          .join('; ')}`,
      ));
      return;
    }
    // 半双工角色：远端不该发 request/notification 到 client。
    if (!isResponse(decoded.value)) {
      this.#protocolFault(new RpcProtocolViolationError(
        '单向 JsonRpcClient 不接受远端 request/notification',
      ));
      return;
    }
    const response = decoded.value;
    // null id 的 response 无法关联到任何 pending——必然是协议错误或 server 实现 bug。
    if (response.id === null) {
      const message = 'error' in response
        ? response.error.message
        : 'success response 不允许 null id';
      this.#protocolFault(new RpcProtocolViolationError(
        `收到无法关联的 JSON-RPC response: ${message}`,
      ));
      return;
    }

    // 墓碑检查：cancelled 表示这个请求已被本地取消，迟到的 response 静默丢弃。
    const tombstone = this.#tombstones.get(response.id);
    if (tombstone === 'cancelled') {
      // MCP 取消允许竞态：取消后的迟到 response 必须忽略。
      this.#tombstones.delete(response.id);
      return;
    }
    // settled 表示这个 id 已经回过一次 response——再回是重复，升级为协议错误。
    if (tombstone === 'settled') {
      this.#protocolFault(new RpcProtocolViolationError(
        `request ${String(response.id)} 收到重复 response`,
      ));
      return;
    }

    // 正常路径：找到 pending，删表、清理、记 settled 墓碑、resolve/reject。
    const pending = this.#pending.get(response.id);
    if (pending === undefined) {
      // 既不在 pending 也不在墓碑 → id 完全陌生，连接已混乱，关闭。
      this.#protocolFault(new RpcProtocolViolationError(
        `response id ${String(response.id)} 不对应任何 pending request`,
      ));
      return;
    }
    this.#pending.delete(response.id);
    pending.cleanup();
    this.#remember(response.id, 'settled');
    if ('error' in response) {
      pending.reject(new RpcRemoteError(pending.method, response.error));
    } else {
      pending.resolve(response.result);
    }
  }

  // #remember：记录一个墓碑并维护 FIFO 上限。
  // 上限存在是因为不能让墓碑表在长连接里无限增长。
  #remember(id: RequestId, kind: Tombstone['kind']): void {
    this.#tombstones.set(id, kind);
    this.#tombstoneOrder.push(id);
    const maximum = this.options.maxTombstones ?? 256;
    while (this.#tombstoneOrder.length > maximum) {
      const oldest = this.#tombstoneOrder.shift();
      if (oldest !== undefined) this.#tombstones.delete(oldest);
    }
  }

  // #protocolFault：协议级故障。直接关闭本端 + transport，不再尝试恢复。
  #protocolFault(error: RpcProtocolViolationError): void {
    this.#onClose(error);
    void this.transport.close(error).catch(() => undefined);
  }

  // #onClose：终态进入函数——幂等。
  // 不管是主动 close、transport 远端关闭，还是协议错误，都走这一条路统一清理。
  #onClose(reason: unknown): void {
    if (this.closed) return;
    // undefined 也可能是合法关闭 reason；用 sentinel Error 保证 closed 判定稳定。
    this.#closedReason = reason ?? new RpcConnectionClosedError(reason);
    this.#unsubscribeMessage();
    this.#unsubscribeClose();
    const error = reason instanceof RpcConnectionClosedError
      ? reason
      : new RpcConnectionClosedError(reason);
    // 所有还在等的 pending 一律用 RpcConnectionClosedError reject——它们再也等不到 response 了。
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.#pending.clear();
  }

  // #ensureOpen：request/notify 入口的守卫。已关闭就立刻抛错，不要让调用方以为请求已发出。
  #ensureOpen(): void {
    if (this.closed) throw new RpcConnectionClosedError(this.#closedReason);
  }
}

// positiveInteger：选项校验工具。安全整数且 ≥1 才合法。
function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} 必须是正安全整数`);
  }
}
