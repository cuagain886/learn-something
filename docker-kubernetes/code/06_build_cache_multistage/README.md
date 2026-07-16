# 06 · 构建缓存与多阶段构建：快、可测、只交付必要产物

> 核心问题：哪些输入变化会让缓存失效？多阶段构建为什么不仅是“缩小镜像”？如何证明测试真的在生产镜像依赖链上？

## 1. 从线性 Dockerfile 到 stage DAG

本课 Dockerfile 的依赖图：

```text
golang base
  → dependencies（只复制 go.mod）
    → test（复制源码并运行全部测试）
      → build（编译带版本信息的静态二进制）
        → runtime（Alpine + 非 root 用户 + 二进制）
```

`build` 明确 `FROM test`，所以默认构建 runtime 时测试是必经节点。如果 test 与 build 都只 `FROM dependencies`，它们会成为兄弟节点，构建 runtime 不一定执行 test——“Dockerfile 里写了测试 stage”不代表生产目标依赖它。

先验证源码：

```powershell
go test ./...
go vet ./...
```

---

## 2. 缓存不是按“这一行以前跑过”判断

BuildKit 为构建操作及输入计算缓存键。简化理解：

```text
cache key = operation
          + relevant instruction arguments
          + parent state
          + files/mounts/build args/platform used by the operation
```

当某一步变化，其后依赖该结果的步骤也要重新计算。Dockerfile 因此把低频、昂贵输入放前面：

```dockerfile
COPY go.mod ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN go test ./...
```

源码变化不会使依赖描述 COPY 失效；go.mod 变化会使依赖及其后续步骤失效。

### cache layer 与 cache mount 不同

- 普通 layer cache：输入完全匹配时整个操作复用。
- cache mount：操作即使重新执行，也可复用挂载目录中的增量内容，如 Go build cache。
- cache mount 的目录不会自动进入最终 layer；它是 builder 管理的可变缓存。

本课使用 `/root/.cache/go-build`。缓存内容提升速度，但不能作为构建正确性的唯一输入；包管理仍需 lockfile/checksum。

---

## 3. 运行可观察的缓存实验

```powershell
docker build --progress=plain `
  --build-arg VERSION=1.0.0 `
  --build-arg COMMIT=lesson06 `
  --tag dk-course/server:06 .

# 完全相同输入再次构建，应出现大量 CACHED
docker build --progress=plain `
  --build-arg VERSION=1.0.0 `
  --build-arg COMMIT=lesson06 `
  --tag dk-course/server:06 .
```

只改变 VERSION：

```powershell
docker build --progress=plain `
  --build-arg VERSION=1.0.1 `
  --build-arg COMMIT=lesson06 `
  --tag dk-course/server:06-v2 .
```

预期 dependencies/test 可复用，带 ldflags 的 build 及 runtime 后续重新执行。以日志中的 `CACHED`/执行记录为证据，不只比较总耗时；后台负载和网络会影响耗时。

`--no-cache` 用于调查缓存相关问题，不应成为日常“保证正确”的替代品：

```powershell
docker build --no-cache --progress=plain --tag dk-course/server:06-nocache .
```

---

## 4. 多阶段构建真正隔离了什么

最终 runtime 只执行：

```dockerfile
FROM alpine:3.22
RUN addgroup ... && adduser ...
COPY --from=build /out/server /usr/local/bin/server
```

builder 中的以下内容不会因“曾经存在”自动进入最终镜像：

- Go 编译器与工具链。
- `/src` 源码和测试文件。
- Go module/build cache。
- 中间对象和测试输出。

验证而不是相信：

```powershell
docker image inspect dk-course/server:05 --format '{{.Size}}'
docker image inspect dk-course/server:06 --format '{{.Size}}'

docker run --rm --entrypoint sh dk-course/server:06 -c `
  'id; test ! -e /src/go.mod; ! command -v go; ls -l /usr/local/bin/server'
```

镜像变小是结果之一；更重要的是缩小运行时攻击面、SBOM 噪声和生产环境可变性。

---

## 5. 命名 stage、target 与调试

命名比数字索引稳定：

```powershell
docker build --target test --tag dk-course/server:06-test .
docker build --target build --tag dk-course/server:06-build .
```

target 适合检查特定阶段，但不要把含源码和编译器的 test/build target 当生产镜像发布。BuildKit 只构建目标可达的依赖节点，这再次说明 stage 是 DAG，不是必须从上到下无条件执行的脚本。

---

## 6. build args、版本身份与可重复性

```dockerfile
ARG VERSION=dev
ARG COMMIT=unknown
RUN go build -trimpath -ldflags="... -X main.version=$VERSION -X main.commit=$COMMIT"
```

- ARG 只在声明后的 stage 范围可用，跨 FROM 通常要重新声明。
- `-trimpath` 移除本机构建路径，减少环境泄漏与差异。
- 不把当前时间无条件写入二进制，否则相同源码每次输出都变化。
- VERSION/COMMIT 是可追踪元数据，不是秘密；build args 可能出现在 history/provenance。

运行验证：

```powershell
docker run --detach --name dk-server-06 -p 127.0.0.1:18086:8080 dk-course/server:06
Invoke-RestMethod http://127.0.0.1:18086/
docker inspect --format 'user={{.Config.User}} entrypoint={{json .Config.Entrypoint}}' dk-server-06
```

跨平台构建时，BuildKit 提供 TARGETOS/TARGETARCH；Go 可直接交叉编译：

```powershell
docker buildx build --platform linux/amd64,linux/arm64 --tag example.invalid/server:06 .
```

多平台结果通常应 push 到 registry；不要对 `example.invalid` 实际执行 push。

---

## 7. 缓存安全与 CI 边界

- 每个 builder 有自己的本地缓存；换 builder/CI runner 不会天然共享。
- CI 可用 `--cache-to/--cache-from` 导出 OCI registry cache，但缓存写权限必须受控。
- 不把秘密放入 layer 或普通 cache；使用 BuildKit secret/SSH mount。
- 基础镜像 tag 更新不会总在本地缓存策略下自动达到你期待的刷新效果；依赖更新流程应显式 pull/检查 digest。
- 缓存命中证明输入键匹配，不证明依赖无漏洞或测试覆盖充分。

---

## 8. 验收与清理

- [ ] 能画出 dependencies → test → build → runtime 依赖图。
- [ ] 能预测源码、go.mod、VERSION 分别使哪些步骤失效。
- [ ] 能解释 cache mount 为什么不会进入最终镜像。
- [ ] 能证明最终镜像没有源码和 Go 工具链。
- [ ] 能说明多阶段构建对安全与可审计性的价值。

```powershell
docker rm --force dk-server-06 2>$null
docker image rm dk-course/server:06 dk-course/server:06-v2 `
  dk-course/server:06-nocache dk-course/server:06-test dk-course/server:06-build 2>$null
```

官方依据：[Build cache](https://docs.docker.com/build/cache/)、[Cache optimization](https://docs.docker.com/build/cache/optimize/)、[Multi-stage builds](https://docs.docker.com/build/building/multi-stage/)。

> 下一课：[07 镜像与运行时安全](../07_image_runtime_security/README.md)。
