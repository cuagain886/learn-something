/**
 * 第 21 课：多模块 Agent Runtime 综合案例
 *
 * 运行：npm run lesson:agent-runtime
 * 测试：npm run test
 */
// demo.ts：把前面 8 个文件组装成一个端到端可执行的样例。
//
// 装配顺序展示了运行时的依赖关系：
//   - 工具（example-tools）-> ToolRegistry（tool）-> AgentRunner（runner）-> start 一条 Run。
// 这里同时演示两条通道：events（事件流，可订阅）+ result（控制流，await 拿终态）。
import { searchDocsTool, sumTool } from './example-tools.js';
import { DeterministicModel } from './mock-model.js';
import { AgentRunner } from './runner.js';
import { createToolRegistry } from './tool.js';
import type { AgentEvent } from './domain.js';

// 构造注册表：把两个示例工具用 createToolRegistry 组装，`as const` 让类型层拿到精确名字联合。
// 这个 registry 既被 Runner 用于调度，也被 type-contracts.ts 用作“类型契约”的样本。
const registry = createToolRegistry([sumTool, searchDocsTool] as const);
// 构造 Runner：注入确定性模型 + 注册表 + 固定 runId 生成器（让 demo 输出可复现）。
const runner = new AgentRunner({
  model: new DeterministicModel(),
  tools: registry,
  createRunId: () => 'run_demo_agent_runtime',
});

// 启动 Run：用户输入里同时包含“求和”和“查找资料”两个意图，正好触发 DeterministicModel 第 1 步的双工具请求。
// maxSteps=4 给模型留出足够空间；grantedPermissions 授予 'docs:read' 让 search_docs 能放行。
const run = runner.start('计算 1、2、3 的和，并查找 Agent 工具调用资料。', {
  maxSteps: 4,
  grantedPermissions: new Set(['docs:read']),
});

// 事件流与最终结果是两个通道：事件用于 UI/日志/持久化，result 用于控制流。
// observeEvents：独立异步任务，边产生边消费事件——演示真实场景下的“流式观察”。
// 注意：它和 await run.result 是并发的；runner 的事件 push 与 result resolve 各自独立推进。
const observeEvents = (async () => {
  for await (const event of run.events) {
    console.log(formatEvent(event));
  }
})();

// await result：拿到终态 outcome（这里期望 'completed'）。
const outcome = await run.result;
// 等 observeEvents 结束：events 队列会在 #execute 的 finally 里 close，
// for-await 自然走完后这个 async IIFE 才 resolve，确保日志全部打印。
await observeEvents;

console.log('最终 Outcome:', outcome);

/**
 * formatEvent：把 AgentEvent 投影成一行可读字符串。
 *
 * switch 不需要 default：因为 AgentEvent 是 closed union，所有分支都列出来了；
 * 未来如果给 union 加新分支，tsc 会在 switch 里直接报错（缺 case），强制更新。
 */
function formatEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'run_started':
      return `[${event.seq}] Run ${event.runId} started`;
    case 'model_started':
      return `[${event.seq}] Step ${event.step}: model started`;
    case 'model_completed':
      // turn.kind 是 'final' 或 'tool_calls'，直接显示就能看出本步是收尾还是要调工具。
      return `[${event.seq}] Step ${event.step}: model -> ${event.turn.kind}`;
    case 'tool_started':
      return `[${event.seq}] Tool ${event.call.name} started`;
    case 'tool_completed':
      // ok 时显示 'ok'，失败时显示 error.code（如 INVALID_ARGUMENTS / FORBIDDEN）。
      return `[${event.seq}] Tool ${event.call.name} -> ${event.result.ok ? 'ok' : event.result.error.code}`;
    case 'run_finished':
      // outcome.status 是 completed / max_steps / cancelled / failed，直接显示。
      return `[${event.seq}] Run finished: ${event.outcome.status}`;
  }
}
