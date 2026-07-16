# 02 · 镜像与 OCI：内容寻址的文件系统和运行配置

> 对应实验：[04 镜像与仓库](../code/04_images_and_registry/README.md)。

## 1. 镜像不是一个“大压缩包”

OCI image 是一组通过 descriptor 和 digest 连接起来的内容对象。最核心的结构是：

```text
image index（可选，多平台入口）
└── platform manifest
    ├── image config
    └── ordered filesystem layers[]
```

descriptor 是连接这些对象的边：

```json
{
  "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
  "digest": "sha256:...",
  "size": 123456
}
```

三个字段共同回答：对象是什么格式、准确内容是什么、应下载多少字节。客户端拿到内容后重新计算 digest；不匹配就不能把 blob 当成该 descriptor 指向的对象。

---

## 2. index：多平台分发入口

OCI image index 包含一组 manifest descriptors，每项可带 platform：

```text
os: linux
architecture: amd64 | arm64 | ...
variant: 可选，例如 arm/v7
```

同一个 `app:1.0` 可以指向 index，index 再分别指向 amd64 和 arm64 manifest。它不是要求一个二进制同时支持所有 CPU，而是用统一入口组织不同平台内容。

选择过程：

```text
tag / digest reference
  → index
  → match requested OS/architecture/variant
  → selected manifest
  → selected config + layers
```

可能还有 attestation 等 artifact manifest 出现在索引/关联关系中，因此看到额外 `unknown/unknown` 或非运行平台条目时，不能立即认定镜像损坏；需要检查 mediaType 与 annotations。

---

## 3. manifest：平台镜像的装配清单

manifest 主要引用：

- 一个 config descriptor。
- 有序的 layer descriptors 数组。
- 可选 annotations、subject 等元数据。

layer 顺序是语义的一部分。运行时 rootfs 是按顺序应用差异层得到的结果：

```text
base layer
  + dependency layer
  + application layer
  + later modifications / whiteouts
  = final rootfs view
```

如果交换层顺序，覆盖与删除结果可能不同，最终 rootfs 也不同。

manifest digest 是对 manifest JSON 内容字节的哈希。manifest 中任一 descriptor、顺序或 annotation 变化，都可能产生新 digest，即使应用代码看似未变。

---

## 4. config：运行默认值与 rootfs 身份

image config 是 JSON blob，包含两类重要信息。

### 4.1 运行默认值

例如：

- Env
- Entrypoint 与 Cmd
- WorkingDir
- User
- ExposedPorts
- Labels
- StopSignal

它们是**镜像默认配置**，创建容器时可以被平台/用户覆盖。镜像不会因为声明 `ExposedPorts` 就自动在宿主开放网络，也不会因为设置 User 就自动满足所有文件权限。

### 4.2 rootfs.diff_ids

`rootfs.diff_ids` 是有序 DiffID 列表。DiffID 对 layer **解压后的 tar 内容**计算 digest；manifest layer descriptor 通常对**压缩后的分发 blob**计算 digest。

```text
compressed layer blob bytes ── sha256 ─→ manifest layer digest
            │ decompress
            ▼
uncompressed tar bytes      ── sha256 ─→ DiffID in image config
```

因此二者不同是正常现象：压缩算法、级别或时间元数据变化可改变压缩 blob 字节，而解压后的内容可能相同。

DiffID 序列还用于确定 rootfs 差异链身份。实现可能基于链式关系生成 snapshot/cache 标识，但使用者通常不应依赖存储后端内部目录名称。

---

## 5. layer：文件系统变更集

OCI layer 通常是 tar archive，可压缩或不压缩。它表达相对上一层的文件系统变化：

- 新增路径与内容。
- 替换已有路径。
- 修改权限、所有者等元数据。
- 通过 whiteout 表达删除。

### whiteout 为什么必要

下层 blob 不可变，后层不能真的进入下层删除文件。它只能添加一个特殊标记，告诉解包/snapshot 实现“最终视图中遮蔽这个下层路径”。

所以：

```dockerfile
RUN echo secret > /secret
RUN rm /secret
```

最终 rootfs 看不到 `/secret`，但第一层 blob 仍可能含有内容。正确做法是让秘密从未进入 build context、指令参数、环境、缓存导出和任何 layer。

### history 与 layer 不一一对应

Dockerfile 的 RUN/COPY 通常影响文件系统，ENV/CMD/LABEL 通常只改变 config。构建历史可以记录 `empty_layer` 项，因此不能用 `docker history` 行数直接等同于 layer 数。

---

## 6. tag、digest 与 image ID

### tag：可读、可移动

tag 是 registry repository 下的命名引用。它适合表达发布通道或版本，例如：

```text
app:1.4.2
app:1.4
app:stable
```

三个 tag 可以同时指向同一 manifest，也可以随发布策略移动。tag 的可变性便于更新，但单独记录 tag 不足以进行精确事故追溯。

### digest：内容地址

`repository@sha256:...` 把引用固定到特定 manifest/index 内容。优势：

- 可重复拉取相同内容。
- registry/CDN 可基于 digest 去重与缓存。
- 下载后能验证内容完整性。
- 审计记录可以关联到确切 artifact。

它没有自动解决：

- 内容由谁构建、是否可信。
- 基础镜像和依赖是否有漏洞。
- 构建环境是否被污染。
- 该 digest 是否符合当前更新策略。

### image ID：本地 config 身份

Docker 本地 image ID 常与 image config digest 相关，而 registry `RepoDigest` 指向 manifest。它们标识的对象层次不同，不应期望字符串相同。

---

## 7. 内容寻址为什么可以安全复用

registry 和客户端把 blob 存储键设为 digest。若两个镜像引用同一个 layer descriptor：

- registry 只需存一份 blob（具体垃圾回收由实现决定）。
- push 时客户端可先询问 blob 是否存在，跳过重复上传。
- pull 时本地已有并验证过相同 digest，可跳过下载。
- 多个镜像/容器可共享只读 layer/snapshot 数据。

这是一张有向无环内容图，而不是“每个镜像复制一套目录”：

```text
manifest A ─┐
            ├─→ shared base layer
manifest B ─┘

manifest A ─→ app layer A
manifest B ─→ app layer B
```

只有当所有可达引用、容器与缓存都不再需要某 blob 时，存储后端才可能回收它。这也是 `docker image rm 某个tag` 不一定立即释放预期空间的原因。

---

## 8. 从 pull 到可运行 rootfs

更完整的概念流程：

```text
解析引用
  → registry authentication / authorization
  → 获取 index 或 manifest
  → 平台选择
  → 获取 platform manifest
  → 下载并校验 config/layer blobs
  → 解压 layers，验证 DiffID
  → snapshotter/storage backend 准备只读快照链
  → 创建容器时增加 writable snapshot/layer
  → mount 为 rootfs
  → runtime 按 config 与用户覆盖启动进程
```

Docker Desktop、Docker Engine 与 containerd 的具体存储实现会演进。例如 Engine 29 新安装默认 containerd image store；旧安装可能沿用 classic storage drivers。稳定知识是 OCI 对象关系和内容寻址，不是 `/var/lib/docker` 下某个内部目录布局。

---

## 9. 缓存与可重复构建的微妙边界

内容寻址能识别相同结果，但“Dockerfile 没改”不保证构建结果永远相同：

- `FROM distro:latest` 的 tag 可移动。
- 包管理器索引与依赖解析会随时间变化。
- 未锁定版本的语言依赖会变化。
- build context 中时间戳、生成文件或无关大文件可能影响缓存/内容。
- 跨平台编译器、工具链和网络输入可能不同。

可重复性需要组合策略：

- 基础镜像记录 digest，并有受控更新流程。
- 依赖使用 lockfile/校验和。
- `.dockerignore` 缩小且稳定 build context。
- 多阶段构建隔离工具链与运行产物。
- 记录源码 commit、构建参数、平台、builder 与 provenance。
- 用 CI 重新构建、扫描、签名并发布，而不是在个人机器手工打生产 tag。

---

## 10. 供应链安全：digest 是地基，不是终点

一个较完整的 artifact 信任问题包括：

```text
完整性：下载字节是否匹配 digest？
真实性：谁声明/签署了这个 artifact？
来源：由什么源码、依赖、builder 和步骤产生？
内容：包含哪些包与许可证（SBOM）？
风险：当前漏洞数据库与策略如何评价？
授权：谁能移动生产 tag、push 或删除？
部署：运行的 digest 是否就是审批过的 digest？
```

只按 digest 部署能很好解决完整性与精确身份，但不能单独回答其余问题。

---

## 11. 可验证命令

```powershell
# 本地名称、digest 和 image ID
docker image ls --digests
docker image inspect alpine:3.22

# 解压层 DiffID 序列
docker image inspect alpine:3.22 --format '{{json .RootFS.Layers}}'

# config 默认值
docker image inspect alpine:3.22 --format '{{json .Config}}'

# 构建/历史视图（不等于严格的一层一行）
docker image history --no-trunc alpine:3.22

# 远程多平台 index/manifest
docker buildx imagetools inspect nginx:1.29-alpine

# 本地共享与磁盘使用概览
docker system df -v
```

验证时明确命令观察的是本地对象还是远程 registry；不要把本地缓存状态误当成 registry 事实。

---

## 12. 面试与自检问题

### 1. 为什么 tag 不能作为不可变发布证据？

tag 是可移动命名引用。需要同时记录解析后的 manifest/index digest，才能证明部署了哪份内容。

### 2. 为什么镜像 ID 与 RepoDigest 不同？

它们通常标识不同 OCI 对象层次：本地 image ID 常关联 config，RepoDigest 关联 repository 中的 manifest/index。

### 3. 为什么 manifest layer digest 与 RootFS.Layers 值不同？

前者通常哈希压缩 blob，后者是解压 tar 的 DiffID。输入字节不同，digest 自然不同。

### 4. 删除文件为什么不一定让镜像变小？

后层删除只遮蔽下层内容；包含文件的旧 blob 仍存在。要缩小镜像需避免早期层加入内容，或重新组织/构建层。

### 5. 按 digest 固定基础镜像是否应该永不更新？

不应该。固定保证构建输入可追溯，但需要自动化依赖更新、扫描和重新发布来吸收安全修复。

---

## 13. 官方资料

- [OCI Image Manifest Specification](https://github.com/opencontainers/image-spec/blob/main/manifest.md)
- [OCI Image Index Specification](https://github.com/opencontainers/image-spec/blob/main/image-index.md)
- [OCI Image Configuration Specification](https://github.com/opencontainers/image-spec/blob/main/config.md)
- [OCI Image Layer Specification](https://github.com/opencontainers/image-spec/blob/main/layer.md)
- [Docker storage drivers and layers](https://docs.docker.com/engine/storage/drivers/)
- [Docker containerd image store](https://docs.docker.com/engine/storage/containerd/)

## 小结

镜像是由 digest 串联的 OCI 内容图：index 负责多平台入口，manifest 负责装配某个平台的 config 与 layers，config 描述运行默认值和 DiffID，layers 表达有序文件系统差异。tag 解决人类命名，digest 解决内容身份；二者配合更新策略、来源证明和扫描，才能形成可靠交付链。
