# PROGRESS｜Java Deep Learning 实施台账

> 快照：2026-07-20（Asia/Shanghai）  
> 规则：只有“正文达到 L3 目标 + 配套实验可运行 + 关键输出已检查”才记为完成。只有文件名或提纲不计完成。

## 1. 版本假设

| 项 | 当前值 | 证据/边界 |
|---|---|---|
| 语言/Class 基线 | Java SE 21，major 65 | `javac 21.0.8`，所有普通样例 `--release 21` |
| JVM | Oracle HotSpot 64-Bit Server VM 21.0.8 | Windows 11 amd64；实现细节不外推其他 VM |
| 构建 | Maven 3.9.11 | JOL/JCStress 使用 Maven；普通样例只需 JDK |
| JOL | 0.17 | 当前进程动态 attach/SA 失败，地址 base/shift 只可视为猜测 |
| JCStress | 0.16 | Windows 无 taskset，affinity 降级；语义通过，不比较跨机频率 |
| 演进观察 | JDK 25 | GA 2025-09-16；Compact Headers 是非默认产品特性，不覆盖 JDK 21 默认布局 |

## 2. 文档完成情况

| 文件 | 状态 | 深度证据 |
|---|:---:|---|
| `README.md` | 完成 | 版本、分层、路线、优先级、运行方式、危险实验边界、毕业标准 |
| `00-learning-map.md` | 完成 | 因果依赖、49 文件主问题/证据、L0–L3、能力矩阵 |
| `01-java-language-design.md` | 完成 | JLS/JVMS/JDK/HotSpot/发行版分层、WORA 与三类兼容性 |
| `02-type-system-and-core-syntax.md` | 完成 | 值/槽/引用、数值、值传递、装箱、String、现代类型与运行成本 |
| `04-javac-and-compilation.md` | 完成 | parse→enter→process→attr→flow→desugar→generate，含真实 processor |
| `05-class-file-and-bytecode.md` | 完成 | Class/CP/descriptor/Code/frame/verifier、五类 invoke、异常与 monitor |
| `06-class-loading.md` | 完成 | 类型身份、委派、生命周期、`<clinit>`、TCCL/SPI、插件隔离与卸载 |
| `07-jvm-runtime-areas.md` | 完成 | 规范区/HotSpot/native/OS/container 分层，OOM 与证据矩阵 |
| `08-object-layout.md` | 完成 | 创建、classic header、字段/数组/对齐、引用强度、JOL 实测与 JDK 25 差异 |
| `15-java-memory-model.md` | 完成 | actions/orders/hb、volatile/final/safe publication、CPU 边界、JCStress 实测 |
| `49-24-week-plan.md` | 完成 | 24 周逐周主题、章节、字节码/JVM/源码/编码/排障/项目/自测/验收 |

本轮正文总计约 2,616 行（不含本文件和代码）。第一轮没有创建 39 个只有标题的占位章。

### 2.1 第二轮：语言/JVM/并发主线

| 文件 | 状态 | 深度证据 |
|---|:---:|---|
| `03-object-oriented-mechanism.md` | 完成 | 对象/接口分派、五类 invoke、默认方法冲突、去虚拟化与 Agent 扩展边界 |
| `09-memory-allocation.md` | 完成 | TLAB/慢路径、大对象、逃逸/标量替换，JMH 分配率对照 |
| `10-garbage-collection.md` | 完成 | 可达性、barrier、G1/ZGC 版本线，young/humongous 实际日志 |
| `11-interpreter-and-jit.md` | 完成 | 模板解释器、分层编译、profile/内联/去优化，JMH 陷阱与实测 |
| `12-generics.md` | 完成 | 擦除、Signature、bridge/checkcast、heap pollution、类型 token |
| `13-exception-mechanism.md` | 完成 | 异常表、栈展开、TWR/suppressed、失败分类与结果未知 |
| `14-collections.md` | 完成 | ArrayList/HashMap/树化/CHM、局部性、可变 key/subList 实验 |
| `16-thread-and-lock.md` | 完成 | 生命周期/中断/park、monitor/wait set、死锁 MXBean 实验 |
| `17-aqs-and-concurrency-tools.md` | 完成 | 独占/共享队列、Condition、CAS/ABA/LongAdder、自制 AQS latch |
| `18-thread-pool-and-virtual-thread.md` | 完成 | ctl/admission/拒绝/取消、FJP/CF、虚拟线程 pinning 和配额实验 |

第二轮新增十章正文约 2,383 行，均包含机制、边界、反例、Agent 场景、实验与一手资料。

### 2.2 第三轮（进行中）：运行时扩展与 I/O

| 文件 | 状态 | 深度证据 |
|---|:---:|---|
| `19-reflection-proxy-bytecode.md` | 完成 | JDK 21 反射实现、Handle、注解、JDK/子类代理、Byte Buddy Agent 正常/异常 Advice |
| `20-module-spi-plugin.md` | 完成 | reads/exports/opens、named/automatic/unnamed、ServiceLoader、ModuleLayer 与插件生命周期 |
| `21-java-io-nio-network.md` | 完成 | Buffer 游标、direct/mmap、Selector/OS 边界、framing/partial write/backpressure/transferTo |
| `22-http-servlet-web.md` | 完成 | HTTP 版本/TLS/连接池/幂等、Tomcat/Servlet/MVC/WebFlux 全链路与执行模型对照 |
| `23-spring-ioc.md` | 完成 | BeanDefinition/扩展点/完整生命周期、三级缓存的代理一致性、scope 与循环依赖 |
| `24-spring-aop-transaction.md` | 完成 | Advisor 链、self invocation、连接绑定、传播/回滚/异步/远程结果未知 |
| `25-spring-boot.md` | 完成 | Boot 4.1 启动事件、条件装配、starter skeleton、配置 metadata、fat JAR 与 StartupStep |
| `26-jdbc-connection-pool.md` | 完成 | JDBC round trip/batch/cursor、Little's Law、Hikari 7 borrow/requite/超时与故障树 |
| `27-mysql.md` | 完成 | InnoDB B+Tree/索引/plan、redo/undo/binlog、MVCC/read view、具体 lock set 与长事务 |
| `28-redis.md` | 完成 | 数据结构/event loop/persistence/replication、cache-aside 竞态与 owner/lease/fencing |
| `29-message-queue.md` | 完成 | partition/group/offset、at-least-once、outbox/inbox、EOS 边界、堆积恢复 |
| `30-distributed-system.md` | 完成 | timeout UNKNOWN、幂等状态机、一致性/CAP/共识边界、Saga/TCC 与韧性组合 |

## 3. 已验证代码与输出

### 3.1 普通 javac/javap 实验

命令：

```powershell
cd deep_java\java-deep-learning
.\labs\compile-and-inspect.ps1
```

2026-07-20 复验通过：

- `ValueSemanticsLab`：值传递、Integer identity/value、IEEE 754、UTF-16/UTF-8 断言通过；
- `DesugaringLab`：record/bridge/lambda/匿名类/switch/TWR suppressed exception 通过；
- `InvocationLab`：virtual/interface/dynamic、dense/sparse switch、monitor 通过；
- `ClassInitializationLab`：编译期常量/数组/`Class.forName(false)` 不初始化，父/子顺序符合预测；
- `PublicationLab`：volatile safe publication 与中断传播通过；
- `ThreadAndLockLab`：start/join、中断恢复和 `unpark` 单许可通过；
- `DeadlockLab`：`ThreadMXBean` 检测到两个 daemon 实验线程的 monitor 环；
- `OneShotLatchLab`：AQS shared mode 的超时、打开和传播通过；
- `ExecutorBoundaryLab`：2 workers + 2 queue 后第五项拒绝，虚拟线程下游最大并发不超过 3；
- `VirtualThreadPinningLab`：JDK 21 trace 捕获 `reason:MONITOR`，定位 monitor 内 sleep；
- 生成 `InvocationLab.javap.txt`，已逐项核对 `max_stack/locals`、五类调用样例、switch 和 monitor exception table。

### 3.2 JMH 与 GC 日志

JMH 1.37 quick 对照（仅作为本机方向性证据）：逃逸分配约 2.320 ns/op、24 B/op；标量替换候选约 0.305 ns/op、接近 0 B/op。接收者类型 1 的分派约 1339.984 ops/us，8 类型约 427.091 ops/us；不能仅凭此把差异全部归因于某次内联决定。

G1 64 MiB 堆实测：young GC 例有 `23M→1M, 4.948 ms`；1 MiB 数组触发 `G1 Humongous Allocation`，region size 为 1 MiB，日志观察到 humongous regions `28→0`。原始日志语义已在 10 章逐项解释。

### 3.3 注解处理器

`labs/annotation-processor/run.ps1` 已执行。处理器生成 `DemoGreeting.java`，下一 round 编译，程序输出 `hello from a generated type`。

### 3.4 类加载插件

`labs/classloader-plugin/run.ps1` 已执行。两个独立 `URLClassLoader` 同时加载同 binary name 的 v1/v2 实现和私有依赖，输出分别为 `v1:TASK`、`v2:[task]`；宿主 `Plugin` API identity 共享。

### 3.5 JOL

`labs/object-layout` 已 `mvn package exec:java`：

| 样例 | 当前实测 |
|---|---:|
| empty object | 16 bytes |
| mixed fields | 32 bytes |
| `int[3]` | 32 bytes |
| `Object[3]` | 32 bytes（只含引用槽，不含元素对象） |

Mark Word 已观察 `non-biasable → thin lock → identity hash`。JOL 报 dynamic attach/SA 不可用，文档未使用其猜测地址支持精确地址结论。

### 3.6 JCStress

两项测试以 quick、2 CPU、1 fork、2 iterations、200 ms 执行，28 个配置全部通过：

- plain reordering 约 1.9968 亿样本，`0,0` 约 29.93%（allowed/interesting）；
- volatile publication 未出现 forbidden `0`；
- 文档明确：plain `0,0` 也可能由普通交错产生，不单独证明 CPU/JIT 重排；有限运行不构成规范证明。

### 3.7 受限故障实验

独立 JVM、小上限实测：

| 模式 | 参数摘要 | 结果 |
|---|---|---|
| stack | `-Xss256k` | `StackOverflowError`，exit 1 |
| heap | `-Xms32m -Xmx32m` | `OutOfMemoryError: Java heap space`，exit 1 |
| direct | `-Xmx128m -XX:MaxDirectMemorySize=16m` | `Cannot reserve ... direct buffer memory`，exit 1 |
| metaspace | `-Xmx128m -XX:MaxMetaspaceSize=24m` | `OutOfMemoryError: Metaspace`，exit 1 |

native-thread exhaustion 未在桌面主机运行。代码要求同时满足系统属性 opt-in；文档要求仅在有 pids/memory/wall-clock 限制和外部 kill 的容器/VM 执行。

### 3.8 反射增强、模块与 NIO

- `ReflectionProxyLab`：反射注解、精确 MethodHandle、VarHandle CAS、JDK Proxy/default method 通过；实验曾实际捕获并修正 `WrongMethodTypeException`。
- `labs/reflection-agent`：Byte Buddy 子类代理通过；启动 `-javaagent` 对 `DemoService.work` 正常与异常退出均写入 timing。脚本逐命令检查退出码，避免后序成功掩盖前序失败。
- `labs/jpms-spi`：三个 named modules 以 `uses/provides` 发现 provider，host 验证实现包未 export。
- `NioProtocolLab`：中文 UTF-8 length frame 经碎片输入完整恢复，3-byte 部分写共 9 次排空；`FileChannelLab` 循环 transferTo 并校验 6,400 bytes。
- `labs/spring-runtime`（Boot 4.1.0 / Framework 7.0.8）：Bean 生命周期精确顺序通过；自调用与跨 Bean `REQUIRES_NEW` 得到物理 begin `1 + 2`；MVC/WebFlux 两条 handler 路径通过。
- 自定义 auto-configuration 验证默认、属性绑定、用户 Bean backoff、disabled 四种上下文；`BootStartupLab` 本机约 979 ms、109 个 StartupStep；configuration processor 实际生成两项 metadata。
- `labs/jdbc-pool`：HikariCP 7.0.2 maximum=2，持有两连接后第三借用约 265 ms 超时；参数绑定、batch、ResultSet 通过。
- `CacheRaceLab` 确定性复现旧值回填并由 version tombstone 拒绝；`FencedLockLab` 拒绝过期旧 owner；`IdempotencyOutboxLab` 验证 lost response 重试、outbox 重投与 inbox 去重。
- `labs/data-systems` 提供 MySQL 8.4/Redis 8.2/Kafka 4.1.0 外部定义；Docker daemon 未运行，未记为实测证据。

## 4. 未解决问题

1. **压缩指针对照**：默认 compressed 模式已实测；关闭 oops/class pointers 的外部 JVM 对照尚未记录到本台账。
2. **Linux 特有证据**：`perf/pidstat/strace/cgroup` 需在 Linux 实验环境完成；Windows 结果不代替。
3. **native-thread / GC-overhead**：前者需安全容器；后者依赖 collector heuristic，需固定 flags/版本并记录“未复现”可能性。
4. **JDK 25 差异实验**：当前只依据官方 JEP 标注，尚未用 JDK 25 binary 运行 Compact Headers 对照。
5. **综合项目**：`java-agent-runtime` 尚未开始，必须按章节依赖逐阶段实现，不能先生成空模块。

## 5. 待完成章节（按依赖队列）

### 第二轮：补齐语言/JVM/并发主线（已完成）

`03`、`09`–`14`、`16`–`18` 的正文与配套实验已完成并复验。

### 第三轮：运行时扩展与 Java 后端

`19-reflection-proxy-bytecode`、`20-module-spi-plugin`、`21-java-io-nio-network`、`22-http-servlet-web`、`23-spring-ioc`、`24-spring-aop-transaction`、`25-spring-boot`、`26-jdbc-connection-pool`、`27-mysql`、`28-redis`、`29-message-queue`、`30-distributed-system`。

### 第四轮：Java Agent 专项

`31-llm-application`、`32-rag`、`33-tool-calling-and-mcp`、`34-agent-architecture`、`35-agent-concurrency`、`36-agent-idempotency`、`37-agent-memory`、`38-agent-sandbox`、`39-agent-event-stream`、`40-java-agent-frameworks`。

### 第五轮：生产排障、源码、题库与综合项目

`41-jvm-observability`、`42-cpu-troubleshooting`、`43-memory-troubleshooting`、`44-thread-troubleshooting`、`45-gc-troubleshooting`、`46-source-reading-guide`、`47-interview-questions`、`48-agent-runtime-project`，以及 `examples/benchmarks/labs/java-agent-runtime` 的持续扩展。

## 6. 下一步任务

进入第三轮：依次完成 19 反射/代理/字节码增强、20 JPMS/SPI/插件、21 I/O/NIO/网络，再构建 HTTP/Spring/数据/分布式主线。每章继续执行“正文 + 可运行实验 + 输出核验 + 台账”质量门。
