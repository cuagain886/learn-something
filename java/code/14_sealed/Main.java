/*
═══════════════════════════════════════════════════════════════════
 14_sealed —— Sealed 密封类/接口（Java 17 正式）
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. sealed + permits：精确控制"谁能继承/实现我"
  2. 子类三选一：final / sealed / non-sealed
  3. 密封类 + record = 代数数据类型（ADT），配合 switch 穷尽匹配
  4. 为什么需要它：在"开放继承"和"完全 final"之间的第三条路

【运行】java 14_sealed/Main.java
*/

public class Main {
    public static void main(String[] args) {
        Shape[] shapes = {
                new Circle(2.0),
                new Rectangle(3.0, 4.0),
                new Triangle(3.0, 4.0)
        };
        for (Shape s : shapes) {
            System.out.printf("%-20s 面积=%.2f%n", s, area(s));
        }

        // 表达式：编译器知道 Shape 的子类"就这三种"，switch 可穷尽
        for (Shape s : shapes) System.out.println(describe(s));
    }

    // ⭐ 因为 Shape 是 sealed，编译器确信子类只有这三种，
    //   switch 覆盖全部后【不需要 default】，且将来若新增子类、忘了处理 → 编译报错
    static double area(Shape s) {
        return switch (s) {                       // switch 模式匹配（第15课详讲）
            case Circle c    -> Math.PI * c.radius() * c.radius();
            case Rectangle r -> r.w() * r.h();
            case Triangle t  -> 0.5 * t.base() * t.height();
            // 没有 default！漏掉任一种都编译不过 —— 这就是穷尽性的价值
        };
    }

    static String describe(Shape s) {
        // record 解构 + sealed 穷尽
        return switch (s) {
            case Circle(double r)        -> "圆，半径 " + r;
            case Rectangle(double w, double h) -> "矩形 " + w + "×" + h;
            case Triangle(double b, double h)  -> "三角形，底 " + b;
        };
    }
}

// ── 密封接口：只允许这三个类型实现 ──────────────────────
sealed interface Shape permits Circle, Rectangle, Triangle {}

// 子类必须明确"封闭策略"，三选一：
//   final     —— 到此为止，不能再被继承（最常见）
//   sealed    —— 继续密封，自己也要 permits
//   non-sealed—— 重新开放，任何人可继承（打破密封链）
record Circle(double radius) implements Shape {}        // record 隐式 final，天然满足
record Rectangle(double w, double h) implements Shape {}
record Triangle(double base, double height) implements Shape {}

/*
【sealed 解决什么问题】
  传统继承的两极：
    - public class（开放）：任何人可继承，你无法预知所有子类 → switch 必须留 default
    - final class（封闭）：完全不能继承
  sealed 是中间态："我明确允许这几个继承我，别人不行"。
  好处：
    1. 作者掌控类型层级，子类集合是【已知且封闭】的
    2. 编译器能做【穷尽性检查】：switch 覆盖全部子类即可省略 default；
       将来新增一个子类，所有未更新的 switch 立刻编译报错 → 不会漏处理

【三种子类策略】
  sealed interface Expr permits Num, Add, Mul {}
    final class Num ...        // 封死
    sealed class Add permits ... // 继续受控分支
    non-sealed class Mul ...   // 重新开放（谨慎使用，会丢掉穷尽性保证）

【规则】
  - permits 列出的子类必须和密封类在【同一模块/同一包】，且确实直接继承它
  - 若子类和父类在同一文件，permits 可省略（编译器自动推断），如本例其实可不写
  - record 自动是 final，是 sealed 体系里最常用的"叶子"

【sealed + record = 代数数据类型(ADT)】
  这套组合让 Java 拥有了函数式语言（如 Scala/Rust/Haskell）的能力：
  用"封闭的类型集合 + 模式匹配"建模数据，编译器保证你处理了每种情况。
  典型场景：表达式树、状态机、解析结果（成功/失败）、AST。
  下一课（15）的模式匹配会把这套组合的威力完全展现出来。
*/
