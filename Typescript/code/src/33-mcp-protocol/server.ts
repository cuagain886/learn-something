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

export type RpcRequestContext = {
  readonly requestId: RequestId;
  readonly method: string;
  readonly signal: AbortSignal;
};

export type RpcHandlers<Methods extends RpcSchemaConstraint<Methods>> = {
  readonly [Name in keyof Methods]: (
    params: Infer<Methods[Name]['params']>,
    context: RpcRequestContext,
  ) => Infer<Methods[Name]['result']> | Promise<Infer<Methods[Name]['result']>>;
};

type ErasedHandler = (
  params: unknown,
  context: RpcRequestContext,
) => unknown | Promise<unknown>;

type InFlight = {
  readonly method: string;
  readonly controller: AbortController;
};

export class RpcApplicationError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: JsonValue,
  ) {
    super(message);
    this.name = 'RpcApplicationError';
    if (!Number.isSafeInteger(code)) {
      throw new RangeError('RpcApplicationError.code 必须是安全整数');
    }
    if (message.length === 0) throw new RangeError('RpcApplicationError.message 不能为空');
  }
}

export class JsonRpcServer<
  const Methods extends RpcSchemaConstraint<Methods>,
> {
  readonly #inFlight = new Map<RequestId, InFlight>();
  readonly #recentIds = new Set<RequestId>();
  readonly #recentOrder: RequestId[] = [];
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
    if (maxRecentIds <= maxInFlight) {
      throw new RangeError('maxRecentIds 必须大于 maxInFlight');
    }
    this.#unsubscribeMessage = transport.onMessage((raw) => {
      void this.#onMessage(raw).catch((cause: unknown) => this.#failTransport(cause));
    });
    this.#unsubscribeClose = transport.onClose(() => this.#finishClose());
  }

  get inFlightCount(): number {
    return this.#inFlight.size;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async close(reason: unknown = new Error('server 主动关闭')): Promise<void> {
    if (this.#closed) return;
    this.#finishClose(reason);
    await this.transport.close(reason);
  }

  async #onMessage(raw: unknown): Promise<void> {
    if (this.#closed) return;
    const decoded = decodeJsonRpcMessage(raw);
    if (!decoded.ok) {
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
      throw new Error('单向 JsonRpcServer 不接受远端 response');
    }
    await this.#handleRequest(message);
  }

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

    try {
      await this.options.onNotification?.(method, params);
    } catch (cause: unknown) {
      // Notification 按定义没有 response；错误只能进入本地观测通道。
      this.options.onNotificationError?.(cause, method);
    }
  }

  async #handleRequest(request: JsonRpcRequest): Promise<void> {
    if (this.#inFlight.has(request.id) || this.#recentIds.has(request.id)) {
      throw new Error(`request id ${String(request.id)} 在同一 connection 中重复`);
    }
    this.#remember(request.id);
    if (this.#inFlight.size >= (this.options.maxInFlight ?? 128)) {
      await this.#sendError(request.id, -32000, 'Server busy');
      return;
    }

    const methodName = request.method as keyof Methods & string;
    const codec = this.methods[methodName] as AnyRpcMethodSchema | undefined;
    const handler = this.handlers[methodName] as ErasedHandler | undefined;
    if (codec === undefined || handler === undefined) {
      await this.#sendError(request.id, -32601, 'Method not found');
      return;
    }

    let params: unknown;
    try {
      params = decodeParams(codec.params, request.params);
    } catch (cause: unknown) {
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

    const controller = new AbortController();
    this.#inFlight.set(request.id, { method: request.method, controller });
    const context: RpcRequestContext = {
      requestId: request.id,
      method: request.method,
      signal: controller.signal,
    };
    try {
      const rawResult = await handler(params, context);
      if (controller.signal.aborted) return;
      const result = encodeResult(codec.result, rawResult);
      await this.transport.send({ jsonrpc: '2.0', id: request.id, result });
    } catch (cause: unknown) {
      if (controller.signal.aborted) return;
      if (cause instanceof RpcApplicationError) {
        await this.#sendError(request.id, cause.code, cause.message, cause.data);
      } else {
        // cause/stack 只进入服务端日志；wire 端不暴露实现细节。
        await this.#sendError(request.id, -32603, 'Internal error');
      }
    } finally {
      this.#inFlight.delete(request.id);
    }
  }

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

  #failTransport(reason: unknown): void {
    this.#finishClose(reason);
    void this.transport.close(reason).catch(() => undefined);
  }

  #finishClose(reason: unknown = new Error('transport closed')): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribeMessage();
    this.#unsubscribeClose();
    for (const item of this.#inFlight.values()) item.controller.abort(reason);
    this.#inFlight.clear();
  }
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} 必须是正安全整数`);
  }
}
