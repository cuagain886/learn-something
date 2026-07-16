# 至少一次、幂等与 Exactly-Once 边界

## 无法消除的双写窗口

消费消息并修改 MySQL 是两个系统的操作。无分布式事务时只有两种顺序：

### 先提交业务，再 XACK

```text
DB commit 成功 -> 进程崩溃 -> 未 XACK -> 消息重投 -> 业务可能重复
```

不会静默丢业务，但会重复；配合幂等可达到业务效果一次，通常是正确选择。

### 先 XACK，再提交业务

```text
XACK 成功 -> 进程崩溃 -> DB 未 commit -> 服务端不再重投
```

会永久丢处理，不能用于可靠任务。

所以推荐“业务事务提交后 ACK”，并接受 ACK 丢失造成的重复。

## 幂等表设计

```sql
CREATE TABLE consumed_event (
  consumer_group VARCHAR(128) NOT NULL,
  event_id       VARCHAR(128) NOT NULL,
  stream_id      VARCHAR(64)  NOT NULL,
  result_code    VARCHAR(32)  NOT NULL,
  processed_at   TIMESTAMP(6) NOT NULL,
  PRIMARY KEY (consumer_group, event_id)
);
```

处理事务：先尝试插入幂等键；唯一键冲突表示已处理，查询结果并 ACK；插入成功后在同一数据库事务更新订单、写审计记录并提交。不能先在 Redis `SETNX` 去重再写数据库，因为去重键和业务数据仍有双写窗口。

业务唯一键应使用 producer 生成且重试不变的 `event_id`，不要仅用 Stream ID：同一业务事件可能被重新发布到不同 Stream ID，迁移或补偿也可能改变日志位置。

## 状态机条件更新

对订单等聚合可额外使用版本：

```sql
UPDATE orders
SET status = 'PAID', version = 7
WHERE order_id = ? AND version = 6 AND status = 'PAYING';
```

影响 0 行时区分已成功、乱序、非法转换。幂等键防重复事件，版本栅栏防旧事件覆盖新状态，两者解决的问题不同。

## 外部 HTTP 副作用

若调用第三方支付，数据库事务不能包住 HTTP。应尽量使用对方支持的 idempotency key，把 `event_id` 作为请求幂等键；本地先持久化调用意图/outbox，再由专门执行器调用并记录确定结果。超时是“不确定”，不能简单视作失败重试新请求。

## Lua 为什么不能实现端到端 exactly-once

Lua/Redis Function 可以原子完成 Redis 内多个 key 的检查、XADD、XACK，但不能原子提交 MySQL 或远程 HTTP。脚本运行期间还会独占命令执行，过大的批处理增加所有客户端延迟。它适合 Redis 内状态机，不是通用分布式事务。

## Producer 侧也需要幂等

XADD 请求超时可能已执行。方案按强度排序：

1. 消费端以 `event_id` 幂等，允许流内重复。
2. Redis Function 原子检查短期去重 key 后 XADD，控制去重窗口和容量。
3. 数据库事务内写 outbox，由 relay 反复发布；消费者仍幂等，relay 成功后标记。

Outbox 解决“业务库提交但事件没发”，不让 Redis 发布和数据库提交变成同一原子事务；它靠可重试发布 + 消费幂等闭环。

## “Exactly once”的准确表述

- 投递 exactly-once：网络与崩溃下通常不可得。
- 处理 exactly-once：跨系统需要事务协议或幂等效果。
- 业务效果 effectively-once：至少一次投递 + 稳定事件 ID + 原子幂等记录 + 状态机约束，工程上可实现。

面试中不要只回答“Redis Stream 支持 ACK 所以可靠”。ACK 只建立至少一次恢复基础，可靠性取决于 PEL 恢复、保留窗口、持久化复制和外部幂等共同成立。

## 反例审查

- 用内存 Set 记录处理过：重启丢失，多实例不共享。
- `SETNX event_id` 后做业务：SETNX 成功后崩溃会跳过真正业务。
- 业务完成后异步 ACK 且无恢复：重复窗口扩大但仍可接受；关键是幂等和 PEL 治理。
- ACK 成功就删除幂等记录：消息晚到/重复发布后失去保护。幂等记录 TTL 应覆盖最大重放、补偿和审计周期。

