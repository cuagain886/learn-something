# Namespace 与元数据治理：作用域、动态集合和准入预算

Namespace、labels、annotations 看似只是对象元数据，却决定 API 身份范围、控制器成员关系和策略选择。治理设计的目标不是给资源“分文件夹”，而是让权限、预算、安全基线和运维查询具有稳定边界。

## 1. 对象身份包含作用域

namespaced 资源通常由 group/resource、namespace、name 标识 API 路径；UID 标识具体历史实例。同名 Deployment 可以存在于 dev/prod，但它们没有继承或关联关系。

cluster-scoped 对象没有 namespace。把 `metadata.namespace` 写进 Node、Namespace、StorageClass 等对象不会获得想象中的隔离，服务器会按 schema 拒绝或忽略不合法输入。

Namespace 本身不能嵌套。如果组织层级需要“事业部/团队/项目/环境”，通常组合 namespace 命名、labels、外部目录和策略工具，而不是尝试构建 namespace 树。

## 2. Namespace 是策略汇聚点，不是完整租户

许多能力以 namespace 为范围：

- RoleBinding 授予 namespaced API 权限；
- ResourceQuota 统计总预算；
- LimitRange 校验/默认化单对象资源；
- Pod Security Admission 通过 Namespace labels 选择 profile；
- NetworkPolicy 在 namespace 中选择 Pod与对端。

但只创建 Namespace 不会自动启用这些能力。强多租户还要考虑集群管理员、共享节点 kernel、CRD/cluster-scoped 权限、存储和网络实现，必要时使用独立集群形成更强故障/信任边界。

## 3. Label 是低基数动态索引

Label 适合被 selector、查询和聚合使用的稳定属性。selector 支持 equality 与 set requirement，多个 requirement 是 AND，没有任意布尔 OR。

Label 值可变，因此集合成员是动态的：

- 改 Pod label 可让它离开 Service endpoints；
- 改 selector label 可让 ReplicaSet补建副本，旧 Pod可能变孤儿；
- 改 Namespace label 可改变 Pod Security 或 NetworkPolicy namespaceSelector 结果。

最后一种尤其敏感：若普通团队能修改被安全策略信任的 Namespace label，就可能改变边界。受信任 label key 的写权限必须受控，必要时由准入策略验证。

避免把 request ID、时间戳、完整 URL 等高基数值做 label；它们增加索引和监控基数，且通常无需选择。

## 4. 推荐应用标签是多维模型

`app.kubernetes.io/name`、instance、component、part-of、managed-by 分别表达通用名称、安装实例、架构角色、上层系统和管理者。它们应在 Deployment、Pod template、Service、ConfigMap 等相关对象上保持一致维度。

Service selector 应只包含决定流量成员所需的稳定键。把 `version` 放入 selector 意味着旧新版无法同时被一个 Service 选中，可能破坏滚动更新；需要金丝雀流量时应显式设计多个 Service 或流量层。

## 5. Annotation 是扩展记录，不是可信秘密

Annotation 适合 controller 配置、校验和、外部资源 ID、联系人和 runbook URL。它不被 label selector索引，大小也仍受对象总大小限制。

Annotation 只是 API 数据：能读取对象的主体通常能读取它，etcd 备份、审计和诊断工具也可能携带它。令牌、密码、私钥不应因“不在 spec”就放进 annotation。

Controller 专用 annotation key 应带 DNS prefix 并定义版本/所有权，避免多个工具写同一键却赋予不同语义。

## 6. ResourceQuota：总量准入而非运行时调度器

ResourceQuota 可限制 requests/limits 总和、对象数量以及特定 scope。准入插件在创建/更新时检查请求是否使 hard 超标，quota controller 异步维护 used 状态。

它不保证 namespace 获得对应物理资源，也不按使用率实时分配 CPU。两个 namespace 都在 quota 内仍可能竞争同一节点；scheduler 依然按 Pod requests 和节点约束判断。

若 quota 追踪 CPU/memory request/limit，而 Pod 未声明相应字段，请求可能被拒绝。可用 LimitRange 注入默认值，但生产清单显式声明通常更易审计。

## 7. LimitRange：单对象边界与默认化

LimitRange 可对 Container/Pod/PVC 等设置 min、max、default 和 defaultRequest。它在 admission 时作用：

```text
提交未写 resources 的 Pod
→ LimitRange 注入 defaults
→ ResourceQuota 按最终值计数
→ scheduler 使用最终 requests
```

LimitRange 更新不会重写已存在 Pod，所以策略变更会产生新旧对象配置差异。要统一必须通过工作负载 rollout 创建新 Pod。

默认 request 过大会导致意外 Pending，过小会造成节点过度承诺；默认 limit 过小可能引起 OOM/throttling。默认值是防线，不代替容量测试。

## 8. Pod Security Admission 的版本化策略

Namespace label 可为 enforce、audit、warn 分别选择 privileged/baseline/restricted profile，并用 version label 固定策略版本。固定版本让集群升级不会静默改变准入含义；升级时应先 audit/warn 新版本，再调整工作负载和 enforce。

Restricted profile 约束 privileged、capabilities、非 root、seccomp 等 Pod字段，但不验证镜像漏洞、不加密 Secret、不创建 NetworkPolicy，也不限制 Kubernetes API 权限。

豁免通常是集群级高权限配置，应该最小化并审计；不要为了一个不兼容工作负载把整个大 namespace 降级。

## 9. RBAC 与 Namespace 的关系

Role 定义 namespaced 权限规则；RoleBinding 在某 namespace 绑定 subject，也可以引用 ClusterRole 以复用规则，但授权结果仍限该 RoleBinding 的 namespace。ClusterRoleBinding 则可能授予全集群范围，风险显著不同。

`kubectl auth can-i` 是当前凭据的授权检查，不是资源存在性检查，也不能证明应用运行时使用的 ServiceAccount 权限相同。应以 `--as`/对应身份或在 Pod 内实际凭据进行受控验证。

禁止读取 Secret 但允许创建 Pod并不一定安全：主体可能创建挂载目标 Secret 的 Pod间接读取。RBAC 威胁建模必须考虑可组合权限。

## 10. 删除 Namespace 的级联与 finalizer

Namespace 删除会触发 discovery 并清理其中资源，等待 finalization 后才消失。APIService 不可用、残留 CR、外部 controller失效或 finalizer 无法完成都可能让它卡在 Terminating。

直接清空 Namespace finalizers 可能让 API 对象消失而外部云资源、存储或自定义系统记录残留。正确顺序是读取 namespace conditions，恢复对应 API/controller，识别具体 finalizer owner，完成或补偿清理，最后才考虑受控强制措施。

## 11. 一套可持续治理规则

1. namespace 命名表达稳定租户/环境边界，不用于区分每个小版本。
2. 自动化清单显式 namespace；kubectl context 默认值只服务交互便利。
3. 建立受控 label taxonomy，区分流量 selector、组织查询和安全信任键。
4. 每个 namespace 同时设计 RBAC、quota、LimitRange、Pod Security 和网络策略。
5. 对 policy 变更使用 audit/warn、server-side dry-run 和小范围 rollout。
6. 监控 quota 使用、准入拒绝、namespace terminating 与高基数标签。

实验入口：[16 Namespace 与标签治理](../code/16_namespace_labels/README.md)。
