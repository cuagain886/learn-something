# PEL、确认、重投与所有权转移

## PEL 记录什么

Pending Entries List 保存“已交付给组但未确认”的元数据。逻辑上每项至少包括消息 ID、当前 owner、最后投递时间、投递次数。它同时可从组级按 ID 查询，也需支持按消费者查看；实现中相应索引必须保持一致。

PEL 不是消息副本。payload 仍在 Stream 主体，PEL 只是引用与交付状态。这是理解删除后空 payload 的前提。

## XPENDING 的两种视图

```redis
XPENDING orders payment-workers
XPENDING orders payment-workers - + 100 pay-01
XPENDING orders payment-workers IDLE 60000 - + 100
```

摘要适合看总量、最小/最大 pending ID 和消费者分布；扩展形式返回 ID、owner、idle、delivery count。线上扫描必须分页，不能一次拉取整个 PEL。idle 表示距离最近一次交付/claim 的时间，不等于业务已执行多久；客户端心跳不会刷新它。

## XACK 的准确边界

```redis
XACK orders payment-workers 1710000000000-0
```

成功返回删除的 PEL 项数。返回 0 可能表示已经 ACK、ID 不在该组 PEL、组/参数问题，而不是“消息不存在”。ACK 不删除 Stream 条目，也不影响其他组。

批量 ACK 减少 RTT，但会增大进程崩溃时未发送 ACK 的重复范围。业务事务最好逐消息或小批完成，再只 ACK 确认已提交的 ID。

## XCLAIM 与 XAUTOCLAIM

`XCLAIM` 由调用者给出具体 ID，只有 idle 达到阈值才转移；适合已通过 XPENDING 筛选的精确接管。`XAUTOCLAIM` 从游标扫描 PEL，自动寻找达到 idle 阈值的项并返回下一游标，更适合周期恢复器。

```redis
XAUTOCLAIM orders payment-workers recovery-01 60000 0-0 COUNT 100
```

必须循环到返回游标为 `0-0`，并限制每轮数量、处理时长和并发。它的扫描工作量不等于返回数量：大量未达到 idle 的项也需检查，因此不要把 COUNT 当严格 CPU 上限。

## claim 不是分布式锁

时间线：

```text
t0 C1 获得 m，开始调用支付接口
t1 C1 发生长 GC/网络暂停，idle 超过 60s
t2 recovery 将 m claim 给 C2
t3 C2 调支付接口
t4 C1 恢复，也完成支付并 XACK
```

Redis 只转移 PEL owner，无法撤销 C1 已经开始的外部动作。因此 min-idle-time 必须大于正常 P99/P999 处理时长并保留抖动，但无论多大都不能替代业务幂等。需要更强互斥时，可在业务存储使用状态机条件更新或 fencing token；普通 Redis 锁同样要处理过期后旧持有者继续运行。

## 投递次数不是精确重试计数器

delivery count 通常随再次交付/claim 变化，但不同读取模式、版本和管理动作会影响它。将其作为毒消息信号可以，将它作为财务级准确计数不合适。可靠重试次数应写入独立重试事件或业务表，并由幂等事务更新。

## 恢复器算法

```text
loop:
  cursor, entries, deleted_ids = XAUTOCLAIM(... minIdle, cursor, COUNT 100)
  for entry in entries:
      if idempotency_store says completed:
          XACK
      else:
          process with timeout
          on success: commit result, then XACK
          on retryable failure: schedule delayed retry, then XACK original
          on permanent/exhausted: append DLQ, then XACK original
  inspect/clean version-supported deleted references
  stop/slow when cursor == 0-0
```

恢复器应使用独立 consumer 名，做 leader 选举或确定性分片，防止多个恢复器反复互相 claim。即使只有一个恢复器，仍需幂等。

## 删除消费者前的审计

先查该 consumer 的 pending 数。如果非零：停止它的新读取，等待正常完成；超时后由恢复器 claim；确认 PEL 清空后再删除 consumer 元数据。直接删除不能等价为业务完成。

## 告警阈值

- pending 总数持续上升：完成速率小于交付速率或 ACK 失败。
- oldest idle 超过 SLO：存在卡住/宕机 worker。
- delivery count 高：毒消息、claim 阈值过低或处理超时。
- 单消费者占 PEL 比例异常：负载不均或其他 worker 离线。
- claim 速率突增：消费者抖动、网络故障或恢复器配置错误。

