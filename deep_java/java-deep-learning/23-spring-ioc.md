# 23. Spring IoC 与 Bean 生命周期：从定义元数据到最终代理

> 优先级：S｜难度：★★★★★｜基线：Spring Framework 7.0.8 / Boot 4.1.0｜前置：[19 反射代理](19-reflection-proxy-bytecode.md)

## 1. 本章目标

完成后能从 `BeanDefinition` 注册跟踪到 singleton 销毁；能区分 BeanFactory 扩展点、对象生命周期回调和代理创建；能从“必须注入最终一致引用”解释三级缓存，而不是背 map 名；能说明构造器循环为何失败、setter 循环为何也不推荐，以及 Boot 4 默认策略。

## 2. IoC 容器控制的是对象图

DI 把对象构造和依赖选择从业务类移到 composition root。容器管理的不是“所有 new”，而是有 BeanDefinition/注册信息的一组对象及 scope、依赖、生命周期、代理规则。

`BeanFactory` 是核心获取/创建契约；`ApplicationContext` 在其上组合资源、Environment、事件、国际化、自动注册处理器等。业务代码频繁 `applicationContext.getBean` 是 service locator，重新隐藏依赖；优先构造器参数表达必需依赖。

## 3. BeanDefinition：还不是 Bean

BeanDefinition 描述 bean class/factory method、scope、lazy、primary、qualifiers、constructor args、property values、init/destroy、role 等。来源可为 XML、`@Bean`、component scan、Import、编程注册和 Boot auto-configuration。

```text
配置源码/注解/资源
 → BeanDefinitionReader / scanner / configuration parser
 → BeanDefinitionRegistry
 → 合并父定义与后处理
 → 实例化时才产生对象
```

同名覆盖会让顺序成为隐式配置，Boot 默认通常拒绝覆盖；共享库用条件和唯一 namespace，不依赖“后注册赢”。容器 refresh 后并发动态注册新 definition 不属于普通稳定用法，可能产生不一致。

## 4. Environment、PropertySource 与 Resource

Environment 统一 profiles 与 key/value property sources；优先级决定同 key 的最终值。命令行、系统属性、环境变量、配置文件和测试 override 的顺序由 Boot 版本规则定义。日志输出 origin 而非秘密值，配置绑定失败应 fail fast。

`Resource` 抽象 classpath/file/URL 等；同一个相对路径在 FileSystemResource 与 ClassPathResource 语义不同。fat JAR 内资源通常不是普通 `File`，要用 stream，不把 `getFile()` 当通用 API。

profile 是配置选择，不是授权边界。`@Profile("prod")` 不能防攻击者通过错误启动参数加载开发 bean；秘密和网络权限由部署系统控制。

## 5. 配置类怎样变成定义

component scan 读取 class metadata 找 stereotype；范围过大会增加启动 I/O/metadata 并意外注册内部类。主应用包位置影响默认 scan，应显式模块边界。

`@Import` 可引入配置类、selector、registrar；`@Conditional` 在定义注册阶段决定是否匹配。条件应尽量基于 class/property/definition metadata，不能在条件里过早 `getBean`，否则对象跳过完整后处理。

full `@Configuration(proxyBeanMethods=true)` 常由子类代理拦截 `@Bean` 方法间调用，使调用回到容器 singleton：

```java
@Bean Client client() { return new Client(codec()); }
@Bean Codec codec() { return new Codec(); }
```

`proxyBeanMethods=false` 是 lite 模式，直接调用就是普通 Java 调用，会 new 第二个 Codec；通过方法参数注入 `client(Codec codec)` 可既关闭代理又保持容器引用。Boot auto-config 通常偏好 false 以减少代理/启动开销。

## 6. 两类最关键的工厂后处理器

`BeanDefinitionRegistryPostProcessor` 可在普通 BeanFactoryPostProcessor 前增加/修改 definitions；`BeanFactoryPostProcessor` 修改已加载定义/工厂配置。它们处理 metadata，执行时普通 singleton 尚未完整创建。

这些处理器通常必须以 static `@Bean` 注册，避免为调用实例方法而过早实例化配置类。内部调用 `getBean` 会提前创建目标，使其错过后续 BeanPostProcessor/auto-proxy，产生“注解存在但事务无效”。

后处理器排序分 PriorityOrdered、Ordered、普通；相同级别不要依赖碰巧注册顺序。扩展点自己也可能被基础设施提前创建，依赖应极小。

## 7. Bean 的主创建路径

简化但有因果顺序的 singleton 路径：

1. 合并 BeanDefinition，检查 depends-on/scope/cached singleton；
2. 选择 constructor/factory method 并实例化；
3. 可能暴露用于循环引用的 singleton factory；
4. property population / autowire；
5. Aware 回调（BeanName、BeanFactory、ApplicationContext 等由不同处理器负责）；
6. BeanPostProcessor before initialization；
7. `@PostConstruct` → `InitializingBean.afterPropertiesSet` → custom init；
8. BeanPostProcessor after initialization，auto-proxy 常在此返回代理；
9. 注册 disposable callbacks，发布可用 singleton；
10. context close 时依赖逆序销毁：`@PreDestroy` → DisposableBean → custom destroy。

“代理在第 8 步”是常见 auto-proxy 路径，不是所有处理器绝对规则；`getEarlyBeanReference` 可为循环依赖提前产生一致代理。

## 8. 可运行生命周期证据

[spring-runtime](labs/spring-runtime) 的 `BeanLifecycleLab` 注册真实 factory post-processor、bean post-processor 和同时实现三种 init/destroy 机制的 probe。

HotSpot 21 + Framework 7.0.8 实测：

```text
factory-post → constructor → aware:probe → before-init
→ post-construct → after-properties → after-init
→ pre-destroy → disposable-destroy → custom-destroy
```

实验用断言锁定顺序，不把日志肉眼看起来相邻当证明。给同一方法同时标两种 init 机制时 Spring 可能去重；生产 bean 通常选择一种不耦合机制即可。

## 9. 注入方式与依赖语义

构造器注入表达必需依赖、可 `final`、对象一创建就满足不变量，也让构造器循环直接失败。字段注入隐藏依赖、测试需容器/反射、不能 final；setter 适合真正可选/可重配置依赖，但对象在填充前暂不完整。

多候选解析用类型 → qualifier/name → primary/fallback/priority 等当前版本规则；集合注入顺序按 Ordered/注解排序。泛型可作为可解析类型信息的一部分，但运行时代理/工厂返回类型若声明过宽，会让条件和注入无法准确判断。

`Optional<T>`、`ObjectProvider<T>` 解决可选/延迟/多实例查找；不要用它们掩盖模块设计中本应必需的依赖。provider 调用点可能每次创建 prototype 或抛非唯一异常。

## 10. BeanPostProcessor 与最终对象

BPP 可修改属性、执行注解回调或返回另一个对象。Spring AOP 的 auto-proxy creator 是特殊 BPP：检查 Advisors，若匹配则返回 proxy。容器 singleton cache 对外应保存最终暴露对象，不是原 target。

如果某个 bean 在所有 BPP 注册前被提前获取，它可能“不 eligible for auto-proxying”。排查日志时找谁在 BPP 构造/FactoryPostProcessor 中注入该业务 bean，而不是给 `@Transactional` 重写一遍。

多个 BPP 包装顺序影响代理链；一个处理器返回代理后，后续处理器看到的可能是代理类型。扫描注解应考虑 target class/bridged method，而非只看 `bean.getClass()` 上生成类。

## 11. 三级 singleton 协作的真实问题

经典实现有：完整 singleton cache、early singleton objects、singleton factories。它们不是“Spring 有三个 Map 所以能循环依赖”，而是在 singleton 创建中协调两个约束：

1. A 填充依赖 B 时，B 又需要 A，必须有某个早期引用打破递归；
2. 若 A 最终需 AOP proxy，B 注入的引用必须与容器最终暴露的 A 一致，不能注入 raw A 后外部拿 proxy A。

singleton factory 延迟调用 `getEarlyBeanReference`，让 auto-proxy creator 有机会提前返回同一代理；真正有人请求早期引用时才执行。若无循环，不需要提前暴露。

## 12. 为什么循环依赖仍是设计错误

构造器循环在 A 构造需要 B、B 构造需要 A 时连 raw 对象都不存在，早期字段引用机制无法解决。setter/field 的 singleton 循环历史上可能被容器解决，但：

- 对象在 init 前被其他 bean 看见，破坏完整构造；
- async/BPP/代理组合可能造成 raw 与 proxy 不一致；
- prototype 没有 singleton early cache；
- Boot 自 2.6 起默认禁止 circular references，Boot 4.1 也不应靠打开开关设计新系统。

修复方法是重新划责任、提取第三个 coordinator/domain service、用事件打断同步图，或让一侧依赖窄 provider（仍需审查运行时循环）。`@Lazy` 代理只是推迟边，不证明架构合理。

## 13. scope、lazy 与销毁

singleton 是每 BeanFactory 一实例，不是 JVM 全局；父子 context 可能各有。prototype 每次查找创建，容器完成创建回调后不自动追踪其销毁，调用者管理资源。web request/session scope 需要活跃 web context，并以 scoped proxy 注入 singleton。

lazy singleton 首次使用才创建，把启动失败推到流量并引入首请求抖动；只对昂贵且非关键/可选组件使用，并做 readiness/warmup。`@Lazy` 注入代理还会改变类型、异常时点和线程安全。

自定义 scope 必须定义 conversation id、并发、销毁 callback 和上下文传播。把 Agent run scope 建在 ThreadLocal 上会在异步/Reactive/虚拟线程切换时失效；显式 run context/registry 更可靠。

## 14. FactoryBean 与 ObjectFactory

FactoryBean 自身是容器 bean，但 `getBean("x")` 返回它生产的 product；`getBean("&x")` 才取 factory。`getObjectType()`/singleton 属性影响类型预测和缓存；返回 null/过早实例化会破坏条件与 autowire。

容器只保证 FactoryBean 自己的生命周期，product 的销毁是否管理取决于具体注册/实现，不能一概而论。动态代理、ORM session factory 等常使用此扩展点。

ObjectFactory/ObjectProvider 是延迟获取回调，常用于 scope/循环边界；它不是 product factory bean，也不自动缓存。

## 15. Agent runtime 中的 IoC

把稳定基础设施作为 singleton：HTTP client、provider registry、metrics、state repository；每次 run/tool invocation 是显式对象/状态，不把百万 run 动态注册成 BeanDefinition。

插件热加载也不宜修改正在服务的主 context。为插件创建 child context/独立 loader，健康后原子发布 provider snapshot，排空后 close child；否则 BPP/事件/listener 和 ClassLoader 引用难卸载。

Bean 初始化不得远程探活所有模型而无限阻塞 refresh。构造只校验本地配置；SmartLifecycle/readiness 在有 deadline 的阶段完成，失败区分“应用不能启动”与“provider 暂不可用”。

## 16. 常见误区与检查清单

1. **IoC 就是反射 new**：核心是 definition、对象图、scope、生命周期和扩展点。
2. **ApplicationContext 比 BeanFactory 只是多几个方法**：它编排完整企业服务与 refresh 生命周期。
3. **BPP 修改 BeanDefinition**：主要是实例；定义由 registry/factory post processors 处理。
4. **三级缓存专为性能**：核心是循环早期引用与最终代理一致性。
5. **Spring 能解决所有循环依赖**：构造器/prototype 不行，Boot 默认禁止，setter 也应重构。
6. **prototype 会自动销毁**：容器通常不追踪完整销毁。
7. **`proxyBeanMethods=false` 完全等价**：直接 `@Bean` 方法调用不再经容器。

- [ ] 能从 definition 画到最终 proxy。
- [ ] 能区分两类 factory post-processor 与 BPP。
- [ ] 能解释 early factory 为什么延迟生成代理。
- [ ] 能选择构造器、provider、scope 而非隐藏依赖。
- [ ] 能诊断 bean 提前实例化导致代理失效。
- [ ] 能设计 Agent 组件与 run 状态的不同生命周期。

## 17. 延伸阅读

- [Spring Bean Overview](https://docs.spring.io/spring-framework/reference/core/beans/definition.html)
- [Container Extension Points](https://docs.spring.io/spring-framework/reference/core/beans/factory-extension.html)
- [Bean Lifecycle Callbacks](https://docs.spring.io/spring-framework/reference/core/beans/factory-nature.html)
- [Spring Framework 7 BeanFactory source](https://github.com/spring-projects/spring-framework/tree/v7.0.8/spring-beans/src/main/java/org/springframework/beans/factory)

下一章：[24 Spring AOP 与事务](24-spring-aop-transaction.md)。
