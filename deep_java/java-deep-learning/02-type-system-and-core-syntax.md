# 02｜类型系统与语言内核：值、槽位、对象和字符不是一回事

> 优先级：S｜难度：★★★★｜基线：Java SE 21｜前置：[01](01-java-language-design.md)

## 1. 本章目标

本章不按关键字罗列语法，而是沿“源码类型 → 编译期转换 → 字节码槽位 → 运行时对象”解释变量、基本类型、引用、参数传递、装箱、控制流、现代数据类型和 `String`。完成后应能预测常见表达式的类型与结果，并用 `javap` 说明预测依据。

## 2. 变量是有类型的存储位置，值不是变量

JLS 把变量分为局部变量、参数、字段、数组元素等。区别直接影响初始化、生命周期和并发可见性：

| 位置 | 默认值 | 典型存放 | 生命周期/可见性 |
|---|---|---|---|
| 局部变量 | 没有；必须 definite assignment | 当前栈帧局部变量表或被 JIT 消除 | 方法调用范围内，默认线程私有 |
| 参数 | 调用方传入的值副本 | 新栈帧槽位 | 方法调用范围内 |
| 实例字段 | 有零值/`null` | 对象实例数据，或被优化 | 随对象可达性；共享需同步 |
| 静态字段 | 有零值/`null` | 与类元数据关联的镜像/存储实现 | 随定义类及 loader 生命周期 |
| 数组元素 | 有零值/`null` | 数组对象连续元素区 | 随数组可达性；共享需同步 |

“局部变量在栈、对象在堆”只是未优化解释模型。JVMS 允许栈帧用任意方式分配，JIT 也可把值放寄存器、做标量替换或完全删除。语义上重要的是可观察行为，不是某一时刻的物理地址。

作用域是名字在源码中可被引用的静态范围；生命周期是运行时存储仍存在的时间。lambda 捕获的 effectively-final 局部值可在方法返回后继续存在，因为编译器把捕获值带入 lambda 对象/调用点；这不等于原栈帧永生。

## 3. 八种基本类型：表示、提升与溢出

| 类型 | 语义范围/表示 | 字节码家族 | 注意 |
|---|---|---|---|
| `byte` | -128…127，二进制补码 | 大多用 `int` 指令 | 运算先数值提升为 `int` |
| `short` | -32768…32767 | 大多用 `int` 指令 | 同上 |
| `char` | 0…65535 的 UTF-16 code unit | 大多用 `int` 指令 | 不是完整 Unicode 字符 |
| `int` | 32-bit 补码 | `i*` | 溢出按低 32 位回绕，不抛异常 |
| `long` | 64-bit 补码 | `l*` | 局部变量表历史上占两个 slot |
| `float` | IEEE 754 binary32 | `f*` | NaN、±Infinity、舍入 |
| `double` | IEEE 754 binary64 | `d*` | `0.1` 通常不能精确表示 |
| `boolean` | 语言层只有 true/false | 无独立完整指令族 | JVM 方法/字段常按 int-like 处理；数组有专门约束 |

补码让同一加法器处理有符号加减，但最高位权重为负。`Integer.MAX_VALUE + 1` 得到 `Integer.MIN_VALUE`；需要检测时用 `Math.addExact`。金额不要用 binary floating point 做十进制相等比较，应按业务选择最小货币单位整数或 `BigDecimal`，并明确 scale 与 rounding mode。

### IEEE 754 不是“随机误差”

`0.1` 的二进制展开无限循环，存储时舍入到有限尾数；`0.1 + 0.2` 的舍入结果与 `0.3` 的表示不同。NaN 还满足 `NaN != NaN`，排序和聚合必须使用库定义的比较契约。`strictfp` 在现代 Java 中不再像早期平台那样改变核心浮点计算结果，但历史代码和不同 JDK 版本要查对应 JLS。

### `boolean` 的分层描述

JLS 定义布尔值，不规定字段占几个字节。JVMS 没有通用 boolean 算术指令，编译器通常用 `iconst_0/1`、整数分支；`boolean[]` 通过 `newarray T_BOOLEAN` 创建，访问共用 `baload/bastore` 指令。HotSpot 对字段和数组的物理布局属于实现细节，必须用 JOL/源码对目标版本观察。

## 4. 引用值不是语言承诺的物理地址

引用变量的值要么是 `null`，要么指称某个对象/数组。JLS/JVMS 不承诺它等于可做算术的物理地址。压缩 Oops 可把引用编码成相对 heap base 的窄值；移动式 GC 复制对象后更新 roots、引用或借助 barrier 保持正确。

```text
局部槽 first ──[reference value]──► Box { value = 1 }
局部槽 copy  ──[同一对象的引用值副本]─┘
```

`==` 对基本数值比较提升后的值，对引用比较是否指称同一对象；`equals` 是可重写的方法契约。作 Map key 的对象若其 `equals/hashCode` 参与字段可变，插入后修改会让条目落在旧 bucket 却按新 hash 查询，形成“看得见对象却查不到 key”的逻辑泄漏。

## 5. Java 只有值传递

调用方法时，实参表达式先求值，再把结果复制到被调方法的新参数槽位：

- 基本类型复制数值；
- 引用类型复制引用值，不复制对象，也不传“变量的地址”。

配套 [ValueSemanticsLab.java](examples/language/ValueSemanticsLab.java) 中：

```java
static void mutate(Box copy)  { copy.value++; }
static void replace(Box copy) { copy = new Box(999); }
```

`mutate` 通过引用副本找到同一对象并改字段，因此调用方可观察；`replace` 只把被调栈帧的 `copy` 槽改为另一个引用，调用方槽位不变。所谓“对象按引用传递”会错误预测 `replace` 能替换调用方变量。

典型字节码形状：

```text
mutate:  aload_0        // 复制参数槽里的引用值到操作数栈
         dup
         getfield value
         iconst_1
         iadd
         putfield value

replace: new Box
         dup
         sipush 999
         invokespecial Box.<init>
         astore_0       // 只覆盖当前方法的 slot 0
```

内存图用于解释语义，不能借此声称引用一定是 32/64 位裸地址。

## 6. 转换、提升、重载与 varargs

赋值转换、方法调用转换、字符串转换、强制转换的许可范围不同。二元数值提升常让新手意外：

```java
byte a = 1, b = 2;
// byte c = a + b;       // a+b 的类型是 int，编译失败
byte c = (byte) (a + b); // 显式窄化，可能截断
```

重载在编译期根据声明类型和适用性选择描述符，不随运行时接收者参数类型“二次选择”；重写才由运行时接收者动态分派。候选大致经历固定元数/不装箱优先、允许装箱、最后 varargs；随意新增重载可能使 `null` 或 lambda 调用变歧义。

可变参数只是调用侧/方法声明的数组语法糖。每次非透传调用通常要创建数组；泛型 varargs 还可能产生堆污染。热路径 API 应评估分配，不要仅因语法短就默认零成本。

自动装箱调用 `Integer.valueOf` 等工厂；拆箱调用 `intValue`。因此：

```java
Integer x = null;
// int y = x;             // 编译通过，运行时 NPE
Integer a = 127, b = 127; // 规范要求的常用缓存范围内通常同一实例
Integer c = 128, d = 128; // 不要依赖 identity；使用 equals
```

整数包装缓存的正确工程结论是“包装值比较用 `equals`/拆箱后的值”，而不是背某个 JVM 可调缓存上限。

## 7. 控制流、definite assignment 与表达式语义

编译器对局部变量做 definite assignment 分析，保证每条可达路径在读取前赋值。字段则在构造逻辑前先有零值。短路运算符 `&&`/`||` 会生成条件分支，右操作数可能不执行；位运算 `&`/`|` 用在 boolean 时两边都会求值。

`switch` 在 Class 层不只有一种形态：密集整数常生成 `tableswitch`，稀疏整数生成 `lookupswitch`；String switch 通常先按 hash 分派再 `equals` 确认；enum switch 的具体编译策略可随 javac 版本变化。pattern matching 还引入类型测试、绑定变量与穷尽性检查，不能简单等同为手写 `instanceof` 一行。

断言 `assert` 默认关闭，只适合开发期内部不变量，不用于外部参数校验、授权或业务错误；生产必需检查必须显式执行。

## 8. enum、record、sealed 与 pattern matching

- `enum` 是受限实例集合的类：常量是静态实例，有编译器生成的 `values/valueOf` 等成员；序列化与数据库持久化不要依赖 ordinal。
- `record` 是透明数据载体：组件生成 private final 字段、访问器、`equals/hashCode/toString` 等；它是浅不可变，组件引用的对象仍可变。
- `sealed` 让声明方列出直接子类型，为封闭层次和穷尽 switch 提供基础；跨模块/包规则以 JLS 21 为准。
- pattern matching 缩短安全类型检查与提取，但不会自动校验业务不变量。record compact constructor 仍应拒绝非法状态。

Agent 的状态与事件很适合 `sealed interface Event permits ...` + records：编译器可以检查遗漏分支；但协议演进新增事件会要求客户端升级，因此持久化格式仍需 type/version/unknown-event 策略。

## 9. String：三个层次必须拆开

### 9.1 Unicode、UTF-16 与 UTF-8

Java `String` 的抽象是 UTF-16 code unit 序列。一个 BMP 外 code point 用 surrogate pair，占两个 `char`，所以 `length()` 不是用户看到的字符数，更不是 UTF-8 字节数。协议长度限制要先明确单位：code unit、code point、grapheme cluster 还是编码后 byte。

[ValueSemanticsLab](examples/language/ValueSemanticsLab.java) 验证 `"A😀".length()==3`、code point 数为 2、UTF-8 字节数为 5。截断流式模型输出若按 `char` 或 byte 生切，可能破坏 surrogate pair 或 UTF-8 多字节序列。

### 9.2 不可变与内部表示

不可变让字面量共享、hash 缓存、安全边界和并发读取更简单；所谓不可变指 API 观察不到字符内容变化。JDK 9+ OpenJDK `String` 使用 Compact Strings 思路，以 `byte[] value` 和 coder 区分 Latin-1/UTF-16；这属于 JDK 类库实现，不是 JLS 对所有实现的字段布局保证。

不可变不代表零成本：substring 在现代 JDK 通常复制相关内容，不再长期共享原大数组；大量短命拼接仍会分配；保存超长 prompt、tool output 或文档 chunk 会直接增加 heap live set。

### 9.3 池、`new`、拼接与 `intern`

字面量进入运行时字符串池并可共享。`new String("x")` 明确创建新的 String 实例；字面量池对象是否此前已存在取决于类加载和执行上下文，不能机械回答“永远创建两个对象”。

常量表达式 `"a" + "b"` 可由 javac 折叠为 `"ab"`。变量拼接在 JDK 9+ javac 常生成 `invokedynamic`，由 `StringConcatFactory` 在运行时链接合适策略，不应再把所有 `+` 固定描述成源码级 `new StringBuilder`。循环中累积仍应显式 `StringBuilder` 或流式写出，避免 O(n²) 复制风险。

`intern()` 返回池中的 canonical 引用，可能减少高重复字符串，却把查池、生命周期和内存压力引入全局机制。先用 heap dump/JFR 证明重复占用，再决定去重策略；对高基数用户输入盲目 intern 可能适得其反。

## 10. 异常与资源边界（本章所需最小模型）

异常不是隐式返回码：`athrow` 根据方法异常表寻找 handler，找不到就展开栈。`finally` 由编译器复制/组织控制流保证正常和异常路径执行。try-with-resources 会按声明逆序关闭资源；若主体和 `close` 都失败，主体异常为主，关闭异常进入 `getSuppressed()`。

在后端/Agent 中，`timeout`、`cancelled`、`retryable`、`result_unknown` 不应全压成一个 RuntimeException。尤其远程请求超时只说明调用方未按时收到结果，不能证明副作用未发生。

## 11. 编译与验证实验

```powershell
cd deep_java\java-deep-learning
.\labs\compile-and-inspect.ps1
javap -classpath build\classes -c -v -p dev.deepjava.language.ValueSemanticsLab
javap -classpath build\classes -c -v -p dev.deepjava.compiler.DesugaringLab
```

观察清单：

1. `mutate/replace` 的 `aload_0` 与 `astore_0`。
2. 装箱处对 `Integer.valueOf`、拆箱处对 `intValue` 的调用。
3. lambda 的 `invokedynamic` 与匿名类生成的 `$1.class`。
4. record 的字段、访问器、`Record` 属性以及 `ObjectMethods` bootstrap。
5. try-with-resources 中异常表与 `Throwable.addSuppressed`。
6. dense/sparse switch 的 `tableswitch/lookupswitch`。

工具输出是当前 javac 21 的证据；JLS 语义相同不代表未来 javac 必须生成逐字相同指令序列。

## 12. 性能与并发影响

| 选择 | 主要成本 | 并发含义 |
|---|---|---|
| 包装类型 | 对象/引用、潜在分配与空值 | 包装对象不可变，但引用发布仍受 JMM 约束 |
| String 拼接 | 数组分配与复制 | 局部 builder 安全；共享 builder 需外部同步 |
| record | 与普通 final 数据类相近，不是值类型 | 浅不可变，组件对象可变时仍不线程安全 |
| varargs | 数组分配 | 数组逃逸后可能被并发修改 |
| 大字符串 | heap live set、编码复制、GC | 流式处理要有 byte/token/事件缓冲上限 |

JIT 可能消除部分装箱与临时对象，但不能把“优化可能发生”写成 API 性能保证。使用 JMH 时必须消费结果、预热、fork，并检查生成代码/分配指标。

## 13. 常见错误与排障

| 错误 | 根因 | 修复/证据 |
|---|---|---|
| `Integer` 用 `==` 比值 | 比较 identity，缓存让问题时隐时现 | `equals` 或显式拆箱；查字节码 |
| 金额用 `double` | 二进制浮点不能精确表示多数十进制小数 | 整数最小单位/`BigDecimal(String)` |
| 方法“交换两个对象”无效 | 误以为按引用传递 | 画调用方/被调方槽位图 |
| 截断 emoji 乱码 | 混淆 char/code point/byte | 以 code point/编码器边界处理 |
| `String +=` 循环内延迟/GC 高 | 每轮复制与临时数组 | JFR allocation、显式 builder/流式输出 |
| record 当深不可变对象 | 组件持有可变集合 | 构造时 defensive copy，访问时只读视图 |
| 业务校验写 `assert` | 生产默认关闭 | 显式校验并返回稳定错误模型 |

## 14. 源码关键路径

带问题阅读 `$JAVA_HOME/lib/src.zip`：

- `java.lang.String`：`value/coder/hash` 如何配合；哪些构造会复制；编码转换在哪层发生。
- `java.lang.Integer`：`valueOf` 缓存与 parse 路径；不要把具体私有字段当规范。
- `java.lang.Record` 与 `java.lang.runtime.ObjectMethods`：record 生成方法如何通过 bootstrap 链接。
- javac 的 `TransTypes`、`Lower`、`StringConcat`：分别观察擦除/桥接、语言糖与拼接策略；准确路径以目标 tag 为准。

源码阅读后用最小样例和 `javap` 验证，不从某个私有方法名推断所有发行版。

## 15. 实验任务

1. 给 `ValueSemanticsLab` 加 `long/double` 参数，记录局部变量槽位变化。
2. 编写 `char` 截断 surrogate pair 的错误示例，再用 `offsetByCodePoints` 修复。
3. 比较常量拼接、局部变量拼接和循环拼接的 Class 文件；解释 BootstrapMethods。
4. 写一个持有可变 `List` 的 record，证明它不是深不可变，再 defensive copy。
5. 用 `-XX:+PrintStringTableStatistics`（目标 JVM支持时）观察高重复与高基数字符串；记录版本和参数。

## 16. 面试题

1. **Java 是值传递还是引用传递？** 只有值传递；引用类型实参复制的是引用值，能经副本改对象，不能改调用方变量槽。
2. **引用就是地址吗？** 规范不承诺；可能是压缩编码，GC 还能移动对象。
3. **为什么 `0.1+0.2!=0.3`？** 输入与运算结果分别舍入到 binary floating point，表示不同；不是 Java 独有 bug。
4. **`new String("x")` 创建几个对象？** 当前表达式明确创建一个新实例；字面量 canonical 对象是否已存在属于上下文，不能固定答“两个”。
5. **String `+` 一定变成 StringBuilder 吗？** 不一定；JDK 9+ 常用 `invokedynamic/StringConcatFactory`，常量还能折叠。
6. **record 是否零开销值类型？** 不是；Java 21 record 仍是普通引用类语义，只减少样板并表达透明载体。

## 17. 检查清单

- [ ] 区分变量、值、对象、引用与地址。
- [ ] 能从槽位图和字节码解释值传递。
- [ ] 能预测数值提升、窄化、溢出与装箱成本。
- [ ] 不把 `char`/`length()` 当用户字符数。
- [ ] 能区分字符串池、对象、后备数组与编码字节。
- [ ] 知道 record 是浅不可变引用类，sealed 是层次约束。
- [ ] 所有协议编码和资源上限都显式指定。

## 18. 延伸阅读

- [JLS 4：Types, Values, and Variables](https://docs.oracle.com/javase/specs/jls/se21/html/jls-4.html)
- [JLS 5：Conversions and Contexts](https://docs.oracle.com/javase/specs/jls/se21/html/jls-5.html)
- [JLS 15.12：Method Invocation Expressions](https://docs.oracle.com/javase/specs/jls/se21/html/jls-15.html#jls-15.12)
- [JVMS 2：JVM Structure](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-2.html)
- [JEP 280：Indify String Concatenation](https://openjdk.org/jeps/280)
- [JEP 254：Compact Strings](https://openjdk.org/jeps/254)

下一章（当前主线）：[04-javac-and-compilation.md](04-javac-and-compilation.md)
