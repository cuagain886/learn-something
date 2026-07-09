/*
═══════════════════════════════════════════════════════════════════
 11_thread_basics —— 多线程基础：线程、同步、可见性
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. 创建线程的方式；线程生命周期与状态
  2. ⚠️ 竞态条件（race condition）与 synchronized 互斥
  3. volatile 保证可见性（但不保证原子性！）
  4. wait / notify 线程协作

【运行】java 11_thread_basics/Main.java
（底层原理见 ../knowledge/04_jmm、05_synchronized）
*/

public class Main {
    public static void main(String[] args) throws InterruptedException {
        // ── 1. 创建并启动线程 ──────────────────────────────
        // 方式一：实现 Runnable（推荐，把"任务"和"线程"解耦）
        Thread t1 = new Thread(() -> System.out.println("子线程: " + Thread.currentThread().getName()));
        t1.start();          // ⚠️ start() 才会开新线程；直接 run() 是在当前线程同步执行
        t1.join();           // 等 t1 结束

        // ── 2. ⚠️ 竞态条件演示 ─────────────────────────────
        System.out.println("--- 不加锁：结果几乎总是错的 ---");
        Counter unsafe = new Counter();
        runConcurrently(unsafe::incrementUnsafe);
        System.out.println("期望 20000，实际 " + unsafe.value + "（i++ 不是原子操作）");

        System.out.println("--- synchronized 加锁：结果正确 ---");
        Counter safe = new Counter();
        runConcurrently(safe::incrementSafe);
        System.out.println("期望 20000，实际 " + safe.value);

        // ── 3. volatile：可见性 vs 原子性 ──────────────────
        // volatile 保证一个线程的写对其他线程立即可见（解决"看不到更新"问题）
        var flag = new VolatileFlag();
        Thread worker = new Thread(flag::loopUntilStopped);
        worker.start();
        Thread.sleep(100);
        flag.stop = true;      // 若 stop 不是 volatile，worker 可能永远看不到这次修改而死循环
        worker.join();
        System.out.println("volatile flag 成功通知线程停止");

        // ── 4. wait / notify 协作（生产者-消费者雏形）──────
        var box = new MessageBox();
        Thread consumer = new Thread(() -> System.out.println("消费到: " + box.take()));
        Thread producer = new Thread(() -> box.put("Hello from producer"));
        consumer.start();
        Thread.sleep(50);     // 故意让消费者先跑、进入 wait
        producer.start();
        consumer.join(); producer.join();

        // ── 5. 线程状态 ────────────────────────────────────
        Thread sleeper = new Thread(() -> { try { Thread.sleep(200); } catch (InterruptedException ignored) {} });
        System.out.println("启动前状态: " + sleeper.getState());   // NEW
        sleeper.start();
        Thread.sleep(50);
        System.out.println("睡眠中状态: " + sleeper.getState());   // TIMED_WAITING
        sleeper.join();
        System.out.println("结束后状态: " + sleeper.getState());   // TERMINATED
    }

    // 开两个线程，各自把任务跑 10000 次
    static void runConcurrently(Runnable task) throws InterruptedException {
        Runnable loop = () -> { for (int i = 0; i < 10000; i++) task.run(); };
        Thread a = new Thread(loop), b = new Thread(loop);
        a.start(); b.start();
        a.join(); b.join();
    }
}

class Counter {
    int value = 0;
    // ⚠️ value++ 实际是"读-改-写"三步，多线程交错会丢更新
    void incrementUnsafe() { value++; }
    // synchronized：同一时刻只有一个线程能进入，串行化对 value 的修改
    synchronized void incrementSafe() { value++; }
}

class VolatileFlag {
    // volatile：禁止把变量缓存在寄存器/线程本地，每次读写都走主内存 → 可见性
    volatile boolean stop = false;
    void loopUntilStopped() {
        long n = 0;
        while (!stop) n++;     // 没有 volatile 时，编译器可能优化成 while(true) 死循环
    }
}

class MessageBox {
    private String message;
    // wait/notify 必须在 synchronized 块内调用，且用 while 防"虚假唤醒"
    synchronized void put(String msg) {
        this.message = msg;
        notify();               // 唤醒等待此锁的一个线程
    }
    synchronized String take() {
        while (message == null) {           // 用 while 而非 if：防虚假唤醒
            try { wait(); }                 // 释放锁并等待，被 notify 后重新竞争锁
            catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }
        return message;
    }
}

/*
【线程生命周期（Thread.State）】
  NEW → RUNNABLE ⇄ (BLOCKED / WAITING / TIMED_WAITING) → TERMINATED
  - RUNNABLE：可运行（包含正在跑和等 CPU 的）
  - BLOCKED：等待进入 synchronized 锁
  - WAITING：wait()/join() 无限等待，需被唤醒
  - TIMED_WAITING：sleep(n)/wait(n)，超时自动醒

【三大并发问题】
  - 原子性：i++ 看似一步，实为读-改-写三步 → synchronized / 原子类 解决
  - 可见性：一个线程改了，别的线程看不到（被缓存） → volatile / synchronized 解决
  - 有序性：编译器/CPU 重排指令 → volatile / happens-before 规则约束（见 knowledge/04）

【synchronized vs volatile】
  synchronized：互斥(原子性) + 可见性，能锁代码块/方法，重；适合"复合操作"
  volatile：只保证可见性 + 禁重排，不保证原子性，轻；适合"一写多读的状态标志"
  ⚠️ volatile 不能替代锁：volatile int 的 ++ 依然线程不安全！

【实践建议】
  - 优先用 Runnable/Callable + 线程池（第12课），别手动 new Thread
  - 别调用已废弃的 stop()/suspend()，用中断 interrupt() + 标志位优雅停止
  - wait/notify 已是底层原语，实际开发用 j.u.c 的高级工具（第12课）
*/
