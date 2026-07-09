# Fighting — 全栈学习笔记

个人技术学习仓库，涵盖后端、前端、Agent 等领域。以**可运行的代码示例 + 中文注释**为教材，按主题分目录组织。

## 项目结构

```
Fighting/
├── agent/          # AI Agent 相关（核心模式、上下文工程、评估、RAG、编排、生产化）
├── frontend/       # 前端三件套（HTML/CSS/JS/TS + 工程化）
├── go/             # Go 语言（基础 → 并发 → 标准库）
├── java/           # Java 进阶（OOP → 泛型 → 并发 → 模块化 → 虚拟线程）
├── python/         # Python 语言 + LangChain + LangGraph
├── Typescript/     # TypeScript 系统学习
├── .github/        # GitHub Actions 工作流
└── CLAUDE.md       # 本文件
```

## 目录规范

每个技术目录遵循统一的组织结构：

```
<技术名>/
├── code/           # 按主题编号的可运行代码示例
│   ├── README.md   # 学习地图、环境配置、运行方式
│   ├── 01_xxx/     # 独立主题，可直接运行
│   ├── 02_xxx/     # 小写英文 + 下划线命名
│   └── ...
└── knowledge/      # 深度知识文章（.md）
    ├── 01_xxx.md   # 编号 + 小写英文 + 下划线命名
    └── ...
```

### 代码文件要求
- **注释即教材**：每个代码文件开头有本节概览（学什么、Java 程序员视角、运行方式）
- **可独立运行**：每个 `code/0X_xxx/` 目录自包含，不依赖其他目录
- **⚠️ 陷阱标注**：常见坑用 ⚠️ 标记，便于快速识别
- **命名规范**：目录名 = `编号_主题`（小写英文 + 下划线），`01_hello`、`02_variables`

### 知识文件要求
- Markdown 格式，带 YAML 标准 frontmatter 或标题行
- 深度讲解原理性内容，不重复代码教程
- 与代码示例互补，代码跑流程，知识讲原理

## Git 提交规范

每次变更必须使用规范化的 commit message，格式为：

```
<type>: <简短描述>

<详细说明（可选）>
```

### type 类型

| type | 说明 | 示例 |
|------|------|------|
| `feat` | 新功能 / 新学习模块 | `feat: 添加前端 CSS Flexbox 学习模块` |
| `fix` | 修复代码错误 / 笔误 | `fix: 修复 Java 泛型示例的类型错误` |
| `docs` | 文档 / 注释变更 | `docs: 完善 Python 对象模型的知识文章` |
| `style` | 代码格式 / 缩进（不影响逻辑） | `style: 统一 Go 代码的缩进风格` |
| `refactor` | 重构（不改变功能） | `refactor: 将 Python 示例拆分为独立模块` |
| `chore` | 构建 / 工具 / 配置 | `chore: 添加 .gitignore 忽略规则` |
| `test` | 测试相关 | `test: 为 Java Stream 示例添加单元测试` |

### 提交要求
- **一个 commit 只做一件事**：不把新模块和配置修改混在一起
- **commit message 使用中文**（描述性文字）+ 英文 type
- **不要提交构建产物**：`node_modules/`、`dist/`、`venv/`、`__pycache__/`、`*.class` 等已在 `.gitignore` 中排除
- **提交前检查**：确认 `.gitignore` 规则生效，不提交 IDE 个人配置

### 示例

```bash
git commit -m "feat: 添加前端 JavaScript 异步编程模块

- Promise / async-await / 事件循环的代码示例
- 对比 Java CompletableFuture 的思维转换
- Console 可运行，F12 查看输出"
```
