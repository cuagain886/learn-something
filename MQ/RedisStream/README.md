# Redis Stream 作为消息队列：深度学习手册

Redis Stream 不是“换了数据结构的 Pub/Sub”。它是 Redis 内部带有持久化条目、单调 ID、范围查询、阻塞读取和 Consumer Group 状态机的日志结构。本目录不把命令罗列当作学习完成，而是沿着“内存布局—命令执行—消费状态—持久化复制—故障恢复—生产治理”逐层拆解。

## 统一案例

后续章节统一使用订单事件：

```text
stream key: orders:{tenant42}
group:      payment-workers
consumer:   pay-01 / pay-02
fields:     event_id, order_id, event_type, schema_version, payload
目标:       至少一次投递、数据库副作用幂等、可重试、可转死信、可审计
```

## 文档地图

| 阶段 | 文档 | 要回答的问题 |
|---|---|---|
| 总览 | [00_学习计划.md](00_学习计划.md) | 如何从会用命令进阶到能解释故障边界 |
| 模型 | [01_Stream模型与ID语义.md](01_Stream模型与ID语义.md) | ID、顺序、时间与日志模型是什么关系 |
| 存储 | [02_rax与listpack底层编码.md](02_rax与listpack底层编码.md) | 条目如何压缩存放，为什么范围查询高效 |
| 写路径 | [03_XADD写入裁剪与删除.md](03_XADD写入裁剪与删除.md) | 写入、近似裁剪、删除何时真正释放内存 |
| 读路径 | [04_范围读取阻塞读取与事件循环.md](04_范围读取阻塞读取与事件循环.md) | XRANGE/XREAD/BLOCK 如何执行且不阻塞 Redis 线程 |
| 消费组 | [05_ConsumerGroup状态机.md](05_ConsumerGroup状态机.md) | `>`、last-delivered-id、lag 到底代表什么 |
| 待确认 | [06_PEL确认重投与所有权转移.md](06_PEL确认重投与所有权转移.md) | XPENDING、XACK、XCLAIM、XAUTOCLAIM 如何协作 |
| 语义 | [07_至少一次幂等与ExactlyOnce边界.md](07_至少一次幂等与ExactlyOnce边界.md) | 业务副作用与 ACK 之间为何必有故障窗口 |
| 生命周期 | [08_保留策略删除与悬空PEL.md](08_保留策略删除与悬空PEL.md) | 裁剪、删除、PEL 引用怎样相互影响 |
| 持久化 | [09_RDB_AOF与恢复路径.md](09_RDB_AOF与恢复路径.md) | 进程崩溃后消息和消费状态如何恢复 |
| 高可用 | [10_复制Sentinel与故障切换窗口.md](10_复制Sentinel与故障切换窗口.md) | 异步复制、WAIT、晋升为什么仍可能丢数据 |
| 分片 | [11_Cluster分片与全局顺序.md](11_Cluster分片与全局顺序.md) | hash slot、hash tag、多流读取怎样设计 |
| 生产 | [12_容量规划监控与排障.md](12_容量规划监控与排障.md) | 如何量化内存、积压、PEL、延迟和吞吐 |
| 韧性 | [13_重试死信与毒消息治理.md](13_重试死信与毒消息治理.md) | 怎样避免热循环、永久 pending 和重试风暴 |
| 客户端 | [14_Java消费循环与连接模型.md](14_Java消费循环与连接模型.md) | Lettuce/Jedis 的阻塞连接、线程和关闭如何安排 |
| 源码 | [15_源码阅读地图与关键函数.md](15_源码阅读地图与关键函数.md) | 从 `t_stream.c` 怎样追到 rax、listpack、阻塞唤醒和传播 |
| 实验 | [16_故障注入实验手册.md](16_故障注入实验手册.md) | 如何用实验验证重复、丢失、claim 和裁剪边界 |
| 面试 | [17_面试必考题与深度回答.md](17_面试必考题与深度回答.md) | 如何从机制、边界和取舍回答高频问题 |
| 选型 | [18_与Kafka_RabbitMQ的机制对比.md](18_与Kafka_RabbitMQ的机制对比.md) | 什么场景该用 Stream，什么场景不该用 |
| 编码源码 | [19_listpack字节布局逐字段拆解.md](19_listpack字节布局逐字段拆解.md) | master entry、SAMEFIELDS、ID delta 和 lp-count 如何编码 |
| 写入源码 | [20_XADD源码执行路径逐分支.md](20_XADD源码执行路径逐分支.md) | `streamAppendItem()` 如何生成 ID、分裂节点、裁剪与传播 |
| PEL 源码 | [21_PEL双索引源码与一致性不变量.md](21_PEL双索引源码与一致性不变量.md) | group/consumer 两棵 rax 如何共享和迁移 NACK |
| 阻塞源码 | [22_XREAD阻塞唤醒与事件循环源码.md](22_XREAD阻塞唤醒与事件循环源码.md) | blocked client、ready key、超时与重新检查如何协作 |
| 裁剪源码 | [23_streamTrim源码与删除策略.md](23_streamTrim源码与删除策略.md) | MAXLEN/MINID、精确/近似和引用策略如何改变执行路径 |
| 恢复源码 | [24_Stream的RDB_AOF序列化与命令传播.md](24_Stream的RDB_AOF序列化与命令传播.md) | 消息、组、PEL 如何序列化并确定性重放 |
| 复制源码 | [25_复制偏移_WAIT与Failover状态回退.md](25_复制偏移_WAIT与Failover状态回退.md) | offset、PSYNC、WAIT 和切主状态回退如何发生 |
| 容量实战 | [26_容量模型压测方法与参数推导.md](26_容量模型压测方法与参数推导.md) | 如何从实测字节和服务率推导容量、批次与告警阈值 |
| 事故复盘 | [27_生产事故时间线与根因推演.md](27_生产事故时间线与根因推演.md) | 如何从指标和状态还原积压、裁剪、切主与重复副作用 |

## 六条必须记住的不变量

1. Stream ID 提供的是单个 key 内的字典序，不等同于业务事件时间，也不提供跨 key 全局顺序。
2. `XREADGROUP ... >` 会修改组状态，所以它不是纯读；成功投递通常会建立 PEL 记录。
3. `XACK` 删除的是 PEL 中的待确认记录，不等于删除 Stream 条目。
4. 消息体和消费状态是两类状态；裁剪消息体不必然清理旧 PEL，具体能力还受 Redis 版本和删除策略影响。
5. Redis 内部命令原子，不代表“Redis + MySQL/HTTP”跨系统 exactly-once。
6. Redis 复制默认异步；`WAIT` 能收窄风险窗口，但不是共识提交协议。

## 版本约定

文档以现代 Redis Open Source 的 Stream 模型为主。`XAUTOCLAIM`、按引用策略删除/确认等能力在不同版本可用性不同；上线前以目标实例的 `COMMAND INFO` 和对应版本文档为准。源码符号也可能重构，阅读时优先追踪 `src/t_stream.c` 中的命令入口和 `stream*` 类型，而不要死记行号。

## 权威材料

- [Redis Streams 官方指南](https://redis.io/docs/latest/develop/data-types/streams/)
- [Redis 命令文档](https://redis.io/commands/)
- [Redis 持久化](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- [Redis 复制](https://redis.io/docs/latest/operate/oss_and_stack/management/replication/)
- [Redis Cluster 规范](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
- [Redis 官方源码](https://github.com/redis/redis)
