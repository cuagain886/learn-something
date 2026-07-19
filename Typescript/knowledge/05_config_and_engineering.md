# 05 · TypeScript 6 工程化配置、构建边界与迁移策略 ⭐⭐⭐

> `tsconfig.json` 描述的是一个 TypeScript Program 的宿主、模块、检查和输出契约。它不是越长越专业；关键是让 checker 模型、构建工具和真实运行时对同一件事达成一致。

---

## 1. tsconfig.json 核心选项速查

### 1.1 必须是 strict: true

```json
{
    "compilerOptions": {
        "strict": true
    }
}
```

在本项目使用的 TypeScript 6.0.3 中，这个总开关控制下面 8 个严格检查项。具体集合会随 TS 版本演进，不要把它理解为永远固定的清单。新项目应直接开启，老项目也应把全量开启作为迁移目标。

| 子选项（strict:true 开启） | 默认值 | 作用 |
|---|---|---|
| `strictNullChecks` | true | null/undefined 不能随意赋值给其他类型 |
| `noImplicitAny` | true | 推断不出类型时不能偷偷用 any |
| `strictFunctionTypes` | true | 函数参数正确逆变检查 |
| `strictBindCallApply` | true | bind/call/apply 类型检查 |
| `strictPropertyInitialization` | true | 类属性必须初始化 |
| `strictBuiltinIteratorReturn` | true | 内置迭代器的 `TReturn` 使用精确类型，避免隐式 any |
| `noImplicitThis` | true | this 类型不能是隐式 any |
| `useUnknownInCatchVariables` | true | catch 变量按 unknown 而不是 any 处理 |

### 1.2 target vs lib vs module

这三个选项经常被混淆：

| 选项 | 控制什么 | 示例 | 选什么 |
|------|---------|------|--------|
| `target` | **语法转换目标**：TS 编译到哪个 ES 版本 | ES2022 | 现代 Node.js → ES2022；浏览器 → 看兼容性 |
| `lib` | **类型定义**：哪些 API 被认为存在 | ["ES2022", "DOM"] | 浏览器项目加 "DOM"；Node 项目不加 |
| `module` | **模块系统**：输出什么模块格式 | ESNext / NodeNext | 2024+：NodeNext 或 ESNext；老项目：CommonJS |

```json
// Node.js 后端项目的典型配置
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "NodeNext",
        "moduleResolution": "NodeNext",
        "lib": ["ES2022"]
    }
}

// 浏览器前端项目（Vite 的典型配置）
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "ESNext",
        "moduleResolution": "bundler",  // 告诉 TS "放心，打包器会处理模块"
        "lib": ["ES2022", "DOM", "DOM.Iterable"]
    }
}
```

### 1.3 moduleResolution —— 模块解析策略

这是现代 TypeScript 中最关键也最容易配错的选项：

| 值 | 适用场景 | 行为 |
|---|---------|------|
| `node16` / `nodenext` | Node.js 项目 | 支持 package.json 的 `"type"`、`.mjs`/`.cjs` |
| `bundler` | Vite/Webpack 打包的前端项目 | 像打包器一样解析（不要求显式扩展名） |
| `node10`（旧名 `node`） | 旧 CommonJS 解析模型 | TypeScript 6 已弃用，不支持现代 `exports`/`imports` |

**当前建议**：
- 新 Node.js 项目 → `moduleResolution: "NodeNext"`
- Vite/Webpack 前端项目 → `moduleResolution: "bundler"`
- 库（要发布到 npm）→ 看下游消费者用什么

---

## 2. 模块系统与输出

### 2.1 ESM vs CommonJS 输出

```json
// 模拟 Node 的 ESM/CJS 双格式规则；具体文件格式仍由扩展名和最近 package.json 决定
{
    "compilerOptions": {
        "module": "NodeNext",
        "moduleResolution": "NodeNext"
    }
}
// package.json 中需要 "type": "module"

// 输出 CommonJS（兼容老项目）
{
    "compilerOptions": {
        "module": "CommonJS",
        "moduleResolution": "node"
    }
}
```

### 2.2 声明文件（.d.ts）—— 给别人用的类型

```json
// 库项目的关键配置
{
    "compilerOptions": {
        "declaration": true,        // 生成 .d.ts
        "declarationMap": true,     // 生成 .d.ts.map（IDE 可以跳转到源码）
        "sourceMap": true,          // 调试时映射回 .ts
        "outDir": "./dist"
    }
}
```

**单一 ESM 包的简化入口**：

```json
// package.json
{
    "type": "module",
    "types": "./dist/index.d.ts",
    "exports": {
        ".": {
            "types": "./dist/index.d.ts",
            "import": "./dist/index.js"
        }
    }
}
```

不要照抄 `main + module + require/import` 就宣称支持双包。真正的 ESM/CJS 双发布必须让运行时入口、`.d.mts`/`.d.cts`、默认/命名导出语义逐一配对，并从两个消费者项目安装测试。详见 [09 · 模块解析与类型发布](09_modules_resolution_and_package_types.md)。

---

## 3. 项目引用（Project References）—— 大型项目必备

当项目大到需要拆分多个 tsconfig 时：

```
my-monorepo/
├── packages/
│   ├── shared/
│   │   ├── tsconfig.json    # { "composite": true }
│   │   └── src/
│   ├── server/
│   │   ├── tsconfig.json    # { "references": [{ "path": "../shared" }] }
│   │   └── src/
│   └── client/
│       ├── tsconfig.json
│       └── src/
└── tsconfig.base.json       # 共享的 compilerOptions
```

**好处**：
- `tsc --build` 按依赖顺序编译，支持增量构建
- IDE 正确解析跨包的类型
- 每个包有独立的配置

---

## 4. 从 JavaScript 迁移到 TypeScript 的策略

### 4.1 渐进式迁移六步法

```
1. 先建立 strict 基线配置；暂时无法迁移的 JS 文件用 allowJs/checkJs 或明确豁免隔离
   ↓
2. 用 allowJs + checkJs 在不改扩展名的情况下获得第一批诊断
   ↓
3. 先定义外部边界、核心领域模型和模块端口，再逐目录迁移
   ↓
4. 将动态数据改为 unknown + parser，记录而不是隐藏 any/断言债务
   ↓
5. 按错误类别开启额外严格选项，并让 CI 禁止债务增长
   ↓
6. 删除临时豁免，验证运行时、声明产物和真实消费者
```

“全局 strict:false，最后一次性打开”会让大量弱类型推断扩散到新代码。更可控的方式是让新边界一开始就严格，把旧代码放在明确的迁移项目/目录中，并持续缩小豁免范围。

### 4.2 关键技巧

**技巧 1：用 `allowJs` + `checkJs` 对 JS 文件做初步类型检查**

```json
{
    "compilerOptions": {
        "allowJs": true,
        "checkJs": true,    // 在 .js 文件中也做类型检查
        "outDir": "./dist"
    },
    "include": ["src/**/*"]
}
```

**技巧 2：用 JSDoc 给 JS 文件加类型（不需要编译步骤）**

```javascript
// @ts-check
/**
 * @param {string} name
 * @param {number} age
 * @returns {string}
 */
function greet(name, age) {
    return `${name} is ${age} years old`;
}
```

**技巧 3：用 `@ts-expect-error` 标记"我知道这行报错"**

```typescript
// @ts-expect-error - 第三方库的类型定义不完整，但运行时正确
const result = thirdPartyLib.doSomething();
```

**技巧 4：为第三方 JS 库写声明文件**

```typescript
// types/legacy-lib.d.ts
declare module "legacy-lib" {
    export function doThing(input: string): number;
    export interface Options {
        timeout: number;
        retry: boolean;
    }
}
```

---

## 5. 性能优化配置

```json
{
    "compilerOptions": {
        // 增量编译：第二次编译只检查改动的文件
        "incremental": true,
        "tsBuildInfoFile": ".tsbuildinfo",

        // 跳过对 .d.ts 的类型检查（减少编译时间）
        "skipLibCheck": true,

        // 只检查你 include 的文件
        // 不要 include 整个项目，只 include src/
    },
    "include": ["src/**/*"],
    "exclude": ["node_modules", "dist"]
}
```

| 选项 | 作用 | 代价 |
|------|------|------|
| `skipLibCheck: true` | 跳过声明文件内部的完整类型检查 | 可能错过声明文件彼此之间的错误（少见） |
| `incremental: true` | 增量编译 | 多一个 `.tsbuildinfo` 文件 |
| `isolatedModules: true` | 提醒哪些代码无法被单文件转换器安全处理 | 不是类型检查替代品，也不会改变 emit 工具 |

性能问题先用 `--extendedDiagnostics` 和 `--generateTrace` 定位。无证据地打开 `skipLibCheck`、减少 include 或拆项目，可能只是把错误移出视野。完整方法见 [20 · 类型级算法与编译性能](20_type_level_performance.md)。

---

## 6. 常用 tsconfig 模板

### 前端 React/Vue 项目

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "ESNext",
        "moduleResolution": "bundler",
        "lib": ["ES2022", "DOM", "DOM.Iterable"],
        "jsx": "react-jsx",
        "strict": true,
        "skipLibCheck": true,
        "noEmit": true,               // Vite/esbuild 负责编译，TS 只做类型检查
        "isolatedModules": true,
        "resolveJsonModule": true,
        "allowImportingTsExtensions": true
    }
}
```

### Node.js 后端项目

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "NodeNext",
        "moduleResolution": "NodeNext",
        "lib": ["ES2022"],
        "strict": true,
        "outDir": "./dist",
        "rootDir": "./src",
        "declaration": true,
        "sourceMap": true,
        "skipLibCheck": true
    },
    "include": ["src/**/*"]
}
```

### npm 库项目

```json
{
    "compilerOptions": {
        "target": "ES2020",
        "module": "NodeNext",
        "moduleResolution": "NodeNext",
        "strict": true,
        "outDir": "./dist",
        "declaration": true,
        "declarationMap": true,
        "sourceMap": true,
        "skipLibCheck": true
    },
    "include": ["src/**/*"],
    "exclude": ["src/**/*.test.ts"]
}
```

---

## 7. ESLint flat config 与类型感知规则

```bash
npm install -D eslint @eslint/js typescript typescript-eslint
```

**关键规则建议**：

```javascript
// eslint.config.mjs（当前 ESLint flat config）
// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig({
    files: ["**/*.{js,cjs,mjs,ts,cts,mts,tsx}"],
    extends: [
        js.configs.recommended,
        tseslint.configs.recommended,
        tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
        parserOptions: {
            projectService: true,
        },
    },
    rules: {
        "@typescript-eslint/consistent-type-imports": "error",
        "@typescript-eslint/no-floating-promises": "error",
        "@typescript-eslint/no-misused-promises": "error",
    },
});
```

`recommended` 只需要语法 AST；`recommendedTypeChecked` 会请求 TypeScript Program 的类型信息，能发现 floating Promise、错误 async callback 等问题，但成本更高。typed lint 的文件集合必须与 project service 能找到的 tsconfig 对齐。

Prettier 只负责格式，ESLint 负责可静态分析的代码质量，`tsc` 负责类型关系；三者职责不能互相替代。

---

## 8. 一套配置只能描述一个运行环境

同一仓库常同时包含：

- Node server：有 `process`、Buffer，没有 DOM；
- browser client：有 DOM，没有 Node 全局；
- Web Worker：有 worker globals，没有 window DOM；
- test：多 test runner 类型和测试辅助全局；
- build script：可能由 Node 原生 type stripping 或 tsx 执行；
- shared package：不应意外依赖任一宿主全局。

把 `DOM` 和 `node` 类型全塞进一个 tsconfig 会让错误代码通过：server 可以引用 document，client 可以引用 process，直到部署才失败。

推荐结构：

```text
tsconfig.base.json        共享严格检查，不声明宿主 lib/types
apps/server/tsconfig.json Node lib/types、Node 模块规则
apps/web/tsconfig.json    DOM lib、bundler 模块规则
packages/core/tsconfig.json 最小 ES lib、无宿主全局
tests/tsconfig.json       测试 runner 类型
```

通过 project references 表达依赖，而不是用一个巨型 Program 混合环境。

---

## 9. `target`、`lib`、`types` 是三个不同承诺

```text
target：允许 emit 使用什么 JavaScript 语法
lib：checker 假设运行时有哪些 ECMAScript/DOM API
types：自动引入哪些 @types 包的全局声明
```

把 `lib` 加到 ESNext 只会让 `Promise.try` 等 API 在类型上存在，不会给旧 Node 安装 polyfill。反过来，Node 类型包会声明 Node API，但不会让浏览器拥有 `process`。

需要同时验证：

1. runtime 版本真的支持 API；
2. 构建工具是否转换语法；
3. 是否提供必要 polyfill；
4. checker 使用的声明是否与真实版本一致。

### `target` 不负责所有转换

TypeScript 不承诺降级所有平台 API，也不会自动注入 polyfill。某些新 JS 语法会被转换，`fetch`、新 Array 方法、Temporal 等运行时 API则不会凭空生成。

---

## 10. strict 之外的高价值检查

本项目还开启：

| 选项 | 捕获的问题 |
|---|---|
| `noUncheckedIndexedAccess` | 数组越界、未知对象键可能得到 undefined |
| `exactOptionalPropertyTypes` | 区分属性缺失与显式 undefined |
| `noPropertyAccessFromIndexSignature` | 动态键必须用 bracket 访问，暴露契约不确定性 |
| `noImplicitOverride` | 父类重命名后，子类方法不再悄悄变成新成员 |
| `noImplicitReturns` | 控制流存在隐式 undefined 返回 |
| `noFallthroughCasesInSwitch` | switch 意外贯穿 |
| `noUncheckedSideEffectImports` | 仅副作用 import 的路径拼写错误 |

这些开关会暴露真实建模问题，不应靠全局 `as` 消音。迁移时按诊断类别修复：索引 API 返回 optional、PATCH DTO 明确缺失语义、基类契约添加 override。

---

## 11. 区分 checker、transpiler、runtime 与 linter

```text
tsc --noEmit
  完整类型检查，不执行程序

tsc
  类型检查 + JavaScript/声明 emit

tsx / esbuild / SWC
  快速转换并运行/打包；通常不替代完整 tsc checker

Node type stripping
  擦除可擦除类型语法；不读取 tsconfig、不类型检查、不降级 JS

typescript-eslint typed rules
  基于 checker 类型信息检查额外语义规则
```

因此 CI 至少要显式运行 `tsc --noEmit`（或 `tsc -b`），不能因为 dev server/tsx 能运行就认为类型已经验证。

同理，`noEmitOnError` 只影响 tsc 是否输出；若真正 emit 由另一个 transpiler 完成，它不会自动阻止打包器产物。

---

## 12. Node 原生 TypeScript type stripping 的边界

现代 Node 可以直接执行只含可擦除 TypeScript 语法的 `.ts`，但它：

- 不执行类型检查；
- 忽略 `tsconfig.json`；
- 不支持 tsconfig `paths` 转换；
- 不降级较新的 JavaScript；
- 要求运行时可解析的 `.ts` 扩展名；
- 不能处理需要生成 JS 的 enum、运行时 namespace、参数属性、import alias 等语法；
- 不支持 `.tsx`。

只运行构建脚本时可考虑：

```jsonc
{
  "compilerOptions": {
    "noEmit": true,
    "target": "ESNext",
    "module": "NodeNext",
    "rewriteRelativeImportExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true
  }
}
```

这份 tsconfig 是让 checker 约束源码与 stripping 模式兼容，Node 本身仍不会读取它。库作者也不应发布 node_modules 内的原始 TS 来要求消费者 stripping；发布标准 JS 和 `.d.ts`。

---

## 13. TypeScript 6 配置迁移要看 deprecation

TypeScript 6 已弃用旧 `moduleResolution: node/node10`，Node 应迁移到 `nodenext`，bundler/Bun 等宿主通常迁移到 `bundler`。`classic` 已不应使用。

升级策略：

1. 阅读目标版本 release notes 和 deprecation diagnostics；
2. 用 `--showConfig` 查看 extends 合并后的真实配置；
3. 用 `--traceResolution` 检查关键 import；
4. 对声明 emit 做 diff；
5. 从打包归档建立最小消费者测试；
6. 运行 Node/浏览器真实产物，不只看 IDE；
7. 重新建立 extendedDiagnostics 性能基线。

TypeScript 6 的 `stableTypeOrdering` 主要用于诊断 6→7 声明顺序差异，并可能显著拖慢检查，不应被当作长期默认开关。

---

## 14. 检查清单：部署到生产前

- [ ] `strict: true` —— 所有严格检查已通过
- [ ] `noUnusedLocals: true` —— 无未使用的局部变量
- [ ] `noUnusedParameters: true` —— 无未使用的参数
- [ ] `noFallthroughCasesInSwitch: true` —— switch 无意外穿透
- [ ] `skipLibCheck` 已按项目取舍设置——开启可缩短检查时间，但不会让缺失或错误的业务类型自动安全
- [ ] source map 按部署策略处理：可私下上传错误追踪平台或随产物部署；不要因“生产”二字盲目关闭，也不要无意公开源码
- [ ] `.gitignore` 包含 `dist/`, `*.tsbuildinfo`
- [ ] CI 中运行 `tsc --noEmit`（只检查不输出）
- [ ] checker、transpiler 与 runtime 是哪三个工具已经写入工程说明
- [ ] 每个运行环境有独立 lib/types，未混入不存在的全局 API
- [ ] 模块解析模式与最终宿主一致，产物 import 可被真实 runtime 解析
- [ ] 发布归档已从最小消费者项目安装、类型检查并运行
- [ ] typed lint 文件都能被 project service 纳入正确 tsconfig
- [ ] Node stripping 场景已开启 erasableSyntaxOnly，且仍单独运行 tsc

---

## 一句话总结

`tsconfig.json` 不是"设好就忘了"的配置文件。理解 `strict`/`target`/`lib`/`module`/`moduleResolution` 这五个核心选项的作用和相互作用，是 TS 工程化的基础。
