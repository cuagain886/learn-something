package dev.deepjava.jvm;

import java.util.ArrayList;
import java.util.List;

/**
 * JDK 21。产生可控分配压力供 GC 日志实验；不是生产负载模型。
 * young: 大量短命 8 KiB 数组并保留约 1%。
 * humongous: 反复创建 1 MiB 数组；是否为 humongous 取决于实际 G1 region size。
 */
public final class GcLogLab {
    private GcLogLab() { }

    public static void main(String[] args) {
        String mode = args.length == 0 ? "young" : args[0];
        long checksum = switch (mode) {
            case "young" -> youngPressure();
            case "humongous" -> humongousPressure();
            default -> throw new IllegalArgumentException("young | humongous");
        };
        System.out.println("mode=" + mode + ", checksum=" + checksum);
    }

    private static long youngPressure() {
        List<byte[]> retained = new ArrayList<>();
        long checksum = 0;
        for (int i = 0; i < 40_000; i++) {
            byte[] block = new byte[8 * 1024];
            block[0] = (byte) i;
            checksum += block[0];
            if (i % 100 == 0) {
                retained.add(block);
            }
        }
        return checksum + retained.size();
    }

    private static long humongousPressure() {
        long checksum = 0;
        for (int i = 0; i < 400; i++) {
            byte[] block = new byte[1024 * 1024];
            block[0] = (byte) i;
            checksum += block[0];
        }
        return checksum;
    }
}
