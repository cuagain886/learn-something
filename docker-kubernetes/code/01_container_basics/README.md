# 01 · 容器生命周期：从镜像到进程

> 核心问题：`docker run` 到底创建了什么？为什么容器会退出？`stop`、`kill`、`rm` 分别改变哪一层状态？

## 学习目标

- 区分 image、container object 与 container process。
- 把 `docker run` 拆成 pull、create、start、attach 等动作。
- 通过 `.State` 而不是猜测判断容器状态与退出原因。
- 理解“容器生命周期绑定主进程”以及停止时的信号路径。
- 安全清理实验资源，不用无差别的 `docker system prune`。

## 前置条件

```powershell
& ..\00_environment\check-env.ps1
```

Docker Engine 必须为 `PASS`。本课统一使用这些资源名：

```text
镜像：nginx:1.29-alpine、alpine:3.22
容器：dk-lab-nginx、dk-lab-exit、dk-lab-signal
端口：localhost:18080
```

固定 tag 是为了减少实验漂移，但 tag 本身仍可被仓库维护者重新指向；第 04 课会学习 digest 固定。

---

## 1. 三个对象，不是一回事

```text
image
  只读模板：rootfs layers + 运行配置
       │ docker create
       ▼
container object
  身份、配置、可写层、网络端点、状态记录
       │ docker start
       ▼
container process
  Linux 内核中的隔离进程；主进程退出后容器进入 exited
```

因此：

- `docker pull` 只准备 image。
- `docker create` 创建容器对象，但不启动进程。
- `docker start` 为已有容器启动进程；容器 ID 不变。
- `docker stop` 停止进程并保留容器对象和可写层。
- `docker rm` 删除容器对象及其可写层，不删除底层 image。
- `docker run` 是常用快捷路径，大致等于 pull（本地缺失时）+ create + start，并可选择 attach。

---

## 2. 实验一：显式走完 create → start → stop → rm

### 2.1 拉取镜像

```powershell
docker image pull nginx:1.29-alpine
docker image ls nginx
```

拉取输出中的每个 `Pull complete` 对应一个可复用内容 blob；它不是“一台完整虚拟机磁盘”。镜像结构在第 04 课与原理文档 02 深挖。

### 2.2 只创建，不启动

```powershell
docker container create `
  --name dk-lab-nginx `
  --publish 127.0.0.1:18080:80 `
  nginx:1.29-alpine

docker container ls --all --filter name=dk-lab-nginx
docker container inspect `
  --format 'status={{.State.Status}} running={{.State.Running}} pid={{.State.Pid}}' `
  dk-lab-nginx
```

预期：`status=created`、`running=false`、`pid=0`。容器对象已经存在，端口配置也已经记录，但还没有容器进程提供 HTTP 服务。

验证端口暂不可用：

```powershell
try {
  Invoke-WebRequest http://127.0.0.1:18080 -TimeoutSec 2
} catch {
  "expected failure: $($_.Exception.Message)"
}
```

### 2.3 启动同一个容器对象

```powershell
$before = docker container inspect --format '{{.Id}}' dk-lab-nginx
docker container start dk-lab-nginx
$after = docker container inspect --format '{{.Id}}' dk-lab-nginx
"same container object: $($before -eq $after)"

docker container inspect `
  --format 'status={{.State.Status}} running={{.State.Running}} pid={{.State.Pid}} started={{.State.StartedAt}}' `
  dk-lab-nginx

(Invoke-WebRequest http://127.0.0.1:18080).StatusCode
```

预期 HTTP 状态码为 `200`，容器 ID 前后相同，PID 从 0 变为非零。

### 2.4 停止，而不是删除

```powershell
docker container stop --timeout 10 dk-lab-nginx
docker container inspect `
  --format 'status={{.State.Status}} exit={{.State.ExitCode}} error={{json .State.Error}} finished={{.State.FinishedAt}}' `
  dk-lab-nginx
```

`docker stop` 先向容器主进程发送镜像配置中的停止信号，默认是 `SIGTERM`；等待超时后再发送 `SIGKILL`。这给应用留下优雅关闭连接、刷新缓冲区的机会。

再次执行 `docker start dk-lab-nginx` 会复用容器对象和可写层，但创建新的进程实例，因此 PID 和 StartedAt 会变化。

### 2.5 删除容器对象

```powershell
docker container stop dk-lab-nginx
docker container rm dk-lab-nginx
docker container ls --all --filter name=dk-lab-nginx
docker image ls nginx:1.29-alpine
```

预期：容器消失，镜像仍存在。删除 image 与删除 container 是两个独立操作。

---

## 3. 实验二：容器为何退出

运行一个明确返回 42 的进程：

```powershell
docker run --name dk-lab-exit alpine:3.22 `
  sh -c 'echo "main process starts"; sleep 1; echo "main process exits 42"; exit 42'

"docker CLI exit code: $LASTEXITCODE"
docker container inspect `
  --format 'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{json .State.Error}}' `
  dk-lab-exit
```

关键结论：

- 容器不是“里面至少有一个进程就活着”，而是由配置的主进程（容器 PID 1）定义生命周期。
- 主进程返回 42，Docker 记录 ExitCode 42；非零表示进程报告失败，但具体语义由应用定义。
- exited 容器仍保留日志、状态元数据和可写层，因此可以事后调查。
- `--rm` 适合一次性成功任务，但会删除容器对象；排障实验不要一律使用 `--rm`。

查看日志并清理：

```powershell
docker logs dk-lab-exit
docker rm dk-lab-exit
```

---

## 4. 实验三：停止信号与强制终止

创建一个能记录 TERM 的 shell 主进程：

```powershell
docker run --detach --name dk-lab-signal alpine:3.22 `
  sh -c 'trap "echo received-TERM; exit 0" TERM; echo ready; while true; do sleep 1; done'

docker logs dk-lab-signal
docker stop --timeout 5 dk-lab-signal
docker logs dk-lab-signal
docker inspect --format 'exit={{.State.ExitCode}} finished={{.State.FinishedAt}}' dk-lab-signal
```

预期日志包含 `received-TERM`，ExitCode 为 0。再对比强制终止：

```powershell
docker start dk-lab-signal
docker kill --signal KILL dk-lab-signal
docker inspect --format 'exit={{.State.ExitCode}}' dk-lab-signal
```

常见 Linux 结果是 137，即 `128 + SIGKILL(9)`。不要把 137 机械等同于 OOM：手动 `SIGKILL` 也可产生 137；必须同时检查 `.State.OOMKilled`、主机/平台事件和资源限制。

清理：

```powershell
docker rm dk-lab-signal
```

---

## 5. 状态机与命令语义

```text
             create
image ─────────────────→ created
                            │ start
                            ▼
                         running ── pause ─→ paused
                            │  ▲              │
                   stop/kill│  │unpause       │
                            ▼  └──────────────┘
                         exited
                            │ start
                            └──────────────→ running

created / running / paused / exited ── rm ─→ container object removed
```

`restart` 不是一种持久状态，而是“停止后再启动”的动作；配置 restart policy 后，Engine 可以在满足条件时自动重启退出的容器。

### stop 与 kill 的工程选择

| 操作 | 信号路径 | 使用场景 | 风险 |
|------|----------|----------|------|
| `docker stop` | TERM → 等待 → KILL | 正常停止、部署替换、维护 | 超时时间过短会截断请求 |
| `docker kill` | 默认直接 KILL | 进程无响应、故障演练 | 无法执行清理逻辑 |
| `docker restart` | stop 路径后重新 start | 验证重启恢复 | 可能掩盖根因，不等于修复 |
| `docker rm -f` | 强制停止并删除 | 已确认无需取证的清理 | 日志、状态和可写层一起丢失 |

---

## 6. 常见误区

### “容器退出就是容器坏了”

错误。批处理容器完成任务后退出是正常行为。是否异常要结合期望、ExitCode、日志和 OOMKilled 判断。

### “stop 后数据一定还在”

stop 会保留容器可写层，所以当前容器再次 start 时通常还能看到。但 `rm` 后可写层删除，它不是持久化方案；第 08 课会使用 volume。

### “用 latest 就是最新版且可复现”

tag 是可变名字，不是内容身份。生产部署需要记录 digest，并配合漏洞修复更新策略，而不是永远固定旧内容。

### “清理就运行 docker system prune -a”

这是超出本实验范围的全局清理，可能删除其他项目的缓存、镜像和网络。本课程始终按固定 label/name 精确清理。

---

## 7. 故障练习

### A. 名称冲突

连续两次创建同名容器，观察第二次失败。用以下证据判断是名字占用，而不是端口问题：

```powershell
docker ps -a --filter name=dk-lab-nginx
docker inspect dk-lab-nginx
```

### B. 端口冲突

先启动 `dk-lab-nginx`，再用另一个名字发布同一宿主端口。比较报错与 `docker ps -a` 状态，思考容器对象是否已经创建、是否需要清理。

### C. 主进程立即退出

```powershell
docker run --name dk-lab-short alpine:3.22 echo done
docker ps
docker ps -a --filter name=dk-lab-short
```

解释为什么它不在默认 `docker ps` 中，却出现在 `docker ps -a` 中。

---

## 8. 验收与清理

验收问题：

- [ ] 能把 `docker run` 拆解为 pull/create/start/attach。
- [ ] 能用 inspect 证明 created、running、exited，而不是凭终端现象猜。
- [ ] 能解释 stop 后容器 ID 不变、PID 变化的原因。
- [ ] 能区分 ExitCode 137 与 OOMKilled。
- [ ] 能说明为什么容器的主进程必须正确处理终止信号。

精确清理：

```powershell
@('dk-lab-nginx', 'dk-lab-exit', 'dk-lab-signal', 'dk-lab-short', 'dk-lab-conflict') |
  ForEach-Object { docker rm --force $_ 2>$null }
```

本课保留镜像供后续实验复用。如需删除：

```powershell
docker image rm nginx:1.29-alpine alpine:3.22
```

## 9. 官方依据

- [docker container run](https://docs.docker.com/reference/cli/docker/container/run/)
- [Start containers automatically](https://docs.docker.com/engine/containers/start-containers-automatically/)
- [Docker storage drivers and writable layer](https://docs.docker.com/engine/storage/drivers/)

> 下一课：[`02_container_observation`](../02_container_observation/README.md)。
