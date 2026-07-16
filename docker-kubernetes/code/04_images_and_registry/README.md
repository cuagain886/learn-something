# 04 · 镜像与仓库：tag、digest、layer 与多平台索引

> 核心问题：拉取一个镜像名时 registry 返回了什么？为什么 tag 不足以标识内容？同一镜像如何同时支持 amd64 和 arm64？

## 学习目标

- 区分 repository、tag、digest、image ID 与 container ID。
- 用 inspect/history 观察镜像配置和 rootfs layers。
- 理解 OCI index → manifest → config + layers 的内容寻址关系。
- 比较 tag 引用和 digest 引用的可变性、可读性与更新策略。
- 解释 pull/push 为什么可以复用已有 layer。

深入原理见 [`../../knowledge/02_image_and_oci.md`](../../knowledge/02_image_and_oci.md)。

---

## 1. 一个镜像引用包含什么

完整形式：

```text
registry.example.com/team/app:1.4.2
└──── registry ────┘└ repository ┘└ tag ┘

registry.example.com/team/app@sha256:abc...
                              └ content digest ┘
```

省略项由客户端补默认值，例如 `alpine:3.22` 通常解析到 Docker Hub 的 `library/alpine` repository。

概念边界：

| 名称 | 性质 | 是否可变 | 回答的问题 |
|------|------|----------|------------|
| repository | 一组相关镜像的命名空间 | 可增加内容 | 去哪里找 |
| tag | repository 内的人类可读指针 | 可以移动 | 维护者当前把名字指向谁 |
| digest | 对特定内容字节计算的哈希 | 内容变则 digest 变 | 精确是哪份内容 |
| image ID | 本地镜像配置对象的内容 ID | 内容寻址 | 本地镜像配置是谁 |
| container ID | 某次容器对象的身份 | 每次 create 不同 | 哪个运行实例 |

---

## 2. 拉取并记录不可变身份

```powershell
docker pull alpine:3.22
docker image ls --digests alpine
$format = @'
id={{.Id}}
repoTags={{json .RepoTags}}
repoDigests={{json .RepoDigests}}
os={{.Os}}
arch={{.Architecture}}
created={{.Created}}
'@
docker image inspect alpine:3.22 --format $format
```

`RepoDigests` 记录仓库返回的内容引用。tag 可在未来指向新 manifest，digest 引用用于精确复现当时解析到的内容。

用实际 digest 启动：

```powershell
$repoDigest = (docker image inspect alpine:3.22 | ConvertFrom-Json).RepoDigests[0]
docker run --rm $repoDigest cat /etc/alpine-release
```

这固定了内容身份，但也意味着不会自动获得后续安全修复。正确实践是“部署按 digest 可复现 + 依赖更新流程主动产生新 digest”，而不是永久冻结旧镜像。

---

## 3. tag 不会复制镜像内容

```powershell
docker tag alpine:3.22 dk-course/alpine:lesson-04

docker image inspect alpine:3.22 --format '{{.Id}}'
docker image inspect dk-course/alpine:lesson-04 --format '{{.Id}}'
```

预期两个 ID 相同。tag 只是新增引用，不复制 layers。

删除别名：

```powershell
docker image rm dk-course/alpine:lesson-04
docker image inspect alpine:3.22 --format '{{.Id}}'
```

原 tag 仍可用。只有当没有引用且没有容器依赖时，底层内容才可能被垃圾回收。

---

## 4. 观察配置与 layer

```powershell
docker image inspect alpine:3.22 --format '{{json .RootFS.Layers}}'
docker image inspect alpine:3.22 --format '{{json .Config}}'
docker image history --no-trunc alpine:3.22
```

必须区分：

- manifest 中 layer descriptor 的 digest 通常针对**压缩后的分发 blob**。
- image config 的 `rootfs.diff_ids` 针对**解压后的 layer 内容**。
- `.RootFS.Layers` 展示的通常是 DiffID，不应拿它与 registry manifest 的压缩 blob digest 强行比较。
- history 项与 filesystem layer 不保证一一对应；ENV、CMD、LABEL 等元数据指令可以产生 history 记录但不产生文件层。

镜像 rootfs 是有序差异层的结果。顺序很重要：后层可以新增或覆盖路径，也可以用 whiteout 表达删除下层路径。

---

## 5. 多平台镜像不是一个万能二进制

```powershell
docker buildx imagetools inspect nginx:1.29-alpine
```

常见返回顶层 OCI image index / Docker manifest list，其中每个 descriptor 指向一个平台 manifest：

```text
index
├── linux/amd64 manifest ─→ config + amd64 layers
├── linux/arm64 manifest ─→ config + arm64 layers
└── ...
```

客户端 pull 时会结合请求平台选择 manifest。Docker Desktop 可借助模拟运行非本机架构，但有性能和兼容成本；生产环境应优先构建目标架构的原生镜像。

查看本机选择结果：

```powershell
docker image inspect nginx:1.29-alpine --format 'os={{.Os}} arch={{.Architecture}}'
docker info --format 'daemon={{.OSType}}/{{.Architecture}}'
```

---

## 6. pull 的内容寻址流程

简化流程：

```text
1. 解析 registry/repository/tag
2. 向 registry 请求 tag 对应的 manifest 或 index
3. 若是 index，按 os/architecture/variant 选择平台 manifest
4. 校验 manifest 中 config 与每个 layer descriptor 的 digest/size
5. 本地已有相同 digest 的 blob 直接复用
6. 下载缺失 blob，逐个校验内容哈希
7. 解包/准备 snapshot，记录镜像配置与名称引用
```

因此 layer 复用同时节省 registry 存储、网络传输和本地存储。digest 也是完整性校验，不只是一个“更长的版本号”。

查看本地磁盘概览：

```powershell
docker system df -v
```

只观察，不在共享开发环境中随意执行全局 prune。

---

## 7. registry、认证与 push 边界

push 并不是上传一个整体 tar 文件：客户端先检查目标 registry 已有哪些 blobs，只上传缺失内容，再提交 manifest，最后更新 tag。

典型流程：

```powershell
docker login registry.example.com
docker tag local-app:1.0 registry.example.com/team/app:1.0
docker push registry.example.com/team/app:1.0
```

本课不实际推送，避免无意创建外部资源。安全注意：

- 不在脚本或命令历史中写明文密码；使用 `--password-stdin` 或凭证管理器。
- pull 权限、push 权限和删除权限应分离。
- registry 中的 tag 可变权限需要严格控制，生产发布应记录 digest。
- digest 只保证取到的字节与引用一致，不自动保证作者可信、无漏洞或构建过程安全；还需要签名、来源证明、SBOM 和扫描策略。

---

## 8. 容器与镜像更新的真实语义

已有容器在 create 时解析并记录 image。之后相同 tag 在 registry 中移动：

- 不会把运行中的容器“原地升级”。
- `docker restart` 仍重启原容器配置，不重新 pull 并 create。
- 要使用新内容，需要 pull，然后删除旧容器并从新镜像创建容器。

这为后续 Kubernetes Deployment 的声明式滚动替换打基础：更新不是修改已有容器文件系统，而是创建新 Pod/容器并淘汰旧实例。

---

## 9. 故障与思考实验

### A. 本地 tag 与远程 tag

给 Alpine 增加本地 tag 后，解释为什么它不会自动出现在 Docker Hub：本地名称变更与 registry push 是两个动作。

### B. 删除被容器引用的镜像

用 `docker create --name dk-lab-image-ref alpine:3.22` 创建容器，再尝试删除镜像。观察冲突信息，解释容器为什么需要保留对镜像内容的引用。

### C. tag 漂移

回答：若部署清单只写 `app:production`，事故调查时还缺什么证据？至少需要 registry digest、构建来源/commit、平台、配置和发布时间。

### D. history 泄密

思考为什么“某层写入密钥、下一层再删除”仍可能泄密：旧 layer blob 不会因上层删除而被改写。秘密必须从未进入 layer；第 07 课会学习 BuildKit secret mount。

---

## 10. 验收与清理

- [ ] 能区分 tag、digest、image ID 和 container ID。
- [ ] 能解释 manifest digest 与 DiffID 为什么可能不同。
- [ ] 能画出多平台 index 到平台 manifest 的选择过程。
- [ ] 能解释 tag 更新为何不会改变已有容器。
- [ ] 能说明 digest 固定解决了什么、没解决什么。

```powershell
docker rm --force dk-lab-image-ref 2>$null
docker image rm dk-course/alpine:lesson-04 2>$null
```

保留 `alpine:3.22` 与 `nginx:1.29-alpine` 供下一阶段复用。

## 11. 官方依据

- [OCI Image Manifest Specification](https://github.com/opencontainers/image-spec/blob/main/manifest.md)
- [OCI Image Configuration Specification](https://github.com/opencontainers/image-spec/blob/main/config.md)
- [Docker storage drivers and image layers](https://docs.docker.com/engine/storage/drivers/)
- [docker image inspect](https://docs.docker.com/reference/cli/docker/image/inspect/)

> 下一阶段：`05_dockerfile_basics`；开始前先完成本阶段验收。
