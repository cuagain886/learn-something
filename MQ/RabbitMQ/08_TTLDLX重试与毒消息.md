# 08｜TTL、DLX、重试与毒消息：构建有界失败状态机

> 核心结论：DLX 是普通 Exchange，死信仍需路由；TTL 不是精确定时器；立即 Requeue 会制造热循环。可靠重试必须有 eventId、次数、退避、最终出口和目标不可用处理。

## 1. 何时 Dead-letter

常见原因：

- Consumer reject/nack 且 `requeue=false`；
- 消息 TTL 到期；
- Queue 超过长度限制并按策略移除；
- Quorum Queue Delivery Limit/毒消息处理；
- 其他队列策略触发。

配置 DLX 后，消息以死信属性/headers 携带原 Queue、原因和路由信息，再发布到 DLX。DLX 目标没有 Binding 或 Queue 不可用时，不能假设一定安全抵达。

## 2. TTL 不是精确定时

Message TTL/Queue TTL 表达过期资格，实际移除受队列头部、后台处理和队列类型实现影响。用 TTL + DLX 做延迟重试时，延迟可能大于配置值。

同一 Queue 混合不同 TTL 可能发生头阻塞：后面的短 TTL 消息被前面的长 TTL 消息挡住，虽已逻辑过期却不能及时 dead-letter。常用固定延迟等级的独立 Retry Queue。

## 3. 有界重试拓扑

```text
main queue
  ├─ transient failure → retry.5s → DLX back to main
  ├─ repeated failure → retry.1m → back
  ├─ repeated failure → retry.10m → back
  └─ attempts >= 5 → parking/DLQ for investigation
```

消息保留：`eventId`、attempt、firstFailureAt、lastErrorCode、originalExchange/routingKey。不要只依赖可被重发布重写的 headers；业务状态中也应能审计。

## 4. Requeue 热循环

若所有 Consumer 立即 `nack(requeue=true)`：消息可能马上被再次投递，形成 CPU/网络高、Delivery rate 高、Ack rate 低的循环。多 Consumer 下位置和顺序也不稳定。

可重试错误进入延迟通道；不可重试 schema/权限/业务规则错误直接 Parking Queue；依赖雪崩时配合熔断与停止消费，避免把 RabbitMQ 当高速定时器。

## 5. DLX 的可靠性边界

传统死信转发可能是 At-Most-Once。Quorum Queue 支持配置更安全的 At-Least-Once dead-lettering：内部 Consumer 使用 Publisher Confirm，目标确认后才从源侧确认死信；但需满足相应策略条件，目标故障会导致源侧保留和重试，也可能在目标产生重复。

因此 DLQ Consumer 仍需幂等，源 Queue 还需 max-length/bytes 防止目标长期不可用导致无限占用。

## 6. 循环死信

错误 Binding 可能让消息在 main → retry → main 或多个 DLX 之间无限循环。设计保护：

- 最大 attempt；
- 首次失败时间与总重试 deadline；
- 检测 x-death/自定义历史；
- Parking Queue 不自动回主队列；
- 人工/工具重放保留原 eventId，并记录 operator/batch。

## 7. 顺序代价

失败消息进入 Retry Queue 后，主 Queue 后续消息可先被处理，严格业务顺序被破坏。若同订单必须按版本推进：

- 原地暂停该 key/Queue；
- 按 key 分片并只阻塞对应 lane；
- 数据库版本检查，把后续事件暂存；
- 选用 Stream 并由应用管理 offset/重放。

不存在同时“任意延迟重试、其他消息继续、同 key 严格顺序”且无额外状态的免费方案。

## 8. 检查题

1. 配置 DLX 是否保证死信一定进入 DLQ？
2. TTL=5s 是否保证第 5 秒准时投递？
3. 为什么每条消息不同 TTL 会产生头阻塞？
4. At-Least-Once DLX 为什么仍可能在目标重复？
5. Retry Queue 如何破坏订单状态顺序？

