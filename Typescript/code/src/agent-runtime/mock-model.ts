import type { ConversationMessage, ModelTurn } from './domain.js';
import type { ModelAdapter, ModelRequest } from './model.js';

/**
 * 完全确定性的模型 Fake。第一步同时请求两个工具，第二步读取工具消息后给最终答案。
 * 它让 demo/test 验证 Runner 协议，而不依赖网络、API Key 或模型随机性。
 */
export class DeterministicModel implements ModelAdapter {
  async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelTurn> {
    signal.throwIfAborted();

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

    const toolMessages = request.messages.filter(isToolMessage);
    return {
      kind: 'final',
      text: `已处理 ${toolMessages.length} 个工具结果：sum=6，并找到 Agent 工具调用资料。`,
      usage: { inputTokens: 20, outputTokens: 10 },
    };
  }
}

function isToolMessage(
  message: ConversationMessage,
): message is Extract<ConversationMessage, { readonly role: 'tool' }> {
  return message.role === 'tool';
}

