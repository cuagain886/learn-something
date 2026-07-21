# 24. Spring AOP 与事务：代理边界、资源绑定和失败语义

> 优先级：S｜难度：★★★★★｜基线：Spring Framework 7.0.8｜前置：[19 代理](19-reflection-proxy-bytecode.md)、[23 IoC](23-spring-ioc.md)

## 1. 本章目标

能从 Advisor 匹配跟踪到 interceptor chain；能用“调用是否穿过 proxy”判断 advice 是否执行；能解释 Spring 事务如何获得/绑定连接、提交/回滚；能推导 REQUIRED/REQUIRES_NEW/NESTED 的物理资源后果；能处理自调用、异常被捕获、异步、远程副作用与长事务。

## 2. Spring AOP 的术语落到调用链

- join point：Spring proxy AOP 中主要是方法执行；
- pointcut：哪些方法匹配；
- advice/interceptor：匹配后执行的行为；
- advisor：pointcut + advice；
- target：真实业务对象；
- proxy：调用方持有的包装对象。

```text
caller → proxy method
       → interceptor[0].invoke
         → interceptor[1].invoke
           → target method
         ← return/throw
       ← return/throw
```

每个 interceptor 调 `proceed()` 决定是否继续、执行几次、如何变换返回/异常。retry 调多次，cache hit 不调 target，transaction 在 proceed 前 begin、之后 commit/rollback。顺序就是业务语义。

## 3. 代理创建与匹配

AutoProxyCreator 作为 BeanPostProcessor 收集候选 Advisors，检查 bean class/method，匹配则生成 JDK interface proxy 或 class-based proxy。Spring 配置可强制 class proxy，但 final/private/static 方法仍不属于可覆写 join point。

pointcut 过宽会代理基础设施/配置类并增加启动与每次调用开销；过窄会漏 bridge/interface annotation。框架解析最具体 target method、bridge method 和 annotation inheritance，用户自写 MethodMatcher 也要考虑这些。

一个对象可能已有 proxy；后续处理器可再包一层，导致 `proxy → proxy → target`。顺序难推导且 `instanceof`/annotation/equals 复杂。尽量让统一 auto-proxy creator 构建一条 interceptor chain，用 `AopUtils`/debug log 检查 Advisors。

## 4. JDK 与 class proxy 的边界

JDK proxy 暴露配置接口；按具体实现类注入会失败。class proxy 让调用方看到 target 子类，但 final class/method 不能增强，构造与 package/module access 也有限制。

无论哪种，关键是调用引用：外部注入的是 proxy，进入 advice；target 内 `this.inner()` 的 `this` 是 target/代理底层执行对象，调用不会重新经过外部 interceptor dispatch，因此常见自调用 advice 失效。

不要用 `AopContext.currentProxy()` 广泛修补，它把业务代码耦合 AOP 且要求 exposeProxy。更清晰的是把 inner operation 提取到另一个 bean，或注入窄 self proxy/provider（仍需防循环）。AspectJ weaving 能覆盖 self invocation，但部署模型完全不同。

## 5. advice 的异常与上下文

around advice 必须保持 target 的正常返回/异常，finally 清理 MDC/permit/计时。若 advice 自己抛异常，会覆盖业务结果；记录日志的 JSON serializer 也可能失败，观测代码应降级。

多个横切关注的推荐思考顺序不是固定答案：auth 应在昂贵工作前；rate limit 是按逻辑请求还是 retry attempt；transaction 是否包含 retry；metrics 测总请求或单 attempt；cache 是否缓存授权相关数据。先写语义，再设置 `@Order`。

ThreadLocal context 只随当前线程；`@Async`、新线程、Reactor 不自动继承。任务 decorator 可以复制不可变 trace/security snapshot，事务连接绝不能复制到另一线程并发用。

## 6. 事务的物理基础

JDBC local transaction 通常在一个 Connection 上：关闭 auto-commit → 执行 SQL → commit/rollback → 恢复/归还池。ACID 的具体保证由数据库隔离、日志和约束实现；Spring 提供统一边界，不创造数据库没有的隔离。

`PlatformTransactionManager` 概念操作是 getTransaction、commit、rollback。DataSourceTransactionManager 从 DataSource 获取连接，把资源 holder 绑定到当前线程的 `TransactionSynchronizationManager`；同线程内 JdbcTemplate/DataSourceUtils 复用它。

业务代码直接 `dataSource.getConnection()` 并自行 close，可能绕过 thread-bound 连接；应通过 Spring-aware access。事务完成后必须解绑并归还，泄漏会耗尽池。

## 7. `@Transactional` 如何执行

annotation 只是 metadata。`TransactionAttributeSource` 解析方法/类属性，`TransactionInterceptor` around invocation：

```text
resolve target method + transaction attribute
 → choose transaction manager
 → get/create/join transaction
 → invoke next interceptor / target
 → normal: commit（也可能发现 rollback-only）
 → throwable: apply rollback rules, rollback or commit
 → cleanup thread-bound resources
```

没有 `@EnableTransactionManagement`/auto-config、没有 manager、对象不是容器 bean、调用未过 proxy，注解都不会自行生效。private 方法通常不能作为外部 proxy join point；把注解放上去会制造错误安全感。

## 8. 可运行的自调用证据

[TransactionBoundaryLab](labs/spring-runtime/src/main/java/dev/deepjava/spring/TransactionBoundaryLab.java) 用 H2 与计数 DataSourceTransactionManager：

1. 外部调用 `selfInvocation()` 创建一个 REQUIRED 物理事务；内部 `this.innerRequiresNew()` 虽标 REQUIRES_NEW，却没经过 proxy，begin 总数只增加 1。
2. 外部调用另一个方法，再调用独立 `AuditService.record(REQUIRES_NEW)`，穿过第二个 proxy，outer 被挂起、inner 新建，begin 增加 2。

实际输出 `physicalBegins=3`，orders/audit 均各 2 行。它证明该调用形状的代理边界，不说明生产中 REQUIRES_NEW 是最佳设计。

## 9. propagation 的物理资源后果

### REQUIRED

无事务则新建，有则参与。同一物理事务内每个 annotated method 有逻辑 scope；inner 标 rollback-only，outer 即使捕获异常并继续，到最终 commit 会收到 `UnexpectedRollbackException`，防止调用方误以为提交成功。

inner 声明的 isolation/timeout/readOnly 加入现有事务时通常不能改变物理属性；需要严格检查可启用 validateExistingTransaction 或在边界设计中统一。

### REQUIRES_NEW

挂起 outer resources，新建独立物理事务和连接；inner 可独立提交并释放锁，但 outer 仍持连接/锁。并发 N 个 outer 都再借 inner connection 时，池至少需额外余量，否则所有线程持一条等第二条而死锁式耗尽。不能用它随手“保证日志一定写入”。

### NESTED

通常在同一 JDBC 物理事务用 savepoint，inner rollback 回保存点，outer 可继续。数据库/manager 必须支持，不等于新连接/独立提交；outer 最终 rollback 仍撤销全部。

SUPPORTS/MANDATORY/NOT_SUPPORTED/NEVER 各自表达有无事务约束，应按领域 boundary 用，不把 propagation 当调试开关。

## 10. 隔离、锁与只读

Spring isolation 枚举映射 JDBC/manager，最终数据库是否支持、如何实现必须查目标版本。READ_COMMITTED、REPEATABLE_READ、SERIALIZABLE 名称相同也可能有 MVCC/锁差异。

`readOnly=true` 是 manager/driver/ORM 的提示或约束，不是跨所有数据库的“禁止写”规范，也不是把 replica 自动路由。对强要求只读，在数据库权限/连接路由层落实并测试。

长事务让连接长期占用、版本/undo 保留、锁冲突和失败重做增加。不要在事务内等待用户、模型、远程 HTTP、文件上传。先完成外部准备再短事务提交，或用状态机/outbox/saga。

## 11. rollback 规则与异常处理

默认声明式规则通常对 RuntimeException/Error 回滚、checked exception 不回滚，除非配置 `rollbackFor/noRollbackFor`。这是 Spring 规则，不是数据库判断业务异常。

```java
@Transactional
public void outer() {
    try { repository.writeThenFail(); }
    catch (RuntimeException e) { log.warn("ignored", e); }
}
```

若异常来自同一事务中的 proxied inner，它可能已标 rollback-only；outer 吞异常也无法提交，最终 UnexpectedRollback。若 target 自己抛并在同一方法内部 catch，interceptor 从未看到异常，除非代码显式 setRollbackOnly，事务可能提交。

选择应基于业务：可恢复 validation 在写前完成；不可恢复 persistence error 让它越过边界；若要转异常，保留 cause 并配置新类型 rollback。不要 catch Exception 后永远返回成功。

## 12. 事务同步与提交后动作

`TransactionSynchronization` 可在 beforeCommit/afterCommit/afterCompletion 回调，但回调运行时资源状态有细节且失败不能“撤销已提交数据库”。afterCommit 直接发 MQ 若失败，会得到 DB 已提交、消息未发。

可靠做法是在同一事务写 outbox row，独立 relay 发布并记录重试/幂等；消费者也按 message id 去重。`@TransactionalEventListener(AFTER_COMMIT)` 适合进程内后续动作，但进程在 commit 后 callback 前崩溃仍会丢，不能代替 outbox。

## 13. 远程 API 与结果未知

事务内调用远程 API 有三重问题：持 DB 连接/锁等待网络；远端不参与本地 commit；超时后不知道远端是否成功。若远端成功、本地 rollback，重试会重复副作用。

模式：本地事务写 intent/outbox → commit → worker 带 idempotency key 调远端 → 保存 confirmed/unknown/failed → 对账恢复。需要强原子跨系统语义时评估协调协议，但多数 HTTP/LLM/tool 不支持 XA。

Agent tool invocation 天然如此，不能用 `@Transactional` 包住模型+工具 loop 解决一致性。

## 14. 异步、Reactive 与虚拟线程

imperative PlatformTransactionManager 把资源绑定当前线程。`@Async`/新平台或虚拟线程得到另一 ThreadLocal，不自动加入原事务；把同 Connection 传过去并发使用也通常不安全。

ReactiveTransactionManager 绑定 Reactor Context，要求所有 DB 操作在同一 reactive pipeline/context；返回普通值的方法不会魔法变 reactive 事务。在链中 `block`/转 future/丢 context 都可能越界。

虚拟线程仍有独立 ThreadLocal，所以每虚拟线程一个顺序 transaction 能工作；它改变线程成本，不改变连接池容量、数据库锁、传播、commit 和远程结果未知。并发虚拟线程更多时更要用 connection admission。

## 15. Agent/Spring 拦截器链

Tool method 可用 advisor 统一 auth/quota/deadline/audit，但状态机仍显式：

```text
authorize → acquire permit → persist STARTED
 → invoke external tool outside DB tx
 → persist SUCCEEDED / UNKNOWN / FAILED in short tx
 → emit event
```

retry interceptor 必须知道 tool 是否幂等；通用 `@Retryable` 包所有异常会把 authorization、validation、unknown side effect 一起重试。transaction advisor 和 retry advisor 顺序需用测试验证 physical transaction count。

审计 advice 对参数/返回脱敏并限制大小；流式 Publisher 的方法返回时尚未执行，普通 around 的 finally 只测“组装 pipeline”时间，需要在 subscription/terminal signal 上埋点。

## 16. 常见误区与检查清单

1. **有注解就有事务**：必须容器、manager、advisor、proxy crossing。
2. **self-invocation 只是 private 才失效**：public 的 `this` 调用也绕外部 proxy。
3. **catch 异常就能继续提交**：可能已 rollback-only；也可能 interceptor 根本没看到异常而错误提交。
4. **REQUIRES_NEW 更安全**：多占连接且无法与 outer 原子提交。
5. **readOnly 保证不能写**：依 manager/DB，不是统一安全边界。
6. **ThreadLocal 事务会自动传给异步线程**：不会。
7. **虚拟线程让连接池不再需要**：数据库容量没变。

- [ ] 能列出 proxy chain 和 advisor 顺序。
- [ ] 能用调用引用判断 self-invocation。
- [ ] 能画 connection bind/suspend/resume/cleanup。
- [ ] 能推导三种 propagation 的连接与 savepoint。
- [ ] 能解释 rollback-only 与 UnexpectedRollback。
- [ ] 能用 outbox 处理 commit 后消息/远程动作。

## 17. 延伸阅读

- [Spring AOP Reference](https://docs.spring.io/spring-framework/reference/core/aop.html)
- [Declarative Transaction Implementation](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/tx-decl-explained.html)
- [Transaction Propagation](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/tx-propagation.html)
- [TransactionSynchronizationManager API](https://docs.spring.io/spring-framework/docs/7.0.8/javadoc-api/org/springframework/transaction/support/TransactionSynchronizationManager.html)

下一章：[25 Spring Boot 自动配置与启动](25-spring-boot.md)。
