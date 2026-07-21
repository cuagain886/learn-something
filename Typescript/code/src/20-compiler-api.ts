/**
 * ============================================================
 * 第 20 课：TypeScript Compiler API 内存实验室
 * ============================================================
 *
 * 运行：npm run lesson:compiler
 *
 * 本课不再依赖“当前项目刚好没有诊断”，而是在内存中构造可重复实验，验证：
 *
 * 1. Scanner 只产生 token，Parser 只建立语法 Node；
 * 2. Binder 把同名声明连接成 Symbol，Checker 为位置计算 Type；
 * 3. flow type 是“声明类型 + 当前控制流事实”，不会改写原 AST；
 * 4. `transpileModule` 不做完整语义检查；Program 才拥有跨节点语义；
 * 5. transformer 改写 emit 树，声明 emit 仍来自 checker 的公共类型；
 * 6. builder program 依赖 SourceFile.version，只重算受影响图而不是重新发明类型系统。
 *
 * Compiler API 没有与语言本身相同的稳定性承诺，工具应锁定 TS 版本并做契约测试。
 */

// node:assert/strict 提供运行时断言；编译期断言无法验证 Compiler API 的运行时输出，故二者并用。
import assert from 'node:assert/strict';
// path 用于把“虚拟文件名”规范成绝对路径，让 Program 把它当成正常模块图中的一个文件。
import path from 'node:path';
// 整个 typescript 包既是“编译器”也是“库”：从这里取 Scanner / Parser / Program / Checker / Transformer。
import * as ts from 'typescript';

// ------------------------------------------------------------
// 1. Scanner：字符流 -> token；不理解声明、作用域或类型
// ------------------------------------------------------------
// Scanner 是编译流水线的第一级：它只关心“当前这段文本切成了什么 token”，
// 不知道 const 是声明、不知道 answer 是名字、不知道 number 是类型——这些都是后续阶段的事。

// 用来喂给 Scanner 的源码字符串：一个带类型标注和初始值的 const 声明。
const scanText = 'const answer: number = 42;';
// createScanner 创建一个有状态的扫描器：每次调用 scan() 推进到下一个 token。
// 参数：目标 ES 版本、是否跳过 trivia（空白/注释）、语言变体（Standard vs JSX）、源文本。
const scanner = ts.createScanner(
  ts.ScriptTarget.ES2022,
  false, // 不跳过 trivia：让我们能显式看到 WhitespaceTrivia / NewLineTrivia，便于演示 token 边界。
  ts.LanguageVariant.Standard,
  scanText,
);

// 收集扫描结果，便于断言 token 序列就是这条源码的精确切分。
const scannedTokens: Array<{ readonly kind: string; readonly text: string }> = [];
// scan() 返回当前 token 的 SyntaxKind，并把扫描器游标推到下一个 token 起点。
// 循环到 EndOfFileToken 表示已经吃完整段源码。
for (
  let token = scanner.scan();
  token !== ts.SyntaxKind.EndOfFileToken;
  token = scanner.scan()
) {
  // 空白和换行也是 token（trivia），但在语义层面无意义，这里过滤掉只看“实质 token”。
  if (
    token === ts.SyntaxKind.WhitespaceTrivia ||
    token === ts.SyntaxKind.NewLineTrivia
  ) {
    continue;
  }
  // ts.SyntaxKind 是数字枚举，反向查表拿到可读名（如 'ConstKeyword'）。
  // getTokenText() 返回当前 token 在源码中的字面文本。
  scannedTokens.push({
    kind: ts.SyntaxKind[token],
    text: scanner.getTokenText(),
  });
}

// 断言 token 序列：这条声明被精确切成 7 个实质 token，
// 证明 Scanner 阶段只做“切词”，不解释 const / number 的含义。
assert.deepEqual(scannedTokens, [
  { kind: 'ConstKeyword', text: 'const' },
  { kind: 'Identifier', text: 'answer' },
  { kind: 'ColonToken', text: ':' },
  { kind: 'NumberKeyword', text: 'number' },
  { kind: 'FirstAssignment', text: '=' },
  { kind: 'FirstLiteralToken', text: '42' },
  { kind: 'SemicolonToken', text: ';' },
]);

// ------------------------------------------------------------
// 2. Parser：token -> AST；节点有语法结构，但没有跨文件语义
// ------------------------------------------------------------
// Parser 拿 Scanner 产出的 token 流，按文法组装成树状的 Node（AST）。
// 此时 AST 只表达“语法结构合法”，并不知道类型、符号、导入等跨节点信息。

// createSourceFile 等价于“单独跑 Parser”：把一段文本解析成 SourceFile（AST 的根节点）。
// 参数：文件名、源文本、目标 ES 版本、是否开启 setParentNodes（true 才能用 node.parent 回溯）、脚本种类。
const parsedSource = ts.createSourceFile(
  'scanner-demo.ts',
  scanText,
  ts.ScriptTarget.ES2022,
  true, // setParentNodes：让每个节点都有 parent 指针，后续 transformer 判断上下文需要它。
  ts.ScriptKind.TS,
);

// 计数 AST 节点总数，用来粗略验证“一棵真正的语法树，而不是一个 token 列表”。
let astNodeCount = 0;
// 经典的递归访问模式：访问者函数 + ts.forEachChild（按语法顺序遍历直接子节点）。
function countNodes(node: ts.Node): void {
  astNodeCount += 1;
  ts.forEachChild(node, countNodes);
}
countNodes(parsedSource);

// 这条声明只产生 1 个顶层语句（VariableStatement）。
assert.equal(parsedSource.statements.length, 1);
const firstParsedStatement = parsedSource.statements[0];
// 类型守卫 isVariableStatement 把宽泛的 Statement 收窄为 VariableStatement。
assert.ok(
  firstParsedStatement !== undefined &&
    ts.isVariableStatement(firstParsedStatement),
);
// AST 节点数远大于 token 数：语法树会拆出 VariableDeclarationList / VariableDeclaration /
// TypeAnnotation / Identifier 等多层结构。
assert.ok(astNodeCount > 5);

// ------------------------------------------------------------
// 3. 内存 CompilerHost：真实默认 lib + 虚拟根文件 + 内存输出
// ------------------------------------------------------------
// Program 需要 CompilerHost 提供“文件系统”的抽象：怎么读源文件、lib 在哪、emit 写到哪里。
// 我们劫持 host 的几个方法，把“一个虚拟 .ts 文件”和“内存输出 Map”接进真实编译器，
// 这样就可以在不落盘的情况下复现完整的 Program → Checker → emit 流水线。

// 虚拟根文件的绝对路径：用 path.resolve 让它在模块图里看起来像一个真实文件。
const virtualFileName = path.resolve('virtual/compiler-lab.ts');

// 编译选项：故意开启严格族 + declaration + noEmitOnError，
// 这样后续的语义诊断、.d.ts emit、错误时不产出 等行为都可以在实验里观察到。
const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  declaration: true, // 让 emit 阶段额外产出 .d.ts，便于验证声明 emit 仍来自类型契约。
  noEmitOnError: true, // 出现诊断时拒绝产出任何文件——稍后会断言 outputs.size === 0。
  skipLibCheck: true, // 跳过对 lib 文件本身的检查，节省时间且与本次实验目标无关。
};

// 文件名的“规范键”：把任意写法归一成统一形式，便于在 Map / host 里精确匹配。
// 关键点：Windows 等大小写不敏感文件系统下需要 toLowerCase，否则 host 的判断会被大小写绕过。
function canonical(fileName: string): string {
  const resolved = path.resolve(fileName).replaceAll('\\', '/');
  return ts.sys.useCaseSensitiveFileNames ? resolved : resolved.toLowerCase();
}

// 一次“内存编译”产物：Program 是入口、host 是文件系统适配、outputs 是 emit 结果、
// sourceFile 是虚拟根文件对应的 AST（后续遍历要用它）。
interface VirtualCompilation {
  readonly program: ts.Program;
  readonly host: ts.CompilerHost;
  readonly outputs: Map<string, string>;
  readonly sourceFile: ts.SourceFile;
}

// 工厂函数：传入源文本，返回一个完整可用的内存编译环境。
// 关键技巧是“用 spread 复制 base host 的所有默认行为，再覆写需要虚拟化的方法”。
function createVirtualCompilation(sourceText: string): VirtualCompilation {
  // 以默认 lib + 真实文件系统为基础 host，避免自己手工拼 lib.d.ts。
  const baseHost = ts.createCompilerHost(compilerOptions, true);
  // 把 baseHost 上需要 wrap 的方法 bind 出来，避免后续调用时 this 丢失。
  const baseFileExists = baseHost.fileExists.bind(baseHost);
  const baseReadFile = baseHost.readFile.bind(baseHost);
  const baseGetSourceFile = baseHost.getSourceFile.bind(baseHost);
  // 提前算好“虚拟根文件的规范键”，比较时只比字符串。
  const virtualKey = canonical(virtualFileName);
  // emit 时被 writeFile 接管：所有产物（JS / .d.ts / tsbuildinfo）都进这个 Map，不落盘。
  const outputs = new Map<string, string>();

  // 自定义 host：先 spread 保留 base host 全部默认行为（getDefaultLibLocation、trace、等），
  // 再覆写与“虚拟文件 / 内存输出”相关的 4 个方法。
  const host: ts.CompilerHost = {
    ...baseHost,
    // fileExists：如果是虚拟根文件就直接承认存在，否则问 base host（lib 等真实文件）。
    fileExists(fileName) {
      return canonical(fileName) === virtualKey || baseFileExists(fileName);
    },
    // readFile：虚拟根文件返回我们注入的 sourceText，其他文件回退到 base host。
    readFile(fileName) {
      return canonical(fileName) === virtualKey
        ? sourceText
        : baseReadFile(fileName);
    },
    // getSourceFile：决定 Program 怎么“拿到一个 SourceFile”。
    // 对虚拟根文件，每次都基于当前 sourceText 重新 createSourceFile，
    // 这样后续 BuilderProgram 改写源文本时，新 Program 会立刻读到新版本。
    getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile) {
      if (canonical(fileName) === virtualKey) {
        return ts.createSourceFile(
          fileName,
          sourceText,
          languageVersion,
          true,
          ts.ScriptKind.TS,
        );
      }
      // lib 文件 / 其他模块走默认实现，保持 lib.d.ts 等正常加载。
      return baseGetSourceFile(
        fileName,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      );
    },
    // writeFile：编译器产出的所有文件都进 outputs Map，用规范键作为 key 便于查找。
    writeFile(fileName, text) {
      outputs.set(canonical(fileName), text);
    },
  };

  // 用自定义 host 创建 Program：rootNames 告诉它“从虚拟根文件开始编译”，
  // 它会按 import 关系自动拉取依赖（本例里只有 lib.d.ts）。
  const program = ts.createProgram({
    rootNames: [virtualFileName],
    options: compilerOptions,
    host,
  });
  // 从 Program 中拿回虚拟根文件的 SourceFile（注意它是 Program 持有的、经过 binder 处理的副本）。
  const sourceFile = program.getSourceFile(virtualFileName);
  if (sourceFile === undefined) throw new Error('虚拟 SourceFile 未进入 Program');

  return { program, host, outputs, sourceFile };
}

// “健康源文本”：用来演示完整流水线的样本代码。
// 故意包含：interface 合并、as const 字面量、typeof 收窄、参数 union 等后续要断言的结构。
const goodSourceText = `
export interface Box { value: string }
export interface Box { readonly tag?: "hot" }

export const config = { mode: "fast", retries: 3 } as const;

export function inspect(input: string | number): number {
  if (typeof input === "string") {
    const insideStringBranch = input;
    return insideStringBranch.length;
  }
  const afterStringBranch = input;
  return afterStringBranch.toFixed(2).length;
}

export function scale(value: number): number {
  return value * 2;
}
`;

// 用健康源文本构造一次内存编译，作为后续多个实验的“被测对象”。
const good = createVirtualCompilation(goodSourceText);
// TypeChecker 是 Program 的“语义大脑”：它消费 Binder 建立的 Symbol 表，为任意 Node 计算 Type。
const checker = good.program.getTypeChecker();

// getSyntacticDiagnostics：纯语法层错误（如缺括号、缺分号）。
// getSemanticDiagnostics：语义层错误（如类型不匹配、未定义名字）。
// 两者都为空数组，证明健康源文本在“严格 + exactOptionalPropertyTypes + noUncheckedIndexedAccess”
// 这套组合下完全合法。
assert.deepEqual(good.program.getSyntacticDiagnostics(), []);
assert.deepEqual(good.program.getSemanticDiagnostics(), []);

// ------------------------------------------------------------
// 4. Node、Symbol、Type 与 flow type 是不同对象
// ------------------------------------------------------------
// 这一节要分清编译器里三种核心对象：
//   Node   —— AST 节点，纯语法位置（来自 Parser）。
//   Symbol —— “名字”的语义身份（来自 Binder），多个声明可合并到同一 Symbol。
//   Type   —— “类型”的语义结果（来自 Checker），可能随控制流位置变化（flow type）。

// 在 AST 中按名字查找一个 VariableDeclaration 节点（如 config / insideStringBranch）。
// 用闭包 + ts.forEachChild 做深度优先搜索，找到第一个匹配项即返回。
function findVariable(sourceFile: ts.SourceFile, name: string): ts.VariableDeclaration {
  let found: ts.VariableDeclaration | undefined;
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = node;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (found === undefined) throw new Error(`找不到变量 ${name}`);
  return found;
}

// 在顶层 statements 里筛出所有名为 `name` 的 InterfaceDeclaration。
// 注意返回是数组：TS 允许多个同名 interface 声明合并，因此长度可能 > 1。
function findInterfaces(sourceFile: ts.SourceFile, name: string): ts.InterfaceDeclaration[] {
  return sourceFile.statements.filter(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  );
}

// 找出所有 Box 声明——这里有两条 interface Box，验证“声明合并”机制。
const boxDeclarations = findInterfaces(good.sourceFile, 'Box');
assert.equal(boxDeclarations.length, 2);

// 取第一条声明的 name Identifier 节点作为“位置锚点”，用于让 checker 找到对应的 Symbol。
const firstBoxName = boxDeclarations[0]?.name;
if (firstBoxName === undefined) throw new Error('缺少 Box 声明');
// getSymbolAtLocation：在某个 AST 位置查询 Binder 创建的 Symbol。
// 关键观察：两条 interface Box 的 name 节点都会返回“同一个” boxSymbol——这是 Binder 合并的结果。
const boxSymbol = checker.getSymbolAtLocation(firstBoxName);
if (boxSymbol === undefined) throw new Error('Binder 未创建 Box Symbol');

// 两个 AST InterfaceDeclaration 被 Binder 合并到一个 Symbol。
// 直接看 Symbol.declarations：它收集了所有“贡献给该 Symbol”的声明节点，长度为 2。
assert.equal(boxSymbol.declarations?.length, 2);
// SymbolFlags 是位掩码：用 & 判断 Symbol 是不是某种语义类别（这里验证它是 Interface）。
assert.ok((boxSymbol.flags & ts.SymbolFlags.Interface) !== 0);
// getDeclaredTypeOfSymbol：返回该 Symbol 的“声明类型”——对 interface 来说是对象类型，typeToString 给出名字 'Box'。
assert.equal(checker.typeToString(checker.getDeclaredTypeOfSymbol(boxSymbol)), 'Box');

// 同一个 VariableDeclaration 的 name 位置去查 Type，得到的是“该位置的精确类型”。
const configNode = findVariable(good.sourceFile, 'config');
const configType = checker.typeToString(checker.getTypeAtLocation(configNode.name));
// as const 让 mode / retries 都保留为字面量类型（'fast' / 3），而不是被拓宽为 string / number。
assert.match(configType, /readonly mode: "fast"/u);
assert.match(configType, /readonly retries: 3/u);

// 取两个“控制流敏感”位置的变量：inside 在 typeof === 'string' 分支里，after 在分支结束后。
// 二者都源自同一个参数 input，但 flow type 在不同位置给出不同类型。
const insideNode = findVariable(good.sourceFile, 'insideStringBranch');
const afterNode = findVariable(good.sourceFile, 'afterStringBranch');
// 在 string 分支里：input 被收窄为 string，赋值给 insideStringBranch 后还是 string。
assert.equal(
  checker.typeToString(checker.getTypeAtLocation(insideNode.name)),
  'string',
);
// 分支结束后：因为 typeof 分支 return 了，剩下的一定不是 string，于是 input 被收窄为 number。
assert.equal(
  checker.typeToString(checker.getTypeAtLocation(afterNode.name)),
  'number',
);

// 参数声明本身仍是 union；flow type 只属于具体引用位置/派生声明。
// 关键点：flow type 不会“改写”原 AST 上 input 参数的声明类型——它只是 Checker 在“某个位置查询时”叠加的事实。
let inputParameter: ts.ParameterDeclaration | undefined;
function findInputParameter(node: ts.Node): void {
  if (
    ts.isParameter(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === 'input'
  ) {
    inputParameter = node;
  }
  ts.forEachChild(node, findInputParameter);
}
findInputParameter(good.sourceFile);
if (inputParameter === undefined) throw new Error('找不到 input 参数');
// 直接查“参数声明节点”的 Type，得到的仍是声明的 string | number，
// 与内部某个引用位置收窄出来的 string / number 形成对比。
assert.equal(
  checker.typeToString(checker.getTypeAtLocation(inputParameter.name)),
  'string | number',
);

// ------------------------------------------------------------
// 5. 语法诊断、语义诊断与 transpileModule 的边界
// ------------------------------------------------------------
// 这一节对比三种产出错误的方式：完整 Program 的两层诊断 vs transpileModule 的“只转语法”。

// 语法错误样本：等号右侧什么都没有，Parser 会拒绝。
const syntacticallyBroken = createVirtualCompilation('const value = ;');
// getSyntacticDiagnostics 在语法层就能捕获，长度 > 0。
assert.ok(syntacticallyBroken.program.getSyntacticDiagnostics().length > 0);

// 语义错误样本：把字符串赋给 number。语法合法，但 Checker 会报错码 2322。
const semanticallyBroken = createVirtualCompilation(`
export const value: number = "not a number";
`);
const semanticDiagnostics = semanticallyBroken.program.getSemanticDiagnostics();
// 2322 对应“类型不能分配给该类型”的经典错误，证明 Checker 真的运行了。
assert.ok(semanticDiagnostics.some((diagnostic) => diagnostic.code === 2322));

// 因为开了 noEmitOnError：出现诊断时 emit 必须被拒绝，outputs 保持空。
const skippedEmit = semanticallyBroken.program.emit();
assert.equal(skippedEmit.emitSkipped, true);
assert.equal(semanticallyBroken.outputs.size, 0);

// transpileModule：另一种独立 API，只做“单文件语法转换 + 删除类型标注”，
// 不创建 Program、不构造 Checker，因此不会做任何跨节点 / 类型层面的检查。
const transpiled = ts.transpileModule(
  'const value: number = "not a number"; export { value };',
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
    // 即便显式要求 reportDiagnostics，它也只能报告语法层问题，看不到类型不匹配。
    reportDiagnostics: true,
  },
);

// transpileModule 做单文件语法转换，不创建完整 Program/Checker，因此不会报告 2322。
// 这是它和完整 Program 的根本差别：速度极快，但没有语义保护。
assert.equal(
  transpiled.diagnostics?.some((diagnostic) => diagnostic.code === 2322),
  false,
);
// 转换后的输出文本里直接抹掉了 : number 标注，但保留了源串里的 "not a number" 字面值。
assert.match(transpiled.outputText, /const value = "not a number"/u);

// ------------------------------------------------------------
// 6. Transformer + 内存 emit：JS 树可改写，.d.ts 仍来自类型契约
// ------------------------------------------------------------
// Transformer 是 emit 阶段的“钩子”：在源 AST 被翻译成 JS 的过程中插入自定义访问者，
// 可以替换节点、改变运行时行为。本例把 `value * 2` 中的字面量 2 改写成 3。

// TransformerFactory<SourceFile>：接收 context（含 factory 和替换上下文），返回真正的 visitor。
const multiplyByThree: ts.TransformerFactory<ts.SourceFile> = (context) => {
  // visit 是实际的节点访问者，返回 VisitResult（可能是单个 Node / undefined / 数组）。
  const visit = (node: ts.Node): ts.VisitResult<ts.Node> => {
    // 命中条件：是一个数值字面量 '2'，且它的父节点是 `* ` 二元表达式（即作为乘数）。
    // 通过 node.parent 判断上下文，避免误改其他 '2' 字面量（依赖第 2 节开启的 setParentNodes）。
    if (
      ts.isNumericLiteral(node) &&
      node.text === '2' &&
      ts.isBinaryExpression(node.parent) &&
      node.parent.operatorToken.kind === ts.SyntaxKind.AsteriskToken
    ) {
      // 命中后用 context.factory 创建一个新的字面量 3，替换原节点。
      return context.factory.createNumericLiteral(3);
    }
    // 否则继续递归：visitEachChild 会按结构遍历所有子节点，保证整棵树都被访问到。
    return ts.visitEachChild(node, visit, context);
  };
  // 返回入口：从 SourceFile 开始访问，强转回 SourceFile（visitNode 返回的是更宽的 VisitResult）。
  return (sourceFile) => ts.visitNode(sourceFile, visit) as ts.SourceFile;
};

// 调用 emit，并通过第 5 个参数注入自定义 transformer（before 表示在 TS 自带转换之前运行）。
const goodEmit = good.program.emit(
  undefined, // targetSourceFile：undefined 表示 emit 所有文件。
  good.host.writeFile, // 写到内存 host 的 writeFile（即 outputs Map）。
  undefined, // emitOnlyDtsFiles：false 表示同时产 JS 和 .d.ts。
  false, // forceDtsEmit：false 走默认策略。
  { before: [multiplyByThree] }, // 自定义 transformers。
);
assert.equal(goodEmit.emitSkipped, false);
assert.deepEqual(goodEmit.diagnostics, []);

// 从 outputs 里挑出 JS 产物 和 .d.ts 产物 两条记录。
const javascriptEntry = [...good.outputs.entries()].find(([fileName]) =>
  fileName.endsWith('.js')
);
const declarationEntry = [...good.outputs.entries()].find(([fileName]) =>
  fileName.endsWith('.d.ts')
);
if (javascriptEntry === undefined || declarationEntry === undefined) {
  throw new Error('内存 emit 缺少 JS 或 .d.ts');
}

const [, javascriptOutput] = javascriptEntry;
const [, declarationOutput] = declarationEntry;
// JS 里出现 `value * 3`：证明 transformer 改写真的影响了 emit 出来的运行时代码。
assert.match(javascriptOutput, /return value \* 3/u);
// .d.ts 仍然保留 `scale(value: number): number`：声明 emit 来自 Checker 的公共类型，与 JS 改写无关。
assert.match(declarationOutput, /scale\(value: number\): number/u);
// 声明里也保留了 as const 带来的字面量类型（'fast'），说明类型契约没被 transformer 触动。
assert.match(declarationOutput, /readonly mode: "fast"/u);

// 直接执行内存 JS，证明 transformer 改变的是运行时语义。
// 把 JS 源码编码成 data URL，用动态 import 在内存里加载（无需落盘到临时文件）。
const dataUrl = `data:text/javascript;base64,${Buffer.from(javascriptOutput).toString('base64')}`;
const emittedModule: unknown = await import(dataUrl);
assert.equal(typeof emittedModule, 'object');
assert.notEqual(emittedModule, null);

// 用 Reflect 取出 scale 函数并直接调用：transformer 把 * 2 改成了 * 3，scale(4) 应返回 12（而非 8）。
const emittedScale = Reflect.get(emittedModule as object, 'scale');
assert.equal(typeof emittedScale, 'function');
assert.equal(Reflect.apply(emittedScale as Function, undefined, [4]), 12);

// ------------------------------------------------------------
// 7. BuilderProgram：source version 驱动增量受影响文件
// ------------------------------------------------------------
// 增量编译的核心：SourceFile 暴露一个 version 字段，BuilderProgram 据此判断哪些文件需要重算。
// 改一个文件，只有它和“依赖它类型”的文件进入受影响集合，而不是整个 Program 重新分析。

// 增量编译需要额外选项：incremental 开启增量模式，tsBuildInfoFile 指定状态文件路径（这里只取路径语义）。
const incrementalOptions: ts.CompilerOptions = {
  ...compilerOptions,
  incremental: true,
  tsBuildInfoFile: path.resolve('virtual/compiler-lab.tsbuildinfo'),
};

// 三个可变状态：源文本、版本号、产物 Map。后续修改它们来模拟“编辑器里改了一个文件”。
let incrementalText = goodSourceText;
let incrementalVersion = 0;
const incrementalOutputs = new Map<string, string>();
// createIncrementalCompilerHost：构造支持增量读取的 host（带 readDirectory 等 builder 需要的能力）。
const incrementalHost = ts.createIncrementalCompilerHost(
  incrementalOptions,
  ts.sys,
);
// 同样提前算好规范键 + bind 出 base 方法，方便覆写。
const incrementalVirtualKey = canonical(virtualFileName);
const incrementalBaseFileExists = incrementalHost.fileExists.bind(incrementalHost);
const incrementalBaseReadFile = incrementalHost.readFile.bind(incrementalHost);
const incrementalBaseGetSourceFile = incrementalHost.getSourceFile.bind(incrementalHost);

// 用直接覆写 host 方法（而非 spread）的方式接管文件系统：
// 原因是 createIncrementalCompilerHost 返回的对象需要保持其他方法引用同一实例，避免丢失增量状态。
incrementalHost.fileExists = (fileName) =>
  canonical(fileName) === incrementalVirtualKey ||
  incrementalBaseFileExists(fileName);
incrementalHost.readFile = (fileName) =>
  canonical(fileName) === incrementalVirtualKey
    ? incrementalText
    : incrementalBaseReadFile(fileName);
incrementalHost.getSourceFile = (
  fileName,
  languageVersion,
  onError,
  shouldCreateNewSourceFile,
) => {
  if (canonical(fileName) !== incrementalVirtualKey) {
    return incrementalBaseGetSourceFile(
      fileName,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    );
  }

  // 每次都按当前 incrementalText 重新构造 SourceFile。
  const sourceFile = ts.createSourceFile(
    fileName,
    incrementalText,
    languageVersion,
    true,
    ts.ScriptKind.TS,
  );
  // BuilderProgram 在运行时读取 version，但公共 SourceFile 接口没有暴露该字段；
  // 这是 Compiler API 稳定边界不完整的一个具体例子，断言集中在 host adapter。
  // 用类型断言强行挂上 version：BuilderProgram 会读它来判断“源文件是否变化”，决定是否重算。
  (sourceFile as ts.SourceFile & { version: string }).version = String(
    incrementalVersion,
  );
  return sourceFile;
};
incrementalHost.writeFile = (fileName, text) => {
  incrementalOutputs.set(canonical(fileName), text);
};

// createEmitAndSemanticDiagnosticsBuilderProgram：创建一个“带着上次状态”的增量 builder。
// 第 4 个参数传入“上一次的 builder program”作为状态来源；首次调用时传 undefined。
const firstBuilder = ts.createEmitAndSemanticDiagnosticsBuilderProgram(
  [virtualFileName],
  incrementalOptions,
  incrementalHost,
);
assert.deepEqual(firstBuilder.getSemanticDiagnostics(), []);
// 因为 SourceFile.version 是 Compiler API 的“运行时内部约定”，公共类型里没有，
// 用一个工具函数加类型断言把它读出来，便于断言。
function sourceVersion(sourceFile: ts.SourceFile | undefined): string | undefined {
  return (sourceFile as (ts.SourceFile & { version?: string }) | undefined)
    ?.version;
}

// 首次构造时 sourceFile.version === '0'（来自 incrementalVersion 初值）。
const firstVersion = sourceVersion(
  firstBuilder.getProgram().getSourceFile(virtualFileName),
);
assert.equal(firstVersion, '0');

// 模拟“用户改了文件”：追加一行有类型错误的代码，并把 version +1。
incrementalText = `${goodSourceText}\nexport const broken: number = "wrong";\n`;
incrementalVersion += 1;

// 第二次构造 builder 时传入 firstBuilder 作为“上一次状态”，让 builder 复用之前的类型图。
const secondBuilder = ts.createEmitAndSemanticDiagnosticsBuilderProgram(
  [virtualFileName],
  incrementalOptions,
  incrementalHost,
  firstBuilder,
);

// 通过不断调用 getSemanticDiagnosticsOfNextAffectedFile 把“受影响文件”逐个拉出来，
// 直到返回 undefined 表示受影响队列已耗尽。
const affectedFiles: string[] = [];
const affectedDiagnostics: ts.Diagnostic[] = [];
while (true) {
  const affected = secondBuilder.getSemanticDiagnosticsOfNextAffectedFile();
  if (affected === undefined) break;

  // affected.affected 通常是 SourceFile（带 fileName）；用 'fileName' in 收窄后取路径。
  if ('fileName' in affected.affected) {
    affectedFiles.push(canonical(affected.affected.fileName));
  }
  // affected.result 是该受影响文件的语义诊断，累加到总集合里供后续断言。
  affectedDiagnostics.push(...affected.result);
}

// 因为根文件的 version 变了，它必然出现在受影响集合里。
assert.ok(affectedFiles.includes(incrementalVirtualKey));
// 新追加的赋值错误码 2322 也能被 builder 检测到：增量语义没有漏报。
assert.ok(affectedDiagnostics.some((diagnostic) => diagnostic.code === 2322));
// 第二次 builder 看到的 sourceFile.version 已经是 '1'：证明 host 注入的新版本号被读到。
assert.equal(
  sourceVersion(secondBuilder.getProgram().getSourceFile(virtualFileName)),
  '1',
);

console.log('=== 第 20 课：Compiler API 内存实验室 ===');
console.log({
  scannedTokens,
  astNodeCount,
  boxDeclarations: boxSymbol.declarations?.length,
  configType,
  flowTypes: {
    inside: checker.typeToString(checker.getTypeAtLocation(insideNode.name)),
    after: checker.typeToString(checker.getTypeAtLocation(afterNode.name)),
  },
  semanticErrorCodes: semanticDiagnostics.map((diagnostic) => diagnostic.code),
  emittedFiles: [...good.outputs.keys()].map((fileName) => path.basename(fileName)),
  transformedScale: Reflect.apply(emittedScale as Function, undefined, [4]),
  affectedFiles: affectedFiles.map((fileName) => path.basename(fileName)),
  affectedErrorCodes: affectedDiagnostics.map((diagnostic) => diagnostic.code),
});

export {};
