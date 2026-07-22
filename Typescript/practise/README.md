# TypeScript 基础动手练习

一套**循序渐进、必须自己动手写**的 TypeScript 基础练习。

> 旁边的 [`../code/`](../code/README.md) 是「带详尽注释、跑给你看」的深度教程；
> 本目录是它的反面：**题目留空、由你来写**，写完立刻能自检对错。
> 看得懂 ≠ 写得出。这套练习就是逼你从「会看」走到「会写」。

---

## 怎么用（三步循环）

```
读题 → 写代码 → 运行自检
```

1. **读题**：打开某个练习目录的 `practice.ts`，文件顶部的注释就是题目（含学习目标、⚠️ 提示）。
2. **写代码**：把代码里所有 `// TODO` 处替换成你的实现/注解。
3. **运行自检**：每个文件底部都自带「自检区」，运行后看到 ✅ 就是通过。

### 安装（仅一次）

```bash
cd Typescript/practise
npm install
```

会装三个开发依赖：`typescript`（类型检查）、`tsx`（直接运行 .ts）、`@types/node`（Node API 类型）。

### 运行方式

```bash
# 运行某一题的「你写的版本」，看自检是否通过（最常用）
npx tsx 01_basic_types/practice.ts

# 对照参考答案运行一遍（卡住时看 solution.ts 怎么写的）
npx tsx 01_basic_types/solution.ts

# 一次性把 12 套参考答案都跑一遍，确认环境 OK
npm run verify
```

### 两种自检方式

练习分两类，自检方式不同：

| 类型 | 怎么知道做对了 | 适用练习 |
| --- | --- | --- |
| **运行时题** | 文件底部 `assert(...)`；运行后打印 ✅ 或抛错 | 03、04、05、06、07、08、09、10、11 |
| **纯类型题** | 文件里 `Expect<Equal<…>>` / `@ts-expect-error`；该行不再报类型错误（用 `npm run check` 或 IDE） | 01、02、12 |

- 运行时题：占位实现会让 assert 失败，改对后变绿。
- 纯类型题（01、02、12）：**故意**用 `Expect<Equal<A, B>>` 或 `@ts-expect-error` 做编译期断言。没做对时，对应行会报类型错误，这是正常的「红 → 绿」反馈。
  - 看 IDE 红波浪线，或运行 `npm run check`（= `tsc --noEmit`）看哪几行报错。
  - ⚠️ **未做完的练习会让 `npm run check` 报错，这是设计如此**，不是 bug。做完一题，该题的错误就消失。
- 混合题（03、04、09、10）：既有运行时 ✅，也含类型断言；两种自检都用上最稳。
  - 看 IDE 红波浪线，或运行 `npm run check`（= `tsc --noEmit`）看哪几行报错。
  - ⚠️ **未做完的练习会让 `npm run check` 报错，这是设计如此**，不是 bug。做完一题，该题的错误就消失。

---

## 学习路线（编号即顺序，建议从 01 做到 12）

| # | 目录 | 主题 | 你会练到 |
| --- | --- | --- | --- |
| 01 | [`01_basic_types/`](01_basic_types/practice.ts) | 基础类型注解 | 原始类型 / bigint / 只读数组 / 元组 / 只读元组 / 只读对象 |
| 02 | [`02_inference/`](02_inference/practice.ts) | 类型推断 | const vs let、对象/数组拓宽、`as const` |
| 03 | [`03_functions/`](03_functions/practice.ts) | 函数类型 | 参数与返回类型、可选、默认、rest、重载、void 回调 |
| 04 | [`04_interfaces/`](04_interfaces/practice.ts) | 对象与接口 | interface、可选、只读、索引签名、extends、call signature |
| 05 | [`05_union_narrowing/`](05_union_narrowing/practice.ts) | 联合与收窄 | 联合类型、typeof/in、判别联合、穷尽检查(never) |
| 06 | [`06_null_safety/`](06_null_safety/practice.ts) | 空值安全 | 可选链 `?.`、空值合并 `??`、非空断言 `!`、越界 undefined |
| 07 | [`07_arrays_tuples/`](07_arrays_tuples/practice.ts) | 数组与元组 | map/filter 类型流、readonly、元组返回多值、`as const` |
| 08 | [`08_classes/`](08_classes/practice.ts) | 类 | 字段、构造、修饰符、参数属性、implements、getter、static |
| 09 | [`09_generics/`](09_generics/practice.ts) | 泛型入门 | 泛型函数、约束 `extends`、自动推断、多类型参数 |
| 10 | [`10_utility_types/`](10_utility_types/practice.ts) | 工具类型 | Partial / Pick / Omit / Record / ReturnType / Readonly |
| 11 | [`11_async/`](11_async/practice.ts) | Promise 与 async | Promise 类型、async/await、Promise.all 元组、catch unknown |
| 12 | [`12_type_gymnastics/`](12_type_gymnastics/practice.ts) | 类型体操入门 | keyof、条件类型、映射类型、infer、模板字面量类型 |

**建议节奏**：每天 2–3 套，先不看 `solution.ts` 自己憋 10 分钟，憋不出再瞄一眼思路，回来继续写。

---

## 目录结构

```
practise/
├── package.json              # 依赖与脚本
├── tsconfig.json             # 严格模式编译配置（带中文注释）
├── README.md                 # 本文件
└── 01_basic_types/           # 每个练习一个目录
    ├── practice.ts           # ★ 你要编辑的文件（题目在顶部注释里，底部是自检）
    └── solution.ts           # 参考答案（卡住时再看）
```

## 约定与小贴士

- `// TODO` = 你要动手写的地方；`★ 自检区` 以下的代码**不要改**，那是裁判。
- 类型题里反复出现的两个小工具照抄即可，不用深究：
  ```ts
  type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
  type Expect<T extends true> = T;
  // type _q1 = Expect<Equal<你的类型, 期望类型>>;  // 不相等就编译报错
  ```
- 每个文件末尾的 `export {};` 是把它变成「独立模块」，防止不同练习里的同名变量冲突。
- 想跳过本地安装，直接在线试： <https://www.typescriptlang.org/play>（把 practice.ts 内容贴进去即可）。
- 做完想更深入原理，回到 [`../code/`](../code/README.md) 与 [`../knowledge/`](../knowledge/README.md)。

祝写得愉快 🎉
