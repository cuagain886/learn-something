/*
═══════════════════════════════════════════════════════════════════
 04_exceptions —— 异常处理进阶
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. 异常体系：Throwable → Error / Exception → 受检 vs 非受检(RuntimeException)
  2. try-with-resources 自动关闭资源（AutoCloseable）
  3. 多重捕获 multi-catch、异常链（cause）、被抑制异常 suppressed
  4. 自定义异常的设计、finally 的陷阱
  5. Java 14+：更友好的 NullPointerException 提示信息

【运行】java 04_exceptions/Main.java
*/

import java.io.IOException;

public class Main {
    public static void main(String[] args) {
        // ── 1. 受检 vs 非受检 ──────────────────────────────
        // 受检异常(checked)：编译器强制你 try 或 throws，如 IOException
        // 非受检异常(unchecked = RuntimeException)：编译器不强制，如 NPE/IllegalArgument
        try {
            readConfig(true);
        } catch (IOException e) {              // 受检异常必须处理
            System.out.println("捕获受检异常: " + e.getMessage());
        }
        try {
            validateAge(-5);                    // 抛非受检异常，不强制 catch
        } catch (IllegalArgumentException e) {
            System.out.println("捕获非受检异常: " + e.getMessage());
        }

        // ── 2. try-with-resources：自动关闭，且关闭顺序与声明相反 ──
        try (var a = new Resource("A"); var b = new Resource("B")) {
            a.use(); b.use();
            // 离开 try 块时自动调用 close()，顺序：先 B 后 A（后开的先关）
        }

        // ── 3. 多重捕获 + 异常链 ───────────────────────────
        try {
            doRisky();
        } catch (IllegalStateException | NumberFormatException e) {  // 一次抓多种
            System.out.println("multi-catch: " + e.getClass().getSimpleName());
        } catch (RuntimeException e) {
            // 异常链：打印根因，排查问题靠它
            System.out.println("包装异常: " + e.getMessage()
                    + " ← 根因: " + e.getCause());
        }

        // ── 4. 被抑制异常 suppressed ───────────────────────
        // try 体抛异常 + close() 也抛异常时，close 的异常被"抑制"，不丢失
        try (var bad = new FailingResource()) {
            throw new RuntimeException("业务异常");
        } catch (RuntimeException e) {
            System.out.println("主异常: " + e.getMessage());
            for (Throwable s : e.getSuppressed()) {
                System.out.println("  被抑制: " + s.getMessage()); // close() 的异常在此
            }
        }

        // ── 5. finally 的返回值陷阱 ────────────────────────
        System.out.println("finally 覆盖返回值: " + trap()); // 返回 2 而非 1！

        // ── 6. Java 14+ Helpful NullPointerException ───────
        try {
            String s = null;
            s.length();   // 旧版只说"NPE"，新版会告诉你"哪个变量是 null"
        } catch (NullPointerException e) {
            System.out.println("NPE 详情: " + e.getMessage());
        }
    }

    // 受检异常：方法签名用 throws 声明，调用方必须处理
    static void readConfig(boolean fail) throws IOException {
        if (fail) throw new IOException("配置文件读取失败");
    }

    // 非受检异常：参数校验的标准做法
    static void validateAge(int age) {
        if (age < 0) throw new IllegalArgumentException("年龄不能为负: " + age);
    }

    static void doRisky() {
        try {
            Integer.parseInt("not a number");        // 抛 NumberFormatException
        } catch (NumberFormatException e) {
            // 包装成业务异常并保留根因（异常链）—— 排错关键习惯
            throw new RuntimeException("解析配置项失败", e);
        }
    }

    // finally 里 return 会【覆盖】try 里的 return（强烈不推荐这样写）
    @SuppressWarnings("finally")
    static int trap() {
        try { return 1; }
        finally { return 2; }   // ⚠️ 吞掉了 try 的返回值，也会吞掉异常
    }
}

// AutoCloseable：能用于 try-with-resources
class Resource implements AutoCloseable {
    private final String name;
    Resource(String name) { this.name = name; System.out.println("打开 " + name); }
    void use() { System.out.println("使用 " + name); }
    @Override public void close() { System.out.println("关闭 " + name); } // 自动调用
}

class FailingResource implements AutoCloseable {
    @Override public void close() { throw new IllegalStateException("关闭时出错"); }
}

/*
【异常体系全景】
  Throwable
  ├── Error               —— JVM 级严重错误，别 catch（OutOfMemoryError、StackOverflowError）
  └── Exception
      ├── RuntimeException —— 非受检：编程错误，靠改代码避免（NPE、IndexOOB、IllegalArgument）
      │                       不强制 try/throws
      └── 其他 Exception   —— 受检：外部不可控（IOException、SQLException）
                              编译器强制 try 或 throws

【最佳实践（Effective Java 第9–12章精华）】
  1. 优先用标准异常（IllegalArgument/IllegalState/NullPointer/IndexOutOfBounds）
  2. 受检异常用于"调用方能恢复"的场景；否则用非受检
  3. 包装底层异常时务必传 cause（new XxxException(msg, e)），别丢根因
  4. 关闭资源永远用 try-with-resources，不要手写 finally close（容易吞异常）
  5. 不要捕获了异常却什么都不做（空 catch 块）——至少记日志
  6. 不要用异常做流程控制（性能差、可读性差）
  7. finally 里不要 return / throw（会吞掉 try 的结果和异常）
*/
