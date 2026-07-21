# 08｜Java 对象模型与内存布局：从 `new` 到 Mark Word、字段和对齐

> 优先级：S｜难度：★★★★★｜基线：HotSpot 21.0.8 x64、compressed oops/class pointers、8-byte alignment｜前置：[07](07-jvm-runtime-areas.md)

## 1. 本章目标

能区分 Java 对象的语言语义、JVMS 的抽象表示和 HotSpot 的物理布局；能用 JOL 解释 header、字段重排、数组长度、padding 与压缩指针；能说明 GC 移动对象后引用为何仍正确，以及 identity hash、锁和 GC 如何竞争/共享 header 状态。

## 2. 先写实验坐标，再回答“占多少字节”

`new Object()` 没有脱离环境的唯一物理大小。至少要给：JVM 实现/build、32/64-bit、compressed oops、compressed class pointers、object alignment、compact headers、collector 和测量工具。

本章实测坐标：

```text
Oracle HotSpot 21.0.8, Windows x64
UseCompressedOops = true（JOL 观察为 3-bit shift）
UseCompressedClassPointers = true
ObjectAlignmentInBytes = 8
Compact Object Headers = 不适用于 JDK 21 默认布局
JOL 0.17；动态 attach/SA 未成功，地址 base/shift 只作猜测
```

JOL 对字段 offset/instance size 的观察仍有价值，但它明确警告“computed addresses are guesses”。证据边界必须随输出保留。

## 3. 对象创建不是构造器这一件事

对常见 `new C(args)`，逻辑路径是：

```text
解析/检查 C 是否已加载、链接、初始化
       ↓
确定实例大小与 Klass 元数据
       ↓
从 TLAB/共享 Eden/其他区域分配（或 JIT 消除）
       ↓
内存零值初始化
       ↓
设置 Mark Word、Klass pointer 等 header
       ↓
执行 invokespecial C.<init>
       ├─ 隐式/显式 super.<init>
       ├─ 实例字段初始化器与实例代码块（按编译后的顺序）
       └─ 构造器主体
       ↓
引用可发布；发布方式决定其他线程可见性
```

`<init>` 是 JVM 特殊实例初始化方法，不等于分配。若构造器抛异常，引用通常不会正常返回，但对象内存由 GC 最终处理。JIT 逃逸分析还可能把整个 allocation 标量化；因此步骤描述的是可观察语义/常见慢快路径，不承诺每次都有 heap bump。

## 4. HotSpot 21 的经典对象布局

```text
ordinary object
┌──────────────────────────────┐ offset 0
│ Mark Word                    │ 8 bytes on x64
├──────────────────────────────┤
│ Klass Word / class pointer   │ 4 bytes when compressed
├──────────────────────────────┤
│ instance fields              │ reordered/aligned by VM
├──────────────────────────────┤
│ internal/external padding    │
└──────────────────────────────┘ multiple of object alignment

array object
┌ Mark Word ───────────────────┐
├ Klass Word ──────────────────┤
├ array length (int) ──────────┤
├ padding if required ─────────┤
├ elements (primitive/ref) ────┤
└ final alignment ─────────────┘
```

JVMS 2.7 明确不强制任何对象内部结构，甚至实现可用 handle。上图只属于目标 HotSpot 配置。

## 5. Mark Word：复用状态，不是固定“锁字段”

经典 HotSpot mark word 会编码或指向 identity hash、GC age、锁状态/locking record/monitor 等信息，具体位布局随版本、locking mode、collector 与 Compact Headers 演进。偏向锁自 JDK 15 默认禁用并继续退出历史舞台；JDK 21 JOL 输出 `non-biasable`，不能继续讲固定的“无锁→偏向→轻量→重量”单向状态链。

本仓库 [LayoutLab.java](labs/object-layout/src/main/java/dev/deepjava/layout/LayoutLab.java) 实测：

```text
before synchronized: 0x0000000000000001 (non-biasable; age: 0)
inside synchronized:  ... (thin lock: pointer-like value)
after identity hash:  ... (hash: 0x..., age: 0)
```

三条边界：

1. JOL 读取本身会执行代码，结果属于这一时刻；
2. identity hash 可能迫使 VM 保存 header 信息并影响 locking 路径，但不是“调用 hashCode 永久变重量锁”的普遍定律；
3. monitor inflation/deflation、lightweight locking 方案随 JDK 变化，需结合对应 HotSpot 源码和 `-Xlog:monitorinflation`（支持时）观察。

## 6. Klass pointer 与动态类型

对象必须能关联其运行时类，支持虚方法分派、`instanceof/checkcast`、反射、GC 扫描引用字段和对象大小计算。经典布局用 Klass Word 指向/编码 VM 内部 Klass 元数据；压缩类指针以 narrow 编码减少 header。

这不是 `java.lang.Class` 引用本身。Klass 是 HotSpot native metadata；Class mirror 是 Java heap 对象。`obj.getClass()` 返回 mirror，VM 内部通过元数据关系得到它。

JDK 25 的 JEP 519 把 Compact Object Headers 提升为**非默认产品特性**，目标是在 x64/AArch64 把 classic 96/128-bit header 压到 64-bit，把压缩 class pointer 合入 header。它不改变本机 JDK 21 观察，也不能把“8-byte header”无条件写成 JDK 25 默认。

## 7. 字段布局、重排与 padding

Java 源码声明顺序不保证就是 HotSpot 物理 offset 顺序。VM 可能按父类边界、字段尺寸、引用/非引用分组和布局策略重排，以满足 alignment 并减少空洞。JMM 保证字段语义，不要求反射/Unsafe 按源码 offset。

样例源码顺序：

```java
byte tag;
long sequence;
Object payload;
int retries;
boolean completed;
```

当前实测：

```text
 0..11 header
12..15 int retries
16..23 long sequence
24     byte tag
25     boolean completed
26..27 internal padding
28..31 compressed reference payload
instance size = 32 bytes
```

“调整源码字段顺序一定能省内存”并不可靠，因为 VM 已可能重排，并且继承层次、`@Contended`、压缩模式会改变结果。优化要对真实类用 JOL/heap 统计，并考虑访问局部性与可维护性，不只追 2 byte padding。

### 对齐公式直觉

若 header + fields 为 `rawSize`，对象大小通常近似：

```text
alignedSize = ceil(rawSize / alignment) * alignment
```

但字段内部 padding、继承字段布局和数组 base offset 要先由 VM 决定，不能只把源码字段 size 相加。

## 8. 本机 JOL 实测表

运行：

```powershell
cd labs\object-layout
mvn -q package exec:java
```

| 对象 | header/base | payload | padding | instance size |
|---|---:|---:|---:|---:|
| 空 `Empty` | 12 | 0 | 4 external | 16 |
| `MixedFields` | 12 | 18 | 2 internal | 32 |
| `int[3]` | 16（含 length） | 12 | 4 external | 32 |
| `Object[3]` | 16（含 length） | 12（3×4 narrow oop） | 4 external | 32 |

`Object[3]` 的 32 byte 只包含数组对象与三个引用槽，**不包含**三个被引用对象。图/表中要区分 shallow size 与 retained size：retained size 还受共享引用和 GC root 路径影响，不能用 `数组 shallow + 元素 shallow` 简单相加得唯一值。

## 9. 压缩 Oops 为什么省内存

64-bit 地址不意味着 heap 内每个引用必须存完整 64 bit。HotSpot 在可覆盖范围内用 narrow oop，通过 base + shift 解码对象位置；8-byte alignment 让低 3 bit 隐含为 0，扩展可寻址范围。引用字段/对象数组元素从 8 降到 4 bytes，会减少 heap、cache footprint 和 GC 扫描带宽。

关闭压缩指针做对照必须新建 JVM：

```powershell
mvn -q exec:java -Dexec.jvmArgs="-XX:-UseCompressedOops -XX:-UseCompressedClassPointers"
```

注意 exec plugin 是否真正把参数传到 fork 的 JVM；若插件未 fork，需直接构建 classpath 后执行 `java`。验证标准是 JOL `VM.current().details()` 显示 flags 变化，而不是相信命令行字符串。

大 heap 可能让压缩 oops 模式/zero-based 条件改变；阈值与编码策略是 HotSpot 版本/参数细节，不背固定“32G”神奇数字。

## 10. 数组为什么多一个 length

数组运行时类型和长度是对象固有属性，`arraylength` 可 O(1) 读取，JVM 也必须做边界检查和精确大小/元素扫描。Class metadata 只能告诉元素类型，不能告诉每个实例的长度，因此数组 header 需要实例 length。

primitive array 连续存值；reference array 连续存引用，元素对象在别处。`boolean[]` 的元素布局是实现关注点；不要从 `boolean` 字段 1 byte 推导所有 VM 的数组编码。

大 primitive 数组可能成为 G1 humongous object，按连续 Region 处理；Agent embedding 的 `float[]`/`byte[]` 批次应按 region/GC 日志观察，不只算业务元素总字节。

## 11. 引用的四种强度与 ReferenceQueue

| 引用 | 回收语义直觉 | 常见用途/陷阱 |
|---|---|---|
| strong | 可达则普通对象不被回收 | 默认；cache 无界会 leak |
| soft | 内存压力下可清理，策略由实现决定 | 不适合作为可预测容量 cache |
| weak | 到达特定可达性状态后可清理 | canonical map/metadata；随时为空 |
| phantom | 对象已不可再取回，用于 post-mortem cleanup 通知 | 必须配 ReferenceQueue；不能替代显式 close |

Reference processing 与 GC 并发/停顿阶段相关。`ReferenceQueue` 只在程序 poll/remove 时变成业务事件；忘记 drain 会让引用对象/清理记录积压。Cleaner/phantom 是最后保险，不保证及时释放 file/socket/direct native resource；工程必须 `try-with-resources`/显式生命周期。

Finalization 已被弃用待移除，既有安全、延迟和 resurrection 问题，不作为新设计方案。

## 12. 对象移动后引用为何仍正确

复制/整理 GC 先确定新地址，再更新 roots 和对象中的引用，或安装 forwarding 信息并通过 load barrier/colored pointer 等机制在读取时修正。应用持有的是受 JVM 管理的 reference value，不是可自行算术的地址。

JNI 若需要跨 safepoint 持有对象，必须用合法 local/global/weak global reference；缓存从临界区获得的裸指针并让 GC 运行会破坏规则。`Unsafe` 返回的 field offset 也只在目标 VM/类布局上下文有意义。

## 13. 大量小对象为什么压垮系统

即使 bump allocation 很快，每个对象仍可能带来：

- header + alignment 的空间放大；
- 初始化、引用写 barrier 与 allocation accounting；
- Eden 带宽、Young GC copy/scan；
- 晋升后 old live set/remembered set；
- pointer chasing 与 cache miss；
- heap dump、序列化和观测成本。

Agent 流式事件若每 token 创建多层 wrapper/map/string，会以高 allocation rate 触发 GC，即使最终 live set 很小。先用 JFR allocation sample/async-profiler alloc 定位，再考虑批量事件、primitive buffer、复用或数据结构扁平化；对象池可能增加老年代 retention、并发复杂度和清零成本，不能默认更快。

## 14. 后端与 Agent 设计

- DTO/record 的浅不可变有利安全发布，但嵌套集合要 copy。
- cache 容量按 retained bytes 与 key 基数，不按 entry count；一个 key 可能保留整棵文档图。
- prompt/JSON/string 往往同时存在 UTF-8 byte[]、String、parser buffer 多份表示，峰值大于文件大小。
- Tool 输出和 SSE delta 应在 byte 层有上限，解码器维护字符边界，避免无限 StringBuilder。
- 多租户内存隔离不能靠 heap GC 自动公平；需要 per-tenant admission、quota 和可归因指标。

## 15. 常见错误与排障

| 误区/现象 | 正确路径 |
|---|---|
| “Object 永远 16 bytes” | 给 VM/build/flags/alignment；JDK 25 compact header 可改变 |
| “数组大小=元素数×元素 size” | 加 header、length、base padding、final alignment |
| “字段按源码顺序” | JOL/VM layout；不要依赖 offset |
| “引用是 64-bit 地址” | 检查 compressed oops；规范只给 reference 抽象 |
| “弱引用 cache 不会 OOM” | key/value/reference/queue 仍占空间，清理不确定 |
| “identity hash 使所有锁永久膨胀” | 对目标 locking mode 做 JOL + monitor log 对照 |
| shallow size 很小但 heap 大 | 看 retained graph、重复对象和 roots |

排障命令：JOL 看单类 layout，JFR/async-profiler 看 allocation，heap dump 看 retained graph，GC log 看复制/晋升/humongous；四者回答不同问题。

## 16. 实验任务

1. 改 `MixedFields` 字段、加父类，记录 layout 与 padding，不先猜结果。
2. 分别开启/关闭 compressed oops/class pointers；验证 JVM 参数确实生效。
3. 对同一 monitor 记录 lock 前/内/后/hash 后 JOL；加竞争线程观察 inflation，并设置超时。
4. 构造 `Object[1000]`，分别测空引用数组、填充共享单例、填充 1000 个对象的 graph size，解释 shallow/retained。
5. 生成大量相同/不同短字符串，用 JFR allocation + heap dump 判断 intern/去重收益和成本。

## 17. 面试题与检查清单

**Q：`new Object()` 多大？** 在本章 HotSpot 21 配置是 12-byte classic header + 4-byte alignment = 16；换 VM、flags、alignment、JDK 25 compact headers 可变。

**Q：字段顺序为什么影响/不影响大小？** 尺寸与对齐产生空洞，但 HotSpot 也会重排；只能对目标布局实测，源码顺序不是稳定 ABI。

**Q：GC 移动对象后引用怎么办？** 更新 roots/fields 或通过 forwarding/barrier 修正；reference 是 JVM 管理的抽象值。

- [ ] 每个大小结论都写 VM/flags/tool。
- [ ] 能解释 Mark/Klass/array length/fields/padding。
- [ ] 能区分 shallow size、graph size、retained size。
- [ ] 知道 compressed oops 的编码直觉和验证方法。
- [ ] 不用 Reference/Cleaner 替代显式资源关闭。

## 18. 延伸阅读

- [JVMS 2.7：Representation of Objects](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-2.html#jvms-2.7)
- [OpenJDK JOL](https://github.com/openjdk/jol)
- [JEP 374：Disable and Deprecate Biased Locking](https://openjdk.org/jeps/374)
- [JEP 519：Compact Object Headers](https://openjdk.org/jeps/519)
- [Reference API, Java 21](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/ref/Reference.html)

下一章：[15-java-memory-model.md](15-java-memory-model.md)
