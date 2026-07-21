# 01｜Java 语言设计与演进：稳定的抽象边界，不是“处处跨平台”

> 优先级：S｜难度：★★★｜基线：JLS/JVMS 21、HotSpot 21.0.8｜前置：编译与进程的基本概念

## 1. 本章目标

学完后应能把“Java”拆成语言、二进制格式、虚拟机、类库和具体发行版，解释为什么字节码既带来可移植性也引入启动与运行时成本；面对“Java 是编译型还是解释型”“一次编译到处运行吗”时，给出带边界的答案。

## 2. Java 当初要解决的不是语法问题

如果源程序直接生成某种 CPU/OS 的本地可执行文件，分发方必须为 `x86_64 Windows`、`x86_64 Linux`、`AArch64 Linux` 等组合分别构建、测试和更新。网络下载的未知程序还需要验证其控制流与内存访问是否安全。Java 选择了中间契约：编译器输出结构受约束的 Class 文件，目标机器提供 JVM 实现。

```text
              一次编译得到平台中立 Class/JAR
Java source ───────────────► JVMS class file
                                  │
                 ┌────────────────┼────────────────┐
                 ▼                ▼                ▼
          HotSpot/Linux-x64  HotSpot/Win-x64  OpenJ9/AArch64
          解释器 + JIT       解释器 + JIT       自己的执行实现
                 │                │                │
                 ▼                ▼                ▼
             本地指令/OS       本地指令/OS       本地指令/OS
```

中间层的代价是 JVM 启动、验证、元数据、运行时 profile 与 JIT 编译；收益是统一的二进制语义、动态加载、垃圾回收、可观测性以及依据现场 profile 做投机优化的机会。

## 3. 五个经常被混称为“Java”的层次

| 层次 | 规范/实现 | 例子 | 错误归因 |
|---|---|---|---|
| Java 语言 | JLS | 重载解析、数值提升、happens-before | “对象头由 Java 语言规定” |
| Class/JVM 契约 | JVMS | 常量池、`invokevirtual`、验证、运行时数据区 | “JVMS 要求 C2 编译器” |
| Java SE API/JDK 工具 | Java SE/JDK | `String`、`HttpClient`、`javac`、`jcmd` | “JVM 就是 JDK” |
| JVM 实现 | HotSpot、OpenJ9 等 | TLAB、G1 Region、C1/C2、Mark Word | 把 HotSpot 21 的布局说成所有 JVM 永恒事实 |
| 发行版/支持 | Oracle JDK、Temurin、Corretto、Zulu 等 | 构建、补丁、许可证、支持周期 | 认为 OpenJDK 和 Oracle JDK 是两套语言 |

JDK 是开发工具与运行时的发行物；JRE 曾是常见独立发行概念，现代部署更常用完整 JDK 或 `jlink` 生成的定制 runtime image。Java SE 定义标准平台；Jakarta EE 定义企业规范集合；Spring 是独立框架生态，既不等于 Java SE，也不是 Jakarta EE 的新名字。

## 4. “编译型还是解释型”是错误二分

一个典型 HotSpot 21 进程会经历：

1. `javac` 提前把 Java 源码编译成字节码；
2. 类加载器按需获得字节，验证并链接；
3. 模板解释器可立即执行方法；
4. 方法调用计数和回边计数形成运行 profile；
5. C1/C2 把热点字节码编成本地机器码；
6. 依赖的假设失效时去优化，返回解释器或较低层级代码。

所以 Java 程序既经过 AOT 的源到字节码编译，也可能被解释和 JIT 编译。JVMS 只规定可观察语义和 Class 格式，不要求某种执行策略；一个合规 JVM甚至可以完全解释或把全部字节码预编译。

### 为什么不默认直接生成机器码

- Class 文件是跨 ISA 的部署契约；机器码不是。
- 动态类加载和反射让闭世界假设难成立。
- JIT 知道生产现场的接收者类型、分支概率和热点，能内联并去虚拟化。
- 验证器能在执行前检查结构与类型流。

这不表示字节码天然更快。短命 CLI、冷启动函数和内存严格的容器可能更适合 CDS/AOT 或 Native Image；后者用构建期闭世界分析换启动与内存，但会约束反射、动态代理、资源发现和动态加载，仍需按应用验证。

## 5. WORA 的准确边界

“Write Once, Run Anywhere”成立需要目标环境有兼容的 JVM、依赖和外部能力。以下内容不会被字节码自动抹平：

- JNI/JNA、本地库与 CPU 特定 intrinsic；
- 文件路径、大小写、换行、默认字符集、时区与 locale；
- 文件权限、信号、进程树、文件描述符、`epoll`/IOCP；
- 可用内存、线程上限、容器 cgroup、时钟精度；
- 图形、设备驱动和外部命令；
- 未固定版本的反射内部 API 或 HotSpot 参数。

JDK 18 后标准 API 的默认 charset 改为 UTF-8（JEP 400），但文件系统、控制台或本地工具仍可能有自己的编码。可移植代码应显式声明协议编码，并在目标 OS/容器运行集成测试。

## 6. 为什么保留基本类型

`int`、`long` 等值可直接进入局部变量槽、操作数栈、字段或连续数组。若一切都是独立对象，整数数组会多出引用和对象头，增加间接寻址、分配和 GC 压力。基本类型也便于 JVM 映射到硬件算术。

代价是类型系统有“值类型/引用类型”裂缝：泛型不能直接用 `int`，自动装箱可能分配，`null` 拆箱会抛异常，`Integer == Integer` 还受到缓存影响。Valhalla 正在演进对象模型，但实验特性不能提前当成当前 Java 21 语义。

## 7. 为什么类没有多继承、接口却可多继承

两个父类可能同时携带状态、构造协议和同签名实现，菱形结构需要决定字段复制、构造顺序与方法选择。Java 选择单一类继承，保持对象状态和 `super` 链清楚；接口主要表达类型契约，并允许多个上级接口。

默认方法后来给接口带来实现复用，但冲突有明确规则：类方法优先、更具体接口优先，否则实现类必须显式消歧。它没有引入多份父类实例状态，因此不是 C++ 式多继承。

工程上“组合优于继承”不是禁用继承：稳定的 is-a 契约与模板方法可用继承；需要运行期替换、多维变化或隔离副作用时优先组合。Agent Tool、Model Provider、Retriever 很适合作为接口与组合，而不是深类树。

## 8. 泛型为何长期使用擦除

Java 5 必须让新泛型类库与旧 Class 文件、旧 JVM、旧客户端二进制互操作。擦除把 `List<String>` 与 `List<Integer>` 映射到相同运行时类，在必要处插入 `checkcast`，并用桥接方法保持重写后的多态。

收益是迁移兼容和较少的 VM 改动；代价包括不能 `new T()`、不能创建普通泛型数组、基本类型需要装箱、运行时不能直接区分大部分参数化类型。Class 文件的 `Signature` 属性可保留一部分声明泛型元数据供编译器和反射使用，所以“擦除”不等于所有泛型字符都从文件消失。

## 9. 兼容性是三个不同问题

```text
源码兼容：旧源码能否被新 javac 再编译？
二进制兼容：旧 class 是否能与新库链接并运行？
行为兼容：即使编译/链接成功，输出、性能、异常时机是否相同？
```

给公开库的方法新增重载可能让旧源码的 `null` 调用变得歧义，但已编译客户端仍绑定原描述符；删除方法会产生 `NoSuchMethodError`；改变默认 locale、GC、反射限制可能保持二进制兼容却改变行为。升级验收必须同时覆盖重新编译、旧二进制运行和关键业务行为，不能只看“服务启动成功”。

Java 版本演进谨慎，是因为生态依赖二进制链接、序列化、反射、框架扫描和多年运行的服务。弃用通常先告警再移除；preview/incubator 特性让设计能迭代，但使用者必须显式 opt-in，不能向生产库稳定 API 泄漏。

## 10. 与 C++、Go、Kotlin 的对照

| 维度 | Java | C++ | Go | Kotlin/JVM |
|---|---|---|---|---|
| 常见部署 | Class/JAR + JVM | 平台本地二进制 | 平台本地静态/动态链接二进制 | Class/JAR + JVM |
| 内存 | GC，受控引用 | 手动/RAII/智能指针 | GC | 复用 JVM GC |
| 泛型 | 擦除为主 | 模板实例化 | 编译期泛型实现细节由编译器决定 | JVM 后端通常受擦除约束，inline reified 可在调用点具体化部分操作 |
| 多态 | 类单继承 + 接口 | 类多继承可用 | 结构化接口组合 | Java 类模型 + 更丰富语法 |
| 运行时优化 | profile-guided JIT | 静态优化/PGO | 静态编译 + runtime | 取决于 JVM 与生成字节码 |

这张表只说明常见路径，不用于简单评判优劣。选择语言要看部署、延迟、内存、互操作、团队和生态，而不是单一微基准。

## 11. 可重复实验：证明格式契约

```powershell
New-Item -ItemType Directory -Force out | Out-Null
javac --release 21 -d out examples\language\ValueSemanticsLab.java
javap -classpath out -verbose dev.deepjava.language.ValueSemanticsLab
```

重点观察：

- `major version: 65` 表示 Java 21 Class 版本；它不是 OS 或 CPU 编号。
- 常量池和指令没有 x86 寄存器名，说明它仍是 JVMS 层契约。
- 用较老 JVM 加载更高 major version 会在链接前失败，通常是 `UnsupportedClassVersionError`。
- `--release 21` 同时约束语言级别、目标 Class 版本和可见的标准 API；只写 `-source` 不足以防止误用新 JDK API。

对照组：在 JDK 25 上仍以 `--release 21` 编译，再用 JDK 21 运行。若用了 Java 25 新 API，编译应失败；这比在 CI 偶然发现运行错误更早。

## 12. 后端与 Agent 场景

后端插件若让宿主 API 由父加载器加载、插件实现由子加载器加载，可以共享契约并隔离依赖；若插件连 API 接口也私带一份，即使类名相同也无法转换。Agent Code Runner 更不能把“JVM 能验证字节码”误当安全沙箱：验证器防止非法 Class 结构，不会阻止合法 Java 代码删文件、访问网络或耗尽 CPU。

Native Image 可能改善模型网关冷启动，但 Tool 插件、动态代理、资源扫描和 Agent 动态扩展会提高配置成本。先按完整功能做 reachability/启动/RSS/峰值延迟对照，再选部署模式。

## 13. 常见错误与排障

| 现象 | 首要问题 | 证据 |
|---|---|---|
| `UnsupportedClassVersionError` | 编译目标是否高于运行 JVM | `java -version`、`javap -v` major |
| `NoSuchMethodError` | 编译期与运行期依赖是否不同 | `-verbose:class`/`-Xlog:class+load`、依赖树 |
| 同代码跨机乱码 | 是否依赖默认 charset/locale | 启动参数、`Charset.defaultCharset()`、协议抓包 |
| 本地快、容器慢 | CPU quota、内存、页故障、JIT 预热是否不同 | cgroup 指标、JFR、启动日志 |
| 插件 `ClassCastException` | 同名类是否由不同 loader 定义 | 打印 `getClassLoader()` 与 protection domain |

## 14. 面试追问

1. **JVM 为什么跨平台？** Class 格式与指令语义统一，每个平台实现 JVM；跨平台的是契约，不是 JNI、文件系统或资源上限。
2. **Java 到底是不是解释型？** 源到字节码先编译；具体 JVM 可解释、JIT 或 AOT，二分法遗漏执行阶段。
3. **OpenJDK 和 Oracle JDK 的关系？** OpenJDK 是开源实现项目和参考实现基础；厂商提供构建、补丁、许可证与支持策略，语言仍服从同一 Java SE 规范。
4. **为什么版本升级谨慎？** 源码、二进制、行为和反射生态的兼容面巨大；稳定性是平台资产。
5. **字节码是否安全沙箱？** 不是。验证保证结构/类型安全的一个层面，不授权业务资源，也不限制合法副作用。

## 15. 检查清单

- [ ] 能区分 JLS、JVMS、JDK、HotSpot 和发行版。
- [ ] 能解释解释器/JIT 是实现选择，不是语言定义。
- [ ] 能列出至少五个 WORA 边界。
- [ ] 能区分 source/binary/behavior compatibility。
- [ ] 能用 `--release` 与 major version 验证兼容目标。
- [ ] 不把 JDK 25 的 Compact Object Headers 当成 JDK 21 默认布局。

## 16. 延伸阅读

- [JVMS 1.2：Java Virtual Machine](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-1.html#jvms-1.2)
- [JVMS 4：Class File Format](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-4.html)
- [JLS 13：Binary Compatibility](https://docs.oracle.com/javase/specs/jls/se21/html/jls-13.html)
- [JDK 21 JEP 列表](https://openjdk.org/projects/jdk/21/jeps-since-jdk-17)
- [JDK 25 与 JEP 519](https://openjdk.org/projects/jdk/25/)

下一章：[02-type-system-and-core-syntax.md](02-type-system-and-core-syntax.md)
