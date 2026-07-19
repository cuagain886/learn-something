# TypeScript 全面学习项目

一套循序渐进、带详细中文注释的 TypeScript 示例。课程从语法和类型系统一路深入到
运行时边界、异步控制、Agent 工具架构与 TypeScript Compiler API。每个文件都可独立运行，
也包含由 `tsc` 自动验证的负向类型用例。

> 适合「会其它语言、想系统学 TS」的同学：注释会简要标注 JS 特有写法，
> 重点放在 TypeScript 的**类型系统**。

---

## 环境要求

- [Node.js](https://nodejs.org/) 24.12 以上（本项目用 v24.14 测试通过；高级课程依赖现代 Node API）
- npm（随 Node 安装）

`@types/node` 主版本与最低运行时保持在 24，避免类型检查意外放行仅 Node 25 才提供的 API。基础语法文件可能在更旧 Node 上也能运行，但那不代表整套高级课程受支持。

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

# 运行新增的高级专题
npm run lesson:foundations
npm run lesson:core-types
npm run lesson:core-types:dist
npm run lesson:modules
npm run lesson:modules:dist
npm run lesson:promise
npm run lesson:decorators
npm run lesson:declarations
npm run lesson:declarations:dist
npm run lesson:events
npm run lesson:intermediate
npm run lesson:intermediate:dist
npm run lesson:inference
npm run lesson:validation
npm run lesson:async
npm run lesson:tools
npm run lesson:compiler
npm run lesson:advanced-core
npm run lesson:advanced-core:dist
npm run lesson:agent-runtime
npm run lesson:agent-runtime:dist
npm run lesson:runtime
npm run lesson:resources
npm run lesson:streaming
npm run lesson:context
npm run lesson:decorators-deep
npm run lesson:type-performance
npm run lesson:event-loop
npm run lesson:errors
npm run lesson:testing
npm run lesson:memory
npm run lesson:workers
npm run lesson:workers:dist
npm run lesson:mcp-protocol
npm run lesson:mcp-protocol:test
npm run lesson:mcp-protocol:dist

# 运行 Agent Runtime 的运行时契约测试
npm test
```

> 学习时建议：**读注释 → 运行看输出 → 自己改两行再运行**，效果最好。
> 文件里被注释掉的「❌ 错误示例」可以试着取消注释，亲眼看看编译器如何报错。

---

## 学习顺序（编号即顺序）

### 第一阶段 · 基础
1. [01-basic-types.ts](src/01-basic-types.ts) — 基础类型与底层边界：IEEE-754、安全整数、unique symbol、readonly tuple、enum emit、any 污染、void 返回兼容、类型/值空间
2. [02-variables-inference.ts](src/02-variables-inference.ts) — 双向推断、`as const` 不等于 freeze、`satisfies`、断言证明义务、安全空值处理

### 第二阶段 · 函数与结构类型
3. [03-functions.ts](src/03-functions.ts) — 函数重载、联合调用限制、动态 `this`、参数逆变、void 回调返回兼容与 async rejection
4. [04-interfaces.ts](src/04-interfaces.ts) — readonly 浅层性、索引签名、call/construct signature、声明合并、fresh object、exact optional
5. [05-type-aliases-union.ts](src/05-type-aliases-union.ts) — 联合/交叉的类型代数、运行时合并、never、interface/type 真实差异和 Agent Result 联合

### 第三阶段 · 面向对象
6. [06-classes.ts](src/06-classes.ts) — class 静态/运行时双层模型：soft private 与 `#private` brand、参数属性 emit、实例/静态侧、prototype/own property、初始化顺序、abstract/implements 擦除和 private 来源名义性

### 第四阶段 · 进阶类型（核心）
7. [07-generics.ts](src/07-generics.ts) — 泛型量化与 union 差异、推断拓宽、readonly/非空数组、constraint 信息保留、const 类型参数、`NoInfer`、构造签名、类型擦除和方差
8. [08-type-narrowing.ts](src/08-type-narrowing.ts) — 控制流图、可达性、truthiness/in/instanceof 边界、unknown 谓词与 assertion、TS 5.5 推断谓词、闭包/别名突变、不健全副作用和 Agent 判别联合
9. [09-advanced-types.ts](src/09-advanced-types.ts) — `keyof` 索引语义、`typeof`/`satisfies`、映射修饰符与键过滤、条件类型分发、`never` 筛选、`infer`、模板解析、递归成本和运行时 parser
10. [10-utility-types.ts](src/10-utility-types.ts) — PATCH 字段白名单、`Required`/`Readonly` 浅层性、Pick/Omit 非 sanitizer、Record 运行时缺键、overload 提取、thenable `Awaited`、this 工具与 `NoInfer`

### 第五阶段 · 工程化
11. [11-modules/](src/11-modules/11-modules.ts) — ESM 模块图、Node 的 `.js` specifier、类型/值依赖、barrel、live binding、模块命名空间对象、URL 缓存和源码/dist 双路径
12. [12-async.ts](src/12-async.ts) — Promise executor/Job、thenable assimilation、resolved/fulfilled 差异、tuple 顺序、all/race 不取消败者、任意 rejection、finally 与 fire-and-forget
13. [13-decorators.ts](src/13-decorators.ts) — 完整保持 this/参数/返回关系的标准装饰器、工厂求值/反向应用、字段初值、`addInitializer`、类替换原型链与静态类型缺口
14. [14-declaration-files.ts](src/14-declaration-files.ts) — `.d.ts` 信任边界、故意漂移的 JS 实现、`declare global`、真实 module augmentation、手写声明/JS 资产构建与源码/dist 双路径

### 第六阶段 · 类型系统实战
15. [15-practice.ts](src/15-practice.ts) — 生产级同步事件系统：void 参数元组、interface 事件表、拒绝 async listener、once 重入、dispatch 快照、AbortSignal 清理和 AggregateError

### 第七阶段 · 深入推断与运行时边界

16. [16-inference-satisfies.ts](src/16-inference-satisfies.ts) — 双向候选/上下文信息流、widening、`satisfies`、fresh excess-property、const 泛型、`NoInfer`、异构实现表相关性，以及静态 readonly 与运行时突变差异
17. [17-runtime-validation.ts](src/17-runtime-validation.ts) — 从 `unknown` 建立 Schema 三层契约：静态 `Infer`、运行时 parser、模型 JSON Schema；验证 own-property、strict/strip、optional、品牌、transform、JSON Pointer 和 prototype-pollution 输入
    - [17-schema.ts](src/17-schema.ts)：可被工具系统复用的透明 Schema 内核与组合器

### 第八阶段 · Agent 开发前置能力

18. [18-async-control.ts](src/18-async-control.ts) — cooperative timeout、取消优先重试、可注入退避、失败 abort sibling 且等待收束的并发池、Deferred 确定性调度证明和 AsyncGenerator cleanup
19. [19-typed-tool-system.ts](src/19-typed-tool-system.ts) — 复用 Schema 的 Agent 工具系统：typed known-call/真实 unknown-call、动态成功联合、编译期/运行时重复名门禁、先鉴权后解析、取消分类与 manifest 深复制

### 第九阶段 · 编译器底层

20. [20-compiler-api.ts](src/20-compiler-api.ts) — Compiler API 内存实验室：Scanner/AST、合并 Symbol、flow Type、语法/语义诊断、`transpileModule` 边界、Transformer、JS/.d.ts 内存 emit/执行和 BuilderProgram version 增量重检

### 第十阶段 · 多模块 Agent Runtime 综合项目

21. [agent-runtime/](src/agent-runtime/README.md) — 从 `unknown` 校验模型协议，复用 Schema 生成工具 JSON Schema；包含权限前置、JSON-safe 输出 clone、多维预算、有界 worker pool、跨轮 call-id、单消费者事件流，以及运行时/编译期双重契约测试

### 第十一阶段 · JavaScript 底层与流式运行时

22. [22-javascript-runtime-model.ts](src/22-javascript-runtime-model.ts) — 原型链、自有属性、属性描述符、动态 `this`、闭包、TS private 与 `#private`、浅复制与类型擦除
23. [23-explicit-resource-management.ts](src/23-explicit-resource-management.ts) — `using`、`await using`、`DisposableStack`、所有权转移、LIFO 清理与 `SuppressedError`
24. [24-streaming-sse.ts](src/24-streaming-sse.ts) — UTF-8 增量解码、Web Streams 背压、CR/LF 分行、完整 SSE 状态机和 Agent 事件验证

### 第十二阶段 · 异步上下文、元编程与类型性能

25. [25-async-context.ts](src/25-async-context.ts) — `AsyncLocalStorage.run`、嵌套工具上下文、`bind`、`snapshot`、EventEmitter 注册/触发上下文与并行 Agent 隔离
26. [26-standard-decorators-internals.ts](src/26-standard-decorators-internals.ts) — 标准装饰器求值/应用顺序、方法替换、`addInitializer`、字段和自动访问器、`Symbol.metadata`
27. [27-type-level-algorithms.ts](src/27-type-level-algorithms.ts) — 分发条件类型、模板字面量解析、尾递归、深度预算和编译期类型契约；性能指标由独立 tsconfig 测量

### 第十三阶段 · 事件循环、失败语义与可靠性测试

28. [28-event-loop-scheduling.ts](src/28-event-loop-scheduling.ts) — libuv 调度的可观察结果、nextTick/微任务优先级、await 分段、事件循环饥饿、协作式 yield 与非抢占取消
29. [29-error-modeling.ts](src/29-error-modeling.ts) — unknown catch、Error cause、判别失败联合、Result、可重试分类、取消优先、AggregateError 与脱敏序列化
30. [30-testing-contracts.test.ts](src/30-testing-contracts.test.ts) — node:test、端口 spy、Deferred 握手、可控并发完成顺序、unknown 表驱动边界和确定性属性测试

### 第十四阶段 · 内存生命周期与泄漏诊断

31. [31-memory-lifecycle.test.ts](src/31-memory-lifecycle.test.ts) — V8/Node 内存指标、UTF-8 byte-budget LRU、强 Map 清理、Disposable 订阅、Abort listener、WeakMap/FinalizationRegistry 边界和确定性泄漏契约

### 第十五阶段 · Worker Threads 与多核协议

32. [32-worker-threads.test.ts](src/32-worker-threads.test.ts) — 独立 V8 isolate、structured clone、ArrayBuffer transfer、SharedArrayBuffer/Atomics 取消、`markAsUntransferable` 和源码/dist 双路径测试
    - [32-worker-protocol.ts](src/32-worker-protocol.ts)：判别 union 与双向 unknown 解析
    - [32-worker-client.ts](src/32-worker-client.ts)：主线程关联、transfer、AbortSignal 和 Worker 所有权
    - [32-worker-checksum-worker.ts](src/32-worker-checksum-worker.ts)：可由 Node 原生剥离类型运行的 CPU Worker 入口

### 第十六阶段 · JSON-RPC 与 MCP Agent 协议

33. [33-mcp-protocol/](src/33-mcp-protocol/README.md) — JSON-safe wire decoder、stdio UTF-8 framing、method→params/result 泛型关联、乱序 response correlator、取消 tombstone、Server dispatch、MCP 初始化/版本/能力协商和 tools 教学子集

---

## 深度知识文档

源码用于“运行和修改”，[`../knowledge/`](../knowledge/README.md) 用于建立完整心智模型。新增课程对应：

| 代码 | 深度文档 |
|---|---|
| 11 / 14 | [模块解析、ESM 与声明资产发布](../knowledge/09_modules_resolution_and_package_types.md) |
| 12 | [Promise 底层与结构化并发](../knowledge/12_async_runtime_and_structured_concurrency.md) |
| 13 | [标准装饰器、初始化顺序与元数据](../knowledge/19_standard_decorators_and_metadata.md) |
| 15 | [公共 API 与事件分发协议](../knowledge/10_public_api_type_design.md) |
| 16 | [推断、上下文类型与 satisfies](../knowledge/06_inference_context_and_satisfies.md) |
| 17 | [运行时边界与领域建模](../knowledge/08_runtime_boundaries_and_domain_modeling.md) |
| 18 | [异步运行时与结构化并发](../knowledge/12_async_runtime_and_structured_concurrency.md) |
| 19 | [Agent 工具系统的类型架构](../knowledge/13_agent_tool_type_architecture.md) |
| 20 | [TypeScript 编译器与 Checker 底层原理](../knowledge/11_compiler_internals.md) |
| 21 | [多模块 Agent Runtime 架构案例](../knowledge/14_agent_runtime_case_study.md) |
| 22 | [JavaScript 运行时对象模型](../knowledge/15_javascript_runtime_object_model.md) |
| 23 | [显式资源管理](../knowledge/16_explicit_resource_management.md) |
| 24 | [Agent 流式协议与背压](../knowledge/17_streaming_protocols_and_backpressure.md) |
| 25 | [异步上下文传播](../knowledge/18_async_context_propagation.md) |
| 26 | [标准装饰器与元数据](../knowledge/19_standard_decorators_and_metadata.md) |
| 27 | [类型级算法与编译性能](../knowledge/20_type_level_performance.md) |
| 28 | [Node.js 事件循环、任务队列与协作式调度](../knowledge/21_event_loop_and_scheduling.md) |
| 29 | [异常语义、Result 与生产级失败建模](../knowledge/22_error_semantics_and_failure_modeling.md) |
| 30 | [TypeScript 与 Agent 的多层契约测试](../knowledge/23_testing_type_and_agent_contracts.md) |
| 31 | [Node/V8 内存模型、GC 与 Agent 泄漏诊断](../knowledge/24_memory_gc_and_leak_diagnostics.md) |
| 32 | [Worker Threads、共享内存与类型化并发协议](../knowledge/25_worker_threads_and_typed_protocols.md) |
| 33 | [JSON-RPC 2.0 与 MCP 协议底层](../knowledge/26_json_rpc_mcp_protocol_internals.md) |

建议每课采用四步法：先预测类型和输出 → 运行源码 → 修改一个不变量观察错误 → 阅读对应原理文档。

---

## 项目结构

```
learn_ts/
├── package.json          # 依赖与脚本
├── tsconfig.json         # TS 编译配置（每个选项都有中文注释）
├── README.md             # 本文件
└── src/
    ├── 01 ~ 10           # 基础到进阶类型
    ├── 11-modules/       # ESM 图、barrel、live binding 与 Node 双路径
    ├── 12 ~ 14           # Promise 底层、标准装饰器、声明文件与 augmentation
    ├── 15-practice.ts    # 可重入、可取消的同步事件系统
    ├── 16 ~ 17           # 推断信息流与可复用 Schema 三层契约
    ├── 18 ~ 19           # 结构化异步与 Agent 工具静态/动态双入口
    ├── 20-compiler-api.ts# Compiler API 内存 emit/transform/builder 实验
    ├── agent-runtime/    # 第 21 课：多模块 Agent Runtime + tests
    ├── 22 ~ 24           # JS 对象模型、资源管理与 SSE 流式协议
    ├── 25 ~ 27           # 异步上下文、标准装饰器底层与类型性能
    ├── 28 ~ 32           # 事件循环、失败、契约、内存与 Worker 并行
    ├── 33-mcp-protocol/  # JSON-RPC correlator + MCP 生命周期/工具协议
    ├── globals.d.ts      # 全局类型声明（第 14 课配套）
    └── legacy/           # 无类型 JS + 配套 .d.ts（第 14 课配套）
```

## 小贴士

- 每个 `.ts` 文件末尾的 `export {};` 是为了让它成为「独立模块」，
  避免不同课程文件里的同名变量在全局作用域冲突（详见第 11 课「模块」）。
- `tsconfig.json` 除 `strict` 外还开启了 `noUncheckedIndexedAccess`、
  `exactOptionalPropertyTypes`、`noPropertyAccessFromIndexSignature` 等高价值检查。
- `@ts-expect-error` 是课程中的负向断言：对应行必须产生类型错误，否则整个 `typecheck` 会失败。
- 想深入查阅，官方文档非常优秀：<https://www.typescriptlang.org/docs/>
- 在线练习场（不用装环境就能试）：<https://www.typescriptlang.org/play>

祝学习愉快 🎉
