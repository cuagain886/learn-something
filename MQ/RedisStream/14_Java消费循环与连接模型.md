# Java 消费循环与连接模型

## 线程与连接拓扑

推荐将“领取”和“处理”解耦但保持有界：

```text
dedicated blocking connection
        |
 XREADGROUP COUNT B BLOCK 2s
        |
 bounded worker queue -> N workers -> DB transaction
                                      -> ACK connection pool
```

阻塞连接不能回普通连接池并被其他请求复用。Lettuce 异步 API 虽不占调用线程，底层连接仍处于阻塞命令语义；Jedis 阻塞调用通常占用调用线程和连接。具体线程安全/自动重连以客户端版本文档为准。

## 有界预取

`COUNT × 并发读取循环` 不能远大于 worker 能力，否则消息快速进入 PEL，却在本地队列等待，idle 看起来像故障并被其他实例 claim。令：

```text
prefetched <= worker_count × acceptable_inflight_per_worker
```

本地队列满时停止下一次 XREADGROUP，而不是无界缓存。处理时长差异大可用小批量和更多 worker；同实体顺序需路由到固定串行 lane。

## 伪代码

```java
while (!stopping) {
    List<Message> batch = readGroup(group, consumer, ">", count, block2s);
    for (Message m : batch) {
        workers.submit(() -> {
            try {
                Result r = transaction(() -> idempotentlyApply(m.eventId(), m));
                ackConnection.xack(stream, group, m.streamId());
            } catch (Retryable e) {
                scheduleRetryThenAck(m, e); // 必须遵守先落重试、后 ACK
            } catch (Permanent e) {
                writeDlqThenAck(m, e);
            }
        });
    }
}
```

伪代码省略了跨槽原子性、批量 ACK 局部失败和 shutdown 排空，不能直接复制生产。

## Consumer 命名

稳定 VM 可用 `service-host-slot`；Kubernetes 可用 StatefulSet ordinal，或 pod UID 加定期清理。随机 UUID 每次重启会残留消费者。consumer 名不是互斥锁，同名并发实例会共享同一 consumer PEL 视图，故部署系统必须确保命名策略与实例生命周期一致。

## 优雅关闭

1. 设置 stopping，停止新的阻塞读；有限 BLOCK 能及时返回。
2. 停止向 worker queue 入队。
3. 在截止时间内等待 in-flight 事务完成并 ACK。
4. 超时任务不 ACK，留给恢复器；不得在未完成时批量 ACK。
5. 关闭 ACK 池和阻塞连接，发布剩余 PEL 指标。

强制 kill 必然留下 pending，这是系统正常恢复路径，不应靠 shutdown hook 假装完全避免。

## 重连与拓扑变更

重连后继续使用 `>` 获取该组新消息，不代表旧 pending 自动处理。启动阶段先处理自己历史或由统一恢复器 claim。捕获 NOGROUP 时不要自动以 `$` 创建；这可能掩盖数据丢失/连错集群。MOVED/READONLY/连接超时应区分，生产 XADD 超时需复用 event_id。

## 序列化和 schema

Stream 字段是字节串。定义 envelope：event_id、type、schema_version、occurred_at、trace_id、content_type、payload。消费者按版本显式分支；不认识的版本进入可诊断 DLQ，而不是默认字段或进程崩溃。避免 Java 原生序列化；使用可演进格式并限制深度/大小。

## 测试重点

- Redis 回复后客户端断线，是否重复业务效果。
- DB commit 后 ACK 连接失败，恢复是否幂等。
- worker queue 满时是否停止领取。
- 长 GC 超过 claim threshold 时是否双执行且被幂等挡住。
- shutdown 截止后 pending 是否能被接管。
- failover 后阻塞连接是否重建，是否错误跳过历史。

