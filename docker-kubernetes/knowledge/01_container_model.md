# 01 · 容器模型：隔离进程，而不是轻量虚拟机

> 对应实验：[00 环境与交付链路](../code/00_environment/README.md)、[01 容器生命周期](../code/01_container_basics/README.md)、[02 容器观察](../code/02_container_observation/README.md)。

## 1. 一句话定义及其边界

容器是一个普通进程（通常是一组进程），由 Linux 内核提供隔离视图与资源控制，由准备好的 root filesystem 提供用户空间文件，并由 runtime 按配置组装后启动。

```text
container = process
          + namespaces（看见什么）
          + cgroups（能用多少）
          + capabilities / LSM / seccomp（允许做什么）
          + rootfs + mounts（从哪个文件系统视图运行）
          + runtime configuration（命令、环境、用户、网络等）
```

这个公式比“容器是轻量虚拟机”更准确。后一句便于入门，却会制造三个错误直觉：

1. 以为每个容器有独立内核；Linux 容器实际共享承载它的 Linux 内核。
2. 以为容器内 root 天然等于安全沙箱；它仍受共享内核与运行配置边界影响。
3. 以为容器的磁盘像 VM 磁盘一样独立持久；默认可写层随容器删除。

---

## 2. 与虚拟机的结构对比

```text
虚拟机：
hardware → host/hypervisor → guest kernel → guest user space → process

Linux 容器：
hardware → Linux kernel → isolated user space view → process
```

| 维度 | 容器 | 虚拟机 |
|------|------|--------|
| 内核 | 多个容器共享宿主/VM Linux 内核 | 每个 VM 有 guest kernel |
| 启动单位 | 进程与 namespace/cgroup 配置 | 虚拟硬件、内核、系统服务 |
| 镜像内容 | 用户空间 rootfs + 配置 | 通常包含完整 OS 磁盘与内核 |
| 隔离边界 | 共享内核，依赖内核机制与运行配置 | hypervisor/硬件虚拟化边界 |
| 密度与启动 | 通常更高密度、更快 | 通常开销更高、启动更慢 |
| 内核差异 | 不能在 Linux 内核上直接运行 Windows 内核程序 | guest OS 可与 host 不同 |

在 Windows Docker Desktop 中，两者并非二选一：Docker Desktop 先使用 WSL 2/VM 提供 Linux 内核，再在其中运行多个 Linux 容器。

```text
Windows host
└── WSL 2 / Docker Desktop Linux VM
    ├── shared Linux kernel
    ├── container A processes
    └── container B processes
```

所以 Linux 容器共享的是 VM 中的 Linux 内核，而不是 Windows NT 内核。

---

## 3. namespace：限制“看见什么”

namespace 为进程提供某类系统资源的隔离视图。不同 namespace 可以独立组合；“容器”是 runtime 对这些机制的一种工程化组合，而不是内核中的单一对象类型。

| namespace | 隔离的视图 | 容器中的直观现象 | 共享/配置错误的风险 |
|-----------|------------|------------------|---------------------|
| PID | 进程编号与进程树 | 主进程在容器内是 PID 1 | `--pid=host` 可看到宿主/VM 进程 |
| Mount | mount points | 容器看到自己的 rootfs 与 mounts | bind mount 可暴露宿主文件 |
| Network | 网卡、路由、端口、网络栈 | 容器有独立接口与 IP | host network 减少网络隔离 |
| UTS | hostname/domain name | 容器有独立 hostname | 主要影响标识，不是安全边界全集 |
| IPC | System V IPC、POSIX message queues 等 | IPC 对象彼此隔离 | 共享 IPC 可能造成越权交互 |
| User | UID/GID 映射 | 容器内 UID 0 可映射为外部非 0 | 默认配置不一定启用独立 user namespace |
| Cgroup | cgroup 层级视图 | 进程看到受限资源层级 | 不是资源限制本身，而是视图隔离 |
| Time | 部分时钟视图 | 可隔离 boot/monotonic offset | 并非所有时间来源都隔离 |

namespace 的关键语义是**视图隔离**，不是“复制资源”。例如 PID namespace 让同一内核 task 在不同层级看到不同 PID；network namespace 提供独立网络栈，但数据包仍由共享内核处理。

### 为什么容器内 PID 1 很特殊

容器主进程通常成为其 PID namespace 的 PID 1。它承担两类额外责任：

1. 正确接收并处理平台发来的终止信号。
2. 回收成为孤儿的子进程，避免 zombie 累积。

常见 shell form：

```dockerfile
CMD my-server --port 8080
```

可能由 `/bin/sh -c` 作为 PID 1，信号是否转发取决于 shell 行为。exec form 更明确：

```dockerfile
CMD ["my-server", "--port", "8080"]
```

若应用确实会产生无法自行回收的子进程，可使用合适的 init（如 Docker `--init`），但不应把它当作掩盖应用生命周期错误的万能开关。

---

## 4. cgroup：限制与计量“能用多少”

namespace 不能限制 CPU 或内存。cgroup 将进程组织进层级，并由各 controller 负责资源统计与控制，例如：

- CPU 权重与配额。
- memory 使用、上限、事件与 OOM 行为。
- pids 上限，防止 fork bomb 耗尽进程表。
- IO 权重或限制（取决于平台与配置）。

### request、limit 之前先懂的 Docker 语义

无资源限制的容器不是“拥有无限资源”，而是与同一宿主/VM 中其他工作负载竞争可用资源。Docker Desktop 的 VM 本身还可能有资源上限。

```text
物理机资源
  → Docker Desktop / WSL VM 可用资源
    → cgroup 给容器的资源边界
      → 应用进程实际使用
```

`docker stats` 显示的是某个层次的观测结果。判断 OOM 时至少结合：

- 容器 `.State.OOMKilled`。
- cgroup memory limit 与峰值。
- 应用退出码和日志。
- Docker Desktop/宿主的整体内存压力。

ExitCode 137 只说明进程最终因 SIGKILL 结束的常见编码，不能单凭它断言一定由 cgroup OOM killer 触发。

---

## 5. rootfs 与 mount namespace：文件系统视图

镜像提供有序只读 layers。创建容器时，存储后端在其上增加容器专属 writable layer，并把结果作为 rootfs 提供给容器进程：

```text
container view
┌──────────────────────────────┐
│ writable container layer     │  新增、修改、删除标记
├──────────────────────────────┤
│ image layer N                │
├──────────────────────────────┤
│ ...                          │
├──────────────────────────────┤
│ base image layer             │
└──────────────────────────────┘
```

对下层已有文件首次修改时，典型存储实现采用 copy-on-write：把文件复制到上层，再修改上层副本。删除下层文件通常通过 whiteout/遮蔽表达，并不改写只读 blob。

工程后果：

- 多个容器可以共享只读 image layers，各自拥有不同 writable layer。
- stop/start 保留同一容器对象，因此可写层仍在。
- rm 删除容器可写层；业务数据必须使用 volume/bind mount/外部存储。
- 写密集数据库不适合依赖容器可写层，性能、生命周期和备份边界都不理想。
- “后续 layer 删除密钥”不会从旧 layer blob 中抹除它。

Docker Engine 29 的全新安装默认使用 containerd image store，以 snapshotter 管理镜像与容器数据；旧安装可能仍使用 classic storage driver。应以 `docker info` 为当前环境证据，不把某个存储实现写死为 Docker 的定义。

---

## 6. capabilities、seccomp 与 LSM：限制“允许做什么”

传统 Unix 把权限粗略分为 root 与非 root。Linux capabilities 把部分 root 权限拆分为独立能力，例如绑定低端口、修改网络配置等。Docker 默认仅给容器一组受限 capabilities，并允许进一步 drop/add。

还可叠加：

- seccomp：限制可调用的系统调用集合。
- AppArmor/SELinux 等 LSM：基于策略限制文件、进程等访问。
- user namespace：把容器内 UID/GID 映射到外部不同 ID。
- read-only rootfs、no-new-privileges、非 root 用户等运行约束。

重要边界：

- 容器不是绝对安全边界；内核漏洞、危险 capabilities、敏感 mounts 或暴露的 Docker socket 都可能扩大影响。
- `--privileged` 不只是“多给一点权限”，而是显著放宽隔离，不应作为权限报错的默认修复。
- 把 `/var/run/docker.sock` 暴露给容器，通常等价于把 daemon 的高权限控制面交给该容器。
- Docker daemon 的访问权本身接近宿主高权限，应严格控制。

---

## 7. 从 Docker API 到容器进程

以 `docker run` 为例，概念流程是：

```text
1. CLI 解析参数，通过当前 Docker context 调用 Engine API
2. Engine 解析镜像引用；需要时从 registry 拉取并校验内容
3. Engine 创建容器元数据、可写层、网络端点和 mount 配置
4. containerd/runtime 根据 OCI runtime config 准备 namespaces/cgroups/rootfs
5. runtime 创建容器初始进程
6. Engine 记录 PID、开始时间、状态并接管生命周期事件
7. CLI 根据 detach/attach 选择返回 ID 或连接 stdio
8. 主进程退出，runtime/Engine 记录 exit code，容器进入 exited
```

Docker、containerd、runc 的职责会随实现演进，学习时要抓住稳定接口边界：高层管理 API、镜像内容管理、OCI runtime bundle/config、内核进程机制。

---

## 8. 容器健康与进程存活是两件事

状态层次：

```text
Engine reachable
  ⊃ container process running
      ⊃ application initialized
          ⊃ dependency reachable
              ⊃ business request succeeds
```

下层成立不能推出上层成立。Nginx 进程运行不代表配置的 upstream 可用；应用端口监听不代表数据库迁移完成；HTTP 200 的浅探针也可能无法覆盖核心业务。

这就是后续 Docker healthcheck 与 Kubernetes startup/readiness/liveness probes 必须分开设计的原因。

---

## 9. 面试与自检问题

### 1. 容器为什么通常比 VM 启动快？

因为启动主要是准备 namespaces、cgroups、mounts 并创建进程，不需要为每个实例启动 guest kernel 和完整系统服务。不能简化成“容器一定毫秒启动”：镜像拉取、解包、应用初始化仍可能很慢。

### 2. 容器内能看到 8 个 CPU，就一定能用满 8 个吗？

不一定。可见 CPU、cgroup quota/weight、Docker Desktop VM 分配和宿主竞争共同决定实际能力。

### 3. 为什么容器内 root 仍有风险？

它可能拥有部分 capabilities、访问敏感 mount，并与其他容器共享内核；配置错误或内核漏洞可能扩大影响。应使用非 root、最小 capabilities、只读文件系统和平台策略等纵深防御。

### 4. stop 后文件还在，为什么不能当持久化？

因为 stop 保留容器对象；部署替换通常会 rm 并 create 新容器，新可写层不包含旧数据。持久数据生命周期必须独立于容器对象。

### 5. Kubernetes 为什么管理 Pod 而不是直接管理“永生容器”？

容器是易失进程；平台通过声明式控制器创建和替换实例来维持期望状态。Pod 又提供一组紧密协作容器共享的网络与 volume 边界。后续课程会展开。

---

## 10. 官方资料

- [Docker Engine security: namespaces, cgroups and capabilities](https://docs.docker.com/engine/security/)
- [Docker storage drivers: images and writable container layer](https://docs.docker.com/engine/storage/drivers/)
- [Docker storage overview](https://docs.docker.com/engine/storage/)
- [Docker Desktop container security FAQ](https://docs.docker.com/security/faqs/containers/)
- [OCI Runtime Specification](https://github.com/opencontainers/runtime-spec)

## 小结

容器的本质不是镜像、命令或 Docker 图标，而是一个被内核机制约束、由特定 rootfs 启动、由平台管理生命周期的进程。掌握这个模型后，端口、volume、资源限制、探针和 Kubernetes Pod 都能落到明确机制上，而不需要靠背诵抽象名词。
