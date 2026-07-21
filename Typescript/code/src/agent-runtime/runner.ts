// runner.ts：Agent Runtime 的“主循环”——把模型、工具、消息、事件、取消串成一条 Run。
//
// 与其它文件的协作关系：
//   - 从 domain.ts 拿数据协议（消息、回合、事件、outcome、用量）；
//   - 从 model.ts 拿 ModelAdapter 端口 + parseModelTurn 协议闸门；
//   - 从 tool.ts 拿 ToolRegistry 的动态调用入口 + AnyTool 类型；
//   - 从 async-queue.ts 拿事件投递通道；
//   依赖全部注入，Runner 自己只做编排，没有具体 SDK/业务依赖。
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

/**
 * Clock：抽象时间源。
 *
 * 让 Runner 不直接依赖 Date.now，便于测试用“递增 clock”断言事件 at 字段，
 * 也便于生产环境接入单调时钟（避免墙钟回拨影响排序）。
 */
export interface Clock {
  now(): number;
}

/**
 * RunOptions：调用方在 start() 时可调整的运行参数。
 *
 *   - maxSteps：模型回合数硬上限，避免模型无限请求工具把 Run 拖死；
 *   - maxToolCallsPerTurn：单 turn 内工具调用数硬上限，防模型炸开 N 个并行调用；
 *   - maxToolConcurrency：worker pool 大小，控制实际在途的工具执行数；
 *   - grantedPermissions：本 Run 授权的工具权限集合（key 是 requiredPermission 字符串）；
 *   - signal：父级 AbortSignal，让外部取消能传播到 Run。
 */
export type RunOptions = {
  readonly maxSteps?: number;
  readonly maxToolCallsPerTurn?: number;
  readonly maxToolConcurrency?: number;
  readonly grantedPermissions?: ReadonlySet<string>;
  readonly signal?: AbortSignal;
};

/**
 * AgentRun：start() 返回给调用方的“Run 句柄”。
 *
 * 三条通道同时存在：
 *   - runId：用于日志/追踪；
 *   - events：观察流（AsyncIterable<AgentEvent>），可被 for-await 消费；
 *   - result：控制流（Promise<AgentOutcome>），await 拿到终态；
 *   - cancel：主动取消接口，等价于 abortController.abort(reason)。
 *
 * 事件流与 result 分开：UI/日志可以只订阅事件而不阻塞控制流，控制流也可以独立 await。
 */
export type AgentRun = {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  readonly result: Promise<AgentOutcome>;
  readonly cancel: (reason?: unknown) => void;
};

/**
 * RunnerDependencies：构造 Runner 需要的注入项。
 *
 * model + tools 是核心；clock/createRunId 可选（带兜底）。
 * 把它们以依赖反转形式传入，让 Runner 完全可测、可换实现。
 */
type RunnerDependencies<Tools extends readonly AnyTool[]> = {
  readonly model: ModelAdapter;
  readonly tools: ToolRegistry<Tools>;
  readonly clock?: Clock;
  readonly createRunId?: () => string;
};

/**
 * CompletedCall：worker pool 内部用来把“ToolCall 与它的执行结果”成对暂存。
 *
 * 调度时事件按真实发生顺序发出，但消息要按模型原调用顺序回填（见 runner 注释），
 * 所以这里同时保留 call（含原顺序的 index 信息）和 result。
 */
type CompletedCall = {
  readonly call: ToolCall;
  readonly result: ToolExecutionResult;
};

// 系统级默认：使用 Date.now 的 Clock，避免每个测试都注入 clock。
const systemClock: Clock = { now: () => Date.now() };
// fallbackRunSequence：进程级 run_id 自增计数。只在调用方未注入 createRunId 时使用。
// 注意：这让同一进程内多个 Runner 共享计数器——测试需要可预测 id 时应主动注入 createRunId。
let fallbackRunSequence = 0;

/**
 * fallbackRunId：默认 id 生成器，输出 run_1 / run_2 / ...
 * 与 process 内自增序号绑定，便于在日志里肉眼排序。
 */
function fallbackRunId(): string {
  fallbackRunSequence += 1;
  return `run_${fallbackRunSequence}`;
}

/**
 * positiveInteger：参数校验小工具。
 *
 * maxSteps / maxToolCallsPerTurn / maxToolConcurrency 必须是 >=1 的安全整数，
 * 否则状态机/control 流会出问题（比如 0 步立刻 max_steps 终止）。
 * 失败抛 RangeError 让“配置错”在 start 阶段立刻暴露，不进入运行时。
 */
function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} 必须是正安全整数`);
  }
  return value;
}

/**
 * ToolCallLimitError：单 turn 工具调用数超限的专用错误。
 *
 * 与通用 Error 区分开，让测试能精确断言 outcome.cause 类型，
 * 也便于上层在 UI 上展示“哪一轮、实际几个、上限几个”的可读错误。
 */
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

/**
 * DuplicateToolCallIdError：跨 turn 重复使用同一 tool call id 的专用错误。
 *
 * 单 turn 内的重复由 model.ts 的 schema 拒绝；这里处理“前几轮用过的 id 又出现”。
 * 重复 id 会让 tool message 关联回错误的 ToolCall，必须直接终止 Run。
 */
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
// const Tools 让 Runner 实例保留工具元组的字面量顺序；type-contracts.ts 的精确推断因此能继续生效。
export class AgentRunner<const Tools extends readonly AnyTool[]> {
  // #model / #tools / #clock / #createRunId：四个私有依赖，构造时定型。
  // 用 private field (#)：不仅限制外部访问，也避免与子类/同名属性冲突。
  readonly #model: ModelAdapter;
  readonly #tools: ToolRegistry<Tools>;
  readonly #clock: Clock;
  readonly #createRunId: () => string;

  /**
   * 构造：保存依赖，clock/createRunId 缺省时用系统实现兜底。
   * 不在这里做任何 I/O——Runner 实例可以反复 start 多次。
   */
  constructor(dependencies: RunnerDependencies<Tools>) {
    this.#model = dependencies.model;
    this.#tools = dependencies.tools;
    this.#clock = dependencies.clock ?? systemClock;
    this.#createRunId = dependencies.createRunId ?? fallbackRunId;
  }

  /**
   * start：开一条新 Run，立即返回句柄（不阻塞）。
   *
   * 主要做三件事：
   *   1) 参数 normalize + 校验（maxSteps 等三个数字限制 + grantedPermissions 不含空串）；
   *   2) 建立取消链路：把外部 signal 串联到内部 AbortController，让父级取消能传播；
   *   3) 异步启动 #execute，把 AsyncQueue 作为事件通道，把 AbortController.abort 作为 cancel 入口。
   */
  start(input: string, options: RunOptions = {}): AgentRun {
    // 三个正整数限制都给默认值；positiveInteger 在非法时直接抛错（不进入 Run）。
    const maxSteps = positiveInteger(options.maxSteps ?? 8, 'maxSteps');
    const maxToolCallsPerTurn = positiveInteger(
      options.maxToolCallsPerTurn ?? 16,
      'maxToolCallsPerTurn',
    );
    const maxToolConcurrency = positiveInteger(
      options.maxToolConcurrency ?? 4,
      'maxToolConcurrency',
    );
    // grantedPermissions 拷贝成新的 Set：避免调用方在 Run 进行中改外部 Set 影响内部判定。
    const grantedPermissions = new Set(options.grantedPermissions ?? []);
    // 拒绝空字符串权限：空串被 trim 后毫无意义，几乎肯定是调用方的拼写错误。
    for (const permission of grantedPermissions) {
      if (permission.trim() === '') {
        throw new RangeError('grantedPermissions 不能包含空字符串');
      }
    }

    // runId 由依赖注入或 fallbackRunId 生成；保持单进程内唯一即可。
    const runId = this.#createRunId();
    // controller：本 Run 的取消枢纽。cancel() = controller.abort(reason)。
    const controller = new AbortController();
    // queue：事件投递通道。AsyncQueue 同时是 AsyncIterable（给外部）和被 Runner 内部 push。
    const queue = new AsyncQueue<AgentEvent>();

    // 父级 signal 链路：如果调用方传了 signal，把它的 abort 转发到本 Run 的 controller。
    // 这样“父任务取消 -> 子 Run 取消”是自动的，符合结构化并发原则。
    const parentSignal = options.signal;
    const forwardParentAbort = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) forwardParentAbort();
    else parentSignal?.addEventListener('abort', forwardParentAbort, { once: true });

    // 真正的执行体：异步启动。.finally 移除监听，避免父级 signal 长期持有回调（内存泄漏）。
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

    // 返回“三通道 + cancel”的句柄。注意 events 是 queue 本身（暴露 AsyncIterable 接口）。
    return {
      runId,
      events: queue,
      result,
      cancel: (reason?: unknown) => controller.abort(reason),
    };
  }

  /**
   * #execute：Run 的主循环。同步签名是 async，整段是结构化的 try/catch/finally。
   *
   * 流程：
   *   1) 初始化 messages（用户输入）、seenCallIds（防重复 id）、usage 累加器、step 计数、seq 计数；
   *   2) 发 run_started 事件；
   *   3) 进入 step 循环（1..maxSteps），每步：发 model_started -> 调模型 -> parseModelTurn -> 累加 usage -> 发 model_completed；
   *   4) 若 final：写入 assistant text message -> 发 run_finished(completed) -> 返回；
   *   5) 若 tool_calls：先做数量/重复 id 校验，再调度工具，把结果回填成 tool message；
   *   6) 全部步骤走完仍非 final -> 发 run_finished(max_steps)；
   *   7) catch：把任何异常归一成 'cancelled' 或 'failed' outcome；
   *   8) finally：关闭事件队列（让观察者的 for-await 自然结束）。
   */
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
    // messages：对话历史。首轮直接放入 user message；后续每轮根据模型回合追加 assistant/tool 消息。
    // 这里用 mutable let：消息只往尾部 push，不修改历史条目，仍是逻辑上的 append-only。
    const messages: ConversationMessage[] = [{ role: 'user', content: input }];
    // seenCallIds：跨 turn 累计已使用的 call id，防模型重复（即使故意试探也只能用一次）。
    const seenCallIds = new Set<string>();
    // usage 累加器，初始 ZERO_USAGE；每个 turn 的 usage 都走 addUsage 做安全整数检查。
    let usage: TokenUsage = ZERO_USAGE;
    // currentStep 用于异常时报告“在第几步失败”——循环内的 step 是 block-scoped，外面拿不到。
    let currentStep = 0;
    // sequence + nextSequence：事件 seq 的自增机制。seq 必须严格递增，便于排序/去重。
    let sequence = 0;
    const nextSequence = () => {
      sequence += 1;
      return sequence;
    };

    // 发出第一条事件 run_started。input 字段让订阅者可以审计/回放用户原始输入。
    events.push({
      type: 'run_started',
      seq: nextSequence(),
      runId,
      input,
      at: this.#clock.now(),
    });

    try {
      // 主循环：1-based 步数，到 maxSteps 终止。
      for (let step = 1; step <= maxSteps; step += 1) {
        currentStep = step;
        // 每步进入时先看 signal：外部取消应立刻终止，不再请求模型。
        signal.throwIfAborted();

        // model_started：让观察者知道“开始调用模型了”，便于 UI 显示 loading。
        events.push({
          type: 'model_started',
          seq: nextSequence(),
          runId,
          step,
          at: this.#clock.now(),
        });

        // 调模型。structuredClone 保护 messages：模型适配器不可信，深拷贝避免它修改内部对话历史。
        // tools.descriptors() 也已深拷贝（在 ToolRegistry 里），双重保险。
        const rawTurn = await this.#model.complete(
          {
            runId,
            step,
            messages: structuredClone(messages),
            tools: this.#tools.descriptors(),
          },
          signal,
        );
        // 关键闸门：rawTurn 是 unknown，必须经 parseModelTurn 升级为受信任 ModelTurn。
        // 协议不合法 -> 抛 ModelProtocolError，被外层 catch 转成 'failed' outcome。
        const turn = parseModelTurn(rawTurn);
        // 模型回合的 usage 在这里累加；非法 usage（负数/NaN/非整数）会在 addUsage 内抛错。
        usage = addUsage(usage, turn.usage);

        // model_completed 只在 parse 成功后发出——保证事件流里看到的 turn 都是合法的。
        events.push({
          type: 'model_completed',
          seq: nextSequence(),
          runId,
          step,
          turn,
          at: this.#clock.now(),
        });

        // 分支 A：final——直接收尾。
        if (turn.kind === 'final') {
          // 把 assistant 的文本回答写进 messages，保持对话历史完整（便于将来继续对话/重放）。
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

        // 分支 B：tool_calls——先校验数量与 id 唯一性，再调度。
        // 数量硬上限：超过 maxToolCallsPerTurn 直接抛 ToolCallLimitError（不执行任何工具）。
        // 这样模型即使在 prompt 注入下“请求 1000 个工具”，也不会把系统拖垮。
        if (turn.calls.length > maxToolCallsPerTurn) {
          throw new ToolCallLimitError(step, turn.calls.length, maxToolCallsPerTurn);
        }
        // 跨 turn 唯一性：当前 turn 内 id 已由 model.ts 校验唯一，这里看历史集合。
        // 重复即抛 DuplicateToolCallIdError——这是不可恢复的协议违规。
        for (const call of turn.calls) {
          if (seenCallIds.has(call.id)) {
            throw new DuplicateToolCallIdError(call.id, step);
          }
        }
        // 全部 id 通过校验后才并入 seenCallIds：避免抛错时也污染历史集合。
        for (const call of turn.calls) seenCallIds.add(call.id);

        // 把模型请求写进对话历史。calls 是只读 ToolCall[]，message 直接引用领域对象。
        messages.push({ role: 'assistant', kind: 'tool_calls', calls: turn.calls });
        // 调度工具调用：worker pool 限制并发；事件在 worker 内按真实发生顺序发出。
        const completedCalls = await this.#executeToolCalls({
          calls: turn.calls,
          concurrency: maxToolConcurrency,
          context: { runId, step, grantedPermissions, signal },
          events,
          nextSequence,
        });

        // 调度结束后再次检查 signal：如果中途取消（worker 自己 abort），在这里转成 throw 走 catch。
        signal.throwIfAborted();

        // 事件按真实发生顺序发出；消息按模型原调用顺序回填，保证 prompt 可复现。
        // 这一刻意区分：观察者关心“什么时候真的发生了”，而模型 prompt 必须稳定可复现。
        for (const { call, result } of completedCalls) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            // serializeToolResult 只暴露稳定脱敏的错误，不会泄露 cause/stack/权限名（见函数注释）。
            content: serializeToolResult(result),
            isError: !result.ok,
          });
        }
      }

      // 走完 maxSteps 仍然不是 final：归一为 'max_steps' outcome。
      // 这是一种“良性终止”——模型可能在合理场景下需要多轮，调用方可以基于此增加 maxSteps 重试。
      const outcome: AgentOutcome = {
        status: 'max_steps',
        runId,
        steps: maxSteps,
        usage,
      };
      this.#finish(events, nextSequence(), outcome);
      return outcome;
    } catch (cause: unknown) {
      // 异常归一：把 try 里抛出的任何错误映射成 cancelled 或 failed。
      // signal.aborted 是判别依据：取消产生的异常归为 cancelled，其它归为 failed。
      // reason/cause 都被透传到 outcome，让调用方能拿到原始错误对象（如 ModelProtocolError）做断言。
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
      // finally 必须执行：关闭事件队列，让所有正在 await next() 的消费者收到 done。
      // 即使是 catch 路径也走这里，确保事件流不会泄漏（订阅方 for-await 永远会结束）。
      events.close();
    }
  }

  /**
   * #executeToolCalls：worker pool 调度本轮的工具调用。
   *
   * 结构化并发策略：
   *   - 用一个 child AbortController，把“父信号取消 / 任一 worker 抛错”都转成它 abort；
   *   - 启动 min(concurrency, calls.length) 个 worker；每个 worker 用 nextIndex 自取下标；
   *   - 任何 worker 抛错（非取消）记录为 firstFailure，并 abort child，让其它 worker 知难而退；
   *   - 全部 worker 完成后，如果 firstFailure 不空，把它 re-throw 给外层 catch；
   *   - completed 数组按下标存储结果，保证回填时按模型原调用顺序。
   *
   * 事件时机：tool_started 在 await 工具前发，tool_completed 在拿到结果后发，
   * 因此“事件流里的顺序 = 真实发生顺序”，与“消息回填顺序”可以不同。
   */
  async #executeToolCalls(configuration: {
    readonly calls: readonly ToolCall[];
    readonly concurrency: number;
    readonly context: Omit<ToolContext, 'callId'>;
    readonly events: AsyncQueue<AgentEvent>;
    readonly nextSequence: () => number;
  }): Promise<readonly CompletedCall[]> {
    const { calls, concurrency, context, events, nextSequence } = configuration;
    // child：本批工具调用的内部 AbortController。
    // 把 context.signal（父信号）的 abort 转发到 child，让 worker 只需观察一个信号。
    const childController = new AbortController();
    const forwardAbort = () => childController.abort(context.signal.reason);
    if (context.signal.aborted) forwardAbort();
    else context.signal.addEventListener('abort', forwardAbort, { once: true });

    // completed：按下标保留结果。初始全部 undefined，最后用 map 把 undefined 翻译成“调度器漏了”错误。
    // 这个“漏了”分支属于状态机不变量检查——理论上不应该被触发，触发就是实现 bug。
    const completed: (CompletedCall | undefined)[] = Array(calls.length);
    let nextIndex = 0; // 下一个待处理的下标，worker 自取——实现并发但保证每个下标只被一个 worker 取走。
    let firstFailure: { readonly cause: unknown } | undefined;

    /**
     * worker：worker pool 里的单个 worker，循环取下标执行。
     * 故意写成 async 函数 + while 循环，让“最大并发 = workerCount”由 Promise.all 控制。
     */
    const worker = async (): Promise<void> => {
      // 只要 child 还没 abort，就持续取任务。abort 时 worker 自然退出。
      while (!childController.signal.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        // 越界 -> 没有更多任务，worker 结束。
        const call = calls[index];
        if (call === undefined) return;

        // 发 tool_started：让观察者知道“这个工具开始跑了”。
        events.push({
          type: 'tool_started',
          seq: nextSequence(),
          runId: context.runId,
          step: context.step,
          call,
          at: this.#clock.now(),
        });

        try {
          // 真正调用工具。callId 来自 call.id，signal 是 child（不是父信号）——
          // 这样“任一 worker 出错 -> child abort -> 其它正在跑的工具也收到取消”。
          const result = await this.#tools.invokeDynamic(call.name, call.arguments, {
            ...context,
            callId: call.id,
            signal: childController.signal,
          });
          // 按原下标存结果——保证后续回填顺序与模型请求顺序一致。
          completed[index] = { call, result };
          // tool_completed：只在结果落地后发出。如果工具在 await 中途被 abort，这条事件不会发。
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
          // 第一个失败的 worker：记录 cause 并 abort child，让其它 worker 知道“批失败”。
          // 后续失败的 worker 不覆盖 firstFailure——只保留第一个原因，便于诊断。
          if (firstFailure === undefined) {
            firstFailure = { cause };
            childController.abort(cause);
          }
          return;
        }
      }
    };

    try {
      // 启动 worker 数：min(concurrency, calls.length)。calls 比 concurrency 少时无需启动全部 worker。
      const workerCount = Math.min(concurrency, calls.length);
      // Promise.all 等所有 worker 退出（无论正常完成还是因 abort 提前退出）。
      await Promise.all(Array.from({ length: workerCount }, worker));
      // 父信号在调度过程中 abort 了？抛给外层走 catch（转 cancelled）。
      context.signal.throwIfAborted();
      // 有 worker 抛错？re-throw 让外层走 catch（转 failed）。
      if (firstFailure !== undefined) throw firstFailure.cause;

      // 没有失败/取消时，每个槽位都必须由唯一 worker 填充；这里检查状态机不变量。
      // 漏槽属于实现 bug（不应该发生），但显式检查比 silent undefined 安全得多。
      return completed.map((item, index) => {
        if (item === undefined) {
          throw new Error(`工具调度器未产生第 ${index} 个结果`);
        }
        return item;
      });
    } finally {
      // 无论成功失败，都把父信号的监听器移除，避免内存泄漏（结构化并发的清理义务）。
      context.signal.removeEventListener('abort', forwardAbort);
    }
  }

  /**
   * #finish：发出 run_finished 事件。三件事都做：push 事件、写入 outcome、消耗 seq。
   * 集中在这里做，让 try/catch/max_steps 三个出口的代码保持对称、好维护。
   */
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

/**
 * assertNever：穷尽性检查 helper。
 *
 * switch 走到 default 分支说明出现了 ToolFailure union 之外的“新 code”，属于实现 bug。
 * 让 TS 在编译期就能警告“switch 没覆盖所有分支”（never 类型只接受 never 值）；
 * 运行时若真的触发，抛出明确错误而不是 silent return undefined。
 */
function assertNever(value: never): never {
  throw new Error(`未处理的工具失败分支: ${String(value)}`);
}

/** 只向模型暴露稳定、脱敏、JSON 兼容的错误，不泄漏原始 cause/stack/权限名。 */
// serializeToolResult：把 ToolExecutionResult 序列化成会进 tool message content 的字符串。
//
// 安全策略：
//   - 成功：直接 JSON.stringify { ok:true, value }；
//   - 失败：按 code 走分支，部分 code（FORBIDDEN/INVALID_OUTPUT/CANCELLED/EXECUTION_FAILED）
//     只暴露 code 字符串本身，不带 cause/requiredPermission/字段级 issue——
//     避免把内部信息（如权限名、堆栈、字段路径）泄露给模型，防止被 prompt 注入利用；
//   - UNKNOWN_TOOL/INVALID_ARGUMENTS 保留必要字段：前者模型需要知道哪个名字错了，
//     后者字段级 issue 是合法的纠错反馈。
//
// assertNever 让“未来新增一个 code”时强制要求更新这里，避免遗漏脱敏。
function serializeToolResult(result: ToolExecutionResult): string {
  if (result.ok) return JSON.stringify({ ok: true, value: result.value });

  // publicError 类型上要求带 code，其它字段用 index signature 接收“安全可暴露的字段”。
  let publicError: { readonly code: string; readonly [key: string]: unknown };
  switch (result.error.code) {
    case 'UNKNOWN_TOOL':
      // 暴露 toolName：模型需要知道“这个名字没注册”，便于自我纠正。
      publicError = { code: result.error.code, toolName: result.error.toolName };
      break;
    case 'INVALID_ARGUMENTS':
      // 暴露字段级 issue：是合法反馈，模型可据此重试。
      publicError = { code: result.error.code, issues: result.error.issues };
      break;
    case 'FORBIDDEN':
    case 'INVALID_OUTPUT':
    case 'CANCELLED':
    case 'EXECUTION_FAILED':
      // 只暴露 code：FORBIDDEN 不带 requiredPermission（防探测可用权限名），
      // INVALID_OUTPUT 不带字段 issue（内部实现细节），CANCELLED/EXECUTION_FAILED 不带 cause。
      publicError = { code: result.error.code };
      break;
    default:
      // 编译期：union 没穷尽时这里收到的 value 不是 never，tsc 直接报错；
      // 运行期：理论上不可达，但保留兜底抛错。
      return assertNever(result.error);
  }

  return JSON.stringify({ ok: false, error: publicError });
}
