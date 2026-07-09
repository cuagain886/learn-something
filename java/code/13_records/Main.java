/*
═══════════════════════════════════════════════════════════════════
 13_records —— Record 记录类（Java 16 正式，14/15 预览）
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. Record 一行声明，自动生成构造器/访问器/equals/hashCode/toString
  2. 紧凑构造器（compact constructor）做校验/规范化
  3. 自定义方法、静态工厂、附加构造器
  4. Record 的限制与适用场景（不可变数据载体）

【运行】java 13_records/Main.java
*/

import java.util.*;

public class Main {
    public static void main(String[] args) {
        // ── 1. 一行 record 顶过去几十行样板代码 ────────────
        Point p1 = new Point(1, 2);
        Point p2 = new Point(1, 2);
        // 自动生成的访问器是【字段名()】，不是 getX()
        System.out.println("x=" + p1.x() + " y=" + p1.y());
        // 自动生成 equals：按值比较（不是按引用）
        System.out.println("p1.equals(p2)? " + p1.equals(p2));   // true
        // 自动生成 hashCode：值相等则 hash 相等 → 能直接做 Map 键/Set 元素
        System.out.println("同 hash? " + (p1.hashCode() == p2.hashCode()));
        // 自动生成 toString
        System.out.println("toString: " + p1);                   // Point[x=1, y=2]

        Set<Point> set = new HashSet<>(List.of(p1, p2));
        System.out.println("去重后大小: " + set.size());          // 1（值相等）

        // ── 2. 紧凑构造器：校验 + 规范化 ───────────────────
        Range r = new Range(5, 1);     // 故意传反，构造器里自动修正
        System.out.println("规范化后: " + r);
        try {
            new Temperature(-300);     // 触发校验
        } catch (IllegalArgumentException e) {
            System.out.println("校验拦截: " + e.getMessage());
        }

        // ── 3. 自定义方法 + 静态工厂 + 附加构造器 ──────────
        Money m = Money.of(100);       // 静态工厂
        System.out.println(m + " 翻倍 = " + m.times(2));

        // ── 4. record 嵌套 + 与模式匹配天然契合（见第15课）─
        var line = new Line(new Point(0, 0), new Point(3, 4));
        System.out.println("线段长度: " + line.length());

        // ── 5. 本地 record（方法内部声明，临时数据结构）────
        record Pair(String k, int v) {}        // Java 16+ 允许方法内声明
        var pairs = List.of(new Pair("a", 3), new Pair("b", 1));
        var sorted = pairs.stream()
                .sorted(Comparator.comparingInt(Pair::v))
                .map(Pair::k).toList();
        System.out.println("按值排序的键: " + sorted);
    }
}

// 最简单的 record：括号里是"组件"，自动成为 final 字段
record Point(int x, int y) {}

// 紧凑构造器：不写参数列表，在赋值给字段前做校验/规范化
record Range(int lo, int hi) {
    Range {                          // 注意：没有 (int lo, int hi)
        if (lo > hi) { int t = lo; lo = hi; hi = t; }  // 修正后会自动赋给字段
    }
}

record Temperature(double celsius) {
    Temperature {
        if (celsius < -273.15) throw new IllegalArgumentException("低于绝对零度: " + celsius);
    }
}

// record 可以有静态工厂、自定义方法、附加构造器
record Money(long cents) {
    static Money of(long yuan) { return new Money(yuan * 100); }   // 静态工厂
    Money times(int n) { return new Money(cents * n); }            // 业务方法
    @Override public String toString() { return (cents / 100.0) + "元"; } // 可覆盖
}

record Line(Point start, Point end) {
    double length() {
        int dx = end.x() - start.x(), dy = end.y() - start.y();
        return Math.sqrt(dx * dx + dy * dy);
    }
}

/*
【Record 替你生成了什么】
  record Point(int x, int y) {} 等价于一个：
  - final 类，继承 java.lang.Record（不能再 extends 别的类）
  - private final int x, y;            字段全 final → 不可变
  - 一个全参"规范构造器" Point(int x, int y)
  - 访问器 x()、y()（注意没有 get 前缀）
  - 基于全部组件的 equals / hashCode / toString
  写法省了 30+ 行样板，且天然正确（不会忘了某个字段没进 equals）。

【限制（因为它是"不可变数据载体"）】
  - 不能继承别的类（已隐式继承 Record），但可以 implements 接口
  - 所有字段隐式 final，不能加可变实例字段（可以加 static 字段）
  - 不能声明实例初始化块
  - 适合"纯数据"：DTO、值对象、坐标、配置项、多返回值、模式匹配的数据形状

【何时用 record vs class】
  用 record：数据是不可变的、由"它包含的值"定义身份（值语义）
  用 class： 需要可变状态、需要继承、需要隐藏内部表示（封装行为 > 暴露数据）

【与其它特性的协同】
  - record + sealed（第14课）= 代数数据类型（封闭的类型集合）
  - record + 模式匹配（第15课）= record 解构，switch 直接拆出字段，极其优雅
*/
