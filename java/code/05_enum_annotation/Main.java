/*
═══════════════════════════════════════════════════════════════════
 05_enum_annotation —— 枚举与注解
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. 枚举不只是常量：可以带字段、构造器、方法，甚至每个常量各自实现
  2. EnumMap / EnumSet：针对枚举优化的高效集合
  3. 自定义注解：元注解 @Retention/@Target、注解元素
  4. 用反射在运行期读取注解（框架如 Spring/JUnit 的底层原理）

【运行】java 05_enum_annotation/Main.java
*/

import java.lang.annotation.*;
import java.lang.reflect.Method;
import java.util.EnumMap;
import java.util.EnumSet;

public class Main {
    public static void main(String[] args) throws Exception {
        // ── 1. 带行为的枚举 ────────────────────────────────
        for (Planet p : Planet.values()) {
            System.out.printf("%s 表面重力=%.2f%n", p, p.surfaceGravity());
        }
        // 枚举是单例、天然线程安全，是实现单例模式的最佳方式（Effective Java 第3条）
        Operation op = Operation.PLUS;
        System.out.println("3 PLUS 4 = " + op.apply(3, 4));     // 常量各自实现 apply
        System.out.println("3 TIMES 4 = " + Operation.TIMES.apply(3, 4));

        // ── 2. EnumSet / EnumMap：底层用位向量/数组，极快 ──
        EnumSet<Day> weekend = EnumSet.of(Day.SAT, Day.SUN);
        System.out.println("周末: " + weekend + "，今天是周末? " + weekend.contains(Day.SAT));
        EnumMap<Day, String> plan = new EnumMap<>(Day.class);
        plan.put(Day.MON, "开周会");
        plan.put(Day.FRI, "写周报");
        System.out.println("日程: " + plan);

        // ── 3. 自定义注解 + 反射读取 ───────────────────────
        // 模拟一个迷你"测试框架"：扫描 @Test 方法并执行
        System.out.println("--- 运行带 @Test 的方法 ---");
        for (Method m : TestCases.class.getDeclaredMethods()) {
            if (m.isAnnotationPresent(Test.class)) {          // 该方法有 @Test 吗？
                Test t = m.getAnnotation(Test.class);          // 读出注解
                System.out.printf("运行 %s（描述: %s）... ", m.getName(), t.description());
                try {
                    m.invoke(new TestCases());                 // 反射调用
                    System.out.println("通过 ✓");
                } catch (Exception e) {
                    System.out.println("失败 ✗ " + e.getCause());
                }
            }
        }
    }
}

// ── 带字段和方法的枚举 ──────────────────────────────────
enum Planet {
    EARTH(5.976e24, 6.378e6),
    MARS(6.421e23, 3.397e6);

    private final double mass;     // 枚举可以有字段
    private final double radius;
    Planet(double mass, double radius) { this.mass = mass; this.radius = radius; } // 私有构造

    double surfaceGravity() {       // 枚举可以有方法
        final double G = 6.67300e-11;
        return G * mass / (radius * radius);
    }
}

// ── 每个常量各自实现抽象方法（常量特定行为）──────────────
enum Operation {
    PLUS  { @Override int apply(int a, int b) { return a + b; } },
    MINUS { @Override int apply(int a, int b) { return a - b; } },
    TIMES { @Override int apply(int a, int b) { return a * b; } };
    abstract int apply(int a, int b);   // 比一长串 switch 更面向对象
}

enum Day { MON, TUE, WED, THU, FRI, SAT, SUN }

// ── 自定义注解 ──────────────────────────────────────────
//   元注解决定注解"何时可见、能贴在哪"：
//   @Retention(RUNTIME)：保留到运行期，反射才读得到（SOURCE/CLASS 读不到）
//   @Target(METHOD)：只能贴在方法上
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
@interface Test {
    String description() default "";   // 注解元素，可带默认值
}

class TestCases {
    @Test(description = "加法应正确")
    public void testAdd() {
        if (1 + 1 != 2) throw new AssertionError("数学崩了");
    }
    @Test(description = "故意失败演示")
    public void testFail() {
        throw new AssertionError("预期 5 实际 4");
    }
    public void notATest() { /* 没有 @Test，不会被框架执行 */ }
}

/*
【枚举要点】
  - 枚举本质是继承 java.lang.Enum 的 final 类，每个常量是一个单例实例
  - 实现单例：用单元素枚举最安全（防反射、防序列化破坏），Effective Java 推荐
  - values() 返回所有常量数组，valueOf("NAME") 按名字反查，ordinal() 是序号
  - ⚠️ 别用 ordinal() 做持久化/业务逻辑（调整顺序就崩），要存就存 name() 或显式字段
  - 大量分支按枚举走时，优先"常量特定方法"而非 switch

【注解 + 反射 = 框架基石】
  @Retention 三档：
    SOURCE  —— 只在源码（如 @Override），编译后丢弃
    CLASS   —— 进 .class 文件，但运行期反射读不到（默认值）
    RUNTIME —— 运行期可反射读取（Spring @Component、JUnit @Test 都靠它）
  常见元注解：@Target（贴哪）、@Retention（活多久）、@Inherited（可被子类继承）、
             @Documented（进 Javadoc）、@Repeatable（同一处可重复贴）
  Spring/JPA/JUnit/Lombok 的"魔法"，本质都是：扫描类 → 反射读注解 → 据此生成/调用代码。
*/
