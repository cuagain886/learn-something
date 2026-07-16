# 19｜RabbitMQ Java 客户端源码：Frame、Channel、Dispatcher 与自动恢复

> 阅读目标：跟踪 `basicPublish` 到 socket、Confirm 回调到 Pending、Delivery 到 Consumer Executor、Ack 到 Channel，并解释自动恢复为什么不补发业务消息。

## 1. 组件图

```text
ConnectionFactory
  → FrameHandler (socket/TLS)
  → AMQConnection / AutorecoveringConnection
     ├── MainLoop / frame read
     ├── Heartbeat sender/timeout monitor
     ├── ChannelManager
     └── ChannelN / RecoveryAwareChannelN
          ├── AMQChannel RPC continuation map
          ├── Confirm listeners / outstanding set
          └── ConsumerDispatcher → Executor / WorkPool
```

类名随客户端版本变化，先 checkout 与生产依赖完全一致的 tag。

## 2. `basicPublish` 路径

概念调用：

```text
Channel.basicPublish
→ validate channel/open state
→ construct Basic.Publish method
→ AMQCommand(method, content header properties, body)
→ transmit command frames
→ Connection frame handler writes socket
```

大 body 根据 negotiated frame max 分成多个 body frame。Channel/Connection 内必须保证一个 Content-bearing Command 的 frames 连续写出，避免与另一 Publish 交错。

`basicPublish` 返回只说明调用已写入客户端传输路径，不代表 Broker 路由/落盘。可靠边界在 Confirm listener/Future。

## 3. RPC Continuation

Queue declare 等同步 AMQP 方法是 request/response：Channel 发送 Method，注册 continuation 等待对应 `declare-ok`/异常。由于同一 Channel 的 RPC 有顺序约束，阻塞 RPC 会影响该 Channel 后续操作。

Publish Confirm 是异步扩展，不为每条 Publish 建同步 RPC；这就是它能流水化高吞吐的原因。

## 4. Connection Main Loop

读线程从 FrameHandler 读取 frame，按 channel number 分派：

- channel=0 的 connection-level method；
- channel=N 交给对应 AMQChannel；
- Method/Content 在 Channel 层组装；
- Delivery/Return/Confirm 触发相应 callback/dispatcher。

如果 callback 直接在 IO/MainLoop 执行慢操作，会阻塞 heartbeat、Confirm 和其他 Channel frame。客户端通常用 ConsumerDispatcher/Executor 隔离 Consumer 回调，但 Confirm/Return callback 的具体执行线程仍需查版本并保持非阻塞。

## 5. ConsumerDispatcher

Delivery 到达后，Dispatcher 将工作排到 Executor，并用 WorkPool 保证同一 Channel Consumer callback 的必要顺序/串行约束。应用若给共享 Executor 太少线程，多个 Connection/Channel Consumer 会互相饿死；无界 Executor queue 又会把 Broker prefetch 背压绕过到 JVM heap。

两级背压必须一起设计：

```text
Broker prefetch limits Unacked
Client executor queue limits delivered-but-not-started work
Business downstream limits active processing
```

## 6. Confirm Listener

Broker `basic.ack/basic.nack` 到 Publish Channel 后，客户端通知 Confirm listeners。Library 可能维护 outstanding seq 以提供 waitForConfirms；业务异步 Pending Map 仍要关联 eventId/Outbox row。

Callback 线程不得同步等待同一 Channel Confirm 或做阻塞 publish，避免死锁/停顿。

## 7. Shutdown Signal

Channel/Connection 关闭生成 `ShutdownSignalException`，包含 hard error（Connection）或 soft error（Channel）、initiatedByApplication、reason method 等信息。

分类：

- 应用主动 close：正常清理；
- Channel 406 PRECONDITION_FAILED：拓扑声明冲突，永久错误；
- Connection reset/heartbeat timeout：可恢复网络错误；
- Access refused/not found：权限/拓扑错误，盲目恢复会循环。

## 8. 自动恢复阶段

现代客户端自动恢复大致：

1. 检测 Connection failure；
2. 按 network recovery interval/backoff 重连可用 endpoint；
3. 重新认证/vhost；
4. 恢复 Channel；
5. 恢复 QoS、Confirm、transaction state；
6. 拓扑恢复：Exchange → Queue → Binding → Consumer；
7. 通知 Recovery listeners。

顺序很重要：Binding 不能先于目标 Exchange/Queue，Consumer 不能先于 Queue。

## 9. Topology Recovery Cache

客户端缓存通过该 Connection 声明的 Exchange、Queue、Binding、Consumer。问题边界：

- 其他 Connection/控制面创建的拓扑不一定在该 cache；
- 临时 server-named Queue 恢复后名称可能变化，Binding/Consumer 引用要重写；
- 多实例同时恢复同一 exclusive/auto-delete topology 有竞态；
- Policy 不在客户端 topology cache 内；
- 声明参数已被运维修改会触发等价冲突。

关键业务拓扑应由部署/reconciliation 管理，客户端自动恢复作为连接故障机制，而不是唯一拓扑控制器。

## 10. 为什么不补发 Publish

客户端无法安全判断断线前每条 Publish 是否到 Broker：自动补发会重复，不补发会可能丢。Library 把语义选择交给应用。

正确模式：

```text
Outbox/Pending state owns eventId
Publish Channel Confirm updates state
Connection loss marks outstanding UNKNOWN
Recovery creates new Channel
Application retries UNKNOWN with same eventId
Consumer Inbox makes effect idempotent
```

## 11. Delivery Tag Recovery

恢复后 Channel 是新协议会话，Broker delivery tags 重置。Java client 的 recovery-aware Channel 可能对应用暴露 tag 映射以减少混乱，但旧 Channel Delivery 的 Ack 不能简单在新 Channel 发给 Broker。旧 Unacked 会被 Broker requeue，再以新 tag Delivery。

业务状态必须绑定 eventId，不绑定 deliveryTag。

## 12. Endpoint 与负载均衡

`newConnection(Address[])`/resolver 可以在恢复时选择多个节点。外部 LB 简单，但可能让所有 reconnect 集中；客户端地址解析可感知节点列表。无论哪种，都要加 jitter/backoff 防止 Broker 恢复时 thundering herd。

Quorum Queue 客户端可连任意节点透明路由，但 Leader locality 影响延迟；Stream Client 应使用其 metadata discovery。

## 13. 源码断点路线

1. `ConnectionFactory.newConnection` 与 FrameHandler；
2. `AMQConnection.start/MainLoop`；
3. `ChannelN.basicPublish` → `AMQCommand.transmit`；
4. incoming `basic.ack/basic.return` dispatch；
5. `ConsumerDispatcher.handleDelivery` 和 Executor；
6. `basicAck` frame write；
7. shutdown notification；
8. `AutorecoveringConnection` reconnect/topology recovery；
9. RecoveryAware Channel delivery tag handling。

## 14. 深度检查题

1. `basicPublish` 正常返回为什么不等于 Broker 收到？
2. Consumer Executor 无界队列如何绕过 prefetch 的内存保护？
3. 406 Channel error 为什么不应自动无限重试？
4. 拓扑恢复为何必须按依赖顺序？
5. Library 为什么有意不自动补发断线 Publish？

