package dev.deepjava.concurrency;

/**
 * JDK 21 version-specific experiment.
 * Run with: java -Djdk.tracePinnedThreads=full ... VirtualThreadPinningLab
 * JDK 24 JEP 491 changes synchronized pinning behavior; do not expect identical output there.
 */
public final class VirtualThreadPinningLab {
    private static final Object MONITOR = new Object();
    private VirtualThreadPinningLab() { }

    public static void main(String[] args) throws InterruptedException {
        Thread virtual = Thread.startVirtualThread(() -> {
            synchronized (MONITOR) {
                try {
                    Thread.sleep(100);
                } catch (InterruptedException cancelled) {
                    Thread.currentThread().interrupt();
                }
            }
        });
        virtual.join();
        System.out.println("pinning probe completed; inspect trace for this exact JDK");
    }
}
