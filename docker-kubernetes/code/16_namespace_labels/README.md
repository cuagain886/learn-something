# 16 · Namespace、标签与治理：作用域不是天然隔离墙

Namespace 解决资源名称作用域和策略挂载点问题；labels 构成动态集合；annotations 保存不可选择的扩展元数据。真正的多租户边界还需要 RBAC、配额、Pod Security、NetworkPolicy 和集群级治理共同完成。

## 1. 创建两个明确命名的作用域

从仓库根目录执行：

```powershell
kubectl apply -f .\docker-kubernetes\code\16_namespace_labels\manifests\namespaces.yaml
kubectl get namespace lab-dev lab-prod --show-labels
kubectl get namespace lab-dev -o jsonpath='{.metadata.labels.kubernetes\.io/metadata\.name}{"`n"}'
```

Kubernetes 自动给 Namespace 添加不可变的 `kubernetes.io/metadata.name` label。Namespace 不能嵌套，一个 namespaced object 也只能属于一个 namespace。

查看哪些资源有 namespace 作用域：

```powershell
kubectl api-resources --namespaced=true
kubectl api-resources --namespaced=false
```

Deployment、Pod、Service、ConfigMap 通常是 namespaced；Node、Namespace、StorageClass、PersistentVolume 等是 cluster-scoped。`kubectl get all` 既不表示所有 API 类型，也默认只查询当前 namespace。

## 2. 当前 context 的默认 namespace 是隐式输入

```powershell
kubectl config view --minify
kubectl config set-context --current --namespace=lab-dev
kubectl config view --minify -o jsonpath='{..namespace}{"`n"}'
```

设置默认 namespace 只改变该 kubeconfig context 的客户端默认值，不创建权限边界，也不移动对象。自动化清单应显式写 `metadata.namespace`，破坏性命令应显式写 `-n` 并先确认 context。

同名对象可以存在于不同 namespace：

```powershell
kubectl apply -f .\docker-kubernetes\code\16_namespace_labels\manifests\objects.yaml
kubectl get configmap application-metadata -n lab-dev -o jsonpath='{.data.log-level}{"`n"}'
kubectl get configmap application-metadata -n lab-prod -o jsonpath='{.data.log-level}{"`n"}'
```

它们不是同一个对象的两个环境视图，而是 namespace/name 作用域下两个独立 UID 的对象。

## 3. Labels 是集合查询协议

```powershell
kubectl get configmap -A -l app.kubernetes.io/part-of=docker-kubernetes-course --show-labels
kubectl get configmap -A -l 'environment in (development,production),tier!=database' --show-labels
kubectl get configmap -n lab-prod -l 'tier in (backend,batch)' --show-labels
```

多个 selector requirement 是 AND；Kubernetes label selector 没有通用 OR 运算符。`in` 的 values 可表达同一 key 的集合匹配，但不能把任意两个完整条件组做 OR。

Label 不是唯一键，也不是可信身份。任何拥有对象更新权限的主体通常可以修改普通 label，因此安全策略若依赖 label，必须用 RBAC/准入限制谁能写受信任键。

Label 是动态的，修改后对象会立即进入或离开 selector 集合：

```powershell
kubectl label configmap search-index -n lab-dev tier=cache --overwrite
kubectl get configmap -n lab-dev -l tier=database
kubectl get configmap -n lab-dev -l tier=cache --show-labels
```

对 Service 或 ReplicaSet 管理的 Pod 修改 selector label 会直接影响流量或控制器计数，不是无害的“分类整理”。

## 4. 推荐标签表达不同维度

本实验使用：

- `app.kubernetes.io/name`：应用/组件的通用名称；
- `app.kubernetes.io/instance`：一次具体安装，如 dev、prod；
- `app.kubernetes.io/component`：api、worker、database 等架构角色；
- `app.kubernetes.io/part-of`：所属更高层系统；
- `app.kubernetes.io/managed-by`：管理工具或控制器。

不要把这些维度压成一个含义混杂的 `app: api-prod-v2-team-a`。稳定、低基数、确实用于选择/聚合的属性适合 label；长文本、URL、校验和、联系人等适合 annotation。

## 5. Annotations 不参与 selector

```powershell
kubectl get configmap application-metadata -n lab-prod -o jsonpath='{.metadata.annotations}{"`n"}'
kubectl annotate configmap application-metadata -n lab-prod `
  owner.example.com/change-ticket=CHG-2026-0713 --overwrite
```

Annotation 可被控制器或工具读取，但 Kubernetes 核心不会因为存在某个 runbook URL 自动采取动作。它也不适合放秘密：有对象读取权限的人可以直接读取，且值可能进入审计、备份和工具输出。

## 6. ResourceQuota 是 namespace 总预算

```powershell
kubectl apply -f .\docker-kubernetes\code\16_namespace_labels\manifests\policies.yaml
kubectl describe resourcequota namespace-budget -n lab-dev
kubectl get resourcequota namespace-budget -n lab-dev -o jsonpath='{.status.hard}{"`n"}{.status.used}{"`n"}'
```

ResourceQuota 在准入时阻止导致 namespace 总量超过 hard 的请求。它不是节点容量预留：namespace 的 CPU quota 尚有余额，不代表 scheduler 一定能找到满足 Pod request 的节点。

多个 quota 对同一资源同时生效时，请求必须满足全部约束。删除对象后 used 更新存在控制器传播时间，脚本不应假设瞬时归零。

## 7. LimitRange 约束单个对象并可注入默认值

`defaulted-pod.yaml` 故意不写 resources。LimitRange admission 会为容器注入默认 request/limit，然后 ResourceQuota 再按最终资源需求计数：

```powershell
kubectl apply -f .\docker-kubernetes\code\16_namespace_labels\manifests\defaulted-pod.yaml
kubectl get pod defaulted-resources -n lab-dev -o jsonpath='{.spec.containers[0].resources}{"`n"}'
kubectl describe resourcequota namespace-budget -n lab-dev
```

这适合观察 admission 行为，不意味着生产应用应依赖管理员默认值。应用清单显式声明经过容量测试的 request/limit，代码审查才看得见其资源假设。

LimitRange 只在创建/更新准入时作用，不会回写已存在 Pod。修改默认值后，旧 Pod 与新 Pod 可能暂时有不同资源配置。

## 8. Pod Security Admission 借 Namespace label 选择策略

两个 namespace 都固定到 Kubernetes v1.35 的 `restricted` policy。故意提交 privileged Pod：

```powershell
kubectl apply --server-side --validate=strict `
  -f .\docker-kubernetes\code\16_namespace_labels\manifests\privileged-pod.yaml
```

预期 API Server 拒绝，因为 privileged 容器不符合 restricted profile。`enforce` 决定拒绝，`audit`/`warn` 分别产生审计标记或客户端警告；版本 label 防止集群升级时策略含义无意漂移。

Pod Security 只覆盖 Pod 安全上下文相关基线，不提供网络隔离、API 授权、镜像可信或秘密管理。它是多租户拼图的一块。

## 9. Namespace 不自动提供哪些隔离

- 网络：默认情况下，跨 namespace Pod 通常仍可互通；需要 CNI 实现 NetworkPolicy。
- API 权限：需要 Role/RoleBinding 或集群级 RBAC；默认 namespace 不等于授权范围。
- 节点资源：quota 控制 API 预算，但不同 namespace Pod 仍可能竞争同一节点。
- 集群级对象：Node、CRD、ClusterRole 等不属于某个 namespace。
- 强租户边界：共享 kernel、控制面和集群管理员仍是共同信任域。

检查当前身份而不做假设：

```powershell
kubectl auth can-i list pods -n lab-dev
kubectl auth can-i create pods -n lab-prod
kubectl auth can-i update namespaces
kubectl auth can-i --list -n lab-dev
```

## 10. Namespace 删除是异步级联操作

删除 Namespace 会触发其 namespaced 内容清理，Namespace 进入 Terminating。控制器、API discovery 或对象 finalizer 异常时可能长期卡住。不要把强行清空 finalizers 当日常清理命令，它可能遗留外部资源。

清理前先按 namespace 取证：

```powershell
kubectl get resourcequota,limitrange,pod,configmap -n lab-dev
kubectl get resourcequota,limitrange,pod,configmap -n lab-prod
kubectl delete namespace lab-dev lab-prod --wait=true --timeout=120s
kubectl config set-context --current --namespace=default
```

若删除超时，先查看 namespace conditions 与剩余资源：

```powershell
kubectl get namespace lab-dev -o yaml
kubectl api-resources --verbs=list --namespaced=true -o name
```

## 11. 验收

必须能解释：

- namespaced 与 cluster-scoped 对象的身份范围；
- Namespace 为什么不是自动网络/RBAC隔离墙；
- labels、annotations、name、UID 各适合表达什么；
- selector 动态成员变化为何会影响 Service/ReplicaSet；
- ResourceQuota 与 LimitRange 分别限制总量和单对象的哪一层；
- Pod Security namespace labels 能防什么、不能防什么。

官方依据：[Namespaces](https://kubernetes.io/docs/concepts/overview/working-with-objects/namespaces/)、[Labels and Selectors](https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/)、[Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/)、[Limit Ranges](https://kubernetes.io/docs/concepts/policy/limit-range/)、[Pod Security Admission](https://kubernetes.io/docs/concepts/security/pod-security-admission/)。

> 下一批进入第 17 课：ConfigMap 与 Secret 的注入、更新传播和安全边界。
