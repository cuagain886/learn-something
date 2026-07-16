# 05 · Dockerfile 工程：构建图、缓存、最小交付与供应链

> 对应实验：[05 Dockerfile 基础](../code/05_dockerfile_basics/README.md)、[06 缓存与多阶段构建](../code/06_build_cache_multistage/README.md)、[07 镜像与运行时安全](../code/07_image_runtime_security/README.md)。

## 1. Docker build 是求值构建图，不是远程执行 shell 脚本

现代 Docker build 由 Buildx 客户端向 BuildKit builder 提交构建请求。Dockerfile frontend 把指令转换为构建图，BuildKit 决定依赖、并行、缓存与输出：

```text
Dockerfile frontend
  + contexts
  + build args / secrets / SSH mounts
  + target platforms
        ↓
      LLB build graph
        ↓
BuildKit solver：解析依赖、查缓存、执行缺失节点
        ↓
image / registry / local artifacts / cache / attestations
```

工程含义：

- Dockerfile 的文本顺序影响父层与缓存，但多 stage 整体是 DAG。
- 未被目标依赖的 stage 可以不执行。
- context 是显式输入边界；COPY 不是任意读取宿主文件。
- 构建输出不只可以是本地 image，也可以直接 push 多平台 index、导出文件或缓存。

---

## 2. layer cache 的准确心智模型

“每行 Dockerfile 是一个缓存”过于粗糙。缓存结果关联构建操作及其输入：父状态、指令参数、COPY 文件元数据/内容、build args、mount、平台等。某节点失效后，依赖其输出的下游节点需要重新求值。

```text
COPY go.mod ─→ download deps ─┐
                              ├→ COPY source → test → compile → runtime
cache mount ──────────────────┘
```

优化不是把不稳定步骤藏起来，而是让依赖边界与真实变化频率一致：

1. 先复制 lockfile/module metadata。
2. 下载依赖。
3. 再复制高频业务源码。
4. 测试和编译。

如果先 `COPY . .`，README 或日志变化也可能使依赖下载层失效；`.dockerignore` 是缓存设计和数据最小化的一部分。

### 三种缓存不要混淆

| 类型 | 复用单位 | 生命周期/位置 | 风险点 |
|------|----------|---------------|--------|
| layer/result cache | 完整构建操作结果 | BuildKit cache store | 输入键设计不合理导致频繁失效 |
| cache mount | 包管理器/编译器可变目录 | builder 管理，可跨操作累积 | 不能作为唯一可信依赖来源 |
| external cache | 导出到 registry/local/CI backend | 可跨 runner/builder | 写权限与缓存污染、敏感内容 |

缓存应加速相同语义输入的构建，不能替代依赖校验、测试或扫描。

---

## 3. 多阶段构建是交付边界

单阶段编译镜像把“构建需要”和“运行需要”合并：编译器、包管理器、headers、源码与运行进程一起交付。多阶段通过 `COPY --from` 建立窄接口：

```text
builder internals                runtime contract
源码、编译器、缓存、测试   ──→   /server + 明确运行依赖
```

这类似软件模块封装：runtime 不应知道 builder 内部布局，只消费稳定 artifact。收益包括：

- 更小的网络和磁盘占用。
- 更少的 OS packages/CVEs 与扫描噪声。
- 攻击者取得应用权限后可直接利用的工具更少。
- 运行时 SBOM 更接近实际部署内容。
- 构建环境可以升级而不改变运行基座接口。

但小镜像不自动安全：静态二进制仍可能有漏洞，scratch 仍共享内核，错误 runtime flags 仍可授予高权限。

### 测试 stage 的可达性陷阱

```dockerfile
FROM base AS test
RUN go test ./...

FROM base AS build
RUN go build ...

FROM runtime
COPY --from=build ...
```

最终目标依赖 build，不依赖 test；BuildKit 可跳过 test。若测试是发布门，应让 build `FROM test`，或在 CI 中把测试目标作为明确失败依赖，不能靠文件出现顺序想当然。

---

## 4. ENTRYPOINT、CMD 与进程模型

稳定组合：

```dockerfile
ENTRYPOINT ["/server"]
CMD ["serve"]
```

默认执行 `/server serve`；`docker run image migrate` 变为 `/server migrate`；`--entrypoint` 才整体替换程序。

exec form 直接创建目标进程，参数边界明确，信号直接抵达 PID 1。shell form 会引入 `/bin/sh -c`、变量展开与信号转发差异。应用需要：

- 监听 SIGTERM。
- 停止接收新工作。
- 在平台 grace period 内排空连接。
- 超时后退出，避免部署永久卡住。

镜像 STOPSIGNAL 只是默认信号选择，应用逻辑和平台终止时限才决定是否真正优雅。

---

## 5. 最小权限是多维向量

```text
identity × filesystem × capabilities × syscalls × mounts × network × resources × daemon access
```

只设置 `USER nonroot` 仍可能：挂敏感宿主目录、无限吃内存、访问 Docker socket、拥有不必要 capabilities。生产硬化至少审视：

- 非 0 UID/GID，高端口监听。
- read-only rootfs，仅为必需路径提供 volume/tmpfs。
- drop capabilities，禁止 privilege escalation。
- 默认 seccomp 与 LSM 策略，不随意关闭。
- memory/CPU/pids 等 cgroup 限制。
- 不挂 Docker socket、宿主根目录或设备。
- 出站网络与凭证权限最小化。

必须区分三个“非 root”：

1. image `USER`：容器进程 UID。
2. user namespace：容器 UID 与外部 UID 的映射。
3. rootless daemon：dockerd/containerd 自身不以宿主 root 运行。

它们解决不同威胁，可叠加但不可互相代替。

---

## 6. scratch、distroless 与小型发行版如何选择

| 运行基座 | 优点 | 代价 | 适合 |
|----------|------|------|------|
| scratch | 内容最少，无 shell/包管理器 | 证书、时区、用户数据等全需显式提供 | 真静态、依赖清晰的单二进制 |
| distroless | 保留常见运行依赖，无通用 shell | 调试方式变化，依赖特定发行方 | JVM、动态/常见运行时应用 |
| Alpine/小型 distro | 包管理和 shell 方便 | 运行内容更多，musl 兼容需验证 | 需要明确 OS 工具/动态库 |
| 完整 distro | 兼容、运维工具丰富 | 体积与攻击面更大 | 有确切运行依赖，不是默认选择 |

决策基于运行依赖和运维模型，不以镜像 MB 数竞赛。无 shell 镜像要准备外部可观测、临时 debug container 或专门 debug target。

---

## 7. 构建秘密的泄漏路径

危险入口：

- COPY 把 `.env`、SSH key、云凭证送入 context/layer。
- ARG/ENV 进入 history、config 或 provenance。
- RUN 命令把 token 打到构建日志。
- “下一层删除”仍保留旧 layer blob。
- cache/export 包含带凭证的包管理配置或生成文件。

BuildKit secret mount 把秘密临时挂到单个 RUN，不进入默认 layer：

```dockerfile
RUN --mount=type=secret,id=token,required=true \
    tool --token-file /run/secrets/token fetch
```

但工具若复制、回显或嵌入秘密，mount 机制不能替你清理。安全性取决于完整数据流，而不是用了某个参数。

---

## 8. 可重复构建与可追溯构建

二者相关但不同：

- 可重复：相同定义输入尽量得到相同输出。
- 可追溯：能证明输出由哪些源码、依赖、builder、参数和步骤产生。

实践组合：

- 基础镜像和依赖记录 digest/checksum，并自动化更新。
- `-trimpath`、固定工具链，避免无意义时间戳/宿主路径。
- 在产物中嵌入 commit/version，但不嵌秘密。
- 生成 SBOM 描述“包含什么”。
- 生成 provenance 描述“如何构建”。
- 签名和策略描述“谁认可、是否允许部署”。
- 部署与运行记录实际 manifest digest。

ARG 可能进入 provenance，因此 max provenance 与错误的 secret ARG 组合会公开凭证；这也是官方明确要求用 secret mount 的原因。

---

## 9. HEALTHCHECK 的系统语义

健康检查命令返回 0/1，Engine 维护 `starting/healthy/unhealthy` 状态并记录有限输出。它回答的是用户定义的探针是否成功，不是完整业务正确性。

设计维度：

- interval × timeout × retries 决定故障检测时间。
- start-period 保护冷启动，但成功一次后后续失败开始计数。
- 探针消耗 CPU、连接和依赖容量，频率不能无限提高。
- 无 shell 镜像可让应用二进制提供 healthcheck 子命令。
- Docker 的 unhealthy 本身不保证自动替换实例；编排器决定动作。

后续 Kubernetes 会把 startup、readiness、liveness 分离，因为“能接流量”和“必须重启”不是同一问题。

---

## 10. 证据式验收

一个镜像交付评审不应只看 Dockerfile，应验证：

```text
构建：测试是否在目标依赖图上？缓存输入是什么？秘密如何流动？
内容：最终有哪些文件、包、用户、入口和 healthcheck？
身份：基础与最终 digest、源码 commit、版本是什么？
运行：UID、capabilities、read-only、mount、resources 是否生效？
行为：SIGTERM 是否排空？健康失败如何被平台消费？
供应链：SBOM、扫描、provenance、签名和准入策略是否闭环？
```

## 11. 官方资料

- [Docker Build overview](https://docs.docker.com/build/concepts/overview/)
- [Build context](https://docs.docker.com/build/concepts/context/)
- [Cache optimization](https://docs.docker.com/build/cache/optimize/)
- [Multi-stage builds](https://docs.docker.com/build/building/multi-stage/)
- [Dockerfile reference](https://docs.docker.com/reference/dockerfile/)
- [Build secrets](https://docs.docker.com/build/building/secrets/)
- [Build attestations](https://docs.docker.com/build/metadata/attestations/)
- [Docker Engine security](https://docs.docker.com/engine/security/)

## 小结

高质量 Dockerfile 是一个可审计构建图：输入边界清楚、缓存与变化频率匹配、测试在产物依赖链上、builder 与 runtime 通过最小 artifact 接口隔离、秘密不进入持久输出、运行默认值符合最小权限，并能用 digest、SBOM 和 provenance 追溯最终交付物。
