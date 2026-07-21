# 28. Redis、缓存与一致性：低延迟数据结构不等于正确状态

> 优先级：A｜难度：★★★★☆｜基线：Redis 官方当前文档；命令语义按部署 exact version 复验｜前置：[21 NIO](21-java-io-nio-network.md)、[30 分布式](30-distributed-system.md)

## 1. 本章目标

能按数据结构/复杂度选择命令并估算 bytes；能解释事件循环、持久化、复制、Sentinel/Cluster 的失败窗口；能设计 cache-aside 的失效竞态、穿透/击穿/雪崩防护；能说明单实例租约为什么仍需 owner、原子释放与 fencing，且不能替代幂等。

## 2. Redis 快来自一组条件

主要命令在内存数据结构上执行，命令处理以事件循环串行化为核心，避免用户键操作的细粒度锁；网络 I/O、持久化、lazy free、复制等在现代版本还可能有辅助线程/后台过程。不能简化为“Redis 永远只有一个线程”。

单命令原子是相对同实例命令执行序列；它不让多命令 read-modify-write 原子，不含外部 DB，也不保证 failover 后 acknowledged write 必在。O(N) 命令、大 Lua、巨大 value 会占 event loop，拖慢所有客户端。

指标看 command p99、event-loop latency、ops、network bytes、slowlog、CPU，而不是只看平均亚毫秒。

## 3. 数据结构与内存成本

- String：bytes、counter、serialized blob；最大 value/复制成本需限制；
- Hash：对象字段，小对象紧凑编码会随阈值转结构；适合局部字段更新，不是无成本文档库；
- List：两端队列/序列，随机位置慢；可靠队列还需 ack/claim 语义；
- Set：去重/集合运算，超大交并集会阻塞；
- Sorted Set：score+member 排序，排行榜/延迟队列，但同 score/浮点和并发 claim 要定义；
- Stream：append-only id、consumer groups、pending entries，仍需 trim/ack/reclaim/幂等；
- bitmap/hyperloglog/geospatial 等换空间/精度，应按错误容忍选。

一个“key 数”指标看不到大 key。统计 value bytes、成员数、编码、增长率；删除大 key 可用异步 unlink/lazyfree（按版本），但复制、迁移、过期时仍会产生带宽/CPU。

## 4. 过期与淘汰不同

TTL 到期是数据逻辑过期；Redis 通过访问时检查 + 主动抽样等删除，不承诺到点立即物理释放。业务不能用“key 还存在几毫秒”推断 TTL 未到。

maxmemory eviction 在内存压力按 noeviction、LRU/LFU/random/TTL 等 policy 选 key；可能淘汰尚未业务过期数据。缓存可接受 miss，锁/session/idempotency record 被淘汰可能破坏正确性，所以正确性状态不要与可随意淘汰 cache 混用，或用独立实例/policy 与持久 store。

TTL 加随机 jitter 防大量 key 同时过期；jitter 分布需大于重建窗口，不是固定加 1 秒。

## 5. RDB 与 AOF

RDB 周期快照，恢复快/文件紧凑，但最后快照后数据可能丢，fork/COW 在大内存高写入时会放大内存/I/O。AOF 追加写命令，fsync always/everysec/no 交换 durability/latency，rewrite 也需资源。

两者可组合，但“启用持久化”等于何种 RPO 要按 fsync、文件系统、主机故障实测。缓存通常允许重建，作为 source of truth 则还需备份、恢复演练、校验与版本升级。

## 6. replication、Sentinel 与 Cluster

主从复制通常异步，master 继续服务并传 command stream；断线可 partial/full resync。master 在 write 尚未复制时故障、replica 提升，acknowledged write 可能丢。`WAIT` 可降低风险但不是强一致 commit。

Sentinel 做监控、故障判断、leader 选举/配置发现，客户端要正确更新 master；网络分区仍有旧 master/新 master 窗口。Cluster 把 key hash slots 分到 masters，客户端处理 MOVED/ASK，multi-key/Lua/transaction 通常要求同 slot（hash tag）。reshard/failover 会增加 latency。

Redis Cluster 官方明确异步复制和在特定分区窗口丢已确认写的可能。不能用它存唯一财务事实而没有下游持久校验。

## 7. Pipeline、事务与 Lua

pipeline 把多命令一起发送，减少 RTT；响应仍逐条、命令仍按队列执行，不自动原子。batch 太大增加 client/server buffers 和 event-loop monopolization。

MULTI/EXEC 排队后连续执行，WATCH 提供 optimistic check，但没有关系数据库 rollback：运行时部分命令错误需理解具体结果。Lua script 在单实例原子执行期间阻塞其他命令，必须短小有上限；脚本可把 compare-owner+delete 做成一条原子操作，不能把 Redis 与 DB 原子提交。

## 8. Cache-Aside 的真实时序

读：cache get → miss → DB read → cache set；写：DB transaction commit → cache invalidate。先写 cache 再 DB 会在 DB rollback 时留下假值；先删 cache 后写 DB 会让并发 reader 回填旧值。即使“先 DB 后删 cache”，也有：

```text
R: cache miss, read DB v1, pause
W: DB commit v2, delete cache
R: set cache v1  ← stale resurrection
```

[CacheRaceLab](examples/cache/CacheRaceLab.java) 确定性复现该时序；修复示例在 cache 留 `watermark=2` tombstone，拒绝迟到 v1，再允许 v2。实际系统可用 CDC/versioned key、短 TTL、write-through 等，取决于允许陈旧窗口。

cache-aside 是最终一致，不要许诺 DB/cache 原子。读关键决策可带 version/回源或直接读 DB。

## 9. 穿透、击穿、雪崩与热点

- 穿透：不存在 key 反复打 DB。缓存短 TTL negative result、Bloom filter，但权限/租户与“后来创建”要处理；
- 击穿：热点 key 过期同时重建。singleflight/lease 只让一个重建，其他用 stale-while-revalidate/有界等待；
- 雪崩：大量 TTL 同时到/Redis 故障。jitter、多级 cache、限流/降级、DB admission；
- 热点 key：单 shard/网卡/CPU；本地 cache、副本读、拆分 key、广播更新，但一致性更复杂；
- 大 key：网络、序列化、复制/迁移/删除阻塞；拆 chunk/field 和硬 size limit。

singleflight 本地只合并单实例；分布式合并仍需处理 owner 崩溃和 stale result。允许服务旧值常比全体等待更抗故障，但要在响应标 age/version。

## 10. 多级缓存

L1 本地 Caffeine 等低延迟，L2 Redis 跨实例，DB source：

```text
L1 → L2 → DB
写 DB → invalidate/update L2 → broadcast/CDC invalidate L1
```

广播可能丢/乱序，消息带 version，L1 只接受更新 watermark 的失效。实例重启从空 cache 开始；长断线后全量 version/epoch 切换。不能靠 pub/sub 一次通知获得强一致。

Write-through 同步写 cache/store 易管理读但 store 失败语义复杂；write-behind 延迟持久化可丢数据/重排，必须 WAL、幂等、replay，不用于不能丢的状态。

## 11. Redis 锁的最低正确性

单实例基本租约：`SET lock randomOwner NX PX ttl`；释放用 Lua “value 等于 owner 才 DEL”。只用 SETNX 无 TTL 会死锁；无 owner 的 DEL 会删别人新锁；续期必须仍是 owner，并有总 deadline。

即便正确释放，client A pause 超过 TTL，B 取得新租约，A 恢复后仍可能写资源。锁服务无法撤回 A 的 CPU。资源端必须接受单调 fencing token：只允许 token ≥ 已见最高；仓库 [FencedLockLab](examples/distributed/FencedLockLab.java) 复现并拒绝旧 token。

Redis failover 还存在异步复制窗口：A 在 master 获锁、未复制即故障，B 在新 master 获锁，双 owner。是否接受取决于资源损害；高要求用有共识/linearizable lease 的系统加 fencing，仍保留业务幂等。

## 12. Agent 使用 Redis

适合：短期 cache、rate-limit counters（算法/cluster slot 清楚）、SSE replay 小窗口、presence/ephemeral lease。持久 run/tool 状态、幂等事实和审计以数据库/event log 为准。

prompt/model response cache key 包 tenant、model/version、parameters、tool schema、policy、prompt hash；输出可能含隐私，需加密/ACL/TTL/删除。语义 cache 有错误命中风险，评测 precision/安全边界后启用。

rate limiter Lua 原子不代表跨 cluster/global 准确；时钟、failover 和 Redis down 时选择 fail-open/closed。模型成本限额通常宁可 fail-closed。

## 13. 外部验证与观测

Docker daemon 当前未运行，Redis server 实验未冒充完成。目标环境应验证：AOF/RDB crash RPO、replica failover acknowledged write、pipeline RTT/bytes、大 Lua 对 p99、hot/big key、expiry/eviction、Cluster slot/redirect、租约 pause/failover。

指标：used/rss/fragmentation、evicted/expired、keyspace hits/misses、command latency/slowlog、blocked clients、network、replication offset/lag、fork/COW、cluster state/slot、client pool pending。cache hit ratio 高也可能因大 value/热点而慢。

## 14. 常见误区与清单

1. **Redis 单线程所以无并发问题**：客户端多命令、复制/failover/外部 DB 仍有竞态。
2. **pipeline 是事务**：只减少 RTT。
3. **过期等于立即删除**：物理回收有策略。
4. **缓存删除后不会回旧值**：迟到 reader 可回填。
5. **SETNX 就是分布式锁**：缺 owner/TTL/原子释放/fencing/failover。
6. **分布式锁替代幂等**：暂停、重复消息和结果未知仍存在。

- [ ] 能给 key/value/member 设置硬上限。
- [ ] 能画 cache-aside stale race。
- [ ] 能区分 RDB/AOF/replication durability。
- [ ] 能设计 owner+TTL+Lua+fencing。
- [ ] 能用 version 处理多级失效乱序。
- [ ] 能在 Redis down 时定义降级。

## 15. 延伸阅读

- [Redis Persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- [Redis Replication](https://redis.io/docs/latest/operate/oss_and_stack/management/replication/)
- [Redis Cluster Specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
- [Redis Distributed Locks](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/)

下一章：[29 消息队列与异步系统](29-message-queue.md)。
