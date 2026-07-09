# Java 进阶 & 高阶系统学习教程

为**已掌握 Java 基础语法**（变量、流程控制、类与对象基本概念）的同学准备的进阶到高阶教程，并覆盖 **Java 25 LTS 的最新特性**。每个编号目录是一个**可独立运行**的主题，源码中的中文注释就是教材——**建议边读注释边运行，再动手改代码做实验**。

## 环境与运行方式

本教程基于 **Java 25 LTS**。从 Java 11 起，单个 `.java` 文件可以**不经过 `javac` 编译直接运行**（[JEP 330](https://openjdk.org/jeps/330) 源码启动器），本教程正是利用这一点做到"每课一个文件、即点即跑"。

```powershell
java -version                 # 确认 25+（本教程基于 Java 25.0.2 LTS）

# 在本目录（code/）下运行任意主题（单文件源码启动，无需先编译）：
java 01_oop_advanced/Main.java
java 07_stream/Main.java

# 需要预览特性的章节（本教程在 21 下基本不需要，列在此备用）：
java --enable-preview --source 25 16_text_block_switch/Main.java

# 传统编译 + 运行方式（多文件 / 模块化章节用）：
javac -d out 18_modules/**/*.java
java  -p out -m com.example.app/com.example.app.Main
```

> 💡 **为什么用单文件而不是 Maven/Gradle 工程？** 学习阶段重点是语言特性本身，单文件启动器让你像写脚本一样验证想法。真实工程请上 Maven/Gradle，见第 20 课。

## 学习顺序

按编号顺序学即可，每课约 30–60 分钟（读注释 + 运行 + 自己改代码实验）。

### 第一阶段：面向对象与类型系统进阶（01–05）

| # | 主题 | 核心知识点 |
|---|------|-----------|
| 01 | [面向对象进阶](01_oop_advanced/Main.java) | 抽象类 vs 接口、default/static/private 接口方法、内部类四种形态、不可变对象 |
| 02 | [泛型](02_generics/Main.java) | 类型参数、上下界 `extends/super`、PECS、通配符 `?`、⚠️类型擦除、桥方法 |
| 03 | [集合框架](03_collections/Main.java) | List/Set/Map/Queue 全家谱、Comparator、迭代器、不可变集合、选型决策表 |
| 04 | [异常处理进阶](04_exceptions/Main.java) | 受检 vs 非受检、try-with-resources、多重捕获、异常链、`addSuppressed` |
| 05 | [枚举与注解](05_enum_annotation/Main.java) | 带行为的枚举、EnumMap、自定义注解、元注解、`@Retention`、反射读注解 |

### 第二阶段：函数式与现代 API（06–10）

| # | 主题 | 核心知识点 |
|---|------|-----------|
| 06 | [Lambda 与函数式接口](06_lambda/Main.java) | `@FunctionalInterface`、四大内置接口、方法引用四形态、闭包捕获规则 |
| 07 | [Stream API](07_stream/Main.java) | 中间/终端操作、惰性求值、`collect`/`Collectors`、`reduce`、并行流陷阱 |
| 08 | [Optional](08_optional/Main.java) | 正确用法、`map/flatMap/filter`、⚠️反模式（别当字段/参数）、与 Stream 配合 |
| 09 | [日期时间 API](09_datetime/Main.java) | `java.time`（LocalDate/Instant/Duration/ZonedDateTime）、为什么弃用旧 Date |
| 10 | [I/O 与 NIO](10_io_nio/Main.java) | 字节流/字符流、`try-with-resources`、`java.nio.file`（Path/Files）、缓冲 |

### 第三阶段：并发编程（11–12）—— 大厂核心区分点

| # | 主题 | 核心知识点 |
|---|------|-----------|
| 11 | [多线程基础](11_thread_basics/Main.java) | Thread/Runnable、生命周期、`synchronized`、`volatile`、`wait/notify`、⚠️竞态 |
| 12 | [并发工具包](12_concurrent_utils/Main.java) | ExecutorService、`Future`/`CompletableFuture`、Lock、原子类、并发集合、CountDownLatch |

### 第四阶段：Java 现代语言特性（13–17）—— 最新版重点 ⭐

| # | 主题 | 核心知识点 |
|---|------|-----------|
| 13 | [Record 记录类](13_records/Main.java) | 不可变数据载体、自动方法、紧凑构造器、自定义、与序列化 |
| 14 | [Sealed 密封类](14_sealed/Main.java) | `sealed`/`permits`/`non-sealed`、密封接口、与模式匹配的代数数据类型 |
| 15 | [模式匹配](15_pattern_matching/Main.java) | `instanceof` 模式、switch 模式匹配、**record 解构**、守卫、穷尽性（Java 25 环境） |
| 16 | [文本块与 switch 表达式](16_text_block_switch/Main.java) | 文本块 `"""`、switch 表达式 `->`/`yield`、与传统语句对比 |
| 17 | [虚拟线程](17_virtual_threads/Main.java) | ⭐ 虚拟线程 vs 平台线程、`Thread.ofVirtual`、结构化并发、为什么能"百万并发" |

### 第五阶段：工程化与高阶机制（18–20）

| # | 主题 | 核心知识点 |
|---|------|-----------|
| 18 | [模块系统 JPMS](18_modules/) | `module-info.java`、`requires`/`exports`、强封装、为什么模块化 |
| 19 | [反射与动态代理](19_reflection_proxy/Main.java) | Class 对象、反射读写字段/调用方法、`Proxy` 动态代理、框架底层原理 |
| 20 | [测试与构建](20_testing/) | JUnit 5、断言、参数化测试、Maven/Gradle 工程结构、测试金字塔 |

## 怎么学效果最好

1. **先跑再读**：`java xx/Main.java` 看输出，对照源码注释理解每一行
2. **动手破坏**：把注释里标 ⚠️ 的陷阱代码取消注释，亲眼看它怎么坏（编译错误 / 运行异常 / 错误结果）
3. **自己重写**：合上教程，凭记忆重写本课的核心示例
4. **对照底层**：跑完代码后翻 [../knowledge](../knowledge) 里对应的底层原理文档，把"会用"升级成"懂原理"

## 学完之后

- **官方教程**：<https://dev.java/learn/>（Oracle 官方现代 Java 教程）
- **JEP 索引**：<https://openjdk.org/jeps/0>（每个新特性的设计文档，理解"为什么"的最佳来源）
- **Java API 文档**：<https://docs.oracle.com/en/java/javase/21/docs/api/>（日常字典）
- **Effective Java（第3版）**：Joshua Bloch 著，Java 进阶圣经，强烈推荐通读
- **配套底层文档**：[../knowledge](../knowledge)（JVM / GC / 并发 / 集合源码 / 面试陷阱）
- **练手项目建议**：命令行待办工具（练集合/IO/异常）→ 简易 HTTP 服务（练并发/`HttpServer`）→ 并发爬虫（练虚拟线程/CompletableFuture）

## 版本里程碑速查（面试加分项）

| 版本 | 年份 | 标志性特性 |
|------|------|-----------|
| Java 8 | 2014 | Lambda、Stream、`Optional`、`java.time`、接口 default 方法 |
| Java 9 | 2017 | 模块系统 JPMS、`var` 前奏、不可变集合工厂 `List.of` |
| Java 10/11 | 2018 | `var` 局部变量推断、单文件源码启动、新 `HttpClient`（11 LTS）|
| Java 14–16 | 2020–21 | `switch` 表达式、文本块、`instanceof` 模式、**Record**、NPE 详情 |
| Java 17 | 2021 | **Sealed 类**（LTS）、伪随机数接口 |
| Java 21 | 2023 | ⭐ **虚拟线程**、**switch 模式匹配 + record 解构**、序列化集合 |
| Java 25 | 2025 | 当前最新 LTS：结构化并发、作用域值、灵活构造体、紧凑源文件 |
