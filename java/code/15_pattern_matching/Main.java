/*
═══════════════════════════════════════════════════════════════════
 15_pattern_matching —— 模式匹配（Java 21 全面定稿）
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. instanceof 模式：判断 + 绑定变量一步到位
  2. switch 模式匹配：按类型分支 + 守卫 when
  3. ⭐ record 解构（record pattern）：直接拆出字段，可嵌套
  4. null 处理、穷尽性

【运行】java 15_pattern_matching/Main.java
（这是 Java 近年最重要的演进之一，配合第13/14课威力倍增）
*/

public class Main {
    sealed interface Json permits JsonNull, JsonBool, JsonNum, JsonStr, JsonArr {}
    record JsonNull() implements Json {}
    record JsonBool(boolean value) implements Json {}
    record JsonNum(double value) implements Json {}
    record JsonStr(String value) implements Json {}
    record JsonArr(java.util.List<Json> items) implements Json {}

    public static void main(String[] args) {
        // ── 1. instanceof 模式：判断即绑定 ─────────────────
        Object obj = "hello world";
        // 旧写法：先 instanceof，再强转，再用 —— 啰嗦
        //   if (obj instanceof String) { String s = (String) obj; ... }
        // 新写法：instanceof 通过的同时把变量绑定到 s
        if (obj instanceof String s && s.length() > 5) {   // s 在 && 右边就能用
            System.out.println("是长字符串: " + s.toUpperCase());
        }

        // ── 2. switch 模式匹配 + 守卫 when ─────────────────
        Object[] values = { 42, "text", 3.14, true, java.util.List.of(1, 2) };
        for (Object v : values) {
            String desc = switch (v) {
                case Integer i when i > 40 -> "大整数 " + i;   // when 守卫：附加条件
                case Integer i             -> "整数 " + i;
                case String str            -> "字符串(长度 " + str.length() + ")";
                case Double d              -> "浮点 " + d;
                case Boolean b             -> "布尔 " + b;
                default                    -> "其他: " + v;
            };
            System.out.println(desc);
        }

        // ── 3. ⭐ record 解构：直接拆字段，还能嵌套 ────────
        Object point = new Point(3, 4);
        String result = switch (point) {
            // 不只匹配类型，还把 x、y 直接解构出来
            case Point(int x, int y) when x == y -> "对角线上的点 " + x;
            case Point(int x, int y)             -> "点(" + x + "," + y + ")，距原点 "
                                                    + Math.sqrt(x * x + y * y);
            default -> "未知";
        };
        System.out.println(result);

        // 嵌套解构：一层层拆开
        Object line = new Line(new Point(0, 0), new Point(3, 4));
        if (line instanceof Line(Point(var x1, var y1), Point(var x2, var y2))) {
            System.out.printf("线段从(%d,%d)到(%d,%d)%n", x1, y1, x2, y2);
        }

        // ── 4. 与 sealed 配合：穷尽匹配，无需 default ───────
        Json[] jsons = {
                new JsonNull(), new JsonBool(true),
                new JsonNum(2.5), new JsonStr("hi"),
                new JsonArr(java.util.List.of(new JsonNum(1), new JsonStr("x")))
        };
        for (Json j : jsons) System.out.println("渲染: " + render(j));

        // ── 5. null 的处理 ─────────────────────────────────
        // Java 21 起，switch 可以显式 case null（旧 switch 遇 null 直接 NPE）
        System.out.println(matchNullable(null));
        System.out.println(matchNullable("x"));
    }

    // sealed + record + switch：编译器保证覆盖了所有 Json 子类型
    static String render(Json j) {
        return switch (j) {
            case JsonNull() -> "null";
            case JsonBool(boolean b) -> String.valueOf(b);
            case JsonNum(double n) -> String.valueOf(n);
            case JsonStr(String s) -> "\"" + s + "\"";
            case JsonArr(var items) -> {
                var sb = new StringBuilder("[");
                for (int i = 0; i < items.size(); i++) {
                    if (i > 0) sb.append(",");
                    sb.append(render(items.get(i)));   // 递归
                }
                yield sb.append("]").toString();       // 块分支用 yield 返回
            }
            // 没有 default：新增一种 Json 子类型时，这里会编译报错提醒你补全
        };
    }

    static String matchNullable(Object o) {
        return switch (o) {
            case null      -> "是 null";          // 显式处理 null
            case String s  -> "字符串 " + s;
            default        -> "其他";
        };
    }

    record Point(int x, int y) {}
    record Line(Point a, Point b) {}
}

/*
【模式匹配的演进时间线】
  Java 16：instanceof 模式（判断+绑定）正式
  Java 21：switch 模式匹配 + record 解构（record pattern）正式 ⭐
           switch 支持 case null、when 守卫、穷尽性检查
  → 这套组合（sealed + record + switch pattern）让 Java 拥有了
    现代函数式语言的"代数数据类型 + 模式匹配"表达力。

【三类模式】
  1. 类型模式 type pattern：  case String s        （匹配类型并绑定）
  2. record 模式 record pattern: case Point(int x, int y)（解构组件，可嵌套）
  3. （未来）还会有更多，如数组模式

【守卫 when】
  case Integer i when i > 40 -> ...
  在类型匹配之上叠加布尔条件；不满足则继续往下匹配其他 case。

【穷尽性（exhaustiveness）—— 为什么这么重要】
  对 sealed 类型做 switch，覆盖全部子类后【不需要 default】。
  价值：将来给 sealed 体系新增一个子类，所有"忘了处理新类型"的 switch
       会在【编译期】报错，而不是运行期默默走错分支。
  这把"加一种情况要改哪些地方"的问题，从靠人记变成靠编译器查。

【对比旧风格】
  旧：if-instanceof-强转 阶梯 / switch 只能匹配常量(int/枚举/String)
  新：一个 switch 按"形状"分发，判断+解构+条件一气呵成，可读性和安全性双赢
*/
