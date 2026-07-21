# 19. 反射、注解、代理与字节码增强：框架如何插入行为

> 优先级：S｜难度：★★★★★｜基线：JDK 21、Byte Buddy 1.15.11｜前置：[05 Class 文件](05-class-file-and-bytecode.md)、[06 类加载](06-class-loading.md)

## 1. 本章目标

完成后应能解释 Spring 为何需要反射但不会“所有调用都反射”；能区分 `Method.invoke`、MethodHandle、动态代理、子类代理与 class-file transform；能读懂注解从源码到 Class 属性的保留边界；能写启动时 Java Agent，并说明重定义做不到什么。

## 2. `Class<?>` 是已加载类型的运行时入口

每个 `(binary name, defining class loader)` 类型对应一个 `Class` 对象。以下入口的初始化语义不同：

```java
Foo.class                                  // 类字面量，不因该表达式初始化 Foo
object.getClass()                          // 对象已存在，返回实际运行时类
Class.forName("p.Foo")                    // 默认初始化
Class.forName("p.Foo", false, loader)     // 加载但不主动初始化
```

`Class` 提供 declared 与 inherited 两组视图：`getDeclaredMethods` 看本类声明，不自动含父类；`getMethods` 看 public 成员并含继承。方法顺序没有可依赖的业务承诺，重载查找必须给精确参数类型。bridge/synthetic 方法也可能出现，框架扫描时要决定是否过滤。

类型身份还包含 loader，所以缓存不能只用类名字符串。反射元数据、MethodHandle、代理类和注解模型若被全局 static map 强引用，会阻止插件 ClassLoader 卸载；可使用 `ClassValue`、弱键或随插件生命周期销毁的 cache。

## 3. Method、Field、Constructor 与访问控制

反射对象描述成员，并不等于绕过语言和模块边界。典型调用步骤是：查找成员 → 校验接收者/参数 → 访问检查 → 装箱/拆箱与可变参数处理 → 调用/读写 → 包装异常。

`Method.invoke` 会把目标方法抛出的异常封装为 `InvocationTargetException`；框架应解包 cause 并保存原始失败类型，不能把所有业务异常变成“反射失败”。`Constructor.newInstance` 同样有构造异常包装；优先于已废弃的 `Class.newInstance()`。

`AccessibleObject.trySetAccessible()` 比无条件 `setAccessible(true)` 更适合探测，但“public 成员”也不保证跨模块可深反射：包必须对调用模块 export；访问非 public 成员通常还需 open。`--add-opens` 是部署者授予深反射能力的强开口，不应成为库的默认自救参数。

反射改 `final` 字段尤其危险：JMM final freeze、JIT 常量折叠、record/hidden class 限制和模块封装都使“调用成功”不等于其他代码观察一致。对象构造和依赖注入应走受支持的构造器/方法边界。

## 4. JDK 21 已没有旧式反射 inflation 主线

历史 HotSpot 核心反射曾先走 native accessor，调用达到阈值后生成 `MagicAccessorImpl` 字节码，常被描述为“反射膨胀”。JEP 416 从 JDK 18 起把 `Method::invoke`、构造和字段访问统一重实现于 MethodHandle；JDK 21 不应再用旧 inflation 阈值解释性能或生成类。

性能仍取决于调用点形状：反射对象若是 `static final`，JIT 更容易常量折叠到具体 handle；每次按字符串扫描、访问检查、分配参数数组仍有成本。框架通常在启动阶段扫描并缓存 metadata/调用器，热路径执行已解析句柄或生成代码。

基准必须避免把查找成本和调用成本混在一起：分别测“每次 getMethod + invoke”和“预缓存 Method.invoke”，并以直接调用/MethodHandle 为对照；用 JMH 消除 DCE、预热和多态混淆。

## 5. MethodHandle 是有类型的可组合调用器

MethodHandle 的 `MethodType` 精确描述参数和返回类型。`invokeExact` 要求调用点 descriptor 完全一致；`invoke` 可做受限适配。仓库实验曾把 `invokeExact` 返回上下文推断成 `Object`，而句柄返回 `String`，真实得到 `WrongMethodTypeException`；显式 `(String)` 固定调用点后才通过。

```java
MethodHandle h = MethodHandles.lookup().findVirtual(
    Greeting.class, "greet", methodType(String.class, String.class));
String result = (String) h.invokeExact((Greeting) target, "agent");
```

Lookup 携带访问能力；`publicLookup`、普通 `lookup`、`privateLookupIn` 权限不同。不要把高权限 Lookup 暴露给不可信插件。handle 可用 `bindTo`、`insertArguments`、`filterArguments`、`guardWithTest` 等组合，`invokedynamic`/lambda 实现也建立在 method handle 基础设施上。

MethodHandle 不是“永远比反射快”的口号；常量性、适配层、多态和 JIT 决定结果。选择它的主要理由是类型化、可组合和 VM 优化接口。

## 6. VarHandle：字段/数组元素的访问模式

VarHandle 描述变量位置，并提供 plain、opaque、acquire/release、volatile、CAS 等访问模式。它同时覆盖字段、static 字段和数组元素，避免依赖 Unsafe 偏移。

仓库 [ReflectionProxyLab](examples/runtime/ReflectionProxyLab.java) 对 volatile int 执行 CAS 与 volatile read。这里的正确性来自所选访问模式，不是“用了 VarHandle”四个字；用 plain get/set 不能替代跨线程发布。句柄坐标类型（接收者/索引）与 value 类型同样由调用点检查。

## 7. 注解从源码到运行时

注解本质上是结构化元数据。`@Retention` 决定保留：

- SOURCE：只供源码/处理器，Class 文件不要求保留；
- CLASS：写入 Class 文件但运行时反射默认不可见；
- RUNTIME：写入运行时可见属性，可用反射读取。

`@Target` 限定声明/类型使用位置；`@Repeatable` 指定容器；`@Inherited` 只影响通过 Class 查询类级注解的继承，不会让方法、字段或接口注解普遍继承。注解元素只允许规范定义的有限类型，默认值存在注解类型本身；修改默认值可能改变未重编译使用方在运行时读到的值。

运行时注解不是执行逻辑。`@Transactional` 只有被框架扫描、生成代理并进入 interceptor 时才有语义；直接 `new` 对象或自调用绕过代理，注解仍在但行为不存在。

## 8. 编译期处理与运行时反射不同

JSR 269 processor 在 javac rounds 中读取 `TypeElement`/`AnnotationMirror`，生成新的源文件/资源，不能可靠地修改已存在源码 AST。新生成类型触发下一 round，直到无新文件。处理器运行的是构建时可信代码，依赖和版本会影响可重复构建。

仓库 [annotation-processor](labs/annotation-processor) 生成 `DemoGreeting.java`，第二轮编译后实际输出 `hello from a generated type`。这比运行时扫描的优势是错误更早、可生成无反射调用代码；代价是增量编译、IDE 集成和生成 API 兼容性。

## 9. JDK 动态代理

`Proxy` 生成一个实现给定接口列表的类，每个代理方法转发给 `InvocationHandler.invoke(proxy, method, args)`。因此常规 JDK proxy 代理接口，不是任意具体类。Object 的 `equals/hashCode/toString` 也会进入 handler，必须定义身份语义；在 handler 中调用同一个 proxy 会递归。

```text
caller → generated interface method → InvocationHandler
                                      ├─ before
                                      ├─ target Method.invoke/handle
                                      └─ after/error
```

默认方法不是天然“绕过 handler”；仓库实验代理的 `kind()` 也进入 handler，再由 `Method.invoke(target, args)` 在真实 target 上执行。复杂框架若要在无 target 情况调用 interface default，可用专门的 invocation handler/default method API 或 MethodHandles。

代理类由指定 ClassLoader 定义；所有接口必须对该 loader 可见，非 public 接口还有包约束。插件系统使用错 loader 常见 `IllegalArgumentException` 或看似同名接口不可赋值。

## 10. 子类代理：CGLIB 与 Byte Buddy

子类代理生成目标类的子类，覆写可覆写方法并插入 interceptor，因此可以代理“没有业务接口的类”。边界来自 Java 继承规则：final class 不能继承，final/private/static 方法不能被普通 override，构造器也不是普通虚方法。self-invocation 仍直接在 `this` 上做虚调用；是否经过 override 取决于方法可覆写与实际对象，但 Spring 的事务自调用问题还涉及同一代理拦截链的入口语义，不能一句话概括。

CGLIB 是成熟子类生成方案；现代 Spring 内部 repackaged CGLIB。Byte Buddy 提供声明式类型匹配、委派、Advice 和 AgentBuilder，底层生成 Class 文件并处理 stack map/frame 等细节。ASM 更接近指令级，控制最强也最容易生成 verifier 错误。

仓库 [reflection-agent](labs/reflection-agent) 的 `ByteBuddyProxyLab` 子类化 `DemoService`，把 `work` 委派到 interceptor，再通过 `@SuperCall` 调原实现。最初 interceptor 返回 `Object` 与目标返回 `String` 无法绑定，加入显式 `@RuntimeType` 后实测通过；这说明生成框架仍必须满足方法 descriptor/绑定规则。

## 11. AOP 能插入什么，不能保证什么

代理 AOP 只拦截“经过代理对象的调用”。以下常绕过：对象由用户 `new`；同类内部调用未走外部 proxy；final/private 方法；构造期间；框架不管理的 callback。AspectJ 编译期/加载期 weaving 或 Java Agent 能改目标字节码，覆盖面更大，但部署、调试和完整性风险也更高。

拦截器顺序是语义：`transaction → retry` 与 `retry → transaction` 决定每次重试是否新事务；`metrics` 放在 retry 外测总请求，放内侧测每次 attempt。必须画调用链和异常传播，不凭注解排列猜。

## 12. Java Agent 与 Instrumentation

启动 agent JAR 的 manifest 声明 `Premain-Class`，JVM 在应用 main 前调用：

```java
public static void premain(String args, Instrumentation inst) {
    inst.addTransformer(transformer, true);
}
```

`ClassFileTransformer` 在类定义、redefine 或 retransform 的指定阶段接收原始/前序转换后的 class bytes；不修改时返回 null，不能原地改输入数组。多个 transformer 按规范分组和注册顺序串联，因此 APM、mock、coverage 同时存在时转换顺序可能影响结果。

`retransformClasses` 从 initial bytes 加既有不可重转换转换，再调用 capable transformers；它不是在当前已变换 bytes 上无限叠加。redefine/retransform 受 VM 限制，通常不能随意增删字段/方法、改继承层次或 nest；查询 `isModifiableClass` 和能力标志，并为失败降级。

## 13. 可运行 timing agent

本仓库用 Byte Buddy `AgentBuilder` 只匹配 `DemoService`，Advice 在 `work` 进入记录 nanoTime，在正常/异常退出都打印耗时：

```powershell
cd labs\reflection-agent
.\run.ps1
```

HotSpot 21.0.8 实测：

```text
Byte Buddy subclass proxy verified: ...DemoService$ByteBuddy$...
agent premain, retransform=true
timed ...DemoService.work ... outcome=success
timed ...DemoService.work ... outcome=IllegalArgumentException
agent application verified
```

耗时数字每次变化，只验证 advice 覆盖两条退出路径。agent 将 Byte Buddy shade 进单独 JAR，使用启动时 `-javaagent`，没有动态 attach。

## 14. 动态 attach 与完整性边界

JEP 451 在 JDK 21 对运行中动态加载 agent 发警告，为未来默认禁止做准备；启动命令显式 `-javaagent` 不受该警告影响。库不应偷偷 self-attach 获取改变任意代码的“超级权限”。生产 APM 应由应用所有者在部署配置中授权，并固定 agent/JDK 兼容矩阵。

agent 代码处在所有类加载路径的敏感位置：transformer 不能递归触发自己依赖的类加载、不能长时间阻塞、不能把应用 loader 强引用进全局 cache。增强方法还需保留异常、同步、返回值和上下文语义；计时 `finally` 自己抛异常会改变业务结果。

APM/Arthas 一类工具可能利用 Instrumentation/JVMTI、方法增强、采样和 Attach 的不同组合。不能看到“无侵入”就推断“无开销/不改字节码”；要查具体命令和版本。

## 15. Agent runtime 的扩展边界

工具 schema 可用运行时注解扫描，也可在编译期生成 registry。推荐：

- 启动时验证唯一 tool id、参数 schema、权限和 MethodHandle；请求热路径不再扫描。
- registry 发布不可变快照；插件卸载时清除 Class/MethodHandle/代理 cache。
- 不把用户输入直接映射任意方法名；只允许预注册 capability。
- 拦截器链明确 auth→quota→timeout→audit→invoke→redact 顺序。
- 代理只能插入本进程控制逻辑，不能让外部副作用自动幂等。

字节码增强适合统一观测，不适合隐藏业务状态机。若一次 tool call 可能“远端成功、本地超时”，Advice 记录耗时也无法决定是否重试；仍需 invocation id 与对账。

## 16. 常见误区与面试追问

1. **反射一定走 native 再 inflation**：JDK 18+ 的 JEP 416 已改变核心实现。
2. **`setAccessible(true)` 能打开一切**：JPMS strong encapsulation 仍约束深反射。
3. **MethodHandle 自动适配所有签名**：`invokeExact` 调用点必须完全一致。
4. **RUNTIME 注解会自动执行**：需要处理器、扫描器或代理/增强器赋予语义。
5. **JDK proxy 能代理具体类**：常规模式生成接口实现；类代理需子类/增强。
6. **final 方法也能被子类 interceptor 覆写**：继承规则禁止 override。
7. **retransform 能任意改类结构**：受 VM 支持的 schema change 限制。
8. **动态 attach 与启动 agent 相同**：授权与 JEP 451 行为不同。

**Q：Spring 为什么大量使用反射却还能高性能？** 扫描/解析多在启动阶段，metadata 和调用器被缓存，热路径常是代理生成方法、MethodHandle 或已解析反射对象；仍需用启动和请求基准验证。

**Q：Byte Buddy 与 ASM 的关系？** Byte Buddy 提供高层类型/匹配/委派模型并使用字节码基础设施；ASM 暴露指令与 ClassVisitor 级控制。前者降低正确生成成本，后者适合极细变换。

- [ ] 能区分加载、初始化和 Class 身份。
- [ ] 能解释 JDK 21 反射实现的历史边界。
- [ ] 能写精确 MethodType 与 Lookup 权限模型。
- [ ] 能画 JDK proxy/子类 proxy/agent 三条调用链。
- [ ] 能说明 transformer 顺序与 retransform 输入来源。
- [ ] 能审计 agent 的递归加载、缓存和授权风险。

## 17. 延伸阅读

- [JEP 416：Reimplement Core Reflection with Method Handles](https://openjdk.org/jeps/416)
- [MethodHandles.Lookup API, Java 21](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/invoke/MethodHandles.Lookup.html)
- [Proxy API, Java 21](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/reflect/Proxy.html)
- [Instrumentation API, Java 21](https://docs.oracle.com/en/java/javase/21/docs/api/java.instrument/java/lang/instrument/Instrumentation.html)
- [JEP 451：Prepare to Disallow Dynamic Loading of Agents](https://openjdk.org/jeps/451)
- [Byte Buddy 官方教程](https://bytebuddy.net/partial/tutorial.partial.html)

下一章：[20 模块、SPI 与插件架构](20-module-spi-plugin.md)。
