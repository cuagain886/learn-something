# 内存池、Chain、Buffer 与生命周期

## 1. 为什么先研究生命周期

Nginx 高性能不只来自 epoll。

大量短命对象如果逐个 malloc/free，会产生锁、碎片和 cleanup 成本。

Nginx 用 pool 把“内存所有权”绑定到 cycle、connection、request 等生命周期。

正确性问题变成：对象属于哪个 pool，以及异步回调发生时 pool 是否还活着。

## 2. ngx_pool_t 布局

概念结构：

```text
ngx_pool_t
├── d.last / d.end       当前小块可用区间
├── d.next               后续 pool block
├── d.failed             分配失败/跳过次数
├── max                  小分配阈值
├── current              当前优先分配 block
├── large                大分配链表
├── cleanup              清理回调链
└── log
```

首 block 同时包含 pool header 与可用区域。

## 3. 小分配

`ngx_palloc(pool, size)` 对小于等于 max 的请求：

1. 从 current block 开始。
2. 按 alignment 调整 last。
3. 若 `end-last >= size`，推进 last并返回。
4. 否则尝试 next block。
5. 都不足则创建新 block。

普通小分配没有独立 free。

pool destroy 时整块释放。

## 4. palloc 与 pnalloc

`ngx_palloc` 做内存对齐，适合结构体和指针。

`ngx_pnalloc` 不要求同样对齐，适合字符缓冲，可能节省 padding。

误用 pnalloc 保存需要严格对齐的类型在某些架构会出错。

## 5. 新 block

新 block 通常与初始 pool block 相近大小。

旧 block 多次无法满足后，其 failed 增加；超过阈值后 current 指针前移，避免每次分配都扫描已接近耗尽的 block。

这是小型启发式，不是通用 allocator。

## 6. 大分配

超过 max 的对象走独立 heap allocation，并用 `ngx_pool_large_t` 节点挂到 pool.large。

destroy 时逐个 free。

`ngx_pfree` 只能尝试释放 large allocation，不能回收普通小块。

频繁中等“大对象”仍可能造成 allocator 碎片。

## 7. reset 与 destroy

destroy：

- 运行 cleanup handlers。
- 释放 large allocations。
- 释放所有 pool blocks。

reset：

- 释放 large。
- 把各 block last 重置到起点。
- 通常不销毁 block 本身。

reset 后旧指针全部逻辑失效，即使字节尚未被覆盖。

## 8. cleanup handler

pool cleanup 用于绑定非内存资源：

```text
关闭文件 fd
删除临时文件
释放第三方库对象
撤销模块上下文
```

注册顺序和执行顺序需看实现。

handler 必须可安全处理部分初始化和重复错误路径。

不能在 cleanup 中访问已先释放的外部对象。

## 9. request pool

`ngx_http_request_t`、headers、变量结果、upstream上下文等大量对象来自 request pool。

request finalize 后 pool 被 destroy。

异步 DNS、subrequest、thread task 或 upstream callback 必须保证 request 引用未归零。

把 request pool 字符串指针存到共享内存是严重错误。

## 10. connection pool

connection pool 生命周期通常跨一个 TCP 连接。

HTTP/1.1 keepalive 上 request pool 每次重建，而 connection pool保留。

连接级模块上下文不能引用已结束 request pool。

## 11. cycle pool

配置对象通常来自 cycle pool，生命周期是一代配置。

reload 后旧 worker 继续使用 old cycle pool，新 worker 使用 new cycle。

所以配置指针无需运行时锁更新，但不能跨进程共享普通地址。

## 12. shared memory slab

共享 zone 不使用普通 request pool。

worker 进程要看到同一数据，使用 shared slab allocator、锁和可共享偏移/指针布局。

共享内存对象生命周期跨请求，可能跨 reload复用。

其中不能存指向 worker 私有 heap/pool 的指针。

## 13. ngx_buf_t 不是一块内存

它是数据描述符：

```text
pos/last           当前内存数据范围
start/end          内存容量范围
file_pos/file_last 文件数据范围
file               文件对象
temporary/memory/mmap/in_file
flush/sync/last_buf/last_in_chain
recycled
shadow
tag
```

同一个 buf 可描述内存、文件或控制信号。

## 14. temporary/memory/mmap

- temporary：可修改内存。
- memory：只读常量内存。
- mmap：只读映射内存。

filter 想原地修改 body 前必须确认 buffer 可写。

对只读 buffer 写入会崩溃或破坏共享常量。

## 15. in_file

`in_file` 表示有效数据来自文件区间。

一个 buf 可以同时有内存 header和文件信息，send chain按平台能力选择 sendfile/writev。

`file_pos` 随部分发送推进，不能直接修改 file_last 破坏范围。

## 16. 特殊 buffer

没有普通数据但带标志：

- flush：要求向下刷新。
- sync：同步边界。
- last_buf：主请求最后 buffer。
- last_in_chain：当前 chain 最后。

filter 丢失 last_buf 会让请求无法正确结束。

错误传播 flush 会导致过多小包。

## 17. ngx_chain_t

```c
struct ngx_chain_s {
    ngx_buf_t *buf;
    ngx_chain_t *next;
};
```

chain 节点本身与 buf/数据内存可能来自不同 pool。

发送部分完成后返回未发送 chain，调用方必须保留并在 write-ready 继续。

## 18. free/busy/out chains

filter/upstream 常维护：

- free：可复用 chain/buffer。
- busy：下游尚未消费完。
- out：本次准备发送。

只有当 buf 数据完全消费，才能移回 free。

提前复用会让慢客户端收到被覆盖内容。

## 19. shadow buffer

一个原始 buffer 可切片成多个 shadow buf，共享底层存储。

shadow 记录关联，最后一个 shadow 消费后才能回收原 buffer。

这避免复制，但生命周期更复杂。

`last_shadow` 等标志用于决定何时释放/复用。

## 20. tag

模块给自己创建的 buffer 设置 tag。

更新 chain 时只回收 tag 属于本模块的 buffer，避免误把其他 filter 的 buffer 放进自己的 free list。

## 21. buffer 大小与 page

默认 buffer 常与系统 page size相关。

调大 buffer 不只增加有效数据容量，也会乘以并发请求。

小响应分配大 buffer 造成 RSS浪费；过小则增加 chain、临时文件和系统调用。

## 22. 零拷贝的边界

sendfile 避免文件 body 经过用户态复制。

但以下情况可能需要内存：

- gzip/body modification。
- TLS 实现路径。
- range/slice 处理。
- 不支持的文件系统。

“ngx_buf_t in_file”表示有机会，不保证端到端零拷贝。

## 23. 常见模块错误

- 异步回调使用已销毁 request pool。
- 把栈内存设置为 buf->pos 后返回。
- 未设置 last_buf，请求悬挂。
- 修改 memory只读 buffer。
- 未处理部分发送。
- shadow 原 buffer 过早复用。
- cleanup重复关闭已复用 fd。
- 共享内存存私有指针。

## 24. 源码路径

- `src/core/ngx_palloc.c/h`。
- `src/core/ngx_buf.c/h`。
- `src/os/unix/ngx_writev_chain.c`。
- 平台 sendfile chain。
- `src/http/ngx_http_write_filter_module.c`。
- `src/event/ngx_event_pipe.c`。

## 25. 实验

为自定义 filter 构造 1B、跨buffer、大文件、慢客户端和客户端断开。

记录 free/busy chain、pos/last推进、request pool destroy和cleanup。

用 ASAN/debug build 验证异步生命周期。

## 26. 面试追问

问：Nginx pool 为什么不支持释放每个小对象？

答：对象生命周期通常与请求/连接一致，批量释放降低元数据、锁和碎片；代价是短期不用的对象只能等pool结束，跨生命周期引用必须严格禁止。

