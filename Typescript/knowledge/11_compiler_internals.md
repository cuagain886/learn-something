# 11 · TypeScript 编译器与类型检查器底层原理 ⭐⭐⭐

> 真正理解 TypeScript，不能只把 `tsc` 看成“删掉类型的 Babel”。它同时是解析器、符号绑定器、类型关系求解器、控制流分析器、代码生成器和语言服务内核。

配套实验：[第 20 课 Compiler API](../code/src/20-compiler-api.ts)。建议一边运行 `npm run lesson:compiler`，一边阅读本文。

---

## 1. 总体流水线：阶段分离，但会惰性协作

```text
源文件文本
  │
  ├─ Scanner：字符 → Token
  │
  ├─ Parser：Token → AST / SourceFile
  │
  ├─ Binder：声明与作用域 → Symbol / 符号表
  │
  ├─ Checker：Symbol + AST + 控制流 → Type / Diagnostic
  │
  ├─ Transformer：按 target/module 等选项转换 AST
  │
  └─ Emitter：输出 .js / .d.ts / .map
```

这张图是概念顺序，不代表每个阶段都会一次性遍历并计算全部结果。类型检查成本很高，Checker 大量采用按需计算和缓存；编辑器里的语言服务也会复用未变化的语法树与检查结果。

理解阶段分离可以解释很多现象：

- `transpileModule` 能把单文件 TS 转成 JS，却不能完成跨文件语义检查。
- 默认情况下即使有类型错误也可能 emit；是否阻止由 `noEmitOnError` 决定。
- 语法错误、配置错误和语义错误来自不同诊断集合。
- 代码能生成 JS，不代表类型正确；类型正确也不代表外部 JSON 正确。

---

## 2. Scanner：最长匹配、上下文与 Trivia

Scanner 负责把字符流切成 `SyntaxKind` token，例如：

```typescript
const answer = value?.items[0] ?? 42;
```

会产生 `ConstKeyword`、`Identifier`、`EqualsToken`、`QuestionDotToken`、标识符、方括号、`QuestionQuestionToken` 等 token。空格、换行和注释属于 trivia；是否跳过取决于 Scanner 使用方式。

Scanner 不负责回答 `value` 是什么类型，也不知道 `items[0]` 是否安全。它只建立词法边界。某些 token 的解释依赖语法上下文，因此 Parser 会驱动 Scanner，并在必要时重新扫描。例如 `/` 可能是除法，也可能开始正则字面量。

底层启示：

- 语法高亮可以只做词法扫描，因此比完整类型检查快。
- 自动格式化与源码映射必须保留位置和 trivia 信息。
- 一个字符错误可能改变后续 token 划分，引发大量级联语法诊断。

---

## 3. Parser：AST 描述“写了什么”，不描述“意味着什么”

Parser 根据语法产生以 `SourceFile` 为根的 AST。每个节点包含：

- `kind`：`FunctionDeclaration`、`CallExpression` 等 `SyntaxKind`。
- `pos/end`：在源码文本中的位置范围。
- 子节点：参数、类型参数、函数体、表达式等。
- 可选 `parent`：创建 SourceFile 时可要求建立父指针。

```typescript
const user = { id: 'u1' };
```

AST 能告诉你这是变量语句、变量名是 `user`、初始化器是对象字面量；但 `user` 最终是 `{ id: string }` 还是 `{ readonly id: 'u1' }`，要由上下文、断言和 Checker 决定。

### Node 不等于 Type

同一个类型可能没有对应的类型语法节点：

```typescript
const point = { x: 1, y: 2 };
```

源码没有写 `{ x: number; y: number }` 类型节点，但 Checker 会构造出这个对象类型。反过来，一个类型节点也可能在不同泛型实例化环境中产生不同语义类型。

### AST 遍历原则

公共 Compiler API 中常用：

```typescript
ts.forEachChild(node, visit);
ts.isFunctionDeclaration(node);
checker.getTypeAtLocation(node);
```

优先使用 `ts.isXxx` 类型守卫，而不是手写 `node.kind === ...` 后到处断言。Compiler API 会跨版本演进，深度依赖未公开节点字段会增加升级成本。

---

## 4. Binder：把声明绑定成 Symbol

Parser 只产生独立语法树。Binder 遍历 AST，建立作用域、符号表和声明关系。可以把它理解为回答：

- 这个名字在哪个作用域声明？
- 标识符可能引用哪个符号？
- 多个声明是否需要合并？
- `export`、成员、局部变量分别进入哪张符号表？

```typescript
interface Request { traceId: string }
interface Request { userId?: string }
```

两个 `InterfaceDeclaration` Node 可以绑定到同一个 `Request` Symbol，Symbol 的 `declarations` 包含两个声明。这就是声明合并在底层对象模型中的基础。

### TypeScript Symbol 与 JavaScript `symbol` 无关

- 编译器 `Symbol`：一个名字在类型系统中的语义实体。
- JavaScript `symbol`：运行时原始值类型。

Binder 主要建立声明关系，不负责完成全部类型推断。这样同一套绑定结果可以被 Checker、语言服务的“转到定义”、重命名和引用查找复用。

---

## 5. Checker：从 Symbol、Node 和上下文计算 Type

`Program#getTypeChecker()` 返回 Checker。常用公共能力包括：

```typescript
checker.getSymbolAtLocation(node);
checker.getTypeAtLocation(node);
checker.getTypeOfSymbolAtLocation(symbol, node);
checker.typeToString(type);
checker.isTypeAssignableTo(source, target);
```

Checker 需要处理：

- 类型推断与上下文类型。
- 泛型约束收集、实例化和默认类型参数。
- 联合/交叉、条件类型、映射类型和模板字面量类型。
- 重载解析与最佳候选签名。
- 结构化可赋值性和方差。
- 控制流收窄。
- 可访问性、属性存在性与各种语义诊断。

### TypeFlags 是位掩码

编译器内部用 `TypeFlags`/`ObjectFlags` 等位标志快速区分联合、对象、字面量、类型参数等大类。一个值可能同时具有多个标志，所以不能总把 `flags` 当成普通枚举做单值相等判断。

### 为什么大量逻辑需要缓存

结构类型意味着任意两个复杂类型理论上都可能被比较；条件类型和泛型实例化还可能递归展开。若每次悬停、补全、诊断都从头计算，大型项目无法交互。因此 Checker 会缓存节点链接、解析结果、实例化和类型关系结果，并设置递归深度/复杂度保护。

---

## 6. 可赋值性不是简单比较类型名字

```typescript
type Source = { id: string; name: string };
type Target = { id: string };
```

检查 `Source` 是否可赋值给 `Target` 时，Checker 大致需要确认目标所要求的成员都能在来源找到，且成员类型递归兼容。真实算法还要处理：

- `any`、`unknown`、`never` 的特殊规则。
- 新鲜对象字面量的多余属性检查。
- 联合来源或联合目标。
- 调用/构造签名与重载。
- 私有/受保护类成员带来的名义化约束。
- 函数参数的逆变、方法双变兼容点。
- 条件类型是否需要延迟求值。

因此不要把 `A extends B` 机械理解为 Java 的继承。它在条件类型里使用的是 TS 的类型关系，在泛型约束里表达“候选类型必须满足 B 的结构能力”。

---

## 7. 泛型推断本质是约束收集与候选求解

```typescript
function get<T, K extends keyof T>(object: T, key: K): T[K] {
  return object[key];
}
```

调用 `get(user, 'id')` 时，Checker 不是逐字符替换 `T`：

1. 从第一个实参为 `T` 收集候选。
2. 从第二个实参为 `K` 收集字面量候选。
3. 检查 `K extends keyof T` 约束。
4. 实例化返回类型 `T[K]`。
5. 若有上下文返回类型，它也可能反向参与推断。

同一类型参数出现在多个输入位置时，候选可能互相影响。`NoInfer<T>` 的价值正是阻止某个位置贡献候选，让它只检查已经求出的 T。

### 为什么推断有时会拓宽

推断结果既要精确，也要保证值在可变位置可用。`let value = 'x'` 若永久推断为 `'x'`，后续赋 `'y'` 就会无谓失败；对象属性同理。`as const`、const 类型参数和 `satisfies` 是开发者向 Checker 提供“这里需要保留精度”的信号。

---

## 8. 控制流分析：声明类型与 Flow Type 并存

```typescript
function length(value: string | number): number {
  if (typeof value === 'string') {
    return value.length; // 当前观察类型：string
  }
  return value.toFixed().length; // 当前观察类型：number
}
```

参数的声明类型一直是 `string | number`。Checker 沿控制流图传播事实，在每个引用位置计算更窄的 flow type：

- `typeof`、`instanceof`、`in`、相等判断产生事实。
- `return`/`throw` 使后续路径排除已经结束的分支。
- 赋值会杀死或更新先前事实。
- 闭包、别名和可变属性可能让事实不再可靠。
- 可辨识联合把字段相等事实传播到整个对象分支。

控制流图不是运行时执行；它是对所有可能路径的保守静态近似。编译器无法证明时会拒绝，即使人类知道某个外部约束成立；此时应优先把约束写成类型谓词、断言函数或更清楚的状态模型。

---

## 9. 类型擦除与 Transformer/Emitter

```typescript
interface User { id: string }
const user: User = { id: 'u1' };
```

默认 JS emit 中 interface 和类型注解消失。根据 `target`，某些新语法会被转换；根据 `module`，模块语法可能被保留或改写。重要边界：

- `tsc` 不会把类型自动变成运行时验证。
- `paths` 默认不会重写输出 import。
- `declaration` 走声明 emit，输出静态契约而非实现。
- `transpileModule` 主要完成单文件语法转换，不能替代完整 Program 检查。

`enum`、类、namespace 和装饰器等可能同时影响类型空间与运行时输出，不能简单概括为“所有 TS 语法都会擦除”。

---

## 10. Program、CompilerHost 与模块图

`Program` 表示一次编译看到的完整文件集合和选项。它通过 `CompilerHost` 抽象文件系统能力：读取文件、判断大小写、写出产物、解析默认库等。

建立 Program 时不仅加载 `include` 中的根文件，还会沿 import、三斜线引用、类型包和 lib 引用扩展模块图。`program.getSourceFiles()` 因而通常远多于业务源码数量。

自定义 Host 可以实现：

- 内存编译器与在线 Playground。
- 虚拟文件系统。
- 自定义模块解析。
- 捕获 emit 结果而不写磁盘。

但自定义解析必须模拟真实运行时，否则又会制造“Checker 找得到、运行时找不到”的裂缝。

---

## 11. 增量编译与语言服务

命令行全量编译、`--watch` 和编辑器的性能目标不同：

- 全量 Program 可以一次性构建并退出。
- BuilderProgram 复用未变化文件的语义诊断/emit 信息。
- Language Service 长期驻留，需要处理每次按键后的局部更新、补全、悬停、定义跳转和重构。

公共 API 中有 `createIncrementalProgram`、BuilderProgram 和 `createLanguageService`。底层核心思想是：语法树尽量视为不可变快照；文件版本变化后替换必要部分，并复用其余图和缓存。

这也解释了为何大型项目应减少：

- 巨大联合之间的笛卡尔积式条件类型。
- 无边界递归类型。
- 数千个成员的精确模板字面量组合。
- 每个文件都导入一个改变频繁的“超级 barrel”。

类型可表达不等于类型值得表达，编辑器延迟也是 API 设计成本。

---

## 12. 诊断为何要分层看

常见诊断来源：

| 诊断 | 关注点 | 示例 |
|---|---|---|
| Options | 配置组合是否合法 | 不兼容的 `module`/`moduleResolution` |
| Syntactic | AST 能否按语法构造 | 少括号、非法 token |
| Global | 全局声明/默认库问题 | 全局类型冲突 |
| Semantic | 类型和符号关系 | 参数不兼容、属性不存在 |
| Declaration | `.d.ts` 是否能正确生成 | 公共签名引用不可命名类型 |
| Emit | 转换/写出阶段 | 输出被跳过或写入问题 |

`ts.getPreEmitDiagnostics(program)` 聚合常用的 pre-emit 诊断，但工具作者仍应理解自己需要哪一层；只想做快速语法转换时，完整语义检查可能是多余成本，发布库时声明诊断却不可缺少。

---

## 13. Compiler API 实验清单

在 `20-compiler-api.ts` 基础上尝试：

1. 修改 snippet，观察可选链、泛型和模板字面量的 token/AST。
2. 用 `checker.getTypeAtLocation` 对比同一联合变量在三个分支的位置类型。
3. 查两个合并 interface 的 Symbol，打印 `declarations` 数量和文件位置。
4. 构造两个 Type，调用 `isTypeAssignableTo` 验证方向性。
5. 使用 `ts.createPrinter` 打印某个 AST 子树。
6. 用自定义 `CompilerHost.writeFile` 把 `.d.ts` 捕获到内存。
7. 对比 `transpileModule` 与完整 `createProgram` 能发现的错误集合。

提醒：Compiler API 会随 TypeScript 版本变化；生产工具应锁定版本、测试升级，不要依赖源码中未导出的内部函数。

---

## 14. Transformer 改写 emit 树，但不会替你重新做类型证明

Program 的 Checker 已经基于原始语法树建立 Symbol/Type。`program.emit(..., { before: [...] })` 中的 transformer 可以把：

```typescript
return value * 2;
```

改写成：

```javascript
return value * 3;
```

这会真实改变 JavaScript 运行结果，但声明 emit 仍可能保持 `scale(value: number): number`。若 transformer 把表达式改成与签名不兼容的值，TypeScript 不会自动对生成树重新运行一轮完整 Checker。Transformer 作者必须自己维护语义不变量，并同时测试：

- emitted JS 文本与真实执行结果；
- `.d.ts` 是否仍描述运行时行为；
- source map 节点范围是否合理；
- 新 TS 版本的 factory/update API 是否改变。

`transpileModule` 的边界更窄：它主要做单文件语法转换，即使源码包含 `const x: number = "wrong"`，也可能正常生成 JS 而没有 2322。需要类型安全时必须建立 Program 并读取 semantic diagnostics。

---

## 15. BuilderProgram 的缓存依据是版本化语法树与依赖图

增量编译不是“缓存上次错误字符串”。BuilderProgram 需要判断：

1. 哪个 SourceFile.version 变化；
2. 它的导出签名是否变化；
3. 哪些反向依赖可能受影响；
4. 哪些 semantic diagnostics 和 emit 可以复用。

自定义内存 CompilerHost 若提供给 builder 的 SourceFile 没有稳定 version，会触碰公共类型 API 与实际 builder 契约之间的缝隙。这也是 Compiler API 版本稳定性弱于语言语法的具体例子：项目应锁定 `typescript` 版本，并把 host/transformer 当成需要升级测试的基础设施。

[第 20 课内存实验室](../code/src/20-compiler-api.ts) 已实际验证 Scanner token、合并 interface 的 Symbol、flow type、2322 semantic diagnostic、内存 JS/.d.ts emit、运行 transformer 产物，以及 version 0 → 1 后的 affected-file diagnostics。

官方参考：[Using the Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)。

---

## 一句话总结

TypeScript 的核心模型是 `Node → Symbol → Type`：Parser 保存语法，Binder 建立名字与声明，Checker 结合结构关系、泛型约束和控制流按需计算类型，最后 Transformer/Emitter 处理运行时代码。理解这条链路，很多“奇怪推断”都会变成可解释的工程行为。
