# Java 进阶 & 大厂面试知识点深入文档

> 适用对象：已掌握 Java 语法与进阶 API（见 [../code](../code) 的 01–20 教程），想深入 **JVM 底层原理**、**并发机制**、**源码实现**，应对**大厂面试**的同学。
>
> 每篇文档结构统一：**原理讲解 → 结构/源码剖析 → 图示/代码示例 → 高频面试题 + 标准答案 → 一句话总结**。
> 标 ⭐ 的是面试出现频率最高的考点，标 ⚠️ 的是最容易答错/写错的陷阱。

---

## 📚 章节索引

### 第一部分：JVM 与运行时（大厂必考 ⭐⭐⭐）

| # | 文档 | 核心考点 |
|---|------|---------|
| 01 | [JVM 内存结构](01_jvm_memory.md) | ⭐ 运行时数据区、堆/栈/方法区/元空间、栈帧、`-Xmx`、OOM 与 SOF 定位 |
| 02 | [类加载机制](02_classloading.md) | ⭐ 加载→链接→初始化、双亲委派、类加载器、打破双亲委派、`<clinit>` |
| 03 | [垃圾回收 GC](03_gc.md) | ⭐⭐ 可达性分析、分代收集、G1/ZGC、STW、三色标记、GC 调优与排查 |

### 第二部分：并发底层原理（大厂区分度最高 ⭐⭐⭐）

| # | 文档 | 核心考点 |
|---|------|---------|
| 04 | [JMM 内存模型](04_jmm.md) | ⭐⭐ 主内存/工作内存、原子性/可见性/有序性、happens-before、volatile、指令重排 |
| 05 | [synchronized 原理](05_synchronized.md) | ⭐⭐ 对象头 Mark Word、锁升级（偏向→轻量→重量）、monitor、自旋 |
| 08 | [线程池原理](08_threadpool.md) | ⭐⭐ ThreadPoolExecutor 七参数、执行流程、拒绝策略、调参、`Executors` 的坑 |
| 09 | [AQS 原理](09_aqs.md) | ⭐⭐ state + CLH 队列、独占/共享、ReentrantLock/CountDownLatch/Semaphore 实现 |

### 第三部分：集合与 String 源码（高频 ⭐⭐）

| # | 文档 | 核心考点 |
|---|------|---------|
| 06 | [HashMap 底层原理](06_hashmap.md) | ⭐⭐ 数组+链表+红黑树、hash 扰动、扩容 resize、为什么 7→8 树化、并发问题 |
| 07 | [ConcurrentHashMap 原理](07_concurrenthashmap.md) | ⭐⭐ 1.7 分段锁 vs 1.8 CAS+synchronized、扩容协助、计数 |
| 10 | [String 原理](10_string.md) | ⭐ 不可变性、字符串常量池、`intern()`、`+` 拼接与 StringBuilder、`==` vs equals |
| 11 | [ArrayList & LinkedList 源码](11_collections_source.md) | ⭐ 扩容机制、fail-fast、modCount、为什么很少用 LinkedList |

### 第四部分：查漏补缺与冲刺

| # | 文档 | 核心考点 |
|---|------|---------|
| 12 | [高频面试陷阱题集锦](12_interview_traps.md) | ⚠️ 30+ 道经典题（输出什么？为什么？怎么改）+ 答案解析 |

---

## 🎯 推荐学习路线

```
面试冲刺（2 周）              系统进阶（1 个月）
─────────────              ─────────────
Day 1-3  : 01 06 10 ⭐基础    先 01 02 03（JVM 是地基，最能体现深度）
Day 4-6  : 03 04 ⭐重点       再 04 05（JMM + 锁，并发的理论根基）
Day 7-9  : 05 08 09          然后 08 09（线程池 + AQS，工程必备）
Day 10-12: 02 07 11          接着 06 07 10 11（源码，手撕题素材）
Day 13-14: 12 刷题           最后 12 查漏补缺
```

**面试官最爱问的 6 个"灵魂拷问"**（在对应文档里都有详解）：

1. **new 一个对象，JVM 内存里发生了什么？对象在堆还是栈？** → [01](01_jvm_memory.md)
2. **GC 怎么判断对象该回收？G1 和 ZGC 有什么区别？** → [03](03_gc.md)
3. **volatile 凭什么保证可见性？happens-before 是什么？** → [04](04_jmm.md)
4. **synchronized 的锁升级过程讲一下；它和 ReentrantLock 怎么选？** → [05](05_synchronized.md) / [09](09_aqs.md)
5. **HashMap 的 put 全过程？为什么用红黑树？为什么线程不安全？** → [06](06_hashmap.md)
6. **线程池七大参数？一个任务进来的执行流程？为什么不用 Executors？** → [08](08_threadpool.md)

---

## 🛠️ 配套工具命令（边学边用）

```bash
# 查看 JVM 默认参数与内存设置
java -XX:+PrintFlagsFinal -version | grep -i heapsize
java -XX:+PrintCommandLineFlags -version

# 打印 GC 日志（Java 9+ 统一日志框架）
java -Xlog:gc* -Xmx64m YourApp

# 运行时诊断三件套
jps            # 列出 Java 进程
jstack <pid>   # 打印线程栈（排查死锁、卡顿）
jmap -histo <pid>   # 对象直方图（排查内存泄漏）
jstat -gcutil <pid> 1000   # 每秒打印 GC 统计

# 图形化/采样工具
jconsole / VisualVM / JDK Mission Control (JMC) / async-profiler / Arthas

# 看对象内存布局（需引入 JOL 库）
# org.openjdk.jol.info.ClassLayout.parseInstance(obj).toPrintable()

# 反汇编看字节码（理解 synchronized/String 拼接的利器）
javap -c -p YourClass.class
```

---

## ⚠️ 关于版本

本文档基于 **Java 25 LTS**（仓库环境为 Java 25.0.2）。涉及版本差异处会标注，常见分水岭：

- **Java 7**：永久代（PermGen）时代；`invokedynamic`；G1 实验性引入
- **Java 8**：⭐ **永久代被元空间（Metaspace）取代**（移到本地内存）；Lambda/Stream
- **Java 8u**：HashMap 链表过长**树化为红黑树**（实际是 JDK 8 引入）
- **Java 9**：G1 成为**默认垃圾回收器**；统一 GC 日志 `-Xlog`；模块系统
- **Java 11**：ZGC、Epsilon GC（实验）；新 `HttpClient`（LTS）
- **Java 15**：ZGC 转正（生产可用）
- **Java 17**：默认强封装；伪随机数接口（LTS）
- **Java 21**：⭐ **虚拟线程**、分代 ZGC、模式匹配定稿（LTS）
- **Java 25**：当前最新 LTS，继续推进紧凑对象头等优化

> 面试时若被问"你用哪个版本、有什么新特性"，上面这些是加分项。
> 尤其要记牢 **Java 8 = 永久代→元空间** 和 **Java 25 = 当前最新 LTS** 这两个分水岭。
