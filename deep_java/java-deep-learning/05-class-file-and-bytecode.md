# 05｜Class 文件与字节码：读懂常量池、栈帧和控制流证明

> 优先级：S｜难度：★★★★★｜基线：JVMS 21、class major 65｜前置：[04](04-javac-and-compilation.md)

## 1. 本章目标

能够从 `javap -c -v -p` 输出定位 Class 结构、常量池引用、方法 descriptor、Code 属性、局部变量槽、操作数栈、异常表、StackMapTable 与 BootstrapMethods；能手算一个小方法的栈变化，解释五类调用指令和字节码验证为何需要类型状态。

## 2. Class 文件是带索引的二进制图

Class 不是“机器码文件”，而是 big-endian、索引密集的结构：

```text
ClassFile {
  u4 magic;                         // CA FE BA BE
  u2 minor_version;
  u2 major_version;                 // Java 21 = 65
  u2 constant_pool_count;
  cp_info constant_pool[count-1];
  u2 access_flags;
  u2 this_class, super_class;
  u2 interfaces_count; u2 interfaces[];
  u2 fields_count;     field_info fields[];
  u2 methods_count;    method_info methods[];
  u2 attributes_count; attribute_info attributes[];
}
```

大量字段不是直接保存字符串/对象，而是指向常量池。`this_class` 指向 `CONSTANT_Class`，它再指向 `CONSTANT_Utf8` 名称。读取时先画索引边，不要把 `#7` 当固定指令编号；重新编译后常量池排序可变。

## 3. 常量池：字面量、符号引用与 bootstrap 参数

常见条目：

- `Utf8`：名称、descriptor、属性名等的 Modified UTF-8 编码；不是普通业务 UTF-8 字符串池。
- `Integer/Float/Long/Double/String`：常量值或字符串条目引用。
- `Class`、`NameAndType`、`Fieldref`、`Methodref`、`InterfaceMethodref`：符号引用图。
- `MethodHandle`、`MethodType`、`InvokeDynamic`、`Dynamic`：动态链接与常量动态计算。
- `Module/Package`：JPMS 元数据。

`long/double` 在常量池历史格式中占两个索引位置；解析器必须跳过后一个不可用项。符号引用（类名、成员名、descriptor）在解析/首次使用时转换为实现可直接定位的内部结构；“直接引用”是 JVM 实现概念，不要求 Class 文件回写机器地址。

## 4. descriptor 与 Signature 不能混淆

descriptor 是 JVM 链接所需的擦除后类型：

```text
I                         int
J                         long
Ljava/lang/String;        String reference
[I                        int[]
(Ljava/lang/String;I)J    (String, int) -> long
```

`Signature` 是可选属性，可记录泛型声明，例如 `Ljava/util/List<Ljava/lang/String;>;`。JVM 方法解析使用 name + descriptor，不以 Signature 区分 `List<String>` 与 `List<Integer>`。删除 Signature 可能损害反射/编译工具信息，却不改变大多数执行描述符。

## 5. Code 属性：每个方法的小型执行世界

```text
Code {
  max_stack
  max_locals
  code_length + code[]
  exception_table[]
  attributes[]  // LineNumberTable, LocalVariableTable, StackMapTable...
}
```

### 局部变量表

实例方法 slot 0 通常保存 `this`，其后是参数和局部变量；静态方法没有隐式 `this`。`long/double` 占连续两个 slot，后一个 slot 不能独立加载。slot 可在不同 bytecode 区间复用，所以 LocalVariableTable 必须用 start/length 描述变量名的生存区间。

### 操作数栈

指令从栈顶取操作数并压回结果。它是抽象栈，不等于硬件 stack 或线程栈内存布局。`max_stack` 按 slot 深度计，是验证/帧分配信息，不是 `-Xss` 大小。

以实测的 `callVirtual(Parent,int):int` 为例：

```text
offset  instruction                         stack after
0       aload_0                             [target]
1       iload_1                             [target, value]
2       invokevirtual #7 (I)I              [result]
5       ireturn                             []
```

`stack=2, locals=2` 与手算一致。若某分支汇合处一个路径栈顶为 int、另一路径为 reference，验证器会拒绝，哪怕运行测试“碰巧不走坏路径”。

## 6. 为什么 JVM 选择基于栈的指令集

栈式字节码指令紧凑、临时值无需编码虚拟寄存器编号，适合早期多平台解释器和验证。代价是 load/store 与 stack manipulation 指令较多。HotSpot 执行时不会机械地让所有值一直在内存栈上；解释器用栈模型，JIT 构建 IR/SSA 后做寄存器分配，最终机器码可完全不同。

因此不能从 `iadd` 数量直接推导 CPU 指令数，也不能从字节码没出现内存屏障就断言 `volatile` 无屏障；字段的 `ACC_VOLATILE` 语义会在解释/JIT 后端实现。

## 7. 指令族与类型信息

指令前缀常表示类型：`i/l/f/d/a`。主要类别：

| 类别 | 示例 | 栈效果摘要 |
|---|---|---|
| 常量 | `iconst_1`, `bipush`, `ldc` | `[] → [value]` |
| load/store | `iload`, `aload`, `istore` | slot ↔ stack |
| 算术/转换 | `iadd`, `lmul`, `i2d` | 弹出操作数，压结果 |
| 对象 | `new`, `dup`, `checkcast`, `instanceof` | 分配未初始化引用/类型检查 |
| 字段 | `getfield`, `putfield`, `getstatic` | owner + value 与字段交互 |
| 数组 | `newarray`, `aaload`, `iastore`, `arraylength` | 数组引用、索引、元素 |
| 控制 | `ifeq`, `if_icmp*`, `goto`, `tableswitch` | 消费条件并改变 PC |
| 调用 | 五类 `invoke*` | 按 descriptor 消费参数/压返回值 |
| 返回/异常 | `ireturn`, `areturn`, `return`, `athrow` | 正常或 abrupt completion |
| 同步 | `monitorenter`, `monitorexit` | 消费 monitor 对象引用 |

`new` 只分配并压入“未初始化对象”的引用；常见序列 `new; dup; invokespecial <init>` 才完成构造调用。验证器专门跟踪 uninitializedThis/未初始化引用，避免构造前随意使用。

## 8. 五种方法调用不是五种性能等级

| 指令 | 典型用途 | 选择时机 |
|---|---|---|
| `invokestatic` | static 方法 | 解析到固定目标 |
| `invokespecial` | 构造器、`super`、部分 private 调用 | 特殊非虚拟选择规则 |
| `invokevirtual` | 普通类实例虚方法 | 根据接收者类动态分派 |
| `invokeinterface` | 接口实例方法 | 接口方法解析 + 接收者分派 |
| `invokedynamic` | lambda、字符串拼接、动态语言 | bootstrap 首次链接 CallSite |

实测 [InvocationLab.java](examples/bytecode/InvocationLab.java)：

```text
callVirtual:   aload_0; iload_1; invokevirtual #7;  ireturn
callInterface: aload_0; iload_1; invokeinterface #13,2; ireturn
callDynamic:   iload_0; invokedynamic #18; areturn
```

`invokedynamic` 的“动态”是调用点链接协议，不等于每次都做慢反射。Class 文件的 `BootstrapMethods` 把 CP 中的 bootstrap method handle、static arguments 和调用点 name/type 连起来；链接后的 target 可以稳定并被 JIT 内联。

虚调用也不必慢：如果 profile 显示单态，C2 可 guarded inline；新子类加载或 profile 改变时 assumption 失效并去优化。性能必须看 JIT 日志/汇编和负载，不按 opcode 名下结论。

## 9. 分支、switch 与 StackMapTable

分支目标是当前方法 code array 的 bytecode offset。JDK 21 对样例输出：密集 `1..3` 用 `tableswitch`，稀疏 `-100,7,10000` 用 `lookupswitch`。前者按范围直接索引，空洞会占表；后者保存匹配键/offset 对，选择取决于密度和生成器策略。

StackMapTable 在基本块入口给出局部变量与操作数栈类型的压缩帧，支持 split verifier 快速检查。它不是运行期 stack trace，也不是 GC root 精确位置表。修改字节码后若不重新计算 frame/max stack，常见 `VerifyError: Bad type on operand stack`。

## 10. 异常表：异常控制流不靠普通 goto 表达

exception table 条目 `(start_pc, end_pc, handler_pc, catch_type)` 表示半开区间。抛出异常时，JVM 在当前方法表中寻找覆盖当前 PC 且类型匹配的 handler；找到后清空操作数栈，只压入异常对象并跳转，否则弹出帧继续展开。

样例 `guardedIncrement` 的同步块实测为：

```text
3:  monitorenter
...
13: monitorexit
14: ireturn
15: astore_3
16: aload_2
17: monitorexit
18: aload_3
19: athrow
Exception table: 4..14 -> 15 any; 15..18 -> 15 any
```

异常路径也释放 monitor，说明源码级 `synchronized` 块的退出语义由正常/异常两条字节码路径共同实现。同步实例方法则通常用方法的 `ACC_SYNCHRONIZED` 标志，而不是方法体显式 `monitorenter`。

## 11. 字节码验证的四层直觉

规范描述包含格式检查、元数据约束、指令静态约束和代码类型安全验证。验证要证明：

- opcode 和 operand 合法，分支落在合法指令边界；
- CP 条目类型与指令期待一致；
- 局部变量/操作数栈在所有控制流路径类型一致；
- 构造器初始化规则、返回类型、异常 handler 入口正确；
- 不会用 int 当 reference、不会越过方法 code 读任意内存。

验证不能证明业务授权、安全 SQL、终止性、内存有界或没有数据竞争。合法字节码仍可无限循环、创建线程、访问文件；Agent Sandbox 需要 OS/容器和权限控制。

## 12. 关键属性：保留什么，谁消费

| 属性 | 用途 | 是否影响核心执行语义 |
|---|---|---|
| `Code` | 方法指令、栈/局部上限、异常表 | 是 |
| `LineNumberTable` | PC 到源码行 | 主要调试 |
| `LocalVariableTable` | 名字/范围/descriptor | 调试，可省略 |
| `StackMapTable` | 验证类型帧 | 验证关键 |
| `Exceptions` | 声明 throws | 编译/反射元数据；不控制 athrow 能否发生 |
| `Signature` | 泛型签名 | 编译/反射 |
| `RuntimeVisibleAnnotations` | 运行期可见注解 | 框架/反射消费 |
| `BootstrapMethods` | indy/condy bootstrap | 动态链接关键 |
| `Record` | record components | 反射/语义元数据 |
| `NestHost/NestMembers` | nest 私有访问 | 链接访问控制 |
| `Module` | 模块描述 | 模块系统 |

未知属性按 JVMS 规则可被不认识它的工具忽略，因此 Class 格式能演进；修改工具应保留自己不理解但需要透传的属性，否则会破坏调试/框架行为。

## 13. 从符号引用到执行

以 `invokevirtual #7` 为例：

1. `#7` 指向 Methodref；
2. Methodref 指向 Class 与 NameAndType；
3. descriptor 决定弹出接收者和参数的类型/数量；
4. JVM 解析 owner 与方法符号，做访问检查；
5. 执行时按接收者实际类选择 overriding target；
6. 解释器调用或已编译代码通过 inline cache/入口执行；
7. JIT 可能内联，假设失效再去优化。

“解析”可以 eager 或 lazy，只要错误出现时机符合规范允许范围。不要把某次 `-Xlog:class+resolve` 顺序提升为所有 JVM 固定算法。

## 14. 实验：从十六进制到逐指令推演

```powershell
cd deep_java\java-deep-learning
.\labs\compile-and-inspect.ps1
Format-Hex build\classes\dev\deepjava\bytecode\InvocationLab.class | Select-Object -First 4
javap -classpath build\classes -c -v -p dev.deepjava.bytecode.InvocationLab
```

实验报告至少完成：

1. 在 hex 中找到 `CA FE BA BE 00 00 00 41`（minor 0、major 65）。
2. 沿 CP 索引展开 `callVirtual` 的 Methodref。
3. 手算每条指令前后 stack，并验证 `max_stack=2`。
4. 对比 `tableswitch/lookupswitch` 的 padding、键与目标 offset。
5. 画出 monitor 正常/异常 CFG，解释为何必须有第二个 handler 范围。
6. 找到 lambda 的 `InvokeDynamic` 与对应 BootstrapMethods 条目。

可选破坏实验：使用 ASM 删除必要 frame 或改错 descriptor，在隔离进程运行并记录 `VerifyError`。不要用十六进制编辑器随意运行来源不明的 Class。

## 15. 后端、Agent 与排障价值

- Spring AOP/Byte Buddy/Java Agent 生成类失败时，`VerifyError` 通常要检查 frame、owner、descriptor 和类版本。
- `NoSuchMethodError` 要从调用方 Class 的 Methodref 出发，对照运行时实际加载的定义类，而不是只看源码。
- Agent Tool 插件 ABI 可用 descriptor 做硬链接审计，Signature/annotation 做 schema 元数据；两者版本都要记录。
- stack trace 行号缺失通常是构建移除了 LineNumberTable，不是 JVM “看不到源码”。
- 超大方法可能超过 Class 格式的 `code_length < 65536` 约束，代码生成器应拆方法；即使未超限，也会撞 JIT 内联/编译预算。

## 16. 常见错误

1. **把局部变量表当 Java 源变量表**：slot 会复用，名字属性可不存在。
2. **把 `max_stack` 当线程栈大小**：一个是抽象 slot 深度，一个是本地线程栈资源。
3. **看到 `invokedynamic` 就认定慢**：应检查 bootstrap、call site 稳定性和 JIT。
4. **只看 `javap -c`**：会漏 descriptor、flags、CP、StackMapTable 和 bootstrap。
5. **Class 验证等于安全沙箱**：验证处理类型安全，不控制合法副作用。
6. **反汇编输出等于规范**：它证明当前编译器产物；其他生成器可用不同等价形状。

## 17. 面试题与检查清单

**Q：JVM 为什么要操作数栈？** Class 指令紧凑且易跨平台验证；JIT 后可转 IR 与寄存器机器码，不意味着 CPU 也按栈执行。

**Q：`invokevirtual` 和 `invokeinterface` 一定比 `invokestatic` 慢？** 语义上需动态选择，但 JIT 可借 profile 去虚拟化和内联；必须实测编译结果。

**Q：异常表怎样工作？** 按当前 PC 和 catch type 找 handler；进入时栈只含异常对象，未命中则栈展开。

- [ ] 能解释 Class 顶层字段与 CP 索引。
- [ ] 能读 descriptor、Signature、flags 和主要属性。
- [ ] 能手算局部 slot/operand stack。
- [ ] 能解释五类 invoke、switch、异常表和 monitor。
- [ ] 能说明 verifier 能保证与不能保证什么。

## 18. 延伸阅读

- [JVMS 2.6：Frames](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-2.html#jvms-2.6)
- [JVMS 4：Class File Format](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-4.html)
- [JVMS 4.10：Verification](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-4.html#jvms-4.10)
- [JVMS 6：Instruction Set](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-6.html)
- [JVMS 5.4.3：Resolution](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-5.html#jvms-5.4.3)

下一章：[06-class-loading.md](06-class-loading.md)
