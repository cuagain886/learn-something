# 00 · 环境准备与容器交付链路

> 这一课不是安装命令合集。目标是明确每个工具位于哪一层、如何证明环境真的可用，以及出现问题时应该检查哪一段链路。

## 学完你应该能做到

- 区分 Docker Desktop、Docker Engine、Docker CLI、containerd、OCI runtime 与容器进程。
- 解释为什么 Windows 上运行 Linux 容器需要 Linux 内核，以及 WSL 2 在其中的角色。
- 使用 [`check-env.ps1`](check-env.ps1) 判断“CLI 已安装”和“引擎可连接”这两个不同事实。
- 解释 kubectl 与 Kubernetes 集群、kind 与 Docker 之间的依赖关系。
- 为后续实验固定工具版本、Docker context 和 Kubernetes context。

---

## 1. 先建立正确的分层模型

在本课程默认的 Windows + Docker Desktop + WSL 2 环境中，执行：

```powershell
docker run nginx:1.29-alpine
```

不是在 Windows 内核上直接创建了一个 Linux 进程。简化后的调用链是：

```text
PowerShell
  │ docker CLI：解析命令，调用 Docker API
  ▼
Docker context：决定 API 请求发给哪个 Engine
  ▼
Docker Desktop 后端 / WSL 2 Linux VM
  │ dockerd：管理镜像、网络、volume、容器元数据
  │ containerd：管理镜像内容和容器生命周期
  │ OCI runtime：按 OCI runtime spec 创建隔离进程
  ▼
Linux 内核：namespace + cgroup + capabilities + filesystem mounts
  ▼
容器中的 nginx 进程
```

这里有四个容易混淆的事实：

1. **CLI 存在不代表 Engine 正在运行。** `docker --version` 只需本地可执行文件；`docker info` 必须连接 Engine。
2. **容器仍然是进程。** 它共享承载它的 Linux 内核，并没有为每个容器启动一套独立内核。
3. **Docker Desktop 不等于 Docker Engine。** Desktop 是 Windows/macOS 上包含 VM、Engine、CLI、网络和管理界面的产品。
4. **kubectl 不会创建集群。** kubectl 只是 Kubernetes API 客户端；kind 才负责在本地创建由容器充当节点的集群。

深入原理见 [`../../knowledge/01_container_model.md`](../../knowledge/01_container_model.md)。

---

## 2. 本课程的环境基线

| 组件 | 用途 | 本课程要求 | 验证重点 |
|------|------|------------|----------|
| Windows 10/11 | 宿主系统 | Docker Desktop 支持的版本 | 系统版本与虚拟化 |
| WSL 2 | 提供 Linux 内核与虚拟化后端 | 2.1.5+，建议保持最新 | `wsl --version` |
| Docker Desktop | Linux 容器开发环境 | 使用 WSL 2 backend | Desktop 已启动 |
| Docker CLI/Engine | 构建、运行和观察容器 | 使用 Linux containers | Client 与 Server 都可用 |
| Docker Compose | 多容器声明式运行 | Compose v2，即 `docker compose` | 不使用旧的 `docker-compose` |
| kubectl | Kubernetes API 客户端 | 与集群版本相差不超过一个 minor | client version |
| kind | 创建本地 Kubernetes 集群 | 实现第 11 课前安装 | `kind version` |

版本不写死在总计划里。每次开始一批 Kubernetes 实验时，在该批 README 中记录实际版本，并在 CI 或复现实验时使用同一版本。

---

## 3. 运行环境自检

在仓库根目录执行：

```powershell
& .\docker-kubernetes\code\00_environment\check-env.ps1
```

脚本把结果分为：

- `PASS`：命令存在且对应服务可用。
- `WARN`：当前 Docker 课程不阻塞，但进入 Kubernetes 课程前要处理。
- `FAIL`：Docker 基础实验无法可靠运行。

进入 Kubernetes 阶段前使用严格模式：

```powershell
& .\docker-kubernetes\code\00_environment\check-env.ps1 -RequireKind
```

### 为什么分别检查 Client 和 Server

```powershell
docker version
```

输出分为 Client 与 Server：

- Client 来自 `docker.exe`，只说明 CLI 能执行。
- Server 来自 Docker API，说明 Engine 已启动、当前 context 可达且协议协商成功。

如果只有 Client，常见错误是：

```text
failed to connect to the docker API ... dockerDesktopLinuxEngine
```

这时不应重装 CLI。先启动 Docker Desktop，再检查：

```powershell
docker context show
docker context ls
docker info
```

`docker context show` 决定 CLI 当前连接哪个 daemon。环境里同时存在远程 Engine、Docker Desktop 和测试环境时，选错 context 会产生“明明启动了却连不上”或“容器怎么不见了”的错觉。

---

## 4. 安装与修复顺序

### 4.1 WSL 2

先检查，不要一上来重装：

```powershell
wsl --version
wsl --status
wsl --list --verbose
```

需要安装或更新时，在管理员 PowerShell 执行：

```powershell
wsl --install
wsl --update
```

完成后可能需要重启。Docker Desktop 官方要求 WSL 2.1.5 或更高版本；硬件虚拟化也必须在 BIOS/UEFI 中启用。

### 4.2 Docker Desktop

安装后确认：

1. Docker Desktop 已启动，而不仅是安装完成。
2. Settings 中使用 WSL 2 based engine。
3. 当前运行 Linux containers；本课程镜像不能在 Windows container daemon 中运行。
4. `docker info --format '{{.OSType}}'` 输出 `linux`。

不要在同一个 WSL 发行版内额外安装一套 Docker Engine 再与 Docker Desktop 混用；两套 daemon、socket 和镜像存储会让 context 与文件权限问题变得难以判断。

### 4.3 kubectl

Docker Desktop 通常自带 kubectl，也可以按 Kubernetes 官方文档独立安装。验证：

```powershell
kubectl version --client --output=yaml
```

此命令成功只代表客户端存在。以下命令成功才代表当前 kubeconfig 指向一个可用集群：

```powershell
kubectl config current-context
kubectl cluster-info
```

### 4.4 kind

kind 不是 Docker Desktop 的必备组件，因此可能尚未安装。按 kind 官方 Quick Start 选择 release binary 或包管理器安装，完成后验证：

```powershell
kind version
```

第 11 课才创建集群。当前不要为了验证安装而留下无归属的测试集群。

---

## 5. 第一个端到端探针

Docker Engine 启动后执行：

```powershell
docker run --rm hello-world
```

这条命令同时验证了多个环节：

1. CLI 能连接 Engine。
2. Engine 能解析镜像名并访问 registry。
3. manifest 与 layer 能下载并校验 digest。
4. runtime 能创建 Linux 容器进程。
5. 容器标准输出能返回终端。
6. 进程退出后 `--rm` 能删除容器元数据和可写层。

它**没有**验证端口发布、持久化、多容器网络或 Kubernetes，这些由后续课程逐层验证。

---

## 6. 环境快照：让问题可复现

遇到环境问题时保存以下信息，而不是只截一张报错图：

```powershell
docker version
docker info
docker context ls
docker compose version
kubectl version --client --output=yaml
kubectl config get-contexts
kind version
wsl --version
wsl --list --verbose
```

注意：`docker info` 可能显示 registry mirror、proxy 等组织环境信息；公开贴日志前先检查是否包含内部域名。

---

## 7. 故障练习

### 故障 A：CLI 存在但 Engine 未启动

1. 退出 Docker Desktop。
2. 执行 `docker --version`，预期成功。
3. 执行 `docker info`，预期失败。
4. 用分层模型解释两条命令为何结果不同。
5. 启动 Desktop，等 `docker info` 恢复后再继续。

### 故障 B：选错 context

只查看，不要删除 context：

```powershell
docker context ls
docker context show
```

如果有多个 context，记录每个 endpoint。理解 `*` 标记的是实际请求目标。

### 故障 C：kubectl 存在但没有集群

```powershell
kubectl version --client
kubectl cluster-info
```

前者成功、后者失败是合理状态：客户端与服务端是两项独立依赖。

---

## 8. 验收清单

- [ ] 能画出 CLI → Engine → containerd/runtime → Linux 内核 → 容器进程的链路。
- [ ] `check-env.ps1` 的 Docker Engine 检查为 `PASS`。
- [ ] `docker info --format '{{.OSType}}'` 输出 `linux`。
- [ ] `docker run --rm hello-world` 成功且 `docker ps -a` 中不遗留该容器。
- [ ] 能解释 Docker context 与 Kubernetes context 互不相同。
- [ ] 已记录本机 Docker、Compose、kubectl、kind 与 WSL 版本。

## 9. 官方依据

- [Docker Desktop on Windows](https://docs.docker.com/desktop/setup/install/windows-install/)
- [Docker Desktop WSL 2 backend](https://docs.docker.com/desktop/features/wsl/)
- [Install kubectl on Windows](https://kubernetes.io/docs/tasks/tools/install-kubectl-windows/)
- [kind Quick Start](https://kind.sigs.k8s.io/docs/user/quick-start/)

> 下一课：[`01_container_basics`](../01_container_basics/README.md)。
