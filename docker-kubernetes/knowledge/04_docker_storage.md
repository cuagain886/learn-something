# 04 · Docker 存储：可写层、mount 与数据一致性

> 对应实验：[08 数据持久化](../code/08_storage_persistence/README.md)、[10 Compose](../code/10_compose/README.md)。

## 1. 先分清两类“Docker 存储”

```text
镜像/容器存储后端：layers、writable snapshot、copy-on-write
应用数据 mount：volume、bind、tmpfs
```

前者让镜像和容器文件系统高效组合；后者让数据获得独立生命周期。数据库写进 writable layer 即使“技术上能工作”，也把数据绑定到易失 container object，且承受 CoW 与备份边界问题。

---

## 2. copy-on-write 的成本模型

容器读取下层文件时可直接共享。第一次修改下层文件，典型 overlay/snapshot 实现需要 copy-up 到可写层再修改。成本与文件大小、目录深度、元数据变化和存储 backend 有关。

```text
read unchanged file → lower layer
modify lower file   → copy-up → writable layer version
delete lower file   → whiteout/遮蔽，不改写 lower blob
```

容器可写层适合易失变化，不适合高写入、需备份和跨替换的核心状态。`docker ps --size` 也不包含 volume、全部日志和所有缓存，不能当完整容量报表。

---

## 3. mount 的 VFS 语义：覆盖而非合并

把任意 mount 挂到 `/data` 后，进程从该 mount 解析 `/data/...`，镜像原目录被遮蔽。重新创建不带 mount 的容器才能重新看到原内容。

Docker 对全新空 volume 挂到非空镜像目录有预填充便利行为，但这是创建时的数据播种，不是持续双向同步。之后 image 更新不会自动迁移已有 volume。

这解释了常见升级事故：新版 image 带新默认配置，旧 volume 仍遮蔽它。迁移必须显式版本化和幂等执行。

---

## 4. volume 与 bind 的所有权差异

### named volume

- Engine 管理身份与位置，可用 driver 接外部存储。
- 生命周期独立于容器；删除需单独动作。
- 适合应用数据，但访问仍受容器内 UID/GID 和文件模式影响。
- Docker Desktop 的真实数据在 Linux VM 中，不应直接修改内部 Mountpoint。

### bind mount

- 宿主路径是 API 契约，部署与宿主目录结构耦合。
- 宿主和容器可同时修改同一文件，需考虑锁、监听、大小写和权限语义。
- Windows/macOS 文件共享跨 VM 边界，延迟与事件行为可能不同于原生 Linux。
- 默认可写会扩大宿主破坏面，应优先 readonly 和最窄路径。

volume 强调 daemon 管理与可移植生命周期；bind 强调宿主可见性。选择不是“生产永远 volume”，而要结合 storage driver、外部存储、备份和调度模型。

---

## 5. tmpfs 与秘密边界

tmpfs 绕过容器可写层，停止后内容消失，适合临时文件与短期敏感数据。但：

- 可能受 swap 影响，不能保证物理介质永不出现。
- 默认容量可能很大，应设置 size/inodes。
- 不能跨容器共享。
- 重启即丢失，应用必须能重建。
- mount 路径权限要与非 root UID/GID 协调。

秘密安全还包括注入、日志、进程环境、core dump 和读取权限；tmpfs 只解决其中的存储生命周期一部分。

---

## 6. 持久化不等于一致性、备份或高可用

四个概念：

| 能力 | 回答的问题 |
|------|------------|
| persistence | 容器/进程结束后字节还在吗 |
| consistency | 快照中的多文件/事务状态逻辑一致吗 |
| backup | 是否有独立副本、保留与恢复流程 |
| high availability | 单节点/单盘故障时服务能否继续 |

Redis AOF volume 提供持久化机制，但 `appendfsync everysec` 允许特定故障窗口；单 volume 也不是异地备份或 HA。可靠方案必须明确 RPO、RTO、故障模型，并做恢复演练。

### 数据库备份为何不能只 tar

数据库可能同时修改数据文件、WAL/AOF、manifest 和内存状态。无协调复制可能捕获互不一致的时间点。优先级通常是：数据库原生逻辑/物理备份接口 → 协调文件系统快照 → 明确停写后的复制。

---

## 7. 删除与容量治理

named volume 默认不会随 container rm 或 Compose down 删除，这是数据保护也是泄漏空间来源。治理应依赖：

- project/owner/purpose labels。
- 容量、inode、增长率和备份监控。
- 明确 retention 与删除审批。
- 精确 `volume rm`，避免在共享主机盲目 prune。
- 定期从备份恢复到隔离环境并校验业务数据。

## 8. 官方资料

- [Docker storage overview](https://docs.docker.com/engine/storage/)
- [Volumes](https://docs.docker.com/engine/storage/volumes/)
- [Bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)
- [tmpfs mounts](https://docs.docker.com/engine/storage/tmpfs/)
- [Storage drivers](https://docs.docker.com/engine/storage/drivers/)

## 小结

容器可写层服务于易失实例，mount 服务于独立数据生命周期。volume、bind、tmpfs 的本质差异是所有权和生命周期；真正的生产数据设计还必须补齐一致性、备份恢复、容量、安全和高可用。
