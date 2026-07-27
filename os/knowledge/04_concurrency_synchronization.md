# 04 · 并发与同步：从竞态到任务状态机 ⭐⭐⭐⭐

> 对应代码：[`../code/02_concurrency`](../code/02_concurrency)（03_race_deadlock、04_worker_pool、05_task_state_machine）· 对应实验：[lab_02](../labs/lab_02_goroutine.md) 实验 6–8
>
> 本章回答：为什么大量锁竞争导致吞吐下降？如何设计幂等性？如何设计任务状态机？如何限制并发数量？——以及 Agent 最疼的四个事故：任务重复执行、状态被并发改坏、取消后还在跑、重试导致副作用重放。

## 1. 本章目标

- 精确理解竞态条件的两种形态（check-then-act / read-modify-write）和"三性"（原子性/可见性/有序性）；
- 掌握锁的底层（futex、自旋 vs 睡眠、饥饿模式）与 Go sync 全家桶的选型；
- 掌握 atomic/CAS、内存屏障、happens-before、False Sharing；
- 能识别并打破死锁/活锁/饥饿；
- **工程输出**：会设计幂等提交、任务状态机、并发限流——Runner 的并发骨架。

## 2. 核心概念

### 2.1 并发 ≠ 并行

- **并发（concurrency）**：结构概念——程序被组织成多个可独立推进的执行流（1 个核也能并发，轮着来）。
- **并行（parallelism）**：执行概念——同一瞬间物理上多个流在跑（需要多核）。
- 一句话：并发是"应对很多事"的**设计**，并行是"同时做很多事"的**硬件事实**。Go 的口号 "concurrency is not parallelism" 说的就是：你写并发结构，runtime 负责映射到并行硬件（GOMAXPROCS 个 P，第 03 章）。

### 2.2 竞态条件：两种病理形态

竞态条件（race condition）= 结果依赖于不受控的执行时序。99% 的竞态属于两种形态：

**形态 A：read-modify-write（读-改-写不原子）**

```go
counter++    // 实际是三步: 读 counter → 加 1 → 写回
// 两个 goroutine 同时执行: 都读到 5, 都写回 6 —— 丢了一次加
```

**形态 B：check-then-act（检查与行动之间世界变了）**

```go
if _, running := tasks[id]; !running {   // 检查: 没在跑
    tasks[id] = newTask()                 // 行动: 启动
}   // 两个请求同时通过检查 → 同一任务被启动两次 —— Agent 重复执行事故的原型
```

⚠️ **数据竞争（data race）在 Go 里是未定义行为**，不是"偶尔算错"这么温和：竞态读到的值可能是撕裂的（torn read）、编译器可能基于"无竞争"假设做出诡异优化。`map` 并发读写更是直接 **fatal error: concurrent map writes——不可 recover，进程当场死**（面试高频陷阱：它不是 panic！）。

### 2.3 三性：原子性、可见性、有序性（Java 程序员的老朋友）

| 性质 | 破坏场景 | OS/硬件根源 | Go 侧修复 |
|---|---|---|---|
| 原子性 (atomicity) | `counter++` 三步被打断 | 指令级中断/多核交错 | atomic 包、Mutex |
| 可见性 (visibility) | A 核写了，B 核读到旧值 | 每核私有缓存/store buffer，写没及时到达对方 | 同步原语自带屏障 |
| 有序性 (ordering) | 写 a 再写 b，别的核先看到 b | 编译器重排 + CPU 乱序执行 | happens-before（§3.4） |

Java 对照（本仓库读者友好）：`synchronized`↔`sync.Mutex`；`volatile`↔`atomic.Load/Store`（Go 没有 volatile 关键字，atomic 是唯一正道）；`AtomicInteger.compareAndSet`↔`atomic.CompareAndSwapInt64`；`ConcurrentHashMap`↔`sync.Map`（但适用面窄得多，见 §3.3）。

### 2.4 临界区与锁粒度

临界区（critical section）= 同一时刻最多一个执行流能进入的代码段。**吞吐的天花板由临界区决定**（Amdahl 定律的锁版本）：临界区占执行时间的比例 p，无论多少核，加速比上限 1/p。所以锁优化的第一原则不是"换更快的锁"，而是**缩小临界区**——锁内只做共享状态读写，I/O、日志、计算全部挪出去。

## 3. 底层原理

### 3.1 锁是怎么实现的：从自旋到 futex

**自旋锁（spinlock）**：拿不到锁就死循环重试 CAS。优点：不陷内核、无切换成本；缺点：白烧 CPU。适用：临界区极短（几十 ns）+ 多核（单核自旋纯属自残——持锁者没 CPU 跑，你自旋到天荒地老）。内核里大量用；用户态慎用。

**睡眠锁**：拿不到就让出 CPU 去睡，解锁者叫醒。问题：睡/醒都是 syscall，无竞争时也付这个钱就亏了。

**futex（fast userspace mutex，Linux 的答案）**：混合两者——
```text
加锁: 用户态 CAS 抢锁 ── 成功 → 完事，零 syscall（无竞争快路径，~20ns）
                     └─ 失败 → futex(FUTEX_WAIT) 陷内核睡在该地址的等待队列上
解锁: 用户态 CAS 释放 ── 没人等 → 完事，零 syscall
                     └─ 有人等 → futex(FUTEX_WAKE) 叫醒一个
```
**"锁慢"慢在竞争，不慢在锁本身**——无竞争的 Mutex 就是一次 CAS。这解释了性能准则：先降竞争（分片、缩临界区），再谈换锁。

**Go sync.Mutex 在 futex 思想上再包一层**：先自旋几圈（多核、有空闲 P 才自旋，赌持锁者马上放）→ 不行再经 runtime 信号量睡觉（gopark 挂起 G——**挂的是 G 不是 M**，比线程锁又轻一层）。并有两种模式：
- **正常模式**：新来的 G 和刚唤醒的 G 抢锁，新来的赢面大（正在 CPU 上，缓存热）——吞吐高但可能饿死等待者；
- **饥饿模式（Go 1.9+）**：等待超过 **1ms** 切换——锁直接移交队首等待者，新来的一律排队。牺牲吞吐换公平，防长尾。
面试考点：这是"吞吐 vs 公平"权衡的教科书案例。

### 3.2 atomic 与 CAS：无锁的地基

- 原子指令由 CPU 保证（x86 的 `lock` 前缀锁缓存行；ARM 用 LL/SC 重试对）。
- **CAS（Compare-And-Swap）**：`if *p == old { *p = new; return true }` 一条指令内完成——无锁算法的全部家当。失败就重读重试（乐观并发）。
- **ABA 问题**：CAS 只看值不看历史——A→B→A 之后 CAS 照样成功，但世界已经变过。Go 里带版本号的解法：`atomic.Pointer` + 带 seq 的结构体。实际业务里更常见的化身：**用"值相等"判断"没变过"的乐观更新丢历史**——任务状态机用版本号/状态枚举防它（§5.3）。
- 适用边界：单个字长的计数器/标志位/指针发布。**两个变量要一起变就超出 atomic 能力了，上锁**——"用一堆 atomic 拼多字段一致性"是高级 bug 制造机。

### 3.3 Go sync 全家桶速查（含选型一句话）

| 原语 | 一句话选型 | 关键坑 |
|---|---|---|
| Mutex | 默认选它——简单正确优先 | 不可重入（同 G 重复 Lock 直接死锁）；不可复制（vet 查 copylocks） |
| RWMutex | 读多写少（读写比 > 10:1 再考虑） | 写者会等所有读者；读者互相不等但**读锁不是免费的**（读者计数本身有原子开销、缓存行争用）；⚠️ 读锁也不可重入升级 |
| sync.Once | 单例/懒初始化 | Do 里 panic 也算"done"（Go 1.21+ OnceFunc/OnceValue 更好用） |
| sync.Cond | 等待复杂条件（队列非空且未关闭…） | Wait 必须裹在 for 循环里重查条件（虚假唤醒/条件被抢） |
| sync.Map | 只适合两类：写少读爆多、或 key 集合只增不改 | 通用场景比 Mutex+map 慢；无 Len；类型不安全 |
| channel | 所有权转移/流水线/信号广播（close） | 有缓冲≠不阻塞；nil channel 永久阻塞（select 里动态禁用分支的技巧） |
| semaphore | 并发额度控制 | 用 buffered channel 或 `x/sync/semaphore`（支持权重和 ctx） |

**channel vs 锁的判断法**：保护一块**共享状态**（大家都要读写同一个 map）→ 锁；传递**数据/任务所有权**（生产者做完交给消费者，交出去就不再碰）→ channel。Go 谚语 "Don't communicate by sharing memory; share memory by communicating" 说的是后者的场景，不是让你用 channel 模拟锁。

### 3.4 内存模型与 happens-before

Go 内存模型回答一个问题：**goroutine B 的读，什么时候保证看到 goroutine A 的写？** 答案：当且仅当写 happens-before 读。建立 happens-before 的手段（每条都是"同步点 + 隐含内存屏障"）：

- channel：第 n 次 send happens-before 第 n 次 receive 完成；close happens-before 收到零值；
- Mutex：第 n 次 Unlock happens-before 第 n+1 次 Lock；
- atomic：对同一变量的原子操作构成全序（Go 1.19 起文档明确，语义近似 Java volatile / C++ seq_cst）；
- go 语句 happens-before 新 G 开始；WaitGroup.Done happens-before Wait 返回；Once.Do 返回前完成初始化。

⚠️ 没有同步点的普通读写**没有任何保证**——"我先写的 flag=true 它总该看见吧"在乱序世界里是错觉（详见本仓库 `go/knowledge/13_memory_model.md` 的 store buffer 实验）。**内存屏障（memory barrier）**你几乎永远不该手写——用上面的原语，屏障是它们的赠品。

### 3.5 False Sharing：伪共享，多核性能刺客

缓存一致性以**缓存行（64 字节）**为单位。两个核各自疯写**不同变量**，但它们落在**同一缓存行** → 缓存行在两核间乒乓（每次写都要夺走对方的独占权）→ 各写各的却像抢同一把锁。典型现场：`counters [8]int64` 给 8 个 worker 各用一格。修法：padding 到行宽（`struct{ v int64; _ [56]byte }`）或每 G 本地累加最后汇总。识别：perf c2c（第 12 章）；症状是"无锁却随核数负扩展"。

### 3.6 死锁、活锁、饥饿

**死锁四条件**（全满足才死）：互斥、持有并等待、不可剥夺、**循环等待**。工程上专打第四条：**全局锁序**（所有代码路径按同一顺序拿多把锁，如按 ID 排序后加锁）。Go 特色死锁还有：Mutex 重入、channel 自己等自己（无缓冲 send 后才 receive）、Wait 与管道互等（第 02 章）。全员睡死时 runtime 报 `fatal error: all goroutines are asleep - deadlock!`——⚠️ 但只要有任何一个 G 活着（比如 http listener）就**不会报**，局部死锁静默存在，靠 goroutine dump 里的 `semacquire` 长时间阻塞识别。

**活锁（livelock）**：都在动，都不推进（互相礼让/同步重试风暴）。修法：随机退避（jitter）。**饥饿（starvation）**：有人永远抢不到（正常模式 Mutex 的等待者、RWMutex 下的写者）。修法：公平机制（饥饿模式、限制读者续借）。

## 4. 关键工程设计：Agent 的并发骨架（本章落地物）

### 4.1 幂等提交：同一任务绝不执行两次

```go
// ⚠️ 错误: check-then-act 竞态 —— 两个请求同时通过 if, 双开
if _, ok := m.tasks[id]; !ok { m.tasks[id] = start(id) }

// ✅ 正确 A: 原子占坑 —— LoadOrStore 一步完成"查+插"
actual, loaded := m.tasks.LoadOrStore(id, newPending(id))
if loaded { return actual.(*Task) }   // 已存在: 返回同一实例(幂等)
go m.run(actual.(*Task))              // 只有占坑成功者启动执行

// ✅ 正确 B(分布式): 数据库唯一约束/Redis SETNX 当占坑, 原理同款——
// 把"判断+登记"压成一个原子操作, 竞态就无处藏身
```
为什么正确：幂等的本质不是"加锁"，是**把决定权收敛到一个原子点**。重试/重复提交拿到的是同一个任务实例，"发邮件发两遍、PR 建两个"从源头消失。副作用本身还要幂等键兜底（邮件带 dedupe key），因为**跨系统的 exactly-once 不存在**，只有"至少一次 + 幂等消费"。

### 4.2 任务状态机：并发修改的秩序来源

```go
// 合法迁移表: 编译期写死, 运行期查表 —— 非法迁移是 bug, 直接拒绝并告警
var transitions = map[State][]State{
    Pending:  {Running, Canceled},
    Running:  {Succeeded, Failed, Canceled, TimedOut},
    // 终态无出边: Succeeded/Failed/Canceled/TimedOut → 什么都不许
}

func (t *Task) To(next State) error {
    t.mu.Lock(); defer t.mu.Unlock()
    if !slices.Contains(transitions[t.state], next) {
        return fmt.Errorf("illegal transition %v → %v", t.state, next) // 迟到的取消/重复的完成, 都被这里挡下
    }
    t.state = next
    for _, hook := range t.onEnter[next] { hook() } // 清理/通知挂在迁移上, 不散落各处
    return nil
}
```
这个 40 行的结构一次性消灭四类事故：取消到达时任务已完成（Canceled←Succeeded 非法，忽略）；两个 goroutine 同时报完成（第二个非法）；用户连点取消（第二次非法）；“取消了还在跑”（Running→Canceled 的 onEnter 挂着杀进程组，第 02 章）。**状态 + 锁 + 迁移表 = 并发世界里的宪法**。

### 4.3 并发限流：worker pool 与信号量

```go
sem := make(chan struct{}, maxConcurrent)   // 信号量: 容量 = 并发额度
func (r *Runner) Submit(ctx context.Context, t *Task) error {
    select {
    case sem <- struct{}{}:                 // 拿到名额
    case <-ctx.Done():                      // 队列满时不硬等 —— 背压给上游
        return fmt.Errorf("runner busy: %w", ctx.Err())
    }
    go func() { defer func() { <-sem }(); r.run(t) }()
    return nil
}
```
或固定 worker pool（N 个常驻 worker 从有界队列取任务，见 [04_worker_pool](../code/02_concurrency/04_worker_pool/main.go)）。选型：任务同质且吞吐稳定 → pool（G 数量恒定，好观测）；任务稀疏突发 → 信号量（不养闲 worker）。共同铁律：**队列必须有界**——无界队列 = 把"拒绝"推迟成"OOM"（第 06 章背压）。

## 5. Go 语言示例

| 示例 | 演示内容 |
|---|---|
| [03_race_deadlock](../code/02_concurrency/03_race_deadlock/main.go) | 两种竞态形态、-race 抓现行、锁序死锁构造与修复、map 并发 fatal |
| [04_worker_pool](../code/02_concurrency/04_worker_pool/main.go) | 固定 worker + 有界队列 + 满载拒绝 + 优雅关闭（排空 vs 丢弃） |
| [05_task_state_machine](../code/02_concurrency/05_task_state_machine/main.go) | 幂等提交 + 迁移表状态机 + 并发攻击测试（重复提交/迟到取消/双完成） |

## 6. 后端开发中的应用

- **锁竞争的吞吐曲线**：QPS 压不上去、CPU 却不满、mutex profile 里一个热点锁——教科书症状。三板斧按序用：缩临界区（锁内逐出 I/O 与计算）→ 分片（按 key 哈希成 N 把锁，如 256 分片 map）→ 无锁化（只读快照 + atomic.Pointer 发布，RCU 思想）。
- **连接池/资源池就是信号量**：数据库连接池 MaxOpenConns、HTTP 客户端 MaxConnsPerHost——都是"有界额度 + 排队/拒绝"，和 4.3 同构。调它们 = 调背压边界。
- **重试必须配幂等**：网络超时 ≠ 对端没执行（可能执行了但响应丢了）。没有幂等键的重试 = 主动制造重复副作用。下单/扣款/发消息接口，幂等键是必选项不是优化项。

## 7. Agent 开发中的应用

四个真实事故 → 本章工具的映射：

| 事故 | 根因 | 解法 |
|---|---|---|
| 同一任务被执行两次 | 提交入口 check-then-act | LoadOrStore 原子占坑（4.1） |
| 任务状态被改坏（完成后又变运行中） | 多方直写状态字段 | 迁移表状态机收口（4.2） |
| 用户取消了，任务还在跑 | 取消只改了字段没进状态机/没杀进程组 | Running→Canceled 的 onEnter 挂杀进程组 + ctx 传播（02 章） |
| 重试导致邮件发两遍 | 重试无幂等键 | 任务级 LoadOrStore + 副作用级 dedupe key |

另有**并发工具调用**：LLM 一次返回 5 个 tool call 并发执行时——每个工具独立 ctx（单个失败/超时不连坐）、共享信号量限总并发、结果写回经状态机（防迟到结果覆盖新状态）。

## 8. 常见问题与错误设计

**错误 1：给"读多写少"无脑上 RWMutex。** 读临界区如果只有几十 ns（读个 map），RLock 的原子计数开销 + 缓存行争用可能比 Mutex 还慢；写者还会被读者流饿到超时。先量（mutex profile），再换。

**错误 2：copy 了带锁的结构体。** `func (s MyStruct) Do()`（值接收者）复制了内部 Mutex——两个副本各锁各的，等于没锁。`go vet` 的 copylocks 能抓；接收者一律用指针。

**错误 3：defer mu.Unlock() 里裹着慢操作。**

```go
mu.Lock(); defer mu.Unlock()
data := m[key]
resp := callLLM(data)   // ⚠️ 几秒的 RPC 在锁内 —— 全体排队陪跑
// ✅ 锁内只取数据, 锁外调用: mu.Lock(); data := m[key]; mu.Unlock(); callLLM(data)
```

**错误 4：用 sleep 代替同步。** `go start(); time.Sleep(100ms); use()`——"等它应该好了"是竞态定时炸弹，CI 慢一点就炸。正确：channel/WaitGroup 明确通知就绪。

## 9. 排障方法

**竞态**：`go test -race` / `go run -race`（happens-before 检测，CPU/内存 5–10 倍开销，压测别开、CI 必开）。⚠️ race detector **只报跑到的路径**——绿灯 ≠ 无竞态，覆盖率决定检出率。

**死锁**：全局死锁看 runtime 报错栈；**局部死锁**（更常见）：pprof goroutine dump 里找长时间 `sync.runtime_SemacquireMutex` 的 G 群 + 它们各自持有什么锁——两群 G 互持对方想要的锁即锁序问题。预防性武器：`go vet`、超时上锁（`TryLock`，Go 1.18+，但滥用它掩盖设计问题）。

**锁竞争定量**：`runtime.SetMutexProfileFraction(5)` 开采样 → `/debug/pprof/mutex` 看**等锁总时长**排名；block profile 看 channel/select 等待。案例走查：现象 QPS 平台期 + CPU 60% → mutex profile 显示 90% 等待集中在全局注册表锁 → 按任务 ID 分 64 片 → QPS 3 倍（分片是"现象→原因→验证→解决"闭环里最常见的解）。

## 10. 实验任务

[lab_02_goroutine.md](../labs/lab_02_goroutine.md) 实验 6–8：⑥ -race 抓两种形态的竞态并读懂报告；⑦ 构造锁序死锁，从 goroutine dump 定位互持关系；⑧ mutex profile 前后对比验证分片优化。

## 11. 面试题（附答题要点）

**Q1：Mutex 底层怎么实现的？**
要点：分层答——硬件原子指令（lock CAS）→ futex（无竞争纯用户态 ~20ns，竞争才 syscall 睡等待队列）→ Go 再包一层（先自旋赌快、再 gopark 挂 G 不挂 M；正常/饥饿双模式，1ms 切换）。金句："锁慢慢在竞争，不慢在锁"。

**Q2：atomic 和 Mutex 怎么选？**
要点：单字长的计数/标志/指针发布 → atomic（无阻塞、纳秒级）；多字段一致性/复合逻辑 → Mutex。加分：CAS 重试的乐观并发思想 + ABA 问题及版本号解法；提 atomic.Pointer 只读快照发布模式（RCU 味道）。

**Q3：Go 的 map 为什么不是并发安全的？并发写会怎样？**
要点：性能优先的设计选择（加锁惩罚所有单线程用户）；运行时有竞态检测位，并发写触发 **fatal error，不可 recover**（不是 panic！进程直接死）。方案：Mutex+map（默认）、分片、sync.Map（读爆多/key 只增两场景）。

**Q4：讲讲 Go 的 happens-before。**
要点：定义（B 读保证看到 A 写的充要条件）；四大来源背两个例子（channel send/recv、Unlock/Lock）；强调无同步的普通读写零保证（编译器+CPU 双重乱序）。加分：atomic 全序（≈seq_cst）是 1.19 才写进文档的；举 done-flag 反例。

**Q5：什么是伪共享？怎么发现和解决？**
要点：缓存一致性以 64B 行为单位 → 不同变量同行 → 多核乒乓 → 无锁却负扩展。解：padding/本地累加。发现：perf c2c、或"加核变慢"的反常压测曲线。

**Q6：死锁四条件？工程里怎么防？**
要点：互斥/持有并等待/不可剥夺/循环等待；主打循环等待——全局锁序（按 ID 排序加锁）。Go 特色补充：Mutex 不可重入、局部死锁不报 fatal 要靠 dump。加分：活锁（随机退避解）与饥饿（公平模式解）的区分。

**Q7：RWMutex 一定比 Mutex 快吗？**
要点：不一定——读临界区极短时读者计数的原子开销+缓存争用反超；写者会被持续读流饿（Go 实现里写者到达后新读者排队，缓解但有代价）。结论：默认 Mutex，profile 证明读远多于写且读临界区可观再换。

**Q8：如何设计"恰好一次"执行？**
要点：先破题——跨系统 exactly-once 不存在，只有"至少一次投递 + 幂等消费"。单机：原子占坑（LoadOrStore）；分布式：唯一约束/SETNX + 幂等键贯穿副作用；配状态机拒绝非法重复迁移。能把 4.1/4.2 讲成方案的就是加分项。

## 12. 本章总结

- 竞态两形态（读改写 / 查再做），修法都是"把决定权收敛到一个原子点"：atomic、锁、LoadOrStore、唯一约束。
- 锁的成本结构：无竞争 ≈ 一次 CAS；有竞争才睡觉。优化顺序：缩临界区 → 分片 → 无锁快照。
- happens-before 是可见性的唯一凭证；无同步的共享读写没有任何直觉可言。
- Agent 并发骨架三件套：幂等占坑、迁移表状态机、有界限流——四类经典事故全部有解。

**检查清单**：
- [ ] 我能用两种形态归类任何一个竞态 bug，并说出对应原子化手段
- [ ] 我能讲出 futex 快慢路径和 Go Mutex 双模式的权衡
- [ ] 我能默写 channel/Mutex 建立 happens-before 的两条规则
- [ ] 我能解释伪共享的乒乓机制和 64 这个数字
- [ ] 我的 Runner 通过"并发重复提交 + 迟到取消 + 双完成"攻击测试（示例 05）

## 13. 延伸阅读

- 《The Art of Multiprocessor Programming》第 7 章（自旋锁与竞争）
- LWN: *A futex overview and update*；Ulrich Drepper: *Futexes Are Tricky*
- Go 官方内存模型文档（2022 重写版）；Russ Cox 内存模型三部曲博客
- 本仓库 `go/knowledge/09_sync_primitives.md`（Mutex/WaitGroup 源码）、`13_memory_model.md`（store buffer 实验）、`25_channel_select_semaphore.md`
- perf c2c 教程（Joe Mario）——伪共享定位实操
