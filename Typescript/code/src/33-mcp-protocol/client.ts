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

type RequestOptions = {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** initialize 不能发送 MCP cancellation；Session 会把它设为 false。 */
  readonly sendCancellation?: boolean;
};

type Pending = {
  readonly method: string;
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (reason: unknown) => void;
  readonly cleanup: () => void;
};

type Tombstone = {
  readonly id: RequestId;
  readonly kind: 'cancelled' | 'settled';
};

export class RpcRemoteError extends Error {
  constructor(
    readonly method: string,
    readonly rpcError: JsonRpcError,
  ) {
    super(`${method} 远端失败 [${rpcError.code}]: ${rpcError.message}`);
    this.name = 'RpcRemoteError';
  }
}

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

export class RpcRequestTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`${method} 超过 ${timeoutMs}ms 未响应`);
    this.name = 'RpcRequestTimeoutError';
  }
}

export class RpcProtocolViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcProtocolViolationError';
  }
}

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
  readonly #pending = new Map<RequestId, Pending>();
  readonly #tombstones = new Map<RequestId, Tombstone['kind']>();
  readonly #tombstoneOrder: RequestId[] = [];
  readonly #unsubscribeMessage: Unsubscribe;
  readonly #unsubscribeClose: Unsubscribe;
  #nextId = 1;
  #closedReason: unknown;

  constructor(
    readonly transport: RpcTransport,
    readonly methods: Methods,
    readonly options: {
      readonly maxPending?: number;
      readonly maxTombstones?: number;
    } = {},
  ) {
    positiveInteger(options.maxPending ?? 128, 'maxPending');
    positiveInteger(options.maxTombstones ?? 256, 'maxTombstones');
    this.#unsubscribeMessage = transport.onMessage((raw) => this.#onMessage(raw));
    this.#unsubscribeClose = transport.onClose((reason) => this.#onClose(reason));
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  get closed(): boolean {
    return this.#closedReason !== undefined;
  }

  async request<Name extends keyof Methods & string>(
    method: Name,
    params: Infer<Methods[Name]['params']>,
    options: RequestOptions = {},
  ): Promise<Infer<Methods[Name]['result']>> {
    this.#ensureOpen();
    if (this.#pending.size >= (this.options.maxPending ?? 128)) {
      throw new RangeError('pending request 已达到上限');
    }
    if (options.signal?.aborted) {
      throw new RpcRequestCancelledError(method, 'not-sent', options.signal.reason);
    }
    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined) positiveInteger(timeoutMs, 'timeoutMs');

    const codec = this.methods[method];
    if (codec === undefined) throw new Error(`没有 method schema: ${method}`);
    const wireParams = encodeParams(codec.params, params);
    const id = this.#allocateId();

    let timer: ReturnType<typeof setTimeout> | undefined;
    let detachAbort: () => void = () => undefined;
    const rawResult = new Promise<JsonValue>((resolve, reject) => {
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        detachAbort();
      };
      this.#pending.set(id, { method, resolve, reject, cleanup });

      const cancel = (reason: unknown) => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        pending.cleanup();
        this.#remember(id, 'cancelled');
        pending.reject(new RpcRequestCancelledError(method, id, reason));
        if (options.sendCancellation !== false) {
          void this.notify('notifications/cancelled', {
            requestId: id,
            ...(typeof reason === 'string' ? { reason } : {}),
          }).catch(() => undefined);
        }
      };

      if (options.signal !== undefined) {
        const onAbort = () => cancel(options.signal?.reason);
        options.signal.addEventListener('abort', onAbort, { once: true });
        detachAbort = () => options.signal?.removeEventListener('abort', onAbort);
      }
      if (timeoutMs !== undefined) {
        timer = setTimeout(
          () => cancel(new RpcRequestTimeoutError(method, timeoutMs)),
          timeoutMs,
        );
      }
    });

    try {
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

    const result = await rawResult;
    const resultSchema = codec.result as Schema<Infer<Methods[Name]['result']>>;
    return decodeResult(resultSchema, result);
  }

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

  async close(reason: unknown = new Error('client 主动关闭')): Promise<void> {
    if (this.closed) return;
    this.#onClose(reason);
    await this.transport.close(reason);
  }

  #allocateId(): number {
    if (!Number.isSafeInteger(this.#nextId)) {
      throw new RangeError('JSON-RPC request id 已耗尽；必须建立新 connection');
    }
    const id = this.#nextId;
    this.#nextId += 1;
    return id;
  }

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
    if (!isResponse(decoded.value)) {
      this.#protocolFault(new RpcProtocolViolationError(
        '单向 JsonRpcClient 不接受远端 request/notification',
      ));
      return;
    }
    const response = decoded.value;
    if (response.id === null) {
      const message = 'error' in response
        ? response.error.message
        : 'success response 不允许 null id';
      this.#protocolFault(new RpcProtocolViolationError(
        `收到无法关联的 JSON-RPC response: ${message}`,
      ));
      return;
    }

    const tombstone = this.#tombstones.get(response.id);
    if (tombstone === 'cancelled') {
      // MCP 取消允许竞态：取消后的迟到 response 必须忽略。
      this.#tombstones.delete(response.id);
      return;
    }
    if (tombstone === 'settled') {
      this.#protocolFault(new RpcProtocolViolationError(
        `request ${String(response.id)} 收到重复 response`,
      ));
      return;
    }

    const pending = this.#pending.get(response.id);
    if (pending === undefined) {
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

  #remember(id: RequestId, kind: Tombstone['kind']): void {
    this.#tombstones.set(id, kind);
    this.#tombstoneOrder.push(id);
    const maximum = this.options.maxTombstones ?? 256;
    while (this.#tombstoneOrder.length > maximum) {
      const oldest = this.#tombstoneOrder.shift();
      if (oldest !== undefined) this.#tombstones.delete(oldest);
    }
  }

  #protocolFault(error: RpcProtocolViolationError): void {
    this.#onClose(error);
    void this.transport.close(error).catch(() => undefined);
  }

  #onClose(reason: unknown): void {
    if (this.closed) return;
    // undefined 也可能是合法关闭 reason；用 sentinel Error 保证 closed 判定稳定。
    this.#closedReason = reason ?? new RpcConnectionClosedError(reason);
    this.#unsubscribeMessage();
    this.#unsubscribeClose();
    const error = reason instanceof RpcConnectionClosedError
      ? reason
      : new RpcConnectionClosedError(reason);
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #ensureOpen(): void {
    if (this.closed) throw new RpcConnectionClosedError(this.#closedReason);
  }
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} 必须是正安全整数`);
  }
}
