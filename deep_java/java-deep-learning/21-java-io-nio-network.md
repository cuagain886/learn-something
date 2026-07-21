# 21. Java I/O、NIO 与网络：字节边界、就绪事件和背压

> 优先级：A｜难度：★★★★★｜基线：JDK 21；Windows 11 已验证，Linux 映射需复验｜前置：[07 运行时区域](07-jvm-runtime-areas.md)、[18 并发](18-thread-pool-and-virtual-thread.md)

## 1. 本章目标

完成后应能解释字节流与字符解码的边界；熟练推导 Buffer 的 position/limit/capacity；知道非阻塞 read/write 可部分完成或返回 0；能写 length-field framing，处理半包/粘包和慢消费者；能限定 Selector、epoll、sendfile、mmap、“零拷贝”和 DirectByteBuffer 的平台结论。

## 2. I/O 首先是字节与协议

网络、文件和进程管道传输字节。`InputStream/OutputStream` 面向字节；`Reader/Writer` 在字节与 UTF-16 `char` 序列间按 Charset 编解码。默认 charset 受 JDK/启动环境影响，持久化和协议必须显式指定 UTF-8 等编码。

```java
try (Reader reader = new InputStreamReader(input, StandardCharsets.UTF_8)) { ... }
```

一个 Unicode code point 可能跨两个 `char`（surrogate pair），一个 UTF-8 字符可能跨多次网络 read。不能对每个收到的 byte chunk 独立 `new String(chunk, UTF_8)`：多字节序列被截断时会替换/报错。应让 CharsetDecoder 保留跨 chunk 状态，或先完成协议 frame 再一次解码完整文本字段。

`read(byte[])` 返回本次实际字节数，可能小于数组；-1 才是 EOF。对 socket，EOF 表示对端有序关闭输出侧，不代表本地 write 一定失败；TCP half-close 需要协议明确。`available()` 只表示无需阻塞可读的估计，不是消息总长度。

## 3. 装饰器与资源所有权

`BufferedInputStream` 减少小 read 的系统调用；`DataInputStream` 定义 primitive binary 编码；`GZIPInputStream` 解压；它们按装饰器组合。关闭最外层通常向内关闭底层，API 必须声明谁拥有流：库方法若只借用调用方 stream，不应擅自 close。

try-with-resources 逆序关闭，主异常保留，关闭异常放 suppressed。网络/文件关闭仍可能阻塞或失败；高可靠上传要区分“写入用户缓冲”“写入内核 page cache”“`force/fsync` 持久化”与“远端确认”，`flush` 不是通用持久化承诺。

大文件处理应流式：固定大小 buffer → 增量解析/写出 → 有界队列。`readAllBytes`、`Files.readString`、把 multipart 全放 byte[] 会让并发请求把 heap 放大为 `concurrency × maxFileSize`。

## 4. Channel 与 Buffer 的状态机

Channel 表示可读/写连接；Buffer 表示待填充或待消费的内存窗口。核心不变量：

```text
0 <= mark <= position <= limit <= capacity
```

典型读循环：

```java
int n = channel.read(buffer); // 写入 buffer：position 前进
buffer.flip();               // limit=position, position=0，切换为读取
consume(buffer);             // get 使 position 前进
buffer.compact();            // 未消费数据移到开头，position=remaining
```

`clear()` 只是 position=0、limit=capacity，不擦除字节；适合旧数据全部消费。frame 未完整时用 `compact` 保留尾部。`rewind()` position=0 但 limit 不变，用于重读当前窗口。忘记 flip 常读到“剩余空位”，误用 clear 会丢半帧。

ByteBuffer 默认 big-endian，可显式 order；协议字段字节序必须固定。slice/duplicate 共享底层存储但有独立 position/limit/mark，跨线程使用共享内容仍需同步或不可变所有权。

## 5. Heap、Direct 与 mapped buffer

HeapByteBuffer 的 backing array 在 Java heap，GC 可见且数组访问方便；native I/O 可能需要临时复制/pin。DirectByteBuffer 使用堆外 native memory，Channel 能更直接与 native I/O 交互，但分配/回收更贵，受 `MaxDirectMemorySize` 和 Cleaner/可达性影响。

不要按每条小消息 `allocateDirect`；使用有界池/arena，明确归还。slice 仍引用整个底层 buffer，小切片长期存活会保住大块 native memory。`ByteBuffer` 本身的 Java 对象很小也不代表 native 内存小，排障要结合 NMT、direct buffer pool/JMX、RSS。

标准 API 没有普通的 `free(ByteBuffer)`。内部 cleaner 强制释放依赖未支持 API且有 use-after-free 风险。通过短生命周期与解除引用等待 Cleaner 适合普通场景；需要确定性 native 生命周期可评估 Foreign Memory API 的 Arena（按目标 JDK 版本），或成熟池。

`MappedByteBuffer` 把文件区间映射进虚拟地址空间，按页 fault，由 OS page cache 管理。它减少显式 read/copy 并支持随机访问，但不是“文件全在物理内存”；大映射影响地址空间/RSS，文件截断、磁盘错误可能产生平台异常。`force()` 请求刷脏页，不等于跨所有硬件/文件系统的绝对持久性证明。Windows 上活映射还可能阻止文件删除/替换，必须做平台测试。

## 6. 阻塞、非阻塞与异步不是同义词

- blocking SocketChannel：read 没数据时阻塞当前线程；虚拟线程在受支持操作可 unmount。
- non-blocking channel：read/write 立即返回，可返回 0；应用用 Selector 监听 readiness。
- asynchronous channel：提交操作后由 Future/CompletionHandler 接收 completion，底层实现随平台不同。

readiness 表示“现在尝试通常不会阻塞”，不是“一条完整消息准备好”，也不是操作一定把请求长度全部完成。completion 表示某次异步操作已完成，但仍需看返回字节数、EOF/错误。

虚拟线程让阻塞式 thread-per-connection 再次可扩展，降低 Reactor 状态机复杂度；Selector/Reactor 仍适合已有 Netty 生态、极细资源控制或事件驱动协议。选择不应基于“阻塞一定旧、NIO 一定快”。

## 7. Selector 的注册与选择

SelectableChannel 必须 `configureBlocking(false)` 后注册 Selector，并给 interest ops。`SelectionKey` 的 ready set 是本次观察到的就绪位，常见 `OP_ACCEPT/CONNECT/READ/WRITE`。

```text
select
  → iterate selectedKeys（必须 remove/clear 已处理 key）
    → accept/read/write
      → 修改 interestOps
        → 回到 select
```

`OP_WRITE` 多数 socket 大多数时间都 ready；若一直注册，每轮 selector 都返回造成 busy loop。只有 outbound queue 非空且上次 write 未排空时注册，排空后移除。

其他线程修改任务/interest 时，把任务放入 MPSC queue 并 `selector.wakeup()`；wakeup permit 不计数式累积，event loop 醒来后先 drain tasks。直接从多个线程并发改 attachment/业务状态会破坏 single-owner 模型。

取消 key 后 channel/资源的真正清理时机与 selector 处理有关；finally 关闭 channel。selected key 的 attachment 常持连接 buffer/业务对象，泄漏 key 就会泄漏整条会话。

## 8. Selector 与 epoll 的准确关系

Java 定义 Selector 抽象，由 `SelectorProvider` 选择平台实现。Linux HotSpot/JDK 常使用 epoll，macOS 可能 kqueue，Windows 有对应 native selector 实现；这是指定 JDK/OS 实现，不是 Java API 承诺。

epoll 也只报告 fd readiness。边缘/水平触发、eventfd/pipe 唤醒、bug workaround 等属于 JDK/native 实现版本；不要从 Java `select()` 直接声称“使用 edge-triggered epoll”。用 `strace -e epoll_wait`、JDK 源码和目标 build 验证 Linux 映射；当前 Windows 实验不能替代。

连接数受进程文件描述符、端口、内核 socket buffer、NAT/负载均衡、内存和应用连接状态共同限制。提高 `ulimit -n` 只消除一个上限，不自动让 event loop 处理得过来。

## 9. TCP 是字节流：半包与“粘包”是协议问题

一次 write 与一次 read 没有消息边界对应。一个 frame 可被拆成多次 read，多帧也可一次读回；TCP 正常地保证有序字节流，不承诺应用消息包。

常用 framing：

- 定长：简单但浪费/限制明显；
- delimiter：需处理转义、最大扫描长度；
- length-prefix：先固定 header，再读取长度 payload；必须验证负数、上限和整数溢出；
- 自描述格式：HTTP chunked、WebSocket frame 等已有协议。

[NioProtocolLab](examples/io/NioProtocolLab.java) 使用 4-byte big-endian length，故意把包含中文 UTF-8 的两帧切成 1/2/5/3/... 字节喂入。decoder 在 header/payload 不完整时 reset 并 compact，实测精确恢复 `模型` 与 `tool-output`。

最大 frame 必须在分配前校验，不能先 `new byte[length]` 再判断。协议还应定义 version、type、correlation id、checksum/压缩标志，以及畸形帧是断连还是返回错误。

## 10. 部分写、慢客户端与背压

non-blocking `write(buffer)` 可能只消费部分字节甚至返回 0。必须保留同一个 buffer 的剩余 position，下次 OP_WRITE 继续；不能认为“调用成功就是整帧已发”。仓库 `PartialChannel` 每次最多写 3 bytes，协议样例的 wire 通过 9 次 write 才排空。

每连接 outbound queue 若无界，慢客户端会占满 heap/direct memory。典型水位：

```text
queuedBytes < lowWater   → 允许上游继续
queuedBytes > highWater  → 暂停读/模型流，或断开慢消费者
queuedBytes > hardLimit  → 明确失败并释放连接
```

计数用 bytes 而不是消息数；一个 tool log message 可能数 MB。暂停 OP_READ 只阻止继续读客户端，不会自动暂停正在生成的模型输出；背压必须沿 Publisher/订阅、模型 HTTP body、工具 stdout 一路传播。若上游不可暂停，只能有界丢弃、落盘或取消，并在协议中标记 gap。

event loop 不做阻塞业务/大 JSON/模型调用。它负责短小状态转换，把 CPU/阻塞任务移交有界 executor/虚拟线程，完成后向 event loop 投递结果；同时保持每连接事件顺序和取消检查。

## 11. Reactor 与 Netty EventLoop

单 Reactor 把 accept/read/write 和协议状态集中在一个 owner；多 Reactor 常有 boss accept、worker loops 负责连接。Netty 的 Channel 绑定 EventLoop，handler pipeline 顺序处理事件，ByteBuf 池与引用计数降低分配/复制。

EventLoop 的价值不只是 Selector 封装：

- 单线程 owner 简化 channel state 并发；
- task queue 串行化跨线程变更；
- pipeline 组合 codec、timeout、TLS、业务；
- buffer pool、watermark 和 promise 统一 I/O 生命周期。

代价是任何 handler 阻塞都会卡该 loop 上多个连接；引用计数 buffer 忘 release 泄漏，过早 release 是 use-after-free。Netty leak detector 用于发现而非替代所有权设计。

## 12. FileChannel、scatter/gather 与“零拷贝”

FileChannel 支持 position、positional read/write、lock、map、`transferTo/transferFrom`。仓库 [FileChannelLab](examples/io/FileChannelLab.java) 写 6400 bytes、force，再循环 `transferTo` 直到 size 完成并逐字节核对，最后删除独立临时目录。

必须循环：`transferTo` 返回值可能小于 count，甚至受 OS/JDK 限制；不能一次调用后假设完成。文件位置、目标 channel backpressure 和 size 变化也要处理。

Linux 上 file→socket 的 transfer 可能映射 sendfile 等内核路径，减少用户态复制/上下文切换；TLS、压缩、目标类型或平台可能退化。所谓“zero-copy”通常不是物理世界零次 copy，而是减少用户空间数据搬运。结论要用目标 OS 的 syscall/profile 验证。

scattering read 把字节依次填多个 buffers（如 header+body），gathering write 从多个 buffers 依次写（如 header+payload）。它不替代 frame 状态机：header 可能仍只读一半，gather write 也可部分完成。

## 13. 连接生命周期与超时

网络需要分阶段 timeout：DNS、connect、TLS handshake、request headers、body idle、overall deadline。只设 connect timeout 无法阻止慢响应；只设总 timeout 难区分故障层。

Selector reactor 通常用 timer wheel/min-heap 管 deadline，触发时回 event loop 关闭/取消 key。虚拟线程阻塞风格可用带 timeout API和父任务 deadline，但仍要关闭 channel 才能终止某些阻塞/下游。

TCP keepalive 是长时间死 peer 检测，不等于应用请求 timeout；HTTP keep-alive 是连接复用，名字相同层次不同。心跳也需序列和最大无响应时间，避免网络分区中双方都保留幽灵状态。

## 14. Agent 流式场景

### 模型流

HTTP/SSE chunk 不等于 token/JSON event；decoder 必须跨 chunk 累积 UTF-8 和行/event 字段。收到 usage/finish/错误 terminal 后只能结束一次，取消要关闭 body subscription 并释放模型 permit。

### 工具 stdout/stderr

子进程两条 pipe 都要并发排空，否则任一 OS pipe 满会让进程阻塞。设总 bytes/行长上限、增量 UTF-8 decoder、敏感信息 redaction；超限时取消进程树而非继续无界缓存。

### 文件与 RAG

上传流边读边计算 hash/写临时文件/解析，达到上限立即停止；解析器产出有界 chunk channel，embedding 消费慢就反压。只有校验成功才原子发布最终文件，避免失败留下半成品。

### 事件协议

每事件有 run id、单调 sequence、type、schema version；网络断开后客户端带 cursor 重连。内存 ring buffer 有保留窗口，过旧 cursor 明确返回 snapshot/resync，而不是假装无事件丢失。

## 15. 测试与观测

网络测试不能只在一次 localhost happy path：

1. 将 header/payload 在每个可能字节边界切分；
2. 多帧合并、空帧、最大帧、负长度/超大长度/截断 EOF；
3. write 每次只接受 0/1/N bytes；0 时确认注册 OP_WRITE 而非 spin；
4. 慢读/不读客户端，验证 queue high watermark 和取消；
5. 半关闭、RST、TLS 失败、连接成功但响应不来；
6. Linux 用 `ss -tinp`、`lsof`/`/proc/<pid>/fd`、`strace`/JFR 对账；Windows 用对应 ETW/netstat/JFR，不混写命令。

指标：active connections、accept/reject、read/write bytes、event-loop lag、outbound queued bytes、oldest event age、partial writes、decode failures、timeouts by phase、direct/mapped memory。平均 QPS 看不到单个慢连接拖住的内存。

## 16. 常见误区与面试追问

1. **一次 read 对应一次 write**：TCP 只提供有序字节流。
2. **read 返回 0 是 EOF**：-1 才是 EOF；非阻塞 0 是当前无数据。
3. **write 成功就发完 buffer**：看返回 count 和 remaining。
4. **clear 会清零内存**：只重置游标。
5. **DirectBuffer 不受内存限制**：占 native/RSS，且有 direct 上限与回收延迟。
6. **Selector 就等于 epoll**：Selector 是 API，映射依 JDK/OS。
7. **transferTo 永远 sendfile 且一次完成**：平台/目标/TLS 可退化，返回可部分。
8. **虚拟线程消灭背压**：它降低等待线程成本，不扩大 socket/下游/内存容量。

**Q：为何 `OP_WRITE` 不能常驻？** socket send buffer 通常可写，会让 select 持续返回并空转；只有未排空队列时关注。

**Q：慢客户端如何拖垮服务？** 生成速率大于发送速率，per-connection queue 累积；连接数乘积耗尽 heap/direct memory。需 byte watermarks 和端到端取消/反压。

- [ ] 能手算 flip/compact 后三个游标。
- [ ] 能写跨 read 的 length-field decoder。
- [ ] 能处理 0/partial write。
- [ ] 能限定 direct/mmap/zero-copy 结论。
- [ ] 能设计 event-loop owner 与业务 offload。
- [ ] 能让模型/tool/file 三条流有界并可取消。

## 17. 延伸阅读

- [java.nio.channels package, Java 21](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/nio/channels/package-summary.html)
- [ByteBuffer API, Java 21](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/nio/ByteBuffer.html)
- [Selector API, Java 21](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/nio/channels/Selector.html)
- [FileChannel API, Java 21](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/nio/channels/FileChannel.html)

下一章：[22 HTTP、Servlet、Spring MVC 与 WebFlux](22-http-servlet-web.md)。
