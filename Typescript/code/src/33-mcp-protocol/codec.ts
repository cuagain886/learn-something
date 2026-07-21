// codec.ts：Schema <-> wire JSON 的桥接层。
//
// 分层定位：
//   - 17-schema 提供带类型推导的 Schema<T>（safeParse + Infer）；
//   - jsonrpc.ts 提供 JsonValue 的纯结构验证（decodeJsonValue）；
//   - 本文件把两者组合：发送前用 Schema 校验领域对象 + decodeJsonValue 兜底确保 JSON 安全；
//     接收后用 Schema 校验 wire 值，得到类型化的领域对象。
//   - client.ts 在 request 出口调 encodeParams、入口调 decodeResult；server.ts 反过来。
import type { Infer, Schema, ValidationIssue } from '../17-schema.js';
import {
  decodeJsonValue,
  type JsonObject,
  type JsonValue,
  type ProtocolIssue,
} from './jsonrpc.js';

/**
 * RPC method 的 params/result 都是 wire schema。
 *
 * 这里刻意不接受 transform schema：同一个 schema 同时用于发送前验证和接收后解析，
 * 必须是幂等的 JSON 表示。Date/值对象等领域类型应使用显式 encode/decode codec。
 */
export interface RpcMethodSchema<Params, Result> {
  readonly params: Schema<Params>;
  readonly result: Schema<Result>;
}

// AnyRpcMethodSchema：方法 schema 的擦除版本（params/result 都未知）。
// 用于把整个 method table 当作“同构集合”遍历（例如 server 端按名查 codec）。
export type AnyRpcMethodSchema = RpcMethodSchema<unknown, unknown>;
// RpcSchemaConstraint：约束一个 method table 的形状——每个 name 都对应一个 AnyRpcMethodSchema。
// client/server 的 `<const Methods>` 用它做上界，既允许字面量推断又保证结构合法。
export type RpcSchemaConstraint<Methods> = {
  readonly [Name in keyof Methods]: AnyRpcMethodSchema;
};

// ParamsOf / ResultOf：从一个具体 method schema 类型提取 params/result 的领域类型。
// 是 client.request 类型签名能把 method name 映射到对应参数/返回值的工具。
export type ParamsOf<Method extends AnyRpcMethodSchema> = Infer<Method['params']>;
export type ResultOf<Method extends AnyRpcMethodSchema> = Infer<Method['result']>;

// PayloadIssue：统一 Schema 层（ValidationIssue）与协议层（ProtocolIssue）两种错误。
// encode/decode 时任一层失败都汇总成 PayloadIssue 列表。
export type PayloadIssue = ValidationIssue | ProtocolIssue;

// RpcPayloadValidationError：encode/decode 失败时抛出的错误。
// 携带 side（params 还是 result）与 issues 列表，让上层能转成结构化错误响应。
export class RpcPayloadValidationError extends Error {
  constructor(
    readonly side: 'params' | 'result',
    readonly issues: readonly PayloadIssue[],
  ) {
    super(
      `${side} 不符合 wire schema：${issues
        .map((item) => `${item.pointer || '/'} ${item.message}`)
        .join('; ')}`,
    );
    this.name = 'RpcPayloadValidationError';
  }
}

// encodeParams：发送前把领域 params 编码成 wire JSON。
// 两层校验：(1) Schema.safeParse 确保结构符合预期；(2) decodeJsonValue 确保结果可无损 JSON 化。
// 额外约束：JSON-RPC params 必须是 object 或 array（裸标量不允许）。
export function encodeParams<Params>(
  schema: Schema<Params>,
  params: Params,
): JsonObject | readonly JsonValue[] {
  const parsed = schema.safeParse(params);
  if (!parsed.ok) throw new RpcPayloadValidationError('params', parsed.error);
  const json = decodeJsonValue(parsed.value);
  if (!json.ok) throw new RpcPayloadValidationError('params', json.issues);
  if (
    typeof json.value !== 'object'
    || json.value === null
  ) {
    throw new RpcPayloadValidationError('params', [{
      path: [],
      pointer: '',
      message: 'JSON-RPC params 必须是 object 或 array',
    }]);
  }
  return json.value;
}

// encodeResult：发送前把领域 result 编码成 wire JSON。
// 与 encodeParams 的区别：result 允许任意 JsonValue（不限于 object/array）。
export function encodeResult<Result>(
  schema: Schema<Result>,
  result: Result,
): JsonValue {
  const parsed = schema.safeParse(result);
  if (!parsed.ok) throw new RpcPayloadValidationError('result', parsed.error);
  const json = decodeJsonValue(parsed.value);
  if (!json.ok) throw new RpcPayloadValidationError('result', json.issues);
  return json.value;
}

// decodeParams：接收后把 wire params 解析成领域对象。
// params 缺省时按空对象 {} 处理——让无参 method 的 handler 不必特判 undefined。
export function decodeParams<Params>(
  schema: Schema<Params>,
  params: JsonObject | readonly JsonValue[] | undefined,
): Params {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.ok) throw new RpcPayloadValidationError('params', parsed.error);
  return parsed.value;
}

// decodeResult：接收后把 wire result 解析成领域对象。
// client 在 request resolve 前用它做最后一道校验——静态类型不能替代 wire 证据。
export function decodeResult<Result>(
  schema: Schema<Result>,
  result: JsonValue,
): Result {
  const parsed = schema.safeParse(result);
  if (!parsed.ok) throw new RpcPayloadValidationError('result', parsed.error);
  return parsed.value;
}
