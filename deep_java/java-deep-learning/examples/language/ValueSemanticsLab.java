package dev.deepjava.language;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;

/**
 * JDK 21。验证参数值传递、包装缓存、浮点语义与 String 编码边界。
 * 运行：javac -d out ValueSemanticsLab.java && java -ea -cp out dev.deepjava.language.ValueSemanticsLab
 */
public final class ValueSemanticsLab {
    private ValueSemanticsLab() {
    }

    static final class Box {
        private int value;

        Box(int value) {
            this.value = value;
        }

        @Override
        public String toString() {
            return "Box[" + value + "]";
        }
    }

    static void mutate(Box copyOfReference) {
        copyOfReference.value++;
    }

    static void replace(Box copyOfReference) {
        copyOfReference = new Box(999);
        // 只替换当前栈帧里的局部变量槽位；调用者的槽位没有被写入。
        assert copyOfReference.value == 999;
    }

    static void swap(Box left, Box right) {
        Box temporary = left;
        left = right;
        right = temporary;
        assert left != right;
    }

    public static void main(String[] args) {
        Box first = new Box(1);
        Box second = new Box(2);
        mutate(first);
        replace(first);
        swap(first, second);
        assert first.value == 2 : "对象状态可变，但调用者变量未被替换";
        assert second.value == 2 : "swap 只交换了引用值的两个副本";

        Integer cachedA = 127;
        Integer cachedB = 127;
        Integer uncachedA = 128;
        Integer uncachedB = 128;
        assert cachedA == cachedB;
        assert uncachedA != uncachedB;
        assert uncachedA.equals(uncachedB);

        double computed = 0.1d + 0.2d;
        assert computed != 0.3d;
        assert new BigDecimal("0.1").add(new BigDecimal("0.2"))
                .compareTo(new BigDecimal("0.3")) == 0;

        String emoji = "A\uD83D\uDE00";
        assert emoji.length() == 3 : "length 统计 UTF-16 code unit";
        assert emoji.codePointCount(0, emoji.length()) == 2;
        byte[] utf8 = emoji.getBytes(StandardCharsets.UTF_8);
        assert utf8.length == 5 : "ASCII 1 byte + emoji 4 bytes";

        System.out.println("value semantics verified: " + first + ", utf8Bytes=" + utf8.length);
    }
}
