# 06｜JVM 启动与类加载：类型身份、初始化锁和插件隔离

> 优先级：S｜难度：★★★★★｜基线：JVMS/HotSpot 21｜前置：[05](05-class-file-and-bytecode.md)

## 1. 本章目标

能区分 load、define、link、initialize；能用“binary name + defining loader”解释类型身份；能推导 `<clinit>` 触发、顺序、并发与失败；能分析 `ClassNotFoundException`、`NoClassDefFoundError`、`NoSuchMethodError` 和 loader 泄漏；最终运行一个让同名插件依赖两个版本并存的隔离实验。

## 2. JVM 启动只定义入口，不会一次加载所有类

启动器解析参数、创建 VM、初始化核心运行时，建立初始类加载器，加载/初始化 main class 并调用合适的 `main`。应用类随后按执行路径按需加载。`-jar`、module main、source-file mode 和自定义 launcher 的入口解析不同，但 Class 生命周期仍受 JVMS 约束。

```text
native launcher
   └─ create VM / bootstrap runtime
       └─ find initial class or module main
           ├─ load + link + initialize main class
           └─ invoke main(String[])
               └─ demand-driven loading continues
```

观察启动顺序用 `-Xlog:class+load=info,class+init=info`，不要仅靠在 static block 打印：打印会改变时间、类依赖和初始化路径。

## 3. 三类内建加载器与 `null` 的含义

JDK 21 常见层次：

```text
Bootstrap loader（VM 内建，Java 反射常显示 null）
        ▲
PlatformClassLoader（平台模块）
        ▲
AppClassLoader（classpath/module-path 应用）
        ▲
自定义 URLClassLoader / 容器 / 插件 loader
```

Bootstrap 不是一个 Java `ClassLoader` 对象必须可见的普通实例，`String.class.getClassLoader()==null` 表示由 bootstrap 定义，不是“这个类没有加载器”。Platform loader 取代早期 extension loader 概念；把 Java 8 的 ExtClassLoader 结构套到 21 会误导。

## 4. 类型身份：同名不等于同类型

运行时类型身份至少包含 binary name 与 defining loader：

```text
(dev.deepjava.plugin.impl.GreetingPlugin, loader-v1)
!=
(dev.deepjava.plugin.impl.GreetingPlugin, loader-v2)
```

initiating loader 是发起加载动作的 loader，defining loader 是最终调用 `defineClass` 定义该 Class 的 loader；两者可能不同。JVM 还维护 loader constraints，确保跨 descriptor 交互时共享类型的身份一致。

插件接口必须由宿主父 loader 定义，插件实现由各自子 loader 定义。若插件 jar 私带并 child-first 定义一份 `Plugin`，对象即使实现同名接口，宿主仍会 `ClassCastException: X cannot be cast to X`。

## 5. 双亲委派是常用实现模式，不是 JVM 规范唯一算法

`ClassLoader.loadClass` 的典型顺序是：

1. 按 name 检查 `findLoadedClass`；
2. 委派 parent（parent 为 null 时请求 bootstrap）；
3. 父找不到再由当前 loader 的 `findClass` 查找并 `defineClass`；
4. 按请求可解析。

收益：核心类只有可信定义、共享 API identity、避免重复定义。容器和插件可能对指定包 child-first，以隔离应用依赖，但必须永久 parent-first 处理 `java.*`、宿主 API、日志/监控桥接等共享契约。

并行加载器可调用 `registerAsParallelCapable`，JDK 用 per-class loading lock 降低全 loader 串行；自定义 loader 若状态/缓存非线程安全，可能重复定义并触发 `LinkageError`。

## 6. 生命周期：七个词要按规范边界使用

```text
Loading
  └─► Linking: Verification ─► Preparation ─► Resolution
                                            （允许一定 lazy）
       └─► Initialization ─► Using
                              └─► Unloading（实现与可达性条件）
```

### 6.1 Loading

按 binary name 获得 bytes，创建 JVM 内部类表示和对应 `java.lang.Class` 对象。来源可以是 module image、JAR、网络、生成器或加密存储。`defineClass` 不是安全审计：必须校验来源、签名、大小、包与 protection domain。

### 6.2 Verification

检查 Class 结构、常量池和字节码类型安全，细节见第 05 章。验证错误是 `VerifyError` 等 `LinkageError`，不是编译期 checked exception。

### 6.3 Preparation

为 static fields 建存储并设默认零值；具有 `ConstantValue` 属性的 static final constant variable 可在准备阶段得到常量值。源码初始化器一般不在这里执行：

```java
static int a = 7;              // prepare 后先是 0，<clinit> 再写 7
static final int B = 7;        // ConstantValue 可在 prepare 设置
static final Integer C = 7;    // 不是 primitive/String constant variable，<clinit> 执行
```

### 6.4 Resolution

把运行时常量池的符号引用检查/转换为可直接使用的内部引用，包括类、字段、方法、接口方法、method handle/type、dynamic constant 等。实现可延迟到首次使用，但访问检查和错误语义要符合 JVMS。

### 6.5 Initialization

执行编译器生成的 `<clinit>()V`：static field 非常量初始化器与 static blocks 按源码文本顺序合并。不是每个类都有 `<clinit>`。初始化前会先初始化必要的 superclass，以及包含 default method 的相关 superinterfaces（精确规则见 JVMS 5.5），不能简化成“所有接口都会先初始化”。

## 7. 主动使用与被动使用

常见主动使用触发初始化：`new`，`getstatic/putstatic/invokestatic`（目标成员非 constant variable），某些反射调用，初始化子类，启动初始类，特定 MethodHandle 解析等。

不会初始化目标类的典型场景：

- 读取已内联的编译期常量；
- 创建该元素类型的数组（初始化的是 JVM 合成的数组类）；
- `ClassLoader.loadClass` 或 `Class.forName(name,false,loader)` 只加载；
- 通过子类名访问实际声明在父类的静态字段，只初始化声明类。

配套 [ClassInitializationLab.java](examples/jvm/ClassInitializationLab.java) 实测顺序：

```text
compile-time constant=42       # Child/Parent 都未初始化
array class=[L...$Child;        # 数组类，不初始化 Child
loaded without initialization=...$Child
Parent.<clinit>                 # 读取 Parent.RUNTIME_CONSTANT
runtime constant=43
Child.<clinit>                  # 首次读取 Child.child
child field=2
```

这是当前样例的证据；不要用输出行间隔推断 JVM 内部具体锁实现。

## 8. `<clinit>` 的并发与失败语义

JVMS 为每个 Class/Interface 使用唯一初始化锁语义：

1. 第一个线程获得初始化权；
2. 同线程递归请求该类可继续，避免自死锁；
3. 其他线程等待结果；
4. 成功后所有等待者看到 initialized 状态；
5. 抛出的非 Error 异常通常包装为 `ExceptionInInitializerError`；类标记 erroneous；
6. 后续主动使用不重试 `<clinit>`，通常得到 `NoClassDefFoundError: Could not initialize class`。

所以 static initializer 不能做长网络请求、等待线程池任务或依赖复杂循环。一个线程在 `<clinit>` 等待另一个线程，而后者又需要这个类初始化完成，会形成初始化死锁；普通线程 dump 不一定直接打印“Java-level deadlock”。

发布语义上，类初始化完成 happens-before 任何线程首次主动使用该类，因此 initialization-on-demand holder 是安全延迟单例；前提是初始化没有泄露未构造完成的其他对象。

## 9. ClassLoader namespace 与资源查找

类和资源是两条相关但不同的查找路径。`getResource` 的委派/重复资源顺序会影响 `META-INF/services`、配置和框架扫描。Fat JAR/嵌套 JAR 还可能使用自定义 URL handler/loader，普通 `URLClassLoader` 假设未必成立。

包 sealing、签名和 `ProtectionDomain/CodeSource` 也在 define 过程中关联。把同一 sealed package 从多个 code source 混入会失败。Java SecurityManager 已弃用/移除演进中，不能把 ClassLoader 或 ProtectionDomain 单独当现代强沙箱。

## 10. TCCL 与 SPI：父如何发现子

平台/框架类由父 loader 定义，但 provider 常在应用子 loader。若框架只用 `Framework.class.getClassLoader()`，父看不到子。Thread Context ClassLoader 把“当前执行上下文应使用哪个 loader”显式放在线程上，`ServiceLoader` 等机制可借它查 provider。

风险：

- 线程池复用时忘记恢复 TCCL，造成跨租户/跨应用泄漏；
- 虚拟线程/异步 stage 切换时上下文传播假设错误；
- provider 实例、缓存、ThreadLocal 或线程保留 loader，插件无法卸载；
- 任意 provider 发现等于执行第三方构造代码，必须先建立信任。

使用时用 `try/finally` 恢复原 TCCL，或显式 `ServiceLoader.load(Service.class, pluginLoader)`，不要依赖环境偶然设置。

## 11. 可运行插件隔离实验

```powershell
cd labs\classloader-plugin
.\run.ps1
```

宿主由 AppClassLoader 加载 `Plugin` API；两个 `URLClassLoader` 各加载同 binary name 的 `GreetingPlugin` 与 `VersionedFormatter`，输出类似：

```text
plugin-v1 -> v1:TASK, implementationLoader=URLClassLoader@..., apiLoader=AppClassLoader@...
plugin-v2 -> v2:[task], implementationLoader=URLClassLoader@..., apiLoader=AppClassLoader@...
two dependency versions isolated; shared API identity preserved
```

关键不变量：

```text
plugin-v1 class != plugin-v2 class       // defining loader 不同
plugin-v1 instanceof Plugin == true      // API 由共同 parent 定义
plugin private dependency v1/v2 coexist  // namespace 隔离
```

`URLClassLoader.close()` 只关闭 JAR/file handle，不保证立即卸载。要卸载，定义 loader、它定义的 Class、实例、线程、ThreadLocal、JNI/global cache 等必须都不可达，随后还取决于 GC 类卸载策略。

## 12. 容器与框架案例

### Tomcat

容器要共享 Servlet API，又允许 WebApp 私有依赖，通常形成 bootstrap/platform/system/common/webapp 多层并对部分包采用 webapp-first。部署泄漏常来自应用创建但未停止的线程、JDBC driver 注册、ThreadLocal、日志缓存或定时器，它们由共享线程/静态表反向保留 WebApp loader。

### Spring Boot 可执行 JAR

嵌套依赖不能直接等同普通目录 Classpath，Boot loader 提供相应 archive/class loader 机制。排障必须打印实际资源 URL 和 loader；把 IDE 展开的 classpath 与生产 fat jar 当同一加载形态会漏问题。

### Agent Tool 插件

宿主 API 应小、稳定、父加载；插件依赖 child namespace；每个插件有版本、权限、资源预算和生命周期。ClassLoader 只隔离类型/依赖，不隔离 CPU、heap、系统属性、文件和网络。运行不可信 Tool 需要独立进程/容器 Sandbox。

## 13. 错误分类：同样是“缺类”，阶段不同

| 错误 | 典型含义 | 先查什么 |
|---|---|---|
| `ClassNotFoundException` | 显式按 name 加载失败，checked exception | 请求 name、调用的 loader、classpath/module path |
| `NoClassDefFoundError` | 执行中所需定义不可得，或类已初始化失败 | cause、首次失败日志、依赖/初始化 |
| `UnsupportedClassVersionError` | major version 高于运行时支持 | `javap -v`、`java -version` |
| `VerifyError` | Class 结构/类型流不合法 | 生成/增强工具版本、StackMapTable |
| `NoSuchMethodError` | 调用方 Methodref 在运行定义中找不到 | 调用方 descriptor、实际加载 jar |
| `IllegalAccessError` | 链接时访问规则不满足 | 模块/包/可见性版本差异 |
| `IncompatibleClassChangeError` | 类/接口、static/instance 等二进制形态变化 | 编译期与运行期 ABI |
| `LinkageError: duplicate class definition` | 同一 defining loader 重复 define name | 并发/缓存与 loader lock |

排障证据链：

```text
异常完整 cause
  → 失败类 binary name + descriptor
  → 调用方与目标 getClassLoader()/CodeSource
  → -Xlog:class+load,class+resolve,class+init
  → 构建 dependency tree / JAR 内容
  → 最小 classpath 对照复现
```

## 14. 性能与并发

Class loading 涉及 JAR I/O、解压、校验、解析、验证、元数据分配和可能的 `<clinit>`；大量生成/代理类增加 metaspace、code cache 和 JIT 压力。启动优化应先用 JFR/启动日志定位是 class path 扫描、verification、bean 初始化还是 JIT，不要一律关闭验证。

并发首次使用会集中在初始化锁；把大缓存和远程连接放 static init 会形成冷启动长尾。可改为显式生命周期：构造配置 → 健康检查 → 原子发布 ready 实例 → 可取消关闭，失败可重试且可观测。

## 15. 实验任务

1. 给插件 v1 私带一份 `Plugin` API 并使用 child-first，复现 `ClassCastException`，再修复共享契约。
2. 在 `<clinit>` 抛异常，分别记录首次和第二次主动使用异常。
3. 两线程构造类初始化循环，抓 thread dump；只在独立进程并加超时。
4. 保留插件创建的线程，关闭 loader 后用 `jcmd <pid> GC.class_histogram`/JFR 证明泄漏，再停止线程对照。
5. 用 `-Xlog:class+load=info,class+unload=info` 记录 loader 卸载；“没有日志”不能单独证明永久泄漏。

## 16. 面试题与检查清单

**Q：双亲委派能打破吗？** 能，自定义 loader/容器可改变顺序；但核心/共享 API identity 与安全边界必须显式保护。

**Q：加载与初始化区别？** 加载创建 Class 表示，链接验证/准备/解析；初始化才执行 `<clinit>`。`Class.forName` 的 initialize 参数能直接验证。

**Q：关闭 URLClassLoader 后类卸载了吗？** 未必；close 只释放 loader 自身资源，所有相关对象必须不可达且 GC 选择卸载。

- [ ] 能画出内建 loader 层次并解释 bootstrap 的 null。
- [ ] 能用 name + defining loader 判断类型身份。
- [ ] 能区分 loading/linking/initialization。
- [ ] 能推导编译期常量、数组和 `Class.forName(false)` 的初始化行为。
- [ ] 能区分四类常见 loading/linkage error。
- [ ] 不把 ClassLoader 隔离当安全 Sandbox。

## 17. 延伸阅读

- [JVMS 5：Loading, Linking, and Initializing](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-5.html)
- [JLS 12：Execution](https://docs.oracle.com/javase/specs/jls/se21/html/jls-12.html)
- [ClassLoader API, Java 21](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/ClassLoader.html)
- [ServiceLoader API, Java 21](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ServiceLoader.html)

下一章：[07-jvm-runtime-areas.md](07-jvm-runtime-areas.md)
