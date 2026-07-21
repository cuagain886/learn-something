// example-tools.ts：示例工具实现。
//
// 目的：让 demo.ts / runner.test.ts 不必为了“能调用的工具”再写一遍实现。
// 同时也示范“如何用 defineTool 把一个 Schema + execute 包成正式工具”。
//
// 提供两个工具：
//   - sumTool：纯计算工具，无需权限；
//   - searchDocsTool：读取内置文档库的工具，需要 'docs:read' 权限（用于演示权限链路）。
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

/**
 * sumInputSchema：sum 工具的输入 schema。
 *
 *   - values：长度 >=1 的数字数组；
*    - minItems:1 阻止模型传空数组（避免退化成“对空数组求和”的语义讨论）。
 */
const sumInputSchema = object({
  values: array(number(), {
    minItems: 1,
    description: '至少一个有限数字',
  }),
});

/**
 * SumOutput：sum 工具的输出领域类型。
 *   - sum：所有 values 的和；
 *   - count：参与求和的元素个数，便于模型回显“N 个数字的和是 M”。
 */
type SumOutput = {
  readonly sum: number;
  readonly count: number;
};

/**
 * sumTool：对一组数字求和的纯计算工具。
 *
 *   - 无 requiredPermission：任何 Run 都可以调用；
 *   - execute 进入时先 throwIfAborted：被取消时立刻返回，不浪费 CPU；
 *   - reduce 求和 + count 长度，作为静态类型 SumOutput 返回。
 *
 * 这是“最小可信工具”的模板：纯粹的 input -> output，没有副作用。
 */
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

/**
 * nonBlankQuerySchema：query 字段的复合 schema。
 *
 * 两层叠加：
 *   1) transform(string) 先 trim，把 '  agent  ' 变成 'agent'；
 *   2) refine 校验 trim 后长度 > 0，拒绝纯空白字符串。
 *
 * 这样领域层拿到的 input.query 一定是“非空且已 trim”的字符串。
 */
const nonBlankQuerySchema = refine(
  transform(string({ minLength: 1 }), (value) => value.trim()),
  (value) => value.length > 0,
  'query 去除首尾空白后不能为空',
);

/**
 * searchInputSchema：search_docs 的完整输入 schema。
 *
 *   - query：用上面的 nonBlankQuerySchema；
 *   - limit：可选，1..10 的整数；optional + transform 让“未提供时默认 3”，
 *     简化模型调用（不需要每次都传 limit）。
 */
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

/**
 * SearchOutput：search_docs 的输出领域类型。
 * hits 是只读数组，元素是 { title, snippet }——刻意用 readonly 让调用方无法误改结果。
 */
type SearchOutput = {
  readonly hits: readonly {
    readonly title: string;
    readonly snippet: string;
  }[];
};

/**
 * DOCUMENTS：内置的“学习资料库”。
 *
 * 用 as const 让每条文档的字段类型成为精确字面量，便于将来扩展或做静态校验。
 * 真实生产场景这里会换成向量检索/数据库调用；demo 中用纯内存数组即可。
 */
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

/**
 * searchDocsTool：在内置文档库里做关键词检索的工具。
 *
 *   - requiredPermission: 'docs:read'：演示“受限工具”，调用方必须在 Run 启动时授予此权限；
 *   - execute 把 query 拆词，逐文档做 case-insensitive 子串匹配，取前 limit 条；
 *   - throwIfAborted 让长检索（理论上是 I/O）能被取消。
 *
 * 这条工具验证了完整链路：权限 -> Schema 校验 -> 业务执行 -> 输出校验。
 */
export const searchDocsTool = defineTool({
  name: 'search_docs',
  description: '在内置 TypeScript/Agent 学习资料中检索',
  inputSchema: searchInputSchema,
  requiredPermission: 'docs:read',
  async execute(input, context): Promise<SearchOutput> {
    context.signal.throwIfAborted();
    // 按空白切词，便于“多个关键词命中任意一个”的检索语义。
    const keywords = input.query.toLocaleLowerCase().split(/\s+/u);
    const hits = DOCUMENTS
      .filter((document) => {
        // 把标题 + 摘要拼成一个串再 lower-case 比对，简化匹配逻辑。
        const text = `${document.title} ${document.snippet}`.toLocaleLowerCase();
        // 任一关键词命中即纳入候选；some 让“多关键词”语义更自然。
        return keywords.some((keyword) => text.includes(keyword));
      })
      // 截断到 limit：保证返回数量受调用方控制（input.limit 默认 3）。
      .slice(0, input.limit);

    return { hits };
  },
});
