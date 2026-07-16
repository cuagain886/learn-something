# 11 · 集群架构与 kubectl：沿 API 请求追踪控制平面

> kind 用 Docker 容器模拟节点，适合学习和 CI，不等于生产 HA 集群。本课关注组件职责与证据链，而不是“命令能返回 Ready”。

## 1. 固定版本基线

- kind：v0.32.0。
- node image：Kubernetes v1.35.0，固定官方 release digest。
- kubectl：本机 v1.34.1，与 server 相差一个 minor。

最新 Kubernetes 已进入 1.36，但课程固定 1.35.0 以匹配 kind release 的已验证 node image。可复现不等于永不更新：后续升级应同时更新 kind、node digest、kubectl 并重跑课程。

进入本课前：

```powershell
& ..\00_environment\check-env.ps1 -RequireKind
kind version
docker info
```

脚本不会自动安装 kind，也不会改已有集群。

---

## 2. 架构不是一个“大脑”

```text
kubectl/client
   │ HTTPS REST
   ▼
kube-apiserver ── persist/watch ── etcd
   ▲       ▲
   │       ├─ scheduler：只为未绑定 Pod 选择 node
   │       └─ controllers：观察差异，创建/更新 API objects
   │
kubelet：watch 已绑定本 node 的 PodSpec → container runtime → report status
```

- API Server 是统一控制面入口：认证、授权、准入、校验、转换、持久化与 watch。
- etcd 保存集群 API 状态，不运行 Pod；备份 etcd 是控制面恢复关键。
- scheduler 只做绑定决策，不启动容器。
- controller manager 中多个控制循环推动实际状态接近期望状态，不直接登录节点执行命令。
- kubelet 位于每个 node，落实绑定到本节点的 PodSpec，并回报状态。
- container runtime 依据 CRI 管理 image/container；Kubernetes 不要求 Docker Engine 作为节点 runtime。

---

## 3. 创建可观察的三节点集群

```powershell
& .\create-cluster.ps1
kubectl config current-context
kubectl cluster-info
kubectl get nodes -o wide
```

kind 创建 1 control-plane + 2 worker。节点本身是 Docker 容器，但节点内使用 containerd 运行 Pod 容器，形成嵌套的教学结构：

```text
Docker Desktop VM
└─ kind node container
   ├─ kubelet/containerd
   └─ Pod containers
```

不要用 `docker ps` 中 kind node 的状态替代 `kubectl get nodes`：前者只证明节点容器进程存在，后者反映 kubelet 心跳与 Node conditions。

---

## 4. 查看控制平面如何自托管

```powershell
kubectl get pods -n kube-system -o wide
kubectl get pod -n kube-system -l component=kube-apiserver -o yaml
docker exec dk-course-control-plane ls /etc/kubernetes/manifests
```

kind/kubeadm 把 API Server、scheduler、controller-manager、etcd 定义为 static Pods。kubelet直接观察本地 manifest 路径并管理它们；API 中看到的 mirror Pod 是可观察表示，不是由 Deployment 创建。

查看组件日志要先识别具体 Pod 名：

```powershell
kubectl logs -n kube-system -l component=kube-scheduler --tail=30
kubectl logs -n kube-system -l component=kube-controller-manager --tail=30
```

---

## 5. kubectl 是 API 客户端

```powershell
kubectl config view --minify
kubectl auth whoami
kubectl api-resources
kubectl api-versions
kubectl get --raw /readyz?verbose
```

kubeconfig context 组合 cluster endpoint、user credential 和默认 namespace。切错 context 的风险不是“查不到资源”，而是把写操作发到错误集群。每次破坏性命令前确认：

```powershell
kubectl config current-context
kubectl auth can-i delete pods --namespace dk-course
```

`kubectl get --raw` 证明 kubectl 最终调用 HTTP API；常规 get/apply 只是更友好的资源发现、序列化与输出层。

---

## 6. 从创建 Pod 到进程运行的因果链

```text
POST Pod → API Server 持久化（nodeName 为空）
→ scheduler watch 到未调度 Pod，过滤/评分 node
→ Binding/更新 nodeName
→ 目标 kubelet watch 到 Pod
→ runtime 拉镜像、建 sandbox/containers
→ kubelet 更新 Pod status/conditions
→ API watch 通知客户端与其他控制器
```

任何一步都可能独立失败。`Pending` 不只等于“镜像还在下载”：可能尚未调度、volume 未绑定、sandbox 创建失败。必须结合 conditions 与 Events。

---

## 7. kind 本地镜像边界

宿主 Docker image store 与 kind 节点 containerd store 不同。构建第 13 课镜像后需要显式加载：

```powershell
docker build -t dk-course/pod-lifecycle:13 ..\13_pod_lifecycle
kind load docker-image dk-course/pod-lifecycle:13 --name dk-course
docker exec dk-course-worker crictl images | Select-String pod-lifecycle
```

manifest 使用 `imagePullPolicy: IfNotPresent`。不要写 `Always` 后期待集群从私有的宿主 image store 拉取。

---

## 8. 验收与清理

- [ ] 能准确说明 scheduler、controller、kubelet 不负责什么。
- [ ] 能从 kubeconfig 解释当前 API endpoint 与身份。
- [ ] 能区分 kind node container、Node API object 和 Pod container。
- [ ] 能画出 Pod create 到 runtime start 的异步链路。

导出排障信息后再删集群：

```powershell
kind export logs .\kind-logs --name dk-course
kind delete cluster --name dk-course
```

官方依据：[Cluster Architecture](https://kubernetes.io/docs/concepts/architecture/)、[Controllers](https://kubernetes.io/docs/concepts/architecture/controller/)、[Scheduler](https://kubernetes.io/docs/concepts/scheduling-eviction/kube-scheduler/)、[kind releases](https://github.com/kubernetes-sigs/kind/releases)。

> 下一课：[12 声明式 API](../12_declarative_api/README.md)。
