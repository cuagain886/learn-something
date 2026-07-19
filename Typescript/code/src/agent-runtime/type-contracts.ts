/**
 * 只由 tsc 执行的“类型契约测试”。
 *
 * 运行时单元测试无法证明泛型推断结果；这里通过正常赋值与 @ts-expect-error
 * 同时锁定正向和负向 API。若 ToolRegistry 日后意外变宽，typecheck 会失败。
 */
import { searchDocsTool, sumTool } from './example-tools.js';
import { createToolRegistry, type ToolContext } from './tool.js';

const registry = createToolRegistry([sumTool, searchDocsTool] as const);

// @ts-expect-error 同一个 literal name 在编译期即被 UniqueConstraint 拒绝
createToolRegistry([sumTool, sumTool] as const);

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Condition extends true> = Condition;

type RegisteredName = (typeof registry.tools)[number]['descriptor']['name'];
type _RegisteredNamesStayLiteral = Expect<Equal<RegisteredName, 'sum' | 'search_docs'>>;

async function verifyContracts(context: ToolContext): Promise<void> {
  const sum = await registry.invokeKnown('sum', { values: [1, 2] }, context);
  if (sum.ok) {
    const numericSum: number = sum.value.sum;
    void numericSum;

    // @ts-expect-error sum 输出没有 hits，证明输出与工具名保持相关
    void sum.value.hits;
  }

  const search = await registry.invokeKnown(
    'search_docs',
    { query: 'TypeScript', limit: 2 },
    context,
  );
  if (search.ok) {
    const hitTitle: string | undefined = search.value.hits[0]?.title;
    void hitTitle;
  }

  // @ts-expect-error sum 的输入不是 search 参数
  await registry.invokeKnown('sum', { query: 'wrong', limit: 1 }, context);

  // @ts-expect-error send_email 没有注册
  await registry.invokeKnown('send_email', {}, context);
}

// 永不执行；函数体仍会被 TypeScript Checker 完整检查。
if (false) {
  void verifyContracts({
    runId: 'compile_only',
    step: 1,
    callId: 'compile_only',
    signal: new AbortController().signal,
    grantedPermissions: new Set(['docs:read']),
  });
}

export {};
