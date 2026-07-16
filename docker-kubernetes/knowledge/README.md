# Docker 与 Kubernetes 原理文章

知识文章解释机制、边界与生产取舍；具体操作放在 [`../code/`](../code/) 的可运行实验中。阅读时应把原理结论带回实验，用 inspect、日志、状态和指标验证。

## 已构建

| # | 文章 | 深入问题 | 对应实验 |
|---|------|----------|----------|
| 01 | [容器模型](01_container_model.md) | namespace、cgroup、rootfs、capabilities 与 PID 1 如何组成容器 | [00](../code/00_environment/README.md) / [01](../code/01_container_basics/README.md) / [02](../code/02_container_observation/README.md) |
| 02 | [镜像与 OCI](02_image_and_oci.md) | index、manifest、config、layer、DiffID、tag 与 digest 的内容图 | [04](../code/04_images_and_registry/README.md) |
| 03 | [Docker 网络](03_docker_network.md) | network namespace、veth、bridge、DNS、NAT 与故障路径 | [03](../code/03_ports_and_environment/README.md) / [09](../code/09_container_networking/README.md) / [10](../code/10_compose/README.md) |
| 04 | [Docker 存储](04_docker_storage.md) | CoW、mount、volume/bind/tmpfs 与一致性备份边界 | [08](../code/08_storage_persistence/README.md) / [10](../code/10_compose/README.md) |
| 05 | [Dockerfile 工程](05_dockerfile_engineering.md) | BuildKit 构建图、缓存、多阶段交付、最小权限、秘密与供应链 | [05](../code/05_dockerfile_basics/README.md) / [06](../code/06_build_cache_multistage/README.md) / [07](../code/07_image_runtime_security/README.md) |
| 06 | [Kubernetes 架构](06_kubernetes_architecture.md) | API Server、etcd、scheduler、controller、kubelet如何通过对象协作 | [11](../code/11_cluster_architecture/README.md) / [13](../code/13_pod_lifecycle/README.md) |
| 07 | [声明式系统](07_declarative_system.md) | API 写入语义、SSA 字段所有权、并发版本、所有权与终结器 | [12](../code/12_declarative_api/README.md) |
| 08 | [Pod 生命周期](08_pod_lifecycle.md) | phase/condition/state、probe、资源、重启、替换与终止边界 | [13](../code/13_pod_lifecycle/README.md) |
| 09 | [工作负载控制器](09_workload_controllers.md) | Deployment/ReplicaSet 所有权图、集合收敛、修订与自愈边界 | [14](../code/14_deployment_replicaset/README.md) |
| 10 | [Kubernetes 网络](10_kubernetes_network.md) | Pod 网络、Service 虚拟入口、EndpointSlice、DNS 与连接数据路径 | [15](../code/15_service_discovery/README.md) |
| 11 | [Namespace 与元数据治理](11_namespace_metadata_governance.md) | 作用域、标签信任、配额、LimitRange、Pod Security 与 RBAC 组合 | [16](../code/16_namespace_labels/README.md) |

## 后续规划

| 范围 | 主线 |
|------|------|
| 12–15 | 配置传播、持久存储、入口流量与工作负载类型 |
| 16–19 | 调度资源、安全、发布、弹性与可观测性 |
| 14 | 从症状到证据的系统排障方法论 |

> 下一篇：`12_configuration_delivery.md`，解释 ConfigMap/Secret 从 API 存储到环境变量、projected volume 和应用重载的传播路径。
