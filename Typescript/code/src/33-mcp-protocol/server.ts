// server.ts：JSON-RPC 请求分发器（半双工“只接请求”的一侧）。
//
// 分层定位（与 client.ts 对称）：
//   - 持有一个 RpcTransport，订阅它的 onMessage/onClose；
//   - 收到 request 时：校验 id 唯一性 → 查 codec/handler → decodeParams → 调 handler → encodeResult → 回 response；
//   - 收到 notification 时：内部处理 notifications/cancelled（abort 在途 handler）；其余转给 onNotification 回调；
//   - 收到 response → 抛错（单向 server 不接受远端 response）。
//   - 通过 #inFlight 给每个在途请求挂一个 AbortController，让取消信号能传到 handler。
import type { Infer } from '../17-schema.js';
import {
  decodeParams,
  encodeResult,
  RpcPayloadValidationError,
  type AnyRpcMethodSchema,
  type RpcSchemaConstraint,
} from './codec.js';
import {
  decodeJsonRpcMessage,
  decodeJsonValue,
  isNotification,
  isJsonObject,
  isRequest,
  type JsonObject,
  type JsonRpcErrorResponse,
  type JsonRpcRequest,
  type JsonValue,
  type RequestId,
} from './jsonrpc.js';
import type { RpcTransport, Unsubscribe } from './transport.js';

// RpcRequestContext：传给每个 handler 的执行上下文。
// requestId 让 handler 能在日志/取消里关联到具体请求；signal 让长任务感知取消。
export type RpcRequestContext = {
  readonly requestId: RequestId;
  readonly method: string;
  readonly signal: AbortSignal;
};

// RpcHandlers：每个 method 对应一个 handler 函数。
// 类型签名让 handler 的 params/result 自动从 Methods 推导，写错参数会编译期报错。
export type RpcHandlers<Methods extends RpcSchemaConstraint<Methods>> = {
  readonly [Name in keyof Methods]: (
    params: Infer<Methods[Name]['params']>,
    context: RpcRequestContext,
  ) => Infer<Methods[Name]['result']> | Promise<Infer<Methods[Name]['result']>>;
};

// ErasedHandler：handler 的类型擦除版本，便于在 dispatch 时统一存取。
type ErasedHandler = (
  params: unknown,
  context: RpcRequestContext,
) => unknown | Promise<unknown>;

// InFlight：一个正在执行的 handler 的状态。controller 用于接收 cancellation。
type InFlight = {
  readonly method: string;
  readonly controller: AbortController;
};

// RpcApplicationError：handler 抛出它时，server 把它翻译成带 code/data 的 wire error response。
// 与未捕获异常（→ -32603 Internal error）区分：这是“业务可表达的错误”。
export class RpcApplicationError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: JsonValue,
  ) {
    super(message);
    this.name = 'RpcApplicationError';
    // 构造时校验：错误码必须是安全整数（JSON-RPC 约定）；message 不能为空。
    if (!Number.isSafeInteger(code)) {
      throw new RangeError('RpcApplicationError.code 必须是安全整数');
    }
    if (message.length === 0) throw new RangeError('RpcApplicationError.message 不能为空');
  }
}

export class JsonRpcServer<
  const Methods extends RpcSchemaConstraint<Methods>,
> {
  // #inFlight：id → InFlight。handler 执行期间在此表，cancel 通知据此找到 controller。
  readonly #inFlight = new Map<RequestId, InFlight>();
  // #recentIds / #recentOrder：已结束请求的 id 去重表 + FIFO 队列。
  // 防止同一 connection 里 id 被复用导致 response 关联混乱。
  readonly #recentIds = new Set<RequestId>();
  readonly #recentOrder: RequestId[] = [];
  // 两个 unsubscribe：构造时订阅 transport，close 时撤销。
  readonly #unsubscribeMessage: Unsubscribe;
  readonly #unsubscribeClose: Unsubscribe;
  #closed = false;

  constructor(
    readonly transport: RpcTransport,
    readonly methods: Methods,
    readonly handlers: RpcHandlers<Methods>,
    readonly options: {
      readonly maxInFlight?: number;
      readonly maxRecentIds?: number;
      readonly onNotification?: (
        method: string,
        params: JsonObject | readonly JsonValue[] | undefined,
      ) => void | Promise<void>;
      readonly onNotificationError?: (cause: unknown, method: string) => void;
    } = {},
  ) {
    const maxInFlight = options.maxInFlight ?? 128;
    const maxRecentIds = options.maxRecentIds ?? 256;
    positiveInteger(maxInFlight, 'maxInFlight');
    positiveInteger(maxRecentIds, 'maxRecentIds');
    // recentIds 必须严格大于 inFlight：否则淘汰策略会让仍在执行的 id 被过早移出去重表。
    if (maxRecentIds <= maxInFlight) {
      throw new RangeError('maxRecentIds 必须大于 maxInFlight');
    }
    // onMessage 的回调是 async，外层用 void + catch 兜底，把异常送到 #failTransport。
    this.#unsubscribeMessage = transport.onMessage((raw) => {
      void this.#onMessage(raw).catch((cause: unknown) => this.#failTransport(cause));
    });
    this.#unsubscribeClose = transport.onClose(() => this.#finishClose());
  }

  // inFlightCount：当前正在执行的 handler 数。MCP 测试用它确认取消后是否真的清空。
  get inFlightCount(): number {
    return this.#inFlight.size;
  }

  get closed(): boolean {
    return this.#closed;
  }

  // close：主动关闭。先标记终态（abort 全部在途 handler），再关 transport。
  async close(reason: unknown = new Error('server 主动关闭')): Promise<void> {
    if (this.#closed) return;
    this.#finishClose(reason);
    await this.transport.close(reason);
  }

  // #onMessage：消息总入口。decode → 分发到 notification / request 两条路径。
  async #onMessage(raw: unknown): Promise<void> {
    if (this.#closed) return;
    const decoded = decodeJsonRpcMessage(raw);
    if (!decoded.ok) {
      // decode 失败：用 null id 回 Invalid Request（无法关联到具体 request id）。
      await this.#sendError(null, -32600, 'Invalid Request', {
        issues: decoded.issues.map((item) => ({
          pointer: item.pointer,
          message: item.message,
        })),
      });
      return;
    }
    const message = decoded.value;
    if (isNotification(message)) {
      await this.#handleNotification(message.method, message.params);
      return;
    }
    if (!isRequest(message)) {
      // 半双工 server 不接受 response——这是协议错误，直接抛让外层 failTransport。
      throw new Error('单向 JsonRpcServer 不接受远端 response');
    }
    await this.#handleRequest(message);
  }

  // #handleNotification：notification 分发。
  // notifications/cancelled 是协议内置的，由 server 自己消费；其余交给应用层回调。
  async #handleNotification(
    method: string,
    params: JsonObject | readonly JsonValue[] | undefined,
  ): Promise<void> {
    if (method === 'notifications/cancelled') {
      // MCP 要求未知、已完成或畸形 cancellation 被忽略，不能升级成协议错误。
      if (
        params !== undefined
        && isJsonObject(params)
        && Object.hasOwn(params, 'requestId')
      ) {
        const requestId = params['requestId'];
        if (typeof requestId === 'string' || typeof requestId === 'number') {
          this.#inFlight.get(requestId)?.controller.abort(params['reason']);
        }
      }
      return;
    }

    // 应用层 notification：try/catch 兜底，因为 notification 没有 response 通道。
    try {
      await this.options.onNotification?.(method, params);
    } catch (cause: unknown) {
      // Notification 按定义没有 response；错误只能进入本地观测通道。
      this.options.onNotificationError?.(cause, method);
    }
  }

  // #handleRequest：request 分发主流程。
  async #handleRequest(request: JsonRpcRequest): Promise<void> {
    // 同一 connection 内 id 重复（在途或最近完成过）→ 直接抛错，由外层 failTransport 关闭连接。
    if (this.#inFlight.has(request.id) || this.#recentIds.has(request.id)) {
      throw new Error(`request id ${String(request.id)} 在同一 connection 中重复`);
    }
    this.#remember(request.id);
    // 容量保护：在途 handler 达到上限就回 Server busy，避免被 DoS。
    if (this.#inFlight.size >= (this.options.maxInFlight ?? 128)) {
      await this.#sendError(request.id, -32000, 'Server busy');
      return;
    }

    // 查 codec 与 handler：类型擦除后做存在性检查。
    const methodName = request.method as keyof Methods & string;
    const codec = this.methods[methodName] as AnyRpcMethodSchema | undefined;
    const handler = this.handlers[methodName] as ErasedHandler | undefined;
    if (codec === undefined || handler === undefined) {
      await this.#sendError(request.id, -32601, 'Method not found');
      return;
    }

    // decodeParams：用 method 的 params schema 校验入参。
    let params: unknown;
    try {
      params = decodeParams(codec.params, request.params);
    } catch (cause: unknown) {
      // 参数不合法：回 -32602 Invalid params，并带上结构化 issues。
      if (cause instanceof RpcPayloadValidationError) {
        await this.#sendError(request.id, -32602, 'Invalid params', {
          issues: cause.issues.map((item) => ({
            pointer: item.pointer,
            message: item.message,
          })),
        });
        return;
      }
      throw cause;
    }

    // 注册 inFlight：给这个请求挂一个 AbortController，cancel 通知会触发它。
    const controller = new AbortController();
    this.#inFlight.set(request.id, { method: request.method, controller });
    const context: RpcRequestContext = {
      requestId: request.id,
      method: request.method,
      signal: controller.signal,
    };
    try {
      const rawResult = await handler(params, context);
      // handler resolve 后如果 signal 已 abort，说明请求被取消——不要再发 response（client 已经放弃了）。
      if (controller.signal.aborted) return;
      // 出口编码：Schema 校验 + JSON 安全化。
      const result = encodeResult(codec.result, rawResult);
      await this.transport.send({ jsonrpc: '2.0', id: request.id, result });
    } catch (cause: unknown) {
      // handler 抛错时若已取消，同样不发 response。
      if (controller.signal.aborted) return;
      if (cause instanceof RpcApplicationError) {
        // 业务错误：透传 code/message/data 给 client。
        await this.#sendError(request.id, cause.code, cause.message, cause.data);
      } else {
        // cause/stack 只进入服务端日志；wire 端不暴露实现细节。
        await this.#sendError(request.id, -32603, 'Internal error');
      }
    } finally {
      // 不管成功失败，从在途表移除（cancel 路径下 finally 也会执行）。
      this.#inFlight.delete(request.id);
    }
  }

  // #sendError：构造并发送 error response。
  // data 再走一次 decodeJsonValue：error 路径必须保持可发送，无效 diagnostic data 直接丢弃而不是覆盖原错误。
  async #sendError(
    id: RequestId | null,
    code: number,
    message: string,
    data?: JsonValue,
  ): Promise<void> {
    let safeData: JsonValue | undefined;
    if (data !== undefined) {
      const decoded = decodeJsonValue(data);
      // error path 必须保持可发送；无效 diagnostic data 直接丢弃，不能覆盖原错误。
      if (decoded.ok) safeData = decoded.value;
    }
    const response: JsonRpcErrorResponse = {
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        ...(safeData === undefined ? {} : { data: safeData }),
      },
    };
    await this.transport.send(response);
  }

  // #remember：把 id 加入去重表，并按 FIFO 淘汰最老——但优先淘汰已不在 inFlight 的 id。
  // 这样在 inFlight 满时不会误删仍在执行的请求 id。
  #remember(id: RequestId): void {
    this.#recentIds.add(id);
    this.#recentOrder.push(id);
    const maximum = this.options.maxRecentIds ?? 256;
    while (this.#recentOrder.length > maximum) {
      const removableIndex = this.#recentOrder.findIndex(
        (candidate) => !this.#inFlight.has(candidate),
      );
      if (removableIndex < 0) break;
      const [oldest] = this.#recentOrder.splice(removableIndex, 1);
      if (oldest !== undefined) this.#recentIds.delete(oldest);
    }
  }

  // #failTransport：处理失败（onMessage 抛错等）→ 关闭连接。
  #failTransport(reason: unknown): void {
    this.#finishClose(reason);
    void this.transport.close(reason).catch(() => undefined);
  }

  // #finishClose：终态进入函数。幂等。
  // abort 所有在途 handler，让长任务能通过 signal.reason 感知到关闭。
  #finishClose(reason: unknown = new Error('transport closed')): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribeMessage();
    this.#unsubscribeClose();
    for (const item of this.#inFlight.values()) item.controller.abort(reason);
    this.#inFlight.clear();
  }
}

// positiveInteger：选项校验工具，与 client.ts 里同名函数语义一致。
function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} 必须是正安全整数`);
  }
}
