/*
═══════════════════════════════════════════════════════════════════
 12_concurrent_utils —— java.util.concurrent 并发工具包
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. 线程池 ExecutorService —— 别再手动 new Thread
  2. Future / CompletableFuture —— 异步结果与编排
  3. Lock / ReentrantLock vs synchronized
  4. 原子类 AtomicInteger、并发集合 ConcurrentHashMap
  5. 同步器 CountDownLatch

【运行】java 12_concurrent_utils/Main.java
（线程池原理见 ../knowledge/08，AQS 见 ../knowledge/09）
*/

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.ReentrantLock;

public class Main {
    public static void main(String[] args) throws Exception {
        // ── 1. 线程池：提交任务，复用线程 ──────────────────
        // 实际生产建议用 ThreadPoolExecutor 显式配置参数（见 knowledge/08），
        // 这里用工厂方法演示。固定 4 个线程。
        try (ExecutorService pool = Executors.newFixedThreadPool(4)) {  // Java 19+ 可 try-with-resources
            // submit 返回 Future：代表"将来才有的结果"
            Future<Integer> future = pool.submit(() -> { Thread.sleep(50); return 42; });
            System.out.println("任务结果: " + future.get());          // get 阻塞直到完成

            // invokeAll：批量提交并等全部完成
            List<Callable<Integer>> tasks = List.of(
                    () -> 1, () -> 2, () -> 3);
            int sum = 0;
            for (Future<Integer> f : pool.invokeAll(tasks)) sum += f.get();
            System.out.println("批量结果之和: " + sum);
        } // try-with-resources 自动 shutdown + 等待任务结束

        // ── 2. CompletableFuture：异步编排（不阻塞地组合）──
        CompletableFuture<String> cf = CompletableFuture
                .supplyAsync(() -> "user-42")               // 异步取数据
                .thenApply(id -> "Profile of " + id)        // 拿到后转换（仍异步）
                .thenApply(String::toUpperCase);
        System.out.println("CompletableFuture: " + cf.get());

        // 组合两个独立异步任务
        CompletableFuture<Integer> a = CompletableFuture.supplyAsync(() -> slow(10));
        CompletableFuture<Integer> b = CompletableFuture.supplyAsync(() -> slow(20));
        CompletableFuture<Integer> combined = a.thenCombine(b, Integer::sum);
        System.out.println("两个异步相加: " + combined.get());
        // 异常处理
        CompletableFuture<Integer> withFallback = CompletableFuture
                .<Integer>supplyAsync(() -> { throw new RuntimeException("boom"); })
                .exceptionally(ex -> -1);                   // 出错给兜底值
        System.out.println("异常兜底: " + withFallback.get());

        // ── 3. ReentrantLock：比 synchronized 更灵活的锁 ───
        var counter = new LockCounter();
        runWith(counter::increment);
        System.out.println("ReentrantLock 计数: " + counter.get());

        // ── 4. 原子类：无锁 CAS，比 synchronized 更轻 ──────
        AtomicInteger atomic = new AtomicInteger(0);
        runWith(atomic::incrementAndGet);     // 硬件级 CAS 保证原子，无需加锁
        System.out.println("AtomicInteger 计数: " + atomic.get());

        // ── 5. 并发集合 ────────────────────────────────────
        // ConcurrentHashMap：高并发下安全且高效（分段/CAS，非整表锁）
        ConcurrentHashMap<String, Integer> chm = new ConcurrentHashMap<>();
        runWith(() -> chm.merge("count", 1, Integer::sum));  // merge 是原子的
        System.out.println("ConcurrentHashMap 计数: " + chm.get("count"));
        // ⚠️ 普通 HashMap 多线程 put 可能丢数据甚至（旧版）死循环，绝不能并发写

        // ── 6. CountDownLatch：等一组任务全部完成 ──────────
        int n = 3;
        CountDownLatch latch = new CountDownLatch(n);
        try (ExecutorService pool = Executors.newFixedThreadPool(n)) {
            for (int i = 1; i <= n; i++) {
                int id = i;
                pool.submit(() -> {
                    System.out.println("子任务 " + id + " 完成");
                    latch.countDown();          // 计数减一
                });
            }
            latch.await();                       // 阻塞直到计数归零
            System.out.println("所有子任务完成，主线程继续");
        }
    }

    static int slow(int x) { try { Thread.sleep(30); } catch (InterruptedException ignored) {} return x; }

    static void runWith(Runnable task) throws InterruptedException {
        Runnable loop = () -> { for (int i = 0; i < 10000; i++) task.run(); };
        Thread a = new Thread(loop), b = new Thread(loop);
        a.start(); b.start(); a.join(); b.join();
    }
}

class LockCounter {
    private final ReentrantLock lock = new ReentrantLock();
    private int value = 0;
    void increment() {
        lock.lock();                 // 显式加锁
        try { value++; }
        finally { lock.unlock(); }   // ⚠️ 必须在 finally 解锁，否则异常会导致死锁
    }
    int get() { return value; }
}

/*
【线程池：为什么不能手动 new Thread】
  - 创建/销毁线程开销大；线程数失控会耗尽内存/CPU
  - 线程池复用线程、限制并发数、提供队列削峰、统一管理生命周期
  ⚠️ 阿里规约：禁止用 Executors 的快捷工厂直接上生产，因为
     newFixedThreadPool/newSingleThreadExecutor 用无界队列 → 可能 OOM；
     newCachedThreadPool 线程数无上限 → 可能耗尽资源。
     生产应 new ThreadPoolExecutor(...) 显式设置核心数/最大数/有界队列/拒绝策略。
     （七大参数与执行流程见 knowledge/08）

【Future vs CompletableFuture】
  Future：只能 get()（阻塞）或 isDone() 轮询，无法组合、无法回调 → 较弱
  CompletableFuture：链式 thenApply/thenCompose/thenCombine、exceptionally
                     兜底、allOf/anyOf 编排，是现代异步编程主力

【synchronized vs ReentrantLock】
  synchronized：JVM 内置、自动释放、写法简单；不可中断、不能尝试获取、非公平
  ReentrantLock：可 tryLock(超时)、可中断 lockInterruptibly、可选公平锁、可绑定多个 Condition
                 代价是必须手动 finally unlock。需要高级特性才用它，否则 synchronized 足矣。

【原子类 vs 锁】
  原子类基于 CAS（Compare-And-Swap）硬件指令，无锁，竞争不激烈时比锁快得多。
  适合单个变量的计数/标志；复合操作（多个变量要一致）还得用锁。

【并发集合速记】
  ConcurrentHashMap    替代 HashMap（高并发读写）
  CopyOnWriteArrayList 替代 ArrayList（读多写极少，如监听器列表）
  BlockingQueue        生产者-消费者标准容器（ArrayBlockingQueue/LinkedBlockingQueue）
  ConcurrentLinkedQueue 无锁并发队列
*/
