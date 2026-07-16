# 02 · 容器观察：从现象建立证据链

> 核心问题：容器“看起来不工作”时，如何区分配置错误、进程退出、资源耗尽和文件系统变化？

## 学习目标

- 知道 `ps`、`inspect`、`logs`、`top`、`stats`、`exec`、`diff` 各回答什么问题。
- 从配置、状态、输出、进程、资源、文件变化六个维度观察同一个容器。
- 理解 `docker exec` 是创建额外进程，不是 SSH，也不会替换主进程。
- 使用结构化输出提取证据，避免在大型 inspect JSON 中盲目搜索。

## 1. 观察面与问题映射

| 想回答的问题 | 首选命令 | 关键限制 |
|--------------|----------|----------|
| 有哪些容器、处于什么摘要状态 | `docker ps -a` | 摘要会丢细节 |
| 实际配置和运行状态是什么 | `docker inspect` | 是 Engine 元数据，不等于应用健康 |
| 应用向 stdout/stderr 写了什么 | `docker logs` | 取决于 logging driver；不会读取任意日志文件 |
| 容器里当前有哪些进程 | `docker top` | 从 daemon/宿主视角查看 |
| CPU、内存、网络、块 IO | `docker stats` | 指标高低要结合限制和基线解释 |
| 在运行中容器里执行诊断命令 | `docker exec` | 主进程退出后不可用 |
| 可写层相对镜像改了什么 | `docker diff` | 只列 A/C/D，不解释谁改的 |

排障时先问问题，再选观察面；不要每次都从 `exec sh` 开始。

---

## 2. 启动可观察目标

```powershell
docker run --detach `
  --name dk-lab-observe `
  --label course=docker-kubernetes `
  --label lesson=02 `
  --publish 127.0.0.1:18080:80 `
  nginx:1.29-alpine
```

确认摘要：

```powershell
docker ps --filter name=dk-lab-observe `
  --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Image}}'
```

`STATUS` 中的 `Up` 只代表容器主进程还在运行。除非镜像定义了 HEALTHCHECK，否则它不能证明 HTTP 路径、数据库依赖或业务功能健康。

---

## 3. inspect：配置与状态的事实来源

完整 JSON：

```powershell
docker inspect dk-lab-observe | ConvertFrom-Json | Format-List
```

更推荐针对问题提取字段：

```powershell
$format = @'
id={{.Id}}
image={{.Config.Image}}
path={{.Path}}
args={{json .Args}}
status={{.State.Status}}
pid={{.State.Pid}}
started={{.State.StartedAt}}
exit={{.State.ExitCode}}
oom={{.State.OOMKilled}}
restartCount={{.RestartCount}}
ports={{json .NetworkSettings.Ports}}
'@
docker inspect --format $format dk-lab-observe
```

理解三类字段：

- `.Config`：创建容器时确定的镜像默认值与用户覆盖，例如 Env、Cmd、Labels。
- `.HostConfig`：宿主侧运行配置，例如端口绑定、mount、资源限制、restart policy。
- `.State` / `.NetworkSettings`：当前或最近一次运行产生的状态。

不要从 `.Config.ExposedPorts` 推断宿主可以访问。EXPOSE 只是镜像/容器配置中的端口声明，真正的宿主映射在 `.NetworkSettings.Ports` 与 `.HostConfig.PortBindings`。

---

## 4. logs：只收集标准输出与标准错误

```powershell
Invoke-WebRequest http://127.0.0.1:18080 | Out-Null
docker logs --timestamps --tail 20 dk-lab-observe
```

Nginx 官方镜像把访问日志和错误日志导向 stdout/stderr，所以 `docker logs` 可见。若应用只写 `/var/log/app.log`，Docker 默认日志命令不会自动读取它。

实时跟随与时间范围：

```powershell
docker logs --follow --since 1m dk-lab-observe
# Ctrl+C 只停止本地跟随，不停止容器
```

生产习惯：

- 输出结构化日志到 stdout/stderr，由平台统一收集。
- 日志包含时间、级别、请求/追踪标识，但不记录密钥和完整凭证。
- 给日志驱动配置轮转；容器可写层大小不包含日志驱动存储的全部占用。

---

## 5. top 与 exec：两个不同视角

```powershell
docker top dk-lab-observe
docker exec dk-lab-observe sh -c 'echo "inside pid=$$"; cat /proc/1/status | head -n 8'
```

容器内 `/proc/1` 是该 PID namespace 中的主进程。宿主/daemon 视角可能看到不同 PID，这是 PID namespace 的映射，而不是两个 Nginx。

证明 exec 创建新进程：

```powershell
docker exec --detach dk-lab-observe sh -c 'sleep 30'
docker top dk-lab-observe
```

你会看到额外的 `sleep`，但容器主进程仍是 Nginx。注意：

- `exec` 只能用于 running 容器。
- `exec` 进程退出不会让容器退出，除非它影响了主进程。
- 极简镜像可能没有 shell、curl、ps；“exec 不进去”不等于应用没运行。
- 生产镜像不应为了方便调试而塞入整套运维工具；后续 Kubernetes 课程会学习临时调试容器。

---

## 6. stats：资源证据，而不是结论

```powershell
docker stats --no-stream dk-lab-observe
docker inspect --format 'memory={{.HostConfig.Memory}} nanoCpus={{.HostConfig.NanoCpus}} pids={{.HostConfig.PidsLimit}}' dk-lab-observe
```

先看限制，再解释用量。`50 MiB` 对无上限容器和限制为 `64 MiB` 的容器意义完全不同。

关键字段：

- CPU %：观察窗口内的 CPU 使用，需结合可用 CPU 数和配额。
- MEM USAGE / LIMIT：当前内存与限制；无限制时上限常接近 VM/宿主可用内存。
- NET I/O：容器网络接口累计收发，不等于单个请求延迟。
- BLOCK I/O：块设备累计读写，不包含所有缓存语义。
- PIDS：进程/线程数量异常增长可提示泄漏或 fork 问题。

单次快照不能证明趋势。真实性能调查需要连续指标、请求负载和基线。

---

## 7. diff：观察容器可写层

```powershell
docker exec dk-lab-observe sh -c 'echo lesson-02 > /tmp/evidence.txt'
docker diff dk-lab-observe
```

输出前缀：

- `A`：相对镜像新增。
- `C`：内容或元数据发生变化。
- `D`：在容器视图中删除。

读取证据：

```powershell
docker exec dk-lab-observe cat /tmp/evidence.txt
docker stop dk-lab-observe
docker start dk-lab-observe
docker exec dk-lab-observe cat /tmp/evidence.txt
```

stop/start 后文件仍在，因为复用了同一个容器可写层。删除并重新 `docker run` 后文件消失，因为新容器获得新的可写层。

---

## 8. 退出后的事后调查

```powershell
docker kill --signal KILL dk-lab-observe
docker inspect --format 'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{json .State.Error}}' dk-lab-observe
docker logs --tail 20 dk-lab-observe
```

此时：

- `exec` 不可用，因为没有运行中的容器进程。
- inspect、logs、diff 仍可用，因为容器对象尚未删除。
- 应先取证，再 `rm`。直接 `rm -f` 会丢失部分最有价值的现场。

统一调查模板：

```text
1. ps -a：范围和摘要状态
2. inspect State：ExitCode / OOMKilled / Error / FinishedAt / RestartCount
3. logs：退出前应用输出
4. inspect Config/HostConfig：实际命令、环境、mount、资源与重启策略
5. diff：是否发生意外文件修改
6. 形成“现象—证据—根因—修复—复验”记录
```

---

## 9. 故障练习

### A. 错误命令

```powershell
docker run --name dk-lab-bad-command alpine:3.22 command-that-does-not-exist
docker inspect --format '{{json .State}}' dk-lab-bad-command
```

区分“runtime 无法启动配置的进程”和“进程启动后返回非零”。重点检查 `.State.Error`、ExitCode 和日志是否存在。

### B. 日志为空

让容器把内容写进文件而不是 stdout：

```powershell
docker run --name dk-lab-file-log alpine:3.22 sh -c 'echo hidden-from-docker-logs > /tmp/app.log'
docker logs dk-lab-file-log
docker cp dk-lab-file-log:/tmp/app.log .\dk-lab-app.log
Get-Content .\dk-lab-app.log
Remove-Item .\dk-lab-app.log
```

解释为什么 `docker logs` 为空，而文件确实存在。

### C. 配置值与运行值冲突

检查 Nginx 的 `.Config.ExposedPorts` 和 `.NetworkSettings.Ports`，指出哪个字段能证明 `127.0.0.1:18080` 的实际映射。

---

## 10. 验收与清理

- [ ] 能为“状态、日志、进程、资源、文件变化”分别选对命令。
- [ ] 能解释 `exec` 与 SSH、主进程的区别。
- [ ] 能说明为什么 `Up` 不等于 Ready/Healthy。
- [ ] 能对退出容器建立至少三条相互支持的证据。
- [ ] 能解释可写层为何跨 stop/start 保留、跨 rm/run 消失。

```powershell
docker rm --force dk-lab-observe dk-lab-bad-command dk-lab-file-log 2>$null
```

## 11. 官方依据

- [docker container inspect](https://docs.docker.com/reference/cli/docker/container/inspect/)
- [docker container logs](https://docs.docker.com/reference/cli/docker/container/logs/)
- [docker container command reference](https://docs.docker.com/reference/cli/docker/container/)
- [Docker storage drivers](https://docs.docker.com/engine/storage/drivers/)

> 下一课：[`03_ports_and_environment`](../03_ports_and_environment/README.md)。
