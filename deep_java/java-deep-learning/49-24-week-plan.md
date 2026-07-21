# 49｜24 周学习计划：每周都留下代码、证据和 Agent Runtime 增量

> 优先级：S｜投入：每周 10–12 小时｜基线：JDK 21｜原则：先预测、再实验、后工程化

## 1. 固定周节奏

每周建议：正文精读 3h，字节码/JVM 实验 2h，源码 1.5h，编码与测试 3h，排障/复盘 1.5h。若时间不足，减少选读，不删除实验、测试和验收。所有产物记录 `java -version`、命令、参数和原始输出摘要。

综合项目 `48-java-agent-runtime-project.md` 将在后续轮次创建；计划中的项目任务是其阶段增量，不用一次搭空壳多模块。

## 第 1 周｜平台契约与可复现环境

- **主题/核心问题**：Java 的可移植契约在哪一层？规范、HotSpot 与 OS 如何分界？
- **必读**：[00](00-learning-map.md)、[01](01-java-language-design.md)、README 版本基线。
- **字节码实验**：`--release 17/21` 编译同一类，比较 major version、API 可见性与 CP。
- **JVM 实验**：`-XshowSettings:vm/properties`、`-Xlog:class+load` 建环境快照。
- **源码阅读**：JDK `LauncherHelper` 只追 main 定位路径，画调用图，不逐行抄。
- **编码任务**：编写 environment probe，输出 VM/vendor/OS/charset/timezone/CPU/container hints。
- **排障任务**：复现 `UnsupportedClassVersionError`，用 `javap -v` 定位。
- **Agent 项目**：建立 ADR-001，固定 JDK、JSON/HTTP 库选择原则与版本升级门。
- **自测题**：JVM 为何跨平台？WORA 的五个边界？LTS 是谁的承诺？
- **产出/验收**：环境清单、两份 Class diff、错误复盘；换机器能按说明复现。

## 第 2 周｜值、类型、String 与现代语法

- **主题/核心问题**：引用为何不是地址？值传递、浮点与文本长度如何准确建模？
- **必读**：[02](02-type-system-and-core-syntax.md)，选读后续泛型/异常章节规划。
- **字节码实验**：分析 `ValueSemanticsLab` 的 slot、装箱、String concat bootstrap。
- **JVM 实验**：JFR 记录循环装箱/拼接 allocation，对照 primitive/StringBuilder。
- **源码阅读**：`String`、`Integer.valueOf`，回答字段、核心路径、版本边界。
- **编码任务**：实现 byte-limited UTF-8 stream accumulator，不能截断多字节序列。
- **排障任务**：复现 `Integer ==`、拆箱 NPE、emoji 截断和金额浮点错误。
- **Agent 项目**：定义 `ModelRequest/TokenUsage/ModelError` records，构造时校验并 defensive copy。
- **自测题**：`new String` 几个对象为何不能固定答？record 是否深不可变？
- **产出/验收**：错误/正确成对测试；输入含 surrogate pair、超限与空值均通过。

## 第 3 周｜OOP、分派、泛型与异常

- **主题/核心问题**：重载何时决定、重写如何分派、擦除怎样保持多态、失败如何穿栈？
- **必读**：规划章 03、12、13；同步复习 [04](04-javac-and-compilation.md) 解糖部分。
- **字节码实验**：五类 invoke、bridge/synthetic、`athrow`、exception table、suppressed。
- **JVM 实验**：JFR 比较正常返回与创建/抛出异常的分配和 CPU，禁止用异常控正常流。
- **源码阅读**：`Throwable.fillInStackTrace`、`AutoCloseable`，定位 native/Java 边界。
- **编码任务**：设计 sealed `AgentFailure`，区分 retryable、cancelled、result-unknown。
- **排障任务**：复现泛型 heap pollution 与 TWR close 覆盖错误，再修复。
- **Agent 项目**：错误代数进入 model/tool 接口，保留 cause、attempt、remote request id。
- **自测题**：bridge 为何必要？override 为何不是多分派？超时等于失败吗？
- **产出/验收**：Class 分析报告 + 错误映射测试；未知结果不能自动标可重试。

## 第 4 周｜javac、AST 与注解处理

- **主题/核心问题**：源码如何经历符号归因、推断、Flow、处理 rounds 与解糖？
- **必读**：[04](04-javac-and-compilation.md)。
- **字节码实验**：对比 lambda/匿名类、record、enum、TWR、dense/sparse switch。
- **JVM 实验**：测 clean/incremental build 时间；更改内联常量后运行未重编客户端。
- **源码阅读**：javac `JavaCompiler/Attr/Flow/TransTypes/Lower` 只跟一份样例。
- **编码任务**：运行并扩展 `labs/annotation-processor`，生成 Tool descriptor 与校验器。
- **排障任务**：处理器重复生成、漏 originating element、运行期 processorpath 不一致。
- **Agent 项目**：编译期生成 Tool Registry 元数据，但运行时仍执行权限/参数检查。
- **自测题**：`--release` 比 `-source` 多约束什么？processor 能否安全改任意 AST？
- **产出/验收**：round 日志、generated source、clean build；生成输出确定且可重现。

## 第 5 周｜Class 文件与字节码阅读

- **主题/核心问题**：CP、descriptor、frame 与 verifier 如何构成可执行证明？
- **必读**：[05](05-class-file-and-bytecode.md)。
- **字节码实验**：手算 `InvocationLab` stack/locals，展开 Methodref 与 BootstrapMethods。
- **JVM 实验**：隔离破坏 StackMapTable/descriptor，捕获并解释 `VerifyError`。
- **源码阅读**：JVMS 4/6 为主；源码只追 ClassFileParser 的顶层校验入口。
- **编码任务**：写只读 Class header inspector，解析 magic/version/CP tag 边界并拒绝畸形输入。
- **排障任务**：构造编译期/运行期 jar ABI 不同导致 `NoSuchMethodError`。
- **Agent 项目**：启动时扫描插件 ABI major/API descriptor，失败前置且给结构化错误。
- **自测题**：Signature 是否参与 JVM 方法解析？max_stack 是否为线程栈？
- **产出/验收**：逐指令表、CFG、畸形输入测试；不执行待检查 Class。

## 第 6 周｜类加载、SPI 与插件系统

- **主题/核心问题**：同名类何时不同？父发现子、隔离与卸载为何困难？
- **必读**：[06](06-class-loading.md)，规划章 20。
- **字节码实验**：观察 `<clinit>`、ConstantValue、NestHost/NestMembers、Module 属性。
- **JVM 实验**：运行 `classloader-plugin`，记录 class load/unload 与错误初始化状态。
- **源码阅读**：`ClassLoader.loadClass`、`URLClassLoader.close`、`ServiceLoader` lazy iterator。
- **编码任务**：为插件增加 API version、provider id、生命周期 close 与超时卸载报告。
- **排障任务**：私带 API 复现 `X cannot be cast to X`；线程保留 loader 复现 metaspace 增长。
- **Agent 项目**：Tool Provider 独立 loader；共享 API parent-first，私有依赖隔离。
- **自测题**：defining/initiating loader 区别？close 后为何未必 unload？
- **产出/验收**：v1/v2 并存、错误插件隔离、无遗留线程；输出 loader/code source 证据。

## 第 7 周｜运行时数据区与内存对账

- **主题/核心问题**：heap、metaspace、direct、stack、code cache 和 RSS 怎样区分？
- **必读**：[07](07-jvm-runtime-areas.md)。
- **字节码实验**：把 frame `max_locals/max_stack` 与递归深度分开记录。
- **JVM 实验**：在隔离进程制造 stack/heap/metaspace/direct OOM；线程耗尽只在 pids 限制容器。
- **源码阅读**：`DirectByteBuffer`/Cleaner；HotSpot NMT 分类文档而非盲读 allocator。
- **编码任务**：写 memory snapshot endpoint，采集 heap/direct/class/thread/code cache。
- **排障任务**：构造 heap used 低但 direct/RSS 高，做 NMT/OS 对账。
- **Agent 项目**：定义每 run 的 byte/event/tool-output/并发预算。
- **自测题**：Xmx 1G 为何 RSS 可 2G？GC 后 RSS 不降是否泄漏？
- **产出/验收**：四类 OOM 证据包与对账表；每类给不同修复，不一律调 Xmx。

## 第 8 周｜对象布局、分配、GC 与 JIT

- **主题/核心问题**：对象真实大小、分配消除、收集与热点编译如何互相影响？
- **必读**：[08](08-object-layout.md)，规划章 09–11。
- **字节码实验**：对比 allocation 源码与字节码；证明仅凭 `new` 不能判断最终 heap allocation。
- **JVM 实验**：JOL 压缩指针对照、GC log、JFR allocation、`PrintCompilation`/JITWatch。
- **源码阅读**：`Reference`、目标 collector 文档、C2 allocation/escape 只追关键路径。
- **编码任务**：创建正确/错误 JMH，消费结果、fork、记录 alloc/op；加入大对象/短命对象对照。
- **排障任务**：高 allocation 导致 Young GC；从日志到 allocation stack 再到代码修复。
- **Agent 项目**：优化流事件对象和 prompt buffer，保持上限与语义测试。
- **自测题**：标量替换为何不等于传统栈分配？空对象为何不是固定 16B？
- **产出/验收**：JOL/JMH/JFR 三证据一致；性能结论包含机器、误差和负载。

## 第 9 周｜JMM、volatile 与安全发布

- **主题/核心问题**：哪些跨线程观察被允许？如何用 hb 证明而非靠 sleep？
- **必读**：[15](15-java-memory-model.md)。
- **字节码实验**：检查 `ACC_VOLATILE`、monitor 指令；说明字节码不展示目标 ISA fence。
- **JVM 实验**：运行两项 JCStress；新增 volatile++ lost-update 测试。
- **源码阅读**：JLS 17.4/17.5；`VarHandle` access modes API 契约。
- **编码任务**：immutable Agent snapshot + `AtomicReference` CAS version 更新。
- **排障任务**：复现普通 HashMap/普通 flag 发布错误；画 hb 缺口后修复。
- **Agent 项目**：Run 状态转换加入 version、合法 transition 与单 owner/CAS。
- **自测题**：volatile 为什么不保证 ++？0,0 是否能证明重排？
- **产出/验收**：允许结果推导写在 test 前；forbidden 为零且状态机并发测试通过。

## 第 10 周｜synchronized、CAS、AQS 与并发容器

- **主题/核心问题**：竞争线程如何从 CAS 入队、park，再被正确唤醒？
- **必读**：规划章 16、17；回看 [08](08-object-layout.md) Mark Word。
- **字节码实验**：同步块/同步方法、VarHandle/CAS 调用点；画异常释放路径。
- **JVM 实验**：JFR monitor/park，JCStress ABA/LongAdder 语义；JOL 锁状态只作目标版本观察。
- **源码阅读**：`AbstractQueuedSynchronizer.acquire/release`、`ReentrantLock.Sync`。
- **编码任务**：基于 AQS 实现一次性 Gate，含中断、超时和单元/压力测试。
- **排障任务**：死锁、notify 丢条件、锁竞争；thread dump + JFR 双证据。
- **Agent 项目**：per-tool Semaphore bulkhead，等待尊重 deadline/interrupt。
- **自测题**：AQS 队列为何不是业务公平保证？CAS 的 ABA 何时有害？
- **产出/验收**：同步器无 busy wait、超时不泄漏 permit、取消路径测试通过。

## 第 11 周｜线程池、CompletableFuture 与虚拟线程

- **主题/核心问题**：并发边界应设在线程、队列还是下游资源？
- **必读**：规划章 18。
- **字节码实验**：lambda task/CF 链的 invokedynamic；异常 stage 的 handler 结构。
- **JVM 实验**：有界/无界队列、平台/虚拟线程、pinning JFR 对照。
- **源码阅读**：`ThreadPoolExecutor.execute/addWorker/getTask`、`CompletableFuture` completion stack。
- **编码任务**：Deadline API、取消传播、并发 tool fan-out + ALL/ANY join。
- **排障任务**：commonPool 被阻塞、线程池耗尽、ThreadLocal 泄漏、pinning。
- **Agent 项目**：Agent 总预算分配到模型/RAG/Tool，任一取消向子任务传播。
- **自测题**：虚拟线程为何不等于无限并发？CF cancel 是否一定中断底层 I/O？
- **产出/验收**：故障注入后无活跃子任务；队列/permit/连接数都有上限。

## 第 12 周｜反射、代理、模块与字节码增强

- **主题/核心问题**：框架如何插入行为，模块边界和代理 self-invocation 为何失效？
- **必读**：规划章 19、20。
- **字节码实验**：JDK proxy class、CGLIB/Byte Buddy subclass、Java Agent transformer 前后 diff。
- **JVM 实验**：反射/MethodHandle/JMH（有预热）；动态类数量与 metaspace。
- **源码阅读**：`Proxy`、`MethodHandles.Lookup`、`ServiceLoader`、Instrumentation API。
- **编码任务**：method interceptor 链，支持 before/after/error 且保留原异常。
- **排障任务**：final/private 方法无法拦截、module access、代理类 loader 冲突。
- **Agent 项目**：Tool annotation → descriptor → interceptor（auth/timeout/metrics/audit）。
- **自测题**：JDK proxy 为什么围绕接口？MethodHandle 与传统反射边界？
- **产出/验收**：代理行为/异常/并发测试；无无界动态类生成。

## 第 13 周｜I/O、NIO、TCP 与背压

- **主题/核心问题**：buffer/channel/selector 怎样映射 OS，慢消费者如何反压？
- **必读**：规划章 21、22 的 HTTP 基础。
- **字节码实验**：try-with-resources 关闭路径；ByteBuffer 调用 descriptor 与 direct wrapper。
- **JVM 实验**：heap/direct buffer、blocking/NIO、文件流式/全量读取 JFR 对照。
- **源码阅读**：`Selector` provider、`SocketChannel`、`DirectByteBuffer` 关键路径。
- **编码任务**：有界 SSE line parser，处理 CRLF、跨 buffer UTF-8、最大事件、取消。
- **排障任务**：半包/粘包、stdout/stderr 未排空、fd 泄漏、慢 consumer buffer 增长。
- **Agent 项目**：model-client transport + SSE decoder，不解析业务 JSON 前越界。
- **自测题**：Selector 是否等于 epoll？零拷贝“零”的边界？
- **产出/验收**：随机分片/property test、超大事件拒绝、断连后资源归零。

## 第 14 周｜HTTP、Servlet、MVC 与 WebFlux

- **主题/核心问题**：一次请求穿过哪些连接、队列、线程和超时？
- **必读**：规划章 22。
- **字节码实验**：controller 参数/annotation metadata、reactive lambda call sites。
- **JVM 实验**：Servlet 平台线程/虚拟线程/WebFlux 同负载延迟与资源曲线。
- **源码阅读**：`DispatcherServlet.doDispatch`、HandlerMapping/Adapter；Reactor request/demand。
- **编码任务**：SSE API，支持 Last-Event-ID、heartbeat、断开取消与敏感字段过滤。
- **排障任务**：WebFlux event loop 阻塞、连接池枯竭、客户端断开后台仍运行。
- **Agent 项目**：api-server 创建/cancel/query run，事件 endpoint 只读持久事件。
- **自测题**：chunked/SSE/WebSocket 区别？虚拟线程是否消除连接池限制？
- **产出/验收**：三模型容量报告；结论基于同业务/硬件，不宣称绝对赢家。

## 第 15 周｜Spring IoC、AOP、事务与 Boot

- **主题/核心问题**：Bean 元数据如何成为代理实例，事务上下文为何绑定调用边界？
- **必读**：规划章 23–25。
- **字节码实验**：配置类/代理、`@Transactional` 调用点；自调用是否经过 proxy。
- **JVM 实验**：ApplicationStartup/JFR 定位 bean 初始化与 class loading 热点。
- **源码阅读**：`DefaultListableBeanFactory`、`AbstractAutowireCapableBeanFactory`、`TransactionInterceptor`。
- **编码任务**：简化 IoC + 构造注入 + proxy transaction，另写 Boot Starter。
- **排障任务**：循环依赖、self-invocation、catch 后不回滚、事务内远程调用。
- **Agent 项目**：通过配置绑定组装 providers，启动时验证 capability/secret 引用。
- **自测题**：三级缓存解决的真实一致性问题？虚拟线程改变事务语义吗？
- **产出/验收**：Bean 生命周期 trace、失效复现测试、Starter 条件装配测试。

## 第 16 周｜JDBC、连接池、MySQL 事务与索引

- **主题/核心问题**：Java 请求从 pool 到 InnoDB 的等待与锁发生在哪里？
- **必读**：规划章 26、27。
- **字节码实验**：TWR connection/statement/result set 的逆序关闭与异常表。
- **JVM 实验**：JFR socket/lock + pool metrics；流式/全量 ResultSet 内存对照。
- **源码阅读**：Hikari `ConcurrentBag`、Spring connection binding；MySQL 官方执行计划文档。
- **编码任务**：Run/Step schema、乐观锁 version、事务内状态转移与唯一 idempotency key。
- **排障任务**：慢 SQL、连接泄漏、pool exhaustion、死锁与长事务。
- **Agent 项目**：persistence 模块保存 run/step/tool call，禁止事务内调用模型/Tool。
- **自测题**：pool 越大为何可能更慢？超时后 SQL 是否一定停止？
- **产出/验收**：执行计划与锁时间线；故障后事务一致且连接归还。

## 第 17 周｜Redis、MQ 与分布式失败语义

- **主题/核心问题**：cache/MQ 的重复、丢失与结果未知怎样转为业务正确？
- **必读**：规划章 28–30。
- **字节码实验**：序列化 DTO descriptor/record schema 演进，验证旧消息兼容。
- **JVM 实验**：消息堆积对 heap/allocation/GC 的影响；有界 consumer 并发。
- **源码阅读**：选定 client 的 connection/event-loop；Kafka/Rabbit 官方语义文档。
- **编码任务**：transactional outbox + idempotent consumer + retry/dead-letter policy。
- **排障任务**：cache stampede、大 key、重复投递、ack 丢失、retry amplification。
- **Agent 项目**：异步 Run queue；lease/fencing/version 防两个 worker 同领任务。
- **自测题**：Exactly Once 边界？分布式锁为何不能替代幂等？
- **产出/验收**：在 commit/ack 各故障窗口 kill 进程，恢复后业务效果不重复。

## 第 18 周｜LLM Client 与流式协议

- **主题/核心问题**：首 token、整体、连接、read timeout 和取消如何分层？
- **必读**：规划章 31；复习第 13–14 周。
- **字节码实验**：JSON record/stream callbacks 的 allocation 与 indy；不把框架 API 当原理。
- **JVM 实验**：模拟 429、慢首 token、半流断开；JFR 看连接/线程/buffer。
- **源码阅读**：JDK `HttpClient` sendAsync/cancel 路径或固定版本 SDK transport。
- **编码任务**：model-client，支持 SSE、schema validation、Retry-After、usage/cost、取消。
- **排障任务**：连接池耗尽、重试风暴、流关闭未释放、部分响应误当成功。
- **Agent 项目**：阶段 1 完成，ModelError 标明 retryable 与 response_started。
- **自测题**：为什么模型调用不是普通 HTTP？流开始后还能透明重试吗？
- **产出/验收**：wiremock/fake server 故障矩阵；所有 deadline/连接均回收。

## 第 19 周｜RAG 数据与检索系统

- **主题/核心问题**：错误来自解析、chunk、召回、权限过滤还是生成？
- **必读**：规划章 32。
- **字节码实验**：primitive float[] 与 boxed vector 集合的 layout/allocation 对照。
- **JVM 实验**：JFR 测批量 embedding 并发、文件流式解析、top-k 分配。
- **源码阅读**：选定 HNSW/Vector Store 的 insert/search 关键路径与 snapshot 语义。
- **编码任务**：流式 loader→chunk→bounded embedding→store→hybrid retrieve→citation。
- **排障任务**：OOM、N+1、过滤后零召回、删除不彻底、跨租户结果。
- **Agent 项目**：rag-engine 保存 document/chunk/version/ACL/embedding model lineage。
- **自测题**：cosine/dot 何时等价？ANN recall 与过滤如何交互？
- **产出/验收**：固定 evidence set 的 Recall@k/nDCG/latency/cost；权限负面测试 100% 拦截。

## 第 20 周｜Tool Calling、MCP 与 Sandbox

- **主题/核心问题**：模型提议如何变成最小权限、可审计且资源有界的动作？
- **必读**：规划章 33、38。
- **字节码实验**：Tool adapter proxy/annotation schema；ProcessBuilder 无 shell 与 shell 调用差异。
- **JVM 实验**：子进程 stdout/stderr 背压、超时、进程树终止、direct/heap buffer 上限。
- **源码阅读**：`ProcessImpl/ProcessHandle`；MCP 固定规范的 initialize/capability/transport。
- **编码任务**：Tool Registry + JSON Schema + policy decision + bounded Code Runner。
- **排障任务**：shell injection、path traversal、SSRF、父死子活、输出管道死锁。
- **Agent 项目**：tool-runtime/sandbox-client；proposal hash 与审批绑定 resource version。
- **自测题**：Docker 默认为何非强 Sandbox？模型能否决定自己的权限？
- **产出/验收**：攻击测试、CPU/memory/pids/output/network 限制证据；超时后进程树为空。

## 第 21 周｜Agent 状态机、并发、取消与幂等

- **主题/核心问题**：crash/retry/cancel 后怎样有限终止且不重复副作用？
- **必读**：规划章 34–36。
- **字节码实验**：sealed state switch 穷尽性、CAS/version 更新调用点。
- **JVM 实验**：并发 tool fan-out、interrupt/HTTP/process cancel，JCStress 状态转移。
- **源码阅读**：`FutureTask` state/cancel、Structured Concurrency 当前 JDK 状态需固定版本。
- **编码任务**：Agent loop + transition table + deadline budget + checkpoint + outbox。
- **排障任务**：模型重复 Tool、worker crash after effect/before ack、双 worker claim。
- **Agent 项目**：阶段 3–5/8 核心闭环；side effect 有 idempotency key 与 reconciliation。
- **自测题**：模型调用可重试为何不代表副作用可重试？interrupt 为何非强杀？
- **产出/验收**：逐故障窗口 kill/replay；状态合法、效果至多一次或可对账。

## 第 22 周｜Memory、事件流与框架分析

- **主题/核心问题**：长期状态如何保真/删除，事件如何重放，框架抽象边界何在？
- **必读**：规划章 37、39、40。
- **字节码实验**：框架 auto-config/proxy/stream callback 产物，识别框架特定层。
- **JVM 实验**：慢 SSE consumer、断线重连、event buffer/Memory 检索 allocation。
- **源码阅读**：固定版本 Spring AI/LangChain4j 的 model/tool/memory/stream 扩展点。
- **编码任务**：event sequence/store/replay/heartbeat；Memory 双时间/version/delete lineage。
- **排障任务**：重复事件、摘要失真、记忆冲突/注入、跨租户与慢 consumer。
- **Agent 项目**：memory-service + event-stream；客户端按 sequence 幂等应用。
- **自测题**：checkpoint 与 conversation memory 区别？框架 retry 能保证业务幂等吗？
- **产出/验收**：断线/重复/乱序测试；删除后检索、cache、备份路径有证据。

## 第 23 周｜JVM 可观测性与四类排障

- **主题/核心问题**：CPU、内存、线程、GC 的症状如何落到代码因果链？
- **必读**：规划章 41–45。
- **字节码实验**：用 `javap` 将 stack frame/nid 热点回到准确 overload/line。
- **JVM 实验**：JFR、async-profiler、NMT、heap/thread dump、GC log 的安全采集。
- **源码阅读**：`ThreadPoolExecutor/AQS/ConcurrentHashMap` 针对事故栈追核心状态。
- **编码任务**：observability 模块：run/step/model/tool trace，queue/pool/GC 指标与结构化日志。
- **排障任务**：CPU loop、heap retention、pool starvation、G1 humongous 各一完整剧本。
- **Agent 项目**：关联 runId/stepId/toolCallId 与 trace，不记录敏感 prompt/tool output 默认正文。
- **自测题**：profile flat/cum？heap used 与 RSS？WAITING 是正常还是耗尽？
- **产出/验收**：四份时间线“现象→指标→证据→代码→同负载修复验证”，无拍脑袋调参。

## 第 24 周｜综合验收、源码答辩与容量演练

- **主题/核心问题**：系统能否在并发、故障、攻击和版本变化下守住不变量？
- **必读**：规划章 46–48，回顾 S 级检查清单。
- **字节码实验**：随机抽一个项目关键类，现场完成 descriptor/CFG/invoke/bootstrap 分析。
- **JVM 实验**：完整负载下 JFR+GC log+NMT baseline；冷/热、稳态/过载对照。
- **源码阅读**：从一次 run trace 反向追 JDK/Spring 三条关键路径，回答扩展点/锁/失败。
- **编码任务**：完成 API、Agent loop、Tool、RAG、Memory、Sandbox、Event、Persistence、Obs 集成。
- **排障任务**：下游慢、429、DB deadlock、worker kill、SSE 断线、Sandbox 逃逸尝试的 game day。
- **Agent 项目**：写架构决策、威胁模型、SLO、容量 knee、恢复手册与升级策略。
- **自测题**：从 47 章随机抽题，回答必须含层次、反例、工具和版本边界。
- **产出/验收**：所有自动测试、故障注入、安全负面测试和恢复验收通过；无无限队列/线程/输出，副作用可对账。

## 2. 24 周毕业门

不能用“读完”验收。毕业证据至少包括：

1. 10 份带完整命令的字节码分析，覆盖 invoke/bridge/indy/exception/monitor/switch。
2. 6 类受控 JVM 失败、4 类生产事故的证据链与修复复验。
3. JOL、JMH、JCStress 各一份解释边界正确的报告。
4. 至少 12 个 JDK/Spring 源码问题卡，每张含契约、状态、并发、失败、实验。
5. `java-agent-runtime` 十阶段能力中，核心链路可运行且 crash/replay/cancel 安全。
6. 任何框架/版本性主张都记录版本和一手来源；任何性能数字都记录环境与负载。

若某周验收未通过，下周先补证据再扩功能。累计代码量和 Markdown 行数都不是能力标准。
