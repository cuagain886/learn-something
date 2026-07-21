package dev.deepjava.concurrency;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** JDK 21。演示 volatile 发布与中断传播；反例的失败不是每次运行都能复现。 */
public final class PublicationLab {
    static final class BrokenMessage {
        int payload;
        boolean ready;
    }

    static final class SafeMessage {
        int payload;
        volatile boolean ready;
    }

    private PublicationLab() {
    }

    static int safePublication() throws InterruptedException {
        SafeMessage message = new SafeMessage();
        CountDownLatch started = new CountDownLatch(1);
        Thread reader = Thread.ofPlatform().start(() -> {
            started.countDown();
            while (!message.ready) {
                Thread.onSpinWait();
            }
            if (message.payload != 42) {
                throw new AssertionError("volatile acquire must observe prior payload write");
            }
        });
        if (!started.await(1, TimeUnit.SECONDS)) {
            throw new IllegalStateException("reader did not start");
        }
        message.payload = 42;
        message.ready = true;
        reader.join(1_000);
        if (reader.isAlive()) {
            reader.interrupt();
            throw new IllegalStateException("reader did not terminate");
        }
        return message.payload;
    }

    static void interruptibleWorker() throws InterruptedException {
        Thread worker = Thread.ofPlatform().start(() -> {
            try {
                Thread.sleep(60_000);
            } catch (InterruptedException cancelled) {
                Thread.currentThread().interrupt();
            }
        });
        worker.interrupt();
        worker.join(1_000);
        if (worker.isAlive()) {
            throw new IllegalStateException("worker ignored cancellation");
        }
    }

    public static void main(String[] args) throws InterruptedException {
        assert safePublication() == 42;
        interruptibleWorker();
        System.out.println("safe publication and cancellation verified");
    }
}
