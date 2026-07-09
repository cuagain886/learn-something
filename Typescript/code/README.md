# TypeScript 全面学习项目

一套循序渐进、带详细中文注释的 TypeScript 示例。每个文件都可独立运行，
按编号从头学到尾，即可系统掌握 TS 的核心语法与类型系统。

> 适合「会其它语言、想系统学 TS」的同学：注释会简要标注 JS 特有写法，
> 重点放在 TypeScript 的**类型系统**。

---

## 环境要求

- [Node.js](https://nodejs.org/) 18 以上（本项目用 v24 测试通过）
- npm（随 Node 安装）

## 安装

```bash
npm install
```

会安装三个开发依赖：

| 依赖 | 作用 |
| --- | --- |
| `typescript` | TS 编译器 `tsc`，负责类型检查与编译 |
| `tsx` | 直接运行 `.ts` 文件，免去手动编译（底层用 esbuild） |
| `@types/node` | 给 `console` / `setTimeout` 等 Node 全局 API 提供类型 |

## 如何运行

```bash
# 运行某一节示例，看输出（推荐这样逐个学习）
npx tsx src/01-basic-types.ts

# 只做类型检查、不产出文件（验证全部示例类型正确）
npm run typecheck

# 编译全部到 dist/ 目录
npm run build

# 快捷方式：运行第 01 课
npm start
```

> 学习时建议：**读注释 → 运行看输出 → 自己改两行再运行**，效果最好。
> 文件里被注释掉的「❌ 错误示例」可以试着取消注释，亲眼看看编译器如何报错。

---

## 学习顺序（编号即顺序）

### 第一阶段 · 基础
1. [01-basic-types.ts](src/01-basic-types.ts) — 基础类型：string/number/boolean/bigint、数组、元组、枚举、any/unknown/void/never、字面量类型
2. [02-variables-inference.ts](src/02-variables-inference.ts) — let/const、类型推断、`as const`、类型断言、非空断言 `!`

### 第二阶段 · 函数与结构类型
3. [03-functions.ts](src/03-functions.ts) — 函数类型、可选/默认/剩余参数、函数重载、`this` 类型
4. [04-interfaces.ts](src/04-interfaces.ts) — 接口、可选/只读属性、索引签名、接口继承、声明合并、结构化类型
5. [05-type-aliases-union.ts](src/05-type-aliases-union.ts) — `type` 别名、联合类型 `|`、交叉类型 `&`、`interface` vs `type`

### 第三阶段 · 面向对象
6. [06-classes.ts](src/06-classes.ts) — 类、访问修饰符、参数属性、static、继承、抽象类、实现接口、`#` 私有字段

### 第四阶段 · 进阶类型（核心）
7. [07-generics.ts](src/07-generics.ts) — 泛型函数/接口/类、泛型约束 `extends`、默认泛型、`keyof` 取属性
8. [08-type-narrowing.ts](src/08-type-narrowing.ts) — 类型守卫（typeof/instanceof/in）、类型谓词、可辨识联合、穷尽检查
9. [09-advanced-types.ts](src/09-advanced-types.ts) — keyof、typeof、索引访问、映射类型、条件类型、`infer`、模板字面量类型
10. [10-utility-types.ts](src/10-utility-types.ts) — 内置工具类型 Partial/Pick/Omit/Record/ReturnType/Awaited 等

### 第五阶段 · 工程化
11. [11-modules/](src/11-modules/11-modules.ts) — 模块：命名导出/默认导出、import、`import type`、重导出
12. [12-async.ts](src/12-async.ts) — Promise、async/await、Promise.all/allSettled/race、错误处理、`Awaited`
13. [13-decorators.ts](src/13-decorators.ts) — 装饰器（TS 5+ 标准装饰器）：类/方法/字段装饰器、装饰器工厂
14. [14-declaration-files.ts](src/14-declaration-files.ts) — 声明文件 `.d.ts`：给无类型 JS 补类型、`declare global`、`declare module`

### 第六阶段 · 实战
15. [15-practice.ts](src/15-practice.ts) — 综合实战：手写一个**类型安全的事件系统**，附带 TODO 练习题与参考答案

---

## 项目结构

```
learn_ts/
├── package.json          # 依赖与脚本
├── tsconfig.json         # TS 编译配置（每个选项都有中文注释）
├── README.md             # 本文件
└── src/
    ├── 01 ~ 10           # 基础到进阶类型
    ├── 11-modules/       # 模块演示（多文件）
    ├── 12 ~ 14           # 异步、装饰器、声明文件
    ├── 15-practice.ts    # 综合实战
    ├── globals.d.ts      # 全局类型声明（第 14 课配套）
    └── legacy/           # 无类型 JS + 配套 .d.ts（第 14 课配套）
```

## 小贴士

- 每个 `.ts` 文件末尾的 `export {};` 是为了让它成为「独立模块」，
  避免不同课程文件里的同名变量在全局作用域冲突（详见第 11 课「模块」）。
- 想深入查阅，官方文档非常优秀：<https://www.typescriptlang.org/docs/>
- 在线练习场（不用装环境就能试）：<https://www.typescriptlang.org/play>

祝学习愉快 🎉
