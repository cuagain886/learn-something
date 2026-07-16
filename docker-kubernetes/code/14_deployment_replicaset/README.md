# 14 · Deployment 与 ReplicaSet：控制器如何自愈

这一课研究的不是“怎样写 Deployment YAML”，而是三层控制器对象怎样通过 ownerReferences、selector 和 Pod template 收敛，以及为什么删除 Pod、扩容和修改模板会产生不同结果。

## 1. 前置准备

从仓库根目录执行：

```powershell
kubectl config use-context kind-dk-course
kubectl apply -f .\docker-kubernetes\code\12_declarative_api\namespace.yaml
docker build -t dk-course/pod-lifecycle:13 .\docker-kubernetes\code\13_pod_lifecycle
kind load docker-image dk-course/pod-lifecycle:13 --name dk-course
```

若上一课已构建并加载完全相同的镜像，可跳过 build/load，但要用节点侧证据确认，而不是凭宿主机 `docker images` 推断：

```powershell
docker exec dk-course-worker crictl images dk-course/pod-lifecycle
docker exec dk-course-worker2 crictl images dk-course/pod-lifecycle
```

## 2. 创建后不要只看 Pod

```powershell
kubectl apply -f .\docker-kubernetes\code\14_deployment_replicaset\manifests\deployment.yaml
kubectl rollout status deployment/lifecycle-api -n dk-course --timeout=120s
kubectl get deployment,replicaset,pod -n dk-course -l app.kubernetes.io/name=lifecycle-api -o wide
```

对象链是：

```text
Deployment lifecycle-api
└─ ReplicaSet lifecycle-api-<pod-template-hash>
   ├─ Pod lifecycle-api-<hash>-<suffix>
   ├─ Pod lifecycle-api-<hash>-<suffix>
   └─ Pod lifecycle-api-<hash>-<suffix>
```

Deployment controller 管理 ReplicaSet；ReplicaSet controller 管理 Pod。它们不是一个控制器直接跨两层创建全部对象。读取 ownerReferences 验证：

```powershell
$rs = kubectl get rs -n dk-course -l app.kubernetes.io/name=lifecycle-api -o jsonpath='{.items[0].metadata.name}'
$pod = kubectl get pod -n dk-course -l app.kubernetes.io/name=lifecycle-api -o jsonpath='{.items[0].metadata.name}'
kubectl get deployment lifecycle-api -n dk-course -o jsonpath='{.metadata.uid}{"`n"}'
kubectl get rs $rs -n dk-course -o jsonpath='{.metadata.ownerReferences}{"`n"}'
kubectl get pod $pod -n dk-course -o jsonpath='{.metadata.ownerReferences}{"`n"}'
```

`ownerReferences.controller=true` 表示负责管理该对象的控制器所有者；删除传播与垃圾回收也依赖这张所有权图。

## 3. replicas 是控制回路输入，不是创建次数

ReplicaSet 的核心计算可简化为：

```text
差值 = spec.replicas - 当前匹配且归属本控制器的 Pod 数量
差值 > 0：创建 Pod
差值 < 0：删除部分 Pod
差值 = 0：不做副本数动作
```

真实实现还处理并发创建/删除、期望计数、失败退避和终止中的 Pod，因此不要把简化公式误当源码。

先记录 Pod UID，然后删除其中一个：

```powershell
kubectl get pod -n dk-course -l app.kubernetes.io/name=lifecycle-api `
  -o custom-columns='NAME:.metadata.name,UID:.metadata.uid,NODE:.spec.nodeName,READY:.status.conditions[?(@.type=="Ready")].status'

$victim = kubectl get pod -n dk-course -l app.kubernetes.io/name=lifecycle-api -o jsonpath='{.items[0].metadata.name}'
kubectl delete pod $victim -n dk-course
kubectl get pod -n dk-course -l app.kubernetes.io/name=lifecycle-api -w
```

新 Pod 名和 UID 改变，旧 Pod 并未“复活”。ReplicaSet 看到集合少一个，创建替代对象；scheduler 再为新对象选节点，kubelet再创建容器。这叫重建，不叫进程迁移。

查看这段行为的证据：

```powershell
kubectl describe rs $rs -n dk-course
kubectl events -n dk-course --types=Normal,Warning
```

## 4. selector 是控制器的集合边界

Deployment selector 必须匹配 Pod template labels。故意提交不匹配的清单：

```powershell
kubectl apply --server-side --validate=strict `
  -f .\docker-kubernetes\code\14_deployment_replicaset\manifests\invalid-selector.yaml
```

API Server 应拒绝它，因为控制器如果创建出自己选不中的 Pod，就会持续创建而无法收敛。

对 `apps/v1` Deployment，创建后 selector 不可变。不要通过扩大 selector“接管”其他 Pod；使用模板标签区分版本，并让 Deployment controller 管理 ReplicaSet。两个控制器在同一 namespace 使用重叠 selector 会形成相互争抢或错误计数。

`pod-template-hash` 由 Deployment controller 根据 Pod template 计算并加入 ReplicaSet selector 与 Pod label。不要手工修改它，也不要把其具体哈希算法当公共 API。

## 5. scale 与修改 Pod template 的语义不同

扩容只修改期望副本数：

```powershell
kubectl scale deployment/lifecycle-api -n dk-course --replicas=5
kubectl wait deployment/lifecycle-api -n dk-course --for=condition=Available --timeout=120s
kubectl get rs -n dk-course -l app.kubernetes.io/name=lifecycle-api
kubectl rollout history deployment/lifecycle-api -n dk-course
```

单纯 scale 不创建 Deployment revision，因为 Pod template 没变；当前 ReplicaSet 扩到 5。

现在修改模板中的环境变量：

```powershell
kubectl set env deployment/lifecycle-api -n dk-course COURSE_REVISION=2
kubectl rollout status deployment/lifecycle-api -n dk-course --timeout=120s
kubectl get rs -n dk-course -l app.kubernetes.io/name=lifecycle-api
kubectl rollout history deployment/lifecycle-api -n dk-course
```

这会改变 `.spec.template`，Deployment 创建新 ReplicaSet，并按 `maxSurge: 1`、`maxUnavailable: 0` 在可用性约束下调整新旧 ReplicaSet。完整的坏版本、暂停和回滚留到第 23 课；此处只需掌握“副本变化”和“模板变化”是两类状态转换。

## 6. 三组计数分别意味着什么

```powershell
kubectl get deployment lifecycle-api -n dk-course -o jsonpath='spec={.spec.replicas} replicas={.status.replicas} updated={.status.updatedReplicas} ready={.status.readyReplicas} available={.status.availableReplicas}{"`n"}'
kubectl get deployment lifecycle-api -n dk-course -o jsonpath='{range .status.conditions[*]}{.type}{"="}{.status}{" reason="}{.reason}{" observed="}{.observedGeneration}{"`n"}{end}'
```

- `replicas`：控制器观察到的总副本。
- `updatedReplicas`：使用当前 Pod template 的副本。
- `readyReplicas`：当前 Ready 的副本。
- `availableReplicas`：Ready 持续至少 `minReadySeconds` 的副本。

`Available=True` 不是“每个请求都成功”；它只表达 Deployment 定义下的最低可用副本条件。应用级 SLO 仍需指标和端到端探测。

## 7. 控制器暂停不等于业务暂停

若 controller-manager 暂时不可用，已经运行的 Pod 不会因此立即退出，但删除后的副本补偿、扩缩容和 rollout 会停止收敛。API 中的 spec 仍可写入，不代表相应控制器已经处理。检查 `metadata.generation`、status 中的 `observedGeneration` 与 conditions，避免只看 apply 成功。

## 8. 故障练习

1. 把 `replicas` 改成 4，确认只扩当前 ReplicaSet且 revision 不增加。
2. 给一个 Pod 删除 selector 所需 label：观察 ReplicaSet 是否创建替代 Pod，并解释被移出集合的原 Pod为何仍存在。
3. 删除 ReplicaSet：观察 Deployment 创建新的 ReplicaSet，再沿 ownerReferences 解释级联行为。
4. 把镜像改成不存在的标签：观察新 ReplicaSet、旧可用副本、Deployment conditions 与 progress deadline；不要立即删除现场。

第 2 项会留下孤立实验 Pod，清理时应按具体名字删除，不能假设 Deployment selector 还能选中它。

## 9. 验收与清理

验收时应能回答：

- Deployment、ReplicaSet、Pod 三层各自维护什么不变量；
- 删除 Pod 与容器 restart 有何不同；
- scale 为何不产生 revision，而 template 变化会产生；
- selector、template labels、pod-template-hash 如何共同定义集合；
- apply 成功后为何仍要观察 generation、conditions 和 Events。

```powershell
kubectl delete deployment lifecycle-api -n dk-course --wait=true
kubectl get rs,pod -n dk-course -l app.kubernetes.io/name=lifecycle-api
```

官方依据：[Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)、[ReplicaSet](https://kubernetes.io/docs/concepts/workloads/controllers/replicaset/)、[Labels and Selectors](https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/)。

> 下一课：[15 Service 与 EndpointSlice](../15_service_discovery/README.md)。
