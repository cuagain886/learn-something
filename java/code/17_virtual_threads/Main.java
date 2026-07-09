/*
═══════════════════════════════════════════════════════════════════
 17_virtual_threads —— 虚拟线程（Java 21 正式）⭐ 近年最重磅特性
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. 虚拟线程 vs 平台线程：为什么能轻松开几百万个
  2. 创建方式：Thread.ofVirtual / Executors.newVirtualThreadPerTaskExecutor
  3. 适用场景（IO 密集）与陷阱（别池化、注意 pinning）
  4. 结构化并发（Java 21 预览 / 25 演进）简介

【运行】java 17_virtual_threads/Main.java
（底层调度与"载体线程"概念见 ../knowledge/04、08 相关章节）
*/

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

public class Main {
    public static void main(String[] args) throws Exception {
        // ── 1. 创建一个虚拟线程 ────────────────────────────
        Thread vt = Thread.ofVirtual().name("vt-1").start(() ->
                System.out.println("我是虚拟线程? " + Thread.currentThread().isVirtual()));
        vt.join();

        // 对比：平台线程（传统线程，1:1 映射操作系统线程）
        Thread pt = Thread.ofPlatform().name("pt-1").start(() ->
                System.out.println("我是虚拟线程? " + Thread.currentThread().isVirtual()));
        pt.join();

        // ── 2. ⭐ 见证奇迹：一次性开 10000 个并发"IO 任务" ──
        // 每个任务 sleep 1 秒模拟 IO。若用平台线程，1 万个线程会吃掉巨量内存；
        // 虚拟线程每个只占几百字节，阻塞时自动让出底层 OS 线程。
        int taskCount = 10_000;
        AtomicInteger done = new AtomicInteger();
        Instant start = Instant.now();

        // 每个任务一个虚拟线程，用完即弃（这正是推荐用法）
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            for (int i = 0; i < taskCount; i++) {
                executor.submit(() -> {
                    try { Thread.sleep(Duration.ofSeconds(1)); }   // 模拟 IO 等待
                    catch (InterruptedException ignored) {}
                    done.incrementAndGet();
                });
            }
        } // try-with-resources 自动等所有任务完成

        Duration elapsed = Duration.between(start, Instant.now());
        System.out.printf("%d 个任务（每个睡 1 秒）全部完成，总耗时约 %d 毫秒%n",
                done.get(), elapsed.toMillis());
        System.out.println("→ 1 万个并发只花约 1 秒，因为它们几乎同时阻塞、几乎同时醒来");
        System.out.println("  若用 newFixedThreadPool(200)，得跑约 50 轮 ≈ 50 秒");

        // ── 3. 同样的阻塞式写法，性能却像异步 ──────────────
        // 关键卖点：你照常写【简单的同步阻塞代码】（易读易调试），
        //         运行期却获得了接近异步/响应式框架的吞吐量。
        String result = fetchUserBlocking("42");
        System.out.println("阻塞式调用结果: " + result);
    }

    // 看起来是"阻塞"的普通代码，跑在虚拟线程上时阻塞几乎零成本
    static String fetchUserBlocking(String id) throws InterruptedException {
        Thread.sleep(Duration.ofMillis(50));    // 模拟网络请求
        return "User(" + id + ")";
    }
}

/*
【虚拟线程到底是什么】
  平台线程（Platform Thread）：传统线程，与 OS 线程 1:1 绑定。
    一个 OS 线程约占 1MB 栈 + 内核资源，开几千个就吃紧，几万个基本崩。
  虚拟线程（Virtual Thread）：JVM 管理的轻量线程，由少量 OS 线程（载体线程
    carrier thread）调度执行。M 个虚拟线程跑在 N 个平台线程上（M >> N）。
    当虚拟线程执行阻塞 IO（sleep、网络、文件）时，JVM 把它从载体线程上
    "卸下"(unmount)，让载体线程去跑别的虚拟线程；IO 就绪再"挂回"(mount)。
    → 阻塞不再占用宝贵的 OS 线程，于是可以有几百万个并发任务。

【解决了什么痛点】
  传统"每请求一线程"模型受限于线程数，高并发要么用线程池（队列堆积），
  要么写异步/响应式代码（回调地狱、难调试、栈追踪断裂）。
  虚拟线程让你：用最朴素的同步阻塞写法，拿到异步级别的吞吐 —— "鱼与熊掌兼得"。

【正确用法 & 陷阱】
  ✓ 每个任务新建一个虚拟线程，用完即弃（newVirtualThreadPerTaskExecutor）
  ✓ 适合 IO 密集（网络、DB、文件、微服务调用）—— 绝大多数业务服务
  ✗ 不要"池化"虚拟线程：它们本就廉价，池化反而是反模式
  ✗ 对 CPU 密集任务没有优势（瓶颈是 CPU 核数，不是线程数）
  ⚠️ Pinning（钉住）：在 synchronized 块内执行阻塞调用时，虚拟线程会被
     "钉"在载体线程上无法卸下，削弱优势 → 这类临界区改用 ReentrantLock。
     （Java 24+ 已大幅缓解 synchronized 内的 pinning 问题）
  ⚠️ 不要用 ThreadLocal 缓存重对象（百万线程 × 每个一份 = 内存爆炸）

【结构化并发（Structured Concurrency，Java 21 预览 → 25 继续演进）】
  把"一组相关的并发子任务"当成一个工作单元管理：要么都成功，要么一起取消，
  父任务等所有子任务结束。用 StructuredTaskScope 让并发代码像同步代码一样
  有清晰的作用域和错误传播，避免线程泄漏。是虚拟线程的最佳搭档。
*/
