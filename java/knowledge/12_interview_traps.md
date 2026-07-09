# 12 · 高频面试陷阱题集锦 ⚠️

> 30+ 道经典"手撕题"。每题先**自己想答案**，再看解析。
> 形式：**代码 → 输出什么？→ 为什么 → 怎么改 / 延伸**。覆盖自动装箱、字符串、集合、并发、继承、异常等高频坑。

---

## 一、自动装箱与 Integer 缓存

### T1. Integer 比较
```java
Integer a = 127, b = 127;
Integer c = 128, d = 128;
System.out.println(a == b);   // ?
System.out.println(c == d);   // ?
```
**输出**：`true` / `false`
**为什么**：`Integer` 有缓存池 **[-128, 127]**，`Integer a = 127` 走 `Integer.valueOf` 返回缓存的同一对象，`==` 为 true。128 超出缓存范围，各 new 一个对象，`==` 比引用为 false。
**怎么改**：包装类比较值永远用 `equals` 或先拆箱比较。

### T2. 装箱拆箱与 NPE
```java
Map<String, Integer> map = new HashMap<>();
int count = map.get("missing");   // ?
```
**输出**：抛 `NullPointerException`
**为什么**：`get` 返回 `null`（Integer），赋给 `int` 要**自动拆箱** `null.intValue()` → NPE。
**怎么改**：`int count = map.getOrDefault("missing", 0);`

### T3. 三元运算符的隐式拆箱
```java
Integer i = true ? Integer.valueOf(1) : Double.valueOf(2.0).intValue();
System.out.println(i);   // ?
Object o = true ? Integer.valueOf(1) : Double.valueOf(2.0);
System.out.println(o);   // ?
```
**输出**：`1` / `1.0`
**为什么**：三元表达式两个分支类型不同会做**数值提升到 double**。第二例结果是 `1.0`（Integer 被提升为 Double）。这是隐蔽的坑。

---

## 二、字符串

### T4. 字符串 ==
```java
String a = "ab";
String b = "a" + "b";          // 编译期常量折叠
String c = new String("ab");
String d = "a";
String e = d + "b";            // 运行期拼接（d 是变量）
System.out.println(a == b);    // ?
System.out.println(a == c);    // ?
System.out.println(a == e);    // ?
```
**输出**：`true` / `false` / `false`
**为什么**：`b` 是编译期常量折叠成 `"ab"`，复用常量池，== a 为 true。`c` 是 new 的堆对象，false。`e` 运行期用 StringBuilder 拼接产生新对象，false。

### T5. final 变量参与拼接
```java
String a = "ab";
final String d = "a";
String e = d + "b";            // d 是 final 常量
System.out.println(a == e);    // ?
```
**输出**：`true`
**为什么**：`d` 是 `final`，编译期就是常量 `"a"`，`d + "b"` 被常量折叠成 `"ab"`，复用常量池。对比 T4 的非 final 变量。

---

## 三、集合

### T6. List.remove 的重载歧义 ⚠️
```java
List<Integer> list = new ArrayList<>(List.of(1, 2, 3));
list.remove(1);
System.out.println(list);   // ?
```
**输出**：`[1, 3]`
**为什么**：`remove(int index)` 和 `remove(Object)` 重载。`remove(1)` 的 1 是 `int`，匹配**按索引**删除，删掉了下标 1 的元素（值 2）。
**怎么改**：想按值删要 `list.remove(Integer.valueOf(1))`。

### T7. 遍历时修改集合
```java
List<Integer> list = new ArrayList<>(List.of(1, 2, 3, 4));
for (Integer x : list) {
    if (x % 2 == 0) list.remove(x);
}
```
**输出**：抛 `ConcurrentModificationException`（fail-fast，见文档 11）
**怎么改**：`list.removeIf(x -> x % 2 == 0);`

### T8. Arrays.asList 的坑
```java
List<Integer> list = Arrays.asList(1, 2, 3);
list.add(4);   // ?

int[] arr = {1, 2, 3};
List<int[]> wrong = Arrays.asList(arr);
System.out.println(wrong.size());   // ?
```
**输出**：第一行抛 `UnsupportedOperationException`；第二行 `1`
**为什么**：asList 返回定长视图不能 add。`int[]`（基本类型数组）被当成**单个对象**，所以 size 是 1；要 `Integer[]` 才会展开成 3 个。

### T9. HashMap 允许 null，ConcurrentHashMap 不允许
```java
new HashMap<>().put(null, null);             // OK
new ConcurrentHashMap<>().put(null, null);   // ?
```
**输出**：第二行抛 `NullPointerException`
**为什么**：CHM 禁止 null 键值（避免并发下"不存在"与"值为 null"的二义性，见文档 07）。

---

## 四、并发

### T10. i++ 不是原子的
```java
// 两个线程各对 count 做 10000 次 count++，count 是普通 int
// 最终 count 是 20000 吗？
```
**答**：几乎总是 **< 20000**。`count++` 是读-改-写三步，多线程交错丢更新。
**怎么改**：`AtomicInteger` 或 `synchronized`（见文档 04）。

### T11. volatile 不保证原子性
```java
volatile int count = 0;
// 多线程 count++，结果对吗？
```
**答**：**还是错的**。volatile 只保证可见性，`++` 仍是复合操作。volatile 适合"一写多读的标志位"，不能替代锁。

### T12. 双重检查锁少了 volatile
```java
private static Singleton instance;            // ⚠️ 没加 volatile
public static Singleton getInstance() {
    if (instance == null) synchronized (X.class) {
        if (instance == null) instance = new Singleton();
    }
    return instance;
}
```
**问题**：`new Singleton()` 的"分配-初始化-赋引用"可能重排，别的线程可能拿到**未初始化完的半成品**。
**怎么改**：`instance` 必须加 `volatile`（见文档 04）。

### T13. 线程的 start vs run
```java
Thread t = new Thread(() -> System.out.println(Thread.currentThread().getName()));
t.run();     // ?
t.start();   // ?
```
**输出**：`run()` 打印 `main`（在当前线程同步执行，没开新线程）；`start()` 打印 `Thread-0`（真正开新线程）。
**记住**：开线程必须用 `start()`，`run()` 只是普通方法调用。

### T14. SimpleDateFormat 线程不安全
```java
static SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd");
// 多线程共享 sdf 调 parse/format
```
**问题**：`SimpleDateFormat` 内部有可变状态，多线程共享会**结果错乱甚至异常**。
**怎么改**：用 `java.time.DateTimeFormatter`（不可变线程安全，见 code/09），或每次新建、或 ThreadLocal。

---

## 五、继承与多态

### T15. 静态方法不能被重写（隐藏）
```java
class A { static void f() { System.out.println("A"); } }
class B extends A { static void f() { System.out.println("B"); } }
A obj = new B();
obj.f();   // ?
```
**输出**：`A`
**为什么**：静态方法是**隐藏**而非重写，按**编译期声明类型** A 解析，不看运行期实际对象。实例方法才有多态。

### T16. 成员变量没有多态
```java
class A { int x = 1; }
class B extends A { int x = 2; }
A obj = new B();
System.out.println(obj.x);   // ?
```
**输出**：`1`
**为什么**：字段访问看**声明类型**（编译期绑定），没有多态。只有**方法调用**才动态绑定。

### T17. 构造器调用顺序
```java
class A { A() { System.out.println("A构造"); init(); } void init() { System.out.println("A.init"); } }
class B extends A { int n = 10; void init() { System.out.println("B.init, n=" + n); } }
new B();
```
**输出**：`A构造` → `B.init, n=0`
**为什么**：构造顺序是"父类构造器 → 子类字段初始化 → 子类构造器"。父类构造器里调 `init()` 动态绑定到 B 的版本，但此时 **B 的字段 n 还没初始化**（还是默认值 0）。**别在构造器里调用可被重写的方法**（Effective Java 第19条）。

### T18. equals 不重写 hashCode
```java
class Point { int x, y; /* 只重写了 equals，没重写 hashCode */ }
Set<Point> set = new HashSet<>();
set.add(new Point(1, 2));
System.out.println(set.contains(new Point(1, 2)));   // ?
```
**输出**：`false`（大概率）
**为什么**：HashSet 先按 hashCode 定位桶。没重写 hashCode 用默认（对象地址），两个内容相同的 Point hashCode 不同，落到不同桶，找不到。
**铁律**：重写 equals 必须同时重写 hashCode（相等对象 hashCode 必须相等，见文档 06）。

---

## 六、异常与 finally

### T19. finally 改返回值
```java
static int f() {
    int x = 1;
    try { return x; }
    finally { x = 2; }   // ?
}
```
**输出**：`1`
**为什么**：`return x` 时已把**返回值 1 暂存**，finally 改的是局部变量 x，不影响已暂存的返回值。

### T20. finally 里 return 吞掉一切
```java
static int f() {
    try { throw new RuntimeException("boom"); }
    finally { return 2; }   // ?
}
```
**输出**：`2`（异常被吞掉！）
**为什么**：finally 里的 `return` 会**覆盖** try 的返回值，并**吞掉异常**。
**铁律**：finally 里不要 return / throw（见 code/04）。

### T21. try-with-resources 关闭顺序
```java
try (var a = new Res("A"); var b = new Res("B")) { }
// close 顺序？
```
**输出**：先关 B 再关 A（**与声明顺序相反**，后声明的先关，像栈）。

---

## 七、运算与基本类型

### T22. 0.1 + 0.2
```java
System.out.println(0.1 + 0.2);          // ?
System.out.println(0.1 + 0.2 == 0.3);   // ?
```
**输出**：`0.30000000000000004` / `false`
**为什么**：浮点数二进制无法精确表示十进制小数。
**怎么改**：金额等精确计算用 `BigDecimal`（且要用**字符串构造** `new BigDecimal("0.1")`，别用 double 构造）。

### T23. 整数溢出
```java
int max = Integer.MAX_VALUE;
System.out.println(max + 1);   // ?
long ms = 1000 * 60 * 60 * 24 * 365;   // 一年的毫秒数
System.out.println(ms);   // ?
```
**输出**：`-2147483648`（溢出回绕）；第二个也**溢出为负/错误值**
**为什么**：`int` 运算在 int 范围内溢出。`1000*60*60*24*365` 都是 int 字面量，**先按 int 算溢出**了才赋给 long。
**怎么改**：`1000L * 60 * 60 * 24 * 365`（让第一个数是 long，整个表达式用 long 算）。

### T24. char 与 int
```java
char c = 'A';
System.out.println(c + 1);        // ?
System.out.println((char)(c + 1));// ?
```
**输出**：`66`（char 参与算术运算提升为 int）/ `B`

### T25. 三元运算符类型统一陷阱
```java
Object o = true ? 'a' : 1;     // 看似 char 或 int
System.out.println(o);          // ?
```
**输出**：`97`
**为什么**：三元两分支会做类型统一，`char` 提升为 `int`，`'a'` 变成 97。

---

## 八、其他高频

### T26. 可变参数与 null
```java
static void f(String... args) { System.out.println(args.length); }
f();          // ?
f((String) null);   // ?
```
**输出**：`0` / `1`（传一个 null 元素的数组）。直接 `f(null)` 会有歧义警告（null 当成整个数组）。

### T27. switch 穿透
```java
int x = 1;
switch (x) {
    case 1: System.out.print("1");   // 没 break
    case 2: System.out.print("2");
    default: System.out.print("d");
}
```
**输出**：`12d`（传统 switch 没 break 会**穿透**）。用 `case 1 ->` 表达式形式可避免（见 code/16）。

### T28. 包装类 ++ 与缓存
```java
Integer i = 100;
i++;
Integer j = 100;
System.out.println(i == j);   // ?（i 已 +1 变 101，无关）
```
（这题考点是 `i++` 会拆箱+1再装箱成新对象。）若问 `Integer i=100; Integer j=100; i==j` → `true`（在缓存范围内）。

### T29. 静态变量初始化顺序
```java
class A {
    static int a = b();          // 此时 c 还没初始化
    static int c = 10;
    static int b() { return c + 1; }
}
// A.a 是多少？
```
**输出**：`a = 1`
**为什么**：静态初始化**自上而下**。算 a 时调 b()，此刻 c 还没执行到赋值，是默认值 0，所以返回 1。

### T30. 字符串 split 的坑
```java
System.out.println("a,b,,".split(",").length);    // ?
System.out.println("a,b,,c".split(",").length);   // ?
```
**输出**：`2` / `4`
**为什么**：`split` 默认**丢弃尾部的空字符串**，所以 `"a,b,,"` 只剩 `["a","b"]`。中间的空串保留。要保留尾部空串用 `split(",", -1)`。

### T31. ThreadLocal 内存泄漏
```java
// 线程池中使用 ThreadLocal，用完没 remove
```
**问题**：ThreadLocal 的 key 是弱引用、value 是强引用。线程池线程长期存活，value 一直被 ThreadLocalMap 引用 → **内存泄漏**。
**怎么改**：用完务必在 finally 里 `threadLocal.remove()`。

---

## 答题心法

1. **装箱拆箱**：看到 `Integer`/`Long` 比较先想缓存池 [-128,127] 和拆箱 NPE。
2. **字符串**：编译期常量折叠（含 final）复用池，运行期拼接是新对象。
3. **集合**：remove 重载、fail-fast、null 容忍度、asList 视图。
4. **并发**：i++ 非原子、volatile 不保原子、DCL 要 volatile、start 才开线程。
5. **继承**：字段和静态方法无多态（编译期绑定），只有实例方法动态绑定；别在构造器调可重写方法。
6. **finally**：暂存返回值、别在里面 return/throw。
7. **基本类型**：浮点不精确用 BigDecimal、int 运算先溢出再转 long。

> 这些题的共同特点：**违反直觉**。面试时不仅要答对结果，更要说清**为什么**和**怎么避免**——后者才是区分度。
