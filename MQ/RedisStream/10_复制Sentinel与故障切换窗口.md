# 复制、Sentinel 与故障切换窗口

## Redis 复制默认异步

主节点执行 XADD/XACK 后把命令流异步发送给副本。主回复客户端时，不要求多数副本已经持久保存。因此存在：

```text
client <- success -- primary crashes before replica receives write
                         |
                         v
                  stale replica promoted
                         |
                         v
                  acknowledged event missing
```

丢失的不只可能是消息，也可能是组推进、PEL、ACK 或 claim。不同状态丢失会产生重复、重新投递、NOGROUP 或 owner 回退。

## replication ID、offset 与 PSYNC

主节点维护复制历史身份和偏移。副本断线重连时带已知 replication ID/offset；若主节点 backlog 仍覆盖缺口，可部分同步，否则全量同步。backlog 过小、断线过久或主身份变化会增加全量同步概率和恢复压力。

偏移表示复制流位置，不是 Stream ID，也不是业务事件数。一个命令可能传播不同字节量，不能用 replication offset 直接推消息 lag。

## WAIT 能做什么

写后执行 `WAIT replicas timeout` 可等待指定数量副本确认已处理到当前连接的复制偏移，降低主回复后立即故障导致丢写的概率。它不保证：

- 副本已 fsync 到持久介质。
- Sentinel/Cluster 一定选择刚确认的那个副本。
- 网络分区下不存在旧主接受写的窗口。
- Redis 变成线性一致或共识系统。

而且 XADD 与随后 WAIT 是两个命令；其语义是等待此前写传播，不是把多个业务命令变成事务提交。

## Sentinel 切换时序

Sentinel 负责监测、达成故障判断、选择副本晋升并重配置其他节点/客户端。客户端会经历超时、连接断开、重定向到新主。在拓扑收敛前：

- 旧连接请求结果可能不确定。
- 客户端重试 XADD 可能重复业务事件。
- 阻塞 XREADGROUP 连接必须重建。
- 新主若状态落后，已 ACK 消息可能重新出现，或已写消息消失。

消费者恢复依赖业务 event_id 幂等，生产者重试也必须复用 event_id。

## `min-replicas-to-write` 的作用与边界

可配置主节点仅在足够副本处于可接受延迟时接收写，减少孤立主长期接受不可复制写的风险。它提高可损失窗口约束但降低网络故障时可用性，且仍不是同步多数派提交。参数必须结合副本数、跨区延迟和业务 RPO 演练。

## 脑裂与 CAP 取舍

客户端与主可达、主与 Sentinel/多数派隔离时，旧主可能短时间继续接受写；另一侧晋升新主后，旧主重新加入会丢弃其分叉数据。限制写条件能缩短窗口，不能宣称完全消除。若业务要求已确认消息在任意单点/分区切换下绝不丢，应使用具备相应共识/持久提交语义的系统并正确配置。

## 故障演练观察矩阵

| 故障点 | 检查 |
|---|---|
| XADD 回复前断网 | event_id 是否出现 0/1/多次 |
| XADD 回复后立即 kill 主 | 新主是否有 payload |
| XREADGROUP 后切换 | group ID、PEL owner、delivery count |
| DB commit 后、ACK 前切换 | 是否重投且幂等成功 |
| ACK 后切换 | ACK 是否回退导致重复 |
| 阻塞连接切换 | 客户端是否重连、是否错误用 `$` 跳消息 |

每轮记录主从 offset、角色、AOF 配置和精确时间线，否则无法区分复制延迟、客户端重试和持久化丢失。

## RPO 表述模板

不要写“主从高可用，数据不丢”。应写：

> 正常写入在主内存执行；复制异步。客户端可选 WAIT N 收窄窗口，主节点限制最少健康副本；在分区、选主或多节点同时故障下仍可能丢最近已确认写。业务以 event_id 幂等处理重复，关键事实以数据库/outbox 留存，演练测得目标 RPO/RTO 为……

