# 04 · JMM 内存模型（Java Memory Model）⭐⭐⭐

> 并发三大问题——**原子性、可见性、有序性**——的理论根基。
> 核心一句话：**JMM 规定了多线程下共享变量的读写规则，volatile/synchronized/final 通过 happens-before 提供保证。**

---

## 1. 为什么需要 JMM

现代 CPU 为了快，每个核心有自己的**高速缓存**；编译器和 CPU 还会**重排指令**。这导致：
一个线程改了共享变量，另一个线程**可能看不到**，或者看到的**顺序乱了**。

JMM 是一个**抽象规范**（不是真实内存结构），它定义了：
- 线程与**主内存（Main Memory）**、线程**工作内存（Working Memory，对应缓存/寄存器）**的交互规则。
- 每个线程操作共享变量时，先从主内存拷贝到工作内存，改完再写回主内存。
- **问题来了**：线程 A 改了自己工作内存的副本还没写回，线程 B 读的还是主内存旧值 → **可见性问题**。

```
   线程A工作内存            主内存             线程B工作内存
   ┌─────────┐         ┌─────────┐        ┌─────────┐
   │ x = 1   │ ──写回→ │  x = ?  │ ←读──  │ x = 0   │  ← B 看到旧值
   └─────────┘         └─────────┘        └─────────┘
```

---

## 2. 并发三大特性

### 2.1 原子性 Atomicity
一个或一组操作要么全做完，要么都不做，中间不被打断。
- `i++` **不是原子的**（读-改-写三步），多线程会丢更新。
- 解决：`synchronized`、`Lock`、原子类（`AtomicInteger`，基于 CAS）。

### 2.2 可见性 Visibility
一个线程对共享变量的修改，其他线程能**立即看到**。
- 普通变量不保证（被缓存在工作内存）。
- 解决：`volatile`（写立即刷主内存、读必从主内存）、`synchronized`、`final`。

### 2.3 有序性 Ordering
程序执行顺序按代码顺序。但编译器/CPU 会**重排序**（在单线程结果不变的前提下）。
- **as-if-serial**：单线程内重排不改变结果，所以你感觉不到。
- 多线程下重排会出问题（如经典双重检查锁 DCL 的对象未初始化完就被发布）。
- 解决：`volatile`（禁止特定重排，插内存屏障）、`synchronized`。

---

## 3. happens-before 原则 ⭐⭐（JMM 的灵魂）

JMM 用 **happens-before** 定义"前一个操作的结果对后一个操作可见"。**只要满足 happens-before，就保证可见性与有序性**，不用关心底层重排细节。

**8 条规则（记住前 5 条最常考）**：
1. **程序顺序规则**：同一线程内，前面的操作 happens-before 后面的操作。
2. **监视器锁规则**：对一个锁的**解锁** happens-before 后续对它的**加锁**。
3. **volatile 规则**：对 volatile 变量的**写** happens-before 后续对它的**读**。
4. **线程启动规则**：`Thread.start()` happens-before 该线程的所有操作。
5. **线程终止规则**：线程的所有操作 happens-before 其他线程检测到它终止（`join()` 返回）。
6. **中断规则**：`interrupt()` happens-before 被中断线程检测到中断。
7. **对象终结规则**：构造器结束 happens-before `finalize()` 开始。
8. **传递性**：A hb B 且 B hb C，则 A hb C。

> 例：线程 A 写 `data=1` 后写 `volatile flag=true`；线程 B 读到 `flag==true` 后读 `data`，
> 由 volatile 规则 + 程序顺序 + 传递性，B 一定能看到 `data==1`。这就是"volatile 的可见性顺带保护了它前面的普通写"。

---

## 4. volatile 深入 ⭐⭐

### 4.1 volatile 保证什么
- ✅ **可见性**：写操作立即刷回主内存，读操作必从主内存读最新值。
- ✅ **有序性**：通过插入**内存屏障**禁止指令重排。
- ❌ **不保证原子性**：`volatile int i; i++` 依然线程不安全（i++ 是复合操作）。

### 4.2 底层：内存屏障（Memory Barrier）
编译器在 volatile 读写前后插入屏障指令，禁止越过屏障的重排：
- volatile **写**之前的所有读写，不能重排到写之后（StoreStore + StoreLoad）。
- volatile **读**之后的所有读写，不能重排到读之前（LoadLoad + LoadStore）。

在 x86 上，volatile 写会编译出带 `lock` 前缀的指令，强制刷缓存 + 充当屏障。

### 4.3 经典应用：双重检查锁单例（DCL）
```java
public class Singleton {
    private static volatile Singleton instance;   // ⚠️ volatile 不可省
    public static Singleton getInstance() {
        if (instance == null) {                   // 第一次检查（免锁，快）
            synchronized (Singleton.class) {
                if (instance == null) {           // 第二次检查（持锁，准）
                    instance = new Singleton();   // ★ 这行不是原子的！
                }
            }
        }
        return instance;
    }
}
```
**为什么必须 volatile？** `instance = new Singleton()` 分三步：① 分配内存 ② 调构造器初始化 ③ 把引用指向内存。②③ 可能被**重排**为 ①③②。若线程 A 执行到 ①③（引用已非 null 但对象没初始化完），线程 B 在第一次检查看到非 null 直接返回了一个**半成品对象** → 崩。volatile 禁止这种重排，保证拿到的对象一定初始化完毕。

---

## 5. final 的内存语义

- 构造器中对 final 字段的写，happens-before 构造器结束后把对象引用赋给其他变量（**禁止把 final 写重排到构造器外**）。
- 因此：**正确构造**（this 不逸出）的对象，其 final 字段对其他线程天然可见，无需同步。这是不可变对象（如 String、record）线程安全的根基。

---

## 6. 高频面试题 + 标准答案

**Q1：并发三大问题是什么？分别怎么解决？** ⭐
> 原子性（synchronized/Lock/原子类）、可见性（volatile/synchronized/final）、有序性（volatile/synchronized）。synchronized 三个都能保证；volatile 只保证可见性和有序性，不保证原子性。

**Q2：volatile 能保证原子性吗？** ⭐⭐
> 不能。volatile 只保证可见性和禁止重排。`volatile int i; i++` 仍线程不安全，因为 i++ 是读-改-写复合操作。要原子用 AtomicInteger 或加锁。

**Q3：什么是 happens-before？** ⭐⭐
> JMM 定义的偏序关系，若 A happens-before B，则 A 的结果对 B 可见且 A 排在 B 前。常用规则：程序顺序、锁的解锁先于加锁、volatile 写先于读、start 先于线程内操作、传递性。它让我们不用关心底层重排就能推理可见性。

**Q4：volatile 底层怎么实现可见性和有序性？**
> 通过内存屏障。volatile 写后插 StoreStore/StoreLoad 屏障并刷主内存，volatile 读前插 LoadLoad/LoadStore 屏障从主内存读。x86 上表现为带 lock 前缀的指令。

**Q5：DCL 单例为什么 instance 要加 volatile？** ⭐⭐
> 因为 `new Singleton()` 的"分配内存、初始化、赋引用"三步可能重排，导致引用非 null 但对象未初始化完，别的线程拿到半成品。volatile 禁止该重排，保证发布的是完整对象。

**Q6：synchronized 和 volatile 的区别？**
> volatile 轻量，只保证可见性+有序性，用于状态标志位（一写多读）；synchronized 重，保证原子性+可见性+有序性，能锁代码块，用于复合操作。volatile 不能替代锁。

---

## 一句话总结

> JMM 用**主内存/工作内存**模型解释可见性问题，用 **happens-before** 规则统一描述可见性与有序性；
> **volatile = 可见性 + 禁重排（不保原子性）**，**synchronized = 三性全保**，**final = 安全发布**；
> DCL 单例必须 volatile，因为 `new` 不是原子的、可能重排出半成品对象。
