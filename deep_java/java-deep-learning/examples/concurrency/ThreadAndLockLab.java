package dev.deepjava.concurrency;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.LockSupport;

/** JDK 21。验证 start/join、中断与 LockSupport 单 permit 语义。 */
public final class ThreadAndLockLab {
    private ThreadAndLockLab() { }

    public static void main(String[] args) throws InterruptedException {
        CountDownLatch started = new CountDownLatch(1);
        Thread worker = Thread.ofPlatform().name("interruptible-worker").start(() -> {
            started.countDown();
            try {
                Thread.sleep(60_000);
                throw new AssertionError("sleep should be interrupted");
            } catch (InterruptedException expected) {
                // sleep clears the status when throwing; restore it when this layer consumes the exception.
                Thread.currentThread().interrupt();
            }
        });
        if (!started.await(1, TimeUnit.SECONDS)) {
            throw new AssertionError("worker did not start");
        }
        worker.interrupt();
        worker.join(1_000);
        assert !worker.isAlive();

        CountDownLatch beforePark = new CountDownLatch(1);
        Thread parked = Thread.ofPlatform().unstarted(() -> {
            beforePark.countDown();
            LockSupport.park();
            if (Thread.interrupted()) {
                throw new AssertionError("unpark is not interrupt");
            }
        });
        parked.start();
        if (!beforePark.await(1, TimeUnit.SECONDS)) {
            throw new AssertionError("parked worker did not start");
        }
        LockSupport.unpark(parked); // permit may be issued after start but before park executes
        parked.join(1_000);
        if (parked.isAlive()) {
            parked.interrupt();
            throw new AssertionError("unpark permit was not consumed");
        }
        System.out.println("thread start/join, interrupt and park permit verified");
    }
}
