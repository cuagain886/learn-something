# 12｜泛型与类型系统：擦除、通配符捕获和桥接方法

> 优先级：S｜难度：★★★★★｜基线：Java 21｜前置：[02](02-type-system-and-core-syntax.md)、[04](04-javac-and-compilation.md)、[05](05-class-file-and-bytecode.md)

## 1. 本章目标

能从 subtype 与赋值安全推导泛型不变性、PECS 和 capture conversion；能解释擦除后 descriptor、`checkcast`、Signature 与 bridge 的协作；能识别 raw type、泛型 varargs 与反射造成的 heap pollution；不把“泛型信息擦除”说成 Class 文件中一个类型参数字符都没有。

## 2. 泛型解决的是静态关系，不是容器自动变安全

```java
final class Box<T> {
    private T value;
    T get() { return value; }
    void set(T value) { this.value = value; }
}
```

`T` 让同一个声明表达 get/set 类型相等，javac 在调用处检查。对象仍可通过并发错误、raw/reflection/unsafe 被污染；泛型本身不提供线程安全、深不可变或运行时 schema 校验。

类型参数可以出现在类、接口、方法和构造器。method type parameter 属于调用本身：`static <T> T first(List<T>)` 不要求 owner 是泛型类。

## 3. 不变性来自“能读也能写”

若 `List<String>` 是 `List<Object>` 子类型：

```java
List<String> strings = new ArrayList<>();
List<Object> objects = strings; // 假设允许
objects.add(42);                // 对 List<Object> 合法
String s = strings.get(0);     // 类型系统被破坏
```

所以普通参数化类型不变：`S <: T` 不能推出 `G<S> <: G<T>`。通配符表达 use-site variance：

- `List<? extends Number>`：可从中读 `Number`，不能安全写具体非-null 值；实际可能是 `List<Integer>`。
- `List<? super Integer>`：可写 Integer，读取只能安全视为 Object；实际可能是 `List<Number/Object>`。

PECS（producer extends, consumer super）是 API 使用口诀，不是类型系统全部。一个既读又写同一精确 T 的结构通常需要类型参数，而不是通配符。

## 4. 通配符捕获

`List<?>` 表示“某个未知但固定的元素类型”，不是 `List<Object>`。编译器可为一次表达式引入 capture variable `CAP#1`：

```java
static void reverse(List<?> values) {
    reverseCaptured(values);
}
private static <T> void reverseCaptured(List<T> values) { ... }
```

helper method 让同一未知类型在 get/set 间保持一致。错误信息中的 `required: CAP#1, found: Object` 表示调用方丢失了该关联，不是编译器随机起名。

下界 `? super Integer` 不意味着编译器知道下界实例的确切类型；它只保证 Integer 可安全写入。Java 类型推断对 lower/upper/equality bounds 求解，详见 JLS 18。

## 5. 数组协变为何危险却保留

数组是 reified：运行时对象知道 component class，因此 Java 为历史兼容允许协变并在写时检查：

```java
String[] strings = new String[1];
Object[] objects = strings;
objects[0] = 42; // 编译通过，运行时 ArrayStoreException
```

泛型选择不变性，把错误前移到编译期。数组可 reified 检查也解释了为什么普通 `new List<String>[10]` 被禁止：运行时数组只能知道 `List[]`，无法检查元素的 String 参数，协变写会制造 heap pollution。

可创建 `List<?>[]`，因为 unbounded wildcard 是 reifiable type，但元素里的具体参数仍未知，API 设计通常优先 `List<List<T>>`。

## 6. 擦除规则

类型变量擦除为最左上界，若无显式上界则 Object：

```java
class Store<T extends Number & Comparable<T>> {
    T value;
    T get() { return value; }
}
```

执行 descriptor 中字段/返回主要擦除为 `Number`；其他 bounds 用于编译检查并可出现在 Signature。调用方需要时插入 `checkcast`。

擦除带来：

- 一个 `ArrayList.class` 服务所有引用类型参数化实例；
- 旧 JVM/旧 raw API 与泛型库迁移兼容；
- 运行时 `new ArrayList<String>().getClass()==new ArrayList<Integer>().getClass()`；
- 不能直接 `new T()`、`T.class`、`instanceof List<String>`；
- primitive type argument 不可用，需要 boxing（Valhalla 演进另论）。

### 为什么不能 `new T()`

擦除后没有唯一运行时 class/构造 descriptor；而且 T 的 bound 不保证 public no-arg constructor。传 `Supplier<T>`、factory、`Class<T>` + 明确构造策略，分别把创建能力做成契约。

`Class<T>` token 能恢复某个 reified class，但 `Class<List<String>>` 没有普通字面量。保留嵌套参数常用 Type/ParameterizedType 或显式 TypeToken；这仍是元数据，不自动校验 JSON 实例。

## 7. 桥接方法维持擦除后的多态

配套：

```java
interface Mapper<T> { T map(T input); }
final class StringMapper implements Mapper<String> {
    public String map(String input) { return input.strip(); }
}
```

擦除接口方法 descriptor 为 `(Object)Object`，具体方法是 `(String)String`。若无 bridge，JVM 会把它们视为不同 descriptor，接口调用找不到 override。javac 生成近似：

```java
// ACC_BRIDGE, ACC_SYNTHETIC
public Object map(Object input) {
    return map((String) input);
}
```

验证：

```powershell
.\labs\compile-and-inspect.ps1
javap -classpath build\classes -c -v -p `
  'dev.deepjava.compiler.DesugaringLab$StringMapper'
```

观察 flags、`checkcast java/lang/String` 和对具体 `map(String)` 的调用。反射扫描方法时过滤 synthetic/bridge 要基于用途：框架若把两个都注册为 handler，会重复；若完全忽略 bridge，可能漏接口契约。

## 8. Class 文件保留了多少泛型信息

| 信息 | 存放 | 运行时可见性 |
|---|---|---|
| 执行参数/返回 | descriptor（擦除） | JVM 链接直接使用 |
| 声明 type parameter/wildcard | Signature 属性 | 反射可解析，属性可缺/畸形 |
| 局部变量泛型 | LocalVariableTypeTable（调试可选） | 非核心执行契约 |
| type-use annotation | Runtime[In]VisibleTypeAnnotations | 取决 retention |
| 实际对象 type argument | 通常不存在独立 reified tag | 不能靠 `getClass()` 得到 |

匿名 subclass 技巧 `new TypeReference<List<String>>() {}` 让参数出现在 superclass Signature，库反射读取；它创建额外类，且中间层变量/动态类型仍可能丢信息。生产 API 更好显式传 `Type`/schema。

## 9. Raw type 与 heap pollution

raw type 是迁移兼容机制，会关闭部分泛型检查并产生 unchecked warning：

```java
List<String> strings = new ArrayList<>();
List raw = strings;
raw.add(42);             // unchecked
String x = strings.get(0); // 此处 checkcast 才 ClassCastException
```

异常发生在远离污染源的 reader，排障困难。构建应把核心模块 unchecked warning 当错误或集中 suppress，并在 suppress 处证明不变量。

heap pollution 还来自：

- generic varargs 数组被写入错误参数化值；
- reflection/MethodHandle/serialization 绕过编译检查；
- 不安全强转、第三方 raw API；
- 错误的泛型数组桥接。

`@SafeVarargs` 是作者承诺方法不会不安全写/泄露 varargs 数组，只允许特定不可重写方法；它不让危险代码变安全。

## 10. 类型推断与 overload 交互

diamond、generic method invocation 和 lambda 都依赖 target typing。推断不是运行时行为：结果体现在选择的 descriptor、插入 cast 和生成方法。

```java
var empty = java.util.List.of(); // standalone/target context 决定推断
```

`var` 只让编译器推断静态局部类型，不变成 dynamic；Class 文件仍有确定 descriptor/字节码。过度依赖复杂推断会让错误出现长 constraint trace，公共 API 应避免 overload + wildcard + varargs 的组合爆炸。

## 11. Kotlin reified 与 Java 的关系

Kotlin/JVM 普通泛型同样受 JVM 擦除。`inline fun <reified T>` 通过在调用点内联，把 T 的具体 class/type 操作展开，从而允许部分 `is T`/`T::class`。它不是 JVM 为所有对象保存 type argument，也不能让非 inline/跨未知边界自动 reified。Java 可用 Class/Type token 表达相同显式能力，代价是调用语法更长。

## 12. API 设计与 Agent 场景

```java
interface Tool<I, O> {
    ToolDescriptor descriptor();
    O execute(ToolContext context, I input) throws ToolException;
}
```

泛型能保证 Java 调用点 I/O 静态关系，但模型输入是 JSON/untrusted bytes，必须用 runtime schema 验证后才能构造 I。由于 registry 往往异构，内部最终会有 existential/erasure 边界；把不安全 cast 收口在已核对 descriptor+Type token 的 adapter，并用测试证明。

事件处理可写 `Handler<? super ToolCompleted>` 表达消费，reader API `List<? extends Event>` 表达生产。不要把所有 API 写 `<?>` 后到处 cast，那只是把类型系统关掉。

序列化 generic state 时持久化 `schemaType/schemaVersion`，不能依赖 Java Signature；重构包名或 type parameter 不应破坏存量数据。

## 13. 性能与内存

擦除通常避免每个 type argument 生成一份 class/code，减少 metaspace；primitive 装箱增加对象、indirection 与 GC。JIT 可消除局部 boxing，但跨集合/接口/逃逸边界未必。

`List<Integer>` 与 `int[]` 的差距来自引用数组 + Integer 对象（缓存/逃逸视情况），不是“泛型语法慢”。需要 primitive 吞吐时用 primitive array、专用库或未来标准特性，并用 JMH/JOL 验证真实数据形状。

bridge 方法通常可被内联，成本很小；反射重复解析 ParameterizedType 和 schema 可缓存，但 cache key 要包含 defining loader，避免插件 loader 泄漏。

## 14. 常见错误与排障

| 现象 | 根因 | 证据 |
|---|---|---|
| 读处突然 ClassCastException | 更早 raw/reflection 污染 | stack 中 `checkcast`，追所有 unchecked warning |
| 反射看不到方法参数类型实参 | 只查 descriptor/局部实例 | `getGeneric*` + Signature 是否存在 |
| 两个泛型 overload name clash | 擦除后 descriptor 相同 | `javac` name clash diagnostic |
| handler 重复注册 | bridge/synthetic 与具体方法都扫描 | `Method.isBridge/isSynthetic` |
| 插件 Type cache 泄漏 | cache key/value 强持 loader 的 Type/Class | heap root path + loader stats |
| `List<? extends T>` 不能 add | 实际 subtype 未知 | capture 推导，而非强转绕过 |

## 15. 实验任务

1. 用 `javap -v` 对照 descriptor 与 Signature，删除 `-g` 后看哪些属性消失。
2. 写 raw pollution，让异常在 reader cast 处发生；再把 unchecked 编译警告升级错误。
3. 实现 `copy(List<? extends T>, List<? super T>)`，解释每个约束。
4. 写 generic varargs 泄漏反例，证明为什么错误 `@SafeVarargs` 不能修复。
5. 反射打印 `StringMapper` 两个 map 方法，正确识别 bridge 与业务方法。

## 16. 面试题与检查清单

**Q：为什么 List<String> 不是 List<Object>？** 若协变允许，调用方可写 Integer，破坏 String list；泛型不变把错误前移。

**Q：擦除后如何检查类型？** 编译器按泛型规则检查，Class descriptor 擦除，并在读取/bridge 等边界插 `checkcast`；Signature 保留部分声明元数据。

**Q：为什么不能 new T？** 擦除后无唯一 runtime class/constructor，bound 也不保证构造器；显式传 factory/token。

- [ ] 能从 PECS 推导读写能力而非背口诀。
- [ ] 能解释 capture variable 与 helper 方法。
- [ ] 能区分数组协变/reified 与泛型不变/擦除。
- [ ] 能找到 bridge flags、cast 和 Signature。
- [ ] 所有 unchecked suppress 都有局部不变量证明。

## 17. 延伸阅读

- [JLS 4.5–4.10：Parameterized Types, Erasure, Subtyping](https://docs.oracle.com/javase/specs/jls/se21/html/jls-4.html)
- [JLS 5.1.10：Capture Conversion](https://docs.oracle.com/javase/specs/jls/se21/html/jls-5.html#jls-5.1.10)
- [JLS 18：Type Inference](https://docs.oracle.com/javase/specs/jls/se21/html/jls-18.html)
- [JVMS 4.7.9：Signature](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-4.html#jvms-4.7.9)

下一章：[13-exception-mechanism.md](13-exception-mechanism.md)
