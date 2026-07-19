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

import assert from 'node:assert/strict';
import path from 'node:path';
import * as ts from 'typescript';

// ------------------------------------------------------------
// 1. Scanner：字符流 -> token；不理解声明、作用域或类型
// ------------------------------------------------------------

const scanText = 'const answer: number = 42;';
const scanner = ts.createScanner(
  ts.ScriptTarget.ES2022,
  false,
  ts.LanguageVariant.Standard,
  scanText,
);

const scannedTokens: Array<{ readonly kind: string; readonly text: string }> = [];
for (
  let token = scanner.scan();
  token !== ts.SyntaxKind.EndOfFileToken;
  token = scanner.scan()
) {
  if (
    token === ts.SyntaxKind.WhitespaceTrivia ||
    token === ts.SyntaxKind.NewLineTrivia
  ) {
    continue;
  }
  scannedTokens.push({
    kind: ts.SyntaxKind[token],
    text: scanner.getTokenText(),
  });
}

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

const parsedSource = ts.createSourceFile(
  'scanner-demo.ts',
  scanText,
  ts.ScriptTarget.ES2022,
  true,
  ts.ScriptKind.TS,
);

let astNodeCount = 0;
function countNodes(node: ts.Node): void {
  astNodeCount += 1;
  ts.forEachChild(node, countNodes);
}
countNodes(parsedSource);

assert.equal(parsedSource.statements.length, 1);
const firstParsedStatement = parsedSource.statements[0];
assert.ok(
  firstParsedStatement !== undefined &&
    ts.isVariableStatement(firstParsedStatement),
);
assert.ok(astNodeCount > 5);

// ------------------------------------------------------------
// 3. 内存 CompilerHost：真实默认 lib + 虚拟根文件 + 内存输出
// ------------------------------------------------------------

const virtualFileName = path.resolve('virtual/compiler-lab.ts');

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  declaration: true,
  noEmitOnError: true,
  skipLibCheck: true,
};

function canonical(fileName: string): string {
  const resolved = path.resolve(fileName).replaceAll('\\', '/');
  return ts.sys.useCaseSensitiveFileNames ? resolved : resolved.toLowerCase();
}

interface VirtualCompilation {
  readonly program: ts.Program;
  readonly host: ts.CompilerHost;
  readonly outputs: Map<string, string>;
  readonly sourceFile: ts.SourceFile;
}

function createVirtualCompilation(sourceText: string): VirtualCompilation {
  const baseHost = ts.createCompilerHost(compilerOptions, true);
  const baseFileExists = baseHost.fileExists.bind(baseHost);
  const baseReadFile = baseHost.readFile.bind(baseHost);
  const baseGetSourceFile = baseHost.getSourceFile.bind(baseHost);
  const virtualKey = canonical(virtualFileName);
  const outputs = new Map<string, string>();

  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists(fileName) {
      return canonical(fileName) === virtualKey || baseFileExists(fileName);
    },
    readFile(fileName) {
      return canonical(fileName) === virtualKey
        ? sourceText
        : baseReadFile(fileName);
    },
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
      return baseGetSourceFile(
        fileName,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      );
    },
    writeFile(fileName, text) {
      outputs.set(canonical(fileName), text);
    },
  };

  const program = ts.createProgram({
    rootNames: [virtualFileName],
    options: compilerOptions,
    host,
  });
  const sourceFile = program.getSourceFile(virtualFileName);
  if (sourceFile === undefined) throw new Error('虚拟 SourceFile 未进入 Program');

  return { program, host, outputs, sourceFile };
}

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

const good = createVirtualCompilation(goodSourceText);
const checker = good.program.getTypeChecker();

assert.deepEqual(good.program.getSyntacticDiagnostics(), []);
assert.deepEqual(good.program.getSemanticDiagnostics(), []);

// ------------------------------------------------------------
// 4. Node、Symbol、Type 与 flow type 是不同对象
// ------------------------------------------------------------

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

function findInterfaces(sourceFile: ts.SourceFile, name: string): ts.InterfaceDeclaration[] {
  return sourceFile.statements.filter(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  );
}

const boxDeclarations = findInterfaces(good.sourceFile, 'Box');
assert.equal(boxDeclarations.length, 2);

const firstBoxName = boxDeclarations[0]?.name;
if (firstBoxName === undefined) throw new Error('缺少 Box 声明');
const boxSymbol = checker.getSymbolAtLocation(firstBoxName);
if (boxSymbol === undefined) throw new Error('Binder 未创建 Box Symbol');

// 两个 AST InterfaceDeclaration 被 Binder 合并到一个 Symbol。
assert.equal(boxSymbol.declarations?.length, 2);
assert.ok((boxSymbol.flags & ts.SymbolFlags.Interface) !== 0);
assert.equal(checker.typeToString(checker.getDeclaredTypeOfSymbol(boxSymbol)), 'Box');

const configNode = findVariable(good.sourceFile, 'config');
const configType = checker.typeToString(checker.getTypeAtLocation(configNode.name));
assert.match(configType, /readonly mode: "fast"/u);
assert.match(configType, /readonly retries: 3/u);

const insideNode = findVariable(good.sourceFile, 'insideStringBranch');
const afterNode = findVariable(good.sourceFile, 'afterStringBranch');
assert.equal(
  checker.typeToString(checker.getTypeAtLocation(insideNode.name)),
  'string',
);
assert.equal(
  checker.typeToString(checker.getTypeAtLocation(afterNode.name)),
  'number',
);

// 参数声明本身仍是 union；flow type 只属于具体引用位置/派生声明。
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
assert.equal(
  checker.typeToString(checker.getTypeAtLocation(inputParameter.name)),
  'string | number',
);

// ------------------------------------------------------------
// 5. 语法诊断、语义诊断与 transpileModule 的边界
// ------------------------------------------------------------

const syntacticallyBroken = createVirtualCompilation('const value = ;');
assert.ok(syntacticallyBroken.program.getSyntacticDiagnostics().length > 0);

const semanticallyBroken = createVirtualCompilation(`
export const value: number = "not a number";
`);
const semanticDiagnostics = semanticallyBroken.program.getSemanticDiagnostics();
assert.ok(semanticDiagnostics.some((diagnostic) => diagnostic.code === 2322));

const skippedEmit = semanticallyBroken.program.emit();
assert.equal(skippedEmit.emitSkipped, true);
assert.equal(semanticallyBroken.outputs.size, 0);

const transpiled = ts.transpileModule(
  'const value: number = "not a number"; export { value };',
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
    reportDiagnostics: true,
  },
);

// transpileModule 做单文件语法转换，不创建完整 Program/Checker，因此不会报告 2322。
assert.equal(
  transpiled.diagnostics?.some((diagnostic) => diagnostic.code === 2322),
  false,
);
assert.match(transpiled.outputText, /const value = "not a number"/u);

// ------------------------------------------------------------
// 6. Transformer + 内存 emit：JS 树可改写，.d.ts 仍来自类型契约
// ------------------------------------------------------------

const multiplyByThree: ts.TransformerFactory<ts.SourceFile> = (context) => {
  const visit = (node: ts.Node): ts.VisitResult<ts.Node> => {
    if (
      ts.isNumericLiteral(node) &&
      node.text === '2' &&
      ts.isBinaryExpression(node.parent) &&
      node.parent.operatorToken.kind === ts.SyntaxKind.AsteriskToken
    ) {
      return context.factory.createNumericLiteral(3);
    }
    return ts.visitEachChild(node, visit, context);
  };
  return (sourceFile) => ts.visitNode(sourceFile, visit) as ts.SourceFile;
};

const goodEmit = good.program.emit(
  undefined,
  good.host.writeFile,
  undefined,
  false,
  { before: [multiplyByThree] },
);
assert.equal(goodEmit.emitSkipped, false);
assert.deepEqual(goodEmit.diagnostics, []);

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
assert.match(javascriptOutput, /return value \* 3/u);
assert.match(declarationOutput, /scale\(value: number\): number/u);
assert.match(declarationOutput, /readonly mode: "fast"/u);

// 直接执行内存 JS，证明 transformer 改变的是运行时语义。
const dataUrl = `data:text/javascript;base64,${Buffer.from(javascriptOutput).toString('base64')}`;
const emittedModule: unknown = await import(dataUrl);
assert.equal(typeof emittedModule, 'object');
assert.notEqual(emittedModule, null);

const emittedScale = Reflect.get(emittedModule as object, 'scale');
assert.equal(typeof emittedScale, 'function');
assert.equal(Reflect.apply(emittedScale as Function, undefined, [4]), 12);

// ------------------------------------------------------------
// 7. BuilderProgram：source version 驱动增量受影响文件
// ------------------------------------------------------------

const incrementalOptions: ts.CompilerOptions = {
  ...compilerOptions,
  incremental: true,
  tsBuildInfoFile: path.resolve('virtual/compiler-lab.tsbuildinfo'),
};

let incrementalText = goodSourceText;
let incrementalVersion = 0;
const incrementalOutputs = new Map<string, string>();
const incrementalHost = ts.createIncrementalCompilerHost(
  incrementalOptions,
  ts.sys,
);
const incrementalVirtualKey = canonical(virtualFileName);
const incrementalBaseFileExists = incrementalHost.fileExists.bind(incrementalHost);
const incrementalBaseReadFile = incrementalHost.readFile.bind(incrementalHost);
const incrementalBaseGetSourceFile = incrementalHost.getSourceFile.bind(incrementalHost);

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

  const sourceFile = ts.createSourceFile(
    fileName,
    incrementalText,
    languageVersion,
    true,
    ts.ScriptKind.TS,
  );
  // BuilderProgram 在运行时读取 version，但公共 SourceFile 接口没有暴露该字段；
  // 这是 Compiler API 稳定边界不完整的一个具体例子，断言集中在 host adapter。
  (sourceFile as ts.SourceFile & { version: string }).version = String(
    incrementalVersion,
  );
  return sourceFile;
};
incrementalHost.writeFile = (fileName, text) => {
  incrementalOutputs.set(canonical(fileName), text);
};

const firstBuilder = ts.createEmitAndSemanticDiagnosticsBuilderProgram(
  [virtualFileName],
  incrementalOptions,
  incrementalHost,
);
assert.deepEqual(firstBuilder.getSemanticDiagnostics(), []);
function sourceVersion(sourceFile: ts.SourceFile | undefined): string | undefined {
  return (sourceFile as (ts.SourceFile & { version?: string }) | undefined)
    ?.version;
}

const firstVersion = sourceVersion(
  firstBuilder.getProgram().getSourceFile(virtualFileName),
);
assert.equal(firstVersion, '0');

incrementalText = `${goodSourceText}\nexport const broken: number = "wrong";\n`;
incrementalVersion += 1;

const secondBuilder = ts.createEmitAndSemanticDiagnosticsBuilderProgram(
  [virtualFileName],
  incrementalOptions,
  incrementalHost,
  firstBuilder,
);

const affectedFiles: string[] = [];
const affectedDiagnostics: ts.Diagnostic[] = [];
while (true) {
  const affected = secondBuilder.getSemanticDiagnosticsOfNextAffectedFile();
  if (affected === undefined) break;

  if ('fileName' in affected.affected) {
    affectedFiles.push(canonical(affected.affected.fileName));
  }
  affectedDiagnostics.push(...affected.result);
}

assert.ok(affectedFiles.includes(incrementalVirtualKey));
assert.ok(affectedDiagnostics.some((diagnostic) => diagnostic.code === 2322));
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
