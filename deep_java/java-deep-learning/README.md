# Java 后端与 Agent 开发：从语言规范到可靠运行时

这不是 API 速查表，而是一套围绕“**语义—编译—Class 文件—HotSpot—操作系统—工程故障**”建立证据链的学习仓库。每个重要结论都应能回答三个问题：它属于哪一层、在什么版本成立、如何用代码或工具证伪。

## 1. 适用人群与最终能力

适合已经写过 Java，希望从“能用 Spring”进阶到能解释、测量和排障的开发者。完成 S 级主线及综合项目后，应能：

- 从一段源码推导 `javac` 的类型检查、解糖结果和主要字节码；
- 区分 JLS、JVMS、JDK 类库、HotSpot 实现和 Linux/Windows 行为，避免跨层推理；
- 用 `javap`、JFR、`jcmd`、线程转储、GC 日志、JOL、JMH、JCStress 建立证据；
- 解释对象布局、类加载、JMM、锁、GC 和 JIT 对延迟与吞吐的影响；
- 设计有 deadline、取消、幂等、背压、恢复和资源隔离的 Java Agent runtime；
- 面对 CPU、堆、原生内存、线程、锁、连接池或下游抖动时，先定位资源与因果链，再调参数。

## 2. 版本基线：先固定实验世界

| 层次 | 本仓库基线 | 处理原则 |
|---|---|---|
| 语言与 Class 文件 | Java SE 21，class major version 65 | 正文默认语义；实验用 `--release 21` |
| JVM 实现 | HotSpot 21.0.8，64-bit Server VM | 对象头、JIT、GC 等必须标记为 HotSpot 实现 |
| 兼容下限 | JDK 17 LTS | 没有 record pattern、虚拟线程等特性时给出替代路径 |
| 演进观察 | JDK 25 | 只放“版本差异”框；例如 Compact Object Headers 在 25 是非默认产品特性，不能用于推导 JDK 21 默认布局 |
| 构建 | Maven 3.9+，UTF-8 | 示例优先原生 `javac`；依赖 JOL/JCStress 时才用 Maven |
| 操作系统 | Windows 11 已验证；Linux 命令另列 | `perf`、`pidstat`、cgroup 等实验必须在 Linux 或容器中复验 |

JDK 25 已在 2025-09-16 GA，但“LTS”是供应商支持策略，不是 Java SE 规范中的语言属性。为了让当前机器上的所有第一轮实验可复现，本仓库没有追逐最高版本，而是以 21 为执行基线、以 25 为差异观察线。

## 3. 六层阅读法

```text
Java 源码与 JLS 语义
        │ javac：解析、归因、解糖、生成
        ▼
Class 文件与 JVMS 指令
        │ 验证、加载、链接、初始化
        ▼
HotSpot：解释器 / C1 / C2 / GC / 对象布局
        │ syscall、页、线程、调度、文件描述符
        ▼
操作系统与容器
        │ HTTP / DB / MQ / 模型 / Tool 等不可靠边界
        ▼
后端与 Agent 的状态机、超时、幂等和恢复
```

看到“Java 保证”时先问：是 JLS/JVMS 的保证，还是某次 HotSpot 运行的观察？看到“机器指令/内存屏障”时再问：目标 CPU、JIT 编译层级和运行参数是什么？

## 4. 推荐学习顺序

1. **语义地基**：`00 → 01 → 02 → 03 → 12 → 13 → 14`。
2. **翻译与执行**：`04 → 05 → 06 → 07 → 08 → 09 → 10 → 11`。
3. **并发语义**：`15 → 16 → 17 → 18`；先 JMM，后工具类。
4. **后端链路**：`19 → 20 → 21 → 22 → 23 → 24 → 25…30`。
5. **Agent 控制面**：`31…40`；模型只提出动作，确定性代码控制权限与副作用。
6. **生产诊断**：`41…46`，并贯穿 `48-java-agent-runtime-project`。

完整依赖、状态与章节映射见 [00-learning-map.md](00-learning-map.md)，按周执行见 [49-24-week-plan.md](49-24-week-plan.md)，真实完成度见 [PROGRESS.md](PROGRESS.md)。

## 5. S / A / B 优先级

- **S：必须能推导并实验**。类型系统、编译、字节码、类加载、对象模型、GC、JIT、JMM、锁、线程池、Spring IoC/AOP/事务、HTTP、数据库事务、Agent 状态机、Tool、安全、超时、取消、重试、幂等。
- **A：必须能做工程选型和排障**。NIO/Netty、MVC/WebFlux、MySQL 索引、Redis、MQ、分布式一致性、Memory、RAG、事件流、JVM 可观测性。
- **B：理解边界，按需下钻**。编译器和 GC 的完整源码、CPU 微架构、数据库/内核全量源码、向量库完整实现。

“S”不等于背更多结论，而是能够给出反例、版本边界、验证命令和失败语义。

## 6. 第一轮已落地实验

所有普通样例均为 JDK 21、无第三方依赖：

```powershell
cd deep_java\java-deep-learning
.\labs\compile-and-inspect.ps1
```

脚本会：

1. 用 `javac --release 21 -g -parameters` 编译源码；
2. 运行参数传递、解糖、调用字节码、类初始化、volatile 发布实验；
3. 把 `InvocationLab` 的完整 `javap -c -v -p` 输出写到 `build/`。

对象布局实验：

```powershell
cd labs\object-layout
mvn -q package exec:java
# 对照实验必须新建 JVM，不能在同一进程动态切换：
mvn -q exec:java -Dexec.jvmArgs="-XX:-UseCompressedOops -XX:-UseCompressedClassPointers"
```

并发统计实验：

```powershell
cd benchmarks\jcstress
mvn -q -DskipTests package
java -jar target\jcstress.jar -m quick -c 2 -f 1 -iters 2 -time 200 `
  -t 'dev\.deepjava\.jcstress\.(PlainReorderingTest|VolatilePublicationTest)'
```

`FailureLab` 会故意耗尽资源，**只允许在独立 JVM 和受限环境中运行**：

```powershell
java -Xmx32m -XX:+HeapDumpOnOutOfMemoryError -cp build\classes dev.deepjava.jvm.FailureLab heap
java -Xss256k -cp build\classes dev.deepjava.jvm.FailureLab stack
java -XX:MaxDirectMemorySize=32m -cp build\classes dev.deepjava.jvm.FailureLab direct
java -XX:MaxMetaspaceSize=32m -cp build\classes dev.deepjava.jvm.FailureLab metaspace
```

不要在承载 IDE、数据库或其他任务的同一 JVM 中制造 OOM；不要用“创建本地线程直到失败”在无进程数限制的主机上做实验。

## 7. 源码阅读方式

每次源码阅读先写问题，而不是从文件第一行开始：

```text
对外契约 → 核心状态/不变量 → happy path → 竞争/失败路径
        → 扩展点 → 分配与锁成本 → 可观测字段 → 最小验证实验
```

JDK 源码以正在运行的准确 build 为准：`$JAVA_HOME/lib/src.zip`。HotSpot 源码要固定 OpenJDK tag；Spring 源码要固定 Framework/Boot 版本和 commit。文章中出现的方法名不构成跨版本 API 承诺。

## 8. 文档质量门

正文至少达到 L2；S 级章节目标是 L3：

| 等级 | 能力 | 不足示例 |
|---|---|---|
| L0 名词 | 知道术语 | “volatile 保证可见性” |
| L1 解释 | 能说设计动机 | 能解释缓存与重排序 |
| L2 工程 | 有数据结构、流程、失败模式、工具证据 | 能判断发布错误并设计实验 |
| L3 答辩 | 能区分规范/实现、给反例、限定版本并证伪 | 能从 happens-before 推导允许结果，再用 JCStress 验证 |

每章提交前检查：规范/实现是否分层，版本是否固定，示例是否编译，危险实验是否隔离，性能数字是否说明机器与负载，Agent 副作用是否有幂等与结果未知处理。

## 9. 一手资料入口

- [Java Language Specification, Java SE 21](https://docs.oracle.com/javase/specs/jls/se21/html/)
- [Java Virtual Machine Specification, Java SE 21](https://docs.oracle.com/javase/specs/jvms/se21/html/)
- [JDK 21 工具规范](https://docs.oracle.com/en/java/javase/21/docs/specs/man/)
- [OpenJDK JDK 21：相对 JDK 17 的 JEP](https://openjdk.org/projects/jdk/21/jeps-since-jdk-17)
- [OpenJDK JDK 25](https://openjdk.org/projects/jdk/25/)
- [OpenJDK JOL](https://github.com/openjdk/jol)
- [OpenJDK JCStress](https://github.com/openjdk/jcstress)

博客可用于发现关键词，关键语义以规范、JEP、目标版本源码和可重复实验为准。
