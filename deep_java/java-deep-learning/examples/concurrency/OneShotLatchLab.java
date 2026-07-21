package dev.deepjava.concurrency;

import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.AbstractQueuedSynchronizer;

/** JDK 21。用 AQS shared mode 实现只开一次的门。 */
public final class OneShotLatchLab {
    static final class OneShotLatch {
        private final Sync sync = new Sync();

        void await() throws InterruptedException { sync.acquireSharedInterruptibly(1); }
        boolean await(long timeout, TimeUnit unit) throws InterruptedException {
            return sync.tryAcquireSharedNanos(1, unit.toNanos(timeout));
        }
        void open() { sync.releaseShared(1); }
        boolean isOpen() { return sync.getStateValue() == 1; }

        private static final class Sync extends AbstractQueuedSynchronizer {
            @Override protected int tryAcquireShared(int ignored) {
                return getState() == 1 ? 1 : -1;
            }
            @Override protected boolean tryReleaseShared(int ignored) {
                return compareAndSetState(0, 1);
            }
            int getStateValue() { return getState(); }
        }
    }

    private OneShotLatchLab() { }

    public static void main(String[] args) throws InterruptedException {
        OneShotLatch latch = new OneShotLatch();
        assert !latch.await(20, TimeUnit.MILLISECONDS);
        Thread opener = Thread.ofPlatform().start(latch::open);
        latch.await();
        opener.join();
        assert latch.isOpen();
        assert latch.await(1, TimeUnit.MILLISECONDS);
        latch.open(); // idempotent: second release does not close or block
        System.out.println("AQS one-shot shared latch verified");
    }
}
