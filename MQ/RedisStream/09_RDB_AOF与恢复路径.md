# RDB、AOF 与恢复路径

## 要持久化的不只是消息

Stream 的 RDB/AOF 状态包括消息条目，也包括 Consumer Group、consumer 和 PEL。否则重启后即使 payload 还在，也不知道哪些已投递未确认。恢复验证必须同时检查 XLEN、首尾 ID、group last-delivered-id、lag、PEL owner/idle/count。

## RDB 的窗口

RDB 是时间点快照。后台保存 fork 子进程，父进程继续写；机器崩溃时，最近一次快照之后的 XADD、ACK、claim 和组变更都会丢失。RDB 适合备份和快速载入，不适合作为低 RPO 消息队列唯一保障。

fork 期间父进程修改内存页触发 Copy-on-Write。高写入 Stream、大 listpack 重写和裁剪会增大额外内存。容量不能只按稳态 used_memory，需预留 fork 峰值并监控 `latest_fork_usec`、COW 指标、RSS 和系统可用内存。

## AOF 的窗口

| 策略 | 大致风险 | 代价 |
|---|---|---|
| `appendfsync always` | 每命令请求同步，窗口最小 | 延迟和 IOPS 高，仍受硬件/OS语义影响 |
| `everysec` | 常见折中，机器故障可能丢约同步周期 | 性能较好 |
| `no` | 交给 OS 刷盘，窗口更不可控 | 吞吐高 |

AOF 收到的是命令传播结果。自动生成的 ID、claim 时间等非确定因素需要以可重放方式传播，保证恢复不重新做随机/时钟决定。

## AOF rewrite 不是简单复制旧文件

重写根据当前内存状态生成能重建数据的紧凑表示，同时父进程继续处理增量并在切换时合并。它会 fork、读内存、写新文件并产生额外 I/O。大 Stream 重写可能造成：磁盘空间短时双份、I/O 竞争、fork 延迟、COW 内存和尾延迟上升。

## 混合持久化与加载

现代配置可使用 RDB preamble + AOF 增量，兼顾载入速度与增量记录。具体格式和恢复优先级取决于版本。不能只检查配置开关；应定期在隔离环境从实际备份启动，验证 Stream 与 PEL 语义。

## 三类崩溃要分开

1. Redis 进程崩溃但 OS 存活：OS page cache 中 AOF 数据可能仍可落盘。
2. 机器掉电：未 fsync 数据可能丢失。
3. 磁盘/文件损坏：需要备份、校验和灾备恢复。

说“AOF everysec 最多丢 1 秒”是工程近似，不是所有故障下的数学承诺。

## 恢复后的语义异常

- XADD 已恢复、对应 ACK 未恢复：消息可能重新 pending/需要重做，幂等兜底。
- ACK 已恢复但外部 DB 未提交：若错误采用先 ACK，会丢业务。
- claim 状态回退：owner 可能与消费者实际运行不一致。
- Stream 已恢复但较新的组创建未恢复：消费者报 NOGROUP。

恢复 runbook 不应自动 `XGROUP CREATE ... $`，这会跳过历史。应根据期望起点和备份前状态重建。

## 验证清单

- 定期复制 RDB/AOF 到隔离节点，禁止连接生产客户端。
- 检查 `XINFO STREAM FULL`、抽样 payload、所有组和 PEL。
- 运行幂等消费者处理恢复数据，统计重复与缺失。
- 记录恢复耗时：加载大 Stream 期间服务 RTO 是否可接受。
- 校验磁盘余量可承受 rewrite、快照和日志同时存在。
- 将 Redis 备份与外部业务库恢复点对齐，否则跨系统时间点不一致。

