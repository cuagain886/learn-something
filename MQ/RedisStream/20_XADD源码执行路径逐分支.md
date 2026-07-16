# XADD 源码执行路径逐分支

本文以 Redis 8.2 为基线，从命令参数到 `streamAppendItem()`、trim、阻塞唤醒和传播逐段追踪。

## 1. 命令阶段全景

```text
xaddCommand
  -> parseStreamAddOrTrimArgs
  -> lookup key / type check
  -> validate explicit or partial ID
  -> streamAppendItem
       -> choose ID
       -> validate monotonicity and size
       -> find tail listpack
       -> reuse or create macro node
       -> append encoded entry
       -> update counters/edge IDs
  -> streamTrim (optional)
  -> rewrite command for deterministic propagation
  -> signalModifiedKey / notifyKeyspaceEvent
  -> mark stream key ready
  -> server.dirty update
  -> reply final ID
```

命令函数名会随版本调整，阅读时以命令表入口和调用关系为准。

## 2. 参数不是互相独立

`XADD` 可同时携带：

- `NOMKSTREAM`。
- `MAXLEN` 或 `MINID`。
- `=` 精确或 `~` 近似。
- `LIMIT`。
- Redis 8.2 的 `KEEPREF/DELREF/ACKED`。
- `*`、显式 ID 或 `ms-*`。

解析器需要拒绝：

- MAXLEN 与 MINID 同时出现。
- 无裁剪策略却出现 LIMIT。
- 负数长度或非法 ID。
- 重复/冲突删除策略。
- 不支持版本中的新参数。

参数解析在修改 key 前完成，避免半写入。

## 3. key 查找与 NOMKSTREAM

key 不存在：

- 默认创建 Stream object。
- NOMKSTREAM 返回 nil，不创建空 key。

key 存在但不是 Stream：返回 WRONGTYPE。

为什么先检查类型再生成最终结果？

因为自动 ID 和幂等元数据不能在错误类型上产生可见副作用。

NOMKSTREAM 常用于受控拓扑：

```text
初始化流程创建允许的 stream
生产者拼错 tenant key 时返回失败
避免无界 key 数量
```

## 4. 自动 ID：时钟只能前进

`streamNextID(last_id, new_id)`：

```text
current_ms > last.ms  -> current_ms-0
current_ms <= last.ms -> last.ms-(last.seq + 1)
```

使用命令时间快照，而不是每个字段操作重新读时钟。

系统时钟回拨时，ID 时间部分停留在历史最大毫秒并增加 seq。

结论：

- ID 保持单调。
- ID 的 ms 不再等于真实当前时间。
- 监控不能把 ID ms 当严格生产时刻。

当 `seq == UINT64_MAX` 且无法推进时需要报错，防止回绕到更小 ID。

## 5. `ms-*` 分支

调用者给毫秒但不提供序列：

```text
last.ms == use.ms -> seq = last.seq + 1
last.ms != use.ms -> seq = 0
```

随后统一验证新 ID 必须严格大于 `last_id`。

若调用者的 ms 小于最后 ID，最终失败。

这不是“按历史业务时间插入”的能力，Stream 仍只允许尾部追加。

## 6. 显式 ID 分支

显式 `ms-seq` 直接使用，但必须满足：

```text
new ID > stream.last_id
new ID != 0-0
```

删除尾部消息不会降低 `last_id`。

所以删除 `100-0` 后仍不能再次写 `100-0`。

这是防止 ID 重用和范围游标歧义的关键不变量。

## 7. 大元素保护

源码累计所有 field/value 的 SDS 长度。

总长度超过 listpack 能表达的硬上限时返回 ERANGE。

但“低于 Redis 硬上限”不代表业务可接受。

一个数百 MB 条目会导致：

- 主线程长时间复制字节。
- AOF 与复制流瞬间放大。
- 客户端输出缓冲和网络拥塞。
- fork COW 峰值。
- 消费者反序列化 OOM。

应用层应设置远低于 Redis 极限的 payload 上限。

## 8. 查找尾节点

源码对 `s->rax` 执行 seek `$` 取得最后一个宏节点。

读取尾 listpack 字节数。

这一步不是按消息总数遍历，所以正常追加接近 O(1)。

若 Stream 为空，尾节点不存在，直接创建。

## 9. 判断是否创建新宏节点

计算 `lp_bytes + totelelen` 与 `stream_node_max_bytes`。

再读取 master 的 `count + deleted` 与 `stream_node_max_entries` 比较。

注意 `totelelen` 主要是业务字符串长度，不完全等于最终编码增量。

边界判断偏保守/近似，真实 listpack 还包含编码头。

节点已满时先 shrink 预分配空间，再让 `lp=NULL` 进入新节点分支。

## 10. 创建 master entry

新节点：

1. master ID 等于当前消息 ID。
2. 编码成 16 字节大端 rax key。
3. 创建带有限预分配的 listpack。
4. 写 `count=1`。
5. 写 `deleted=0`。
6. 写字段数和全部字段名。
7. 写 master 终止 0。
8. 插入 rax。
9. 当前消息设置 SAMEFIELDS。

master count 一开始就是 1，因为马上要追加第一条真实 entry。

## 11. 复用尾节点

复用时先把 master `count` 加一。

再逐个比较：

- 字段数量。
- 字段字节长度。
- 字段字节内容。
- 字段顺序。

全部匹配才设置 SAMEFIELDS。

任何一个字段顺序变化都走完整编码。

## 12. 追加真实 entry

固定写入：

```text
flags
id.ms - master.ms
id.seq - master.seq
```

非 SAMEFIELDS 再写字段数。

每个字段：

- 非 SAMEFIELDS 写 field。
- 始终写 value。

最后写 `lp-count` 支持反向迭代。

若 listpack realloc 后地址变化，需要把 rax value 更新为新指针。

## 13. 更新 Stream 元数据

追加成功后：

```text
s->length++
s->entries_added++
s->last_id = id
if first entry: s->first_id = id
```

这几个字段更新必须在 entry 已成功编码之后。

若中途分配失败，Redis 的内存分配策略通常会终止进程而不是返回半成品；但逻辑验证错误必须发生在修改之前。

## 14. trim 接在追加之后

`XADD ... MAXLEN/MINID` 先追加，再在同一命令执行中调用 `streamTrim()`。

它不是后台任务。

精确 trim 可能进入宏节点内部逐条打墓碑。

近似 KEEPREF 优先整节点删除；如果头节点不能完整删，停止。

`LIMIT` 控制本次最大处理工作，但可能留下超限数据。

## 15. Redis 8.2 引用策略影响快速路径

KEEPREF 不需要逐组检查引用，符合条件时可直接删除完整 rax 节点。

DELREF 需要清理各组 PEL 引用。

ACKED 需要判断是否所有组都已确认。

因此即使指定 `~`，非 KEEPREF 策略也可能进入节点逐 entry 处理。

不能把 8.2 的所有近似裁剪都理解为纯整节点 O(1) 删除。

## 16. 确定性传播

客户端发送 `XADD key * ...`。

副本/AOF 重放时不能再次执行 `*`，否则会依据另一时刻产生不同 ID。

主节点在决定 ID 和实际裁剪结果后，需要将传播形式重写为确定参数或传播等价确定命令。

源码阅读时要搜索：

- `rewriteClientCommandArgument`。
- `alsoPropagate`。
- 命令参数中自动 ID 被最终 ID 替换的位置。
- trim 实际删除结果如何表达。

这是理解“命令复制”而非“内存页复制”的关键。

## 17. 唤醒阻塞读者

成功追加后 key 被标记 ready。

事件循环稍后处理等待该 key 的 XREAD/XREADGROUP 客户端。

不是在 listpack append 内直接递归执行所有消费者。

这避免写路径深层调用客户端业务，但一个热点 key 上大量独立 XREAD 仍会产生大量响应。

## 18. 响应丢失场景

服务端顺序可能是：

```text
完成 append
更新 dirty
传播
把响应写入客户端输出缓冲
连接在客户端收到前断开
```

客户端看到 timeout，无法由 timeout 判断 XADD 未执行。

重试必须复用业务 event_id。

Redis 8.6 引入生产端幂等能力，但旧版本仍需应用去重；即使使用新能力，也必须区分生产去重与消费副作用幂等。

## 19. 复杂度拆分

正常 XADD：

- 找尾节点近似常数。
- 字段比较与编码 O(payload bytes + fields)。
- listpack 扩容涉及复制当前节点字节。

带 trim：

- 整节点删除与节点数相关。
- 精确/引用感知删除与处理 entry、group 引用相关。

所以命令文档中的 O(1) 是在不裁剪等条件下的抽象，不等于任何 payload、任何配置都恒定延迟。

## 20. 断点清单

建议断点：

```text
xaddCommand
streamAppendItem
streamNextID
streamTrim
streamEncodeID
signalKeyAsReady
```

每个断点记录：

- `s->length/entries_added/last_id`。
- `raxSize(s->rax)`。
- 尾 listpack bytes/count/deleted。
- client argv 是否在传播前被重写。
- server.dirty 增量。

## 21. 代码审查清单

- producer 是否预生成并复用 event_id？
- 是否限制字段数量、字段长度和 payload？
- 是否误把 Stream ID 时间当业务时间？
- MAXLEN 是否按峰值恢复窗口计算？
- 是否知道 `~` 与 LIMIT 会超限？
- 是否确认部署版本支持引用策略？
- 写超时是否盲目生成新事件？
- Redis 是否配置 noeviction 和容量告警？

