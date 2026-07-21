# 26. JDBC 与连接池：从 Java 调用到数据库会话的容量边界

> 优先级：S｜难度：★★★★☆｜基线：JDBC 4.3 / JDK 21、HikariCP 7.0.2｜前置：[24 事务](24-spring-aop-transaction.md)

## 1. 本章目标

能从 DataSource 借连接跟踪到 driver/network/database session；能正确使用 PreparedStatement、batch、ResultSet 和 transaction；能用到达率/持有时间解释池等待；能读 HikariCP 借还、ConcurrentBag 与 HouseKeeper 的职责，并定位泄漏、慢 SQL、网络故障而非盲目扩大池。

## 2. JDBC 是 SPI 契约

`java.sql` 定义 Driver、Connection、Statement、ResultSet 等接口；vendor driver 实现协议、类型映射、错误码、TLS、failover。DriverManager 适合简单启动；服务端通过 DataSource 获得连接，便于池、JNDI、监控和凭据管理。

```text
application → DataSource/pool proxy Connection
 → driver physical connection → socket/TLS → DB session
 → parse/bind/execute/fetch → ResultSet → mapping
```

`Connection.close()` 对池代理通常是归还并重置状态，不是关闭物理 TCP。忘 close 就是长期借用；try-with-resources 要覆盖 Connection、Statement、ResultSet。

## 3. PreparedStatement 与注入边界

参数值必须用 `?` 绑定，不能字符串拼接：

```java
try (PreparedStatement ps = c.prepareStatement("select * from run where tenant_id=? and id=?")) {
    ps.setString(1, tenant); ps.setLong(2, id);
}
```

绑定把 SQL structure 与 value 分开，driver 是否 server-side prepare、何时缓存由实现/参数决定。表名、列名、ORDER BY 方向不能当 value 绑定，必须映射到固定 allowlist；不要把用户字符串原样拼进去。

仓库实测把 `x'); drop table item; --` 作为参数批量插入，表和原值都保留。它证明参数路径，不替代数据库最小权限、SQL 日志脱敏和查询资源上限。

## 4. round trip、batch 与 generated keys

每次 execute 都可能是网络往返；N 次单行 insert 的延迟通常远大于一次 batch。`addBatch/executeBatch` 仍受 driver rewrite、packet/statement 大小、事务日志和错误语义影响。返回 count 可能是 `SUCCESS_NO_INFO/EXECUTE_FAILED`，部分 batch 失败要读 BatchUpdateException counts 并决定整事务回滚。

超大 batch 会占 client/server memory、锁和 redo；分块并在相同事务/幂等策略下提交。generated keys 也可能改变批处理优化，按目标 driver 验证。

## 5. ResultSet 与流式读取

默认 driver 可能预取全部或分批 fetch；`setFetchSize` 是 hint，MySQL/PostgreSQL 等启用 server cursor 的条件不同。只有 forward-only、正确 autoCommit/driver properties 等组合才可能真正流式，不能看到 while(rows.next) 就宣称 O(1) 内存。

ResultSet 活着时通常持 Statement、Connection 和 server cursor；业务逐行做远程调用会长时间占连接。应在短 DB 阶段映射/分页或通过有界 pipeline 解耦，但要保留一致性需求。大 BLOB 用 getBinaryStream，也必须限 bytes 并及时关闭。

分页深 offset 让数据库扫描/丢弃大量记录；稳定唯一排序下用 keyset (`where (time,id) > (?,?)`) 更可控。

## 6. JDBC transaction

autoCommit=true 时每 statement 自成事务（具体 commit 时点查 driver/DB）。多语句不变量：setAutoCommit(false) → execute → commit；异常 rollback；finally 恢复/归还由 pool proxy 负责。

savepoint 允许局部 rollback，不是独立 commit。isolation/readOnly/network timeout/schema/catalog 等 connection state 若不重置会污染下个借用者；成熟 pool proxy 负责已知状态，但用户修改 vendor session variables 需显式恢复。

commit 响应丢失时结果未知：不能简单 rollback（连接已断）或无脑重做。用业务唯一键/operation id 查询最终状态。

## 7. 连接池是并发 semaphore + 生命周期管理

maximumPoolSize 限制物理 DB sessions；无 idle 时 getConnection 排队到 connectionTimeout。池不是让 SQL 更快，而是复用握手并保护 DB。

Little's Law：平均 in-use connections `L ≈ λ × W`。500 req/s、每请求持连接 20 ms，平均需要约 10；p99、事务内远程等待与 burst 决定余量。若 SQL 持有时间翻十倍，固定池立即排队，扩大池可能把数据库 CPU/lock 推到更坏。

容量必须满足：所有应用实例 pool max 总和 + 运维/复制 < DB max connections；滚动扩容时旧新实例重叠也算。按数据库可并行能力设置，不按 HTTP threads/虚拟线程数设置。

## 8. HikariCP 关键参数

- `maximumPoolSize`：idle+active 上限；耗尽后等待；
- `minimumIdle`：最低 idle；官方建议常用固定大小默认以响应突发，但需结合 DB 总预算；
- `connectionTimeout`：借用等待，最低 250 ms；
- `validationTimeout`：活性检查且小于 connectionTimeout；优先 JDBC4 `isValid`，不随意配 test query；
- `idleTimeout`：仅 minIdle < max 时淘汰，HouseKeeper 有时间粒度；
- `maxLifetime`：只在连接归还后退休，需略短于 DB/LB/firewall 上限，并做负偏移防同时死亡；
- `keepaliveTime`：只 ping idle connection，必须小于 maxLifetime；
- `leakDetectionThreshold`：借出超过阈值记录获取栈，是诊断提示，不会自动回收。

时钟不准会影响生命周期/timeout，生产主机需要可靠时间同步。驱动 socket/connect timeout 与 pool acquisition timeout 是不同层，都要配置。

## 9. Hikari 内部结构的阅读边界

7.0.2 当前源码中，HikariDataSource/HikariPool 管理生命周期；ConcurrentBag 支持高并发 borrow/requite，含线程本地快速路径、共享列表与等待者/添加连接协调；ProxyConnection 跟踪 statement/dirty state 并在 close 时清理归还；HouseKeeper 周期处理 idle/需要补充等任务，max lifetime 有独立 scheduled retirement 协作。

`FastList` 用于低开销跟踪 statement 等内部对象，减少普通 ArrayList 边界/删除成本；它不是用户可调“连接池算法”。实现字段会变，排障依赖公开 MXBean/metrics 与准确 tag，不在业务代码反射内部类。

借用概念路径：先尝试可用 bag entry → 无则登记 waiter/触发 add → poll 到 timeout → validate/evict → 包成 proxy；归还清理 open statements/rollback dirty transaction/reset state，再 requite。任何阶段的网络检查也可能慢，不能把 pool timeout 当唯一超时。

## 10. 可运行池耗尽实验

[jdbc-pool](labs/jdbc-pool) 固定 HikariCP 7.0.2、H2 2.3.232：maximum=2、minimumIdle=0、connectionTimeout=250ms。持有两条连接后，第三个虚拟线程借用实际约 265ms 抛 `SQLTransientConnectionException`，MXBean active=2；归还后继续 query。

```powershell
cd labs\jdbc-pool
.\run.ps1
```

同一实验还验证参数绑定、3 项 batch、forward-only ResultSet/fetchSize。H2 只验证 JDBC/pool 行为，不能冒充 MySQL 协议、cursor、索引和 lock 证据。

## 11. 故障定位

`connection acquisition timeout` 先看 active/idle/pending、最长 borrow 与 SQL/transaction duration：

```text
active=max, pending↑
 ├─ DB query/lock 慢 → plan/lock waits
 ├─ transaction 包含远程/大映射 → 缩短持有
 ├─ Connection 泄漏 → acquisition stack + code path
 └─ DB/network 建连失败 → creation errors/socket metrics
```

池 idle 多但请求慢，瓶颈不在借连接；active 未满却 creation 失败，要看 DB max/user/TLS/DNS/firewall。leak report 也可能只是合法长 query，需与 SQL event 对齐。

metrics：active/idle/total/pending、acquire duration、usage duration、creation failures/time、query/transaction duration、DB sessions/CPU/locks。只看 pool size 没有因果。

## 12. Agent 场景

run 状态写入用短事务；不要持连接等待模型/tool。流式事件分批/单 writer 写，batch 有 bytes/time 上限。checkpoint 带 version CAS，两个 worker 不能同时完成同一 run。

虚拟线程可让 10 万任务等待，但 DB pool 仍可能只有 20；在进入事务前用 admission/queue deadline，超时任务不再获取连接。pool timeout 要小于请求剩余 deadline，并映射明确的 overload 错误。

## 13. 常见误区与清单

1. **PreparedStatement 自动让所有 SQL 安全**：identifier/order 仍需 allowlist，权限/资源仍有限制。
2. **ResultSet while 就是流式**：依 driver/cursor/fetch 配置。
3. **池越大越快**：DB 饱和后更多并发只增加锁/切换。
4. **connectionTimeout 是 SQL timeout**：只管借用等待。
5. **close 关闭物理连接**：池 proxy 通常归还。
6. **leak detector 会修泄漏**：只报警。

- [ ] 能画 pool/driver/socket/server 路径。
- [ ] 能按 λ×W 估算并用压测收敛。
- [ ] 能区分 acquisition/connect/socket/query/transaction timeout。
- [ ] 能解释 Hikari borrow/requite/housekeeping。
- [ ] 能证明查询真正流式。
- [ ] 能处理 commit 结果未知。

## 14. 延伸阅读

- [JDBC API, Java 21](https://docs.oracle.com/en/java/javase/21/docs/api/java.sql/java/sql/package-summary.html)
- [HikariCP 7.0.2 README/configuration](https://github.com/brettwooldridge/HikariCP)
- [HikariCP 7.0.2 source](https://github.com/brettwooldridge/HikariCP/tree/HikariCP-7.0.2/src/main/java/com/zaxxer/hikari)

下一章：[27 MySQL、事务与索引](27-mysql.md)。
