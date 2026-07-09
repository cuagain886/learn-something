/*
═══════════════════════════════════════════════════════════════════
 06_lambda —— Lambda 表达式与函数式接口
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. 函数式接口：@FunctionalInterface（有且仅有一个抽象方法）
  2. Lambda 语法与四大内置函数式接口 Function/Consumer/Supplier/Predicate
  3. 方法引用的四种形态
  4. ⚠️ 闭包：Lambda 只能捕获 effectively final 的变量

【运行】java 06_lambda/Main.java
*/

import java.util.*;
import java.util.function.*;

public class Main {
    public static void main(String[] args) {
        // ── 1. Lambda 就是"函数式接口的实例" ──────────────
        // 下面三种写法等价，都是给 Runnable（单抽象方法接口）一个实现：
        Runnable r1 = new Runnable() { public void run() { System.out.println("匿名类"); } };
        Runnable r2 = () -> System.out.println("Lambda");
        r1.run(); r2.run();

        // ── 2. 四大内置函数式接口 ──────────────────────────
        // Function<T,R>：输入 T 返回 R
        Function<String, Integer> len = s -> s.length();
        System.out.println("长度: " + len.apply("hello"));
        // andThen / compose 组合
        Function<Integer, Integer> doubleIt = x -> x * 2;
        System.out.println("先求长再翻倍: " + len.andThen(doubleIt).apply("hello"));

        // Consumer<T>：消费 T，无返回（如打印、写库）
        Consumer<String> print = System.out::println;
        print.accept("Consumer 输出");

        // Supplier<T>：无输入，生产 T（如工厂、延迟求值）
        Supplier<Double> random = Math::random;
        System.out.println("Supplier 生产: " + random.get());

        // Predicate<T>：输入 T 返回 boolean（条件判断），可 and/or/negate
        Predicate<Integer> isEven = n -> n % 2 == 0;
        Predicate<Integer> isPositive = n -> n > 0;
        System.out.println("4 是正偶数? " + isEven.and(isPositive).test(4));
        System.out.println("3 是奇数? " + isEven.negate().test(3));

        // BiFunction<T,U,R>：两个输入
        BiFunction<Integer, Integer, Integer> add = Integer::sum;
        System.out.println("相加: " + add.apply(3, 4));

        // ── 3. 方法引用的四种形态 ──────────────────────────
        List<String> words = new ArrayList<>(List.of("banana", "Apple", "cherry"));
        // ① 静态方法引用      ClassName::staticMethod
        words.sort(String::compareToIgnoreCase);
        System.out.println("排序: " + words);
        // ② 特定实例方法引用  instance::method
        String prefix = "pre-";
        Function<String, String> addPrefix = prefix::concat;
        System.out.println(addPrefix.apply("fix"));
        // ③ 任意对象实例方法  ClassName::instanceMethod（第一个参数当接收者）
        Function<String, Integer> strLen = String::length;
        System.out.println("引用实例法: " + strLen.apply("abcd"));
        // ④ 构造器引用        ClassName::new
        Supplier<ArrayList<String>> listFactory = ArrayList::new;
        System.out.println("构造器引用造出: " + listFactory.get());

        // ── 4. ⚠️ 闭包：只能捕获 effectively final 的变量 ──
        int base = 10;                       // 没有显式 final，但之后没被改 → "事实上 final"
        Function<Integer, Integer> addBase = x -> x + base;
        System.out.println("闭包捕获: " + addBase.apply(5));
        // base = 20;   // ⚠️ 若取消注释，上面的 Lambda 会编译错误（base 不再 effectively final）

        // 想"修改"捕获的状态？用数组/AtomicInteger 等可变容器绕过（但要小心线程安全）
        int[] counter = {0};
        Runnable inc = () -> counter[0]++;
        inc.run(); inc.run();
        System.out.println("可变容器计数: " + counter[0]);

        // ── 5. 自定义函数式接口 ────────────────────────────
        Calculator pow = (a, b) -> Math.pow(a, b);
        System.out.println("2^10 = " + pow.compute(2, 10));
    }
}

@FunctionalInterface        // 编译器强制检查：必须恰好一个抽象方法
interface Calculator {
    double compute(double a, double b);
    // default / static 方法不算"抽象方法"，可以有任意多个
    default Calculator then(Function<Double, Double> after) {
        return (a, b) -> after.apply(compute(a, b));
    }
}

/*
【为什么需要函数式接口？】
  Java 的 Lambda 没有独立的"函数类型"，它必须依附于某个【只有一个抽象方法】
  的接口（SAM, Single Abstract Method）。编译器看上下文需要什么接口，
  就把 Lambda 当成那个接口的实例。所以：
     Runnable r = () -> ...;        // Lambda 是 Runnable
     Callable<String> c = () -> ...; // 同样的 () -> 在这变成 Callable

【四大内置接口速记（java.util.function）】
  Supplier<T>      ()      -> T        没输入有输出（工厂/延迟）
  Consumer<T>      T       -> void     有输入没输出（打印/写库）
  Function<T,R>    T       -> R        转换
  Predicate<T>     T       -> boolean  判断
  + 双参版本 BiFunction/BiConsumer/BiPredicate
  + 原始类型特化 IntFunction/ToIntFunction/IntPredicate...（避免装箱，见第7课性能）

【方法引用 = Lambda 的语法糖】
  x -> System.out.println(x)   等价  System.out::println
  s -> s.length()              等价  String::length
  能用方法引用就用，更短更清晰。
*/
