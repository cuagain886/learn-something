import {
  array,
  number,
  object,
  optional,
  refine,
  string,
  transform,
} from '../17-schema.js';
import { defineTool } from './tool.js';

const sumInputSchema = object({
  values: array(number(), {
    minItems: 1,
    description: '至少一个有限数字',
  }),
});

type SumOutput = {
  readonly sum: number;
  readonly count: number;
};

export const sumTool = defineTool({
  name: 'sum',
  description: '计算一组有限数字的总和',
  inputSchema: sumInputSchema,
  async execute(input, context): Promise<SumOutput> {
    context.signal.throwIfAborted();
    return {
      sum: input.values.reduce((total, value) => total + value, 0),
      count: input.values.length,
    };
  },
});

const nonBlankQuerySchema = refine(
  transform(string({ minLength: 1 }), (value) => value.trim()),
  (value) => value.length > 0,
  'query 去除首尾空白后不能为空',
);

const searchInputSchema = transform(
  object({
    query: nonBlankQuerySchema,
    limit: optional(number({ integer: true, minimum: 1, maximum: 10 })),
  }),
  (input) => ({
    query: input.query,
    limit: input.limit ?? 3,
  }),
);

type SearchOutput = {
  readonly hits: readonly {
    readonly title: string;
    readonly snippet: string;
  }[];
};

const DOCUMENTS = [
  {
    title: 'TypeScript 类型收窄',
    snippet: '控制流分析会根据 typeof、判别字段和可达性计算当前位置的类型。',
  },
  {
    title: 'Agent 工具调用',
    snippet: '模型参数必须从 unknown 开始验证，不能使用类型断言代替运行时证据。',
  },
  {
    title: '结构化并发',
    snippet: '父任务负责等待、取消和清理它创建的子任务。',
  },
] as const;

export const searchDocsTool = defineTool({
  name: 'search_docs',
  description: '在内置 TypeScript/Agent 学习资料中检索',
  inputSchema: searchInputSchema,
  requiredPermission: 'docs:read',
  async execute(input, context): Promise<SearchOutput> {
    context.signal.throwIfAborted();
    const keywords = input.query.toLocaleLowerCase().split(/\s+/u);
    const hits = DOCUMENTS
      .filter((document) => {
        const text = `${document.title} ${document.snippet}`.toLocaleLowerCase();
        return keywords.some((keyword) => text.includes(keyword));
      })
      .slice(0, input.limit);

    return { hits };
  },
});
