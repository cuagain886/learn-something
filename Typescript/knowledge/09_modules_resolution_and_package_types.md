# 09 · 模块解析、ESM/CJS 与类型发布 ⭐⭐⭐

> 模块问题通常不是 `import` 语法问题，而是三套系统没有对齐：TypeScript 如何找类型、构建工具如何产出代码、运行时如何加载文件。

---

## 1. 先拆开四个经常混淆的问题

```typescript
import { parse } from "pkg/subpath";
```

编译器需要依次回答：

1. 当前文件会被视为 ESM 还是 CommonJS？
2. `pkg/subpath` 在目标宿主中按什么算法解析？
3. 哪个 `.ts`/`.d.ts` 文件提供静态类型？
4. 最终运行时加载的是哪个 `.js` 文件？

`module` 主要描述模块格式与 emit；`moduleResolution` 描述如何解析模块说明符。两者必须模拟真正执行代码的宿主，而不是选一个“看起来最新”的值。

---

## 2. `moduleResolution` 应匹配宿主

| 场景 | 常见组合 | 关键约束 |
|---|---|---|
| Node 直接运行编译后 JS | `module: NodeNext` + `moduleResolution: NodeNext` | 尊重 `type`、扩展名、`exports` 条件 |
| Vite/esbuild/webpack 处理源码 | `module: Preserve` 或 `ESNext` + `moduleResolution: Bundler` | 允许打包器支持的无扩展名路径 |
| 库发布给 Node 用户 | 通常 NodeNext，并分别验证 ESM/CJS 产物 | 声明文件必须跟随对应入口 |
| 旧 CommonJS 项目 | 按现有 Node/构建链选择，避免只改 TS 配置 | `require` 与默认导入互操作需实测 |

`Bundler` 允许 `import "./foo"` 这类打包器常见写法，不代表编译后的 JS 能被 Node 原生 ESM 直接执行。类型检查通过只是说明“在所选宿主模型下可解析”。

---

## 3. NodeNext 如何判断一个文件的模块格式

在 Node 风格模式中，格式来自扩展名和最近的 `package.json`：

- `.mts` / `.mjs`：明确 ESM。
- `.cts` / `.cjs`：明确 CommonJS。
- `.ts` 编译成 `.js` 时：读取最近 `package.json` 的 `"type"`。
- `"type": "module"`：`.js` 按 ESM；缺失或 `commonjs`：按 CJS。

这意味着移动源文件到另一个包边界，可能在不改源码的情况下改变模块语义。排查时不要只看根目录 `package.json`，要找**最近的**那个。

---

## 4. 为什么源码里常写 `.js` 扩展名

Node 原生 ESM 的相对导入要求运行时可解析的完整路径：

```typescript
// src/index.ts
import { helper } from "./helper.js";
```

TypeScript 会做扩展名替换，在检查阶段用 `./helper.ts` 提供类型；emit 后仍保留 `./helper.js`，恰好指向产物。写 `./helper.ts` 通常不是正确替代，因为运行时产物未必保留 `.ts`，并且这涉及单独的导入扩展名配置与运行方式。

在 `Bundler` 模式下省略扩展名通常可行，因为打包器会重写或内联依赖。关键不是统一写法，而是源码路径必须对最终宿主诚实。

---

## 5. `paths` 不会替你改写运行时代码

```jsonc
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@app/*": ["src/*"] }
  }
}
```

```typescript
import { config } from "@app/config";
```

`paths` 告诉 TypeScript“宿主或其他工具已经支持这个映射”，默认不会把输出中的 `@app/config` 改成相对路径。若 Node、测试运行器或打包器没有配置同样别名，就会出现编辑器正常、运行时报 `MODULE_NOT_FOUND`。

检查原则：每一个 TS 解析别名，都必须在真正的运行时/打包器/测试器中有对应规则，或者由构建步骤明确重写。

---

## 6. `package.json exports` 是公共 API 防火墙

```json
{
  "name": "@acme/toolkit",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./testing": {
      "types": "./dist/testing.d.ts",
      "import": "./dist/testing.js"
    }
  },
  "types": "./dist/index.d.ts"
}
```

一旦存在 `exports`，没有显式导出的内部子路径通常不能再被消费者深度导入。好处是你可以重构 `dist/internal/*` 而不破坏公共契约。

条件对象的顺序有意义；`types` 应放在相关运行时条件之前，使 TypeScript 优先命中声明入口。仍建议保留顶层 `types`，兼容工具并让包元数据显示类型支持。

---

## 7. 双包发布的核心是入口成对，而非复制文件

同时发布 ESM 和 CJS 时，运行时代码与声明必须对应：

```json
{
  "exports": {
    ".": {
      "import": {
        "types": "./dist/esm/index.d.mts",
        "default": "./dist/esm/index.mjs"
      },
      "require": {
        "types": "./dist/cjs/index.d.cts",
        "default": "./dist/cjs/index.cjs"
      }
    }
  }
}
```

`.d.mts` 描述 ESM，`.d.cts` 描述 CJS。错误地让两种入口共享不匹配的 `.d.ts`，可能造成默认导出、`export =` 或命名导出的静态形状与运行时不一致。

双包比单一 ESM 包维护成本高。只有消费者环境确实要求两种格式时才承担这份复杂度。

---

## 8. `.d.ts` 是契约，不是实现注释

开启：

```jsonc
{
  "compilerOptions": {
    "declaration": true,
    "declarationMap": true,
    "emitDeclarationOnly": true
  }
}
```

声明 emit 会暴露所有可从导出签名触达的类型。常见失败：

- 导出函数推断出了内部类或不可命名类型。
- 返回类型包含未导出的私有模块路径。
- 条件导出指向了不存在的声明文件。
- 源码能依赖工作区路径别名，发布包中却没有该文件。

公共导出最好显式写返回类型。这既是稳定契约，也能防止一次实现重构意外改变生成的 `.d.ts`。

---

## 9. 类型导入与运行时导入要分清

```typescript
import type { User } from "./model.js";
import { createUser, type Options } from "./model.js";
```

类型导入会从 JS 输出中擦除，适合明确依赖只存在于类型空间。启用 `verbatimModuleSyntax` 后，导入/导出的保留规则更直观，也更容易在源码阶段发现 ESM/CJS 写法不匹配。

注意某些“看起来像类型”的声明有运行时值，例如 `class` 和普通 `enum`。若代码中需要构造类或读取枚举成员，就不能使用 `import type`。

---

## 10. 声明合并与模块扩充的作用域陷阱

```typescript
// express-extension.d.ts
import "express";

declare module "express-serve-static-core" {
    interface Request {
        userId?: string;
    }
}
```

模块扩充必须针对真正声明接口的模块名，且该 `.d.ts` 必须被 `include` 或导入链纳入程序。一个没有顶层 `import`/`export` 的 `.d.ts` 可能成为全局脚本，意外污染全局命名空间。

全局扩充应显式表达：

```typescript
export {};

declare global {
    namespace NodeJS {
        interface ProcessEnv {
            APP_ENV?: "development" | "production";
        }
    }
}
```

这仍不验证环境变量；它只描述预期。进程启动时仍应解析和验证。

---

## 11. 发布前必须从消费者视角测试

只在源码仓库运行 `tsc` 不够。建议：

1. 生成 tarball 或等价发布快照，确认 `files` 白名单包含 JS、声明和 source map。
2. 建立最小 ESM 消费项目，实际安装并执行。
3. 若支持 CJS，再建立最小 CJS 消费项目。
4. 测试根入口和每个公开子路径。
5. 分别验证编辑器类型、`tsc --noEmit` 和真实运行时。
6. 确认内部路径无法被意外深度导入。

`npm pack --dry-run` 能发现“本地 dist 存在但包里没发出去”这类问题。

---

## 12. 模块故障排查顺序

1. 当前文件最终是 ESM 还是 CJS？依据哪个扩展名/`package.json`？
2. `module` 与 `moduleResolution` 是否匹配实际宿主？
3. `tsc --traceResolution` 最终命中了哪个类型文件？
4. `exports` 当前走的是 `import`、`require` 还是 `types` 条件？
5. 产物中的 import specifier 是什么，运行时能否原样解析？
6. `.d.ts` 的模块格式是否和 JS 入口匹配？
7. 发布归档中是否真的包含目标文件？

---

## 13. ESM 不只是“每个文件一个对象”：链接、求值与 live binding

把 ESM 简化成 CommonJS 的 `require()` 返回对象，会漏掉三个关键阶段：

1. **解析与链接**：宿主把 specifier 规范化成 URL，建立完整依赖图，并连接 import/export binding；
2. **实例化**：为模块环境创建 binding，但此时模块体不一定已经执行；
3. **求值**：按依赖顺序执行模块体，遇到 top-level await 时整条相关依赖链可能异步暂停。

```typescript
// state.ts
export let count = 0;
export function increment() {
    count += 1;
}

// consumer.ts
import { count, increment } from "./state.js";

increment();
console.log(count); // 1，不是 import 时复制得到的 0
```

imported binding 是只读的“远程引用”：消费方不能给 `count` 重新赋值，但导出模块改变它后，所有消费方都会读到新值。`export { count } from ...` 继续转发同一个 binding，也不是生成值快照。

### 模块命名空间对象不是普通字典

```typescript
const namespace = await import("./state.js");

Object.getPrototypeOf(namespace);       // null
Reflect.set(namespace, "count", 99);   // false
```

它是 Module Namespace Exotic Object：键集合来自导出表，属性读取连接 live binding，不能像普通对象一样任意增删改。不要把 namespace import 当作可变配置容器。

### 缓存键是规范化 URL

同一个 Realm 中，同一个规范化 URL 的 ESM 通常只实例化和求值一次，因此模块级 singleton 会被所有 import 共享。Node ESM 按 URL 缓存；查询串或 fragment 不同可能形成不同模块实例：

```javascript
await import("./plugin.js?tenant=a");
await import("./plugin.js?tenant=b"); // 不同 URL，可能再次求值
```

这对 Agent 服务很重要：把当前 run、tenant、授权或可变测试状态放进模块顶层，会把本应请求隔离的数据升级为进程级共享状态。模块缓存适合不可变配置和显式 singleton，不适合隐式请求上下文。

### 循环依赖为何有时成功、有时 TDZ 失败

ESM 先链接整个图，所以循环依赖不必然报错；但 binding 创建不等于值已初始化。函数声明通常可在求值前建立可用绑定，而 `let`/`const`/`class` 在初始化前仍处于 TDZ。循环中的顶层读取很容易得到 `ReferenceError`，并且加入 top-level await 后求值顺序更难推断。

解决循环依赖的首选不是“调整 import 顺序”，而是：

- 把双方共同依赖的协议下沉到第三个无副作用模块；
- 通过参数注入运行时依赖；
- 避免模块顶层执行依赖另一侧已初始化值的副作用；
- 用依赖图工具或 `--traceResolution` 区分“解析环”与“求值环”。

---

## 14. `tsc` 不是通用发布资产流水线

开启 `declaration` 后，`tsc` 会从 `.ts` 实现生成 `.d.ts`，但这不代表它会复制所有与课程或包有关的文件：

- 未开启 `allowJs` 时，手写 `.js` 通常不进入 emit；
- 作为输入参与检查的手写 `.d.ts` 不会自动镜像到 `outDir`；
- schema、prompt、WASM、模板、证书和 package metadata 更不会凭空进入产物；
- 本地源码运行器能沿源码路径找到资产，不证明安装后的包也包含它。

真实构建应把静态资产当成显式清单：

```text
tsc emit
  + copy handwritten JS/.d.ts/schema assets
  + generate package.json exports
  + npm pack --dry-run
  + install tarball in a consumer fixture
```

第 14 课的构建脚本故意显式复制手写 JS 与声明文件，用来证明“源码能运行”和“dist 自包含”是两道不同门禁。`allowJs` 也不是自动答案：它会改变程序包含范围、JS 检查方式和声明生成结果，仍需检查最终归档。

---

## 15. 可运行证明

- [第 11 课：模块图、live binding 与命名空间对象](../code/src/11-modules/11-modules.ts)
- [live binding 模块](../code/src/11-modules/runtime-state.ts)
- [第 14 课：声明文件信任边界](../code/src/14-declaration-files.ts)
- [显式资产复制脚本](../code/scripts/copy-course-assets.mjs)

建议分别执行：

```bash
npm run lesson:modules
npm run lesson:modules:dist
npm run lesson:declarations
npm run lesson:declarations:dist
```

只有四条都通过，才能证明 checker、源码宿主、emit specifier 与 dist 资产至少在这组实验中对齐。

官方延伸阅读：

- [TypeScript Modules Reference](https://www.typescriptlang.org/docs/handbook/modules/reference)
- [TypeScript Declaration Files](https://www.typescriptlang.org/docs/handbook/declaration-files/introduction.html)
- [Node.js ECMAScript Modules](https://nodejs.org/api/esm.html)

---

## 一句话总结

TypeScript 模块配置的目标不是“让红线消失”，而是准确模拟宿主。类型入口、运行时入口、文件格式和 `exports` 条件必须成对一致，且要从实际消费者项目验证。
