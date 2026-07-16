# 05 · Dockerfile 基础：把源码变成可解释的镜像

> 目标不是记住指令，而是区分构建期与运行期、理解 build context，并能从镜像配置和 layers 反推 Dockerfile 的效果。

## 1. 本课交付物

本目录是独立 Go 模块，服务提供：

- `GET /`：返回运行期 `MESSAGE`。
- `GET /healthz`：返回进程级健康状态。
- SIGTERM/SIGINT 优雅关闭，最多等待 5 秒。
- HTTP header、写响应和空闲连接超时，避免默认无限等待。

先在宿主验证业务代码：

```powershell
go test ./...
go vet ./...
go run .
```

另开终端：

```powershell
Invoke-RestMethod http://127.0.0.1:8080/
Invoke-RestMethod http://127.0.0.1:8080/healthz
```

先测应用再构建镜像，可以把“代码失败”和“容器化失败”分开。

---

## 2. 三类输入与两个时间点

```text
Dockerfile ─┐
context ────┼→ BuildKit 执行构建 → image: rootfs layers + config
build args ─┘                              │
                                          │ docker run + runtime overrides
                                          ▼
                                      container process
```

| 机制 | 生效时间 | 是否进入最终镜像 | 典型用途 |
|------|----------|------------------|----------|
| `ARG` | build | 可能进入 history/provenance，不自动成为运行环境 | 版本、目标平台、非敏感构建开关 |
| `RUN` | build | 文件变化成为 layer；命令可见于 history | 编译、安装依赖、生成文件 |
| `COPY` | build | 复制结果进入 layer | 源码、配置模板、二进制 |
| `ENV` | build 定义，run 使用 | 写入 image config | 非敏感运行默认值 |
| `CMD` / `ENTRYPOINT` | run | 写入 image config，不在构建期执行 | 容器默认进程与参数 |
| `docker run -e/-v/-p` | run | 不修改 image | 环境差异、mount、端口发布 |

`RUN go build` 在构建容器中执行；`CMD ["/usr/local/bin/course-server"]` 在每次创建的业务容器中执行。混淆两者会产生“为什么 build 时服务没启动”之类的问题。

---

## 3. build context 不是当前 Dockerfile 的目录猜测

```powershell
docker build --tag dk-course/server:05 .
```

最后的 `.` 是 context。`COPY main.go ./` 只能读取 context 内文件，不能读取任意宿主路径。BuildKit 会先处理 context 与 `.dockerignore`，再计算 COPY 等步骤的输入。

本课 `.dockerignore` 排除了 Git 元数据、README、日志和构建产物。意义不只是速度：

- 减少意外进入 builder 的文件和秘密。
- 缩小 COPY 的缓存输入集合。
- 降低无关文件变化导致缓存失效的概率。

从仓库根目录错误执行 `docker build -f docker-kubernetes/code/05_dockerfile_basics/Dockerfile .` 时，context 变成整个仓库，Dockerfile 中的 `COPY go.mod` 会指向根目录而失败或拿错文件。正确方式是进入本目录，或显式把本目录作为 context：

```powershell
docker build `
  --file .\docker-kubernetes\code\05_dockerfile_basics\Dockerfile `
  --tag dk-course/server:05 `
  .\docker-kubernetes\code\05_dockerfile_basics
```

---

## 4. 逐条解释基线 Dockerfile

```dockerfile
# syntax=docker/dockerfile:1
FROM golang:1.26.4-alpine
WORKDIR /src
COPY go.mod ./
COPY main.go main_test.go ./
RUN go test ./... && CGO_ENABLED=0 go build -trimpath -o /usr/local/bin/course-server .
ENV PORT=8080 MESSAGE="hello from the lesson-05 image"
EXPOSE 8080
STOPSIGNAL SIGTERM
CMD ["/usr/local/bin/course-server"]
```

- syntax directive 选择 Dockerfile frontend，不是普通版本注释。
- FROM 建立 stage；tag 仍可移动，生产流程还要记录解析后的 digest。
- WORKDIR 会影响后续 RUN、COPY、CMD 等相对路径，并在不存在时创建目录。
- 分开复制 go.mod 与源码为后续缓存优化建立结构；本课暂无第三方依赖。
- RUN 中测试失败会终止构建；`&&` 保证失败不继续编译。
- `CGO_ENABLED=0` 生成不依赖 libc 的 Go 二进制，为后续极简运行镜像准备。
- EXPOSE 不发布端口，真正映射仍由 `-p` 完成。
- exec-form CMD 不经过 shell，Go 程序直接作为 PID 1 接收 SIGTERM。

本课故意把 builder 当 runtime：最终镜像仍有 Go 工具链、源码和 root 默认用户。它是用来测量的基线，不是生产模板。

---

## 5. 构建、检查、运行

Docker Engine 启动后：

```powershell
docker build --progress=plain --tag dk-course/server:05 .
docker image inspect dk-course/server:05 --format 'size={{.Size}} user={{json .Config.User}} cmd={{json .Config.Cmd}} env={{json .Config.Env}}'
docker image history dk-course/server:05
```

运行时覆盖 ENV：

```powershell
docker run --detach --name dk-server-05 `
  --env MESSAGE='configured when the container was created' `
  --publish 127.0.0.1:18085:8080 `
  dk-course/server:05

Invoke-RestMethod http://127.0.0.1:18085/
docker logs dk-server-05
```

证明镜像没有因 `-e` 改变：

```powershell
docker image inspect dk-course/server:05 --format '{{json .Config.Env}}'
docker container inspect dk-server-05 --format '{{json .Config.Env}}'
```

前者是镜像默认值，后者是该容器合并后的配置。

---

## 6. CMD、ENTRYPOINT 与覆盖规则

本镜像只有 CMD。用户在 image 后提供命令时，会整体替换 CMD：

```powershell
docker run --rm dk-course/server:05 /usr/local/bin/course-server
docker run --rm dk-course/server:05 go version
```

第二条能够运行恰好证明最终镜像包含不必要的 Go 工具链。第 06 课改用 ENTRYPOINT 固定可执行文件；image 后参数将作为它的参数，而 `--entrypoint` 才整体替换入口。

不要使用 shell form `CMD course-server` 来图省事。它通常变成 `/bin/sh -c ...`，shell 可能成为 PID 1，信号转发与参数组合更难推断。

---

## 7. 故障实验与验收

### 缺少 context 文件

临时把 Dockerfile 中 `COPY main.go` 改为不存在的路径，观察失败发生在 COPY 而不是 RUN；恢复后再构建。

### 运行配置错误

```powershell
docker run --name dk-server-05-bad -e PORT=127.0.0.1:8080 dk-course/server:05
docker inspect --format 'exit={{.State.ExitCode}} error={{json .State.Error}}' dk-server-05-bad
docker logs dk-server-05-bad
```

这里 runtime 成功创建了进程，是应用验证配置后以 2 退出；不要误诊为镜像拉取或端口映射问题。

验收：

- [ ] 能指出 context、Dockerfile、build args 和 runtime overrides 的边界。
- [ ] 能解释 RUN 与 CMD 为何不在同一时间执行。
- [ ] 能用 inspect 证明 ENV 默认值和容器覆盖值。
- [ ] 能说明这个基线镜像为什么不适合生产。

```powershell
docker rm --force dk-server-05 dk-server-05-bad 2>$null
docker image rm dk-course/server:05
```

官方依据：[Dockerfile overview](https://docs.docker.com/build/concepts/dockerfile/)、[Build context](https://docs.docker.com/build/concepts/context/)、[Dockerfile reference](https://docs.docker.com/reference/dockerfile/)。

> 下一课：[06 缓存与多阶段构建](../06_build_cache_multistage/README.md)。
