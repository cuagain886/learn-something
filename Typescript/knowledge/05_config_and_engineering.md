# 05 · TypeScript 工程化配置与迁移策略 ⭐⭐

> tsconfig.json 是 TS 项目的"控制中心"。理解每个选项的作用，是写生产级 TS 代码的基础。

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

这一个选项开启 7 个子选项。没有理由不开——新项目默认就是开的，老项目也应该作为目标。

| 子选项（strict:true 开启） | 默认值 | 作用 |
|---|---|---|
| `strictNullChecks` | true | null/undefined 不能随意赋值给其他类型 |
| `noImplicitAny` | true | 推断不出类型时不能偷偷用 any |
| `strictFunctionTypes` | true | 函数参数正确逆变检查 |
| `strictBindCallApply` | true | bind/call/apply 类型检查 |
| `strictPropertyInitialization` | true | 类属性必须初始化 |
| `noImplicitThis` | true | this 类型不能是隐式 any |
| `alwaysStrict` | true | 输出 ES 严格模式 |

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

这是 TS 5.x 中最关键也最容易配错的选项：

| 值 | 适用场景 | 行为 |
|---|---------|------|
| `node16` / `nodenext` | Node.js 项目 | 支持 package.json 的 `"type"`、`.mjs`/`.cjs` |
| `bundler` | Vite/Webpack 打包的前端项目 | 像打包器一样解析（不要求显式扩展名） |
| `node` | 老式 Node.js 项目（CommonJS） | 自动找 `index.js`、不加扩展名 |

**2024+ 的建议**：
- 新 Node.js 项目 → `moduleResolution: "NodeNext"`
- Vite/Webpack 前端项目 → `moduleResolution: "bundler"`
- 库（要发布到 npm）→ 看下游消费者用什么

---

## 2. 模块系统与输出

### 2.1 ESM vs CommonJS 输出

```json
// 输出 ESM（推荐，2024+ 标准）
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

**发布 npm 包的典型配置**：

```json
// package.json
{
    "main": "./dist/index.js",     // CommonJS 消费者用
    "module": "./dist/index.mjs",  // ESM 消费者用
    "types": "./dist/index.d.ts",  // 类型定义入口
    "exports": {
        ".": {
            "types": "./dist/index.d.ts",
            "import": "./dist/index.mjs",
            "require": "./dist/index.js"
        }
    }
}
```

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
1. 安装 TypeScript + 写 tsconfig.json（strict: false 起步）
   ↓
2. .js 重命名为 .ts（TS = JS 的超集，大部分代码编译通过）
   ↓
3. 修复明显的类型错误（通常是 JSON/API 数据的类型不匹配）
   ↓
4. 逐个文件添加类型注解（从"高频使用"的模块开始）
   ↓
5. 打开 strict: true（修复所有剩余的类型错误）
   ↓
6. 清理 any：把逃生舱替换为精确类型
```

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
| `skipLibCheck: true` | 不检查 `.d.ts` 文件 | 可能错过库的类型错误（少见） |
| `incremental: true` | 增量编译 | 多一个 `.tsbuildinfo` 文件 |
| `isolatedModules: true` | 确保代码可被独立编译（打包器需要） | 禁止某些 TS 特有语法 |

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

## 7. ESLint + Prettier 配合 TypeScript

```bash
npm install -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin prettier
```

**关键规则建议**：

```json
// .eslintrc.json
{
    "parser": "@typescript-eslint/parser",
    "plugins": ["@typescript-eslint"],
    "rules": {
        "@typescript-eslint/no-explicit-any": "warn",     // 告警 any 的使用
        "@typescript-eslint/no-unused-vars": "error",      // 未用变量
        "@typescript-eslint/consistent-type-imports": "error", // import type 一致性
        "@typescript-eslint/array-type": ["error", { "default": "generic" }] // 统一数组写法
    }
}
```

---

## 8. 检查清单：部署到生产前

- [ ] `strict: true` —— 所有严格检查已通过
- [ ] `noUnusedLocals: true` —— 无未使用的局部变量
- [ ] `noUnusedParameters: true` —— 无未使用的参数
- [ ] `noFallthroughCasesInSwitch: true` —— switch 无意外穿透
- [ ] `skipLibCheck: true` —— 不需要的 .d.ts 不检查
- [ ] `sourceMap: true` 或 false（生产通常 false，调试保留）
- [ ] `.gitignore` 包含 `dist/`, `*.tsbuildinfo`
- [ ] CI 中运行 `tsc --noEmit`（只检查不输出）

---

## 一句话总结

`tsconfig.json` 不是"设好就忘了"的配置文件。理解 `strict`/`target`/`lib`/`module`/`moduleResolution` 这五个核心选项的作用和相互作用，是 TS 工程化的基础。
