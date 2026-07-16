# 保留策略、删除与悬空 PEL

## 两条独立生命周期

```text
消息生命周期: XADD -> 可范围读取 -> XDEL/XTRIM -> payload 不可用
交付生命周期: 未交付 -> PEL(owner,idle,count) -> XACK -> PEL 删除
```

经典语义下，两条生命周期不自动绑定。对仍 pending 的条目执行删除/裁剪，PEL 可能保留 ID，但消息主体已不存在。消费者读取 pending 历史时会得到该 ID 对应的空值/nil payload，不能继续业务处理。

## 为什么实现要分离

一条消息可被多个组读取；若删除必须扫描并更新所有组 PEL，删除成本会随组数和 PEL 规模放大，破坏可预测性。独立索引让组各自管理确认，但把引用清理责任暴露给应用和新版策略命令。

## 版本相关的引用策略

较新的 Redis 版本为删除、裁剪和 ACK+删除增加了引用处理选项/命令，例如按策略保留引用、删除引用，或只在所有组已确认时删除。名称与可用参数需以部署版本的 `XDELEX`、`XACKDEL`、`XTRIM` 命令文档为准。

上线前执行：

```redis
COMMAND INFO XDELEX XACKDEL XAUTOCLAIM
COMMAND DOCS XTRIM
```

不要把新版本示例直接复制到旧集群。即使使用“已被所有组确认才删除”，仍需处理组永久停用、组游标重置和新增组的语义。

## 保留窗口必须覆盖什么

```text
retention >= 最大正常积压时间
          + 最长消费者故障发现时间
          + 最长恢复/重放时间
          + 运维响应余量
```

如果只按正常 TPS 配 `MAXLEN`，流量洪峰时实际时间窗口会骤降，仍 pending 的 payload 可能被裁掉。监控应测“最老可读消息年龄”而不只看 XLEN。

## 多组带来的保留难题

fast-group 已全部 ACK，slow-group 停了两天。若统一 Stream：

- 为 slow-group 保留会抬高所有数据的内存成本。
- 按 fast-group 裁剪会让 slow-group PEL/未交付历史失去 payload。
- “所有组已 ACK 后删除”会被废弃组永久卡住。

治理方式包括为 SLA 不同的消费者拆流、定期注销废弃组、将长回放需求落到持久日志系统，或明确 slow group 可从数据库重建。

## 安全裁剪控制器

1. 枚举所有有效组及其 lag、PEL 最小 ID、业务 SLA。
2. 计算每组仍需保留的安全下界。
3. 取最保守下界并减去安全窗口。
4. 分批近似裁剪，限制单轮工作。
5. 裁剪后检测 pending 空 payload、最老可读 ID 和内存变化。
6. 组新增、删除、SETID 必须进入变更流程。

仅用 `last-delivered-id` 计算不安全，因为更早的消息仍可能 pending；仅用最小 pending ID 也忽略尚未投递给落后组的消息。

## 遇到悬空 PEL 怎么办

payload 已不可恢复时，不能假装成功。按业务选择：

- 从数据库/对象存储按 event_id 重建事件后处理。
- 将“payload_missing”审计事件写入 DLQ，人工/自动补偿。
- 在确认无法恢复且已记录证据后清理 PEL 引用。

如果 PEL 只剩 Stream ID 而消息字段中的业务 event_id 已丢失，恢复能力更差。因此关键事件应有外部审计/outbox，不应把内存 Stream 当唯一事实来源。

## 实验

1. 创建组并读取一条但不 ACK。
2. `XPENDING` 确认存在。
3. `XDEL` 该 ID 或裁剪越过它。
4. 再以消费者 pending 历史读取，观察 payload。
5. 测试目标版本的引用策略命令，并对比组 PEL。

记录命令返回、`XINFO STREAM FULL` 和版本；不要仅凭文档推断生产版本行为。

