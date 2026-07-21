# 03｜面向对象机制：对象状态、单分派与 JIT 去虚拟化

> 优先级：S｜难度：★★★★｜基线：Java 21 / HotSpot 21｜前置：[02](02-type-system-and-core-syntax.md)、[05](05-class-file-and-bytecode.md)

## 1. 本章目标

能把封装、继承和多态落到字段布局、构造顺序、编译期重载、运行期重写和五类 invoke；能解释 `this`、`super`、接口 default method 和单分派；能判断何时组合优于继承，并用 JIT profile 说明虚调用成本不是常数。

## 2. 类同时承担三种角色

1. **源码类型**：成员、可见性、继承与重载候选由 JLS 约束。
2. **Class 元数据**：字段/方法表、descriptor、flags、父类与接口由 Class 文件表达。
3. **对象工厂/运行时类型**：HotSpot Klass 描述实例布局、分派、GC 引用字段和反射信息。

对象则是具有运行时类身份和实例状态的实体。变量保存引用值，不内嵌完整对象。`new` 分配/初始化，`<init>` 只负责实例初始化方法；详见 [08](08-object-layout.md)。

## 3. 封装不是 getter/setter 数量

封装的目标是让对象始终满足不变量，并把变化局限在稳定边界：

```java
final class Budget {
    private long remainingMillis;

    synchronized long reserve(long requested) {
        if (requested <= 0 || requested > remainingMillis) {
            throw new IllegalArgumentException("budget exceeded");
        }
        remainingMillis -= requested;
        return requested;
    }
}
```

如果暴露 `setRemainingMillis`，调用者可绕过“不能为负”与并发原子性。字段 private 只是访问控制；可变集合直接返回、构造期间 `this` 逃逸、反射/序列化绕过验证，都会破坏封装。

模块 `exports` 控制普通可访问包，`opens` 控制深反射边界；框架为了注入调用 `setAccessible` 不等于业务对象可以放弃不变量。

## 4. 继承：复用的是契约与状态布局

子类对象包含父类实例状态，只有一个最具体对象 identity。字段不是虚拟的：同名字段是 hiding，字段访问按表达式编译期声明类型绑定；实例方法通常可重写并动态分派。

```java
class Parent { int value = 1; int value() { return value; } }
class Child extends Parent { int value = 2; @Override int value() { return value; } }

Parent p = new Child();
// p.value == 1：getfield Parent.value
// p.value() == 2：invokevirtual，接收者 Child 重写
```

把字段 hiding 当多态会制造两个状态来源。公共基类应保护 invariant，避免可见可变字段。

### 构造顺序

Java 21 子类构造器必须先链到本类另一构造器或父构造器（显式/隐式）；父构造完成后执行子类实例初始化器/字段初始化与构造主体，具体源码结构由 javac 合入 `<init>`。

危险：父构造器调用可重写方法。动态分派会进入子类 override，但子类字段尚未完成初始化，观察到零值或破坏不变量。构造器只调用 private/final 或明确安全的方法；复杂注册在工厂完成构造后执行。

JDK 25 的 flexible constructor bodies 改变了“super 前可写哪些语句”的语言能力，不能倒推 Java 21；父类实例初始化仍必须遵守对象构造安全规则。

## 5. `this`、static 与调用 descriptor

实例方法有隐式接收者。Class descriptor 不把 `this` 写入参数列表，但执行 frame 的 slot 0 通常保存它：

```text
int Parent.virtualCall(int)
descriptor: (I)I
frame: slot0=this, slot1=value
```

static 方法没有接收者，不能直接访问实例字段，使用 `invokestatic`。static 方法可以被子类同名 hiding，但不参与实例重写；通过实例调用 static 虽能编译（不推荐），仍按编译期类型选择。

`super.m()` 不是“把 this 变成父对象”；接收者仍是同一个子类对象，只是方法选择用 `invokespecial` 绕过普通虚分派，从指定父实现开始。

## 6. 重载与重写是两个阶段

### 重载：编译期

根据方法名、候选、声明参数类型、装箱/varargs、泛型推断选唯一 descriptor。运行时实参对象类型不会重新做 overload resolution。

```java
void handle(Object x) {}
void handle(String x) {}
Object value = "text";
handle(value); // 编译为 handle(Object)，不是 String overload
```

### 重写：运行期

对已选定的 name+descriptor，`invokevirtual/invokeinterface` 根据接收者实际类选择最具体 override。返回类型可协变；参数类型变化是 overload，不是 override。泛型擦除导致 descriptor 不一致时 javac 生成 bridge 维持 override。

这就是 **single dispatch**：动态选择只基于接收者，不基于所有参数的运行时类型。Visitor/模式匹配可模拟双分派，但增加闭包层次与演进成本。

## 7. 五种 invoke 的 OOP 含义

配套 [InvocationLab.java](examples/bytecode/InvocationLab.java)：

| 源码意图 | 字节码 | 关键语义 |
|---|---|---|
| static helper | `invokestatic` | 无 receiver |
| constructor/super | `invokespecial` | 特殊静态选择 |
| class virtual | `invokevirtual` | 接收者类分派 |
| interface method | `invokeinterface` | 接口解析 + 接收者分派 |
| lambda factory | `invokedynamic` | bootstrap 链接 call site |

实测 `Child.virtualCall` 内 `super.virtualCall` 使用 `invokespecial`；`callVirtual(Parent, int)` 用 `invokevirtual Parent.virtualCall:(I)I`，即便实参是 Child；`callInterface` 用 `invokeinterface Operation.apply:(I)I`。

`invokedynamic` 不是 OOP 的“第五种继承”，而是可编程调用点链接机制，lambda、拼接和动态语言都可利用。

## 8. 虚方法表只是实现直觉

HotSpot 可为类构造 vtable、为接口调用维护 itable/缓存；但 JVMS 只要求调用语义，不规定表布局。解释器可解析，JIT 可使用 inline cache：

```text
call site profile
  monomorphic: 100% Child   → guard class == Child; inline Child body
  bimorphic: Child/A        → two guards + inline bodies
  megamorphic: many types   → generic dispatch，内联困难
```

类层次分析（CHA）和 profile 可证明当前只有一个实现，C2 去虚拟化并内联。动态加载新子类或 profile 变化会使 dependency 失效，触发 deoptimization。`final` class/method、private/static 调用更易静态确定，但不应为了“性能”到处 final；先用 JMH/JIT log 证明瓶颈。

内联的价值不只省调用：它暴露常量、对象逃逸、分支与范围检查，允许后续标量替换和死代码消除，所以小方法虚调用在热路径可能完全消失。

## 9. 抽象类、接口与 default method

抽象类可持实例状态、构造协议、protected 模板；接口允许多实现类型与能力组合。Java 8 default method 支持接口演进，但解析需处理冲突：

1. 类/父类具体方法优先于接口 default；
2. 更具体子接口优先；
3. 无唯一最具体实现时，实现类必须 override，并可用 `A.super.m()` 消歧。

接口 static 方法属于接口本身，不被实现类继承为实例方法。private interface methods 用于 default 实现复用，不成为 public 契约。

Agent 插件 API 适合窄接口：`execute(Context, Input)` + capability metadata；不要让接口 default 方法悄悄执行网络副作用，否则旧 provider 升级后行为可能改变。

## 10. 内部类、匿名类、Lambda 与方法引用

- non-static inner class 持 enclosing instance，构造器有合成参数，可能无意保留外部大对象。
- static nested class 没有隐式外部引用，适合 builder/helper。
- anonymous class 生成独立类，有自己的 `this`，可声明字段/初始化器。
- lambda 的 `this` 指向词法外部实例，通常 `invokedynamic` 链接，不等于匿名类 identity。
- method reference 是 lambda 语法形态，bound reference 会捕获 receiver，unbound 接收者成为函数参数。

异步任务捕获 controller/request/context 可能延长其生命周期。捕获最小 immutable value，而不是整个外部对象或 tenant session。

## 11. 组合优于继承的可操作标准

继承适合：稳定 is-a、父类明确为继承设计、Liskov substitution 可测试、状态/生命周期一致。组合适合：

- 策略需运行时替换（模型路由、retry、auth）；
- 多维功能组合（metrics + timeout + audit）；
- 子组件生命周期/资源独立；
- 需要隔离第三方实现或副作用；
- 基类 change surface 大、protected 状态易破坏。

```text
AgentRuntime
 ├─ ModelClient
 ├─ ToolRegistry
 ├─ StateStore
 ├─ RetryPolicy
 └─ EventSink
```

这比 `OpenAiRagAuditedRetryingAgent extends ...` 的继承组合更可测试。组合也不是免费：需要明确 owner、顺序、错误传播和生命周期，避免“服务定位器”隐藏依赖。

## 12. SOLID 的边界

- SRP 是“一个变化原因”，不是每类一个方法；过度拆分会隐藏事务与不变量。
- OCP 通过稳定 extension point 降低修改，但所有协议仍需版本演进；不是永不改核心。
- LSP 要求前置条件不加强、后置/不变量保持、异常/时序语义兼容；“能强转”不等于可替换。
- ISP 避免胖接口，仍要把原子操作组成一致事务边界。
- DIP 让策略依赖抽象；若抽象泄漏具体框架类型，只是换了 import。

在高风险 Agent Tool 上，明确 effect/security contract 比画 SOLID 类图更重要。

## 13. 对象方法契约

`equals/hashCode/toString/clone/finalize` 有不同契约。最常见问题：

- equals 相等必须 hash 相等；参与字段在 HashMap key 生命周期内稳定；
- 继承有新增 value state 时对称性/传递性很难维护，value object 常用 final/record；
- `toString` 不记录 secret/prompt/tool token；日志需 redaction；
- `clone` 是浅复制、绕过构造语义，优先 copy constructor/factory；
- finalization 不用于资源生命周期。

identity (`==`/identity hash) 与 value equality 分开。JDK value-based classes 明确不应依赖 identity/synchronization，未来 Valhalla 演进会进一步强化边界。

## 14. 后端与 Agent 应用

### 代理边界

Spring AOP 的代理对象转发到 target；同对象 `this.internal()` 不经过外部 proxy，事务/审计 advice 失效。private/final 方法不能被普通 subclass override。解决应重构调用边界或用明确编排，不用“再加注解”。

### 状态机

用 sealed state/event + composition 把概率模型决策和确定性 transition 分开。模型返回 proposal，不获得 runtime 对象的任意方法能力；Tool interface 只暴露受校验 command。

### 多态序列化

持久化接口实现必须有显式 type/version allowlist。直接按客户端 class name 反序列化会产生 gadget/security 与重构兼容问题。

## 15. 常见错误与排障

| 现象 | 机制 | 证据/修复 |
|---|---|---|
| 子类字段“没生效” | field hiding，编译期绑定 | `javap` 看 Fieldref owner；移除同名状态 |
| 父构造调用 override 得到零值 | 子字段未初始化即动态分派 | 构造器不调 overridable 方法 |
| 注解事务自调用失效 | `this` 未穿过 proxy | 打印 runtime class/调用链，重构边界 |
| lambda 留住大对象 | 捕获 enclosing `this` | heap root path，改捕获最小值/static nested |
| HashMap 查不到 key | mutable equality/hash state | immutable key，插入后不变 |
| 接口调用热路径慢 | call site megamorphic/未内联 | JFR/JIT log/perfasm，不按 opcode 猜 |

## 16. 实验任务

```powershell
cd deep_java\java-deep-learning
.\labs\compile-and-inspect.ps1
javap -classpath build\classes -c -v -p 'dev.deepjava.bytecode.InvocationLab$Child'
```

1. 标出 `<init>` 的 `aload_0; invokespecial Parent.<init>`。
2. 区分 `super.virtualCall` 的 invokespecial 与外部 invokevirtual。
3. 新增 field hiding 样例，展开两个 Fieldref owner。
4. 写两个 default interface 冲突并显式消歧，检查 invoke 指令。
5. 用 JMH 构造 monomorphic/megamorphic call site，记录 `PrintInlining`；防止 dead-code elimination。

## 17. 源码阅读路径

- `java.lang.Object`：native/VM intrinsic 边界，方法契约而非私有实现。
- `java.lang.Class`：mirror 与类型查询；不要把 mirror 当 Klass。
- HotSpot `klass/vtable` 相关源码：固定 tag，只追 link 与 lookup 主路径。
- C2 dependencies/inlining 日志：先由具体 call site 问题导航，不逐文件阅读。

## 18. 面试题与检查清单

**Q：重载和重写何时决定？** 重载在 javac 选择 name+descriptor；重写在运行时按 receiver 做单分派。

**Q：`this` 是什么？** 实例方法隐式 receiver 的引用值，frame slot 0 常保存；不是对象副本。

**Q：虚调用一定慢吗？** 不；JIT 可基于 CHA/profile guard + inline，类型多态度与假设失效决定成本。

- [ ] 能区分字段 hiding、static hiding、instance overriding。
- [ ] 能从 invoke 指令解释 this/super/interface/lambda。
- [ ] 能说明父构造调用 override 风险。
- [ ] 能给出组合/继承的可测试选择标准。
- [ ] 能把代理自调用和单分派联系起来。

## 19. 延伸阅读

- [JLS 8：Classes](https://docs.oracle.com/javase/specs/jls/se21/html/jls-8.html)
- [JLS 9：Interfaces](https://docs.oracle.com/javase/specs/jls/se21/html/jls-9.html)
- [JLS 15.12：Method Invocation](https://docs.oracle.com/javase/specs/jls/se21/html/jls-15.html#jls-15.12)
- [JVMS 6：invoke 指令](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-6.html)

下一主线：[04-javac-and-compilation.md](04-javac-and-compilation.md)
