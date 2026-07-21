// mock-model.ts：完全确定性的 ModelAdapter 实现。
//
// 作用：
//   - 让 demo.ts / runner.test.ts 能跑完整 Runner 而不依赖真实 LLM（无网络、无 API Key、无随机性）；
//   - 通过两条“写死”的回合覆盖 happy path：第一步请求两个工具，第二步基于工具消息给出 final。
//   - 验证“Runner -> 模型 -> 工具 -> 工具消息 -> 模型 -> final”的完整闭环。
import type { ConversationMessage, ModelTurn } from './domain.js';
import type { ModelAdapter, ModelRequest } from './model.js';

/**
 * 完全确定性的模型 Fake。第一步同时请求两个工具，第二步读取工具消息后给最终答案。
 * 它让 demo/test 验证 Runner 协议，而不依赖网络、API Key 或模型随机性。
 */
// 注意：complete 返回的是 ModelTurn（类型层）而不是 unknown——但 Runner 仍然会跑 parseModelTurn。
// 这是有意为之：让 Runner 在测试中也走完整协议闸门，确保 parseModelTurn 不会拒绝合法 ModelTurn。
export class DeterministicModel implements ModelAdapter {
  async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelTurn> {
    // 第一步先看取消：取消信号到达时立刻抛，不返回回合——让 Runner 走 'cancelled' 分支。
    signal.throwIfAborted();

    // 第 1 步：固定请求两个工具——sum 计算 1+2+3，search_docs 找 Agent 资料。
    // 同时请求多个工具，正好覆盖 Runner 的 worker pool 并发调度路径。
    if (request.step === 1) {
      return {
        kind: 'tool_calls',
        calls: [
          {
            id: 'call_sum_1',
            name: 'sum',
            arguments: { values: [1, 2, 3] },
          },
          {
            id: 'call_search_1',
            name: 'search_docs',
            arguments: { query: 'Agent 工具', limit: 2 },
          },
        ],
        usage: { inputTokens: 12, outputTokens: 8 },
      };
    }

    // 第 2 步：从 request.messages 里筛出 tool message，根据数量产出最终答案。
    // 这里写死文本“sum=6”——隐含断言：sum 工具确实算出了 6。
    const toolMessages = request.messages.filter(isToolMessage);
    return {
      kind: 'final',
      text: `已处理 ${toolMessages.length} 个工具结果：sum=6，并找到 Agent 工具调用资料。`,
      usage: { inputTokens: 20, outputTokens: 10 },
    };
  }
}

/**
 * isToolMessage：类型守卫，把对话历史中的 'tool' 消息精确筛出来。
 *
 * 写成独立函数（而不是内联 lambda）便于复用，并让 type predicate 收窄到具体分支。
 * 模型在第 2 步可以根据“有几个 tool 消息”做决策——这是工具调用循环最常见的设计模式。
 */
function isToolMessage(
  message: ConversationMessage,
): message is Extract<ConversationMessage, { readonly role: 'tool' }> {
  return message.role === 'tool';
}

