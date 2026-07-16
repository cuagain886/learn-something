# 02｜Connection、Channel 与协议帧：为什么不能一条消息一个连接

> 核心结论：AMQP Connection 是 TCP 连接及认证会话，Channel 是在 Connection 上多路复用的轻量逻辑会话。Connection 昂贵应长期复用；Channel 便宜但不是可被任意线程无约束共享的并发容器。

## 1. 层次关系

```text
TCP Connection
├── Channel 1: publisher confirms
├── Channel 2: publisher confirms
├── Channel 3: consumer + prefetch
└── Channel 4: topology/admin
```

建立 Connection 涉及 TCP、TLS、认证、vhost 权限、心跳和资源分配。Channel 通过 frame header 中的 channel number 在同一 TCP 连接复用。

## 2. AMQP frame

AMQP 0-9-1 操作被编码为 frame。概念类别包括：

- method frame：`basic.publish`、`queue.declare`、`basic.ack` 等命令；
- content header：消息属性和 body 大小；
- body frame：消息正文，可按 frame max 分片；
- heartbeat frame：空闲连接活性检测。

一次消息发布可能由 publish method、content header、一个或多个 body frames 构成。多个线程若在同一 Channel 无正确序列化地同时发布，frame 交错会破坏命令边界；Java 客户端虽可能提供部分保护，仍推荐线程/Publisher 与 Channel 有清晰所有权。

## 3. Channel Exception 与 Connection Exception

协议错误有作用域：

- 不等价 Queue 声明、发布到不存在 Exchange 等常关闭当前 Channel；
- 认证、协议帧损坏或严重连接问题可能关闭整个 Connection。

Channel 被 Broker 关闭后不能继续使用，应用要记录 shutdown cause、重建 Channel 并恢复其 confirms/qos/consumer 状态。捕获异常后在同一个已关闭 Channel 无限重试没有意义。

## 4. 心跳不是业务健康检查

Heartbeat 用于检测 TCP 半开、对端长期不可达，并维持中间网络设备状态。过低会因短暂网络抖动或调度暂停误判，过高会延迟故障发现。

Heartbeat 正常只说明连接层有活动，不证明 Queue 可用、Confirm 正常、Consumer 在处理或数据库健康。业务 readiness 还需拓扑、队列类型和下游检查。

## 5. Connection/Channel 设计

常见建议：

- 每个应用实例少量长期 Connection，发布与消费可按故障隔离使用不同 Connection；
- 每个线程/Publisher worker 使用独立或池化 Channel；
- Consumer Channel 通常由消费线程模型专有，Ack 必须在正确 Channel 上；
- 不建立无界 Channel；监控 Connection/Channel 数、frame rate、blocked 状态；
- 不在每条消息上创建/关闭 Channel。

Channel 池归还前必须清理 Confirm listener、事务/QoS 状态和异常 Channel；否则状态泄漏比创建 Channel 更危险。

## 6. 自动恢复的真实边界

现代 Java Client 支持 Connection 与拓扑自动恢复：重连、恢复 Channel、QoS、Confirm、Exchange/Queue/Binding/Consumer。

但自动恢复不等于发布缓存：连接断开期间调用 `basicPublish` 的消息不会神奇地在恢复后重发。应用仍需 Publisher Confirm、在途记录表和未知结果处理。

拓扑自动恢复也可能与多个实例同时声明临时/独占 Queue 产生竞态，因此临时 Queue 优先服务端命名并设计幂等声明。

## 7. 网络故障的未知窗口

```text
Client 写完 publish frames
Broker 已路由/落入 Queue
Confirm 正在返回
TCP 断开
```

客户端未收到 Confirm，无法断言消息未进入 Queue。重发可能重复，不重发可能丢。可靠 Publisher 要给消息稳定 `eventId`，保留未确认集合，连接恢复后按策略重发，下游幂等。

## 8. 检查题

1. 为什么 Connection 复用而 Channel 隔离？
2. Channel 被 406 错误关闭后能否继续 publish？
3. 自动拓扑恢复是否会补发断线期间丢失的业务消息？
4. Heartbeat 正常为何 Consumer 仍可能不工作？
5. 多线程共享 Channel 的风险发生在消息正文还是 frame 序列层？

