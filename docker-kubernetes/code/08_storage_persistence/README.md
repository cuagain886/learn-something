# 08 · 数据持久化：让数据生命周期脱离容器

> 核心问题：数据应进入 image、容器可写层、volume、bind mount 还是 tmpfs？选择依据是所有权、生命周期、性能、安全和备份一致性，而不是命令长短。

## 1. 五种位置的语义

| 位置 | 生命周期 | 谁管理 | 适合 | 不适合 |
|------|----------|--------|------|--------|
| image layer | 随 image digest | builder/registry | 程序、静态默认配置 | 运行数据、秘密 |
| writable layer | 随 container object | storage backend | 临时且可丢状态 | 数据库、跨重建数据 |
| named volume | 独立于容器 | Docker/volume driver | 数据库、跨容器持久数据 | 需要直接用宿主编辑的源码 |
| bind mount | 随宿主路径 | 用户/宿主工具 | 开发源码、明确宿主配置 | 可移植生产数据默认方案 |
| tmpfs | 随当前运行实例 | Linux 内核内存 | 临时缓存、敏感短期文件 | 需要重启后保留的数据 |

mount 会覆盖目标路径的原有视图；它不是把两棵目录自动合并。

---

## 2. 先证明可写层不持久

```powershell
docker run --name dk-storage-layer alpine:3.22 `
  sh -c 'echo writable-layer > /state.txt'
docker start dk-storage-layer
docker cp dk-storage-layer:/state.txt .\layer-state.txt
Get-Content .\layer-state.txt
docker rm dk-storage-layer
```

stop/start 复用同一容器对象和可写层；rm 后它消失。重新从相同镜像 create 的容器不会继承 `/state.txt`。

```powershell
docker run --rm alpine:3.22 sh -c 'test ! -e /state.txt'
Remove-Item .\layer-state.txt
```

---

## 3. named volume：身份与容器解耦

```powershell
docker volume create `
  --label fighting.course=docker-kubernetes `
  --label fighting.lesson=08 `
  dk-course-data

docker run --rm `
  --mount type=volume,source=dk-course-data,target=/data `
  alpine:3.22 sh -c 'date +%s > /data/created.txt; echo first >> /data/events.log'

docker run --rm `
  --mount type=volume,source=dk-course-data,target=/data,readonly `
  alpine:3.22 sh -c 'cat /data/created.txt; cat /data/events.log'
```

两个一次性容器已删除，数据仍在。inspect 观察逻辑身份与 daemon 管理位置：

```powershell
docker volume inspect dk-course-data
```

Docker Desktop 显示的 Mountpoint 位于 Linux VM 语义中，不应从 Windows 直接修改内部目录；通过挂载该 volume 的容器访问。

### 新 volume 的预填充与遮蔽

首次把空 volume 挂到镜像已有内容的目录时，Docker 默认会把目录内容复制进 volume。验证：

```powershell
docker volume create dk-nginx-html
docker run --rm --mount type=volume,src=dk-nginx-html,dst=/usr/share/nginx/html `
  nginx:1.29-alpine sh -c 'head -n 2 /usr/share/nginx/html/index.html'
```

若 volume 已有内容，它会遮蔽镜像目录。不要依赖隐式预填充做数据库迁移；生产初始化应显式、幂等、可审计。需要禁止复制可使用 `volume-nocopy`。

---

## 4. bind mount：宿主路径就是契约

```powershell
$source = Join-Path $PWD 'bind-data'
New-Item -ItemType Directory -Force $source | Out-Null
Set-Content (Join-Path $source 'config.txt') 'from-windows-host'

docker run --rm `
  --mount "type=bind,source=$source,target=/config,readonly" `
  alpine:3.22 cat /config/config.txt
```

使用 `--mount` 时源路径不存在会报错；`-v` 的历史行为可能自动创建目录，掩盖拼写错误。Windows → Docker Desktop VM 的文件共享还涉及跨文件系统性能、权限与大小写语义；高频依赖缓存/数据库通常优先 named volume，源码同步才使用 bind mount。

安全边界：bind mount 默认可写，容器可能修改或删除宿主文件。只读消费者必须加 `readonly`，且只挂必需子目录。

```powershell
Remove-Item -LiteralPath $source -Recurse -Force
```

---

## 5. tmpfs：不进入容器可写层

```powershell
docker run --name dk-tmpfs `
  --mount type=tmpfs,target=/run/private,tmpfs-size=16777216,tmpfs-mode=0700 `
  alpine:3.22 sh -c 'echo ephemeral > /run/private/value; sleep 300'

docker inspect --format '{{json .Mounts}}' dk-tmpfs
docker exec dk-tmpfs cat /run/private/value
docker exec dk-tmpfs sh -c 'echo remove-on-restart > /run/private/transient'
docker restart dk-tmpfs
docker exec dk-tmpfs sh -c 'test ! -e /run/private/transient'
```

重启后原 tmpfs 实例消失，启动命令会创建新内容。tmpfs 数据可能受宿主 swap 影响，不能把“内存挂载”绝对等同于“永不落盘”。

---

## 6. 备份不是 tar 命令本身，而是一致性协议

静态实验 volume 可用辅助容器导出：

```powershell
$backup = Join-Path $PWD 'backup'
New-Item -ItemType Directory -Force $backup | Out-Null
docker run --rm `
  --mount type=volume,src=dk-course-data,dst=/data,readonly `
  --mount "type=bind,src=$backup,dst=/backup" `
  alpine:3.22 tar -C /data -czf /backup/dk-course-data.tgz .
```

但数据库正在写时直接复制文件可能得到逻辑不一致快照。应使用数据库原生备份、暂停写入、事务快照或存储快照协调，并定期做恢复演练。没有验证恢复的备份只是一个未经证明的文件。

---

## 7. 验收与精确清理

- [ ] 能解释 stop/start、rm/run 对可写层和 volume 的不同影响。
- [ ] 能说明 mount 遮蔽与空 volume 预填充。
- [ ] 能根据开发源码、数据库、临时秘密选择 bind/volume/tmpfs。
- [ ] 能解释为什么文件级 tar 不必然是数据库一致备份。

```powershell
docker rm --force dk-tmpfs 2>$null
docker volume rm dk-course-data dk-nginx-html
Remove-Item -LiteralPath .\backup -Recurse -Force
```

官方依据：[Docker storage](https://docs.docker.com/engine/storage/)、[Volumes](https://docs.docker.com/engine/storage/volumes/)、[Bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)、[tmpfs](https://docs.docker.com/engine/storage/tmpfs/)。

> 下一课：[09 容器网络与 DNS](../09_container_networking/README.md)。
