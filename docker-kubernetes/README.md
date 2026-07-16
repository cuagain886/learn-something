# Docker 与 Kubernetes 系统学习计划

> 目标：从“会运行一个容器”逐步走到“能独立构建镜像、编排多容器应用、把服务部署到 Kubernetes，并完成更新、扩缩容和故障排查”。
>
> 课程按批次构建：当前已完成 `00–16`，覆盖 Docker 地基以及 Kubernetes 架构、声明式 API、Pod、控制器、Service 网络与 Namespace 治理，并配有十一篇深度原理文章。

---

## 1. 学习原则

延续本仓库“代码 + 知识”双轨结构：

```text
docker-kubernetes/
├── README.md             # 总学习计划与进度
├── code/                 # 可运行实验：先观察，再修改，再排障
│   ├── README.md         # 实验索引、环境配置和运行命令
│   ├── 01_container_basics/
│   └── ...
└── knowledge/            # 原理文章：解释机制、边界和生产决策
    ├── README.md         # 原理文章索引
    ├── 01_container_model.md
    └── ...
```

每一课遵循同一闭环：

1. **先跑起来**：执行最小命令，看到可验证结果。
2. **再解释**：理解对象、生命周期和数据流，而不是背命令。
3. **主动破坏**：制造端口冲突、探针失败、镜像拉取失败等问题。
4. **用工具定位**：通过 `inspect`、`logs`、`describe`、`events` 等证据排障。
5. **清理现场**：每个实验都提供资源清理和结果验收命令。

贯穿课程的示例应用是一套小型 Go HTTP 服务。先用 Docker 打包它，再用 Compose 加入 Redis，最后迁移到 Kubernetes；这样学习重点始终放在容器和编排，而不是业务框架。

---

## 2. 完成课程后的能力

- 解释容器与虚拟机、镜像与容器、Docker 与 Kubernetes 的区别和联系。
- 编写安全、体积合理、可缓存的多阶段 `Dockerfile`。
- 使用 volume、network 和 Compose 运行、观察、调试多容器应用。
- 看懂 Kubernetes 控制平面、工作节点和声明式 API 的协作方式。
- 正确使用 Pod、Deployment、Service、ConfigMap、Secret、Ingress 和存储对象。
- 完成滚动更新、回滚、水平扩缩容、资源限制、健康检查与优雅终止。
- 按“工作负载 → 事件 → 日志 → 网络 → 配置 → 资源”的路径定位常见故障。
- 把同一个应用从本地源码一路交付到本地 Kubernetes 集群。

---

## 3. 总体路线

建议用 **6–8 周**完成，每周学习 3–5 小时。编号代表依赖顺序，不代表必须按自然周推进。

| 阶段 | 主题 | 预计产出 | 验收里程碑 |
|------|------|----------|------------|
| 0 | 环境与心智模型 | Docker Desktop、Docker CLI、kubectl、kind | 能说明整条交付链路并通过环境检查 |
| 1 | Docker 基础 | 01–04 四个实验 | 能独立运行、观察和清理容器 |
| 2 | 镜像构建 | 05–07 三个实验 | 能为 Go 服务构建非 root、多阶段镜像 |
| 3 | 数据、网络与 Compose | 08–10 三个实验 | 能用 Compose 启动并排查 Web + Redis |
| 4 | Kubernetes 基础对象 | 11–16 六个实验 | 能将应用部署到 kind 并通过 Service 访问 |
| 5 | 配置、存储与流量 | 17–20 四个实验 | 能管理配置、持久化数据和入口流量 |
| 6 | 可靠性与运维 | 21–25 五个实验 | 能更新、扩缩容、限制资源并系统排障 |
| 7 | 综合项目 | 26–28 三个实验 | 完成从镜像到集群的可重复交付与故障演练 |

推荐主线：

```text
Linux 进程/网络基础
        ↓
Docker 容器 → Dockerfile → Compose
        ↓
Kubernetes 架构 → Pod → Deployment → Service
        ↓
配置/存储/Ingress → 探针/资源/更新/扩缩容
        ↓
可观测与排障 → 综合交付项目
```

---

## 4. 分阶段课程清单

### 阶段 0：环境与核心概念

| # | 主题 | 核心内容 | 实验结果 |
|---|------|----------|----------|
| 00 | 环境准备 | Docker Desktop、WSL 2、Docker CLI、kubectl、kind、版本与上下文 | 一条检查脚本输出所有工具状态 |

本课程默认使用 Windows + PowerShell，Docker Desktop 提供容器运行环境，`kind` 使用容器作为本地 Kubernetes 节点。Kubernetes 与 kind 的具体版本在开始实现课程时统一固定，避免实验随版本漂移。

### 阶段 1：Docker 容器基础（01–04）

| # | 主题 | 核心知识点 | 动手任务 |
|---|------|------------|----------|
| 01 | 容器生命周期 | image/container、create/start/run/stop/rm、前台与后台 | 运行 Nginx，检查状态并彻底清理 |
| 02 | 容器内观察 | logs、exec、inspect、stats、top、退出码 | 进入容器、查看进程和元数据 |
| 03 | 端口与环境变量 | 端口发布、监听地址、环境注入、命名 | 用不同配置启动两个独立实例 |
| 04 | 镜像与仓库 | tag、pull、push、digest、分层与不可变性 | 比较 tag 与 digest，查看镜像历史 |

阶段验收：不借助图形界面，仅使用 CLI 完成容器的启动、观察、配置和清理，并能解释容器退出的原因。

### 阶段 2：Dockerfile 与镜像工程（05–07）

| # | 主题 | 核心知识点 | 动手任务 |
|---|------|------------|----------|
| 05 | Dockerfile 基础 | FROM、WORKDIR、COPY、RUN、CMD、ENTRYPOINT、build context | 打包最小 Go HTTP 服务 |
| 06 | 构建缓存与多阶段构建 | layer cache、`.dockerignore`、BuildKit、多阶段构建 | 缩小镜像并验证缓存命中 |
| 07 | 镜像安全 | 非 root 用户、最小基础镜像、只读文件系统、秘密信息边界 | 让应用以非 root 身份运行 |

阶段验收：同一源码可重复构建；镜像中没有源码、构建工具和秘密信息；容器使用非 root 用户且能正常响应健康检查。

### 阶段 3：数据、网络与 Compose（08–10）

| # | 主题 | 核心知识点 | 动手任务 |
|---|------|------------|----------|
| 08 | 数据持久化 | writable layer、bind mount、named volume、备份与清理 | 重建容器后数据仍然存在 |
| 09 | 容器网络 | bridge、端口发布、DNS 服务发现、网络隔离 | 让 Web 通过服务名连接 Redis |
| 10 | Docker Compose | `compose.yaml`、服务、依赖、健康检查、日志、配置合并 | 一条命令运行 Web + Redis |

阶段验收：能够说明“容器启动”不等于“应用就绪”，并用 healthcheck 修复启动竞态；能判断数据应进入镜像、bind mount 还是 volume。

### 阶段 4：Kubernetes 核心对象（11–16）

| # | 主题 | 核心知识点 | 动手任务 |
|---|------|------------|----------|
| 11 | 集群架构与 kubectl | control plane、node、API Server、etcd、scheduler、controller、kubelet | 创建 kind 集群并查看核心组件 |
| 12 | 声明式 API 与 YAML | apiVersion、kind、metadata、spec/status、label/selector | apply/get/explain/diff/delete 一个对象 |
| 13 | Pod | Pod 生命周期、重启策略、日志、exec、多容器边界 | 运行并主动破坏一个 Pod |
| 14 | Deployment 与 ReplicaSet | 期望状态、控制器、Pod 模板、副本、自愈 | 删除 Pod 并观察自动恢复 |
| 15 | Service 与服务发现 | ClusterIP、selector、EndpointSlice、集群 DNS、端口映射 | 稳定访问一组会变化的 Pod |
| 16 | Namespace 与标签 | 资源隔离、label、selector、annotation、推荐标签 | 按环境组织和筛选资源 |

阶段验收：将阶段 2 的本地镜像加载进 kind，由 Deployment 管理三个副本，通过 Service 访问；手动删除一个 Pod 后服务自动恢复。

### 阶段 5：配置、存储与流量入口（17–20）

| # | 主题 | 核心知识点 | 动手任务 |
|---|------|------------|----------|
| 17 | ConfigMap 与 Secret | 环境变量、volume 挂载、更新行为、Secret 的安全边界 | 不重建镜像切换应用配置 |
| 18 | 持久化存储 | volume、PV、PVC、StorageClass、动态供给 | 为有状态组件申请并验证存储 |
| 19 | Ingress | Ingress Controller、host/path 路由、TLS 基础 | 用统一入口访问两个服务 |
| 20 | 工作负载选择 | Deployment、StatefulSet、DaemonSet、Job、CronJob | 为四类典型任务选择正确控制器 |

阶段验收：配置与镜像解耦；能够说明 Secret 不是天然的密码保险箱；能根据无状态服务、有状态服务、节点代理和批任务选择工作负载类型。

### 阶段 6：可靠性、发布与排障（21–25）

| # | 主题 | 核心知识点 | 动手任务 |
|---|------|------------|----------|
| 21 | 探针与生命周期 | startup/readiness/liveness、preStop、terminationGracePeriodSeconds | 复现并修复探针导致的重启循环 |
| 22 | 资源与调度 | requests/limits、QoS、OOMKilled、nodeSelector、taint/toleration、affinity | 制造 Pending 和 OOM 场景并解释原因 |
| 23 | 更新与回滚 | RollingUpdate、maxSurge、maxUnavailable、revision、rollback | 发布坏版本并安全回滚 |
| 24 | 扩缩容 | 手动扩容、HPA、指标、容量与冷启动 | 生成负载并观察副本变化 |
| 25 | 可观测与系统排障 | get/describe/logs/events/top、临时调试容器、网络与 DNS 检查 | 完成一组未知故障排查题 |

统一排障顺序：

```text
确认现象与范围
  → 查看工作负载和 Pod 状态
  → 查看 Events 与 describe
  → 查看当前/上一次容器日志
  → 核对 Service、EndpointSlice 与 DNS
  → 核对配置、挂载、探针和资源限制
  → 修复后验证，并记录根因
```

阶段验收：在不知道故障答案的情况下，仅凭集群证据定位并修复 `ImagePullBackOff`、`CrashLoopBackOff`、`Pending`、探针失败、Service 无端点和 DNS 失败等问题。

### 阶段 7：综合项目（26–28）

| # | 项目 | 交付内容 | 验收方式 |
|---|------|----------|----------|
| 26 | Docker 化 Go 服务 | 多阶段 Dockerfile、非 root、健康检查、Compose 开发环境 | 一条命令构建和启动，重建后数据保留 |
| 27 | 部署到 Kubernetes | Deployment、Service、ConfigMap、Secret、Ingress、PVC | 从空 kind 集群可重复部署并访问 |
| 28 | 发布与故障演练 | 滚动更新、回滚、扩缩容、资源限制、6 类故障脚本 | 完成运行手册和排障报告 |

最终验收不以“YAML 能 apply”为标准，而以以下结果为准：

- 新环境可按 README 从零复现。
- 应用有就绪/存活检查、资源请求与限制，并能优雅退出。
- 更新过程保持服务可用，坏版本可以回滚。
- 日志和事件足以解释每一次故障。
- 所有实验有清理命令，不遗留集群、容器、网络或 volume。

---

## 5. 原理文章规划

`knowledge/` 不重复命令教程，重点回答“为什么”和“生产环境如何取舍”。

| # | 文章 | 核心问题 |
|---|------|----------|
| 01 | 容器模型 | namespace、cgroup、rootfs 如何共同形成容器 |
| 02 | 镜像与 OCI | 分层、联合文件系统、manifest、digest 与 registry |
| 03 | Docker 网络 | veth、bridge、NAT、端口发布和容器 DNS |
| 04 | Docker 存储 | writable layer、volume、bind mount 的语义与性能边界 |
| 05 | Dockerfile 工程 | 缓存、体积、供应链安全和可重复构建 |
| 06 | Kubernetes 架构 | API Server、etcd、scheduler、controller 的协作 |
| 07 | 声明式系统 | spec/status、控制循环、幂等与最终一致性 |
| 08 | Pod 生命周期 | phase、condition、restart、探针与优雅终止 |
| 09 | Kubernetes 网络 | Pod IP、Service、EndpointSlice、DNS、Ingress 的数据路径 |
| 10 | 调度与资源 | requests/limits、QoS、驱逐与调度约束 |
| 11 | Kubernetes 存储 | PV/PVC/StorageClass、CSI 与有状态应用边界 |
| 12 | 配置与安全 | ServiceAccount、RBAC、Secret、SecurityContext、最小权限 |
| 13 | 发布与弹性 | 滚动更新、回滚、HPA、PDB 与容量设计 |
| 14 | 排障方法论 | 从症状到证据、常见状态机和故障树 |

---

## 6. 进度看板

下表记录学习者进度，状态约定：`⬜ 未开始`、`🟨 进行中`、`✅ 已完成`。课程资料是否已经构建请查看 [`code/README.md`](code/README.md) 和 [`knowledge/README.md`](knowledge/README.md)，不要把“文档已写完”误记为“已经学会”。

| 阶段 | 状态 | 完成定义 |
|------|------|----------|
| 0 环境与模型 | ⬜ 未开始 | 工具检查通过，能画出交付链路 |
| 1 Docker 基础 | ⬜ 未开始 | 完成 01–04 与阶段验收 |
| 2 镜像构建 | ⬜ 未开始 | 完成 05–07 与阶段验收 |
| 3 Compose | ⬜ 未开始 | 完成 08–10 与阶段验收 |
| 4 K8s 核心对象 | ⬜ 未开始 | 完成 11–16 与阶段验收 |
| 5 配置/存储/入口 | ⬜ 未开始 | 完成 17–20 与阶段验收 |
| 6 可靠性与排障 | ⬜ 未开始 | 完成 21–25 与阶段验收 |
| 7 综合项目 | ⬜ 未开始 | 完成 26–28 与最终验收 |

建议每补充完一课，同时更新课程表、进度看板和对应索引，避免计划与实际内容脱节。

---

## 7. 官方学习资料

- [Docker Get Started](https://docs.docker.com/get-started/)
- [Docker Compose Quickstart](https://docs.docker.com/compose/gettingstarted/)
- [Kubernetes Basics](https://kubernetes.io/docs/tutorials/kubernetes-basics/)
- [Kubernetes Concepts](https://kubernetes.io/docs/concepts/)
- [kubectl Reference](https://kubernetes.io/docs/reference/kubectl/)
- [kind Quick Start](https://kind.sigs.k8s.io/docs/user/quick-start/)

版本敏感的行为以实现课程时锁定版本的官方文档和命令输出为准。

---

## 8. 下一步

下一批进入 Kubernetes `17–20`：ConfigMap/Secret 的配置传播、PV/PVC/StorageClass 存储模型、Ingress 流量入口，以及 Deployment/StatefulSet/DaemonSet/Job/CronJob 的选择边界。
