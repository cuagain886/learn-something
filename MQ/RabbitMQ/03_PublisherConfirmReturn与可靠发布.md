# 03｜Publisher Confirm、Return 与可靠发布：三个“成功”必须分开

> 核心结论：Publisher Confirm 回答 Broker 是否接受并按队列类型达到确认条件；mandatory Return 回答消息是否无法路由到任何 Queue；Consumer Ack 回答下游是否完成处理。三者方向不同。

## 1. 发布结果矩阵

| Confirm | Return | 含义方向 |
|---|---|---|
| Ack | 无 | Broker 接受，且至少路由路径没有触发 mandatory return；不代表业务消费成功 |
| Ack | 有 | 发布到 Exchange 被处理，但不可路由；Publisher 必须处理 returned message |
| Nack | 可能无 | Broker 无法按要求处理/安全接收，应用需告警和重试决策 |
| 未收到 | 未知 | 连接断开/超时，结果不确定，重发可能重复 |

Return 与 Confirm 回调时序必须由客户端 API 正确协调，不能收到 Ack 就提前删除在途消息而忽略稍早/稍后的 Return 处理。

## 2. Confirm 序列号

开启 confirm mode 后，Channel 上每次发布获得单调 delivery sequence number。Broker 可单条或批量确认：

```text
Ack(deliveryTag=105, multiple=true)
=> 该 Channel 上截至 105 的未确认发布均被确认
```

因此异步 Publisher 通常维护有序 `seqNo → PendingMessage` 映射：

- 单条 Ack/Nack 移除一个；
- multiple Ack/Nack 原子处理一个前缀；
- Connection/Channel 关闭时剩余集合进入未知/重试流程。

Delivery tag/sequence 只在 Channel 内有效，Channel 重建后重新计数，不能作为业务全局 ID。

## 3. 单条、批量与异步 Confirm

- 每条 publish 后 `waitForConfirms`：实现简单但网络往返限制吞吐；
- 发布一批再等待：吞吐更高，但失败时要定位批次中的未知消息；
- 异步 listener：吞吐最好，需有界在途窗口、并发安全映射、超时和 Channel 故障恢复。

高吞吐可靠 Publisher 的关键不是无限异步，而是**有界在途**。Confirm 变慢时必须背压上游，否则 Pending Map 和客户端内存无限增长。

## 4. 不同队列类型的 Confirm 语义

- Classic Queue：确认与其本地队列存储状态相关，不提供 4.x 中已移除的 classic mirroring 数据复制；
- Quorum Queue：Confirm 在消息复制到 quorum 并被认为安全后发出；
- Stream：Confirm 与其复制日志的 quorum 条件相关。

如果同一消息路由到多个 Queue，确认要考虑所有目标的接收结果和实现条件。某目标不可用可能拖延或导致 Nack；设计大 Fanout 时必须压测最慢目标对 Publisher 的影响。

## 5. 持久发布的组合条件

经典可靠发布检查：

1. Exchange/Queue 拓扑是 durable；
2. 消息 delivery mode 为 persistent（队列类型语义可能有差异）；
3. 使用 Publisher Confirm 并处理 Nack/Connection failure；
4. 使用 mandatory/Return 或 Alternate Exchange 防止不可路由静默丢失；
5. 关键数据使用 Quorum Queue/Stream 等复制结构；
6. 节点与副本跨故障域；
7. 下游用 eventId 幂等。

缺一不可简化为“设置 persistent 就不丢”。

## 6. Java 异步 Confirm 伪代码

```java
channel.confirmSelect();
ConcurrentNavigableMap<Long, Pending> pending = new ConcurrentSkipListMap<>();

channel.addConfirmListener((tag, multiple) -> {
    if (multiple) pending.headMap(tag, true).clear();
    else pending.remove(tag);
}, (tag, multiple) -> {
    // 标记 Nack，交给有界重试/告警，不在回调里阻塞重发
});

long seq = channel.getNextPublishSeqNo();
pending.put(seq, new Pending(eventId, payload));
channel.basicPublish(exchange, routingKey, true, props, body);
```

生产实现还要解决 publish 抛异常时映射清理、Return 与 Confirm 关联、Channel 关闭、超时扫描、重试顺序和内存上限。

## 7. RabbitMQ Transaction 与 Confirm

AMQP Channel transaction 通过 `tx.select/commit/rollback` 提供事务式发布，但同步开销大，通常显著限制吞吐。Publisher Confirm 更适合可靠批量发布，但它不是跨 RabbitMQ 与数据库的分布式事务。

数据库→RabbitMQ 双写仍用 Transactional Outbox/CDC；不要用先 DB commit 再 publish 假装原子。

## 8. 检查题

1. Confirm Ack + Return 同时出现是否矛盾？
2. multiple Ack 的 tag 能否跨 Channel 使用？
3. 连接断开时 Pending 消息应全部判定失败还是未知？
4. Confirm 延迟突然上涨为什么必须给 Publisher 背压？
5. Quorum Queue 不使用 Confirm，Publisher 能否知道消息达到 quorum？

