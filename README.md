<div align="center">

# 🥊 Fighting — 全栈技术学习笔记

**以「可运行代码 + 中文注释」为教材的个人技术成长仓库**

从语言基础到 runtime 源码，从前端三件套到 AI Agent 工程化，成体系地把每个主题啃透。

[![Language](https://img.shields.io/badge/lang-Go%20%7C%20Java%20%7C%20Python%20%7C%20TS%20%7C%20JS-00ADD8?style=flat-square)](#-学习地图)
[![Docs](https://img.shields.io/badge/knowledge-200%2B%20articles-4B8BBE?style=flat-square)](#-学习地图)
[![Code](https://img.shields.io/badge/runnable%20examples-140%2B-brightgreen?style=flat-square)](#-学习地图)
[![Comments](https://img.shields.io/badge/comments-中文注释即教材-red?style=flat-square)](#-设计理念)
[![License](https://img.shields.io/badge/license-personal%20learning-lightgrey?style=flat-square)](#-许可)

</div>

---

## 📖 目录

- [这是什么](#-这是什么)
- [设计理念](#-设计理念)
- [学习地图](#-学习地图)
  - [Go —— 从语法到 runtime 源码](#go--从语法到-runtime-源码)
  - [Java —— 进阶与并发](#java--进阶与并发)
  - [Python —— 语言 + LangChain + LangGraph](#python--语言--langchain--langgraph)
  - [前端三件套 —— HTML / CSS / JS](#前端三件套--html--css--js)
  - [TypeScript —— 类型系统专精](#typescript--类型系统专精)
  - [AI Agent —— 工程化实战](#ai-agent--工程化实战)
  - [Nginx —— 从配置到源码级状态机](#nginx--从配置到源码级状态机)
  - [RPC —— 从函数调用幻觉到线上字节](#rpc--从函数调用幻觉到线上字节)
  - [消息队列 —— Kafka / RabbitMQ / Redis Stream](#消息队列--kafka--rabbitmq--redis-stream)
  - [Docker 与 Kubernetes —— 从容器到编排](#docker-与-kubernetes--从容器到编排)
- [目录规范](#-目录规范)
- [快速开始](#-快速开始)
- [提交规范](#-提交规范)
- [许可](#-许可)

---

## 🎯 这是什么

**Fighting** 是一个成体系的全栈学习仓库。它不是零散的代码片段堆积，而是把每个技术领域拆成**编号递进的独立主题**，每个主题都是一个**可以直接跑起来**的最小示例，代码里的**中文注释就是教材**。

覆盖领域：

| 领域 | 定位 | 深度 |
|------|------|------|
| 🐹 **Go** | 后端主力语言 | 基础语法 → 并发 → **runtime 源码深挖（调度器 / GC / Swiss Table）** |
| ☕ **Java** | 进阶与并发 | OOP → 泛型 → 并发工具 → 虚拟线程 → 模块化 |
| 🐍 **Python** | 语言 + AI 生态 | 语言核心 → **LangChain / LangGraph 工程实践** |
| 🎨 **前端** | 三件套 + 工程化 | HTML/CSS/JS → 异步 → 模块化 → Vite |
| 🔷 **TypeScript** | 类型系统专精 | 结构化类型 → 泛型编程 → 工程配置 |
| 🤖 **AI Agent** | 应用层工程化 | 核心模式 → RAG → 编排 → 评估 → 生产化 |
| 🌐 **Nginx** | Web 服务器源码深挖 | 事件循环 → HTTP 状态机 → upstream → TLS → 性能调优 |
| 🔌 **RPC** | 远程调用协议全链路 | IDL → Protobuf 线格式 → gRPC/HTTP2 → 失败语义与重试 |
| 📨 **消息队列** | MQ 选型与核心机制 | Kafka / RabbitMQ / Redis Stream 深度对比 |
| ☸️ **Docker / Kubernetes** | 容器与编排 | 容器 → 镜像 → Compose → K8s → 发布与排障 |

> **约 200+ 篇知识文章 + 140+ 可运行代码示例**，每个语言目录都遵循统一的 `code/`（跑流程）+ `knowledge/`（讲原理）双轨结构。

---

## 💡 设计理念

1. **注释即教材** —— 每个代码文件开头都有本节概览（学什么、其他语言程序员的视角、如何运行），关键逻辑逐行中文注释。
2. **可独立运行** —— 每个 `code/0X_xxx/` 目录自包含，不依赖其他目录，`clone` 下来就能跑。
3. **⚠️ 陷阱标注** —— 常见坑用 ⚠️ 显式标记，一眼定位易错点。
4. **代码 + 知识双轨** —— `code/` 跑流程建立手感，`knowledge/` 讲原理夯实内功，互为补充不重复。
5. **对比式学习** —— 针对有经验的程序员，主动标注「从 X 语言到 Y 语言」的思维转换（如 *从 Java 到 JS*、*从 Java 到 Go*）。

---

## 🗺️ 学习地图

### Go —— 从语法到 runtime 源码

> 面向有其他语言经验的程序员，是本仓库**最深入**的板块：从 `hello world` 一路挖到调度器、GC pacer、Swiss Table map 的 runtime 源码。

`go/code/` — **37 个可运行主题**，`go/knowledge/` — **28 篇深度文章**

| 阶段 | 主题范围 | 关键内容 |
|------|---------|---------|
| **基础语法** | `01`–`09` | 变量 / 流程控制 / 切片底层数组共享 ⚠️ / 指针与逃逸分析 |
| **类型系统** | `10`–`14` | 结构体嵌入 / 值 vs 指针接收者 ⚠️ / nil 接口陷阱 ⚠️ / 泛型 |
| **并发** | `15`–`17` | goroutine（`-race` 竞态检测）/ channel / context |
| **标准库与测试** | `18`–`20` | packages / stdlib / `go test` + benchmark |
| **进阶专题** | `21`–`28` | 内存模型 / 结构化并发 / 背压流水线 / reflect+unsafe / 编译器 SSA / 生产级服务 |
| **runtime 源码深挖** | `29`–`36` | 调度器 / goroutine 栈与 ABI / 分配器与 GC pacer / Swiss Table / select 与 semaphore / syscall+cgo+netpoll / **综合事故实验室** |

```powershell
go run ./01_hello              # 第 1 课
go run -race ./15_goroutines   # ★ 体验竞态检测器
go test -race ./28_production_service/...
```

---

### Java —— 进阶与并发

> 从 OOP 进阶到虚拟线程，配套 JVM / JMM / 并发容器源码级知识文章。

`java/code/` — **20 个主题**，`java/knowledge/` — **12 篇文章**

| 阶段 | 主题 |
|------|------|
| **语言进阶** | OOP 进阶 / 泛型 / 集合 / 异常 / 枚举注解 |
| **函数式** | Lambda / Stream / Optional / DateTime |
| **IO 与并发** | IO-NIO / 线程基础 / 并发工具（`12_concurrent_utils`） |
| **现代特性** | Records / Sealed / 模式匹配 / 文本块 / **虚拟线程** / 模块化 / 反射代理 |
| **知识专题** | JVM 内存 / 类加载 / GC / JMM / synchronized / HashMap / ConcurrentHashMap / 线程池 / AQS / 面试陷阱 |

---

### Python —— 语言 + LangChain + LangGraph

> 语言核心之外，重点建设 **AI 应用生态**：LangChain 15 讲 + LangGraph 12 讲，均带可运行代码与深度文章。

| 子模块 | 内容 | 规模 |
|--------|------|------|
| **`python/code`** | 语言核心：类型提示 / 生成器 / 装饰器 / 上下文管理器 / 魔术方法 … | 20 主题 |
| **`python/knowledge`** | 对象模型 / dict 内部 / GIL / 描述符 / 元类 / 内存 GC / import 系统 … | 12 篇 |
| **`python/langchain`** | Models/Prompts → LCEL → RAG → Tools → Agents → 结构化输出 → LangGraph | 15 主题 + 8 篇 |
| **`python/langgraph`** | State/Reducer → 条件边 → 工具 Agent → 人在回路 → checkpoint → 子图 → 多智能体 | 12 主题 + 6 篇 |

---

### 前端三件套 —— HTML / CSS / JS

> 为有后端基础的程序员准备，学习成本极低：**浏览器 + 编辑器**即可开跑。

`frontend/code/` — **20 个主题**，`frontend/knowledge/` — **5 篇原理文章**

| 阶段 | 主题范围 | 内容 |
|------|---------|------|
| **HTML** | `01`–`02` | 语义化结构 / 表单与验证 |
| **CSS** | `03`–`08` | 选择器与特指度 / 盒模型 / Flexbox / Grid / 响应式 / 动画 |
| **JavaScript** | `09`–`16` | 基础 / 函数 / 对象 / 数组 / DOM / 事件 / 异步 / Fetch |
| **工程化** | `17`–`20` | ES6 模块 / 浏览器存储 / TypeScript 入门 / Vite |
| **知识专题** | — | 浏览器渲染管线 / CSS 层叠与特指度 / 事件循环 / 关键渲染路径 / **从 Java 到 JS** |

---

### TypeScript —— 类型系统专精

> 一套循序渐进的可运行示例（`ts-node` 直接执行），聚焦 TS 最核心的**类型系统**。

`Typescript/code/src/` — **编号 TS 示例**，`Typescript/knowledge/` — **10 篇文章**

- 基础类型 / 类型推断 / 函数 / 接口 / 联合类型 / 类 / **泛型** / 类型收窄 / 高级类型 / 工具类型
- 知识专题：类型系统概览 / **结构化 vs 名义类型** / 类型收窄模式 / 泛型与类型编程 / 配置与工程化 / 类型推断上下文与 satisfies / 可赋值性、变型与稳健性 / 运行时边界与领域建模 / 模块解析与包类型 / 公共 API 类型设计

```bash
cd Typescript/code && npm install && npm run dev
```

---

### Nginx —— 从配置到源码级状态机

> 以官方 Nginx 主线源码为基线，从请求进入监听 socket 开始，追踪到 worker 事件循环、HTTP 状态机、upstream 建连与响应过滤。

**24 篇深度文章**，入口见 [`Nginx/README.md`](Nginx/README.md)：

| 阶段 | 主题范围 | 关键内容 |
|------|---------|---------|
| **进程与事件** | `01`–`02` | master/worker 架构 / epoll 事件循环 / 连接对象 |
| **配置与 HTTP** | `03`–`06` | 配置解析与继承 / HTTP 请求状态机 / server/location 匹配 / phase 引擎与 rewrite 陷阱 |
| **代理与缓存** | `07`–`10` | upstream 状态机 / 负载均衡与健康判定 / 缓冲流控与零拷贝 / proxy_cache 一致性 |
| **TLS 与协议** | `11`–`12` | TLS 握手与会话复用 / HTTP2/HTTP3 多路复用与队头阻塞 |
| **性能与运维** | `13`–`18` | sendfile+gzip+文件缓存 / 限流限连接 / 日志指标与延迟拆解 / 内核调优 / 热升级高可用 / Stream 四层代理 |
| **源码与实战** | `19`–`24` | 源码阅读地图 / 故障注入实验 / 生产事故根因分析 / 面试必考题 / 内存池与 Buffer 生命周期 / HTTP 解析器引用计数 |

---

### RPC —— 从函数调用幻觉到线上字节

> 拆掉"远程调用像本地函数"这层幻觉：从 IDL 追到 Protobuf 线格式、gRPC over HTTP2 协议字节、失败语义与重试策略。

**6 篇深度文章**，入口见 [`RPC/README.md`](RPC/README.md)：

| 主题 | 核心内容 |
|------|---------|
| `01` RPC 语义 | 调用链与失败模型（部分失败、超时不代表未执行、幂等键） |
| `02` IDL 与 Schema | 代码生成、Schema 演进兼容性（ABI 兼容 vs 语义兼容） |
| `03` Protobuf 线格式 | varint、length-delimited、字段序与未知字段逐字节拆解 |
| `04` gRPC over HTTP2 | 请求/响应/错误/尾元数据如何映射到 HTTP2 frame |
| `05` HTTP2 多路复用 | stream、流控窗口、队头阻塞与连接管理 |
| `06`  Deadline 与重试 | deadline 传播、取消、重试策略、幂等与去重 |

---

### 消息队列 —— Kafka / RabbitMQ / Redis Stream

> 没有"最好的 MQ"，只有匹配业务约束的消息模型。从选型 15 问到三者的消息模型、可靠性、性能与运维对比。

入口见 [`MQ/MQ选型深度指南_Kafka_RabbitMQ_RedisStream.md`](MQ/MQ选型深度指南_Kafka_RabbitMQ_RedisStream.md)，子目录含各 MQ 的核心机制记录：

| 子模块 | 定位 |
|--------|------|
| **选型指南** | 先给结论 → 15 个量化问题 → 消息模型对比 → 可靠性/性能/运维三维矩阵 |
| `Kafka/` | 分区与消费组、ISR 与水位、日志压缩、幂等与事务 |
| `RabbitMQ/` | exchange/queue/binding 拓扑、TTL/DLX/优先级、确认与回退 |
| `RedisStream/` | stream/consumer group/pending entries、与 Redis 数据结构配合 |

---

### AI Agent —— 工程化实战

> 面向**应用层 / Agent 开发者**，聚焦如何工程化地搭出可用、可靠、可上线的 Agent，不深入 Transformer 内部。入口见 [`agent/INDEX.md`](agent/INDEX.md)。

**6 大专题，约 44 篇文章**：

| 专题 | 目录 | 核心内容 |
|------|------|---------|
| 🧠 **Agent 核心** | [`agent-core`](agent/agent-core) | Agent 循环与 ReAct / 工具使用 / 反思 / 规划 / 多智能体 / 模式选择 |
| 📚 **RAG** | [`rag`](agent/rag) | 分块策略 / 嵌入与向量库 / 混合检索与重排 / 查询改写路由 / 高级架构 / 评估 |
| 🔌 **上下文工程** | [`context-engineering`](agent/context-engineering) | MCP 协议 / 上下文工程基础 / Agent 记忆系统 / 上下文管理 / 反模式 |
| 🕸️ **编排** | [`orchestration`](agent/orchestration) | 五种工作流模式 / 多智能体拓扑 / 状态管理 / 通信协议 / 框架选型 |
| 📊 **评估与可观测** | [`evaluation`](agent/evaluation) | 为何评估更难 / 指标维度 / LLM 裁判 / 数据集与 CI / 追踪 / 线上持续评估 |
| 🛡️ **生产化** | [`production`](agent/production) | 安全威胁全景 / Prompt 注入防御 / 最小权限隔离 / 护栏与人类介入 / 成本延迟治理 |

> **黄金法则**：从简单开始，按需增加复杂度。先把「单 Agent + ReAct + 好工具」做扎实——它能搞定现实中大多数任务。

---

### Docker 与 Kubernetes —— 从容器到编排

> 以一个小型 Go HTTP 服务贯穿全部实验：先构建 Docker 镜像与 Compose 开发环境，再部署到本地 Kubernetes 集群，最终完成更新、扩缩容、可观测与故障排查。

总路线规划为 **8 个阶段、28 个递进实验和 14 篇原理文章**，当前已建立课程骨架，后续逐课补充：

- Docker：容器生命周期、镜像、Dockerfile、存储、网络与 Compose。
- Kubernetes：架构、Pod、Deployment、Service、配置、存储与 Ingress。
- 生产实践：探针、资源、调度、滚动更新、扩缩容、可观测与系统排障。
- 综合项目：从源码、镜像一路交付到本地集群，并完成坏版本回滚和故障演练。

入口见 [`docker-kubernetes/README.md`](docker-kubernetes/README.md)。

---

## 📂 目录规范

每个技术目录遵循统一的双轨组织结构：

```
<技术名>/
├── code/                 # 按主题编号的可运行代码示例
│   ├── README.md         # 该领域的学习地图、环境配置、运行方式
│   ├── 01_xxx/           # 独立主题，可直接运行（小写英文 + 下划线命名）
│   ├── 02_xxx/
│   └── ...
└── knowledge/            # 深度知识文章（.md）
    ├── 01_xxx.md         # 编号 + 主题，讲原理不重复代码
    └── ...
```

- **代码文件**：开头有本节概览，关键处中文注释，常见坑用 ⚠️ 标记。
- **知识文件**：Markdown 深度讲解原理，与代码互补——代码跑流程，知识讲原理。
- 每个领域的 `code/README.md` 都是该领域的**完整学习地图**，建议从那里开始。

---

## 🚀 快速开始

```bash
git clone <this-repo> Fighting && cd Fighting
```

按兴趣选一个领域，进入对应 `code/README.md` 跟着学习地图走：

| 想学 | 从这里开始 | 环境 |
|------|-----------|------|
| Go | [`go/code/README.md`](go/code/README.md) | Go 1.26+ |
| Java | [`java/code/README.md`](java/code/README.md) | JDK 21+（虚拟线程需要） |
| Python | [`python/code/README.md`](python/code/README.md) | Python 3.10+ |
| LangChain / LangGraph | [`python/langchain`](python/langchain) · [`python/langgraph`](python/langgraph) | Python 3.10+ |
| 前端 | [`frontend/code/README.md`](frontend/code/README.md) | 浏览器（工程化部分需 Node 18+） |
| TypeScript | [`Typescript/code/README.md`](Typescript/code/README.md) | Node 18+ |
| AI Agent | [`agent/INDEX.md`](agent/INDEX.md) | 纯阅读，无需环境 |
| Nginx | [`Nginx/README.md`](Nginx/README.md) | 纯阅读，无需环境 |
| RPC | [`RPC/README.md`](RPC/README.md) | 纯阅读，无需环境 |
| 消息队列 | [`MQ/MQ选型深度指南_Kafka_RabbitMQ_RedisStream.md`](MQ/MQ选型深度指南_Kafka_RabbitMQ_RedisStream.md) | 纯阅读，无需环境 |
| Docker / Kubernetes | [`docker-kubernetes/README.md`](docker-kubernetes/README.md) | Docker Desktop、kubectl、kind |

---

## 📝 提交规范

本仓库使用规范化的 commit message（详见 [`CLAUDE.md`](CLAUDE.md)）：

```
<type>: <简短中文描述>
```

| type | 说明 |
|------|------|
| `feat` | 新学习模块 |
| `fix` | 修复代码错误 / 笔误 |
| `docs` | 文档 / 注释变更 |
| `refactor` | 重构（不改变功能） |
| `style` / `chore` / `test` | 格式 / 工具配置 / 测试 |

**原则**：一个 commit 只做一件事；描述用中文、type 用英文；不提交构建产物（`node_modules/`、`venv/`、`__pycache__/`、`*.class` 等已在 `.gitignore` 排除）。

---

## 📄 许可

个人学习仓库，内容以中文注释和知识文章为主，供学习交流参考。

<div align="center">

**⭐ 学习不是看完，而是边学边做 —— Keep Fighting.**

</div>
