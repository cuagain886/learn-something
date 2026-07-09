package calc;

import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.*;

/*
 JUnit 5 示例测试。展示：生命周期注解、基本断言、异常断言、
 assertAll 聚合、参数化测试、嵌套测试。
 运行：在 20_testing/ 下执行  mvn test
*/
@DisplayName("Calculator 单元测试")
class CalculatorTest {

    Calculator calc;

    @BeforeAll
    static void beforeAll() {
        System.out.println("整个测试类开始（只执行一次）");
    }

    @BeforeEach
    void setUp() {
        // 每个 @Test 前都新建一个全新实例 → 测试之间互相独立（Independent）
        calc = new Calculator();
    }

    // ── 基本断言 ────────────────────────────────────────
    @Test
    @DisplayName("加法：2 + 3 = 5")
    void add() {
        assertEquals(5, calc.add(2, 3));
    }

    // ── assertAll：一次性报告多个断言（而非第一个失败就停）──
    @Test
    @DisplayName("四则运算一组校验")
    void arithmetic() {
        assertAll("四则",
                () -> assertEquals(1, calc.subtract(4, 3)),
                () -> assertEquals(12, calc.multiply(3, 4)),
                () -> assertEquals(2, calc.divide(8, 4)));
    }

    // ── 异常断言：验证"该抛异常时确实抛了，且类型/消息正确" ──
    @Test
    @DisplayName("除以 0 抛 IllegalArgumentException")
    void divideByZero() {
        IllegalArgumentException ex = assertThrows(
                IllegalArgumentException.class,
                () -> calc.divide(10, 0));
        assertEquals("除数不能为 0", ex.getMessage());
    }

    // ── 参数化测试：一个方法跑多组数据，避免复制粘贴 ──────
    @ParameterizedTest(name = "{0} 是素数")
    @ValueSource(ints = {2, 3, 5, 7, 11, 13})
    void primes(int n) {
        assertTrue(calc.isPrime(n));
    }

    @ParameterizedTest(name = "{0} 不是素数")
    @ValueSource(ints = {0, 1, 4, 9, 100})
    void notPrimes(int n) {
        assertFalse(calc.isPrime(n));
    }

    // CsvSource：每行是一组 (输入..., 期望)
    @ParameterizedTest(name = "{0} + {1} = {2}")
    @CsvSource({"1, 1, 2", "2, 3, 5", "-1, 1, 0", "100, 200, 300"})
    void addParameterized(int a, int b, int expected) {
        assertEquals(expected, calc.add(a, b));
    }

    // ── 嵌套测试：把相关用例分组，结构更清晰 ─────────────
    @Nested
    @DisplayName("边界情况")
    class EdgeCases {
        @Test
        void negativeIsNotPrime() {
            assertFalse(calc.isPrime(-7));
        }

        @Test
        @Disabled("演示：临时跳过的测试")
        void notYetImplemented() {
            fail("还没写");
        }
    }
}
