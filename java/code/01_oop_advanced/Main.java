/*
═══════════════════════════════════════════════════════════════════
 01_oop_advanced —— 面向对象进阶：抽象类、接口、内部类、不可变对象
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. 抽象类（abstract class）与接口（interface）的本质区别与选型
  2. 接口的现代能力：default 方法、static 方法、private 方法（Java 8/9+）
  3. 内部类的四种形态：成员内部类、静态嵌套类、局部类、匿名类
  4. 如何设计一个真正"不可变"的类（Effective Java 经典话题）

【运行】java 01_oop_advanced/Main.java

【与基础的衔接】
  你已经会写 class、继承 extends、方法重写。这一课把"会写"升级到
  "会设计"：什么时候用抽象类、什么时候用接口、怎么用内部类组织代码。
*/

import java.util.ArrayList;
import java.util.List;

public class Main {
    public static void main(String[] args) {
        // ── 1. 抽象类：有共享状态/实现的"半成品" ──────────────
        // 抽象类不能被 new，必须由子类补全 abstract 方法。
        Shape c = new Circle(2.0);
        Shape r = new Rectangle(3.0, 4.0);
        System.out.printf("圆面积=%.2f，描述=%s%n", c.area(), c.describe());
        System.out.printf("矩面积=%.2f，描述=%s%n", r.area(), r.describe());

        // ── 2. 接口 + default 方法 ─────────────────────────
        // 接口可以带"默认实现"，老接口加新方法时不破坏已有实现类。
        Greeter en = name -> "Hello, " + name;     // 只实现唯一抽象方法
        System.out.println(en.greet("Java"));        // 用接口里的 default 方法
        System.out.println(en.greetLoudly("Java"));

        // ── 3. 静态嵌套类 vs 成员内部类 ─────────────────────
        // Builder 是静态嵌套类：不持有外部实例，可独立 new。
        var user = new User.Builder().name("Alice").age(30).build();
        System.out.println(user);

        // 成员内部类持有外部实例引用，能访问外部私有成员。
        var box = new Box<Integer>();
        box.add(1); box.add(2); box.add(3);
        for (int x : box) System.out.print(x + " ");   // 用内部类实现的迭代器
        System.out.println();

        // ── 4. 匿名类 vs Lambda ────────────────────────────
        // 匿名类能实现多方法接口/抽象类；Lambda 只能实现单抽象方法接口。
        Runnable viaAnon = new Runnable() {
            @Override public void run() { System.out.println("匿名类 run"); }
        };
        Runnable viaLambda = () -> System.out.println("Lambda run");
        viaAnon.run();
        viaLambda.run();

        // ── 5. 不可变对象 ──────────────────────────────────
        Money m1 = new Money(100, "CNY");
        Money m2 = m1.plus(50);             // 不修改 m1，返回新对象
        System.out.println(m1 + " | " + m2); // m1 仍是 100
    }
}

// ───────────────────────────────────────────────────────────────
// 抽象类：当多个子类有【公共状态或公共实现】时用它
// ───────────────────────────────────────────────────────────────
//   - 可以有字段、构造器、已实现的方法（区别于接口的核心）
//   - 单继承：一个类只能 extends 一个抽象类
abstract class Shape {
    private final String name;          // 抽象类可以有状态
    protected Shape(String name) { this.name = name; }

    abstract double area();             // 抽象方法：子类必须实现

    // 已实现的方法：所有子类共享，子类不必重写
    String describe() {
        return name + "(面积=" + String.format("%.2f", area()) + ")";
    }
}

class Circle extends Shape {
    private final double radius;
    Circle(double radius) { super("圆"); this.radius = radius; }
    @Override double area() { return Math.PI * radius * radius; }
}

class Rectangle extends Shape {
    private final double w, h;
    Rectangle(double w, double h) { super("矩形"); this.w = w; this.h = h; }
    @Override double area() { return w * h; }
}

// ───────────────────────────────────────────────────────────────
// 接口：定义"能力/契约"，用来实现多继承式的能力组合
// ───────────────────────────────────────────────────────────────
//   - default 方法（Java 8）：带默认实现，演进接口不破坏旧代码
//   - static 方法（Java 8）：工具方法，挂在接口名下
//   - private 方法（Java 9）：给 default/static 方法复用的内部逻辑
@FunctionalInterface
interface Greeter {
    String greet(String name);                       // 唯一抽象方法 → 可用 Lambda

    default String greetLoudly(String name) {        // 默认方法
        return shout(greet(name));                    // 复用 private 方法
    }
    private String shout(String s) { return s.toUpperCase() + "!"; } // Java 9+
    static Greeter formal() { return n -> "Dear " + n; }            // 静态工厂
}

/*
【抽象类 vs 接口 怎么选？】
  ┌───────────────┬──────────────────┬──────────────────────┐
  │               │ 抽象类            │ 接口                  │
  ├───────────────┼──────────────────┼──────────────────────┤
  │ 状态(字段)    │ 可以有           │ 只能 public static final 常量 │
  │ 构造器        │ 有               │ 没有                  │
  │ 继承数量      │ 单继承           │ 多实现（一个类实现多个）│
  │ 方法实现      │ 可以             │ default/static/private │
  │ 适用场景      │ "is-a"+共享实现  │ "can-do"能力契约      │
  └───────────────┴──────────────────┴──────────────────────┘
  经验法则：优先用接口（更灵活、可多实现）；
  当多个实现需要共享【字段状态】或大量公共代码时才用抽象类。
*/

// ───────────────────────────────────────────────────────────────
// 静态嵌套类：典型用途 —— Builder 模式（构建参数多的对象）
// ───────────────────────────────────────────────────────────────
class User {
    private final String name;
    private final int age;
    private User(Builder b) { this.name = b.name; this.age = b.age; }

    @Override public String toString() { return "User{name=" + name + ", age=" + age + "}"; }

    // static 嵌套类：不需要外部 User 实例就能创建，独立性强
    static class Builder {
        private String name = "";
        private int age = 0;
        Builder name(String name) { this.name = name; return this; }  // 链式
        Builder age(int age) { this.age = age; return this; }
        User build() { return new User(this); }
    }
}

// ───────────────────────────────────────────────────────────────
// 成员内部类：持有外部实例，能访问外部私有成员（如实现迭代器）
// ───────────────────────────────────────────────────────────────
class Box<T> implements Iterable<T> {
    private final List<T> items = new ArrayList<>();
    void add(T item) { items.add(item); }

    @Override public java.util.Iterator<T> iterator() {
        return new BoxIterator();        // 成员内部类隐式持有 Box.this
    }

    private class BoxIterator implements java.util.Iterator<T> {
        private int index = 0;
        @Override public boolean hasNext() { return index < items.size(); } // 直接访问外部 items
        @Override public T next() { return items.get(index++); }
    }
}

// ───────────────────────────────────────────────────────────────
// 不可变对象：线程安全、可放心共享、可做 Map 键（Effective Java 第17条）
// ───────────────────────────────────────────────────────────────
//   设计要点：① final 类（不可被继承绕过）② 所有字段 private final
//   ③ 不提供 setter ④ "修改"操作返回新对象 ⑤ 含可变字段要防御性拷贝
final class Money {
    private final long amount;
    private final String currency;
    Money(long amount, String currency) { this.amount = amount; this.currency = currency; }

    Money plus(long delta) { return new Money(amount + delta, currency); } // 返回新对象
    @Override public String toString() { return amount + " " + currency; }
}
