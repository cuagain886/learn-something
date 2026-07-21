// model.ts：定义 Runner 与“模型适配器”之间的端口协议。
//
// 与 domain.ts 的关系：
//   - domain.ts 描述“数据形状”（消息、回合、用量）；
//   - 这里描述“调用形状”：调用方传什么（ModelRequest）、被调用方返回什么（unknown）。
// 关键设计：端口返回 unknown 而不是 ModelTurn。任何 SDK 都可能漂移，
// 必须经 parseModelTurn 这一关运行时校验，才能升级为受信任的 ModelTurn。
//
// 本文件分三层：
//   1) 端口协议（ModelRequest / ModelAdapter）：让 Runner 与具体 SDK 解耦；
//   2) Schema 构造（usage/toolCall/turn）：把 domain 里的“类型约束”镜像为“运行时校验”；
//   3) parseModelTurn + ModelProtocolError：唯一的“unknown -> ModelTurn”升级入口。
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

// ---------------------------------------------------------------------------
// 1) 端口协议：Runner 给适配器什么、适配器要返回什么
// ---------------------------------------------------------------------------

/**
 * Runner 交给模型适配器的稳定请求协议。 */
// ModelRequest：每一次模型调用的入参快照。
//   - runId/step：让适配器可以按 run/step 写日志、做缓存、注入 trace；
//   - messages：完整对话历史（Runner 会做 structuredClone，避免适配器污染内部状态）；
//   - tools：当前注册表的 ToolDescriptor 列表，适配器据此生成提示词或 function schema。
//
// 字段都是 readonly：Runner 传出去的快照不允许被适配器改写，避免共享可变状态。
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
// ModelAdapter：依赖反转接口。Runner 依赖这个抽象，不依赖任何具体 SDK。
// 实现者负责：
//   - 把 ModelRequest 翻译成具体厂商的 prompt / function schema；
//   - 把响应原样回传（unknown），由 Runner 端的 parseModelTurn 统一收窄。
// signal 让模型调用能被外部取消；具体实现应在底层 API 上把它接好。
//
// 测试与演示：mock-model.ts 的 DeterministicModel 与 runner.test.ts 里的内联 model
// 都实现这个接口，验证 Runner 在不依赖真实网络/Key 时的协议行为。
export interface ModelAdapter {
  complete(request: ModelRequest, signal: AbortSignal): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// 2) 运行时 Schema：与 domain 类型“形影相随”的运行时校验
// ---------------------------------------------------------------------------
// 每个 Schema<X> 都在“保留 domain 类型”的同时提供 safeParse，把 unknown 收窄到 X。
// 这样协议错误能在状态机入口被发现，而不是污染后续业务逻辑。

// usageSchema：约束 ModelTurn.usage 的运行时 schema。
// 通过 number({integer, minimum:0, maximum: MAX_SAFE_INTEGER}) 复刻 addUsage 的“非负安全整数”约束，
// 让协议错误在 parse 阶段就被发现，而不是等到 addUsage 抛 RangeError。
// 这里与 domain.ts addUsage 的运行时检查形成“双层防御”：schema 拦模型层，addUsage 拦所有累加点。
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

// toolCallSchema：模型返回的 ToolCall 的运行时 schema。
//   - id/name： minLength=1 且 pattern /\S/ 拒绝纯空白字符串；
//   - arguments：unknownValue()，刻意保留 unknown——字段级校验由工具自己的 inputSchema 完成。
// 这样模型层只校验“是个 ToolCall 的形状”，不重复工具层的工作。
// 这是分层校验：本层只确认“形状”，example-tools.ts 的 schema 负责“字段语义”。
const toolCallSchema: Schema<ToolCall> = object({
  id: string({ minLength: 1, pattern: /\S/ }),
  name: string({ minLength: 1, pattern: /\S/ }),
  arguments: unknownValue(),
});

// finalTurnSchema：'final' 分支的 schema。text 必须非空——空 final 既无意义也可能是协议 bug。
// literal('final') 把 kind 锁死为字面量，匹配 ModelTurn 的判别字段。
const finalTurnSchema: Schema<Extract<ModelTurn, { readonly kind: 'final' }>> =
  object({
    kind: literal('final'),
    text: string({ minLength: 1 }),
    usage: usageSchema,
  });

// toolCallsTurnSchema：'tool_calls' 分支的 schema，比 final 多两道约束：
//   - calls 至少 1 项（minItems:1），避免模型回“空 tool_calls”导致 Runner 卡死；
//   - refine 自定义校验：所有 call.id 必须在本 turn 内唯一，防下游关联错乱。
// 与 runner.ts 的 DuplicateToolCallIdError 互补：这里拦“单 turn 内重复”，runner 拦“跨 turn 重复”。
const toolCallsTurnSchema: Schema<
  Extract<ModelTurn, { readonly kind: 'tool_calls' }>
> = refine(
  object({
    kind: literal('tool_calls'),
    calls: array(toolCallSchema, { minItems: 1 }),
    usage: usageSchema,
  }),
  // 用 Set 去重后比对长度；不一致说明有重复 id，refine 返回 false 触发 parse 失败。
  (turn) => new Set(turn.calls.map((call) => call.id)).size === turn.calls.length,
  '同一模型 turn 中 tool call id 必须唯一',
);

// modelTurnSchema：把两个分支 union 起来，正好覆盖 ModelTurn 的全部合法形态。
// 任何“既不是 final 也不是 tool_calls”、或“同时是两者”的输入都会被拒绝。
// union 内部会尝试每个分支并报告最贴近的失败原因，便于 ModelProtocolError 给出可读 issues。
const modelTurnSchema: Schema<ModelTurn> = union(
  finalTurnSchema,
  toolCallsTurnSchema,
);

// ---------------------------------------------------------------------------
// 3) 升级入口：unknown -> ModelTurn
// ---------------------------------------------------------------------------

/**
 * ModelProtocolError：parse 失败时抛出的专用错误。
 *
 * 携带 issues 数组（带 JSON Pointer）便于排查：
 *   - 测试用它区分“模型协议错” vs “其它运行时错”；
 *   - 错误信息只拼 pointer + message，不拼原始 raw，避免敏感数据落日志。
 */
// runner.ts 的 catch 会把 cause instanceof ModelProtocolError 的运行终态设为 'failed'。
// runner.test.ts 里“run_bad_protocol” 用例专门验证这条路径。
export class ModelProtocolError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super(
      `模型返回不符合 normalized ModelTurn 协议：${issues
        .map((issue) => `${issue.pointer || '/'} ${issue.message}`)
        .join('; ')}`,
    );
    // 自定义错误都需要设置 name，否则在 instanceof 检查和日志里都只会显示 "Error"。
    this.name = 'ModelProtocolError';
  }
}

/**
 * parseModelTurn：把 unknown 升级为受信任的 ModelTurn。
 *
 * 这是“不可信边界 -> 受信任领域”的唯一入口：
 *   - safeParse 不会抛，失败时返回结构化 issues；
 *   - 失败时包装成 ModelProtocolError，让 Runner 的 catch 能识别成 'failed' outcome。
 *
 * Runner 在拿到 rawTurn 后立刻调用它，确保后续逻辑只处理“已通过协议的”回合。
 */
// 严格两步：safeParse（不抛）+ 显式 throw（包装成 ModelProtocolError）。
// 这样调用方既能拿到结构化 issues，又能用 try/catch 写出统一的错误流。
export function parseModelTurn(raw: unknown): ModelTurn {
  const parsed = modelTurnSchema.safeParse(raw);
  // parsed.ok 为 true 时 value 已被 Schema 收窄为 ModelTurn，类型不再有 unknown。
  if (parsed.ok) return parsed.value;
  throw new ModelProtocolError(parsed.error);
}
