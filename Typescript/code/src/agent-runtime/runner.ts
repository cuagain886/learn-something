import { AsyncQueue } from './async-queue.js';
import {
  ZERO_USAGE,
  addUsage,
  type AgentEvent,
  type AgentOutcome,
  type ConversationMessage,
  type ToolCall,
  type ToolExecutionResult,
  type TokenUsage,
} from './domain.js';
import { parseModelTurn, type ModelAdapter } from './model.js';
import { ToolRegistry, type AnyTool, type ToolContext } from './tool.js';

export interface Clock {
  now(): number;
}

export type RunOptions = {
  readonly maxSteps?: number;
  readonly maxToolCallsPerTurn?: number;
  readonly maxToolConcurrency?: number;
  readonly grantedPermissions?: ReadonlySet<string>;
  readonly signal?: AbortSignal;
};

export type AgentRun = {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  readonly result: Promise<AgentOutcome>;
  readonly cancel: (reason?: unknown) => void;
};

type RunnerDependencies<Tools extends readonly AnyTool[]> = {
  readonly model: ModelAdapter;
  readonly tools: ToolRegistry<Tools>;
  readonly clock?: Clock;
  readonly createRunId?: () => string;
};

type CompletedCall = {
  readonly call: ToolCall;
  readonly result: ToolExecutionResult;
};

const systemClock: Clock = { now: () => Date.now() };
let fallbackRunSequence = 0;

function fallbackRunId(): string {
  fallbackRunSequence += 1;
  return `run_${fallbackRunSequence}`;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} 必须是正安全整数`);
  }
  return value;
}

export class ToolCallLimitError extends Error {
  constructor(
    readonly step: number,
    readonly actual: number,
    readonly limit: number,
  ) {
    super(`第 ${step} 轮请求了 ${actual} 个工具，超过上限 ${limit}`);
    this.name = 'ToolCallLimitError';
  }
}

export class DuplicateToolCallIdError extends Error {
  constructor(readonly callId: string, readonly step: number) {
    super(`模型在第 ${step} 轮重复使用 tool call id: ${callId}`);
    this.name = 'DuplicateToolCallIdError';
  }
}

/**
 * 一个最小但边界完整的 Agent Runner。
 *
 * 它只编排端口：验证模型协议、推进消息、限制工具并发、传播取消并投影事件。
 * 模型 SDK 与业务工具都位于不可信边界外，不能把静态类型当作运行时证据。
 */
export class AgentRunner<const Tools extends readonly AnyTool[]> {
  readonly #model: ModelAdapter;
  readonly #tools: ToolRegistry<Tools>;
  readonly #clock: Clock;
  readonly #createRunId: () => string;

  constructor(dependencies: RunnerDependencies<Tools>) {
    this.#model = dependencies.model;
    this.#tools = dependencies.tools;
    this.#clock = dependencies.clock ?? systemClock;
    this.#createRunId = dependencies.createRunId ?? fallbackRunId;
  }

  start(input: string, options: RunOptions = {}): AgentRun {
    const maxSteps = positiveInteger(options.maxSteps ?? 8, 'maxSteps');
    const maxToolCallsPerTurn = positiveInteger(
      options.maxToolCallsPerTurn ?? 16,
      'maxToolCallsPerTurn',
    );
    const maxToolConcurrency = positiveInteger(
      options.maxToolConcurrency ?? 4,
      'maxToolConcurrency',
    );
    const grantedPermissions = new Set(options.grantedPermissions ?? []);
    for (const permission of grantedPermissions) {
      if (permission.trim() === '') {
        throw new RangeError('grantedPermissions 不能包含空字符串');
      }
    }

    const runId = this.#createRunId();
    const controller = new AbortController();
    const queue = new AsyncQueue<AgentEvent>();

    const parentSignal = options.signal;
    const forwardParentAbort = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) forwardParentAbort();
    else parentSignal?.addEventListener('abort', forwardParentAbort, { once: true });

    const result = this.#execute({
      runId,
      input,
      maxSteps,
      maxToolCallsPerTurn,
      maxToolConcurrency,
      grantedPermissions,
      signal: controller.signal,
      events: queue,
    }).finally(() => {
      parentSignal?.removeEventListener('abort', forwardParentAbort);
    });

    return {
      runId,
      events: queue,
      result,
      cancel: (reason?: unknown) => controller.abort(reason),
    };
  }

  async #execute(configuration: {
    readonly runId: string;
    readonly input: string;
    readonly maxSteps: number;
    readonly maxToolCallsPerTurn: number;
    readonly maxToolConcurrency: number;
    readonly grantedPermissions: ReadonlySet<string>;
    readonly signal: AbortSignal;
    readonly events: AsyncQueue<AgentEvent>;
  }): Promise<AgentOutcome> {
    const {
      runId,
      input,
      maxSteps,
      maxToolCallsPerTurn,
      maxToolConcurrency,
      grantedPermissions,
      signal,
      events,
    } = configuration;
    const messages: ConversationMessage[] = [{ role: 'user', content: input }];
    const seenCallIds = new Set<string>();
    let usage: TokenUsage = ZERO_USAGE;
    let currentStep = 0;
    let sequence = 0;
    const nextSequence = () => {
      sequence += 1;
      return sequence;
    };

    events.push({
      type: 'run_started',
      seq: nextSequence(),
      runId,
      input,
      at: this.#clock.now(),
    });

    try {
      for (let step = 1; step <= maxSteps; step += 1) {
        currentStep = step;
        signal.throwIfAborted();

        events.push({
          type: 'model_started',
          seq: nextSequence(),
          runId,
          step,
          at: this.#clock.now(),
        });

        const rawTurn = await this.#model.complete(
          {
            runId,
            step,
            messages: structuredClone(messages),
            tools: this.#tools.descriptors(),
          },
          signal,
        );
        const turn = parseModelTurn(rawTurn);
        usage = addUsage(usage, turn.usage);

        events.push({
          type: 'model_completed',
          seq: nextSequence(),
          runId,
          step,
          turn,
          at: this.#clock.now(),
        });

        if (turn.kind === 'final') {
          messages.push({ role: 'assistant', kind: 'text', content: turn.text });
          const outcome: AgentOutcome = {
            status: 'completed',
            runId,
            text: turn.text,
            steps: step,
            usage,
          };
          this.#finish(events, nextSequence(), outcome);
          return outcome;
        }

        if (turn.calls.length > maxToolCallsPerTurn) {
          throw new ToolCallLimitError(step, turn.calls.length, maxToolCallsPerTurn);
        }
        for (const call of turn.calls) {
          if (seenCallIds.has(call.id)) {
            throw new DuplicateToolCallIdError(call.id, step);
          }
        }
        for (const call of turn.calls) seenCallIds.add(call.id);

        messages.push({ role: 'assistant', kind: 'tool_calls', calls: turn.calls });
        const completedCalls = await this.#executeToolCalls({
          calls: turn.calls,
          concurrency: maxToolConcurrency,
          context: { runId, step, grantedPermissions, signal },
          events,
          nextSequence,
        });

        signal.throwIfAborted();

        // 事件按真实发生顺序发出；消息按模型原调用顺序回填，保证 prompt 可复现。
        for (const { call, result } of completedCalls) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: serializeToolResult(result),
            isError: !result.ok,
          });
        }
      }

      const outcome: AgentOutcome = {
        status: 'max_steps',
        runId,
        steps: maxSteps,
        usage,
      };
      this.#finish(events, nextSequence(), outcome);
      return outcome;
    } catch (cause: unknown) {
      const outcome: AgentOutcome = signal.aborted
        ? {
            status: 'cancelled',
            runId,
            steps: currentStep,
            usage,
            reason: signal.reason,
          }
        : {
            status: 'failed',
            runId,
            steps: currentStep,
            usage,
            cause,
          };

      this.#finish(events, nextSequence(), outcome);
      return outcome;
    } finally {
      events.close();
    }
  }

  async #executeToolCalls(configuration: {
    readonly calls: readonly ToolCall[];
    readonly concurrency: number;
    readonly context: Omit<ToolContext, 'callId'>;
    readonly events: AsyncQueue<AgentEvent>;
    readonly nextSequence: () => number;
  }): Promise<readonly CompletedCall[]> {
    const { calls, concurrency, context, events, nextSequence } = configuration;
    const childController = new AbortController();
    const forwardAbort = () => childController.abort(context.signal.reason);
    if (context.signal.aborted) forwardAbort();
    else context.signal.addEventListener('abort', forwardAbort, { once: true });

    const completed: (CompletedCall | undefined)[] = Array(calls.length);
    let nextIndex = 0;
    let firstFailure: { readonly cause: unknown } | undefined;

    const worker = async (): Promise<void> => {
      while (!childController.signal.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        const call = calls[index];
        if (call === undefined) return;

        events.push({
          type: 'tool_started',
          seq: nextSequence(),
          runId: context.runId,
          step: context.step,
          call,
          at: this.#clock.now(),
        });

        try {
          const result = await this.#tools.invokeDynamic(call.name, call.arguments, {
            ...context,
            callId: call.id,
            signal: childController.signal,
          });
          completed[index] = { call, result };
          events.push({
            type: 'tool_completed',
            seq: nextSequence(),
            runId: context.runId,
            step: context.step,
            call,
            result,
            at: this.#clock.now(),
          });
        } catch (cause: unknown) {
          if (firstFailure === undefined) {
            firstFailure = { cause };
            childController.abort(cause);
          }
          return;
        }
      }
    };

    try {
      const workerCount = Math.min(concurrency, calls.length);
      await Promise.all(Array.from({ length: workerCount }, worker));
      context.signal.throwIfAborted();
      if (firstFailure !== undefined) throw firstFailure.cause;

      // 没有失败/取消时，每个槽位都必须由唯一 worker 填充；这里检查状态机不变量。
      return completed.map((item, index) => {
        if (item === undefined) {
          throw new Error(`工具调度器未产生第 ${index} 个结果`);
        }
        return item;
      });
    } finally {
      context.signal.removeEventListener('abort', forwardAbort);
    }
  }

  #finish(events: AsyncQueue<AgentEvent>, seq: number, outcome: AgentOutcome): void {
    events.push({
      type: 'run_finished',
      seq,
      runId: outcome.runId,
      outcome,
      at: this.#clock.now(),
    });
  }
}

function assertNever(value: never): never {
  throw new Error(`未处理的工具失败分支: ${String(value)}`);
}

/** 只向模型暴露稳定、脱敏、JSON 兼容的错误，不泄漏原始 cause/stack/权限名。 */
function serializeToolResult(result: ToolExecutionResult): string {
  if (result.ok) return JSON.stringify({ ok: true, value: result.value });

  let publicError: { readonly code: string; readonly [key: string]: unknown };
  switch (result.error.code) {
    case 'UNKNOWN_TOOL':
      publicError = { code: result.error.code, toolName: result.error.toolName };
      break;
    case 'INVALID_ARGUMENTS':
      publicError = { code: result.error.code, issues: result.error.issues };
      break;
    case 'FORBIDDEN':
    case 'INVALID_OUTPUT':
    case 'CANCELLED':
    case 'EXECUTION_FAILED':
      publicError = { code: result.error.code };
      break;
    default:
      return assertNever(result.error);
  }

  return JSON.stringify({ ok: false, error: publicError });
}
