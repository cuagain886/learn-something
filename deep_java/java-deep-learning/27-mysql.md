# 27. MySQL/InnoDB：索引、MVCC、日志与锁如何决定请求延迟

> 优先级：S｜难度：★★★★★｜基线：MySQL 8.4 LTS / InnoDB｜前置：[24 事务](24-spring-aop-transaction.md)、[26 JDBC](26-jdbc-connection-pool.md)

## 1. 本章目标

能从 Java 请求沿 pool/driver/protocol/optimizer 到 InnoDB page；能用聚簇/二级索引结构解释回表、覆盖与联合索引；能区分 redo/undo/binlog；能从 read view 推导一致性读，从具体 SQL/索引/隔离级别推导 record/gap/next-key locks；能用实际 plan/locks 而非“加索引”猜调优。

## 2. 端到端链路

```text
Controller → Service → Spring Transaction
 → Hikari acquisition → Connector/J Connection
 → MySQL protocol/TLS → server thread/session
 → parser/resolver → optimizer → executor
 → InnoDB indexes/locks/MVCC → buffer pool → filesystem/storage
 → rows/packets → ResultSet mapping → commit/response
```

端到端 500ms 可能是池等 300ms、lock wait 180ms、SQL 20ms；慢查询日志只看到 server execution，不含 pool queue/Java mapping。必须用同一 trace/request connection/thread id 对齐分段时间。

## 3. page 与 B+Tree

InnoDB 以 page 为核心 I/O/cache 单位，B+Tree 非叶节点存分隔 key+子页，叶节点有序链接。高 fan-out 使树高较低；一次逻辑查询仍可能触发多个 page read、buffer miss 和 random I/O。

页分裂/合并、记录 header、free space、change buffer 等是具体实现；不要用“B+ 树三层所以任何查询三次 I/O”作结论。buffer pool 命中时没有磁盘读，范围扫描读很多叶页，回表又访问其他页。

主键应稳定、尽量短且单调有利局部性；完全递增也可能形成最后页热点，高并发/分片需实测。随机宽 UUID 让所有二级叶都携带更宽主键，增加页与 cache 压力；可用有序二进制 ID，但业务唯一性/迁移优先。

## 4. 聚簇与二级索引

InnoDB 聚簇索引叶保存整行；有主键用主键，否则选合适 unique non-null，否则生成隐藏 key。二级索引叶存二级 key + 主键，因此：

```text
where email=?
 → secondary B+Tree 找 primary key
 → 若所需列不全，再到 clustered B+Tree 回表
```

若 select 列与条件都由二级叶覆盖，可避免回表（covering index）。覆盖不是 `EXPLAIN Extra` 名词游戏：宽索引会增写放大、内存与维护成本。只投影 API 所需列，不用 `select *`。

## 5. 联合索引、最左前缀与 ICP

联合 `(tenant_id, status, created_at, id)` 按 lexicographic 排序。等值 tenant+status 后 created_at 范围可连续扫描；跳过前导列通常不能用同样的有序定位能力（optimizer 可能 index skip scan 等，必须看 plan）。范围列之后的列通常不能继续缩窄索引扫描边界，但可用于 index condition/filter/order 等。

Index Condition Pushdown 让 storage engine 在二级索引层先判断可用条件、少回表；不代表扫描行数为 0。列函数、隐式类型/字符集转换、前导通配可能破坏 sargability。

索引设计从固定查询族出发：tenant/权限等高选择前缀、等值、范围、order、projection；同时考虑写频率和唯一约束。一个万能十列索引通常不可维护。

## 6. optimizer 与执行计划

optimizer 按统计信息估 cardinality/cost 选 access path、join order/algorithm。`EXPLAIN` 是估计；MySQL 8.4 `EXPLAIN ANALYZE` 实际执行并报告 iterator 的 estimated rows、actual rows、first/all-row time、loops。

重点读：actual vs estimate 偏差、rows×loops、access type/key、过滤比例、排序/临时、回表与 join 被重复执行次数。总耗时不等于各节点简单相加（parent 包含 child 等）。对 UPDATE/DELETE 的 ANALYZE 要在安全副本/事务中谨慎，因为会真实执行。

统计信息过期/数据倾斜可导致错 plan；ANALYZE TABLE/histogram 有成本与适用列。强制 index hint 是最后手段，会随数据变化腐化。

## 7. Buffer Pool

Buffer Pool cache data/index pages，并管理 dirty pages、flush、LRU-like lists。命中率接近 100% 也可能慢：扫描绝对页数大、锁等待、单 page contention、dirty flush 或 CPU 高。看 buffer pool reads/request、dirty %, page age/eviction、I/O latency 与 working set。

数据库与 OS page cache/redo/binlog buffer 共同占内存；容器 memory limit 下配置不能只看 innodb_buffer_pool_size。首次/冷 cache 和热 cache plan 性能需分别测。

## 8. Redo、Undo 与 Binlog

- redo 是 InnoDB WAL，记录页修改所需恢复信息，支持 crash recovery；提交 durability 受 flush 策略/存储保证；
- undo 保存旧版本/逆向信息，支持 rollback 与 MVCC consistent read；长 read view 阻止 purge，history 增长；
- binlog 在 server 层记录逻辑/row events，用于 replication/PITR；不是 InnoDB redo 的别名。

提交需协调 redo 与 binlog，防“引擎提交但复制日志无”之类不一致；具体两阶段提交流程和 sync 参数按 8.4 文档。应用收到 commit 连接断开仍可能结果未知，日志机制不会替应用提供业务幂等。

## 9. MVCC 与 Read View

记录版本由事务 id/undo 链关联。consistent read 根据 read view 判断某版本对当前事务是否可见：概念上考虑创建 view 时 active transactions、上下界和自身事务。不要简化成“比较一个版本号”。

MySQL 8.4 InnoDB 默认 REPEATABLE READ：事务第一次 consistent read 通常建立 snapshot，后续一致性读复用；READ COMMITTED 每次 consistent read 有新 snapshot。当前读/locking read（UPDATE、SELECT FOR UPDATE 等）读最新可锁版本，不等同 snapshot read。

因此同一事务先普通 SELECT 看旧值，再 UPDATE 基于当前版本，行为看似矛盾但来自不同读类型。业务用 optimistic version (`update ... where id=? and version=?`) 显式检测冲突更易推导。

## 10. 锁在索引记录上

InnoDB record lock 锁 index record；无合适 index 的条件可扫描并锁大量记录/范围。意向锁是 table-level 协调多粒度，不等于把所有行锁升级为表锁。

在 REPEATABLE READ，next-key lock = record + preceding gap，用于范围 locking read 防 phantom inserts；纯 gap lock 抑制插入，gap S/X 可共存，因为不保护已有记录。唯一索引精确查完整 unique key 通常只需 record lock；只用联合唯一一部分仍可能 gap。

READ COMMITTED 对普通搜索/扫描减少 gap locking（外键/duplicate checks 等仍有），不等于“没有锁”。具体 SQL 的 lock set 受索引、执行路径、是否匹配和版本影响，用 Performance Schema `data_locks/data_lock_waits` 验证。

## 11. deadlock 与 lock wait

deadlock 是等待图环，InnoDB 检测并选择 victim rollback；应用收到错误必须 rollback 整事务，并仅在操作可重试/有预算时重试。统一资源顺序、短事务、精确索引与小 batch 减少环。

lock wait timeout 只是等太久，没有证明环；被阻塞者的 SQL 不一定是根因，root blocker 可能 idle in transaction。采集：当前事务、等待边、locked index/record、SQL digest、transaction age、Java trace。

`SHOW ENGINE INNODB STATUS` 只有 latest detected deadlock；生产需开启/采集 deadlock 日志并关联业务 key，Performance Schema 给当前边。不要 kill 所有等待线程，先找到 blocker 和事务所有者。

## 12. 长事务的系统性损害

长事务持 connection/locks、延迟 purge/undo 回收、增加 replica lag 和失败重做；只读长 snapshot 也会保留历史。常见来源：事务内 HTTP、逐行大循环、连接借出后等待、手工客户端忘 commit。

指标：oldest transaction age、history list length、lock age、rows modified、pool usage。把 batch 分短事务需定义断点/幂等/checkpoint，不是简单每 1000 行 commit 后假装全有或全无。

## 13. Java 请求的调优顺序

1. 从 trace 分开 pool wait、DB time、mapping/serialization；
2. 保存参数形状（脱敏）、schema/index、isolation、plan 与 actual；
3. 查 lock waits/transaction age；
4. 读 rows examined/returned 与 network bytes；
5. 改索引/SQL/事务边界，固定负载复验 p99 和写成本。

ORM N+1 会把一次页面变成 101 round trips；日志单条都快但总请求慢。用 request-level query count/bytes，并显式 fetch plan/batch。

## 14. 外部实验（尚未在本机验证）

本机只有 Docker client，daemon 未运行，因此没有把 H2 输出冒充 MySQL。MySQL 8.4 环境应完成：

- 建 `(tenant,status,created_at,id)` 联合索引，对比覆盖/回表 `EXPLAIN ANALYZE`；
- 两 session 以 REPEATABLE READ 做范围 FOR UPDATE，第三 session insert，查询 `performance_schema.data_locks/data_lock_waits`；
- 相反顺序 update 两行复现 deadlock，保存 InnoDB status；
- 开长一致性读并持续更新，观察 history/purge；
- Connector/J streaming 条件与 JVM heap/网络 fetch 对照。

每份报告记录 MySQL exact version、schema、row count/distribution、buffer warm/cold、server variables 与原始输出。

## 15. Agent 数据模型

`agent_run(tenant,id,status,version,deadline,...)` 用 `(tenant,id)` 主键；claim 用 version/status 条件 update，检查 affected rows。事件表按 `(run_id,sequence)` unique；tool invocation/idempotency key unique；outbox 同事务写。

轮询 worker 用合适索引和 `FOR UPDATE SKIP LOCKED`（按 MySQL 8.4 具体语义验证），短事务 claim 后立即 commit，模型/tool 在事务外执行。完成再以 version CAS 写结果；旧 worker 被 fencing。

## 16. 常见误区与清单

1. **B+Tree 查询固定三次磁盘 I/O**：cache、范围、回表都改变。
2. **有索引就不会锁很多**：执行路径和范围决定 lock set。
3. **RR 所有 SELECT 都同一 snapshot**：locking/current reads 不同。
4. **gap X 与 gap S 互斥**：gap locks 可共存，目标是抑制插入。
5. **redo=binlog**：层次、格式、用途不同。
6. **EXPLAIN 就是实际**：用 ANALYZE/运行指标核对估计。

- [ ] 能画二级索引回表路径。
- [ ] 能按查询族设计联合索引。
- [ ] 能解释 read view 与 current read。
- [ ] 能从索引+隔离推导 lock 范围。
- [ ] 能对齐 Java pool wait 与 MySQL lock/plan。
- [ ] 能为 Agent claim/checkpoint 建唯一键与 CAS。

## 17. 延伸阅读

- [MySQL 8.4 InnoDB Introduction](https://dev.mysql.com/doc/refman/8.4/en/innodb-introduction.html)
- [Clustered and Secondary Indexes](https://dev.mysql.com/doc/refman/8.4/en/innodb-index-types.html)
- [EXPLAIN ANALYZE](https://dev.mysql.com/doc/refman/8.4/en/explain.html)
- [InnoDB Locking](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html)

下一章：[28 Redis、缓存与一致性](28-redis.md)。
