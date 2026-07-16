# TypeScript 深度知识索引

这里不是语法速查表，而是解释 TypeScript 在真实工程里“为什么这样工作”。建议先读 01～05 建立模型，再按问题查 06～10。

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

## 推荐路径

- 日常业务开发：01 → 03 → 06 → 08 → 10
- 库与基础设施：01 → 02 → 04 → 07 → 09 → 10
- 排查“编译通过、运行失败”：05 → 07 → 08 → 09
- 从 Java/C# 转 TS：02 → 03 → 06 → 07

## 阅读约定

- `✅` 表示推荐或类型安全；`❌` 表示编译错误或危险设计。
- 示例默认开启 `strict`；涉及可选属性与索引访问时会明确说明额外开关。
- 类型断言只证明“开发者愿意负责”，不会生成运行时校验代码。

