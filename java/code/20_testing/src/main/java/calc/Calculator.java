package calc;

/** 被测对象：一个简单的计算器。注意 divide 对除零会抛异常，测试里会验证这一点。 */
public class Calculator {

    public int add(int a, int b) {
        return a + b;
    }

    public int subtract(int a, int b) {
        return a - b;
    }

    public int multiply(int a, int b) {
        return a * b;
    }

    /** 整数相除；除数为 0 时抛 IllegalArgumentException（而非让 JVM 抛 ArithmeticException）。 */
    public int divide(int a, int b) {
        if (b == 0) {
            throw new IllegalArgumentException("除数不能为 0");
        }
        return a / b;
    }

    public boolean isPrime(int n) {
        if (n < 2) return false;
        for (int i = 2; (long) i * i <= n; i++) {
            if (n % i == 0) return false;
        }
        return true;
    }
}
