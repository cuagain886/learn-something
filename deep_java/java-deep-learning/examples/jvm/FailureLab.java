package dev.deepjava.jvm;

import java.lang.reflect.Proxy;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;

/**
 * JDK 21。只允许显式选择故障模式；务必在独立 JVM、很小的资源上限下运行。
 * 示例：java -Xmx32m -cp out dev.deepjava.jvm.FailureLab heap
 */
public final class FailureLab {
    private static int depth;

    private FailureLab() {
    }

    public static void main(String[] args) {
        if (args.length != 1) {
            throw new IllegalArgumentException("choose one: stack | heap | direct | metaspace | native-thread");
        }
        switch (args[0]) {
            case "stack" -> overflowStack();
            case "heap" -> exhaustHeap();
            case "direct" -> exhaustDirectMemory();
            case "metaspace" -> exhaustMetaspace();
            case "native-thread" -> exhaustNativeThreads();
            default -> throw new IllegalArgumentException("unknown mode: " + args[0]);
        }
    }

    static void overflowStack() {
        depth++;
        overflowStack();
    }

    static void exhaustHeap() {
        List<byte[]> retained = new ArrayList<>();
        while (true) {
            retained.add(new byte[1024 * 1024]);
        }
    }

    static void exhaustDirectMemory() {
        List<ByteBuffer> retained = new ArrayList<>();
        while (true) {
            retained.add(ByteBuffer.allocateDirect(1024 * 1024));
        }
    }

    static void exhaustMetaspace() {
        List<Object> retainedProxies = new ArrayList<>();
        while (true) {
            ClassLoader loader = new ClassLoader(FailureLab.class.getClassLoader()) { };
            Object proxy = Proxy.newProxyInstance(
                    loader,
                    new Class<?>[] { Runnable.class },
                    (instance, method, arguments) -> null);
            retainedProxies.add(proxy);
        }
    }

    static void exhaustNativeThreads() {
        if (!Boolean.getBoolean("deepjava.allowNativeThreadExhaustion")) {
            throw new IllegalStateException(
                    "refusing dangerous experiment; use an isolated container with pids/memory limits "
                            + "and -Ddeepjava.allowNativeThreadExhaustion=true");
        }
        List<Thread> retained = new ArrayList<>();
        while (true) {
            Thread thread = Thread.ofPlatform().unstarted(() -> {
                try {
                    Thread.sleep(Long.MAX_VALUE);
                } catch (InterruptedException cancelled) {
                    Thread.currentThread().interrupt();
                }
            });
            thread.start();
            retained.add(thread);
        }
    }
}
