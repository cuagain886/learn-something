/**
 * Agent Runtime 的领域协议。
 *
 * 这里刻意只放“数据类型”，不放执行逻辑。这样模型适配器、Runner、工具系统和
 * 测试可以共同依赖稳定协议，而不会形成循环依赖。
 */
import type { JsonSchema, ValidationIssue } from '../17-schema.js';

/** JSON 能无损表达的值。工具输出被限制为这个集合，避免函数、BigInt、循环引用等。 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type TokenUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
};

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
};

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const inputTokens = left.inputTokens + right.inputTokens;
  const outputTokens = left.outputTokens + right.outputTokens;
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
export type ToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
};

/**
 * 对话消息使用判别字段，而不是 role + 大量可选属性。
 * 每个分支只能携带该消息形态真正合法的数据。
 */
export type ConversationMessage =
  | {
      readonly role: 'user';
      readonly content: string;
    }
  | {
      readonly role: 'assistant';
      readonly kind: 'text';
      readonly content: string;
    }
  | {
      readonly role: 'assistant';
      readonly kind: 'tool_calls';
      readonly calls: readonly ToolCall[];
    }
  | {
      readonly role: 'tool';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly content: string;
      readonly isError: boolean;
    };

/** 一次模型调用只能选择直接回答，或请求一组工具；非法组合无法表示。 */
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

export type ToolDescriptor = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly requiredPermission?: string;
};

export type ToolFailure =
  | {
      readonly code: 'UNKNOWN_TOOL';
      readonly toolName: string;
    }
  | {
      readonly code: 'INVALID_ARGUMENTS';
      readonly issues: readonly ValidationIssue[];
    }
  | {
      readonly code: 'FORBIDDEN';
      readonly toolName: string;
      readonly requiredPermission: string;
    }
  | {
      readonly code: 'INVALID_OUTPUT';
      readonly issues: readonly ValidationIssue[];
    }
  | {
      readonly code: 'CANCELLED';
      readonly reason: unknown;
    }
  | {
      readonly code: 'EXECUTION_FAILED';
      readonly cause: unknown;
    };

export type ToolExecutionResult<Output extends JsonValue = JsonValue> =
  | { readonly ok: true; readonly value: Output }
  | { readonly ok: false; readonly error: ToolFailure };

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
export type AgentEvent =
  | {
      readonly type: 'run_started';
      readonly seq: number;
      readonly runId: string;
      readonly input: string;
      readonly at: number;
    }
  | {
      readonly type: 'model_started';
      readonly seq: number;
      readonly runId: string;
      readonly step: number;
      readonly at: number;
    }
  | {
      readonly type: 'model_completed';
      readonly seq: number;
      readonly runId: string;
      readonly step: number;
      readonly turn: ModelTurn;
      readonly at: number;
    }
  | {
      readonly type: 'tool_started';
      readonly seq: number;
      readonly runId: string;
      readonly step: number;
      readonly call: ToolCall;
      readonly at: number;
    }
  | {
      readonly type: 'tool_completed';
      readonly seq: number;
      readonly runId: string;
      readonly step: number;
      readonly call: ToolCall;
      readonly result: ToolExecutionResult;
      readonly at: number;
    }
  | {
      readonly type: 'run_finished';
      readonly seq: number;
      readonly runId: string;
      readonly outcome: AgentOutcome;
      readonly at: number;
    };
