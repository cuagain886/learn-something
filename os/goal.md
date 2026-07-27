请为我生成一套系统化、工程导向的《操作系统学习文档》，目标读者是一名正在学习后端开发和 Agent 开发的程序员，主要使用 Go 语言。

## 一、总体目标

这套文档不能只是操作系统教材知识的简单整理，而要帮助我建立以下能力：

1. 理解后端程序运行时，操作系统内部发生了什么。
2. 能够分析并解决 CPU、内存、并发、I/O、进程和资源泄漏问题。
3. 能够理解 Go runtime、goroutine、GMP、GC、netpoller 与操作系统的关系。
4. 能够正确设计 Agent 的进程管理、任务取消、超时控制和资源清理机制。
5. 能够理解容器、Sandbox、Namespace、cgroup、seccomp 等隔离技术。
6. 能够使用 Linux 工具定位真实的线上问题。
7. 学完后具备开发简易 Agent Sandbox 或代码执行平台的基础能力。

文档需要强调“为什么这样设计”“底层是如何工作的”“实际项目中如何使用”和“出现问题时如何排查”。

## 二、内容范围

请按照由浅入深的顺序，覆盖以下模块。

### 模块 1：操作系统基础

包括但不限于：

- 操作系统的职责
- 用户态与内核态
- 内核、Shell、系统调用之间的关系
- 中断、异常和系统调用
- CPU、内存、磁盘、网络设备如何被操作系统管理
- 一个 Go 程序从启动到运行经历了什么
- ELF、动态链接和程序加载的基本过程

需要回答：

- 为什么应用程序不能直接操作硬件？
- 用户态切换到内核态的成本是什么？
- 系统调用和普通函数调用有什么区别？
- 一个可执行文件是如何变成运行中的进程的？

### 模块 2：进程

深入讲解：

- 进程的定义和数据结构
- 进程地址空间
- 进程状态
- 进程调度
- PID、PPID、进程树
- 父子进程
- fork、exec、wait
- 僵尸进程和孤儿进程
- 守护进程
- 进程退出码
- 进程组、会话和控制终端
- 信号机制
- SIGTERM、SIGKILL、SIGINT、SIGCHLD
- 优雅退出
- 子进程回收

结合 Agent 场景重点讲解：

- Agent 如何启动 Shell、Python 或其他工具进程
- 为什么只杀父进程可能留下子进程
- 如何终止整个进程树
- 如何处理 stdout、stderr 和 stdin
- 如何避免僵尸进程
- 如何实现超时退出
- 用户取消任务后如何传播取消信号
- 如何保证任务结束后资源被清理

请提供 Go 语言示例。

### 模块 3：线程、协程和调度

深入讲解：

- 线程和进程的区别
- 内核线程和用户线程
- 上下文切换
- 抢占式调度
- 时间片
- CPU 密集型和 I/O 密集型任务
- 多核并行
- 超线程的基本概念
- 协程的设计思想
- M:1、1:1、M:N 模型
- goroutine 与操作系统线程的关系
- Go GMP 调度模型
- G、M、P 分别是什么
- work stealing
- goroutine 抢占
- 系统调用阻塞时的处理
- GOMAXPROCS
- goroutine 栈的增长和收缩
- goroutine 泄漏

需要回答：

- goroutine 为什么比线程轻量？
- goroutine 多是否一定性能更好？
- 一个 goroutine 阻塞时为什么不一定阻塞整个程序？
- CPU 密集型 goroutine 为什么可能影响其他请求？
- 如何定位 goroutine 泄漏？

请结合 Go runtime 源码或实现原理讲解，但避免无意义地逐行分析源码。

### 模块 4：并发与同步

深入讲解：

- 并发与并行
- 竞态条件
- 临界区
- 原子性、可见性、有序性
- Mutex
- RWMutex
- Semaphore
- Condition Variable
- Atomic
- CAS
- 自旋锁
- 内存屏障
- 死锁
- 活锁
- 饥饿
- 锁竞争
- 锁粒度
- False Sharing
- 无锁数据结构的基本思想
- Happens-before

结合 Go 讲解：

- sync.Mutex
- sync.RWMutex
- sync.Once
- sync.Cond
- sync.Map
- atomic 包
- channel 与锁的适用场景
- Go 内存模型

结合 Agent 场景说明：

- 同一个任务被重复执行
- 多个工具同时修改任务状态
- 多个 Tool Call 并发执行
- 用户取消时仍有任务继续运行
- 重试导致发送邮件、创建 PR 等操作重复执行
- 如何设计幂等性
- 如何设计任务状态机
- 如何限制并发数量

每一类问题都需要包含错误示例、正确示例和分析过程。

### 模块 5：内存管理

深入讲解：

- 虚拟内存
- 物理内存
- 地址空间
- 页和页表
- 多级页表
- TLB
- Page Fault
- 缺页中断
- 堆与栈
- mmap
- Copy-on-Write
- Swap
- 内存过量分配
- OOM
- 内存碎片
- 共享内存
- 内存映射文件

结合 Go 深入讲解：

- Go 堆和栈
- 逃逸分析
- 小对象和大对象分配
- GC 基本过程
- 三色标记
- 写屏障
- STW
- GC 触发条件
- GOGC
- 内存分配速率
- sync.Pool
- 大切片和大字符串
- 字符串与字节切片转换
- 逻辑内存泄漏
- goroutine 泄漏造成的内存问题
- Go runtime 为什么不一定立即把内存归还给操作系统

结合 Agent 场景说明：

- 长对话上下文
- 大模型流式输出
- 工具日志过大
- 文件内容全部读入内存
- 截图和二进制数据
- 大量并发任务
- 未消费的 channel
- 无界队列
- 缓存无限增长

需要讲解如何通过流式处理、分块、背压、临时文件和输出限制避免 OOM。

### 模块 6：文件系统

包括：

- 文件和目录
- inode
- 文件描述符
- 文件权限
- 用户和用户组
- 硬链接与软链接
- 文件打开、读取、写入和关闭
- 文件偏移量
- 标准输入、标准输出、标准错误
- 管道
- 命名管道
- 文件锁
- Page Cache
- Buffer
- fsync
- 顺序读写和随机读写
- 临时文件
- 磁盘空间和 inode 耗尽
- Too many open files
- 文件描述符泄漏

结合 Agent 和 Sandbox 场景说明：

- 工作目录管理
- 临时目录清理
- 文件大小限制
- 磁盘配额
- 路径穿越
- 符号链接攻击
- 文件权限控制
- 上传文件处理
- 工具生成大量文件
- 任务结束后如何回收工作目录

请提供 Go 文件操作和安全路径处理示例。

### 模块 7：I/O 模型

深入讲解：

- 阻塞 I/O
- 非阻塞 I/O
- 同步 I/O
- 异步 I/O
- I/O 多路复用
- select
- poll
- epoll
- Level Triggered
- Edge Triggered
- Reactor
- Proactor
- 零拷贝
- sendfile
- splice
- mmap 的使用场景
- DMA 的基本概念

结合 Go 讲解：

- Go netpoller
- goroutine 和网络 I/O 的关系
- 为什么大量连接不需要一个连接对应一个线程
- 为什么慢客户端会造成内存堆积
- 为什么写阻塞会影响系统
- 如何设计背压
- 如何限制单连接输出缓冲区

### 模块 8：系统调用

讲解常见系统调用的作用和调用链：

- open
- read
- write
- close
- socket
- bind
- listen
- accept
- connect
- fork
- exec
- wait
- kill
- mmap
- clone
- ioctl

需要说明：

- 标准库与系统调用的关系
- 系统调用的性能成本
- 为什么大量小 I/O 性能差
- 为什么频繁创建进程成本高
- 为什么高频日志可能拖慢服务
- 如何使用 strace 分析系统调用

### 模块 9：Linux 资源限制

包括：

- ulimit
- 文件描述符限制
- 最大进程数
- 栈大小限制
- CPU 限制
- 内存限制
- 磁盘限制
- nice 和优先级
- OOM Killer
- Linux load average
- CPU 使用率和负载的区别
- 上下文切换
- 中断和软中断

需要结合真实问题说明：

- CPU 使用率不高但 load 很高
- 服务被 OOM Kill
- 无法创建线程
- 无法创建子进程
- Too many open files
- 磁盘有空间但无法创建文件
- 容器内看到的资源和宿主机不一致

### 模块 10：容器与 Sandbox

这是重点模块，需要深入讲解：

- 容器与虚拟机的区别
- Namespace
- PID Namespace
- Mount Namespace
- Network Namespace
- UTS Namespace
- IPC Namespace
- User Namespace
- cgroup v1 与 v2 的基本区别
- CPU 限制
- 内存限制
- pids 限制
- I/O 限制
- chroot
- pivot_root
- Linux capabilities
- seccomp
- OverlayFS
- 容器镜像和分层文件系统
- 容器网络
- 容器生命周期

结合 Agent Sandbox 重点讲解：

- 如何限制 CPU
- 如何限制内存
- 如何限制进程数量
- 如何限制磁盘
- 如何限制运行时间
- 如何限制网络访问
- 如何禁止访问宿主机和内网
- 如何防止 fork bomb
- 如何防止读取云元数据服务
- 如何限制系统调用
- 如何以非 root 用户运行
- 如何清理失控进程和残留资源
- 多租户隔离的基本原则
- 容器逃逸风险的基本概念

最后给出一个简化版代码执行 Sandbox 的架构设计。

### 模块 11：操作系统可观测性和排障

系统讲解以下工具：

- ps
- top
- htop
- free
- vmstat
- iostat
- pidstat
- mpstat
- lsof
- strace
- dmesg
- ulimit
- df
- du
- mount
- lsblk
- ss
- netstat
- perf
- pstack 或类似线程栈工具

Go 相关工具：

- pprof
- go tool trace
- runtime metrics
- GODEBUG
- goroutine dump
- heap profile
- CPU profile
- block profile
- mutex profile

每个工具需要说明：

1. 它解决什么问题。
2. 常用命令。
3. 输出中重点关注哪些字段。
4. 常见误区。
5. 一个真实排障案例。

## 三、重点问题清单

文档必须能够帮助我回答并解决以下问题：

- 为什么服务 CPU 很高？
- 为什么 CPU 不高但请求很慢？
- 为什么内存持续增长？
- 为什么 Go 进程内存不下降？
- 为什么容器被 OOM Kill？
- 为什么 goroutine 越来越多？
- 为什么任务取消了，子进程还在运行？
- 为什么只杀 Shell 后 Python 进程仍然存在？
- 为什么读取子进程 stdout 可能导致死锁？
- 为什么出现大量僵尸进程？
- 为什么文件描述符不断增长？
- 为什么出现 Too many open files？
- 为什么磁盘有空间却无法创建文件？
- 为什么大量锁竞争导致吞吐下降？
- 为什么大量 goroutine 不一定提高性能？
- 为什么服务 load average 很高？
- 为什么频繁写日志会影响性能？
- 为什么无界队列最终会导致系统崩溃？
- 为什么 Agent 工具执行需要资源配额？
- 为什么 Sandbox 不能只依赖 Docker 默认配置？

## 四、文档结构要求

每个章节统一使用以下结构：

1. 本章目标
2. 核心概念
3. 底层原理
4. 关键数据结构或执行流程
5. 图解或 ASCII 流程图
6. Go 语言示例
7. 后端开发中的应用
8. Agent 开发中的应用
9. 常见问题和错误设计
10. 排障方法
11. 实验任务
12. 面试题
13. 本章总结
14. 延伸阅读

不要只罗列定义。每个核心概念都要至少包含一个具体场景。

## 五、示例代码要求

代码以 Go 为主，必要时可以使用 Shell、C 或伪代码辅助解释。

Go 示例必须：

- 可以独立运行或尽量接近可运行
- 包含必要的错误处理
- 使用 context 实现超时和取消
- 明确资源关闭位置
- 避免只有几行、无法体现问题的玩具代码
- 对错误示例标明问题所在
- 对正确示例解释为什么正确

重点实现以下示例：

1. 启动和管理子进程。
2. 捕获 stdout 和 stderr。
3. 超时后终止进程。
4. 终止整个进程组。
5. 回收子进程。
6. 构造和排查 goroutine 泄漏。
7. 构造死锁和竞态条件。
8. 使用 Mutex、Atomic、Channel 解决并发问题。
9. 实现固定大小 Worker Pool。
10. 实现有界队列和背压。
11. 流式读取大文件。
12. 限制工具输出大小。
13. 使用 pprof 定位 CPU 和内存问题。
14. 使用 strace 分析程序。
15. 实现简化版 Agent Task Runner。
16. 设计简化版 Sandbox 生命周期管理器。

## 六、实验项目

请在文档最后设计一个循序渐进的综合项目：

项目名称：Agent Code Runner

目标是实现一个可以执行 Shell 或代码任务的简化 Agent 运行器。

功能包括：

- 接收执行任务
- 为任务创建独立工作目录
- 启动子进程
- 流式读取 stdout 和 stderr
- 设置执行超时
- 支持用户取消
- 限制最大输出
- 限制并发任务数
- 记录任务状态
- 防止重复执行
- 任务结束后清理进程和文件
- 提供基础监控指标
- 后续扩展到容器 Sandbox

请将项目拆分为多个阶段：

1. 单进程命令执行器
2. 支持超时和取消
3. 支持流式输出
4. 支持进程组清理
5. 支持并发任务
6. 支持任务状态机
7. 支持资源限制
8. 支持容器 Sandbox
9. 支持多租户隔离
10. 支持可观测性

每个阶段需要包含：

- 目标
- 架构设计
- 关键代码
- 容易出现的问题
- 测试方法
- 验收标准

## 七、学习计划

最后生成一个 10 周学习计划，每周预计投入 8 到 10 小时。

每周包括：

- 学习主题
- 必读章节
- 实验任务
- 编码任务
- 排障任务
- 自测问题
- 本周产出物
- 验收标准

学习顺序要优先满足后端和 Agent 开发需求，不要完全照搬大学操作系统教材顺序。

## 八、内容深度要求

对以下主题必须深入讲解：

- 进程、线程、协程
- Go GMP
- 并发同步
- 虚拟内存
- Go GC
- 文件描述符
- epoll
- 子进程与信号
- 进程组
- OOM
- cgroup
- Namespace
- seccomp
- Sandbox 资源隔离
- Linux 性能排查

对以下主题可以理解原理，不需要过度深入数学证明：

- 调度算法的完整理论推导
- 文件系统的所有实现细节
- 编译器后端
- CPU 微架构
- 密码学算法细节
- Linux 内核源码逐行分析

## 九、质量要求

生成内容时遵循以下要求：

- 使用中文。
- 专业术语首次出现时给出英文名称。
- 保持概念准确，不要编造。
- 明确区分操作系统原理、Linux 实现和 Go runtime 实现。
- 对可能因 Linux 内核版本或 Go 版本变化的内容注明版本背景。
- 对不确定的实现细节不要武断下结论。
- 多使用流程图、对比表和执行链路。
- 避免为了完整而堆积低价值知识。
- 强调高频工程问题和真实故障。
- 从“现象—原因—验证—解决方案”角度讲解排障。
- 每个模块结束后提供一份检查清单。

## 十、文件组织

请将文档拆分为多个 Markdown 文件，不要生成一个超长文件。

建议目录结构：

```text
operating-system-learning/
├── README.md
├── 00-learning-map.md
├── 01-os-foundations.md
├── 02-process.md
├── 03-thread-coroutine-scheduling.md
├── 04-concurrency-synchronization.md
├── 05-memory-management.md
├── 06-go-memory-and-gc.md
├── 07-file-system.md
├── 08-io-model.md
├── 09-system-calls.md
├── 10-linux-resource-management.md
├── 11-container-and-sandbox.md
├── 12-observability-and-debugging.md
├── 13-agent-code-runner-project.md
├── 14-interview-questions.md
├── 15-ten-week-plan.md
├── examples/
│   ├── process/
│   ├── concurrency/
│   ├── memory/
│   ├── io/
│   ├── profiling/
│   └── sandbox/
└── labs/
    ├── lab-01-process.md
    ├── lab-02-goroutine.md
    ├── lab-03-memory.md
    ├── lab-04-io.md
    ├── lab-05-debugging.md
    └── lab-06-agent-runner.md
```

README.md 需要说明：

- 学习目标
- 适用人群
- 推荐学习顺序
- 各章节关系
- 实验运行方法
- 环境准备
- 最终能力目标

## 十一、执行方式

请先完成以下步骤：

1. 分析目标和内容范围。
2. 输出完整目录。
3. 标注每一章的学习目标、难度和优先级。
4. 制定文档生成计划。
5. 按章节逐步生成文档和示例代码。
6. 每生成一个章节后检查是否满足结构要求。
7. 确保代码、实验和正文相互对应。
8. 最后检查是否遗漏 Agent、Sandbox、Go runtime 和排障相关内容。

不要一开始只生成零散片段，也不要只给出目录后停止。请实际创建完整的 Markdown 文档和示例代码文件。