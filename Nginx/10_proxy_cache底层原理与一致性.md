# proxy_cache 底层原理与一致性

## 1. 两部分状态

```text
keys_zone(shared memory): key hash、状态、过期、使用信息
cache_path(disk): response header/body 文件
```

keys_zone 大小限制可管理 key 数，不是响应 body 总容量。

body 主要受 cache path `max_size`、`min_free` 和磁盘约束。

## 2. cache key

默认/自定义 key 必须覆盖影响响应的所有维度：

```text
scheme + proxy_host + request_uri
以及必要的 tenant、Accept-Encoding、语言、认证维度
```

漏掉 tenant/Authorization 可能将 A 用户响应返回给 B。

把所有 Cookie 都放入 key 又会造成碎片和低命中。

## 3. 可缓存性

受以下因素影响：

- method，通常 GET/HEAD。
- response status 与 `proxy_cache_valid`。
- Cache-Control/Expires/Set-Cookie/Vary。
- `proxy_no_cache`：响应是否不存。
- `proxy_cache_bypass`：本次是否不查缓存。

bypass 与 no_cache 是读路径和写路径两个概念。

## 4. MISS 写入

概念路径：

1. 计算 key/hash。
2. 查共享 metadata。
3. MISS 请求 upstream。
4. 响应写临时 cache 文件。
5. 完成后原子 rename 到最终 cache 文件。
6. 更新共享节点。

未完整响应不应变成有效 cache entry。

磁盘文件名是 key 摘要和 levels 目录布局，不应人工按 URL猜。

## 5. cache loader/manager

启动时共享内存为空但磁盘有旧 cache。

loader 分批扫描文件加载 metadata，避免一次长扫描。

manager 周期删除 inactive、超 max_size 或低磁盘空间文件。

因此启动后短时间命中率可能逐步恢复。

## 6. stampede

热点 key 过期，1000 个请求同时 MISS 并回源。

`proxy_cache_lock` 让一个请求更新，其余等待或按配置处理。

还需设置 lock timeout/age，防止更新者挂死让所有请求长期等待。

## 7. stale-while-update

`proxy_cache_use_stale updating` 可在一个请求更新期间向其他请求返回旧内容。

`background_update` 可让触发请求也先拿 stale，后台子请求更新。

这以短期陈旧换取可用性和防击穿。

必须明确数据允许陈旧多久。

## 8. upstream 故障 stale

可针对 error/timeout/特定 5xx 返回 stale。

优点：后端故障时保持服务。

风险：缓存数据已严重过期，监控因最终 200 掩盖 upstream 故障。

日志必须记录 `$upstream_cache_status` 和 upstream status。

## 9. revalidation

过期 entry 可带 If-Modified-Since/If-None-Match 回源。

upstream 304 后刷新 metadata，避免重传 body。

需要后端正确维护 Last-Modified/ETag。

弱/强 ETag、压缩变体和动态内容需一致设计。

## 10. Vary

upstream `Vary: Accept-Encoding` 告诉 cache 按 header 变体区分。

Vary 维度过多/高基数会降低命中并扩大磁盘。

`Vary: *` 通常不可缓存。

## 11. purge 与一致性

开源版本原生 purge 能力和商业/第三方模块不同。

常见策略：

- 版本化 URL/key，最可靠。
- 短 TTL + stale。
- 外部删除对应 cache 文件风险高，不应绕过 metadata 协调。
- 使用明确支持的 purge 模块/API。

多 Nginx 节点本地 cache 没有自动全局一致失效。

## 12. 缓存私有数据

默认对带 Authorization/Set-Cookie 的响应应谨慎。

不要为提高命中粗暴 ignore headers，除非 cache key 和访问控制被严格证明安全。

鉴权应在 cache 命中前还是后执行，需要架构明确；公共 CDN 内容与用户 API 策略不同。

## 13. range/slice

大文件 range 请求、slice 缓存可减少单次回源和支持分片。

但 cache key 必须包含 slice range，文件变化期间多个 slice 可能版本不一致。

需要稳定 ETag/versioned URL。

## 14. 容量

估算：

```text
cache_disk = unique_objects × avg_object_size × variant_factor
keys_zone  = unique_keys × metadata_bytes × safety_factor
```

再考虑临时文件、inode、清理速度和峰值写入。

manager 删除速度小于新增速度时仍会打满磁盘。

## 15. 观测

`$upstream_cache_status`：MISS、BYPASS、EXPIRED、STALE、UPDATING、REVALIDATED、HIT。

按 key class/status 统计命中，不要只看全站平均。

监控 cache path 容量、inode、写延迟、loader/manager 日志和回源率。

## 16. 事故模式

- key 漏租户：数据泄露。
- 热 key 同时过期：回源雪崩。
- cache disk 与日志同盘写满：全站异常。
- 5xx 被错误缓存：故障延长。
- Set-Cookie 响应被公共缓存：会话泄露。
- stale 返回 200 掩盖后端 outage。

## 17. 面试追问

问：keys_zone=100m 是否能缓存 100m 响应内容？

答：不能。keys_zone 主要存 key metadata，响应文件在 cache path 磁盘，容量由 max_size 等控制。

