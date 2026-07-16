# Docker 与 Kubernetes 可运行实验

本目录按照 [`../README.md`](../README.md) 的总计划分批构建。每个实验都包含学习目标、机制解释、运行步骤、预期结果、故障练习、验收标准和精确清理命令。

## 已构建：Docker 地基与 Kubernetes 核心起步

| # | 课程 | 核心能力 | 配套原理 |
|---|------|----------|----------|
| 00 | [环境与交付链路](00_environment/README.md) | 区分 CLI/Engine/runtime，验证 WSL 2、Docker、kubectl、kind | [容器模型](../knowledge/01_container_model.md) |
| 01 | [容器生命周期](01_container_basics/README.md) | create/start/stop/kill/rm、PID 1、信号与退出码 | [容器模型](../knowledge/01_container_model.md) |
| 02 | [容器观察](02_container_observation/README.md) | inspect/logs/top/stats/exec/diff、事后取证 | [容器模型](../knowledge/01_container_model.md) |
| 03 | [端口与环境变量](03_ports_and_environment/README.md) | 端口数据路径、监听地址、配置注入与故障定位 | 后续 03 Docker 网络 |
| 04 | [镜像与仓库](04_images_and_registry/README.md) | tag/digest/layer、多平台 index、pull/push 语义 | [镜像与 OCI](../knowledge/02_image_and_oci.md) |
| 05 | [Dockerfile 基础](05_dockerfile_basics/README.md) | build context、构建期/运行期、指令与进程模型 | [Dockerfile 工程](../knowledge/05_dockerfile_engineering.md) |
| 06 | [缓存与多阶段构建](06_build_cache_multistage/README.md) | 缓存键、cache mount、stage DAG、最小交付 | [Dockerfile 工程](../knowledge/05_dockerfile_engineering.md) |
| 07 | [镜像与运行时安全](07_image_runtime_security/README.md) | scratch、非 root、只读根、capability、秘密与供应链 | [Dockerfile 工程](../knowledge/05_dockerfile_engineering.md) |
| 08 | [数据持久化](08_storage_persistence/README.md) | 可写层、volume、bind、tmpfs、备份一致性 | [Docker 存储](../knowledge/04_docker_storage.md) |
| 09 | [容器网络与 DNS](09_container_networking/README.md) | namespace、bridge、服务发现、NAT 与分层排障 | [Docker 网络](../knowledge/03_docker_network.md) |
| 10 | [Docker Compose](10_compose/README.md) | Go + Redis、健康依赖、网络、volume 与项目生命周期 | [网络](../knowledge/03_docker_network.md) / [存储](../knowledge/04_docker_storage.md) |
| 11 | [集群架构与 kubectl](11_cluster_architecture/README.md) | kind 三节点集群、控制面、kubeconfig、API 证据链 | [Kubernetes 架构](../knowledge/06_kubernetes_architecture.md) |
| 12 | [声明式 API](12_declarative_api/README.md) | GVK/GVR、spec/status、SSA 字段所有权、并发版本 | [声明式系统](../knowledge/07_declarative_system.md) |
| 13 | [Pod 生命周期](13_pod_lifecycle/README.md) | phase/condition/state、probe、资源、重启与优雅终止 | [Pod 生命周期](../knowledge/08_pod_lifecycle.md) |
| 14 | [Deployment 与 ReplicaSet](14_deployment_replicaset/README.md) | 所有权图、selector、副本收敛、自愈与 template revision | [工作负载控制器](../knowledge/09_workload_controllers.md) |
| 15 | [Service 与服务发现](15_service_discovery/README.md) | ClusterIP、EndpointSlice、DNS、端口映射与分层排障 | [Kubernetes 网络](../knowledge/10_kubernetes_network.md) |
| 16 | [Namespace 与标签治理](16_namespace_labels/README.md) | 作用域、动态 selector、配额、LimitRange 与 Pod Security | [Namespace 与元数据治理](../knowledge/11_namespace_metadata_governance.md) |

推荐顺序：

```text
00 环境分层 → 01 生命周期 → 02 证据式观察 → 03 网络入口与配置
  → 04 镜像身份 → 05 Dockerfile → 06 构建工程 → 07 运行硬化
  → 08 数据生命周期 → 09 网络数据路径 → 10 Compose 多服务系统
  → 11 集群控制路径 → 12 声明式收敛 → 13 Pod 状态机
  → 14 副本控制器 → 15 稳定网络入口 → 16 资源作用域与治理
```

Docker Engine 启动后，从仓库根目录执行环境检查：

```powershell
& .\docker-kubernetes\code\00_environment\check-env.ps1
```

## 后续批次

- `17`–`20`：Kubernetes 配置、存储、流量入口与工作负载选择。
- `21`–`25`：可靠性、发布、扩缩容与排障。
- `26`–`28`：综合交付与故障演练项目。

> 下一批进入 `17–20`：ConfigMap/Secret、PV/PVC/StorageClass、Ingress 以及 Deployment/StatefulSet/DaemonSet/Job 的选择边界。
