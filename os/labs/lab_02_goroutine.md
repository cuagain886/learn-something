# Lab 02 · goroutine 与并发：从 schedtrace 到竞态取证

> 配套章节：[03 线程协程与调度](../knowledge/03_thread_coroutine_scheduling.md)、[04 并发与同步](../knowledge/04_concurrency_synchronization.md) · 配套代码：[`code/02_concurrency`](../code/02_concurrency)
>
> 规则不变：先写预测，再动手。实验 1–5 对应 03 章，6–8 对应 04 章。
> 本 lab 大部分实验跨平台；标注 🐧 的需要 Linux/WSL2。

---

## 实验 1：goroutine vs 线程的内存账 🐧

**目的**：亲手量出"轻量"的数量级差距。

```bash
# A. 10 万 goroutine 的代价
cat > /tmp/g.go <<'EOF'
package main
import ("fmt"; "runtime"; "time")
func main() {
    var ms runtime.MemStats
    runtime.ReadMemStats(&ms); before := ms.Sys
    for i := 0; i < 100000; i++ { go func() { time.Sleep(time.Hour) }() }
    time.Sleep(time.Second)
    runtime.ReadMemStats(&ms)
    fmt.Printf("10万 goroutine ≈ %d MB (≈%d KB/个)\n",
        (ms.Sys-before)>>20, (ms.Sys-before)>>10/100000)
}
EOF
go run /tmp/g.go

# B. 对比线程：默认线程栈的虚拟大小
ulimit -s        # 通常 8192 KB —— 单线程【虚拟】栈就是 8MB
# 10 万线程 = 800GB 虚拟空间 + 页表开销, 根本创建不出来（试试 C 或 Java 就知道）
```

**预期观察**：每个空闲 goroutine ~2–4KB；对比线程 8MB 虚拟栈，差距 3 个数量级。

**思考题**：goroutine 栈为什么敢从 2KB 起步？靠什么机制长大？长大时最贵的操作是什么？（提示：morestack 整栈拷贝 + 指针修正）

## 实验 2：读懂 schedtrace（03 章 §3.2）

**目的**：把 GMP 从图变成滚动的真实数字。

```bash
cd <repo>/os/code
GODEBUG=schedtrace=200 go run ./02_concurrency/02_cpu_starvation
```

**预期观察**：每 200ms 一行：
```text
SCHED 1004ms: gomaxprocs=8 idleprocs=0 threads=14 spinningthreads=1 runqueue=9 [3 2 0 1 4 0 2 1]
```
- `gomaxprocs=8`：P 的数量；`idleprocs=0`：无空闲 P = CPU 压满阶段；
- `threads=14`：M 的数量（> P 数，因为有 sysmon、陷 syscall 的 M）；
- `runqueue=9`：全局队列长度；`[3 2 ...]`：每个 P 的本地队列长度。
- 场景②（无限制烧 CPU）时 runqueue/本地队列明显变长——就绪的 G 在排队，这就是延迟。

**思考题**：threads 为什么比 gomaxprocs 大？什么情况下会大很多？（提示：03 章 §3.4 M 增生三大户）

## 实验 3：观察异步抢占（03 章 §3.3）🐧

**目的**：验证 Go 1.14+ 靠 SIGURG 抢占紧循环。

```bash
cat > /tmp/tight.go <<'EOF'
package main
func main() {
    go func() { for {} }()   // 紧循环, 无函数调用 = 无协作检查点
    ch := make(chan int); <-ch // main 等着(永远), 只为让程序活着
}
EOF
go build -o /tmp/tight /tmp/tight.go
strace -f -e trace=tgkill /tmp/tight 2>&1 | head -20
```

**预期观察**：持续的 `tgkill(..., SIGURG)` ——sysmon 每发现紧循环 G 跑超 ~10ms 就发信号抢占。加环境变量 `GODEBUG=asyncpreemptoff=1` 重跑，tgkill 消失（关闭异步抢占，退回 1.13 行为）。

**思考题**：1.13 以前这个程序会有什么灾难性行为？（提示：GC 需要 STW 时等一个永不到检查点的 G → 整个程序冻结）

## 实验 4：syscall 阻塞与 M 增生（03 章 §3.4）🐧

**目的**：亲眼看到"阻塞 syscall 越多，线程越多"。

```bash
cat > /tmp/mgrow.go <<'EOF'
package main
import ("fmt"; "os"; "runtime"; "time")
func main() {
    fmt.Println("GOMAXPROCS =", runtime.GOMAXPROCS(0))
    for i := 0; i < 64; i++ {
        go func(n int) {  // 64 个 G 同时做慢速磁盘 I/O(阻塞 syscall)
            f, _ := os.Open("/dev/urandom")
            defer f.Close()
            buf := make([]byte, 1<<20)
            for { f.Read(buf); time.Sleep(time.Millisecond) }
        }(i)
    }
    time.Sleep(3 * time.Second)
}
EOF
go run /tmp/mgrow.go &
sleep 2; ps -o nlwp -p $(pgrep -f mgrow | head -1)   # nlwp = 线程数
wait
```

**预期观察**：线程数（nlwp）明显大于 GOMAXPROCS——G 陷入 syscall 带走 M，runtime 补新 M 维持 P 的消费。

**思考题**：换成 64 个 G 同时做**网络** I/O，线程数还会暴涨吗？为什么？（提示：netpoller，08 章）

## 实验 5：三种泄漏与 pprof 定位（03 章 §9）

**目的**：跑通"水位对比 + 创建栈聚类"的定位流程。

```bash
cd <repo>/os/code && go run ./02_concurrency/01_goroutine_leak
```

**预期观察**：三个 leaky 版本各净增 10 个 G，三个 fixed 版本归零；结尾的全量栈 dump 里能看到卡在 `chan send`/`chan receive` 的泄漏 G 及其创建位置。

**进阶**：给任意长跑服务加 `import _ "net/http/pprof"`，实践两次采样相减法：
```bash
curl -s localhost:6060/debug/pprof/goroutine?debug=1 > /tmp/a; sleep 600
curl -s localhost:6060/debug/pprof/goroutine?debug=1 > /tmp/b; diff /tmp/a /tmp/b | head
```

## 实验 6：-race 抓两种形态的竞态（04 章 §2.2）

```bash
cd <repo>/os/code
go run ./02_concurrency/03_race_deadlock          # 先看症状: 丢加/双开
go run -race ./02_concurrency/03_race_deadlock    # 再看取证报告
```

**预期观察**：race 报告给出 `WARNING: DATA RACE` + 冲突的读写栈 + 两个 goroutine 的创建栈。读报告的固定姿势：先看两个冲突操作各在哪行，再看它们所属 G 是谁创建的。

**思考题**：为什么 `-race` 过了不能宣布无竞态？CI 里应该怎么配？（提示：只检测执行到的路径；CI 用 -race 跑全量测试 + 高并发的集成测试）

## 实验 7：锁序死锁取证（04 章 §3.6）

```bash
go run ./02_concurrency/03_race_deadlock -deadlock
```

**预期观察**：错误版 2 秒无进展但**进程不崩**（main 还活着，runtime 不报 fatal）；修复版千轮双向转账无事。

**进阶取证**：死锁挂住期间给进程发 `kill -QUIT <pid>`（🐧）导出全量栈，找两个卡在 `sync.runtime_SemacquireMutex` 的 G，标出各自已持有/正在等的锁——这是读真实死锁 dump 的完整流程。

**思考题**：为什么"按 id 排序加锁"能从四条件层面根治死锁？（提示：循环等待被全序打破——资源有序分配法）

## 实验 8：状态机攻击测试（04 章 §4）

```bash
go run ./02_concurrency/05_task_state_machine
go run -race ./02_concurrency/05_task_state_machine   # 状态机自身无竞态
go run ./02_concurrency/04_worker_pool                # 顺带体会有界队列的拒绝
```

**预期观察**：100 并发提交只执行 1 次；200 轮取消赛跑两边各有胜负但无状态错乱；终态改写全部被拒。

**思考题**：如果把清理逻辑从"终态迁移钩子"挪到"取消请求的 handler 里"，会产生什么 bug？（提示：完成赢了赛跑时没人清理；两边都清理时 double-free）

---

## 验收清单

- [ ] 我量出过 goroutine 与线程的内存差距，能讲出三笔账
- [ ] 我能逐字段解读一行 schedtrace，并说出 runqueue 变长意味着什么
- [ ] 我见过 SIGURG 抢占的 strace 证据，知道 1.14 分水岭
- [ ] 我验证过阻塞 syscall 导致 M 增生，并能解释网络 I/O 为何例外
- [ ] 我能读懂 -race 报告和死锁 dump，各自有固定的阅读姿势
- [ ] 我的状态机通过三种并发攻击，清理钩子恰好执行一次
