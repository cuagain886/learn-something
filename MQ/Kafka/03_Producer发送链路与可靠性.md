# 03｜Producer 发送链路与可靠性：吞吐、延迟、顺序和重复如何耦合

> 核心结论：`send()` 通常不是一次同步网络写。业务线程完成序列化、分区与入缓冲，后台 Sender 将同一 broker/partition 的记录批量发送。可靠性不是一个 `acks` 参数决定的，而是确认、ISR、重试、超时、幂等与业务错误处理的组合。

## 1. `send()` 之后发生什么

```mermaid
flowchart LR
    A["ProducerRecord"] --> S["Serializer"]
    S --> P["Partitioner / partition selection"]
    P --> M["Metadata lookup"]
    M --> R["RecordAccumulator: per-partition batch"]
    R --> D["Sender drains ready batches"]
    D --> N["ProduceRequest to leader"]
    N --> B["Broker append + replication"]
    B --> C["Callback / Future completion"]
```

关键阶段：

1. **序列化**：key/value 变成字节，序列化异常通常在客户端暴露；
2. **选分区**：显式 partition 优先；否则通常根据 key 或无 key 策略选择；
3. **缓冲**：记录进入按 partition 组织的 batch；
4. **发送**：Sender 线程按 broker 聚合请求；
5. **确认**：响应满足 `acks` 或返回可重试/不可重试错误；
6. **完成**：Future/callback 告知业务，但业务若忽略异步错误，逻辑上仍会“静默丢失”。

## 2. batch 是性能模型的中心

逐条请求的固定成本包括系统调用、协议头、网络往返、broker 请求调度和日志追加。batch 将固定成本摊到多条记录上，压缩也通常以 batch 为单位，因此批量越充分，吞吐和压缩率往往越好。

主要旋钮：

- `batch.size`：单 partition batch 的目标容量上限方向；
- `linger.ms`：数据不足时允许等待更多记录的时间；
- `compression.type`：网络与磁盘节省对 CPU 的交换；
- `buffer.memory`：Producer 可用于缓冲待发送记录的总内存方向；
- `max.block.ms`：元数据/缓冲不足时业务调用最多容忍的阻塞。

注意 `linger.ms=5` 不等于每条记录固定多 5ms：batch 提前填满可立即发送；网络/排队/复制仍会贡献更多延迟。

## 3. 分区选择与热点

有 key 时通常通过 key 的序列化字节映射 partition。你必须保证：

- 不同语言/版本对 key 使用兼容的序列化与分区算法；
- 扩分区前评估映射变化；
- key 基数足够且分布不过度倾斜；
- 真正需要顺序的业务实体与 key 一致。

热点诊断不要只看 topic 总吞吐，要看 partition 级 bytes/records、请求延迟和 broker 负载。总吞吐正常但单 partition 饱和，会表现为少量 key 延迟高、batch 堆积和不均匀 lag。

## 4. `acks` 精确定义

### `acks=0`

客户端不等待 broker 确认。延迟低，但无法从响应判断 leader 不可用或写入失败，适用于确实允许损失且有其他观测机制的数据。

### `acks=1`

leader 本地接受写入后即可响应，不等待其他同步副本达到确认条件。若 leader 响应后、follower 复制前发生不可恢复故障，记录可能丢失。

### `acks=all`

leader 等待当前 ISR/最小同步副本规则满足后响应。它与 `min.insync.replicas` 联合决定故障期是继续成功写入还是拒绝写入。它不表示等待 assignment 中每一个落后副本，更不等于所有磁盘完成物理 flush。

## 5. 重试、超时与不确定结果

分布式调用有三种业务结果：明确成功、明确失败、**未知**。超时只说明客户端没及时拿到结果，不能证明 broker 没执行。

需要一起理解：

- `request.timeout.ms`：一次请求等待响应的边界；
- `delivery.timeout.ms`：一条记录从发送到最终成功/失败的总时间预算方向；
- `retries` 与 retry backoff：可重试错误的尝试策略；
- 业务自己的 HTTP/RPC deadline：上游可能比 Producer 更早放弃并再次提交业务请求。

若上层在 Producer Future 未确定时自行重发业务事件，即使协议幂等开启，也可能产生新的逻辑发送。`eventId` 和业务去重不可省略。

## 6. 幂等 Producer 的状态机

幂等写入的思想是：broker 不按 value 比较内容，而按 Producer 身份和每个 partition 的序列状态识别重复/乱序 batch。

```text
PID = producer identity
epoch = producer incarnation/fencing generation
sequence(P3) = 17, 18, 19 ...
```

当 batch 18 的响应丢失后重试，broker 已见过该序列就可避免再次追加。边界：

- 主要解决客户端协议重试造成的重复；
- 不替代业务 `eventId` 去重；
- 不让跨 partition 写入天然原子；跨 partition 原子性需要 transaction；
- 应避免配置与幂等所需的 `acks`、重试、in-flight 约束冲突；以所用版本的官方配置校验为准。

## 7. 顺序为什么仍可能被破坏

无幂等保护且允许多个 in-flight request 时：

1. batch A 先发，batch B 后发；
2. A 暂时失败，B 成功追加；
3. A 重试后成功；
4. 日志成为 B、A。

幂等协议与序列校验可在允许流水线并发时保护 partition 内顺序，但业务层还有两类乱序：

- 多个 Producer 实例同时写同一 key，Kafka 不知道它们的业务先后；
- consumer 并发执行同一 partition 的记录，完成/落库顺序反转。

## 8. 错误分类与处理策略

| 错误类别 | 例子方向 | 策略 |
|---|---|---|
| 短暂可重试 | leader 变化、网络抖动 | 由客户端在总 delivery deadline 内重试并刷新元数据 |
| 配置/数据永久错误 | 序列化失败、记录过大、鉴权失败 | 立即告警/修复，盲目重试无意义 |
| 状态已失效 | 事务 producer 被 fencing | 关闭旧实例，按事务协议恢复，不能继续复用 |
| 结果未知 | 请求超时 | 依靠协议幂等和业务 eventId 处理，不武断判断未写入 |

异步发送必须观察 callback/Future。只记录异常但继续返回业务成功，会把 Kafka 失败窗口隐藏到数据对账阶段。

## 9. 两套基准测试思路

### 低延迟流

- 小消息、低并发；
- 测 p50/p95/p99/p99.9，不只测平均；
- 逐步改变 linger、压缩和 acks；
- 同时观察 Producer queue time、request latency、broker request time。

### 高吞吐流

- 固定消息大小和 key 分布；
- 增加并发直到吞吐不再线性增长；
- 记录 batch size、compression ratio、网络、磁盘与 CPU；
- 区分客户端先饱和、单 partition 饱和、broker 磁盘饱和。

基准结果必须带版本、硬件、分区数、副本数、记录大小、压缩、acks 和 key 分布，否则不可复现。

## 10. 深度检查题

1. `send()` 返回 Future 是否意味着数据已发到 broker？
2. 增大 `batch.size` 为什么可能完全不提升低流量 partition 的实际 batch？
3. `acks=all` 在 ISR=1、`min.insync.replicas=1` 时能提供几份有效确认？
4. 开启幂等后，用户双击“支付”导致两个 API 请求，Kafka 会自动去重吗？
5. 业务 deadline 为 2 秒，Producer delivery timeout 为 2 分钟，会产生什么资源与语义风险？

