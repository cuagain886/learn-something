package dev.deepjava.concurrency;

import java.lang.management.ManagementFactory;
import java.lang.management.ThreadInfo;
import java.lang.management.ThreadMXBean;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** JDK 21。daemon 线程构造 monitor deadlock，由 ThreadMXBean 检测后主线程退出。 */
public final class DeadlockLab {
    private DeadlockLab() { }

    public static void main(String[] args) throws InterruptedException {
        Object left = new Object();
        Object right = new Object();
        CountDownLatch firstLocksHeld = new CountDownLatch(2);

        Thread a = daemon("deadlock-left", () -> lockInOrder(left, right, firstLocksHeld));
        Thread b = daemon("deadlock-right", () -> lockInOrder(right, left, firstLocksHeld));
        a.start();
        b.start();
        if (!firstLocksHeld.await(1, TimeUnit.SECONDS)) {
            throw new AssertionError("threads did not acquire first locks");
        }

        ThreadMXBean bean = ManagementFactory.getThreadMXBean();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        long[] ids = null;
        while (ids == null && System.nanoTime() < deadline) {
            ids = bean.findDeadlockedThreads();
            Thread.sleep(10);
        }
        if (ids == null || ids.length != 2) {
            throw new AssertionError("expected two-thread deadlock, found " + Arrays.toString(ids));
        }
        for (ThreadInfo info : bean.getThreadInfo(ids, true, true)) {
            System.out.println(info.getThreadName() + " waits on " + info.getLockName()
                    + " owned by " + info.getLockOwnerName());
        }
        System.out.println("deadlock detected; daemon workers allow the lab JVM to exit");
    }

    private static void lockInOrder(Object first, Object second, CountDownLatch barrier) {
        synchronized (first) {
            barrier.countDown();
            try {
                barrier.await();
            } catch (InterruptedException cancelled) {
                Thread.currentThread().interrupt();
                return;
            }
            synchronized (second) {
                throw new AssertionError("unreachable");
            }
        }
    }

    private static Thread daemon(String name, Runnable body) {
        return Thread.ofPlatform().daemon(true).name(name).unstarted(body);
    }
}
