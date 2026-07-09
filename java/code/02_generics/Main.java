/*
═══════════════════════════════════════════════════════════════════
 02_generics —— 泛型：类型参数、上下界、通配符、类型擦除
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. 泛型类、泛型方法、有界类型参数 <T extends ...>
  2. 通配符 ? 与 PECS 原则（生产者 extends，消费者 super）
  3. ⚠️ 类型擦除（type erasure）—— Java 泛型最坑的底层真相
  4. 泛型的限制：不能 new T[]、不能 instanceof List<String> 等

【运行】java 02_generics/Main.java

【一句话本质】
  Java 泛型是【编译期】的类型检查工具，运行期类型信息被"擦除"。
  这和 Go/C++ 的泛型（运行期保留类型）完全不同，必须记牢。
*/

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public class Main {
    public static void main(String[] args) {
        // ── 1. 泛型类 ──────────────────────────────────────
        Pair<String, Integer> p = new Pair<>("age", 30);
        System.out.println(p.first() + " = " + p.second());

        // ── 2. 泛型方法：类型参数写在返回类型前 ─────────────
        // 编译器从实参推断 T，通常不用显式写 <Integer>
        List<Integer> ints = listOf(1, 2, 3);
        List<String> strs = listOf("a", "b");
        System.out.println(ints + " " + strs);
        System.out.println("max=" + max(Arrays.asList(3, 9, 1, 7))); // 有界类型参数

        // ── 3. PECS：生产者 extends，消费者 super ───────────
        List<Integer> src = List.of(1, 2, 3, 4);
        List<Number> dst = new ArrayList<>();
        copy(src, dst);     // 从 src 读(生产)，往 dst 写(消费)
        System.out.println("copy 后 dst=" + dst);

        // ? extends Number：只能读出来当 Number，不能写入（除 null）
        double total = sum(List.of(1, 2, 3));      // List<Integer> 也能传
        double total2 = sum(List.of(1.5, 2.5));    // List<Double> 也能传
        System.out.println("sum=" + total + ", " + total2);

        // ── 4. ⚠️ 类型擦除实证 ─────────────────────────────
        List<String> ls = new ArrayList<>();
        List<Integer> li = new ArrayList<>();
        // 运行期两者是【同一个类】！泛型信息没了。
        System.out.println("擦除后同类? " + (ls.getClass() == li.getClass())); // true

        // 因为擦除，下面这些都【编译不过】（取消注释会报错）：
        //   if (ls instanceof List<String>) {}   // 错：无法在运行期检查 <String>
        //   T[] arr = new T[10];                  // 错：不能 new 泛型数组
        //   class A<T> { static T x; }            // 错：静态成员不能用类型参数

        // ── 5. 桥方法 / 协变返回 等细节见文末注释 ───────────
        demonstrateErasurePitfall();
    }

    // 泛型方法：<T> 声明在返回类型之前
    @SafeVarargs
    static <T> List<T> listOf(T... items) {
        return new ArrayList<>(Arrays.asList(items));
    }

    // 有界类型参数：T 必须是 Comparable<T>，才能调用 compareTo
    static <T extends Comparable<T>> T max(List<T> list) {
        T best = list.get(0);
        for (T x : list) if (x.compareTo(best) > 0) best = x;
        return best;
    }

    // PECS：src 是生产者(读)用 extends，dst 是消费者(写)用 super
    static <T> void copy(List<? extends T> src, List<? super T> dst) {
        for (T item : src) dst.add(item);
    }

    // ? extends Number：接受 Number 及其任意子类型的列表
    static double sum(List<? extends Number> nums) {
        double s = 0;
        for (Number n : nums) s += n.doubleValue();
        return s;
    }

    // ⚠️ 擦除带来的"看似类型安全实则不安全"
    @SuppressWarnings("unchecked")
    static void demonstrateErasurePitfall() {
        List<String> strings = new ArrayList<>();
        List raw = strings;          // 退化成原始类型 raw type（编译器仅警告）
        raw.add(42);                 // 塞进一个 Integer！编译期没拦住
        try {
            String s = strings.get(0); // 取出时才在此处隐式插入了 checkcast → 抛异常
        } catch (ClassCastException e) {
            System.out.println("擦除陷阱触发 ClassCastException：" + e.getMessage());
        }
    }
}

// ───────────────────────────────────────────────────────────────
// 泛型类：两个类型参数。Java 16+ 这种纯数据载体更推荐用 record（见第13课）
// ───────────────────────────────────────────────────────────────
class Pair<A, B> {
    private final A a;
    private final B b;
    Pair(A a, B b) { this.a = a; this.b = b; }
    A first() { return a; }
    B second() { return b; }
}

/*
【PECS 助记】Producer-Extends, Consumer-Super
  - 你要从结构里【读取】T（它生产 T 给你）→ <? extends T>
  - 你要往结构里【写入】T（它消费你的 T）   → <? super T>
  - 既读又写 → 用确切类型 <T>，别用通配符
  典型例子：Collections.copy(dest, src) 签名就是
      copy(List<? super T> dest, List<? extends T> src)

【类型擦除的连锁后果（面试高频）】
  1. List<String> 和 List<Integer> 运行期是同一个 Class
  2. 不能 new T[]、不能 new ArrayList<String>[10]（泛型数组）
  3. 不能对参数化类型做 instanceof（只能 instanceof List<?> ）
  4. 静态字段/方法不能使用类的类型参数
  5. catch 不能捕获泛型异常类型
  6. 重载时 List<String> 和 List<Integer> 擦除后签名冲突 → 编译错误
  补偿手段：需要运行期类型时传 Class<T>（"类型令牌"），
            如 <T> T fromJson(String s, Class<T> type)。

【为什么 Java 选擦除？】为了和 Java 5 之前的代码二进制兼容
  （老的非泛型 .class 不用改就能跑）。代价就是上面这一堆限制。
*/
