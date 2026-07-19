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

export type AnyRpcMethodSchema = RpcMethodSchema<unknown, unknown>;
export type RpcSchemaConstraint<Methods> = {
  readonly [Name in keyof Methods]: AnyRpcMethodSchema;
};

export type ParamsOf<Method extends AnyRpcMethodSchema> = Infer<Method['params']>;
export type ResultOf<Method extends AnyRpcMethodSchema> = Infer<Method['result']>;

export type PayloadIssue = ValidationIssue | ProtocolIssue;

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

export function decodeParams<Params>(
  schema: Schema<Params>,
  params: JsonObject | readonly JsonValue[] | undefined,
): Params {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.ok) throw new RpcPayloadValidationError('params', parsed.error);
  return parsed.value;
}

export function decodeResult<Result>(
  schema: Schema<Result>,
  result: JsonValue,
): Result {
  const parsed = schema.safeParse(result);
  if (!parsed.ok) throw new RpcPayloadValidationError('result', parsed.error);
  return parsed.value;
}
