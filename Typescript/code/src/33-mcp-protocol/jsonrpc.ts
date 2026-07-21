/**
 * 第 33 课：JSON-RPC 2.0 wire protocol。
 *
 * TypeScript union 只约束本编译图；transport 收到的值仍是 unknown。本文件先验证
 * JavaScript 对象图可无损表示为 JSON，再验证 JSON-RPC 的互斥字段与关联 ID。
 */

// ---------------------------------------------------------------------------
// JSON 值类型：描述“能被 JSON.stringify 无损往返”的数据形状。
// 这些类型同时作为 wire schema 的 TypeScript 镜像，被 client/server/codec 共享。
// ---------------------------------------------------------------------------

// JsonPrimitive：JSON 规范的四种标量。null 属于 primitive（JSON 没有 undefined）。
export type JsonPrimitive = string | number | boolean | null;
// JsonValue：递归定义“任意合法 JSON 值”。readonly 修饰提示协议层不应在原地改 wire 数据。
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
// JsonObject：专用于 params/result/error.data 等“必须是 object”的位置。
export type JsonObject = { readonly [key: string]: JsonValue };

/** MCP 的 RequestId 比通用 JSON-RPC 更严格：只使用 string | number，不使用 null。 */
export type RequestId = string | number;
// ResponseId 比 RequestId 多允许 null：JSON-RPC 允许在 request id 无法解析时用 null id 回 error。
export type ResponseId = RequestId | null;

// JsonRpcRequest：带 id 的双向请求——id 是 client/server 关联 response 的唯一钥匙。
// params 允许省略；允许 array 或 object 以兼容不同 JSON-RPC 库的约定。
export type JsonRpcRequest = {
  readonly jsonrpc: '2.0';
  readonly id: RequestId;
  readonly method: string;
  readonly params?: JsonObject | readonly JsonValue[];
};

// JsonRpcNotification：没有 id 的单向通知——对方不需要（也不应该）回 response。
export type JsonRpcNotification = {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: JsonObject | readonly JsonValue[];
};

// JsonRpcError：error 对象的内部结构。code 是机器可读整数（见 JSON-RPC 错误码约定）；data 是可选 diagnostic。
export type JsonRpcError = {
  readonly code: number;
  readonly message: string;
  readonly data?: JsonValue;
};

// JsonRpcSuccessResponse：成功 response——id 必须对齐某个 pending request，result 必填。
export type JsonRpcSuccessResponse = {
  readonly jsonrpc: '2.0';
  readonly id: RequestId;
  readonly result: JsonValue;
};

// JsonRpcErrorResponse：失败 response——id 允许 null（request id 无法解析时的兜底）。
export type JsonRpcErrorResponse = {
  readonly jsonrpc: '2.0';
  readonly id: ResponseId;
  readonly error: JsonRpcError;
};

// JsonRpcResponse：success | error 的互斥联合，由 'result'/'error' 字段是否存在来区分。
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
// JsonRpcMessage：wire 上所有合法消息的总联合 = request | notification | response。
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ProtocolIssue：协议层（区别于 17-schema 的 Schema 层）的解码错误描述。
// path 是位置数组（含数字下标），pointer 是 RFC 6901 风格的可读定位，便于日志与错误响应。
export type ProtocolIssue = {
  readonly path: readonly (string | number)[];
  readonly pointer: string;
  readonly message: string;
};

// DecodeResult：核心解码器的统一返回——成功带 value，失败带 issues 列表。
// 刻意不 throw：让调用方（client/server）自行决定是关闭连接还是回 error response。
export type DecodeResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly issues: readonly ProtocolIssue[] };

// ---------------------------------------------------------------------------
// 字段白名单：JSON-RPC 2.0 要求每种消息“只允许特定字段集合”。
// 用 Set 表示白名单，decode 时据此发现未知字段（防止字段注入与实现歧义）。
// ---------------------------------------------------------------------------
// request 允许的四个字段：jsonrpc/id/method/params。
const REQUEST_KEYS = new Set(['jsonrpc', 'id', 'method', 'params']);
// notification 比 request 少 id：有无 id 是 request/notification 的判别依据。
const NOTIFICATION_KEYS = new Set(['jsonrpc', 'method', 'params']);
// success response 的三个字段：jsonrpc/id/result。
const SUCCESS_KEYS = new Set(['jsonrpc', 'id', 'result']);
// error response 的三个字段：jsonrpc/id/error。
const ERROR_KEYS = new Set(['jsonrpc', 'id', 'error']);
// error 对象内部允许的三个字段：code/message/data。
const ERROR_OBJECT_KEYS = new Set(['code', 'message', 'data']);

// pointer：把 path 数组转成 RFC 6901 JSON Pointer 字符串（如 /params/0/left）。
// ~ 与 / 需要转义（~0、~1），否则 pointer 本身会被下游解析器误解。
function pointer(path: readonly (string | number)[]): string {
  if (path.length === 0) return '';
  return `/${path
    .map((segment) => String(segment).replaceAll('~', '~0').replaceAll('/', '~1'))
    .join('/')}`;
}

// issue：构造一条带 pointer 的 ProtocolIssue，简化各处错误创建。
function issue(
  path: readonly (string | number)[],
  message: string,
): ProtocolIssue {
  return { path, pointer: pointer(path), message };
}

// isPlainObject：只接受 plain object 或 null-prototype object。
// 拒绝 Date/Map/Class 实例等——这些在 JSON 里无法无损表示（会丢原型信息）。
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
  // active 跟踪当前递归路径上的对象，防止循环引用导致无限递归。
  // 用 WeakSet 而非路径数组：无需手动清理栈，且对 GC 友好。
  const active = new WeakSet<object>();

  // visit 是核心递归：逐值判定“是否能无损表示为 JSON”。
  // 失败时收集 issues 而非立刻短路，让调用方一次看到全部问题。
  function visit(
    value: unknown,
    path: readonly (string | number)[],
  ): DecodeResult<JsonValue> {
    // null / string / boolean：JSON 原生支持，直接通过。
    if (
      value === null
      || typeof value === 'string'
      || typeof value === 'boolean'
    ) {
      return { ok: true, value };
    }
    // number：JSON 允许任意 finite number；NaN/Infinity/-Infinity 必须拒绝（JSON.stringify 会把它们写成 null）。
    if (typeof value === 'number') {
      return Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, issues: [issue(path, 'JSON number 必须是有限数字')] };
    }
    // symbol / bigint / function / undefined：JSON 不支持，全部拒绝。
    if (typeof value !== 'object') {
      return {
        ok: false,
        issues: [issue(path, `JSON 不支持 ${typeof value}`)],
      };
    }
    // 循环引用检测：当前对象已在祖先路径上 → 必然无法序列化，拒绝。
    if (active.has(value)) {
      return { ok: false, issues: [issue(path, 'JSON 对象图不能包含循环引用')] };
    }
    active.add(value);

    try {
      if (Array.isArray(value)) {
        const output: JsonValue[] = [];
        const issues: ProtocolIssue[] = [];
        // 数组逐元素访问：用 descriptor 检测稀疏槽位（hole）与 accessor（getter/setter）。
        // 这两种情况 JSON.stringify 都会静默处理（hole→null、getter→执行结果），但对协议层不安全。
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (descriptor === undefined) {
            issues.push(issue([...path, index], 'JSON 数组不能包含稀疏槽位'));
            continue;
          }
          if (!('value' in descriptor)) {
            // accessor 在序列化时会执行 getter，等价于任意代码执行，必须拒绝。
            issues.push(issue([...path, index], 'JSON 数组元素不能是 accessor'));
            continue;
          }
          const decoded = visit(descriptor.value, [...path, index]);
          if (decoded.ok) output[index] = decoded.value;
          else issues.push(...decoded.issues);
        }

        // 再扫一遍 ownKeys：数组的非索引属性 / symbol 属性 JSON.stringify 会丢弃，但对协议层是隐藏信息。
        // length 是数组内置属性，跳过；canonical index 已在循环里处理，这里只查额外 key。
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

      // 对象必须先通过 plain object 判定。
      if (!isPlainObject(value)) {
        return {
          ok: false,
          issues: [issue(path, 'JSON object 必须是 plain/null-prototype object')],
        };
      }

      const output: Record<string, JsonValue> = {};
      const issues: ProtocolIssue[] = [];
      // Reflect.ownKeys 拿到 symbol key + string key 的完整集合（含 non-enumerable）。
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') {
          // symbol key 在 JSON 里无法表达。
          issues.push(issue([...path, String(key)], 'JSON object 不支持 symbol key'));
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        // wire object 不应包含隐藏属性（non-enumerable）——否则对端看到的字段会不一致。
        if (descriptor === undefined || !descriptor.enumerable) {
          issues.push(issue([...path, key], 'wire object 不能包含隐藏属性'));
          continue;
        }
        // accessor 会在序列化时执行 getter，等价于任意代码执行，必须拒绝。
        if (!('value' in descriptor)) {
          issues.push(issue([...path, key], 'wire object 不能包含 accessor'));
          continue;
        }
        const decoded = visit(descriptor.value, [...path, key]);
        if (!decoded.ok) {
          issues.push(...decoded.issues);
          continue;
        }
        // 用 defineProperty 显式声明 enumerable/writable，避免 output 继承奇怪原型。
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
      // 离开当前对象前从 active 移除：同一对象允许出现在不相交分支里（菱形引用不是循环）。
      active.delete(value);
    }
  }

  return visit(raw, []);
}

// isJsonObject：JsonValue 上的类型守卫——区分 object 与 array/primitive。
// 与 decodeJsonValue 配套：先确保 JSON 安全，再判断是否为对象。
export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// hasOwn：封装 Object.hasOwn，避免 obj.hasOwnProperty() 上的原型污染陷阱。
function hasOwn(object: JsonObject, key: string): boolean {
  return Object.hasOwn(object, key);
}

// unknownKeys：找出 object 中不在白名单 allowed 里的字段，转成 ProtocolIssue。
// 这实现了 JSON-RPC 对“未知字段”的严格拒绝，是字段互斥约束的核心。
function unknownKeys(
  object: JsonObject,
  allowed: ReadonlySet<string>,
): ProtocolIssue[] {
  return Object.keys(object)
    .filter((key) => !allowed.has(key))
    .map((key) => issue([key], `JSON-RPC 不允许未知字段 ${key}`));
}

// decodeRequestId：MCP 的 id 比 JSON-RPC 更严——只接受非空 string 或安全整数。
// 拒绝 null（即使是 request）、小数、空字符串，避免关联表 key 歧义。
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

// decodeParams：params 只能是 object 或 array（或省略）。
// 单独抽出是因为 request/notification 都用它。
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

// decodeError：验证 error 对象的内部结构——code/message 必填，data 可选。
// 同样用 ERROR_OBJECT_KEYS 白名单拒绝未知字段。
function decodeError(value: JsonValue | undefined): DecodeResult<JsonRpcError> {
  if (value === undefined || !isJsonObject(value)) {
    return { ok: false, issues: [issue(['error'], 'error 必须是 object')] };
  }
  // unknownKeys 返回的 path 相对 error 对象根，这里要补 'error' 前缀让定位准确。
  const issues: ProtocolIssue[] = unknownKeys(value, ERROR_OBJECT_KEYS)
    .map((item) => ({ ...item, path: ['error', ...item.path], pointer: pointer(['error', ...item.path]) }));
  const code = value['code'];
  const message = value['message'];
  const data = value['data'];
  // code 必须是安全整数（JSON-RPC 错误码约定）。
  if (typeof code !== 'number' || !Number.isSafeInteger(code)) {
    issues.push(issue(['error', 'code'], 'error.code 必须是安全整数'));
  }
  // message 必须是非空字符串（避免空错误描述）。
  if (typeof message !== 'string' || message.length === 0) {
    issues.push(issue(['error', 'message'], 'error.message 必须是非空 string'));
  }
  // 收集完全部 issue 再做最终判定：避免短路漏报其它问题。
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
      // data 只在显式存在且非 undefined 时透传——避免输出 { data: undefined }。
      ...(hasOwn(value, 'data') && data !== undefined ? { data } : {}),
    },
  };
}

/** 把 transport 的 unknown 值收敛成互斥的 request/notification/response 联合。 */
export function decodeJsonRpcMessage(raw: unknown): DecodeResult<JsonRpcMessage> {
  // 第一层：先确保整个对象图是 JSON 安全的（拒绝 NaN/getter/cycle/symbol 等）。
  const json = decodeJsonValue(raw);
  if (!json.ok) return json;
  // 第二层：顶层必须是 object（裸 number/string/array 都不是合法 JSON-RPC message）。
  if (!isJsonObject(json.value)) {
    return { ok: false, issues: [issue([], 'JSON-RPC message 必须是 object')] };
  }
  const object = json.value;
  // 第三层：jsonrpc 字段必须严格等于字面量 '2.0'（拒绝 '2'、'2.00' 等变体）。
  if (object['jsonrpc'] !== '2.0') {
    return {
      ok: false,
      issues: [issue(['jsonrpc'], "jsonrpc 必须严格等于 '2.0'")],
    };
  }

  // 第四层：按“有无 method”分两条主分支。method 在 → request 或 notification。
  if (hasOwn(object, 'method')) {
    // 有 id → request（REQUEST_KEYS）；无 id → notification（NOTIFICATION_KEYS）。
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

    // --- request 分支：必须有合法 id ---
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

    // --- notification 分支：无 id ---
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

  // 第五层：无 method → response。必须且只能包含 result 或 error 之一。
  const hasResult = hasOwn(object, 'result');
  const hasError = hasOwn(object, 'error');
  // 两者同时出现 / 同时缺失：违反 JSON-RPC 互斥约束。
  if (hasResult === hasError) {
    return {
      ok: false,
      issues: [issue([], 'response 必须且只能包含 result 或 error 之一')],
    };
  }
  // response 必须有 id 字段（即使值为 null 也算“有字段”）。
  if (!hasOwn(object, 'id')) {
    return { ok: false, issues: [issue(['id'], 'response 必须包含 id')] };
  }

  // --- success response 分支 ---
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
        // result 可以是任意 JsonValue（包括 null），这里只做类型断言。
        result: object['result'] as JsonValue,
      },
    };
  }

  // --- error response 分支 ---
  const issues = unknownKeys(object, ERROR_KEYS);
  const rawId = object['id'];
  // error response 允许 id 为 null（request id 无法解析时的兜底），单独处理。
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

// JsonTextParseError：JSON.parse 本身的语法错误（缺引号、尾逗号等）。
// 用 Error.cause 链接原始 SyntaxError，保留诊断细节。
export class JsonTextParseError extends Error {
  constructor(override readonly cause: unknown) {
    super('输入不是合法的单个 JSON 文本', { cause });
    this.name = 'JsonTextParseError';
  }
}

// JsonRpcDecodeError：JSON 语法合法但不符合 JSON-RPC wire schema。
// issues 里每条带 pointer，可直接进入错误响应或日志。
export class JsonRpcDecodeError extends Error {
  constructor(readonly issues: readonly ProtocolIssue[]) {
    super(issues.map((item) => `${item.pointer || '/'}: ${item.message}`).join('; '));
    this.name = 'JsonRpcDecodeError';
  }
}

// parseJsonRpcText：把单行文本解析成 JsonRpcMessage。
// 是本文件里唯一会 throw 的入口（把 DecodeResult 翻译成异常），供 stdio decoder 等流式场景使用。
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
  // 出口也走一遍 decode：防御性编程，确保自己构造的消息同样符合 wire schema。
  // 如果 message 是 TypeScript 类型“撒谎”的产物，这里会立刻发现。
  const decoded = decodeJsonRpcMessage(message);
  if (!decoded.ok) throw new JsonRpcDecodeError(decoded.issues);
  return `${JSON.stringify(decoded.value)}\n`;
}

// 下面三个类型守卫配合 client/server 做消息分发：
// isRequest —— 有 method + 有 id。
export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'method' in message && 'id' in message;
}

// isNotification —— 有 method + 无 id。
export function isNotification(
  message: JsonRpcMessage,
): message is JsonRpcNotification {
  return 'method' in message && !('id' in message);
}

// isResponse —— 无 method。success/error 的进一步区分留给消费方按需做。
export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return !('method' in message);
}
