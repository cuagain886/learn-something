# 13 Pod 生命周期：从调度到终止的证据链

这一课不把 Pod 当成“更小的虚拟机”。目标是沿着 `Pod → containerStatuses → runtime process` 三层状态，解释一个工作负载为什么尚未可用、为什么重启，以及删除时发生了什么。

## 1. 实验模型

`pod.yaml` 运行一个无 shell 的非 root Go 服务：

- 进程启动后 `/livez` 立即返回 200；
- `/readyz` 前 8 秒返回 503，之后返回 200；
- `/` 返回 Downward API 注入的 Pod 名、节点名和进程 UID；
- 收到 `SIGTERM` 后停止接收新请求，并最多用 10 秒排空连接。

Pod 还声明了 startup、readiness、liveness probe，资源 request/limit 和受限安全上下文。`crashloop.yaml` 与 `completed.yaml` 分别制造“反复失败”和“一次成功结束”。

## 2. 准备镜像与命名空间

在仓库根目录执行：

```powershell
kubectl config use-context kind-dk-course
kubectl apply -f .\docker-kubernetes\code\12_declarative_api\namespace.yaml

docker build -t dk-course/pod-lifecycle:13 .\docker-kubernetes\code\13_pod_lifecycle
kind load docker-image dk-course/pod-lifecycle:13 --name dk-course
```

`docker build` 把镜像放入宿主机 Docker Engine；kind 节点里的 kubelet 使用节点容器中的 containerd，两者不是同一个镜像存储。`kind load` 是必须跨越的边界。清单使用 `imagePullPolicy: IfNotPresent`，因此节点已有镜像时不会尝试从公网拉取。

确认镜像确实进入每个节点：

```powershell
docker exec dk-course-control-plane crictl images dk-course/pod-lifecycle
docker exec dk-course-worker crictl images dk-course/pod-lifecycle
docker exec dk-course-worker2 crictl images dk-course/pod-lifecycle
```

## 3. 创建过程中分别观察什么

先开两个终端：

```powershell
# 终端 A：对象和容器状态变化
kubectl get pod -n dk-course lifecycle-demo -w
```

```powershell
# 终端 B：按资源时间线看事件
kubectl events -n dk-course --for pod/lifecycle-demo --watch
```

第三个终端创建 Pod：

```powershell
kubectl apply -f .\docker-kubernetes\code\13_pod_lifecycle\manifests\pod.yaml
kubectl describe pod -n dk-course lifecycle-demo
kubectl get pod -n dk-course lifecycle-demo -o yaml
```

不要只记 `Pending → Running`。把证据拆成四层：

1. `spec.nodeName` 为空到出现：scheduler 已经绑定节点。
2. `status.conditions` 中 `PodScheduled`、`Initialized`、`ContainersReady`、`Ready`：它们回答不同问题。
3. `status.containerStatuses[0].state`：容器此刻是 waiting、running 还是 terminated。
4. Events：`Scheduled`、`Pulling/Created/Started` 或失败原因构成带时间的因果线索。

可用 JSONPath 聚焦字段，避免在完整 YAML 中迷失：

```powershell
kubectl get pod -n dk-course lifecycle-demo -o jsonpath='{.spec.nodeName}{"`n"}'
kubectl get pod -n dk-course lifecycle-demo -o jsonpath='{range .status.conditions[*]}{.type}{"="}{.status}{" reason="}{.reason}{"`n"}{end}'
kubectl get pod -n dk-course lifecycle-demo -o jsonpath='{range .status.containerStatuses[*]}{.name}{" ready="}{.ready}{" restarts="}{.restartCount}{" state="}{.state}{"`n"}{end}'
```

## 4. 三种 probe 不是三个同义健康检查

| Probe | 失败时的直接动作 | 回答的问题 |
|---|---|---|
| startup | 未成功前阻止 liveness/readiness；超过阈值后重启容器 | 应用是否完成启动 |
| readiness | 将容器标为 not ready，不直接重启 | 现在是否应接收流量 |
| liveness | 超过阈值后重启容器 | 进程是否已无法自行恢复 |

本实验 startup probe 检查立即可用的 `/livez`，所以很快成功；readiness 在约 8 秒内失败，因此 Pod 可以处于 `Running`，但 `READY` 仍为 `0/1`。这证明 phase 不是流量资格。

```powershell
kubectl port-forward -n dk-course pod/lifecycle-demo 18080:8080
curl.exe -i http://127.0.0.1:18080/readyz
curl.exe -i http://127.0.0.1:18080/
```

生产上最危险的两个反模式：把依赖服务短暂不可达当作 liveness 失败，会制造级联重启；把 startup 阈值设得小于正常最慢启动时间，会让应用永远无法启动。

## 5. request 与 limit 位于不同控制面

清单声明 CPU `20m/200m`、内存 `16Mi/64Mi`：

- scheduler 用 request 评估节点是否有足够可分配资源；它不以实时 CPU 使用率做这次放置决定。
- kubelet/runtime 把 limit 落到节点的资源隔离机制。CPU 超额通常被节流；内存超过硬限制可能触发 OOM kill。
- request 不是预留一个独占 CPU 核，limit 也不是性能保证。

查看声明、节点容量与当前指标：

```powershell
kubectl get pod -n dk-course lifecycle-demo -o jsonpath='{.spec.containers[0].resources}{"`n"}'
kubectl describe node (kubectl get pod -n dk-course lifecycle-demo -o jsonpath='{.spec.nodeName}')
kubectl top pod -n dk-course lifecycle-demo
```

`kubectl top` 需要 Metrics Server；kind 默认没有。命令失败并不表示 request/limit 无效，只表示指标 API 不存在。

## 6. CrashLoopBackOff 是退避状态，不是根因

```powershell
kubectl apply -f .\docker-kubernetes\code\13_pod_lifecycle\manifests\crashloop.yaml
kubectl get pod -n dk-course crashloop-demo -w
kubectl describe pod -n dk-course crashloop-demo
kubectl logs -n dk-course crashloop-demo --previous
kubectl get pod -n dk-course crashloop-demo -o jsonpath='{.status.containerStatuses[0].lastState.terminated}{"`n"}'
```

容器进程以 42 退出；`restartPolicy: Always` 让 kubelet 在同一个 Pod 中重建容器，`restartCount` 增长，Pod UID 不变。连续快速失败后，kubelet 延迟下一次启动，kubectl 展示 `CrashLoopBackOff`。排障时真正要找的是 `lastState.terminated.exitCode/reason`、上一实例日志和 Events，而不是把 BackOff 当作应用错误。

## 7. 成功退出为何有时仍会重启

```powershell
kubectl apply -f .\docker-kubernetes\code\13_pod_lifecycle\manifests\completed.yaml
kubectl get pod -n dk-course completed-demo -w
kubectl get pod -n dk-course completed-demo -o jsonpath='{.status.phase}{" exit="}{.status.containerStatuses[0].state.terminated.exitCode}{"`n"}'
```

这里 `restartPolicy: Never` 且进程退出码为 0，所以 phase 最终为 `Succeeded`。若把同一进程放入 `restartPolicy: Always` 的 Pod，即使退出码为 0，kubelet仍会重启它。是否重启由退出结果与 restart policy 共同决定。

`restartPolicy` 只作用于同一 Pod 内的容器。Deployment 创建新 Pod 是控制器的另一层行为，不能混为一谈。

## 8. 优雅终止的时间预算

一个终端跟随日志：

```powershell
kubectl logs -n dk-course lifecycle-demo -f
```

另一个终端删除：

```powershell
kubectl delete pod -n dk-course lifecycle-demo --grace-period=20
```

典型顺序是：

1. API 对象记录删除时间与宽限期，Pod 进入 terminating 展示状态。
2. kubelet开始总计 20 秒的倒计时；若有 `preStop`，它也消耗这段预算，而不是额外获得时间。
3. runtime 向容器主进程发送 TERM；本服务记录信号并执行 `http.Server.Shutdown`。
4. 进程在预算内退出；否则宽限期结束后被强制杀死。

清单的 20 秒必须大于应用 10 秒的最大排空时间，并留出调度和 hook 开销。直接创建的 Pod 删除后不会回来；若由 Deployment 管理，控制器会创建替代 Pod，这是“对象所有权”而非 kubelet重启。

## 9. 安全上下文为何每项都要有理由

本实验同时使用：

- `runAsNonRoot` 与 UID/GID 65532：禁止以 root 运行；
- `allowPrivilegeEscalation: false`：禁止通过 setuid 等路径获得更多权限；
- `capabilities.drop: [ALL]`：移除默认 Linux capabilities；
- `readOnlyRootFilesystem: true`：阻止向镜像根文件系统写入；
- `seccompProfile: RuntimeDefault`：应用运行时默认 syscall 过滤策略。

这不是“安全标签集合”。例如需要写临时文件时，应显式挂载 `emptyDir` 到确定目录，而不是把整个根文件系统改回可写。

## 10. 故障练习与验收

依次修改并解释证据链：

1. 把镜像标签改成不存在的值：观察 `ErrImagePull → ImagePullBackOff`，从 Events 定位拉取失败。
2. 把 readiness 路径改成 `/missing`：Pod phase 可为 Running，但 `Ready=False`；容器不应因 readiness 失败重启。
3. 把 liveness 路径改成 `/missing`：达到阈值后 `restartCount` 增长，并用 `--previous` 读取前一实例日志。
4. 把内存 request 改得大于任一节点可分配量：Pod 保持 Pending，从 scheduler event 读取 `FailedScheduling`。

验收时必须能独立说明：

- Pod phase、condition、container state 和 kubectl `STATUS` 列为何不是同一字段；
- Running 为何不等于 Ready；
- CrashLoopBackOff 为何是结果而非根因；
- scheduler、kubelet和应用进程在启动/终止路径中各负责什么；
- request、limit、probe、restart policy 分别在哪一层生效。

## 11. 清理

```powershell
kubectl delete -f .\docker-kubernetes\code\13_pod_lifecycle\manifests --ignore-not-found
```

若不继续后续课程，再删除命名空间和集群：

```powershell
kubectl delete namespace dk-course --ignore-not-found
kind delete cluster --name dk-course
```
