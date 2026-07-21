/**
 * Agent Runtime 的领域协议。
 *
 * 这里刻意只放“数据类型”，不放执行逻辑。这样模型适配器、Runner、工具系统和
 * 测试可以共同依赖稳定协议，而不会形成循环依赖。
 */
// ---------------------------------------------------------------------------
// 领域层：仅描述“数据形状”，不引用 model/tool/runner 的任何实现
// ---------------------------------------------------------------------------
// 与其它文件的协作关系：
//   - model.ts：把不可信 unknown 升级成本文件定义的 ModelTurn；
//   - tool.ts：定义工具并产出 ToolExecutionResult/ToolFailure；
//   - runner.ts：编排消息（ConversationMessage）、累加用量（TokenUsage）、
//     投影终态（AgentOutcome）和事件（AgentEvent）；
//   - 测试/type-contracts 通过断言锁定这些类型在边界处的形状。
//
// 全部字段都用 readonly：领域对象一旦构造就不可变，避免 Runner/工具/适配器
// 任何一方偷偷篡改消息体导致难以追踪的并发 bug。
import type { JsonSchema, ValidationIssue } from '../17-schema.js';

/** JSON 能无损表达的值。工具输出被限制为这个集合，避免函数、BigInt、循环引用等。 */
// JsonPrimitive：JSON 规范能表达的“标量”集合——字符串、数字、布尔、null。
// 注意：number 还需配合运行时 Number.isFinite 才能真正落入 JSON（见 tool.ts 的 validateJsonValue）。
export type JsonPrimitive = string | number | boolean | null;
// JsonValue：用递归类型定义“任意 JSON 值”。
//   - 要么是标量；
//   - 要么是 string -> JsonValue 的只读记录（对象）；
//   - 要么是只读的 JsonValue 数组。
// readonly 修饰让协议所有层级都不可变，避免 Runner/工具误改消息体。
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

// TokenUsage：单次模型调用的 token 用量。整条 Run 会逐 turn 累加（见 addUsage）。
// inputTokens 对应 prompt 用量，outputTokens 对应生成用量；计费/限流都依赖这两个字段。
export type TokenUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
};

// ZERO_USAGE：累加用的单位元，保证 Run 启动时初始 usage 为零且不可变。
// 选用常量对象而非工厂函数，因为只读字段不会在运行时被修改。
export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
};

/**
 * addUsage：把两次 token 用量相加，并在加完后做“非负安全整数”防御。
 *
 * 设计动机：
 *   - 模型适配器返回的 usage 来自不可信边界，可能为 NaN/Infinity/负数；
 *   - 把校验下沉到唯一的累加点，Runner 就无需在每一处都重复防御。
 *
 * 抛错策略：失败抛 RangeError，由 Runner 的 try/catch 转成 'failed' outcome，
 * 避免把一个非法 usage 沉默地累计下去，最终污染计费/限流决策。
 */
export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  // 分项相加，便于后续在错误信息或日志里指出“哪一项爆掉”。
  const inputTokens = left.inputTokens + right.inputTokens;
  const outputTokens = left.outputTokens + right.outputTokens;
  // Number.isSafeInteger 同时排除 NaN、Infinity 和超过 2^53 的不精确值；
  // 加上 >= 0 才能保证 token 数是合法计数。
  // 这里的检查与 model.ts 的 usageSchema 互补：schema 在 parse 阶段拦非法值，
  // 这里则兜底覆盖所有“非模型层来源”的累加（例如手工测试构造的 usage）。
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0
  ) {
    throw new RangeError('TokenUsage 累加结果必须是非负安全整数');
  }
  return {
    inputTokens,
    outputTokens,
  };
}

/** 模型产生的原始工具调用。arguments 仍然不可信，因此必须是 unknown。 */
// ToolCall：模型请求一次工具调用的最小信息。
//   - id：模型分配的调用 id，用于把后续 tool message 关联回这条请求；Run 内必须唯一；
//   - name：目标工具名，是否注册需由 ToolRegistry 在运行时确认（不能相信类型层结论）；
//   - arguments：unknown 是刻意的——必须经工具的 inputSchema.safeParse 才能升级为具体 Input。
//
// 跨文件链路：ModelAdapter(unknown) -> parseModelTurn -> ModelTurn.calls: ToolCall[]
//            -> ToolRegistry.invokeDynamic -> tool.inputSchema.safeParse -> Input。
export type ToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
};

/**
 * 对话消息使用判别字段，而不是 role + 大量可选属性。
 * 每个分支只能携带该消息形态真正合法的数据。
 */
// ConversationMessage：贯穿整条 Run 的对话历史类型，是一个“判别 union”。
// 刻意不用 `{ role, content?, calls?, ... }` 的扁平可选结构：
//   - 那会让“user 消息带 calls”这种非法组合在类型层就能表达；
//   - 用 role + kind 作为判别字段，把“什么角色能带什么载荷”编码进类型，让非法状态无法表示。
// Runner 的 messages: ConversationMessage[] 就是这个 union 的有序集合，作为 prompt 的来源。
export type ConversationMessage =
  | {
      readonly role: 'user';
      readonly content: string;
    }
  | {
      // assistant 的“纯文本回答”：kind='text' 与 tool_calls 互斥，类型上二选一。
      // 这条分支对应 ModelTurn.kind === 'final' 被记入历史后的形态。
      readonly role: 'assistant';
      readonly kind: 'text';
      readonly content: string;
    }
  | {
      // assistant 的“工具调用请求”：calls 至少 1 个；空 calls 由 model.ts 的 schema 拒绝。
      // 这条分支对应 ModelTurn.kind === 'tool_calls' 被记入历史后的形态。
      readonly role: 'assistant';
      readonly kind: 'tool_calls';
      readonly calls: readonly ToolCall[];
    }
  | {
      // tool 消息：把工具执行结果回填给模型。isError 让模型显式区分成功/失败，便于它改写策略。
      // content 已序列化为字符串（见 runner.ts serializeToolResult），保持与底层 SDK 兼容。
      readonly role: 'tool';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly content: string;
      readonly isError: boolean;
    };

/** 一次模型调用只能选择直接回答，或请求一组工具；非法组合无法表示。 */
// ModelTurn：normalized 后的模型回合，也是 Runner 唯一信任的模型输出形态。
// 与 ConversationMessage 一样，用 kind 做判别，避免“既 final 又 tool_calls”的非法态。
// usage 强制每 turn 都带用量——Runner 不需要也不能从外部默认值兜底。
//
// 与 ConversationMessage 的关系：ModelTurn 是“模型刚刚产生的新回合”，
// Runner 在执行完毕后把它“投影”成对应的消息塞进 messages（见 runner.ts #execute）。
export type ModelTurn =
  | {
      readonly kind: 'final';
      readonly text: string;
      readonly usage: TokenUsage;
    }
  | {
      readonly kind: 'tool_calls';
      readonly calls: readonly ToolCall[];
      readonly usage: TokenUsage;
    };

// ToolDescriptor：暴露给模型的工具元信息（schema 子集），用于提示词/JSON Schema 协议层。
// inputSchema 是 JsonSchema（协议层），与 tool.ts 里的运行时 Schema<Input> 是“同一约束的两个投影”。
// requiredPermission 可选；不填表示“无需特殊授权”，由 Runner 在 ToolContext 里授予。
//
// 跨文件链路：ToolRegistry.descriptors() 返回 ToolDescriptor[]，
// Runner 把它放进 ModelRequest.tools，让 ModelAdapter 据此生成 function schema。
export type ToolDescriptor = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly requiredPermission?: string;
};

/**
 * ToolFailure：工具执行失败的“结构化错误”。
 *
 * 用 code 做判别字段，而不是抛 Error：
 *   - 工具失败是预期的业务结果（不是 bug），让 Runner/模型能基于 code 做策略选择；
 *   - 每个分支只带与该失败相关的字段，避免 UNKNOWN_TOOL 也被迫带一个空的 issues。
 *
 * 字段刻意不包含原始 cause/stack：序列化回填给模型时由 runner.serializeToolResult 脱敏。
 */
// 这些 code 与 tool.ts 里 defineTool 的返回路径一一对应：
//   - UNKNOWN_TOOL/INVALID_ARGUMENTS：由 ToolRegistry.invokeDynamic / invokeRaw 产生；
//   - FORBIDDEN：由 checkAccess 在权限校验失败时产生；
//   - INVALID_OUTPUT：由 validateJsonValue 在工具输出非法 JSON 时产生；
//   - CANCELLED：由 AbortSignal 触发或 execute 抛出取消类异常时产生；
//   - EXECUTION_FAILED：兜底所有未分类异常，cause 在日志保留但不会暴露给模型。
export type ToolFailure =
  | {
      // UNKNOWN_TOOL：模型调用了未注册的工具名——可能由模型幻觉或注册表裁剪引起。
      readonly code: 'UNKNOWN_TOOL';
      readonly toolName: string;
    }
  | {
      // INVALID_ARGUMENTS：参数 parse 失败，issues 里带 JSON Pointer 指向具体字段。
      // 字段级 issue 会回填给模型，让它有机会修正参数后重试。
      readonly code: 'INVALID_ARGUMENTS';
      readonly issues: readonly ValidationIssue[];
    }
  | {
      // FORBIDDEN：缺少 requiredPermission；只回 toolName + 权限名，不回字段级 issue（防探测）。
      readonly code: 'FORBIDDEN';
      readonly toolName: string;
      readonly requiredPermission: string;
    }
  | {
      // INVALID_OUTPUT：工具自己返回了静态类型通过、运行时不合法的值（NaN/循环/getter）。
      // 由 tool.ts 的 validateJsonValue 兜底，证明“静态 JsonValue 不等于运行时 JSON”。
      readonly code: 'INVALID_OUTPUT';
      readonly issues: readonly ValidationIssue[];
    }
  | {
      // CANCELLED：AbortSignal 触发，reason 透传信号原因（可能是用户字符串或 Error）。
      readonly code: 'CANCELLED';
      readonly reason: unknown;
    }
  | {
      // EXECUTION_FAILED：execute 抛出非取消类异常；cause 在日志保留，序列化时不暴露给模型。
      readonly code: 'EXECUTION_FAILED';
      readonly cause: unknown;
    };

/**
 * ToolExecutionResult：工具调用的统一返回。
 *
 * ok=true 携带 value（JsonValue 子类型），ok=false 携带结构化 ToolFailure。
 * 强制 readonly 字段让下游必须走分支，避免“忘记处理失败”。
 */
// Output 默认 JsonValue：动态调用（invokeDynamic）拿不到精确 Output，退化为 JsonValue；
// 类型化的 invokeKnown 会通过 ToolRegistry 推断出每个工具的具体 Output。
//
// 这是 Result 模式而非 throw：调用方必须 if (result.ok) 分支才能取 value，
// 类型系统强制处理失败路径，避免静默错误。
export type ToolExecutionResult<Output extends JsonValue = JsonValue> =
  | { readonly ok: true; readonly value: Output }
  | { readonly ok: false; readonly error: ToolFailure };

/**
 * AgentOutcome：一次 Run 的终态，由 Runner 在结束时投影给调用方。
 *
 * 与 AgentEvent 不同：Outcome 是“控制流返回值”，调用方通常 await run.result 拿到它；
 * 事件则是“观察流”，可以独立地被收集/持久化。
 *
 * 四种终态都带 runId/steps/usage，便于无论成败都能记账/做上限判定：
 *   - completed：模型给出 final，附带最终文本；
 *   - max_steps：达到 maxSteps 上限，模型始终在请求工具；
 *   - cancelled：外部取消（AbortSignal），reason 透传取消原因；
 *   - failed：运行时异常（协议错误、调度异常等），cause 保留原始错误。
 */
// 状态映射：runner.ts #execute 的 try/catch 是终态分发器——
//   正常 return -> completed / max_steps；
//   catch + signal.aborted -> cancelled；
//   catch 其它 -> failed。
// 同一个 outcome 会被同时塞进 run_finished 事件和 run.result 的 resolve，保证两个通道一致。
export type AgentOutcome =
  | {
      readonly status: 'completed';
      readonly runId: string;
      readonly text: string;
      readonly steps: number;
      readonly usage: TokenUsage;
    }
  | {
      readonly status: 'max_steps';
      readonly runId: string;
      readonly steps: number;
      readonly usage: TokenUsage;
    }
  | {
      readonly status: 'cancelled';
      readonly runId: string;
      readonly steps: number;
      readonly usage: TokenUsage;
      readonly reason: unknown;
    }
  | {
      readonly status: 'failed';
      readonly runId: string;
      readonly steps: number;
      readonly usage: TokenUsage;
      readonly cause: unknown;
    };

/**
 * 事件是对运行状态机的只读投影。调用者观察事件，不能直接修改 Runner 内部状态。
 * 序号 seq 由 Runner 单调递增，可用于测试顺序和持久化去重。
 */
// AgentEvent：状态机生命周期里的 6 种事件。每条事件都带 seq + runId + at。
//   - seq：单 Run 内严格自增，前端/测试可据此排序、检测丢失；
//   - at：来自注入的 Clock（测试用递增 clock，生产用 Date.now），便于断言而不依赖墙钟；
//   - turn/call/result 直接引用领域对象，让订阅者拿到完整上下文。
//
// 与 Outcome 的关系：最后一条 run_finished 的 outcome 字段就是 run.result 解析出的 Outcome，
// 因此“只看事件流”也能完整重建终态——这对持久化/重放很关键。
//
// 发射源全部在 runner.ts：每个状态转换点（run 开始/每轮模型/每个工具/结束）
// 都会 events.push(...)；AsyncQueue 把这些事件按顺序交给消费者。
export type AgentEvent =
  | {
      // run_started：Run 进入执行体，input 是用户原始输入，便于审计/回放。
      readonly type: 'run_started';
      readonly seq: number;
      readonly runId: string;
      readonly input: string;
      readonly at: number;
    }
  | {
      // model_started：每轮模型调用前发出，step 是 1-based 的轮次号。
      // 即使模型随后协议错被拒绝，这条事件也保留，便于诊断“到底调了第几轮才出错”。
      readonly type: 'model_started';
      readonly seq: number;
      readonly runId: string;
      readonly step: number;
      readonly at: number;
    }
  | {
      // model_completed：模型回合被 normalized 成功，turn 是已通过协议校验的 ModelTurn。
      // 注意：失败的 parse 不会触发 model_completed，而是直接进入 catch -> run_finished。
      readonly type: 'model_completed';
      readonly seq: number;
      readonly runId: string;
      readonly step: number;
      readonly turn: ModelTurn;
      readonly at: number;
    }
  | {
      // tool_started：单个工具调用开始（在 worker pool 内发出），call 是触发它的 ToolCall。
      // 多个 tool_started 可能交错，但每条的 seq 仍单调递增，可作为时间线锚点。
      readonly type: 'tool_started';
      readonly seq: number;
      readonly runId: string;
      readonly step: number;
      readonly call: ToolCall;
      readonly at: number;
    }
  | {
      // tool_completed：单个工具调用结束，result 是结构化的成功/失败包装。
      // 注意：事件按真实发生顺序发出，消息则按模型原调用顺序回填（见 runner.ts）。
      readonly type: 'tool_completed';
      readonly seq: number;
      readonly runId: string;
      readonly step: number;
      readonly call: ToolCall;
      readonly result: ToolExecutionResult;
      readonly at: number;
    }
  | {
      // run_finished：终态事件。outcome 与 run.result 解析值一致，事件流到此关闭。
      // AsyncQueue 在这之后会被 close()，迭代器对消费者返回 { done: true }。
      readonly type: 'run_finished';
      readonly seq: number;
      readonly runId: string;
      readonly outcome: AgentOutcome;
      readonly at: number;
    };
