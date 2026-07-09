# 前端三件套（HTML / CSS / JavaScript）系统学习教程

为有 Java 后端基础的程序员准备的前端入门到进阶教程。每个编号目录是一个**可独立运行**的主题，代码中的中文注释就是教材——**建议边读注释边运行，再动手改代码做实验**。

## 环境与运行方式

前端的学习成本极低——你只需要**浏览器 + 文本编辑器**：

- **HTML/CSS 文件**：直接用浏览器打开 `.html` 文件即可看到效果
- **JS 文件**：HTML 页面通过 `<script>` 标签引入，在浏览器开发者工具（F12 → Console）查看输出
- **Node.js**（第 17-20 课需要）：`node --version` 确认已安装（建议 18+ LTS）

```powershell
# 第 01-16 课：直接在浏览器中打开 HTML 文件
# 或使用 VS Code 的 Live Server 插件（推荐，自动刷新）

# 第 17-18 课：浏览器打开 HTML，配合 Console 查看
# 第 19 课：先在 19_typescript_intro 目录下 npm install，再 npm run dev
# 第 20 课：先在 20_vite_tooling 目录下 npm install，再 npm run dev
```

## 学习地图

按编号顺序学即可，每课约 30–60 分钟（读注释 + 运行 + 自己改代码实验）。

### 第一阶段：HTML —— 网页骨架（01–02）

| # | 主题 | 核心知识点 | Java 程序员的对应概念 |
|---|------|-----------|---------------------|
| 01 | [HTML 结构与语义化](01_html_structure/index.html) | DOCTYPE、head/body、块级/行内元素、语义标签、SEO 基础 | XML 的结构化标记 → HTML 是"带语义的 XML" |
| 02 | [表单与验证](02_html_forms/index.html) | input 类型、表单校验、label/fieldset、可访问性基础 | 类似 Swing/JavaFX 的表单控件 |

### 第二阶段：CSS —— 视觉呈现（03–08）

| # | 主题 | 核心知识点 | Java 程序员的对应概念 |
|---|------|-----------|---------------------|
| 03 | [选择器与优先级](03_css_selectors/index.html) | 基础选择器、组合器、伪类/伪元素、特指度计算 | 类似 CSS 选择器的"查询条件" |
| 04 | [盒模型](04_css_box_model/index.html) | content/padding/border/margin、box-sizing、display | 类似 Swing 的 Insets + LayoutManager |
| 05 | [Flexbox 弹性布局](05_css_flexbox/index.html) | 容器/项目属性、主轴交叉轴、常见布局模式 | 类似 BoxLayout / FlowLayout |
| 06 | [Grid 网格布局](06_css_grid/index.html) | 网格容器/项目、template、fr 单位、Grid vs Flexbox | 类似 GridBagLayout 但强大 100 倍 |
| 07 | [响应式设计](07_css_responsive/index.html) | 媒体查询、移动优先、相对单位、clamp() | 类似 Java 的 LayoutManager 自适应窗口 |
| 08 | [过渡与动画](08_css_animations/index.html) | transition、keyframes、transform、性能注意 | 类似 JavaFX 的 Timeline / Transition |

### 第三阶段：JavaScript 核心（09–12）

| # | 主题 | 核心知识点 | Java 程序员的对应概念 |
|---|------|-----------|---------------------|
| 09 | [语言基础](09_js_basics/index.html) | var/let/const、动态类型、== vs ===、类型转换、严格模式 | Java 基础语法的 JS 版本（注意⚠️陷阱） |
| 10 | [函数](10_js_functions/index.html) | 函数声明/表达式、箭头函数、闭包、this 绑定 | 类似 Java 的 Lambda + 方法引用 |
| 11 | [对象](11_js_objects/index.html) | 对象字面量、原型链（简述）、解构、展开、可选链 | 类似 Java 的 Map + POJO 的混合体 |
| 12 | [数组与高阶方法](12_js_arrays/index.html) | map/filter/reduce/find、展开、解构、不可变操作 | 类似 Java Stream API（map/filter/reduce） |

### 第四阶段：浏览器 JavaScript（13–16）

| # | 主题 | 核心知识点 | Java 程序员的对应概念 |
|---|------|-----------|---------------------|
| 13 | [DOM 操作](13_dom_manipulation/index.html) | querySelector、createElement、classList、dataset、性能 | 操作 UI 组件树的 API |
| 14 | [事件处理](14_events/index.html) | addEventListener、事件委托、冒泡/捕获、自定义事件 | 类似 Java 的 ActionListener / Event 机制 |
| 15 | [异步编程](15_async/index.html) | 回调、Promise、async/await、错误处理、Promise.all | 类似 Java 的 CompletableFuture |
| 16 | [HTTP 请求](16_fetch_http/index.html) | fetch API、Headers、错误处理、JSON、FormData、CORS 简介 | 类似 Java 的 HttpClient |

### 第五阶段：工程化（17–20）

| # | 主题 | 核心知识点 | Java 程序员的对应概念 |
|---|------|-----------|---------------------|
| 17 | [ES6 模块化](17_es6_modules/) | import/export、命名/默认导出、动态导入、Tree Shaking | 类似 Java 的 package + import |
| 18 | [浏览器存储](18_browser_storage/index.html) | localStorage、sessionStorage、Cookie、IndexedDB 简介 | 类似 Java 的 Properties 文件 + 轻量数据库 |
| 19 | [TypeScript 入门](19_typescript_intro/) | 类型注解、接口、泛型（轻量）、从 JS 到 TS 迁移 | ⭐ Java 程序员最亲切的一课 |
| 20 | [Vite 工程化](20_vite_tooling/) | 项目搭建、热更新、构建、环境变量、npm 脚本 | 类似 Maven/Gradle 但更轻量 |

## 关键思维转换：从 Java 到前端

| 维度 | Java 后端 | 前端 |
|------|----------|------|
| **类型系统** | 静态强类型 | JS：动态弱类型。TS：渐进式静态类型 |
| **并发** | 多线程（Thread Pool） | 单线程 + 事件循环（Event Loop） |
| **执行环境** | JVM | 浏览器（不同的浏览器 = 不同的"JVM"） |
| **依赖管理** | Maven / Gradle | npm / pnpm / yarn |
| **模块化** | package + Maven坐标 | npm 包 + ES Modules |
| **调试** | IDE Debugger | 浏览器 DevTools（F12） |
| **部署** | jar/war 部署到服务器 | 静态文件部署到 CDN / Nginx |

## 怎么学效果最好

1. **先跑再看**：浏览器打开 HTML 看效果，对照源码注释理解每一行
2. **动手破坏**：把注释里标 ⚠️ 的陷阱代码取消注释，亲眼看它怎么坏
3. **打开 DevTools**：F12 是你最重要的工具——Elements（看 DOM/CSS）、Console（看 JS 输出）、Network（看 HTTP 请求）、Application（看存储）
4. **自己重写**：合上教程，凭记忆重写本课的核心示例
5. **边学边做**：学完 CSS 就去模仿一个你喜欢的网站布局；学完 JS 就给表单加上交互

## 精通之路：学完 20 课之后

- **MDN Web Docs**：<https://developer.mozilla.org/>（前端的事实标准文档，比 w3schools 权威）
- **现代框架**：React（最流行）→ Vue（最易上手）→ Angular（最像 Spring）
- **CSS 进阶**：Tailwind CSS（实用优先）、Sass（CSS 预处理器）
- **TypeScript 深入**：官方 Handbook → type-challenges（类型体操）
- **全栈框架**：Next.js（React 全栈）→ Nuxt（Vue 全栈）
- **练手项目建议**：
  1. 个人博客（纯 HTML/CSS/JS）→ 练布局和响应式
  2. Todo App（加 JS 交互）→ 练 DOM + 事件
  3. 天气查询（调 API）→ 练 fetch + async
  4. Markdown 预览器 → 练工程化（Vite + 第三方库）
  5. 后台管理 CRUD → 练表单 + 状态管理
