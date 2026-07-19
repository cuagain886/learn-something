# TypeScript 深度知识索引

这里不是语法速查表，而是解释 TypeScript 在真实工程里“为什么这样工作”。建议先读 01～05 建立模型，再按问题查阅 06～26；每篇都尽量把静态类型、JavaScript 运行时与 Agent 工程实践连起来。

| 编号 | 主题 | 解决的核心问题 |
|---|---|---|
| [01](01_type_system_overview.md) | 类型系统全景 | TS 的静态类型、推断、拓宽、收窄如何协作 |
| [02](02_structural_vs_nominal.md) | 结构化类型 | 为什么“长得一样”就兼容，以及如何阻止误用 |
| [03](03_type_narrowing_patterns.md) | 控制流收窄 | 怎样把运行时判断转化为编译期证明 |
| [04](04_generics_and_type_programming.md) | 泛型与类型编程 | 怎样表达类型之间的关系，而不是只给值贴标签 |
| [05](05_config_and_engineering.md) | 配置与工程化 | 编译目标、模块策略、严格检查如何匹配运行环境 |
| [06](06_inference_context_and_satisfies.md) | 推断、上下文与 `satisfies` | 为什么同一个表达式放在不同位置会得到不同类型 |
| [07](07_assignability_variance_and_soundness.md) | 可赋值性、方差与健全性 | 为什么某些看似危险的赋值能通过，如何守住边界 |
| [08](08_runtime_boundaries_and_domain_modeling.md) | 运行时边界与领域建模 | 如何安全处理 JSON、异常、状态机和外部输入 |
| [09](09_modules_resolution_and_package_types.md) | 模块解析与类型发布 | 为什么编辑器能找到类型但运行时报错，库怎样正确发 `.d.ts` |
| [10](10_public_api_type_design.md) | 公共 API 类型设计 | 如何让调用方获得稳定推断、清晰错误和可演进契约 |
| [11](11_compiler_internals.md) | 编译器与 Checker 底层原理 | Scanner、AST、Symbol、Type、控制流和增量编译如何协作 |
| [12](12_async_runtime_and_structured_concurrency.md) | 异步运行时与结构化并发 | Agent 中如何正确处理取消、超时、重试、限流和流式背压 |
| [13](13_agent_tool_type_architecture.md) | Agent 工具类型架构 | 如何把动态 LLM 调用收敛成可验证、可授权、强关联的执行协议 |
| [14](14_agent_runtime_case_study.md) | 多模块 Agent Runtime 案例 | 如何组合模型端口、工具注册表、状态机、事件流、取消和双重测试 |
| [15](15_javascript_runtime_object_model.md) | JavaScript 运行时对象模型 | 类型擦除后，原型、属性描述符、this、私有元素和闭包如何工作 |
| [16](16_explicit_resource_management.md) | 显式资源管理 | 如何用 using、DisposableStack 和所有权边界可靠清理资源 |
| [17](17_streaming_protocols_and_backpressure.md) | 流式协议与背压 | 如何从任意字节分块正确恢复 UTF-8、SSE 和 Agent 领域事件 |
| [18](18_async_context_propagation.md) | 异步上下文传播 | AsyncLocalStorage 如何沿异步因果链传递 run、trace 和授权上下文，哪里会丢失 |
| [19](19_standard_decorators_and_metadata.md) | 标准装饰器与元数据 | 类定义、装饰器组合、初始化器、字段/访问器和元数据的真实运行时语义 |
| [20](20_type_level_performance.md) | 类型级算法与编译性能 | 联合分发、递归、实例化和项目边界为何拖慢 checker，怎样测量和控制成本 |
| [21](21_event_loop_and_scheduling.md) | Node.js 事件循环与调度 | libuv 阶段、微任务、nextTick、CPU 阻塞和协作式取消怎样影响所有并发 Agent run |
| [22](22_error_semantics_and_failure_modeling.md) | 异常语义与失败建模 | 如何区分取消、领域拒绝、暂时失败和 bug，并安全重试、聚合、序列化错误 |
| [23](23_testing_type_and_agent_contracts.md) | TypeScript 与 Agent 契约测试 | 如何组合类型负向测试、unknown 边界、确定性并发、属性测试和真实适配器契约 |
| [24](24_memory_gc_and_leak_diagnostics.md) | Node/V8 内存模型与泄漏诊断 | 可达性、分代 GC、强弱引用、内存指标和 heap retainer 如何共同解释长运行 Agent 的泄漏 |
| [25](25_worker_threads_and_typed_protocols.md) | Worker Threads 与类型化并发协议 | isolate、structured clone、transfer、SharedArrayBuffer/Atomics 和跨线程取消如何协作 |
| [26](26_json_rpc_mcp_protocol_internals.md) | JSON-RPC 2.0 与 MCP 协议底层 | wire 校验、请求关联、取消竞态、stdio/HTTP 传输与 MCP 生命周期如何形成可靠 Agent 协议 |

## 文档深度标准与审计状态

每篇核心文档至少应回答五类问题：静态类型关系、checker/emit 机制、JavaScript 运行时事实、已知不健全边界、Agent/后端工程应用，并尽量由可运行断言或负向类型测试验证。

- 01～05 已完成第二轮深度审计：修正类型格、函数参数方差、Java Lambda、控制流闭包、空数组泛型、旧式发布/ESLint 配置等问题，并补齐对应代码契约。
- 06～10 本轮逐篇复核后，已具备推断、健全性、运行时边界、模块发布和公共 API 的机制级说明；它们与 01～05 新增章节互相交叉引用。
- 配套代码 06～10 已完成第二轮重写：不再只罗列 class/泛型/守卫/工具类型语法，而是用运行时断言和 `@ts-expect-error` 验证 emit、初始化顺序、推断信息流、谓词证明义务、条件类型分发以及工具类型不产生 runtime sanitizer 等边界。
- 配套代码 11～15 已完成第二轮重写：修正 Bundler 无扩展名导入与 Node ESM dist 的错位，补齐模块 live binding/URL 缓存、Promise resolution/组合器非取消语义、类型保持型标准装饰器、手写声明资产发布，以及事件系统的重入/快照/异常/AbortSignal 协议；09、10、12 文档同步回填机制说明与可运行链接。
- 配套代码 16～20 已完成第二轮重写：推断课程加入 runtime 反证；Schema 拆成可复用的静态/解析/JSON Schema 三层内核；异步池在失败时取消并等待 sibling；工具系统区分 known/unknown 调用并加入授权与重复名门禁；Compiler API 课程改为内存 host、transform、JS/.d.ts emit 和 builder version 实验。06、08、11、12、13 文档已同步回填。
- 第 21 课 Agent Runtime 已完成边界重构：模型端口返回 `unknown` 并校验 normalized turn，工具复用 Schema、先授权后解析、验证并安全复制输出；Runner 加入单轮调用量、并发和 step 三重预算、全 Run call-id 唯一性与有界 worker pool。第 14 篇文档同步重写，并以故障路径测试证明协议。
- 第 33 课新增 JSON-RPC/MCP 协议实验室：按固定 `2025-11-25` revision 实现 wire decoder、stdio framing、typed method table、pending/in-flight/tombstone 状态、取消竞态、版本/能力协商和 tools 教学子集；第 26 篇文档同步解释规范事实与生产缺口。
- 11～26 是编译器、并发、Agent Runtime、JS 对象模型、流协议、装饰器、类型性能、测试、内存、Worker 与 MCP 等高级专题。
- 后续审计不以行数为标准；发现事实错误、版本漂移或缺少可验证例子时，直接修正文档和源码。

## 推荐路径

- 日常业务开发：01 → 03 → 06 → 08 → 10
- 库与基础设施：01 → 02 → 04 → 07 → 09 → 10
- 排查“编译通过、运行失败”：05 → 07 → 08 → 09
- 从 Java/C# 转 TS：02 → 03 → 06 → 07
- 深入编译器底层：01 → 04 → 06 → 07 → 11
- Java 开发者补运行时：01 → 02 → 15 → 16 → 18 → 19 → 21 → 22 → 24 → 25
- 面向 Agent 开发：08 → 10 → 12 → 13 → 14 → 16 → 17 → 18 → 21 → 22 → 23 → 24 → 25 → 26
- 类型体操与编译性能：04 → 06 → 07 → 11 → 20
- 事件循环与多核并行：12 → 18 → 21 → 24 → 25
- 生产可靠性：12 → 16 → 17 → 18 → 21 → 22 → 23 → 24 → 25 → 26

## 阅读约定

- `✅` 表示推荐或类型安全；`❌` 表示编译错误或危险设计。
- 示例默认开启 `strict`；涉及可选属性与索引访问时会明确说明额外开关。
- 类型断言只证明“开发者愿意负责”，不会生成运行时校验代码。
