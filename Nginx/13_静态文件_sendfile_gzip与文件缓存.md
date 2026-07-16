# 静态文件、sendfile、gzip 与文件缓存

## 1. URI 到路径

root/alias、index、try_files 将规范化 URI映射到文件。

需要防：路径穿越、alias 尾斜杠错误、符号链接越界、大小写文件系统差异。

## 2. open/stat

静态请求需 stat/open 文件。

`open_file_cache` 可缓存 fd、文件信息和错误，减少系统调用。

参数控制缓存项、inactive、valid、最少使用次数和是否缓存错误。

部署替换文件后缓存可能短时保留旧 metadata/fd，优先用原子 rename 与版本化 URL。

## 3. sendfile

文件页通过内核发送到 socket，减少用户态 copy。

响应 header 仍在内存 chain，body 可是 in-file buffer。

部分 filter、TLS/平台实现会改变具体路径，不能把 sendfile 描述成永远零拷贝。

## 4. directio/AIO/thread pool

大文件可绕 page cache 或异步读取，但 alignment、文件系统和 workload 非常关键。

小热点文件使用 page cache 通常更好。

directio 与 sendfile 组合会按范围切换路径。

只在真实大文件场景压测调优。

## 5. gzip

动态 gzip 消耗 worker CPU并需要用户态处理。

压缩收益取决于 MIME、大小和客户端带宽。

图片/视频等已压缩格式再 gzip 浪费 CPU。

`gzip_min_length`、types、level 和 vary 需结合 cache/CDN。

## 6. gzip_static

预生成 `.gz` 文件可减少在线 CPU，Nginx 按 Accept-Encoding 选择。

必须确保原文件和压缩文件版本同步，发布使用原子目录/版本路径。

Brotli 通常依赖额外模块，不能假定官方构建自带。

## 7. Range

大文件断点续传用 Range/206。

多 Range、If-Range、ETag/Last-Modified 共同决定响应。

恶意多范围请求可能放大开销，应限制异常模式。

## 8. 条件请求

If-Modified-Since/If-None-Match 命中返回 304，节省 body。

ETag 在多节点发布时必须稳定；若包含 inode/mtime 等节点差异，跨节点缓存效果下降。

## 9. symlink 安全

共享上传目录中符号链接可能逃逸 root。

使用权限隔离、专用目录和 `disable_symlinks` 等能力时评估 openat 检查成本与平台支持。

## 10. 文件描述符

open_file_cache 缓存 fd，会占用 RLIMIT_NOFILE。

最大 cache entry、worker 数与 active connection 同时计算。

## 11. 面试追问

问：sendfile 为什么快，是否总该开？

答：减少用户态复制和系统调用，适合静态文件；动态 body filter、平台/文件系统和 TLS 路径可能限制收益，需要按 workload 验证。

