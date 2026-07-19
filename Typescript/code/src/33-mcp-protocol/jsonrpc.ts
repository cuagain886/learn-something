/**
 * 第 33 课：JSON-RPC 2.0 wire protocol。
 *
 * TypeScript union 只约束本编译图；transport 收到的值仍是 unknown。本文件先验证
 * JavaScript 对象图可无损表示为 JSON，再验证 JSON-RPC 的互斥字段与关联 ID。
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

/** MCP 的 RequestId 比通用 JSON-RPC 更严格：只使用 string | number，不使用 null。 */
export type RequestId = string | number;
export type ResponseId = RequestId | null;

export type JsonRpcRequest = {
  readonly jsonrpc: '2.0';
  readonly id: RequestId;
  readonly method: string;
  readonly params?: JsonObject | readonly JsonValue[];
};

export type JsonRpcNotification = {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: JsonObject | readonly JsonValue[];
};

export type JsonRpcError = {
  readonly code: number;
  readonly message: string;
  readonly data?: JsonValue;
};

export type JsonRpcSuccessResponse = {
  readonly jsonrpc: '2.0';
  readonly id: RequestId;
  readonly result: JsonValue;
};

export type JsonRpcErrorResponse = {
  readonly jsonrpc: '2.0';
  readonly id: ResponseId;
  readonly error: JsonRpcError;
};

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export type ProtocolIssue = {
  readonly path: readonly (string | number)[];
  readonly pointer: string;
  readonly message: string;
};

export type DecodeResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly issues: readonly ProtocolIssue[] };

const REQUEST_KEYS = new Set(['jsonrpc', 'id', 'method', 'params']);
const NOTIFICATION_KEYS = new Set(['jsonrpc', 'method', 'params']);
const SUCCESS_KEYS = new Set(['jsonrpc', 'id', 'result']);
const ERROR_KEYS = new Set(['jsonrpc', 'id', 'error']);
const ERROR_OBJECT_KEYS = new Set(['code', 'message', 'data']);

function pointer(path: readonly (string | number)[]): string {
  if (path.length === 0) return '';
  return `/${path
    .map((segment) => String(segment).replaceAll('~', '~0').replaceAll('/', '~1'))
    .join('/')}`;
}

function issue(
  path: readonly (string | number)[],
  message: string,
): ProtocolIssue {
  return { path, pointer: pointer(path), message };
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 验证并复制任意 JSON 值。
 *
 * JSON.stringify 会静默改写 NaN/Infinity、忽略 symbol/undefined/function，并执行 getter；
 * 所以不能把“JSON.stringify 没抛异常”等同于协议安全。
 */
export function decodeJsonValue(raw: unknown): DecodeResult<JsonValue> {
  const active = new WeakSet<object>();

  function visit(
    value: unknown,
    path: readonly (string | number)[],
  ): DecodeResult<JsonValue> {
    if (
      value === null
      || typeof value === 'string'
      || typeof value === 'boolean'
    ) {
      return { ok: true, value };
    }
    if (typeof value === 'number') {
      return Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, issues: [issue(path, 'JSON number 必须是有限数字')] };
    }
    if (typeof value !== 'object') {
      return {
        ok: false,
        issues: [issue(path, `JSON 不支持 ${typeof value}`)],
      };
    }
    if (active.has(value)) {
      return { ok: false, issues: [issue(path, 'JSON 对象图不能包含循环引用')] };
    }
    active.add(value);

    try {
      if (Array.isArray(value)) {
        const output: JsonValue[] = [];
        const issues: ProtocolIssue[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (descriptor === undefined) {
            issues.push(issue([...path, index], 'JSON 数组不能包含稀疏槽位'));
            continue;
          }
          if (!('value' in descriptor)) {
            issues.push(issue([...path, index], 'JSON 数组元素不能是 accessor'));
            continue;
          }
          const decoded = visit(descriptor.value, [...path, index]);
          if (decoded.ok) output[index] = decoded.value;
          else issues.push(...decoded.issues);
        }

        for (const key of Reflect.ownKeys(value)) {
          if (key === 'length') continue;
          const isCanonicalIndex = typeof key === 'string'
            && /^(0|[1-9]\d*)$/u.test(key)
            && Number(key) < value.length;
          if (!isCanonicalIndex) {
            issues.push(issue(
              [...path, String(key)],
              'JSON 数组不能包含 symbol 或额外属性',
            ));
          }
        }
        return issues.length === 0
          ? { ok: true, value: output }
          : { ok: false, issues };
      }

      if (!isPlainObject(value)) {
        return {
          ok: false,
          issues: [issue(path, 'JSON object 必须是 plain/null-prototype object')],
        };
      }

      const output: Record<string, JsonValue> = {};
      const issues: ProtocolIssue[] = [];
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') {
          issues.push(issue([...path, String(key)], 'JSON object 不支持 symbol key'));
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !descriptor.enumerable) {
          issues.push(issue([...path, key], 'wire object 不能包含隐藏属性'));
          continue;
        }
        if (!('value' in descriptor)) {
          issues.push(issue([...path, key], 'wire object 不能包含 accessor'));
          continue;
        }
        const decoded = visit(descriptor.value, [...path, key]);
        if (!decoded.ok) {
          issues.push(...decoded.issues);
          continue;
        }
        Object.defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: decoded.value,
        });
      }
      return issues.length === 0
        ? { ok: true, value: output }
        : { ok: false, issues };
    } finally {
      active.delete(value);
    }
  }

  return visit(raw, []);
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(object: JsonObject, key: string): boolean {
  return Object.hasOwn(object, key);
}

function unknownKeys(
  object: JsonObject,
  allowed: ReadonlySet<string>,
): ProtocolIssue[] {
  return Object.keys(object)
    .filter((key) => !allowed.has(key))
    .map((key) => issue([key], `JSON-RPC 不允许未知字段 ${key}`));
}

function decodeRequestId(
  value: JsonValue | undefined,
  path: readonly (string | number)[],
): DecodeResult<RequestId> {
  if (typeof value === 'string' && value.length > 0) {
    return { ok: true, value };
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return { ok: true, value };
  }
  return {
    ok: false,
    issues: [issue(path, 'MCP request id 必须是非空 string 或安全整数')],
  };
}

function decodeParams(
  value: JsonValue | undefined,
): DecodeResult<JsonObject | readonly JsonValue[] | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (Array.isArray(value) || isJsonObject(value)) {
    return { ok: true, value };
  }
  return {
    ok: false,
    issues: [issue(['params'], 'JSON-RPC params 只能是 object 或 array')],
  };
}

function decodeError(value: JsonValue | undefined): DecodeResult<JsonRpcError> {
  if (value === undefined || !isJsonObject(value)) {
    return { ok: false, issues: [issue(['error'], 'error 必须是 object')] };
  }
  const issues: ProtocolIssue[] = unknownKeys(value, ERROR_OBJECT_KEYS)
    .map((item) => ({ ...item, path: ['error', ...item.path], pointer: pointer(['error', ...item.path]) }));
  const code = value['code'];
  const message = value['message'];
  const data = value['data'];
  if (typeof code !== 'number' || !Number.isSafeInteger(code)) {
    issues.push(issue(['error', 'code'], 'error.code 必须是安全整数'));
  }
  if (typeof message !== 'string' || message.length === 0) {
    issues.push(issue(['error', 'message'], 'error.message 必须是非空 string'));
  }
  if (
    issues.length > 0
    || typeof code !== 'number'
    || typeof message !== 'string'
  ) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      code,
      message,
      ...(hasOwn(value, 'data') && data !== undefined ? { data } : {}),
    },
  };
}

/** 把 transport 的 unknown 值收敛成互斥的 request/notification/response 联合。 */
export function decodeJsonRpcMessage(raw: unknown): DecodeResult<JsonRpcMessage> {
  const json = decodeJsonValue(raw);
  if (!json.ok) return json;
  if (!isJsonObject(json.value)) {
    return { ok: false, issues: [issue([], 'JSON-RPC message 必须是 object')] };
  }
  const object = json.value;
  if (object['jsonrpc'] !== '2.0') {
    return {
      ok: false,
      issues: [issue(['jsonrpc'], "jsonrpc 必须严格等于 '2.0'")],
    };
  }

  if (hasOwn(object, 'method')) {
    const issues = unknownKeys(
      object,
      hasOwn(object, 'id') ? REQUEST_KEYS : NOTIFICATION_KEYS,
    );
    const method = object['method'];
    if (typeof method !== 'string' || method.length === 0) {
      issues.push(issue(['method'], 'method 必须是非空 string'));
    }
    const params = decodeParams(object['params']);
    if (!params.ok) issues.push(...params.issues);

    if (hasOwn(object, 'id')) {
      const id = decodeRequestId(object['id'], ['id']);
      if (!id.ok) issues.push(...id.issues);
    if (
      issues.length > 0
      || !id.ok
      || !params.ok
      || typeof method !== 'string'
    ) {
        return { ok: false, issues };
      }
      return {
        ok: true,
        value: {
          jsonrpc: '2.0',
          id: id.value,
          method,
          ...(params.value === undefined ? {} : { params: params.value }),
        },
      };
    }

    if (issues.length > 0 || !params.ok || typeof method !== 'string') {
      return { ok: false, issues };
    }
    return {
      ok: true,
      value: {
        jsonrpc: '2.0',
        method,
        ...(params.value === undefined ? {} : { params: params.value }),
      },
    };
  }

  const hasResult = hasOwn(object, 'result');
  const hasError = hasOwn(object, 'error');
  if (hasResult === hasError) {
    return {
      ok: false,
      issues: [issue([], 'response 必须且只能包含 result 或 error 之一')],
    };
  }
  if (!hasOwn(object, 'id')) {
    return { ok: false, issues: [issue(['id'], 'response 必须包含 id')] };
  }

  if (hasResult) {
    const issues = unknownKeys(object, SUCCESS_KEYS);
    const id = decodeRequestId(object['id'], ['id']);
    if (!id.ok) issues.push(...id.issues);
    if (issues.length > 0 || !id.ok) return { ok: false, issues };
    return {
      ok: true,
      value: {
        jsonrpc: '2.0',
        id: id.value,
        result: object['result'] as JsonValue,
      },
    };
  }

  const issues = unknownKeys(object, ERROR_KEYS);
  const rawId = object['id'];
  const id = rawId === null
    ? ({ ok: true, value: null } as const)
    : decodeRequestId(rawId, ['id']);
  const error = decodeError(object['error']);
  if (!id.ok) issues.push(...id.issues);
  if (!error.ok) issues.push(...error.issues);
  if (issues.length > 0 || !id.ok || !error.ok) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: { jsonrpc: '2.0', id: id.value, error: error.value },
  };
}

export class JsonTextParseError extends Error {
  constructor(override readonly cause: unknown) {
    super('输入不是合法的单个 JSON 文本', { cause });
    this.name = 'JsonTextParseError';
  }
}

export class JsonRpcDecodeError extends Error {
  constructor(readonly issues: readonly ProtocolIssue[]) {
    super(issues.map((item) => `${item.pointer || '/'}: ${item.message}`).join('; '));
    this.name = 'JsonRpcDecodeError';
  }
}

export function parseJsonRpcText(text: string): JsonRpcMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause: unknown) {
    throw new JsonTextParseError(cause);
  }
  const decoded = decodeJsonRpcMessage(raw);
  if (!decoded.ok) throw new JsonRpcDecodeError(decoded.issues);
  return decoded.value;
}

/** JSON.stringify 会转义字符串内换行，因此最终只有 delimiter 是真实 LF。 */
export function encodeJsonRpcLine(message: JsonRpcMessage): string {
  const decoded = decodeJsonRpcMessage(message);
  if (!decoded.ok) throw new JsonRpcDecodeError(decoded.issues);
  return `${JSON.stringify(decoded.value)}\n`;
}

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'method' in message && 'id' in message;
}

export function isNotification(
  message: JsonRpcMessage,
): message is JsonRpcNotification {
  return 'method' in message && !('id' in message);
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return !('method' in message);
}
