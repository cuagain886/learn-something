/*
═══════════════════════════════════════════════════════════════════
 16_text_block_switch —— 文本块 与 switch 表达式
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. 文本块 """ ... """（Java 15 正式）：多行字符串不再拼接地狱
  2. switch 表达式 ->（Java 14 正式）：有返回值、不穿透、必须穷尽
  3. switch 表达式 vs 传统 switch 语句的区别
  4. yield 在块分支中返回值

【运行】java 16_text_block_switch/Main.java
*/

public class Main {
    public static void main(String[] args) {
        // ── 1. 文本块：多行字符串 ──────────────────────────
        // 旧写法：满屏 \n 和 + 拼接，难读易错
        String oldJson = "{\n" +
                "  \"name\": \"Alice\",\n" +
                "  \"age\": 30\n" +
                "}";
        // 新写法：所见即所得，三引号包裹
        String json = """
                {
                  "name": "Alice",
                  "age": 30
                }""";                       // 结尾 """ 的位置决定缩进基准
        System.out.println("文本块 JSON:\n" + json);
        System.out.println("两种写法相等? " + oldJson.equals(json));

        // 文本块里引号不用转义，天然适合 SQL / HTML / JSON
        String sql = """
                SELECT id, name, email
                FROM users
                WHERE age > 18
                  AND status = 'active'
                ORDER BY name""";
        System.out.println("\nSQL:\n" + sql);

        // 行尾 \ 表示"不换行"（拼接续行）；\s 保留尾部空格
        String oneLine = """
                这是一段 \
                连续的文本""";
        System.out.println("\n续行: " + oneLine);

        // ── 2. switch 表达式：有返回值 ─────────────────────
        for (int day = 1; day <= 7; day++) {
            // -> 分支：不穿透、不用 break、可直接作为表达式赋值
            String type = switch (day) {
                case 1, 2, 3, 4, 5 -> "工作日";   // 多个标签用逗号，无需 fall-through
                case 6, 7          -> "周末";
                default            -> "非法";
            };
            System.out.print(day + ":" + type + "  ");
        }
        System.out.println();

        // ── 3. 块分支用 yield 返回 ─────────────────────────
        int month = 4;
        int days = switch (month) {
            case 1, 3, 5, 7, 8, 10, 12 -> 31;
            case 4, 6, 9, 11           -> 30;
            case 2 -> {
                int year = 2024;
                boolean leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
                yield leap ? 29 : 28;        // 块里必须用 yield 给出"这个分支的值"
            }
            default -> throw new IllegalArgumentException("非法月份");
        };
        System.out.println(month + " 月有 " + days + " 天");

        // ── 4. 传统 switch 语句的穿透陷阱（对比）───────────
        System.out.println("--- 传统 switch 的 fall-through ---");
        traditionalSwitch(2);       // 故意漏 break 会"穿透"到下个 case

        // ── 5. switch 表达式必须穷尽 ───────────────────────
        Color c = Color.GREEN;
        String hex = switch (c) {                 // 枚举全覆盖，无需 default
            case RED   -> "#FF0000";
            case GREEN -> "#00FF00";
            case BLUE  -> "#0000FF";
        };
        System.out.println("颜色 " + c + " = " + hex);
    }

    enum Color { RED, GREEN, BLUE }

    // 传统 switch 语句：忘记 break 就穿透（历史包袱，新代码尽量用表达式）
    static void traditionalSwitch(int x) {
        switch (x) {
            case 1:
                System.out.println("一");
                // 没 break，继续往下穿透 ↓
            case 2:
                System.out.println("二");
                // 又没 break ↓
            case 3:
                System.out.println("三");
                break;        // 这里才停
            default:
                System.out.println("默认");
        }
    }
}

/*
【文本块要点】
  - 用 """ 开头（后面必须换行），""" 结尾
  - 缩进：编译器按"所有行的最小公共缩进 + 结尾 """ 的位置"去掉前导空白
    （这叫 incidental whitespace stripping），所以结尾 """ 放哪很关键
  - 内部双引号无需转义；想要尾随空格用 \s；想拼接不换行用行尾 \
  - 适合：JSON、SQL、HTML、多行文案。本质仍是普通 String，无运行期开销

【switch 表达式 vs 语句】
  表达式（->，Java 14+）        语句（:，传统）
  ───────────────────────      ──────────────────
  有返回值，可赋值/return       无返回值
  不穿透，无需 break            默认穿透，要手动 break
  多标签用逗号 case 1,2,3       要写多个 case 叠着
  对枚举/sealed 必须穷尽        无强制
  块分支用 yield 返回值         用 break

  建议：新代码一律用 -> 表达式形式，避免 fall-through 这个经典 bug 源。
  switch 表达式 + 模式匹配（第15课）是现代 Java 控制流的核心。
*/
