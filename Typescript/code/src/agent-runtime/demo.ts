/**
 * 第 21 课：多模块 Agent Runtime 综合案例
 *
 * 运行：npm run lesson:agent-runtime
 * 测试：npm test
 */
import { searchDocsTool, sumTool } from './example-tools.js';
import { DeterministicModel } from './mock-model.js';
import { AgentRunner } from './runner.js';
import { createToolRegistry } from './tool.js';
import type { AgentEvent } from './domain.js';

const registry = createToolRegistry([sumTool, searchDocsTool] as const);
const runner = new AgentRunner({
  model: new DeterministicModel(),
  tools: registry,
  createRunId: () => 'run_demo_agent_runtime',
});

const run = runner.start('计算 1、2、3 的和，并查找 Agent 工具调用资料。', {
  maxSteps: 4,
  grantedPermissions: new Set(['docs:read']),
});

// 事件流与最终结果是两个通道：事件用于 UI/日志/持久化，result 用于控制流。
const observeEvents = (async () => {
  for await (const event of run.events) {
    console.log(formatEvent(event));
  }
})();

const outcome = await run.result;
await observeEvents;

console.log('最终 Outcome:', outcome);

function formatEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'run_started':
      return `[${event.seq}] Run ${event.runId} started`;
    case 'model_started':
      return `[${event.seq}] Step ${event.step}: model started`;
    case 'model_completed':
      return `[${event.seq}] Step ${event.step}: model -> ${event.turn.kind}`;
    case 'tool_started':
      return `[${event.seq}] Tool ${event.call.name} started`;
    case 'tool_completed':
      return `[${event.seq}] Tool ${event.call.name} -> ${event.result.ok ? 'ok' : event.result.error.code}`;
    case 'run_finished':
      return `[${event.seq}] Run finished: ${event.outcome.status}`;
  }
}
