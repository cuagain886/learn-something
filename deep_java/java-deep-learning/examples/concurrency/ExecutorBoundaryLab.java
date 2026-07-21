package dev.deepjava.concurrency;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.Semaphore;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** JDK 21。验证有界平台线程池拒绝、取消，以及虚拟线程仍需下游并发限制。 */
public final class ExecutorBoundaryLab {
    private ExecutorBoundaryLab() { }

    public static void main(String[] args) throws Exception {
        boundedPlatformPool();
        boundedVirtualConcurrency();
        System.out.println("executor boundaries and cancellation verified");
    }

    private static void boundedPlatformPool() throws Exception {
        ThreadPoolExecutor pool = new ThreadPoolExecutor(
                2, 2, 0, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(2),
                new ThreadPoolExecutor.AbortPolicy());
        CountDownLatch release = new CountDownLatch(1);
        List<Future<?>> accepted = new ArrayList<>();
        try {
            for (int i = 0; i < 4; i++) {
                accepted.add(pool.submit(() -> {
                    try { release.await(); }
                    catch (InterruptedException cancelled) { Thread.currentThread().interrupt(); }
                }));
            }
            try {
                pool.submit(() -> { });
                throw new AssertionError("fifth task must be rejected: 2 workers + queue capacity 2");
            } catch (RejectedExecutionException expected) {
                // Admission is explicit instead of silently building an unbounded queue.
            }
        } finally {
            for (Future<?> future : accepted) future.cancel(true);
            release.countDown();
            pool.shutdownNow();
            if (!pool.awaitTermination(1, TimeUnit.SECONDS)) {
                throw new AssertionError("pool did not terminate");
            }
        }
    }

    private static void boundedVirtualConcurrency() throws Exception {
        Semaphore downstream = new Semaphore(3);
        AtomicInteger active = new AtomicInteger();
        AtomicInteger maximum = new AtomicInteger();
        try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Future<?>> futures = new ArrayList<>();
            for (int i = 0; i < 30; i++) {
                futures.add(executor.submit(() -> {
                    if (!downstream.tryAcquire(1, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("downstream admission timed out");
                    }
                    try {
                        int now = active.incrementAndGet();
                        maximum.accumulateAndGet(now, Math::max);
                        Thread.sleep(10);
                    } finally {
                        active.decrementAndGet();
                        downstream.release();
                    }
                    return null;
                }));
            }
            for (Future<?> future : futures) future.get(2, TimeUnit.SECONDS);
        }
        assert maximum.get() <= 3 : maximum;
    }
}
