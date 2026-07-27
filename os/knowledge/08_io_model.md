# 08 · I/O 模型：epoll、netpoller 与背压 ⭐⭐⭐⭐

> 对应代码：[`../code/04_io`](../code/04_io)（04_epoll_echo、05_slow_client）· 对应实验：[lab_04](../labs/lab_04_io.md) 实验 5–7
>
> 本章回答：为什么大量连接不需要一个连接一个线程？为什么慢客户端会造成内存堆积？为什么写阻塞会影响系统？为什么 CPU 不高但请求很慢？

## 1. 本章目标

- 精确区分五种 I/O 模型，尤其是"同步非阻塞"与"异步"的界线；
- 掌握 select/poll/epoll 的演进逻辑与 epoll 的三个关键设计；
- 说清 LT 与 ET 的差异及各自的编程约束；
- 理解 Go netpoller 如何把 epoll 藏在 goroutine 的同步外表下；
- **工程输出**：慢客户端防御与输出缓冲限制。

## 2. 核心概念

### 2.1 一次网络读的两个阶段

理解所有 I/O 模型的钥匙：**`read` 一个 socket 分两个阶段**——

```text
阶段 1: 等待数据就绪   (数据从网络到达 → DMA 进内核 socket 接收缓冲区)
阶段 2: 拷贝数据       (内核缓冲区 → 用户态 buf)
```

五种模型的区别，全在于**这两个阶段分别是谁在等、怎么等**：

| 模型 | 阶段 1（等就绪） | 阶段 2（拷贝） | 特点 |
|---|---|---|---|
| **阻塞 I/O** | 线程挂起等待 | 线程等待拷贝完 | 最简单；一连接一线程 |
| **非阻塞 I/O** | 立即返回 EAGAIN，**应用轮询** | 线程等待拷贝完 | 轮询烧 CPU，很少单独用 |
| **I/O 多路复用** | **阻塞在 select/epoll 上**（可同时等 N 个 fd） | 线程等待拷贝完 | 一个线程管海量连接；主流 |
| **信号驱动 I/O** | 内核用 SIGIO 通知 | 线程等待拷贝完 | 信号处理复杂，罕用 |
| **异步 I/O (AIO)** | 内核全包 | **内核全包**，完成后通知 | 真异步；Linux 上是 io_uring |

⚠️ **面试关键区分**：前四种都是**同步 I/O**——因为**阶段 2 的拷贝都是应用线程自己在做（会阻塞）**。只有 AIO 是异步：应用发起后什么都不管，内核连拷贝都做完了才通知你。"I/O 多路复用是异步的"是常见错误说法——它是**同步的非阻塞多路复用**。

**Windows 的 IOCP 是真 AIO，Linux 的 epoll 不是**——这是 Reactor 与 Proactor 两种模式分野的根源。Linux 的 `io_uring`（5.1+）才是真正可用的异步 I/O，正在逐步改变格局。

### 2.2 select → poll → epoll 的演进

**select（1983）** 的三宗罪：
1. fd 集合用**位图**，上限 `FD_SETSIZE`=1024（编译期固定）；
2. 每次调用要把整个 fd 集合**从用户态拷到内核态**，返回时再拷回来；
3. 返回后只告诉你"有几个就绪"，**不告诉你是哪几个**——应用必须 O(n) 遍历所有 fd 挨个试。

**poll（1986）**：用数组代替位图，解决了 1024 上限，但 2、3 依然存在。

**epoll（Linux 2.5.44, 2002）** 三个关键设计一次解决全部：

```text
epoll_create()  → 内核里创建一个 eventpoll 对象，包含:
                    ① 一棵红黑树: 存所有被监听的 fd (O(log n) 增删改)
                    ② 一个就绪链表: 存已就绪的 fd
                    ③ 一个等待队列: 存阻塞在 epoll_wait 上的进程

epoll_ctl(ADD)  → 把 fd 注册进红黑树，【一次注册长期有效】—— 解决罪状 2
                  同时在该 fd 的等待队列上挂一个【回调函数】
                    ↓
                  数据到达 → 网卡中断 → 协议栈处理 → 唤醒该 fd 的等待队列
                                                    → 触发回调 → 把 fd 挂进就绪链表

epoll_wait()    → 只看就绪链表: 空就睡, 非空就把【就绪的那些】拷给用户 —— 解决罪状 3
                  复杂度 O(就绪数) 而非 O(总数) —— 这是万级连接下的质变
```

**核心洞察**：epoll 把"轮询查找"变成了"事件回调"——**内核在数据到达时主动把 fd 放进就绪链表**，而不是被应用一遍遍问。100 万连接里只有 100 个活跃时，epoll_wait 只处理这 100 个，select 要遍历 100 万个。

⚠️ 但也要说清 epoll 不是万能的：**连接数少而全都活跃时，select/poll 反而可能更快**（epoll 的红黑树维护和系统调用次数不占优）。epoll 的优势场景是"**海量连接 + 低活跃比例**"——这恰好是互联网服务的典型形态。

### 2.3 LT 与 ET：两种触发语义

| | **LT（Level Triggered，水平触发，默认）** | **ET（Edge Triggered，边缘触发）** |
|---|---|---|
| 语义 | 只要缓冲区**还有数据**，每次 epoll_wait 都报告 | 只在**状态发生变化时**报告一次 |
| 类比 | 闹钟响到你起床为止 | 闹钟只响一声，没听见就没了 |
| 编程要求 | 可以只读一部分，下次还会通知 | **必须循环读到 EAGAIN**，否则剩余数据永远收不到 |
| 风险 | 频繁唤醒（如果不及时处理） | 漏读 = 连接卡死（最难查的 bug 之一） |
| 谁在用 | Go netpoller、多数框架的默认 | Nginx、libevent 的高性能模式 |

**ET 的正确写法必须是循环**：
```c
while (1) {
    n = read(fd, buf, size);
    if (n > 0) process(buf, n);
    else if (n == -1 && errno == EAGAIN) break;  // 读干净了，退出
    else if (n == 0) { close(fd); break; }        // 对端关闭
}
```
⚠️ ET 模式下**写事件同理**：不能一直注册可写事件（缓冲区通常都可写 → 疯狂唤醒），正确做法是"**平时不注册写事件，写不完时才注册，写完立刻注销**"。这个模式叫 EPOLLOUT 的懒注册。

### 2.4 Reactor 与 Proactor

- **Reactor（反应堆）**：基于**就绪事件**。"数据可以读了" → 应用自己去 read。epoll/kqueue 都是这一派。经典结构：**主 Reactor 收 accept，子 Reactor 各管一批连接的读写，业务逻辑丢线程池**（Netty、Nginx 的模型）。
- **Proactor（前摄器）**：基于**完成事件**。"数据已经读进你给的 buf 了" → 应用直接处理。Windows IOCP、Linux io_uring 是这一派。

Go 的模型很特别：**底层是 Reactor（epoll），但通过 goroutine 挂起/唤醒，暴露给用户的是同步阻塞式 API**——你写 `conn.Read(buf)` 像在写阻塞代码，实际上 runtime 在背后做多路复用。这是 Go 网络编程"心智负担极低"的根本原因。

### 2.5 零拷贝

传统"读文件发网络"要 4 次拷贝 + 4 次上下文切换：

```text
传统 read + write:
  磁盘 --DMA--> 内核 Page Cache --CPU拷贝--> 用户 buf --CPU拷贝--> socket缓冲 --DMA--> 网卡
                                 ↑ 两次多余的 CPU 拷贝 + 两次态切换

sendfile(out_fd, in_fd, ...):
  磁盘 --DMA--> 内核 Page Cache --(仅传递描述符)--> socket缓冲 --DMA(scatter-gather)--> 网卡
                                 ↑ 零 CPU 拷贝，一次系统调用
```

- **sendfile**：文件 → socket，最经典（Nginx 静态文件、Kafka 消费者拉取）。⚠️ 限制：输入必须是文件，输出必须是 socket，数据**不经过用户态所以无法修改**（不能压缩/加密）。
- **splice**：通过管道在两个 fd 间传数据，更灵活（可 socket→socket）。
- **mmap + write**：省一次拷贝（不是零拷贝），但适合需要读写内容的场景。
- Go 里 `io.Copy` 在符合条件时（`*os.File` → `*net.TCPConn`）**自动使用 sendfile**——`ReadFrom`/`WriteTo` 接口的作用就是给这类优化开后门。

**DMA（Direct Memory Access）**：设备直接读写内存，不占用 CPU。这是"零拷贝"里"零"的物理基础——CPU 只下指令，搬运由 DMA 控制器完成。

## 3. 底层原理：Go netpoller 全链路

这是本章最重要的一节——把第 03 章的 GMP 和本章的 epoll 缝合起来：

```text
① 建立连接: net.Listen/Dial
   └→ socket() 创建 fd
   └→ 【关键】setNonblock(fd) —— Go 把所有网络 fd 设为非阻塞!
   └→ epoll_ctl(ADD, fd, EPOLLIN|EPOLLOUT|EPOLLET)  ← Go 用 ET 模式
      并把一个 pollDesc 结构关联到该 fd (记录等待读/写的 goroutine)

② 用户代码: n, err := conn.Read(buf)     ← 看起来是阻塞调用
   └→ runtime 执行 read(fd, buf) 系统调用
      ├─ 有数据 → 直接返回，goroutine continue    (快路径，零调度开销)
      └─ 返回 EAGAIN(没数据) →
          └→ gopark(): 把当前 goroutine 挂起, 状态置 Gwaiting
             把 g 的指针记进该 fd 的 pollDesc
             ⚠️ 【M 不阻塞】—— M 立刻去运行队列里拿下一个 G 跑
                这就是"一个 goroutine 阻塞不影响其他 goroutine"的网络版答案

③ 数据到达: 网卡中断 → 协议栈 → socket 接收缓冲区有数据 → 该 fd 就绪

④ 发现就绪: runtime 在多个时机调用 netpoll(0) 非阻塞地查一次 epoll_wait:
   - 调度循环里(第03章 §3.2 的第④级)
   - sysmon 后台监控(每 10ms 级)
   - GC 的 STW 前后
   └→ epoll_wait 返回就绪的 fd 列表
   └→ 从每个 fd 的 pollDesc 取出挂着的 goroutine
   └→ goready(): 把它们置为 Grunnable, 塞进运行队列

⑤ 被调度: 某个 M 取到这个 G, 从 gopark 处继续执行 → 重新 read → 这次有数据 → 返回
```

**这套设计的四个结果**：
1. **一个 goroutine 一个连接是可行的**：goroutine 挂起只占 ~2KB 栈（第 03 章），不占线程。10 万连接 = 10 万 goroutine ≈ 几百 MB，而 10 万线程根本创建不出来。
2. **M 的数量与连接数无关**：网络阻塞不消耗 M（对比第 03 章磁盘 I/O 的 M 增生），所以线程数稳定在 GOMAXPROCS 附近。
3. **心智负担为零**：用户写同步代码，runtime 做异步复用——没有回调地狱、没有 async 传染。
4. **代价是 runtime 复杂度**：netpoller 与调度器、GC 深度耦合；也意味着**你无法轻易换掉它**（想用 io_uring 得绕开标准库）。

## 4. 关键工程设计：慢客户端与背压

### 4.1 慢客户端为什么危险

```text
你的服务: 生成 100MB 响应, conn.Write(data)
客户端:   4G 网络 + 后台挂着, 每秒只读 10KB

内核 socket 发送缓冲区(默认几百 KB, wmem) 很快填满
   ↓
conn.Write 阻塞 (Go 里: goroutine 挂起等 EPOLLOUT)
   ↓
这个 goroutine 挂着不动，它持有的 100MB 响应数据【全程占着内存】
   ↓
1000 个这样的慢客户端 = 100GB 内存 = OOM
```

⚠️ **这是"慢客户端造成内存堆积"的完整机制**——问题不在于 goroutine 本身（很便宜），而在于**它抓着的数据不能释放**。同理，"写阻塞影响系统"的本质是：阻塞的写操作让上游的资源（内存、连接、数据库游标、文件句柄）无法回收，形成反向压力。

### 4.2 四层防御

```go
// ① 写超时 —— 最基本的止损，绝不能省
conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
// Go 的 deadline 由 netpoller 的定时器实现，到期直接让阻塞的 Read/Write 返回 timeout

// ② 流式生成而不是全量缓冲 —— 从源头不持有大对象
// ⚠️ 错误: data := renderAll(); conn.Write(data)      ← 100MB 全在内存
// ✅ 正确: for chunk := range render() { conn.Write(chunk) }  ← 只持有一个 chunk
//    背压天然传导: 客户端读得慢 → Write 阻塞 → 生成也跟着慢下来 → 内存不涨

// ③ 单连接输出缓冲上限 —— 超了就断开
type LimitedConn struct {
    net.Conn
    pending atomic.Int64
    max     int64
}
// 写入前检查 pending，超限直接 Close —— 保护整体优于伺候个体

// ④ 全局在途字节数上限 —— 所有连接的缓冲之和也要有天花板
// (信号量/令牌桶, 第 04 章)
```

**设计哲学**：慢客户端不是错误，是常态（移动网络、后台标签页）。系统必须**有能力把它们踢掉**——**保护整体的可用性优先于伺候单个连接**。这与第 06 章的背压是同一思想在网络层的体现。

### 4.3 Go 中容易忽略的两个细节

- **`http.Server` 的三个超时**：`ReadTimeout`（读完整个请求）、`WriteTimeout`（写完整个响应）、`IdleTimeout`（keep-alive 空闲）。⚠️ **默认全是 0（无超时）**——生产环境不设置就是给慢客户端敞开大门（Slowloris 攻击的原理）。
- **`resp.Body` 必须读完才能复用连接**：只读一部分就 Close，连接会被销毁而非放回池，导致连接池失效、TIME_WAIT 堆积。正确：`io.Copy(io.Discard, resp.Body)` 后再 Close。

## 5. Go 语言示例

| 示例 | 演示内容 |
|---|---|
| [04_epoll_echo](../code/04_io/04_epoll_echo/main.go) | 裸 epoll 系统调用写 echo server（Linux），对照 `net` 包版本理解 netpoller 藏了什么 |
| [05_slow_client](../code/04_io/05_slow_client/main.go) | 慢客户端的内存堆积复现 + 四层防御的效果对比 |

## 6. 后端开发中的应用

- **"CPU 不高但请求慢"的排查顺序**：① `ss -ntp` 看 Recv-Q/Send-Q（Recv-Q 大 = 应用读得慢；Send-Q 大 = 对端收得慢或网络差）→ ② `go tool trace` 看 goroutine 在网络等待还是调度等待 → ③ block profile 看阻塞点 → ④ 下游依赖延迟（数据库慢查询、外部 API）。**多数情况根本不在你的进程里**。
- **连接数容量估算**：每连接成本 = goroutine 栈（~4-8KB 实际使用）+ 读写缓冲（Go 的 bufio 默认 4KB×2）+ 内核 socket 缓冲（可调 wmem/rmem）。10 万连接约 1-2GB——**内核缓冲往往是大头**，`net.core.rmem_default` 等参数要一起算。
- **Nginx 与 Go 服务的分工**：Nginx 的 sendfile+零拷贝擅长静态文件与 TLS 卸载，还能**作为慢客户端的缓冲垫**（Nginx 先完整收下响应再慢慢喂客户端，你的 Go 进程早已释放内存）——这是反向代理最被低估的价值。

## 7. Agent 开发中的应用

- **LLM 流式输出就是慢客户端场景**：用户端网络慢 / 浏览器标签页在后台 → SSE 连接的写阻塞 → 你的 goroutine 抓着已生成的 token 不放。对策：流式转发即丢（不缓冲全量）、写超时、单连接缓冲上限。
- **工具输出的流式转发链路**：子进程 stdout（管道，第 02 章）→ Agent 处理 → SSE 推给用户。**三段的速率必须匹配**——任何一段没有背压，压力就堆在它前面。第 02 章的管道 64KB 是天然背压点（子进程写满就阻塞），要善用而不是绕过。
- **超时要分层**：单次 write 超时（秒级）< 单个工具执行超时（分钟级）< 整个任务超时（更长）。⚠️ 内层超时必须严格小于外层，否则外层超时永远先触发，内层形同虚设。

## 8. 常见问题与错误设计

**错误 1：为每个连接开线程。** Go 里不会犯（goroutine 便宜），但**为每个连接开一个额外的辅助 goroutine 做心跳/统计**是变相的同类错误——10 万连接 × 3 个 goroutine = 30 万，调度开销和 GC 扫描成本开始显现。

**错误 2：不设任何超时。** `http.Server{}` 零值就上生产是最常见的事故源。**最小配置**：ReadHeaderTimeout（防 Slowloris）、WriteTimeout、IdleTimeout。

**错误 3：把 epoll 当银弹。** 连接少而活跃度高时，多路复用的收益有限。真正的高性能要看整体架构（连接复用、批处理、零拷贝），不是"用了 epoll 就快"。

**错误 4：ET 模式不循环读。** 自己写 epoll 时最容易踩——读一次就返回，剩余数据不再触发，连接静默卡死。用 Go 的 `net` 包就不用担心（runtime 处理了）。

## 9. 排障方法

**案例：服务内存缓慢增长，pprof 显示大量 `[]byte` 存活，goroutine 数正常。**
- **现象**：heap profile 里 `bytes.makeSlice` 或响应构造函数占大头；goroutine 总数不高（排除泄漏）。
- **原因假设**：goroutine 数量不多但每个抓着大对象——典型慢客户端/慢下游。
- **验证**：
  ```bash
  ss -ntp state established '( dport = :443 or sport = :8080 )' | head -20
  # 看 Send-Q 列: 大量连接 Send-Q 高 = 数据发不出去, 堆在内核缓冲
  curl -s localhost:6060/debug/pprof/goroutine?debug=2 | grep -c 'net.*Write'
  # 有多少 goroutine 卡在网络写上
  ```
- **判决**：Send-Q 普遍高 + 大量 goroutine 在 `internal/poll.(*FD).Write` → 慢客户端确认。
- **解决**：加写超时 + 改流式 + 单连接缓冲上限（4.2 四层）。回归：Send-Q 分布回归正常，heap 平稳。

**工具速查**：`ss -ti`（看 TCP 详细状态含 cwnd/rtt）、`ss -s`（连接状态汇总，快速看 TIME_WAIT/CLOSE_WAIT 是否异常）、`netstat -s`（协议栈统计，看重传/丢包/溢出计数）、`go tool trace`（Network blocking profile）。

## 10. 实验任务

[lab_04_io.md](../labs/lab_04_io.md) 实验 5–7：⑤ 裸 epoll echo server 与 net 包版本的 strace 对比；⑥ 慢客户端的内存堆积复现与防御验证；⑦ `ss` 读懂 Recv-Q/Send-Q。

## 11. 面试题（附答题要点）

**Q1：讲讲五种 I/O 模型。**
要点：先给"两个阶段"框架（等待就绪 + 拷贝数据），再逐个说各阶段的行为差异。**关键**：前四种都是同步 I/O（阶段 2 应用自己拷），只有 AIO 是异步。加分：Linux 的 AIO 长期不好用，io_uring 才是真正可用的答案。

**Q2：select、poll、epoll 的区别？**
要点：select 三宗罪（1024 上限 / 每次全量拷贝 / 返回后 O(n) 遍历）；poll 解决第一个；epoll 用红黑树（一次注册）+ 回调机制（内核主动放进就绪链表）+ 只返回就绪的，做到 O(就绪数)。加分：epoll 的优势在"海量连接 + 低活跃比"，全活跃时未必赢；提 kqueue（BSD）、IOCP（Windows）的对应关系。

**Q3：LT 和 ET 的区别？ET 编程要注意什么？**
要点：LT 只要有数据就一直通知，ET 只在状态变化时通知一次。ET 必须**循环读到 EAGAIN**，否则丢数据；写事件要懒注册（写不完才注册 EPOLLOUT，写完注销）。加分：Go netpoller 用 ET；Nginx 也用 ET，图的是减少 epoll_wait 唤醒次数。

**Q4：Go 的 netpoller 是怎么工作的？（高频）**
要点：完整讲 §3 的五步链路——所有网络 fd 设非阻塞 + epoll ET 注册；Read 遇 EAGAIN 就 gopark 挂起 goroutine（**M 不阻塞，去跑别的 G**）；runtime 在调度循环/sysmon/GC 时机调 netpoll 查就绪；就绪后 goready 唤醒。**结论**：同步的代码外表 + 异步的底层实现。加分：对比磁盘 I/O 会导致 M 增生（第 03 章），网络 I/O 不会。

**Q5：为什么大量连接不需要一个连接一个线程？**
要点：线程 8MB 栈 + 切换 μs 级 → 万级就撑不住；epoll 让一个线程能等 N 个 fd；Go 更进一步用 goroutine（2KB 栈）做每连接的执行流，阻塞时不占线程。数字对比：10 万 goroutine ≈ 几百 MB，10 万线程 ≈ 不可能。

**Q6：什么是零拷贝？sendfile 的原理？**
要点：传统 read+write 有 2 次多余 CPU 拷贝 + 4 次态切换；sendfile 让数据不出内核（Page Cache → socket 缓冲，配合 scatter-gather DMA 可做到 0 次 CPU 拷贝）。限制：数据不经用户态所以不能修改。加分：splice 更通用；Go 的 io.Copy 自动用 sendfile；Kafka 的高吞吐部分归功于此。

**Q7：慢客户端为什么会拖垮服务？怎么防？**
要点：机制——发送缓冲满 → write 阻塞 → goroutine 挂起 → **它持有的响应数据无法释放** → 累积 OOM。四层防御：写超时、流式生成不全量缓冲、单连接缓冲上限、全局在途上限。加分：Slowloris 攻击原理相同；反向代理作为缓冲垫的价值；Go http.Server 默认零超时是坑。

**Q8：CPU 不高但请求很慢，怎么查？**
要点：说明 CPU 空闲意味着"在等"——按序排查：ss 看队列（应用读慢还是网络慢）→ trace/block profile 看阻塞点 → 锁竞争（第 04 章）→ 下游延迟 → D 状态磁盘 I/O（第 10 章）。**核心思路：找到"等什么"，而不是找"谁在算"**。

## 12. 本章总结

- 所有 I/O 模型的差异都在"等就绪"和"拷数据"两阶段的处理方式；同步/异步的界线在阶段 2。
- epoll 的三个设计（红黑树一次注册、就绪回调、只返回就绪的）把 O(n) 变成 O(就绪数)；LT 省心，ET 高效但必须循环读到 EAGAIN。
- Go netpoller = 非阻塞 fd + epoll ET + goroutine 挂起唤醒，让同步代码跑出异步性能，且网络阻塞不消耗 M。
- 慢客户端的危害不是 goroutine 多，是**挂起的 goroutine 抓着数据不放**；四层防御的核心是"保护整体优先于伺候个体"。

**检查清单**：
- [ ] 我能用"两个阶段"框架推导出五种模型，并说清同步/异步的界线
- [ ] 我能画出 epoll 的三个数据结构和数据到达时的回调路径
- [ ] 我能完整讲出 netpoller 的五步链路，指出每步在用户态还是内核态
- [ ] 我能解释慢客户端导致 OOM 的完整因果链和四层防御
- [ ] 我知道 http.Server 的三个超时默认值是 0，并且永远会设置它们

## 13. 延伸阅读

- 《UNIX 网络编程 卷1》第 6 章（I/O 模型的经典出处）
- 《The Linux Programming Interface》第 63 章（备选 I/O 模型）
- `man 7 epoll`（LT/ET 语义的权威说明）
- Go 源码 `runtime/netpoll.go` 与 `internal/poll/fd_poll_runtime.go`
- 本仓库 `go/knowledge/16_http_netpoll.md`、`27_syscall_cgo_netpoll.md`
- io_uring 入门：*Efficient IO with io_uring*（Jens Axboe）
