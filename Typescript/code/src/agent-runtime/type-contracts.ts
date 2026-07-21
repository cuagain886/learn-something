/**
 * 只由 tsc 执行的“类型契约测试”。
 *
 * 运行时单元测试无法证明泛型推断结果；这里通过正常赋值与 @ts-expect-error
 * 同时锁定正向和负向 API。若 ToolRegistry 日后意外变宽，typecheck 会失败。
 */
// 文件存在意义：
//   - 工具系统的很多保证（精确 name、与工具名相关的 Output、不存在的工具报错等）只在“类型层”成立；
//   - runner.test.ts 跑的是运行时，无法证明 invokeKnown('sum', ...) 的返回值类型一定是 sum 的 Output；
//   - 因此把“类型断言”抽到一个 .ts 文件，只让 tsc 跑（永不真正执行），就能在 CI 中挡住“泛型被改宽”。
import { searchDocsTool, sumTool } from './example-tools.js';
import { createToolRegistry, type ToolContext } from './tool.js';

// 构造一个真实的注册表，类型参数 Tools 会精确推断为 readonly [sumTool, searchDocsTool]。
// `as const` 关键：没有它，名字会被拓宽成 string，后续所有断言都会失真。
const registry = createToolRegistry([sumTool, searchDocsTool] as const);

// @ts-expect-error 同一个 literal name 在编译期即被 UniqueConstraint 拒绝
// 这一行触发 UniqueConstraint 的“重名报错”：sumTool 出现两次，DuplicateNames 类型非 never，
// 参数类型不匹配；@ts-expect-error 必须有下一行确实报错才能通过。
createToolRegistry([sumTool, sumTool] as const);

// 等价测试工具：Equal 利用函数类型的高阶等价性做严格相等判定，比单纯 A extends B 更严。
// 这两个工具类型只在“编译期”存在；tsc 把它们求值成 true 或者在 Expect<...> 处直接报错。
type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2)
    ? true
    : false;
// Expect：把“必须为 true”的约束编码进类型层；任何非 true 的实参都无法满足 extends true。
type Expect<Condition extends true> = Condition;

// RegisteredName：从 registry.tools 元组抽出所有工具名字，应该是 'sum' | 'search_docs'。
// 如果 ToolRegistry 实现变宽（比如把 name 拓宽成 string），下面这行就会失败。
type RegisteredName = (typeof registry.tools)[number]['descriptor']['name'];
// 静态断言：注册表保留字面量名字的并集，没有丢失。
type _RegisteredNamesStayLiteral = Expect<Equal<RegisteredName, 'sum' | 'search_docs'>>;

/**
 * verifyContracts：把每个 invokeKnown 的正向/负向契约写在同一个函数里。
 *
 * 函数体只为了让 tsc 走一遍类型推断；运行时永不执行（见末尾 if (false) 块）。
 * 这样既覆盖“happy path”（返回值类型对得上），也用 @ts-expect-error 覆盖“错误用法应被拒绝”。
 */
async function verifyContracts(context: ToolContext): Promise<void> {
  // ① 正向：invokeKnown('sum', { values: [1, 2] }, ...) 调用 sum，返回值 sum.value.sum 是 number。
  const sum = await registry.invokeKnown('sum', { values: [1, 2] }, context);
  if (sum.ok) {
    // 静态上 sum.value 的类型是 { sum: number; count: number }，所以 numericSum 可以收窄成 number。
    const numericSum: number = sum.value.sum;
    void numericSum;

    // @ts-expect-error sum 输出没有 hits，证明输出与工具名保持相关
    // 反向断言：sum 的 Output 不包含 hits 字段；若 ToolRegistry 把 Output 拓宽成 JsonValue，
    // 这一行不再报错，@ts-expect-error 反而会让 tsc 失败——锁住了精确性。
    void sum.value.hits;
  }

  // ② 正向：invokeKnown('search_docs', ...) 返回 hits 数组；元素是 { title, snippet }。
  const search = await registry.invokeKnown(
    'search_docs',
    { query: 'TypeScript', limit: 2 },
    context,
  );
  if (search.ok) {
    // 验证 Output 的元素类型：hits[0]?.title 应当是 string | undefined（可能为空数组）。
    const hitTitle: string | undefined = search.value.hits[0]?.title;
    void hitTitle;
  }

  // @ts-expect-error sum 的输入不是 search 参数
  // 反向断言：把 search 的参数传给 sum 应被类型层拒绝——证明 Input 也是按工具精确推断的。
  await registry.invokeKnown('sum', { query: 'wrong', limit: 1 }, context);

  // @ts-expect-error send_email 没有注册
  // 反向断言：ToolName<Tools> 联合里没有 'send_email'，调用应直接被拒绝（防 typo 调用）。
  await registry.invokeKnown('send_email', {}, context);
}

// 永不执行；函数体仍会被 TypeScript Checker 完整检查。
// 用 if (false) 包裹是为了让 verifyContracts 不在运行时真正发请求，又能让 tsc 把每个断言跑一遍。
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
