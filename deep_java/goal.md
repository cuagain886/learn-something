请为我创建一套系统化、底层导向、工程实践导向的《Java 后端与 Agent 开发学习文档》。

## 一、学习目标

目标读者是一名具备基本编程经验，希望系统掌握 Java 后端与 Agent 开发的程序员。

这套学习文档不能停留在：

- 会写 Java 语法
- 会调用集合 API
- 会使用 Spring Boot
- 会配置 MyBatis
- 会调用大模型 API
- 会复制常见项目模板

而是需要从以下层次逐步建立完整知识体系：

```text
Java 语言设计
    ↓
Java 编译过程
    ↓
Class 文件与字节码
    ↓
JVM 类加载与运行时数据区
    ↓
解释执行与 JIT 编译
    ↓
对象模型、内存分配与 GC
    ↓
Java 内存模型与并发实现
    ↓
网络、数据库与中间件
    ↓
Spring 等后端框架底层机制
    ↓
分布式系统
    ↓
LLM、RAG、工具调用与 Agent 系统
```

最终需要具备以下能力：

1. 理解 Java 语言核心特性的设计原因，而不只是会使用语法。
2. 理解 Java 源代码如何经过编译、类加载、解释和 JIT 编译后执行。
3. 能够阅读和分析 Java 字节码。
4. 理解 JVM 内存模型、对象布局、内存分配和垃圾回收机制。
5. 理解 Java 并发工具背后的 Java Memory Model、CAS、锁和线程调度机制。
6. 理解集合、反射、动态代理、注解、泛型、Lambda 等语言和运行时特性的底层实现。
7. 理解 Spring Boot、Spring IoC、AOP、事务和 Web 框架的核心实现机制。
8. 能够设计和排查高并发 Java 后端系统。
9. 能够使用 Java 构建 LLM 应用、RAG 系统、工具调用系统和 Agent 工作流。
10. 能够分析 Agent 系统中的并发、状态、超时、取消、重试、幂等和资源隔离问题。
11. 能够使用 JVM 和 Linux 工具定位 CPU、内存、线程、GC、锁和网络问题。
12. 能够通过阅读 JDK、JVM 和主流框架源码进一步提升能力。

------

# 二、总体学习原则

整套文档必须遵循以下原则。

## 1. 不止讲“怎么用”

每个核心知识点都要回答：

1. 它解决了什么问题？
2. 为什么要这样设计？
3. 如果没有它会发生什么？
4. 编译器如何处理它？
5. JVM 如何执行它？
6. 它在字节码层面是什么样的？
7. 它在内存中如何表示？
8. 它有什么运行时成本？
9. 它在并发环境下是否安全？
10. 它在真实后端或 Agent 项目中如何应用？
11. 常见错误和性能问题是什么？
12. 如何通过工具验证结论？

例如，讲解 `synchronized` 时不能只说明语法，还需要覆盖：

```text
Java 源代码
    ↓
monitorenter / monitorexit 字节码
    ↓
对象头 Mark Word
    ↓
Monitor
    ↓
锁竞争与线程阻塞
    ↓
Java Memory Model 可见性语义
    ↓
JIT 编译器锁消除、锁粗化等优化
```

## 2. 明确区分不同层次

文档必须明确区分：

- Java 语言规范
- Java 编译器实现
- Class 文件格式
- JVM 规范
- HotSpot JVM 实现
- JDK 类库实现
- Spring 等框架实现
- Linux 操作系统行为

不能把某个 HotSpot 实现细节错误地描述成 Java 语言规范。

## 3. 重视验证

对重要结论，应尽可能设计实验，通过以下工具进行验证：

- `javac`
- `javap`
- `java`
- `jcmd`
- `jstack`
- `jmap`
- `jstat`
- Java Flight Recorder
- Java Mission Control
- VisualVM
- Arthas
- async-profiler
- JMH
- GC 日志
- Linux `top`
- Linux `pidstat`
- Linux `perf`
- Linux `strace`
- Linux `lsof`

------

# 三、内容范围

## 模块 1：Java 语言的设计与演进

讲解 Java 语言解决的问题、设计哲学和演进过程。

内容包括：

- Java 的设计目标
- 静态类型语言与动态类型语言
- 编译型语言与解释型语言
- Java 为什么采用字节码和虚拟机
- Write Once, Run Anywhere 的实现基础
- Java 与 C、C++、Go、Kotlin 的主要差异
- Java 语言规范、JVM 规范和 JDK 的关系
- OpenJDK、Oracle JDK 和其他发行版的关系
- Java SE、Jakarta EE 和 Spring 生态的关系
- Java 长期支持版本的概念
- Java 版本演进中的重要特性
- 向后兼容性
- 二进制兼容性
- 源码兼容性

重点回答：

- 为什么 Java 不直接编译成机器码？
- JVM 为什么能够跨平台？
- Java 的跨平台边界在哪里？
- Java 为什么保留基本类型，而不是一切皆对象？
- Java 为什么不支持多继承类？
- Java 为什么长期保持类型擦除泛型？
- Java 的版本升级为什么相对谨慎？

------

## 模块 2：Java 基础语法与语言内核

不能按普通语法教程简单罗列，需要从语言语义、编译器和运行时角度讲解。

包括：

- 变量
- 常量
- 作用域
- 生命周期
- 基本类型
- 引用类型
- 值传递
- 自动装箱与拆箱
- 数值提升
- 类型转换
- 运算符
- 控制流
- 方法调用
- 方法重载
- 可变参数
- 异常机制
- `try-catch-finally`
- `try-with-resources`
- 断言
- `enum`
- `record`
- sealed class
- pattern matching

重点深入：

### 基本类型与引用类型

需要讲解：

- 各种基本类型的表示
- 补码
- 浮点数 IEEE 754
- 浮点数精度问题
- `boolean` 在 JVM 中的实现特点
- 引用是否等同于内存地址
- 局部变量、字段和数组元素的默认值差异
- 包装类型缓存
- 自动装箱产生的对象和性能成本
- `Integer == Integer` 的典型问题

### Java 参数传递

必须明确讲解 Java 只有值传递：

- 基本类型传递的是值副本
- 引用类型传递的是引用值的副本
- 为什么方法可以修改对象状态，却不能替换调用方变量
- 使用字节码或内存示意图解释

### String

深入讲解：

- String 为什么不可变
- String 对象的内部表示
- 字符串常量池
- `new String()` 的对象创建情况
- 编译期字符串拼接
- 运行期字符串拼接
- StringBuilder
- invokedynamic 字符串拼接
- `intern()`
- 字符编码
- UTF-8、UTF-16、Unicode
- Compact Strings
- 大字符串带来的内存问题

------

## 模块 3：面向对象机制

包括：

- 类与对象
- 封装
- 继承
- 多态
- 抽象类
- 接口
- 默认方法
- 静态方法
- 内部类
- 匿名类
- Lambda
- 方法引用
- 组合优于继承
- SOLID 原则的适用边界

从底层深入讲解：

- 对象在 JVM 中如何表示
- 字段如何存储
- 实例方法如何调用
- 静态方法如何调用
- `this` 的本质
- 构造方法的执行过程
- 父类构造器调用
- 方法重载在编译期如何确定
- 方法重写在运行期如何分派
- `invokevirtual`
- `invokespecial`
- `invokestatic`
- `invokeinterface`
- `invokedynamic`
- 虚方法表的基本思想
- 单分派
- 多态调用的性能成本
- JIT 如何进行内联和去虚拟化

必须通过 `javap` 展示不同调用形式对应的字节码。

------

## 模块 4：Java 编译过程

这是重点模块，需要深入讲解。

包括：

- Java 源代码到 Class 文件的完整流程
- 词法分析
- 语法分析
- 抽象语法树 AST
- 符号表
- 名称解析
- 类型检查
- 泛型检查
- 注解处理
- 语法糖解糖
- 字节码生成
- 编译期常量折叠
- 编译期错误和运行时错误
- 增量编译
- 模块化编译

需要结合 `javac` 讲解：

- `javac` 的主要编译阶段
- AST 的基本结构
- 符号解析过程
- 方法重载解析
- 类型推断
- Lambda 的编译方式
- 内部类的编译方式
- `enum` 的解糖
- `record` 的编译结果
- `try-with-resources` 的解糖
- `switch` 的不同编译方式
- 字符串拼接的编译方式
- 桥接方法
- 合成方法
- 注解处理器

设计实验：

- 编译并观察普通类
- 观察内部类生成的 Class 文件
- 观察 Lambda 和匿名类的区别
- 观察泛型擦除后的字节码
- 观察桥接方法
- 观察 `try-with-resources`
- 观察字符串拼接
- 编写简单注解处理器

------

## 模块 5：Class 文件与字节码

这是重点模块，需要达到能够阅读常见字节码的程度。

包括：

- Class 文件整体结构
- 魔数
- 版本号
- 常量池
- 访问标志
- 类索引
- 父类索引
- 接口表
- 字段表
- 方法表
- 属性表
- Code 属性
- LineNumberTable
- LocalVariableTable
- StackMapTable
- BootstrapMethods
- Exceptions
- Signature
- RuntimeVisibleAnnotations

深入讲解：

- JVM 是基于栈的虚拟机
- 操作数栈
- 局部变量表
- 栈帧
- 常量池引用
- 符号引用
- 直接引用
- 字节码验证
- 最大栈深度
- 局部变量槽位
- `long` 和 `double` 的槽位
- 方法返回值
- 异常表
- 分支跳转

重点字节码指令：

- 常量加载
- 局部变量加载和存储
- 算术指令
- 类型转换
- 对象创建
- 字段访问
- 数组操作
- 方法调用
- 类型检查
- 分支
- switch
- return
- 异常抛出
- monitor

每个知识点需要配套：

```bash
javac Example.java
javap -c -v -p Example
```

并逐段解释字节码，而不是只展示输出。

------

## 模块 6：JVM 启动与类加载机制

深入讲解：

- JVM 启动过程
- Bootstrap ClassLoader
- Platform ClassLoader
- Application ClassLoader
- 类加载器命名空间
- 双亲委派模型
- 类加载阶段
- 加载
- 验证
- 准备
- 解析
- 初始化
- 使用
- 卸载

重点讲解：

- 类的主动使用与被动使用
- `<clinit>`
- 静态字段初始化
- 静态代码块
- 初始化顺序
- 编译期常量
- 数组类加载
- ClassLoader 隔离
- Thread Context ClassLoader
- SPI
- ServiceLoader
- 自定义类加载器
- 热部署
- 模块化
- 类冲突
- `ClassNotFoundException`
- `NoClassDefFoundError`
- `NoSuchMethodError`
- `LinkageError`

结合场景：

- Tomcat 类加载
- Spring Boot 可执行 JAR
- 插件系统
- Agent Tool 插件加载
- 多版本依赖冲突
- 动态加载用户代码
- Sandbox 中的类隔离

设计一个简单插件系统，使用独立 ClassLoader 加载不同版本的插件。

------

## 模块 7：JVM 运行时数据区

深入讲解：

- 程序计数器
- Java 虚拟机栈
- 本地方法栈
- Java 堆
- 方法区
- 元空间
- 运行时常量池
- 直接内存
- Code Cache

必须明确区分：

- JVM 规范中的运行时数据区
- HotSpot 的具体实现
- Java 堆内存
- Native Memory
- 操作系统虚拟内存
- 进程 RSS
- 容器内存统计

重点讲解：

- 栈帧
- 局部变量表
- 操作数栈
- 动态链接
- 方法返回地址
- 栈溢出
- 堆溢出
- 元空间溢出
- 直接内存溢出
- Code Cache 耗尽
- Native Thread 创建失败

设计实验制造：

- `StackOverflowError`
- Java Heap OOM
- Metaspace OOM
- Direct Buffer Memory OOM
- Unable to create native thread
- GC overhead limit exceeded

并说明如何分析和修复。

------

## 模块 8：Java 对象模型与内存布局

这是重点模块。

包括：

- 对象创建过程
- 类加载检查
- 内存分配
- 零值初始化
- 对象头设置
- 构造方法执行
- 对象头
- Mark Word
- Klass Pointer
- 数组长度
- 实例数据
- 对齐填充
- 字段重排
- 对象对齐
- 压缩对象指针
- 压缩类指针
- 引用类型
- 强引用
- 软引用
- 弱引用
- 虚引用
- ReferenceQueue

需要使用 JOL 等工具观察：

- 普通对象大小
- 包装类型大小
- 数组大小
- 字段排列
- 对齐填充
- 开启和关闭压缩指针的差异
- 对象头随锁状态变化的情况

重点回答：

- `new Object()` 到底占用多少内存？
- 为什么字段顺序会影响对象大小？
- 为什么数组对象额外保存长度？
- Java 引用是不是物理内存地址？
- 对象被移动后引用如何保持正确？
- 压缩指针为什么能够节省内存？
- 大量小对象为什么会给 GC 带来压力？

------

## 模块 9：内存分配、逃逸分析与标量替换

包括：

- TLAB
- Eden
- Survivor
- 老年代
- 大对象分配
- 快速指针碰撞
- 空闲列表
- 对象晋升
- 分配担保
- 逃逸分析
- 标量替换
- 栈上分配的准确理解
- 锁消除
- 锁粗化
- 对象生命周期
- 分配速率

重点纠正常见误区：

- 不能简单地说 Java 对象一定分配在堆上
- 不能把标量替换直接等同于传统意义的栈上分配
- 对象是否实际分配取决于 JIT 优化结果
- 微型测试容易受到 JIT 和逃逸分析干扰

使用：

- JIT 日志
- JMH
- JFR
- async-profiler allocation profiling

观察对象分配和逃逸。

------

## 模块 10：垃圾回收机制

这是核心重点模块。

首先讲解通用 GC 原理：

- 可达性分析
- GC Roots
- 引用计数的局限
- 标记
- 清除
- 复制
- 整理
- 分代假说
- 弱分代假说
- 跨代引用
- Remembered Set
- Card Table
- 写屏障
- 读屏障
- Stop The World
- 并发与并行 GC
- 吞吐量
- 延迟
- 内存占用之间的权衡

然后分别讲解主要垃圾收集器：

- Serial GC
- Parallel GC
- CMS 的历史意义
- G1 GC
- ZGC
- Shenandoah
- Epsilon GC

对 G1 深入讲解：

- Region
- Humongous Object
- Young GC
- Mixed GC
- Collection Set
- Remembered Set
- SATB
- 并发标记
- 停顿预测
- IHOP
- Evacuation Failure

对 ZGC 深入讲解：

- Colored Pointer 或其后续实现思路
- Load Barrier
- 并发转移
- 低延迟设计
- 分代 ZGC 的基本思想

需要说明不同 JDK 版本的实现差异，避免把历史实现当成当前实现。

GC 调优需要围绕目标展开：

- 延迟优先
- 吞吐优先
- 内存成本优先
- 容器环境
- 大堆
- Agent 长任务
- 大量短命事件对象
- 向量数据和文档块
- 大模型流式输出

必须包含 GC 日志分析实验。

------

## 模块 11：解释器、JIT 和代码执行

这是重点模块。

包括：

- 解释执行
- 模板解释器
- 热点代码
- 方法调用计数器
- 回边计数器
- 分层编译
- C1 编译器
- C2 编译器
- OSR
- Code Cache
- 编译线程
- 去优化
- Uncommon Trap
- Profile Guided Optimization
- 方法内联
- 逃逸分析
- 标量替换
- 公共子表达式消除
- 范围检查消除
- 死代码消除
- 循环优化
- 去虚拟化
- 分支预测信息

重点回答：

- Java 为什么启动阶段可能较慢？
- Java 为什么运行一段时间后会变快？
- 为什么第一次请求往往更慢？
- 什么是预热？
- 为什么微基准测试容易错误？
- 为什么一个方法内联后性能可能大幅提高？
- 为什么代码变化会导致 JIT 去优化？
- JVM 怎么判断一个调用点只有一种实现？
- AOT、JIT 和解释执行是什么关系？
- GraalVM Native Image 的优势和限制是什么？

使用 JMH 编写正确和错误的基准测试案例。

------

## 模块 12：泛型与类型系统

深入讲解：

- 泛型类
- 泛型方法
- 类型参数
- 上界
- 下界
- 通配符
- PECS
- 类型推断
- 泛型不变性
- 数组协变
- 原始类型
- 类型擦除
- 桥接方法
- 泛型方法签名
- 反射获取泛型信息
- 堆污染
- 可变参数与泛型
- 捕获转换

重点回答：

- 为什么 `List<String>` 不是 `List<Object>` 的子类型？
- 为什么数组协变而泛型不协变？
- 类型擦除后 JVM 如何进行类型检查？
- 为什么不能直接 `new T()`？
- 为什么不能创建泛型数组？
- 桥接方法解决了什么问题？
- 泛型信息到底擦除了多少？
- Kotlin reified 泛型和 Java 泛型有什么差异？

使用 `javap` 分析泛型擦除和桥接方法。

------

## 模块 13：异常机制

深入讲解：

- Checked Exception
- Unchecked Exception
- Error
- 异常表
- 栈展开
- `athrow`
- finally 的实现
- suppressed exception
- try-with-resources
- 异常对象创建成本
- 栈轨迹生成成本
- Fast Throw
- 异常控制流的性能问题
- 异常边界设计

结合后端与 Agent 场景：

- 业务异常
- 系统异常
- 第三方 API 异常
- 超时
- 用户取消
- 工具执行失败
- 模型调用失败
- 可重试和不可重试异常
- 异常转换
- 错误码
- 全局异常处理
- 工作流中的部分失败

------

## 模块 14：集合框架底层原理

需要深入分析，而不只是介绍 API。

包括：

- Collection 体系
- List
- Set
- Queue
- Deque
- Map
- Iterator
- Spliterator

重点分析：

### ArrayList

- 底层数组
- 扩容
- 随机访问
- 插入删除成本
- `modCount`
- Fail-Fast
- `subList`
- 内存占用

### LinkedList

- 双向链表
- 节点对象开销
- 缓存局部性
- 为什么实际性能经常不如 ArrayList
- 适用场景的边界

### HashMap

- 数组、链表和红黑树
- 哈希扰动
- 容量为什么通常是 2 的幂
- 索引计算
- 扩容
- 链表树化
- 负载因子
- 哈希冲突
- `equals` 与 `hashCode`
- 可变 Key 的风险
- 非线程安全问题

### ConcurrentHashMap

- JDK 7 与 JDK 8 之后实现差异
- CAS
- bin 锁
- ForwardingNode
- 扩容协助
- TreeBin
- 弱一致性
- `computeIfAbsent`
- 递归更新问题

### 其他集合

- LinkedHashMap
- TreeMap
- PriorityQueue
- ArrayDeque
- CopyOnWriteArrayList
- ConcurrentLinkedQueue
- BlockingQueue
- DelayQueue
- SkipList

每个集合需要分析：

- 数据结构
- 时间复杂度
- 空间复杂度
- 缓存局部性
- 并发语义
- 适用场景
- 常见误用
- 源码关键路径

------

## 模块 15：Java 内存模型

这是并发学习的核心模块，必须深入。

包括：

- 主内存与工作内存抽象
- 原子性
- 可见性
- 有序性
- Happens-Before
- 程序次序规则
- Monitor 锁规则
- volatile 规则
- 线程启动规则
- 线程终止规则
- 传递性
- final 字段语义
- 数据竞争
- 顺序一致性
- 编译器重排序
- CPU 重排序
- 内存屏障
- Store Buffer
- Cache Coherence 的基本概念

重点讲解：

### volatile

- 可见性
- 有序性
- 不保证复合操作原子性
- volatile 读写语义
- 双重检查锁
- 发布与逃逸
- 字节码表现
- JIT 与 CPU 层面的屏障

### final

- final 字段安全发布
- 构造期间 `this` 逃逸
- 不可变对象设计

必须通过错误并发程序和 JCStress 等方式验证。

------

## 模块 16：线程、锁和并发工具

包括：

- Java Thread
- 平台线程
- 虚拟线程
- 线程状态
- 线程启动
- 线程中断
- `park/unpark`
- 线程调度
- 上下文切换
- CPU 密集和 I/O 密集任务
- ThreadLocal
- InheritableThreadLocal
- 线程池

### synchronized

深入讲解：

- Monitor
- 对象头
- Mark Word
- monitorenter
- monitorexit
- 重入
- 锁竞争
- wait set
- entry set
- wait
- notify
- notifyAll
- 锁消除
- 锁粗化

注意根据当前 JDK 版本说明历史上的偏向锁等机制，不能把已经改变或移除的实现当成当前事实。

### AQS

深入讲解：

- state
- CAS
- CLH 队列思想
- 独占模式
- 共享模式
- acquire
- release
- park
- unpark
- 公平锁
- 非公平锁
- ConditionObject

基于 AQS 分析：

- ReentrantLock
- ReentrantReadWriteLock
- Semaphore
- CountDownLatch

### 原子类

- CAS
- ABA
- AtomicInteger
- AtomicReference
- LongAdder
- Striped64
- VarHandle
- Unsafe

### 并发容器

- ConcurrentHashMap
- CopyOnWriteArrayList
- BlockingQueue
- ConcurrentLinkedQueue
- ConcurrentSkipListMap

------

## 模块 17：线程池、ForkJoinPool 与虚拟线程

深入讲解 ThreadPoolExecutor：

- corePoolSize
- maximumPoolSize
- keepAliveTime
- workQueue
- threadFactory
- rejectionHandler
- execute 流程
- Worker
- ctl 状态
- 线程池生命周期
- 任务队列
- 有界队列和无界队列
- 拒绝策略
- 线程池隔离
- 动态调整
- 优雅关闭

必须解释：

- 为什么 Executors 的某些工厂方法可能存在风险？
- 无界队列为什么可能导致 OOM？
- 线程数应该如何估算？
- 为什么多个业务共用一个线程池会互相影响？
- ThreadLocal 在线程池中为什么容易泄漏？
- CompletableFuture 默认线程池有什么风险？

深入讲解：

- ForkJoinPool
- Work Stealing
- RecursiveTask
- CompletableFuture
- 异步编排
- 异常传播
- 取消语义

### 虚拟线程

结合现代 Java 深入讲解：

- Project Loom
- 平台线程
- 虚拟线程
- Continuation 的基本思想
- 挂载与卸载
- Carrier Thread
- 阻塞 I/O
- Pinning
- synchronized 和 native 调用的影响
- ThreadLocal 成本
- 虚拟线程不等于无限资源
- 并发限制仍然必要
- 虚拟线程与 Reactor 模型的取舍

结合 Agent 场景：

- 大量并行模型请求
- 工具调用
- 工作流节点等待
- 长轮询
- SSE
- 数据库请求
- Sandbox RPC
- 限制外部 API 并发量

------

## 模块 18：反射、注解、动态代理与字节码增强

包括：

- Class 对象
- Method
- Field
- Constructor
- AccessibleObject
- MethodHandle
- VarHandle
- 反射调用成本
- 反射膨胀的历史实现
- 模块化访问限制
- 注解
- 元注解
- 注解保留策略
- 注解处理器
- JDK 动态代理
- InvocationHandler
- CGLIB
- Byte Buddy
- ASM
- Java Agent
- Instrumentation
- 类重定义
- 类重转换

重点回答：

- Spring 为什么大量使用反射？
- JDK 动态代理为什么通常要求接口？
- CGLIB 为什么能够代理类？
- final 方法为什么难以代理？
- AOP 是如何插入逻辑的？
- Java Agent 如何修改字节码？
- Arthas 和 APM 工具如何增强类？
- MethodHandle 和传统反射有什么区别？

设计实验：

- 编写 JDK 动态代理
- 编写 Byte Buddy 代理
- 编写简单 Java Agent
- 在方法进入和退出时打印耗时
- 分析代理类字节码

------

## 模块 19：模块系统、SPI 与插件架构

包括：

- JPMS
- module-info.java
- exports
- requires
- opens
- reflection access
- unnamed module
- automatic module
- ServiceLoader
- SPI
- 类加载器隔离
- 插件生命周期
- 依赖隔离
- 版本冲突
- 安全边界

结合 Agent 设计：

- Tool 插件
- Model Provider 插件
- Memory Provider 插件
- Retriever 插件
- Sandbox Provider 插件
- 独立 ClassLoader
- 插件权限
- 插件卸载
- 插件版本兼容性

------

## 模块 20：Java I/O、NIO 与网络编程

包括：

- InputStream
- OutputStream
- Reader
- Writer
- 字节流和字符流
- Buffer
- Channel
- Selector
- SocketChannel
- ServerSocketChannel
- FileChannel
- ByteBuffer
- DirectByteBuffer
- HeapByteBuffer
- MappedByteBuffer
- Scatter/Gather
- 零拷贝
- sendfile
- mmap
- epoll
- Reactor 模型

重点讲解：

- Java NIO 如何映射到底层操作系统
- Selector 与 epoll 的关系
- Netty 为什么需要 EventLoop
- 堆外内存的优缺点
- DirectByteBuffer 如何释放
- 大文件为什么应该流式处理
- 半包和粘包
- 背压
- 慢客户端
- 连接数与文件描述符

结合 Agent：

- 模型流式响应
- SSE
- WebSocket
- 工具日志流
- 文件上传
- 大文档解析
- Sandbox 输出流
- 流式事件协议

------

## 模块 21：HTTP、Servlet、Spring MVC 与 WebFlux

需要从请求进入服务器开始完整分析。

### HTTP 基础

- TCP 连接
- HTTP/1.1
- HTTP/2
- HTTP/3 基本概念
- Keep-Alive
- 连接池
- Header
- Body
- Chunked
- SSE
- WebSocket
- TLS
- 超时
- 重试
- 幂等性

### Servlet

- Servlet 容器
- Tomcat
- Connector
- Acceptor
- Poller
- Worker Thread
- Filter
- Servlet
- Listener
- Session
- Request
- Response
- 异步 Servlet

### Spring MVC

- DispatcherServlet
- HandlerMapping
- HandlerAdapter
- ArgumentResolver
- HttpMessageConverter
- Interceptor
- ExceptionResolver
- ViewResolver
- 请求参数绑定
- JSON 序列化

### WebFlux

- Reactor
- Mono
- Flux
- Reactive Streams
- Subscription
- Demand
- 背压
- EventLoop
- Netty
- 阻塞调用风险
- Context

需要比较：

- Servlet + 平台线程
- Servlet + 虚拟线程
- WebFlux + Reactor

说明不同模型的适用场景和复杂度，避免简单宣称某一种方案一定性能更好。

------

## 模块 22：Spring IoC 与 Bean 生命周期

这是 Spring 底层重点。

包括：

- IoC
- DI
- BeanDefinition
- BeanFactory
- ApplicationContext
- BeanDefinitionRegistry
- BeanFactoryPostProcessor
- BeanPostProcessor
- FactoryBean
- ObjectFactory
- Environment
- PropertySource
- Resource
- Component Scan
- Configuration Class
- Import
- Conditional

深入讲解 Bean 生命周期：

1. BeanDefinition 加载
2. 实例化
3. 属性填充
4. Aware 回调
5. BeanPostProcessor 前置处理
6. 初始化
7. BeanPostProcessor 后置处理
8. 代理对象生成
9. 使用
10. 销毁

重点讲解：

- 构造器注入
- 字段注入
- Setter 注入
- 循环依赖
- 三级缓存
- Early Reference
- 为什么构造器循环依赖无法通过同样方式解决
- 原型 Bean
- 懒加载
- Bean 作用域
- 配置类代理
- `@Bean` 方法调用

需要避免只背三级缓存，必须从对象生命周期和代理一致性角度解释循环依赖。

------

## 模块 23：Spring AOP 与事务

### AOP

包括：

- Join Point
- Pointcut
- Advice
- Advisor
- Proxy
- JDK Proxy
- CGLIB
- MethodInterceptor
- 代理链
- 自调用失效
- final 方法
- 代理对象与目标对象
- 多层代理

### 事务

包括：

- ACID
- 本地事务
- JDBC 事务
- Spring 事务抽象
- PlatformTransactionManager
- TransactionInterceptor
- 事务传播行为
- 隔离级别
- 回滚规则
- 只读事务
- 事务同步
- ThreadLocal
- 连接绑定

重点问题：

- 为什么 `@Transactional` 自调用会失效？
- 为什么捕获异常可能导致事务不回滚？
- 为什么异步线程中事务上下文不会自动传播？
- 为什么一个事务内调用远程 API 是危险的？
- 为什么长事务会降低系统吞吐？
- 为什么事务注解放在 private 方法上通常无效？
- 虚拟线程是否改变了事务的基本语义？

------

## 模块 24：Spring Boot 自动配置与启动过程

包括：

- SpringApplication
- 启动阶段
- Environment 准备
- ApplicationContext 创建
- 自动配置
- 条件注解
- Starter
- 配置绑定
- 外部化配置
- ApplicationRunner
- CommandLineRunner
- 生命周期事件
- 内嵌 Tomcat
- Fat JAR
- 可执行 JAR
- Spring Boot Loader

需要完成：

- 手写一个简单 Starter
- 手写自动配置类
- 自定义配置属性
- 使用条件注解
- 分析 Spring Boot 启动日志
- 分析启动耗时
- 定位 Bean 初始化缓慢问题

------

## 模块 25：数据库与 JDBC 底层

包括：

- JDBC API
- Driver
- DriverManager
- DataSource
- Connection
- PreparedStatement
- ResultSet
- Batch
- Transaction
- Connection Pool
- SQL 注入
- 参数绑定
- 网络往返
- 游标
- 流式查询

深入连接池：

- 最大连接数
- 最小空闲连接
- 获取连接超时
- 空闲超时
- 最大生命周期
- 连接泄漏
- 连接检测
- 排队时间
- 数据库最大连接数
- Little's Law 的工程意义

结合 HikariCP 分析：

- FastList
- ConcurrentBag
- HouseKeeper
- 连接借用和归还
- 泄漏检测

------

## 模块 26：MySQL、事务与索引

需要从 Java 后端视角深入掌握：

- InnoDB
- 页
- B+ 树
- 聚簇索引
- 二级索引
- 回表
- 覆盖索引
- 联合索引
- 最左前缀
- 索引下推
- 执行计划
- Buffer Pool
- Redo Log
- Undo Log
- Binlog
- MVCC
- Read View
- 行锁
- 间隙锁
- Next-Key Lock
- 死锁
- 隔离级别
- 长事务

必须建立从 Java 请求到数据库执行的完整链路：

```text
Controller
  ↓
Service
  ↓
Spring Transaction
  ↓
Connection Pool
  ↓
JDBC Driver
  ↓
MySQL Protocol
  ↓
SQL Parser
  ↓
Optimizer
  ↓
Storage Engine
  ↓
Buffer Pool / Disk
```

------

## 模块 27：Redis、缓存与一致性

包括：

- Redis 数据结构
- 单线程事件循环
- I/O 多路复用
- 持久化
- RDB
- AOF
- 主从复制
- Sentinel
- Cluster
- 过期删除
- 内存淘汰
- Pipeline
- Lua
- 分布式锁

缓存问题：

- 缓存穿透
- 缓存击穿
- 缓存雪崩
- 热点 Key
- 大 Key
- 双写一致性
- 延迟双删
- Cache Aside
- Write Through
- Write Behind
- 本地缓存
- 多级缓存

重点说明分布式锁不能简单等同于 `SETNX`，需要考虑：

- 过期时间
- 锁续期
- 锁归属
- 原子释放
- 主从切换
- fencing token
- 业务幂等

------

## 模块 28：消息队列与异步系统

包括：

- 消息模型
- Producer
- Consumer
- Topic
- Partition
- Consumer Group
- Offset
- 顺序消息
- 重复消息
- 消息丢失
- 消息堆积
- 死信队列
- 延迟消息
- 事务消息
- 至少一次
- 至多一次
- 精确一次的边界
- 幂等消费
- Outbox Pattern

结合 Agent：

- Agent 任务队列
- 工具调用队列
- 长任务执行
- 工作流事件
- Sandbox 调度
- 异步结果通知
- 任务重试
- 失败补偿

------

## 模块 29：分布式系统基础

包括：

- 网络不可靠
- 超时
- 重试
- 幂等
- 分布式状态
- CAP
- BASE
- 一致性模型
- 线性一致性
- 最终一致性
- 主从复制
- 共识算法基本思想
- 分布式锁
- 分布式事务
- Saga
- TCC
- Outbox
- 服务发现
- 负载均衡
- 限流
- 熔断
- 隔离
- 降级
- 背压

必须强调：

- 超时不等于执行失败
- 重试可能导致重复副作用
- 请求成功返回前服务可能已经完成操作
- Exactly Once 往往需要业务语义支持
- 分布式锁不能替代幂等设计

------

# 四、Java Agent 与 LLM 应用专项

## 模块 30：LLM 应用基础

包括：

- Token
- Context Window
- Prompt
- System Prompt
- Temperature
- Top-p
- Streaming
- Embedding
- Function Calling
- Structured Output
- 模型上下文
- 多轮对话
- 模型幻觉
- Token 成本
- 延迟
- 限流
- 配额

重点从工程角度讲解：

- Java HTTP Client 调用模型 API
- SSE 流式解析
- JSON Schema
- 结构化输出校验
- 请求超时
- 流式超时
- 连接池
- 重试
- 429 处理
- Retry-After
- 取消
- Token 统计
- 成本记录
- 模型路由
- 降级

不要把 LLM 调用简化为一次普通 HTTP 请求。

------

## 模块 31：RAG 系统

包括：

- 文档加载
- 文档解析
- 文本清洗
- Chunk
- Chunk Size
- Chunk Overlap
- Embedding
- Vector Store
- Similarity Search
- Top-K
- Metadata Filter
- Hybrid Search
- BM25
- Rerank
- Query Rewrite
- Context Compression
- Citation
- Evaluation

从底层和工程角度讲解：

- 向量是什么
- 余弦相似度
- 点积
- 欧氏距离
- ANN
- HNSW 基本原理
- 索引构建成本
- 查询成本
- 召回率和延迟权衡
- 文档更新和删除
- 多租户隔离
- 权限过滤
- 数据一致性

Java 实现需要避免：

- 一次性把大文件全部读入内存
- 无界并发生成 Embedding
- 无限制保存模型返回内容
- 查询阶段 N+1
- 忽略文档权限
- 只依赖向量召回

------

## 模块 32：Tool Calling 与 MCP

包括：

- Tool Schema
- 参数校验
- 工具注册
- 工具选择
- 工具执行
- 工具结果
- 错误反馈
- 工具重试
- 工具权限
- 工具超时
- 工具幂等
- 工具审计
- MCP 的基本架构
- Client
- Server
- Resource
- Prompt
- Tool
- Transport

重点安全问题：

- 模型输出不可信
- 工具参数不可信
- Shell 注入
- SQL 注入
- 路径穿越
- SSRF
- 权限提升
- 敏感信息泄露
- Prompt Injection
- Tool Poisoning
- 过度授权

必须使用确定性代码对工具调用进行控制，不能把安全边界交给模型自行判断。

------

## 模块 33：Agent 架构

包括：

- Agent Loop
- Planning
- Acting
- Observation
- Reflection
- ReAct
- Plan-and-Execute
- Router
- Workflow
- Multi-Agent
- Memory
- Tool
- State
- Checkpoint
- Human-in-the-loop

重点从软件工程角度分析：

- Agent 不应只是 `while(true)` 调模型
- Agent 状态应显式建模
- Agent 执行应使用状态机
- 模型决策和确定性流程的边界
- 工作流和自由 Agent 的取舍
- Agent 最大步数
- Token 预算
- 时间预算
- 工具调用预算
- 循环检测
- 重复调用检测
- 终止条件
- 用户取消
- 人工审批

设计状态：

```text
CREATED
  ↓
PLANNING
  ↓
RUNNING
  ↓
WAITING_TOOL
  ↓
WAITING_APPROVAL
  ↓
COMPLETED / FAILED / CANCELLED / TIMED_OUT
```

------

## 模块 34：Agent 并发、超时、取消和重试

这是 Agent 工程的核心重点。

包括：

- Java `Future`
- CompletableFuture
- Structured Concurrency
- 虚拟线程
- Cancellation
- Interrupt
- Deadline
- Timeout Budget
- Retry
- Exponential Backoff
- Jitter
- Retry Budget
- Circuit Breaker
- Bulkhead
- Rate Limiter
- Semaphore

需要区分：

- 请求连接超时
- 模型首 Token 超时
- 模型整体响应超时
- 工具执行超时
- 单步骤超时
- Agent 总超时
- 用户取消

超时需要分层设计：

```text
Agent 总预算
  ├── Planning 预算
  ├── 模型调用预算
  ├── Tool 预算
  ├── RAG 预算
  └── 结果整理预算
```

重点分析 Java 中断语义：

- `Thread.interrupt()`
- 中断标志
- InterruptedException
- 为什么中断不是强制终止
- 哪些阻塞操作响应中断
- 如何正确传播中断
- 为什么吞掉 InterruptedException 是错误的
- 外部 HTTP 请求和子进程如何取消

------

## 模块 35：Agent 幂等性和状态一致性

包括：

- Task ID
- Run ID
- Step ID
- Tool Call ID
- Idempotency Key
- 状态版本
- 乐观锁
- 去重表
- 唯一约束
- 事件日志
- Checkpoint
- Resume
- Replay
- Outbox

重点场景：

- 模型重复发起工具调用
- 消息队列重复投递
- HTTP 请求超时后客户端重试
- Worker 执行完但确认消息丢失
- 创建 PR 成功但任务状态更新失败
- 邮件发送成功但 Agent 认为失败
- Agent 崩溃后恢复执行
- 多个 Worker 同时领取同一任务

必须明确：

```text
模型调用可以重试
不代表模型触发的副作用可以直接重试
```

------

## 模块 36：Agent Memory

包括：

- Conversation Memory
- Working Memory
- Long-Term Memory
- Semantic Memory
- Episodic Memory
- User Profile
- Checkpoint
- Summary
- Vector Memory
- Structured Memory

重点分析：

- 哪些信息应该保存
- 哪些信息不应该保存
- Memory 生命周期
- Token 限制
- 摘要失真
- 记忆冲突
- 隐私
- 多租户隔离
- 数据过期
- 用户删除
- 权限控制
- Memory 检索
- Memory 注入 Prompt 的风险

------

## 模块 37：Agent Sandbox 与代码执行

结合 Java 重点讲解：

- `ProcessBuilder`
- Process
- stdin
- stdout
- stderr
- 管道
- 子进程
- 进程树
- ProcessHandle
- 超时
- 取消
- 输出限制
- 工作目录
- 环境变量
- 临时文件
- 文件权限
- 容器
- cgroup
- Namespace
- seccomp
- 网络隔离

重点问题：

- 为什么只销毁父进程可能留下子进程？
- 为什么 stdout 和 stderr 不及时读取可能导致死锁？
- 为什么不能无界保存进程输出？
- 为什么超时不等于资源已经回收？
- 如何终止整个进程树？
- 如何避免命令注入？
- 为什么不能直接执行模型输出的 Shell？
- 为什么 Docker 默认配置不等于安全 Sandbox？
- 如何限制 CPU、内存、进程数、磁盘和网络？
- 如何防止访问云元数据服务和内网？

设计 Java Agent Code Runner。

------

## 模块 38：Agent 流式事件系统

包括：

- SSE
- WebSocket
- HTTP Chunked
- Event
- Sequence
- Replay
- Resume
- Heartbeat
- Backpressure
- Buffer
- Slow Consumer
- Disconnect
- Cancellation

事件类型示例：

```text
agent_started
planning_started
message_delta
tool_requested
tool_started
tool_output
tool_completed
approval_requested
artifact_created
agent_completed
agent_failed
agent_cancelled
```

重点设计：

- 事件序号
- 事件持久化
- 客户端断线重连
- 重复事件处理
- 慢客户端
- 最大缓冲区
- 敏感信息过滤
- Tool 输出截断
- Token 流与结构化事件的关系

------

## 模块 39：Java Agent 框架分析

可以选择当前主流 Java AI 框架作为案例，但不能只讲 API。

分析方向包括：

- Spring AI
- LangChain4j
- 其他成熟 Java AI SDK

对每个框架分析：

- 抽象模型
- ChatModel
- EmbeddingModel
- Tool Calling
- Advisor 或拦截器
- Memory
- RAG
- Vector Store
- Streaming
- Retry
- Observability
- Auto Configuration
- Spring 集成
- 扩展点
- 框架限制

必须区分：

- Java Agent 开发的通用原理
- 某个框架的特定 API
- 框架帮助解决的问题
- 框架无法替代的系统设计

版本可能变化的 API 需要注明版本背景，并以官方文档或源码为准。

------

# 五、性能分析与故障排查

## 模块 40：JVM 可观测性

系统讲解：

- JVM 参数
- GC 日志
- Heap Dump
- Thread Dump
- Native Memory Tracking
- JFR
- JMC
- async-profiler
- Arthas
- JMH
- JCStress

工具包括：

```text
jps
jcmd
jstack
jmap
jstat
javap
jinfo
```

每个工具需要说明：

1. 用来解决什么问题。
2. 常用命令。
3. 输出中重点关注哪些字段。
4. 常见误区。
5. 一个实际案例。

------

## 模块 41：CPU 问题排查

包括：

- CPU 使用率
- 系统 CPU
- 用户 CPU
- 上下文切换
- 热点方法
- 无限循环
- 自旋
- 锁竞争
- 频繁 GC
- JSON 序列化
- 正则表达式
- 加密压缩
- 大量日志
- 大量对象分配

排查流程：

```text
top 定位进程
  ↓
top -H 定位线程
  ↓
线程 ID 转十六进制
  ↓
jstack 定位 Java 栈
  ↓
async-profiler / JFR 验证热点
  ↓
修复并基准测试
```

------

## 模块 42：内存问题排查

包括：

- Java Heap
- Metaspace
- Direct Memory
- Thread Stack
- Code Cache
- JNI Memory
- mmap
- RSS
- 容器内存
- 内存泄漏
- 内存抖动
- 分配速率
- 大对象
- 缓存
- ThreadLocal
- ClassLoader 泄漏
- DirectByteBuffer 泄漏

必须区分：

- Java Heap 使用量高
- JVM 已提交内存高
- 进程 RSS 高
- 容器内存高
- GC 后堆不下降
- GC 后 RSS 不下降

------

## 模块 43：线程与锁问题排查

包括：

- Deadlock
- Blocked
- Waiting
- Timed Waiting
- Park
- Monitor
- AQS
- Thread Pool Exhaustion
- Connection Pool Exhaustion
- ThreadLocal 泄漏
- 虚拟线程 Pinning
- CompletableFuture 阻塞

通过 Thread Dump 分析：

- 死锁
- 锁竞争
- 线程池耗尽
- 数据库连接等待
- HTTP 连接等待
- Agent Tool 等待
- 所有线程等待同一个下游服务

------

## 模块 44：GC 问题排查

包括：

- Young GC 频繁
- Mixed GC 频繁
- Full GC
- Promotion Failure
- Evacuation Failure
- Humongous Object
- Allocation Stall
- Concurrent Mode Failure 的历史背景
- GC CPU 高
- GC 停顿长
- 内存晋升过快

必须从：

```text
现象
  ↓
指标
  ↓
GC 日志
  ↓
对象分配
  ↓
Heap Dump
  ↓
代码路径
```

进行分析，不能一上来就随意调整 JVM 参数。

------

# 六、源码阅读要求

文档需要引导阅读部分 JDK 和框架源码，但避免无目标地逐行阅读。

优先阅读：

## JDK

- String
- ArrayList
- HashMap
- ConcurrentHashMap
- Thread
- ThreadLocal
- ThreadPoolExecutor
- ForkJoinPool
- CompletableFuture
- AbstractQueuedSynchronizer
- ReentrantLock
- Semaphore
- CountDownLatch
- FutureTask
- Reference
- ClassLoader
- Proxy
- MethodHandle
- ServiceLoader
- ProcessImpl

## Spring

- SpringApplication
- DefaultListableBeanFactory
- AbstractApplicationContext
- AbstractAutowireCapableBeanFactory
- BeanPostProcessor
- ConfigurationClassPostProcessor
- AnnotationAwareAspectJAutoProxyCreator
- JdkDynamicAopProxy
- CglibAopProxy
- TransactionInterceptor
- DispatcherServlet
- RequestMappingHandlerMapping
- RequestMappingHandlerAdapter

## 源码阅读模板

每次阅读源码都需要回答：

1. 这个类解决什么问题？
2. 对外暴露什么抽象？
3. 核心数据结构是什么？
4. 主执行流程是什么？
5. 并发控制在哪里？
6. 扩展点在哪里？
7. 错误处理在哪里？
8. 性能风险在哪里？
9. 与其他模块如何协作？
10. 可以设计什么实验验证？

------

# 七、文档结构要求

每一章统一使用以下结构：

1. 本章目标
2. 前置知识
3. 核心概念
4. 设计动机
5. 语言规范视角
6. 编译器视角
7. 字节码视角
8. JVM 或运行时视角
9. 操作系统视角
10. 关键数据结构
11. 执行流程
12. ASCII 图解
13. Java 示例
14. 字节码分析
15. 源码关键路径
16. 后端应用
17. Agent 应用
18. 性能影响
19. 常见错误
20. 排障方法
21. 实验任务
22. 面试题
23. 本章检查清单
24. 延伸阅读

并非所有章节都必须机械包含所有小节，但底层主题必须尽可能覆盖不同视角。

------

# 八、代码要求

示例代码需要：

- 使用现代 Java
- 明确标注最低适用 JDK 版本
- 尽量可以独立运行
- 包含错误处理
- 包含资源关闭
- 包含并发取消
- 包含超时
- 包含测试
- 避免纯玩具示例
- 错误示例与正确示例成对出现
- 必要时提供 JUnit 测试
- 性能测试使用 JMH
- 并发正确性测试可以使用 JCStress

示例不得无条件使用 Lombok 隐藏核心实现。

核心章节优先使用原生 JDK 展示底层原理，再使用框架展示工程封装。

------

# 九、实验要求

需要设计以下实验。

## 编译与字节码实验

1. 查看普通方法字节码。
2. 查看重载和重写调用指令。
3. 查看 Lambda 和匿名类。
4. 查看泛型擦除。
5. 查看桥接方法。
6. 查看字符串拼接。
7. 查看异常表。
8. 查看 synchronized 字节码。
9. 查看 switch 编译结果。
10. 编写注解处理器。

## JVM 实验

1. 制造 StackOverflowError。
2. 制造 Heap OOM。
3. 制造 Metaspace OOM。
4. 制造 Direct Memory OOM。
5. 制造 Native Thread 创建失败。
6. 分析对象布局。
7. 观察 TLAB。
8. 观察对象晋升。
9. 分析 GC 日志。
10. 观察 JIT 编译和内联。

## 并发实验

1. 构造数据竞争。
2. 构造可见性问题。
3. 构造死锁。
4. 使用 volatile 修复发布问题。
5. 使用锁保护复合操作。
6. 使用 CAS 实现计数器。
7. 比较 AtomicLong 和 LongAdder。
8. 实现简化 AQS 同步器。
9. 构造线程池耗尽。
10. 分析虚拟线程 Pinning。

## Spring 实验

1. 实现简化 IoC 容器。
2. 实现构造器注入。
3. 实现 JDK 动态代理。
4. 实现方法拦截器。
5. 实现简化事务代理。
6. 实现 Spring Boot Starter。
7. 跟踪 Bean 生命周期。
8. 复现事务自调用失效。
9. 分析循环依赖。
10. 分析一次 MVC 请求。

## Agent 实验

1. Java 调用模型 API。
2. 解析 SSE 流。
3. 实现结构化输出校验。
4. 实现 Tool Registry。
5. 实现工具参数验证。
6. 实现 Agent 状态机。
7. 实现超时预算。
8. 实现取消传播。
9. 实现幂等 Tool Call。
10. 实现 RAG Pipeline。
11. 实现事件流。
12. 实现 Agent Code Runner。
13. 限制进程输出。
14. 终止进程树。
15. 实现 Checkpoint 和恢复。

------

# 十、综合项目

设计并实现一个完整的 Java Agent Platform，项目名称可以为：

```text
java-agent-runtime
```

项目不是一次性生成的演示程序，而是用于贯穿整套学习内容的工程项目。

## 核心模块

```text
java-agent-runtime/
├── agent-core
├── agent-state-machine
├── model-client
├── tool-runtime
├── rag-engine
├── memory-service
├── workflow-engine
├── sandbox-client
├── event-stream
├── persistence
├── observability
├── api-server
└── examples
```

## 功能要求

- 模型调用
- 流式响应
- Tool Calling
- Tool Registry
- 参数校验
- Agent 状态机
- 工作流
- 超时
- 取消
- 重试
- 幂等
- Checkpoint
- 恢复执行
- RAG
- Memory
- SSE 事件流
- 用户审批
- Sandbox
- 可观测性
- 多租户基础隔离

## 分阶段实现

### 阶段 1：Java 基础运行时

- 纯 Java 模型客户端
- HTTP 连接管理
- SSE 解析
- JSON 序列化
- 超时和错误处理

### 阶段 2：Tool Runtime

- Tool 接口
- Tool Schema
- Tool Registry
- 参数验证
- 工具执行
- 工具超时
- 工具错误模型

### 阶段 3：Agent Loop

- Agent State
- Agent Step
- Model Decision
- Tool Observation
- 最大步数
- Token 预算
- 终止条件

### 阶段 4：状态机

- 显式状态转换
- 非法状态拒绝
- 状态持久化
- 乐观锁
- 事件记录

### 阶段 5：并发与取消

- Structured Concurrency 或等价设计
- 虚拟线程
- 用户取消
- Deadline
- 子任务取消
- 并发工具调用
- Semaphore 限流

### 阶段 6：RAG

- 文档解析
- Chunk
- Embedding
- Vector Store
- 混合检索
- Rerank
- 引用

### 阶段 7：事件流

- SSE
- 事件序号
- 心跳
- 重连
- 事件重放
- 慢客户端背压

### 阶段 8：持久化与恢复

- Task
- Run
- Step
- Tool Call
- Checkpoint
- Outbox
- 崩溃恢复
- 幂等

### 阶段 9：Sandbox

- ProcessBuilder
- 工作目录
- stdout 和 stderr
- 输出限制
- 超时
- 进程树终止
- 容器 Sandbox 接口

### 阶段 10：可观测性

- Metrics
- Trace
- Log
- Model Token
- Model Cost
- Tool Latency
- Agent Step
- GC
- Thread
- Connection Pool
- Queue

每个阶段都需要包含：

1. 目标
2. 架构
3. 核心接口
4. 数据模型
5. 执行流程
6. 关键代码
7. 并发模型
8. 错误处理
9. 测试方案
10. 性能测试
11. 故障注入
12. 验收标准

------

# 十一、学习路线

请生成一个 24 周学习计划，每周投入约 10 至 12 小时。

建议分为以下阶段：

## 第一阶段：Java 语言内核

- Java 类型系统
- 面向对象
- String
- 泛型
- 异常
- 集合

## 第二阶段：编译与字节码

- javac
- AST
- 语法糖
- Class 文件
- 字节码
- 方法调用

## 第三阶段：JVM

- 类加载
- 运行时数据区
- 对象模型
- 内存分配
- GC
- JIT

## 第四阶段：并发

- JMM
- volatile
- synchronized
- CAS
- AQS
- 线程池
- 虚拟线程

## 第五阶段：Java 后端

- NIO
- HTTP
- Servlet
- Spring
- 数据库
- Redis
- MQ
- 分布式系统

## 第六阶段：Java Agent

- LLM Client
- Tool Calling
- RAG
- Agent 状态机
- 并发与取消
- 幂等
- Sandbox
- 可观测性

每周需要包含：

- 学习主题
- 核心问题
- 必读章节
- 字节码实验
- JVM 实验
- 源码阅读
- 编码任务
- 排障任务
- Agent 项目任务
- 自测题
- 本周产出物
- 验收标准

------

# 十二、知识深度分级

需要对知识点标注优先级。

## S 级：必须深入掌握

- Java 类型系统
- 对象模型
- Java 编译过程
- Class 文件
- 字节码
- 类加载
- JVM 内存
- 对象分配
- GC
- JIT
- JMM
- synchronized
- volatile
- CAS
- AQS
- 线程池
- 虚拟线程
- HashMap
- ConcurrentHashMap
- 反射
- 动态代理
- Spring IoC
- Spring AOP
- Spring 事务
- HTTP
- 数据库事务
- 超时
- 重试
- 幂等
- Agent 状态机
- Tool Calling
- RAG
- 取消传播
- Sandbox 安全

## A 级：需要熟练掌握

- NIO
- Netty
- Spring MVC
- WebFlux
- MySQL 索引
- Redis
- MQ
- 分布式一致性
- 可观测性
- JVM 排障
- Agent Memory
- 工作流
- 事件流

## B 级：理解原理，按需深入

- JVM 编译器源码细节
- GC 算法数学推导
- CPU 微架构
- 完整编译器实现
- Linux 内核源码
- 数据库内核源码
- 向量数据库底层完整实现

------

# 十三、质量检查

生成每一章后需要检查：

- 是否只讲了 API 而没有解释底层？
- 是否区分了规范和实现？
- 是否包含编译器视角？
- 是否包含字节码视角？
- 是否包含 JVM 视角？
- 是否包含操作系统视角？
- 是否说明设计动机？
- 是否存在版本过时问题？
- 是否提供验证实验？
- 是否提供后端应用？
- 是否提供 Agent 应用？
- 是否说明性能成本？
- 是否说明并发安全性？
- 是否包含故障排查方法？
- 示例代码是否可运行？
- 是否存在未经验证的武断结论？

对于不同 JDK、Spring 或 Agent 框架版本可能变化的内容，必须明确标注版本。

------

# 十四、文件组织

将文档拆分为多个 Markdown 文件，不要生成单个超长文件。

建议目录：

```text
java-deep-learning/
├── README.md
├── 00-learning-map.md
├── 01-java-language-design.md
├── 02-type-system-and-core-syntax.md
├── 03-object-oriented-mechanism.md
├── 04-javac-and-compilation.md
├── 05-class-file-and-bytecode.md
├── 06-class-loading.md
├── 07-jvm-runtime-areas.md
├── 08-object-layout.md
├── 09-memory-allocation.md
├── 10-garbage-collection.md
├── 11-interpreter-and-jit.md
├── 12-generics.md
├── 13-exception-mechanism.md
├── 14-collections.md
├── 15-java-memory-model.md
├── 16-thread-and-lock.md
├── 17-aqs-and-concurrency-tools.md
├── 18-thread-pool-and-virtual-thread.md
├── 19-reflection-proxy-bytecode.md
├── 20-module-spi-plugin.md
├── 21-java-io-nio-network.md
├── 22-http-servlet-web.md
├── 23-spring-ioc.md
├── 24-spring-aop-transaction.md
├── 25-spring-boot.md
├── 26-jdbc-connection-pool.md
├── 27-mysql.md
├── 28-redis.md
├── 29-message-queue.md
├── 30-distributed-system.md
├── 31-llm-application.md
├── 32-rag.md
├── 33-tool-calling-and-mcp.md
├── 34-agent-architecture.md
├── 35-agent-concurrency.md
├── 36-agent-idempotency.md
├── 37-agent-memory.md
├── 38-agent-sandbox.md
├── 39-agent-event-stream.md
├── 40-java-agent-frameworks.md
├── 41-jvm-observability.md
├── 42-cpu-troubleshooting.md
├── 43-memory-troubleshooting.md
├── 44-thread-troubleshooting.md
├── 45-gc-troubleshooting.md
├── 46-source-reading-guide.md
├── 47-interview-questions.md
├── 48-agent-runtime-project.md
├── 49-24-week-plan.md
├── examples/
│   ├── language/
│   ├── compiler/
│   ├── bytecode/
│   ├── jvm/
│   ├── gc/
│   ├── jit/
│   ├── concurrency/
│   ├── nio/
│   ├── spring/
│   ├── database/
│   ├── agent/
│   └── sandbox/
├── benchmarks/
│   ├── jmh/
│   └── jcstress/
├── labs/
└── java-agent-runtime/
```

README 需要包含：

- 学习目标
- 适用人群
- 环境要求
- JDK 版本
- 推荐学习顺序
- S/A/B 优先级
- 实验运行方式
- 项目运行方式
- 源码阅读方式
- 最终能力标准

------

# 十五、执行方式

不要只输出目录或学习建议，请实际创建完整学习仓库。

执行顺序：

1. 分析目标和范围。
2. 确定基准 JDK 版本和兼容版本。
3. 输出完整目录。
4. 标注每章优先级、难度和前置知识。
5. 创建 README 和学习地图。
6. 先完成 Java 语言、编译、字节码和 JVM 基础部分。
7. 再完成并发和后端部分。
8. 最后完成 Agent 专项和综合项目。
9. 每章生成后执行质量检查。
10. 示例代码需要编译和运行验证。
11. JMH、JCStress 和测试代码需要实际执行。
12. 不确定的实现细节需要查看对应版本的官方文档或源码。
13. 不要为了快速完成而生成只有概念罗列的浅层内容。
14. 如果一次上下文无法高质量完成全部内容，则按阶段持续推进，但必须维护进度文件。

创建：

```text
PROGRESS.md
```

记录：

- 已完成章节
- 当前章节
- 待完成章节
- 已验证代码
- 未解决问题
- 版本假设
- 下一步任务
