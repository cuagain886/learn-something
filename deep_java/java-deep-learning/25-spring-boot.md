# 25. Spring Boot 自动配置与启动：条件化组装、可执行包和启动诊断

> 优先级：A｜难度：★★★★☆｜基线：Spring Boot 4.1.0 / Framework 7.0.8 / JDK 21｜前置：[23 IoC](23-spring-ioc.md)、[24 AOP/事务](24-spring-aop-transaction.md)

## 1. 本章目标

完成后能按事件和 context refresh 解释 `SpringApplication.run`；能读 AutoConfiguration.imports 和 ConditionEvaluationReport；能写配置属性、条件 backoff 和 starter；能解释 executable JAR 的 loader/classpath；能用 ApplicationStartup/JFR 定位慢 bean，而不是只开 lazy initialization。

## 2. Boot 解决的是组装，不是替代 Spring

Boot 用依赖管理、starters、外部配置、auto-configuration、嵌入式 server 和生产运维约定降低组装成本。BeanDefinition、BPP、AOP 和事务仍由 Spring Framework 执行；Tomcat/Netty、Jackson、数据库驱动仍有自己的容量与版本。

`@SpringBootApplication` 组合 `@SpringBootConfiguration`、`@EnableAutoConfiguration` 和 component scan。主类所在 package 是默认 scan/auto-config package 根，放在过深/默认包会漏扫或全盘扫描。

## 3. SpringApplication 主启动阶段

精简因果链：

```text
构造 SpringApplication：推断 application type / primary sources
 → run listeners：starting
 → 准备 Environment、ConfigData、profiles、绑定 SpringApplication
 → environment-prepared
 → 创建对应 ApplicationContext（NONE/SERVLET/REACTIVE）
 → initializers
 → 加载 primary sources/definitions
 → context.refresh：BFPP/BPP/singletons/web server
 → started + liveness correct
 → ApplicationRunner / CommandLineRunner
 → ready + readiness accepting traffic
```

失败在任意阶段发布 failed event，并交 FailureAnalyzers 生成 description/action。某些早期事件发生在 context 创建前，不能只注册 `@Bean ApplicationListener`；需 `SpringApplication.addListeners` 或对应启动元数据。

事件 listener 默认同线程执行，做长远程调用会直接拖慢启动。需要启动任务用 runner，并定义 readiness 前是否必须完成；不把无限 warmup 放 `@PostConstruct`。

## 4. WebApplicationType 与嵌入式 server

Boot 依据 classpath 推断 servlet/reactive/none；当 MVC 和 WebFlux 同时存在时，默认选择规则由当前 Boot 文档定义，实验/混合 client 依赖时应显式设置。选错会创建不同 context、server 与自动配置。

Servlet context refresh 中创建 WebServer factory 和 Tomcat 11（Boot 4.1 默认支持 Servlet 6.1 线），启动 connector 并发布 WebServerInitializedEvent。端口可用不等于业务 ready；runners 完成后才进入 readiness accepting traffic。

graceful shutdown 先拒绝/排空请求，再关闭 context/beans；平台终止宽限要大于应用 grace，Agent 子进程和流 subscriber 也必须在 SmartLifecycle stop 内有界结束。

## 5. 自动配置候选从哪里来

Boot 4 auto-configuration JAR 在：

```text
META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
```

逐行列 `@AutoConfiguration` class。Import selector 收集/去重/排序候选，条件在定义阶段筛选。旧文章只讲 `spring.factories` 的 EnableAutoConfiguration key 已不适合作为当前唯一入口；listeners/initializers 等其他扩展仍可能使用相应 factories 机制。

auto-config class 是普通配置类加 ordering/conditions。不要 component scan 它，也不要让用户依赖内部 nested configuration；对外支持面通常是配置属性、生成的 bean 类型与可 exclude 的 auto-config class name。

## 6. 条件不是运行时 if

常用条件：OnClass/MissingClass、OnBean/MissingBean、OnProperty、OnResource、OnWebApplication。class 条件可借 ASM metadata 在不加载候选类时判断，避免缺类直接 linkage error。

`@ConditionalOnMissingBean` 的结果依赖当前已处理 definitions，因此放 auto-config 让其在用户配置后评估；bean method 返回类型应尽量具体，让条件能在实例化前推断。条件不是动态开关：context refresh 后改 property 通常不会自动删/建 bean。

`--debug` 或 ConditionEvaluationReport 显示 positive/negative matches。报告的“not matched”多为正常 backoff，不是错误；真正问题是期望条件与 classpath/property/bean definition 不一致。

## 7. 手写 starter/auto-configuration 的结构

生产常分：

```text
deepjava-agent-spring-boot-autoconfigure
  ├─ AgentProperties
  ├─ AgentAutoConfiguration
  └─ AutoConfiguration.imports
deepjava-agent-spring-boot-starter
  └─ 仅依赖 autoconfigure + 推荐 runtime dependencies
```

starter 是依赖/体验入口，通常不含业务代码；auto-config 独立便于用户只取配置。第三方 artifact 不使用 `spring-boot-*` 官方前缀。

仓库 [spring-runtime](labs/spring-runtime) 把这两个角色合在一个教学 JAR：真实 imports 文件、`@AutoConfiguration`、`@ConditionalOnMissingBean`、property condition 和 `@EnableConfigurationProperties` 都可运行。产品化时按上图拆 artifact。

## 8. 类型安全配置绑定

`@ConfigurationProperties("deepjava.agent")` 把层级 property 绑定为对象，支持转换、validation、metadata，比散落 `@Value` 更适合模块配置。不可变构造绑定降低半初始化；敏感值的 `toString`/Actuator 必须脱敏。

仓库 `AgentProperties` 有 enabled/provider；processor 生成 configuration metadata。实验覆盖：

- 缺配置：默认 `auto:local`；
- `provider=remote`：绑定得到 `auto:remote`；
- 用户 AgentClient bean：missing-bean 条件 backoff，只留 `user`；
- `enabled=false`：property condition 不注册 client。

配置的默认值属于兼容契约。把默认 timeout 从 5s 改 60s 会改变容量和故障恢复，即使 Java API 未变。

## 9. 外部配置与优先级

Boot ConfigData 在 Environment 准备阶段处理 application properties/yaml、profile variants、imports 等；命令行、system/env、测试和默认属性有明确但版本相关的优先级。排查“配置为何没生效”要看 property origin/active profiles，不凭文件名猜。

环境变量 key 映射和 YAML 类型有边界；duration/data size 用 `10s/64MiB` 等明确单位。部署系统注入 secret，配置文件只引用；不要在 condition report、startup log 和 `/env` 暴露 token。

远程配置失败策略要明确：启动 fail-fast、使用 last-known-good，还是以 not-ready 等待；静默回默认可能把生产模型切到错误 provider。

## 10. Runner、事件和可用性

ApplicationRunner 得到解析后的 ApplicationArguments，CommandLineRunner 得 string array，均在 context refreshed/server started 后、ready 前执行，可排序。runner 抛异常使启动失败。

数据库 migration、关键 schema 校验适合 readiness 前完成；大缓存预热若可渐进，不应阻塞所有启动。liveness 只反映进程内部不可恢复状态，不应因下游 DB 挂就重启全部实例；readiness 可因过载/必要依赖暂时拒流。

父子 context 会让 listener 收到多次层级事件；比较 event context，避免重复执行副作用。

## 11. Fat JAR 与 Boot Loader

普通 JVM classpath 不从嵌套 JAR 直接加载。Boot executable JAR 通常布局：

```text
META-INF/MANIFEST.MF
BOOT-INF/classes/      application classes/resources
BOOT-INF/lib/*.jar     dependencies
org/springframework/boot/loader/... launcher
```

manifest 的 Main-Class 指 launcher，Start-Class 指应用 main。Boot Loader 构造支持 nested jars 的 classpath/loader 后调用应用。它不把所有依赖 class 合并成一个文件；与 shade uber-JAR 的 package/resource 合并方式不同。

`java -jar` 时 `-cp` 通常不按普通方式参与，外置 loader path/layertools 需按 Boot 当前文档。容器镜像可分 layers：依赖稳定层、应用变化层，提高 cache；snapshot/loader/application layer 顺序影响构建效率，不影响 Java 语义。

## 12. 版本管理与 Boot 4 边界

本仓库使用 2026-07-20 官方稳定 Boot 4.1.0，要求 Java ≥17、支持到 26，Framework ≥7.0.8；实验运行 JDK 21。Boot BOM/parent 管理受支持依赖组合，不等于所有 CVE 自动安全，也不应随意 override 单个核心依赖造成不兼容。

Boot 4 相对 3 有模块/starter 与 Jakarta/Servlet 基线演进；例如教学 POM 尝试沿用旧 `spring-boot-starter-aop` 未被 4.1 BOM 管理，改用实际所需 `spring-aop`。迁移必须跑 dependency tree、编译、context tests 与真实 server tests，不能只改 parent version。

## 13. 启动耗时如何定位

总 “Started in X seconds” 只能看回归。使用：

1. `ApplicationStartup` 记录 StartupStep；Boot `BufferingApplicationStartup` 可给 Actuator `/startup`，有容量上限；
2. `FlightRecorderApplicationStartup` 把 Spring steps 与 class loading、JIT、allocation、GC、I/O 关联；
3. condition report 看候选数量/backoff；
4. JFR/async-profiler 找扫描、解压、网络、bean init 热点；
5. 对照禁用单个 starter/auto-config，而不是全开 lazy。

仓库 `BootStartupLab` 用 NONE context + BufferingApplicationStartup，实际验证自动配置 client，打印 wall-clock elapsed 与非空 startup event 数。数字只用于当前机器冒烟；稳定比较需相同 cold/warm filesystem cache、JDK、JAR、CPU 和多次分布。

慢 bean 常见：`@PostConstruct` 远程 I/O、扫描范围过大、数据库 migration、熵/DNS、证书、重复 context、过多代理和 class loading。给每个外部初始化 deadline，并决定失败是否阻止 readiness。

## 14. Lazy、AOT 与 native image

全局 lazy 能缩短启动表面时间，但把配置错误、类缺失、首用分配推到真实流量；内存最终仍需容纳使用到的 beans。更优先删除无用 starter、缩小 scan、避免启动 I/O、并行化真正独立且安全的 warmup。

AOT 在构建期分析 BeanFactory、生成初始化/反射 hints，Native Image 用 closed-world 构建 native executable；动态 reflection/proxy/resource/class loading 需 metadata/hints，Agent plugin 热加载可能与 closed world 冲突。AOT 改变启动/内存与动态性，不使 DB/MQ/Tool 状态机自动正确。

## 15. Agent Boot 自动配置

条件可按 classpath/property 注册 provider client，但不要让“检测到 SDK”就自动启用真实外呼；还需 enabled、凭据、endpoint allowlist 和启动校验。用户 bean 应 backoff，避免两个 model clients 都接流量。

配置属性包括 connect/header/idle/overall timeout、max concurrency、queue、retry attempts、model allowlist、sandbox limits；绑定时校验关系，如 queue ≥0、overall ≥ connect、maxOutputBytes 有硬上限。

Actuator 只暴露脱敏状态：provider up/down、permits、queue age、run counts；不能返回 prompt/tool args/secret。自定义 endpoint 默认不公网暴露，交 Spring Security 和网络策略。

## 16. 常见误区与检查清单

1. **Boot 自己实现 IoC/MVC**：它组装 Framework/容器。
2. **auto-config 会覆盖用户 bean**：良好配置用 missing-bean backoff，但需验证具体条件。
3. **condition 不匹配就是错误**：大量 negative match 是正常。
4. **starter 包含很多自动配置代码**：通常是依赖 facade，代码在 autoconfigure artifact。
5. **fat JAR 等于 shade 合并类**：Boot 保留 nested libraries 并用 loader。
6. **lazy 是启动优化终点**：可能延迟失败和首请求抖动。
7. **Started 日志可定位慢 bean**：需要 StartupStep/JFR/profile。

- [ ] 能按事件复述 run/refresh/runner/ready。
- [ ] 能定位 AutoConfiguration.imports 与条件报告。
- [ ] 能写 property + condition + backoff 测试。
- [ ] 能画 executable JAR loader 布局。
- [ ] 能区分 liveness/readiness 与外部依赖。
- [ ] 能用 StartupStep/JFR 找慢初始化。

## 17. 延伸阅读

- [Spring Boot 4.1 System Requirements](https://docs.spring.io/spring-boot/system-requirements.html)
- [Auto-configuration](https://docs.spring.io/spring-boot/reference/using/auto-configuration.html)
- [Creating Your Own Auto-configuration](https://docs.spring.io/spring-boot/reference/features/developing-auto-configuration.html)
- [SpringApplication lifecycle/startup](https://docs.spring.io/spring-boot/reference/features/spring-application.html)
- [Executable JAR specification](https://docs.spring.io/spring-boot/specification/executable-jar/index.html)

下一章：[26 JDBC 与连接池](26-jdbc-connection-pool.md)。
