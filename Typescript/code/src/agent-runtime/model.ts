import {
  array,
  literal,
  number,
  object,
  refine,
  type Schema,
  string,
  union,
  unknownValue,
  type ValidationIssue,
} from '../17-schema.js';
import type {
  ConversationMessage,
  ModelTurn,
  TokenUsage,
  ToolCall,
  ToolDescriptor,
} from './domain.js';

/** Runner 交给模型适配器的稳定请求协议。 */
export interface ModelRequest {
  readonly runId: string;
  readonly step: number;
  readonly messages: readonly ConversationMessage[];
  readonly tools: readonly ToolDescriptor[];
}

/**
 * 端口返回 unknown 是刻意的：真实 SDK response、流式组装器和自定义 adapter 都可能
 * 漂移。Runner 只信任通过下面 normalized ModelTurn Schema 的数据。
 */
export interface ModelAdapter {
  complete(request: ModelRequest, signal: AbortSignal): Promise<unknown>;
}

const usageSchema: Schema<TokenUsage> = object({
  inputTokens: number({
    integer: true,
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  }),
  outputTokens: number({
    integer: true,
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  }),
});

const toolCallSchema: Schema<ToolCall> = object({
  id: string({ minLength: 1, pattern: /\S/ }),
  name: string({ minLength: 1, pattern: /\S/ }),
  arguments: unknownValue(),
});

const finalTurnSchema: Schema<Extract<ModelTurn, { readonly kind: 'final' }>> =
  object({
    kind: literal('final'),
    text: string({ minLength: 1 }),
    usage: usageSchema,
  });

const toolCallsTurnSchema: Schema<
  Extract<ModelTurn, { readonly kind: 'tool_calls' }>
> = refine(
  object({
    kind: literal('tool_calls'),
    calls: array(toolCallSchema, { minItems: 1 }),
    usage: usageSchema,
  }),
  (turn) => new Set(turn.calls.map((call) => call.id)).size === turn.calls.length,
  '同一模型 turn 中 tool call id 必须唯一',
);

const modelTurnSchema: Schema<ModelTurn> = union(
  finalTurnSchema,
  toolCallsTurnSchema,
);

export class ModelProtocolError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super(
      `模型返回不符合 normalized ModelTurn 协议：${issues
        .map((issue) => `${issue.pointer || '/'} ${issue.message}`)
        .join('; ')}`,
    );
    this.name = 'ModelProtocolError';
  }
}

export function parseModelTurn(raw: unknown): ModelTurn {
  const parsed = modelTurnSchema.safeParse(raw);
  if (parsed.ok) return parsed.value;
  throw new ModelProtocolError(parsed.error);
}
