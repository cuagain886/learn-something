# 12 · 声明式 API：对象身份、版本、字段所有权与并发

> YAML 只是序列化输入。真正的 Kubernetes 能力来自 API object、控制循环、watch、版本转换和多个写入者之间的字段协作。

## 1. 一次写请求的服务端路径

```text
decode → authentication → authorization → mutating admission/defaulting
→ schema validation → validating admission → version conversion/storage → etcd
→ watch events → controllers/kubelets/clients
```

认证回答“你是谁”，授权回答“能做什么”，准入回答“即使有权限是否允许/如何修改”，schema 校验回答“对象是否合法”。它们不是同一个 403/400 问题。

创建实验 namespace：

```powershell
kubectl apply --server-side --field-manager=course-bootstrap -f namespace.yaml
kubectl auth can-i create deployments -n dk-course
```

---

## 2. GVK、GVR 与对象身份

manifest 中 `apiVersion + kind` 是 GVK；REST 访问通常使用 group/version/resource，例如：

```text
GVK: apps/v1, Kind=Deployment
GVR: apps/v1, Resource=deployments
URL: /apis/apps/v1/namespaces/dk-course/deployments/api-object-demo
```

对象名称只在 group/resource/namespace 作用域唯一；同名对象删除重建会获得新 UID。UID 区分“历史上两个同名实例”。API version 不是名称作用域的一部分。

```powershell
kubectl api-resources | Select-String Deployment
kubectl explain deployment --api-version=apps/v1
kubectl get --raw /apis/apps/v1 | ConvertFrom-Json
```

---

## 3. spec、status 与 metadata 版本字段

```powershell
kubectl apply --server-side --field-manager=course-manager-a -f deployment-manager-a.yaml
kubectl get deploy api-object-demo -n dk-course -o yaml
```

本 Deployment `replicas: 0`，用于观察 API 而不创建工作负载。

- spec：调用者声明的期望状态。
- status：controller 报告的观测状态；不要在普通 spec apply 中伪造。
- generation：期望状态发生有意义变化时递增；controller 常用 observedGeneration 表示已处理到哪一代。
- resourceVersion：etcd/API 并发与 watch 版本，不是时间戳，也不应做数值业务比较。
- UID：对象实例身份，删除重建变化。
- managedFields：服务端记录字段管理者，不应手改。

```powershell
$d = kubectl get deploy api-object-demo -n dk-course -o json | ConvertFrom-Json
$d.metadata | Select-Object uid,generation,resourceVersion,managedFields
$d.status | Format-List
```

---

## 4. Server-Side Apply 是字段协作协议

manager A 已声明 `track: stable`。manager B 尝试改成 canary：

```powershell
kubectl apply --server-side --field-manager=course-manager-b -f deployment-manager-b.yaml
```

预期 conflict：B 正在改变 A 拥有且值不同的字段。三个正确选择：

1. B 不关心该字段：从自己的 manifest 删除它并 apply，放弃声明。
2. 与 A 协调，由 A 修改。
3. B 被授权接管：审阅 diff 后使用 `--force-conflicts`，字段所有权转移。

```powershell
kubectl diff --server-side --field-manager=course-manager-b -f deployment-manager-b.yaml
kubectl apply --server-side --field-manager=course-manager-b --force-conflicts -f deployment-manager-b.yaml
kubectl get deploy api-object-demo -n dk-course -o json --show-managed-fields
```

`force` 不是“忽略错误”，而是明确改变协作所有权，自动化控制器使用时必须谨慎。

---

## 5. validation、defaulting 与 live object

```powershell
kubectl apply --server-side --validate=strict -f invalid-field.yaml
```

预期服务端拒绝未知 `replicaz`。不要用 `--validate=false` 让拼写错误静默消失。

提交的 YAML 与 live object 不完全相同：API Server/准入可能填默认值、规范化字段，controller 更新 status，其他 manager 管理其他字段。因此：

```powershell
kubectl diff --server-side -f deployment-manager-a.yaml
kubectl get deploy api-object-demo -n dk-course -o yaml
```

Git manifest 是某个管理者的意图，不是 etcd 对象字节的完整镜像。

---

## 6. watch 与乐观并发

list 返回当前集合和 resourceVersion；watch 从某版本接收变化流。客户端必须处理断线、过期版本、重新 list，而不是假设 watch 永不结束。

PUT/条件更新可利用 resourceVersion 防止 lost update：读对象 → 修改 → 带原版本写回；若期间被他人更新，服务端返回 conflict，客户端重新读取和决策。盲目重试覆盖会丢失他人修改。

---

## 7. 验收与清理

- [ ] 能区分 GVK/GVR、name/UID、generation/resourceVersion。
- [ ] 能解释 API request pipeline 的四类安全/校验阶段。
- [ ] 能制造并正确解释 SSA field conflict。
- [ ] 能说明 manifest、live object 和 status 为什么不同。

```powershell
kubectl delete namespace dk-course --wait=true
```

官方依据：[API Concepts](https://kubernetes.io/docs/reference/using-api/api-concepts)、[Objects](https://kubernetes.io/docs/concepts/overview/working-with-objects/)、[Server-Side Apply](https://kubernetes.io/docs/reference/using-api/server-side-apply/)。

> 下一课：[13 Pod 生命周期](../13_pod_lifecycle/README.md)。
