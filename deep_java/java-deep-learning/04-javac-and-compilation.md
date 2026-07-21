# 04｜javac 编译过程：从字符流到可验证的 Class 文件

> 优先级：S｜难度：★★★★★｜基线：OpenJDK javac 21｜前置：[02](02-type-system-and-core-syntax.md)

## 1. 本章目标

能够按阶段解释 `javac` 如何解析源码、建立符号、做类型归因与数据流检查、运行注解处理、消除语言糖并生成 Class；能区分语言规范要求与 javac 的内部组织；能用 `-XprintRounds`、`-XprintProcessorInfo`、`-XD-printflat`（内部选项，可能变化）和 `javap` 验证，而不是把“语法糖”当黑盒。

## 2. 编译不是一次文本替换

```text
Unicode source
   │ lexical translation / tokens
   ▼
Parser ──► AST
   │        │
   │      Enter：声明进入 Symbol/Table
   │        │
   │      Annotation Processing rounds ──► 新 source/class ─┐
   │        │                                                │
   └────► Attr：名称解析、重载、类型检查/推断 ◄──────────────┘
            │
          Flow：可达性、definite assignment、异常流
            │
          TransTypes / Lower / LambdaToMethod / StringConcat
            │
          Gen / ClassWriter
            ▼
       .class：CP、fields、methods、attributes、bytecode
```

阶段名是 OpenJDK javac 21 的实现地图，不是 JLS 要求所有编译器必须有同名类。JLS 定义源程序是否合法及其语义，JVMS 定义 Class 格式和指令约束；其他编译器可以用不同 pipeline 产生等价 Class。

## 3. 词法、语法与 AST

词法阶段把字符分成 identifier、keyword、literal、operator 等 token。Java 的 Unicode escape 在词法翻译早期处理，甚至能影响注释和换行，安全审查不能只看渲染后的字符。解析器依据语法构建 AST：类声明、方法、变量、表达式和语句成为不同节点。

AST 保留的是源级结构，不等于最终指令。例如 enhanced-for、try-with-resources、lambda、record、string switch 后续会改写；因此“AST 里有一个节点”不能推出 Class 文件里有同名概念。

语法错误发生在 parser 尚无法形成合法树时；类型错误通常发生在 Attr；未初始化局部变量和 checked exception 泄漏常由 Flow 发现。定位编译器 bug 时先确定失败阶段，能显著缩小范围。

## 4. Enter、符号表与名称解析

编译器必须先知道有哪些包、模块、类型和成员，才能解释名字。Enter 阶段为顶层/成员声明建立 `Symbol`，维护作用域和 owner 关系；后续名称解析把源码中的 `List`、`x`、`map` 绑定到具体 symbol。

同一个简单名可能来自当前类、继承成员、单类型 import、同包、按需 import 等，冲突按 JLS 规则处理。Classpath/module-path 不只是“找 jar”：它们决定哪些符号可观察、哪个二进制声明被选中。编译成功但运行时 jar 不同，就可能得到 `NoSuchMethodError`、`IllegalAccessError` 等 linkage failure。

### 模块化编译

JPMS 增加 readability 和 exports。某类物理上存在于 module path，不代表当前模块可读或包已导出；`opens` 主要影响深反射，不等于编译期 `exports`。不要用 `--add-exports/--add-opens` 常驻掩盖模块边界，除非明确记录兼容债务。

## 5. Attr：类型归因、重载与推断

“归因”给 AST 表达式赋类型并检查上下文。方法调用要做候选收集、可访问性、适用性、最具体选择、泛型约束求解；lambda/poly expression 的类型还依赖目标类型，因此不能总是从子表达式独立自底向上决定。

```java
static void use(java.util.function.Function<String, Integer> f) {}
static void use(java.util.function.UnaryOperator<String> f) {}
// use(x -> x.length()); // 只有第一候选返回类型匹配，但真实解析还要走约束归约
```

重载是编译期绑定：Class 文件方法引用包含 owner、name、descriptor。运行时重写分派只在已选描述符对应的方法家族内发生。新增重载可能让旧源码重新编译时绑定不同方法，即使旧 Class 二进制仍调用原描述符。

泛型推断不是“猜 T”：编译器收集兼容、子类型、相等约束，归约为 inference variable 的 bounds，再求解。通配符捕获会引入不可命名的新类型变量；错误信息中的 `CAP#1` 正是捕获转换的痕迹。

## 6. 注解处理是多轮元编程，不是运行时反射

JSR 269 processor 读取 `javax.lang.model` 的声明模型，通过 `Filer` 生成源码、Class 或资源。新源码会进入下一 round；最后一轮 `processingOver()==true`。处理器不能可靠地任意改写现有 javac AST，依赖内部 API 的做法与编译器版本强耦合。

本仓库实验：

```powershell
cd labs\annotation-processor
.\run.ps1
```

它先编译 `@GenerateGreeting` 与 `GreetingProcessor`，再显式通过 `-processorpath/-processor` 编译 `Demo`。processor 生成 `DemoGreeting.java`，javac 在后续 round 编译生成类，程序输出：

```text
hello from a generated type
```

加上 `-XprintRounds -XprintProcessorInfo` 可观察每轮输入/注解/processor。工程注意点：

- 处理同一元素要幂等，避免重复创建文件；
- 用 originating element 关联增量构建依赖；
- 生成稳定、可读、确定性的源码，错误通过 `Messager` 绑定元素；
- 不在 processor 中访问网络或依赖环境时间，否则构建不可复现；
- JDK 23 起注解处理器发现/启用策略有安全演进，构建应显式声明 processor，按目标 JDK 工具文档校准。

## 7. Flow：编译期数据流不是运行期数据流

Flow 关注可达性、局部变量 definite assignment/unassignment、checked exception、模式变量流作用域等。例如：

```java
int value;
if (condition) value = 1;
// consume(value); // condition=false 路径未赋值，编译拒绝
```

分析通常是保守的：编译器证明所有相关路径安全才放行。它不等于全程序静态分析，不证明数组不越界、引用不为 null、SQL 安全或线程安全。

## 8. 解糖：语义保留，形状可以变化

配套 [DesugaringLab.java](examples/compiler/DesugaringLab.java) 覆盖以下机制。

### 8.1 内部类与匿名类

成员/匿名类通常生成额外 Class 文件。捕获外部实例会出现合成字段（常见 `this$0`）和构造参数；捕获局部值也会复制进字段。Java 11 nestmate 属性减少同一 nest 私有访问所需的合成 accessor，因此旧资料中的 `access$000` 不一定出现在 JDK 21 输出。

### 8.2 Lambda

lambda 通常不生成固定的匿名 `$1.class`。javac 生成合成实现方法，并在调用点放 `invokedynamic`；`BootstrapMethods` 指向 `LambdaMetafactory`。运行时第一次链接 call site，再产生/获取函数对象策略。无捕获 lambda 可能复用实例，但 identity 不应成为业务契约。

### 8.3 enum

enum 编译为继承 `java.lang.Enum` 的 final-ish 枚举类，常量是静态字段，并有 `$VALUES`、`values()`、`valueOf()` 等合成结构。switch 的 mapping 形式是编译器策略；持久化 ordinal 会因插入常量而破坏兼容。

### 8.4 record

record 生成组件字段、访问器、构造器及 Object 方法，Class 文件带 `Record` 属性。JDK 21 javac 常用 `invokedynamic` + `java.lang.runtime.ObjectMethods.bootstrap` 实现 `equals/hashCode/toString`。这是生成策略，不是 record 语义要求永久如此。

### 8.5 try-with-resources

编译器建立主异常与关闭异常路径，调用 `addSuppressed`，资源逆序关闭。若手写 finally 覆盖原异常，会丢失真正故障；`javap -c -v` 的 exception table 能显示 handler 范围和跳转。

### 8.6 泛型、桥接与 cast

`Mapper<String>.map(String)` 擦除后接口方法是 `map(Object):Object`。为保持重写，编译器在实现类生成 `ACC_BRIDGE, ACC_SYNTHETIC` 的 `map(Object)`，其中 `checkcast String` 后调用具体方法。运行时类型安全来自编译期约束与插入的 cast，不是 JVM 认识 `List<String>` 的完整参数化类型。

### 8.7 switch 与字符串拼接

密集整数适合 `tableswitch`，稀疏值适合 `lookupswitch`，但选择阈值是编译器决策。字符串拼接在 JDK 9+ 常降为 `invokedynamic`/`StringConcatFactory`；编译期常量先折叠。阅读字节码要识别 bootstrap，不能只找 `StringBuilder`。

## 9. 字节码生成与 ClassWriter

生成阶段把表达式转为基于操作数栈的指令，分配局部变量槽，计算分支/异常表并写常量池和属性。`max_stack` 是方法执行所需最大操作数栈深度，不是线程栈字节大小；`max_locals` 是槽位数，实例方法 slot 0 通常是 `this`。

调试信息取决于编译参数：`-g` 生成行号、局部变量等信息，`-parameters` 保留方法参数名。它们影响调试、反射和文件大小，不改变 Java 语义。生产是否去除要权衡可观测性，不要为了微小体积让 stack trace 与诊断失去上下文。

## 10. 编译期常量与初始化边界

满足 constant expression 的 `static final` primitive/String 可内联进使用方 Class。库把 `public static final int TIMEOUT=10` 改成 20 后，只替换库 jar而不重编客户端，客户端仍可能使用 10。需要运行时可变配置就不要发布为可内联常量契约。

常量折叠可能删除计算和分支，导致字节码与源码直觉不同；这属于编译期可证明变换。不要用只含常量的微基准测真实算法。

## 11. 增量编译不是 javac 的语义保证

javac 可以一次编译一组 compilation units，并通过 Classpath 读取其他二进制；IDE/Gradle/Maven 的增量系统负责判断哪些源受影响。困难在于依赖不只存在于 import：常量内联、注解处理生成物、package-private 访问、泛型签名、sealed permits、模块描述符都可能扩大重编范围。

可靠构建需要：

1. processor 声明 isolating/aggregating 特性（构建工具约定）；
2. CI 定期做 clean build，与 incremental 输出/测试比较；
3. 发布库做 API/ABI 兼容检查；
4. 不缓存依赖未锁定、环境未记录的 Class 输出。

## 12. 编译错误、链接错误、运行错误

| 阶段 | 示例 | 典型证据 |
|---|---|---|
| parse/attr/flow | 语法错、重载歧义、未赋值、checked exception | javac diagnostic + 源位置 |
| Class 验证 | 非法 stack map、错误类型流 | `VerifyError`、`javap -v` |
| 加载/链接 | 缺类、缺方法、访问不兼容 | `ClassNotFoundException`、`NoSuchMethodError` |
| 初始化 | `<clinit>` 抛异常 | 首次 `ExceptionInInitializerError`，后续 `NoClassDefFoundError` |
| 执行 | NPE、业务异常、资源失败 | stack trace、JFR、日志/trace |

“编译通过”只证明源程序满足编译期规则并产出结构，不证明运行依赖、数据、并发和外部系统正确。

## 13. 验证命令与预期

```powershell
cd deep_java\java-deep-learning
.\labs\compile-and-inspect.ps1

Get-ChildItem build\classes\dev\deepjava\compiler
javap -classpath build\classes -c -v -p dev.deepjava.compiler.DesugaringLab
javap -classpath build\classes -c -v -p 'dev.deepjava.compiler.DesugaringLab$StringMapper'
```

逐项确认：

- 匿名类有独立 `$1.class`，lambda 调用点有 `InvokeDynamic`；
- `StringMapper` 有 bridge/synthetic 方法；
- TWR 有 exception table 和 `addSuppressed`；
- record 有 `Record`/bootstrap 属性；
- `-g -parameters` 让行号、局部变量和参数名可见。

实验报告必须保存 `javac -version`、命令和完整输出。只贴三行反汇编无法排除编译版本或参数差异。

## 14. 后端与 Agent 应用

Spring 的配置元数据、MapStruct、Dagger 等常用处理器把错误前移到编译期；运行时反射更灵活但把失败和成本留到启动/请求阶段。Tool schema 也可由注解处理器生成，不过安全约束必须由运行时确定性校验执行，不能因为 schema 是编译生成就信任模型参数。

Agent 插件 SDK 的 ABI 需要显式版本：修改方法描述符会让旧插件 linkage failure；新增 default method 可能兼容二进制但改变冲突解析。编译期生成 Tool Registry 时记录 provider、schema version、permission scope 与 effect type，避免只有方法名。

## 15. 性能和安全边界

- processor 位于构建信任边界，能读写构建进程可访问的资源；依赖供应链必须锁版本与校验。
- 过度生成会增加编译时间、Class 数、metaspace 和启动扫描成本。
- 大方法/深表达式可能拖慢 Attr/Flow 或阻碍 JIT 内联；不要用生成代码体积换表面“零反射”。
- Class 文件更小不必然运行更快；JIT 看的是热点、profile、内联预算与机器码。

## 16. 常见误区

1. **“javac 优化很强，所以运行前性能已确定”**：javac 主要做语义翻译与有限折叠，热点优化主要在 JIT。
2. **“lambda 就是匿名内部类”**：语言用途相近，Class 形态、identity、序列化和链接机制不同。
3. **“类型擦除后完全没有泛型信息”**：执行描述符擦除，但 `Signature` 等属性可保留声明信息。
4. **“增量编译成功等于 clean build 成功”**：依赖图可能漏边，必须有 clean 对照。
5. **“注解处理器能像反射一样看运行时对象”**：处理的是编译模型，不执行未来对象。

## 17. 面试题与检查清单

**Q：javac 的关键阶段？** 解析 AST、进入符号、注解处理、类型归因、Flow、解糖、字节码/Class 写出；名称仅对应 javac 实现，不是 JLS 强制架构。

**Q：桥接方法为什么必要？** 擦除后接口/父类描述符与具体参数方法不同，bridge 保持 JVM 方法重写和多态契约，并在入口 cast。

**Q：注解处理能修改已有代码吗？** 标准 JSR 269 主要生成新文件、读取元素模型；直接修改 javac AST 依赖内部 API，版本脆弱。

- [ ] 能把一个编译错误定位到 parse/attr/flow。
- [ ] 能解释 lambda、TWR、record、enum、bridge 的 Class 证据。
- [ ] 能区分 method descriptor 与 generic Signature。
- [ ] 知道 processor round、幂等与构建安全问题。
- [ ] 能解释 `--release` 与 clean/incremental build 的边界。

## 18. 延伸阅读

- [JLS 7.3：Compilation Units](https://docs.oracle.com/javase/specs/jls/se21/html/jls-7.html#jls-7.3)
- [JLS 15.12：重载解析](https://docs.oracle.com/javase/specs/jls/se21/html/jls-15.html#jls-15.12)
- [JLS 18：Type Inference](https://docs.oracle.com/javase/specs/jls/se21/html/jls-18.html)
- [JVMS 4：Class File](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-4.html)
- [javac tool specification](https://docs.oracle.com/en/java/javase/21/docs/specs/man/javac.html)
- 本机 OpenJDK 源码：`$JAVA_HOME/lib/src.zip` 与对应 `jdk.compiler` 模块 tag

下一章：[05-class-file-and-bytecode.md](05-class-file-and-bytecode.md)
