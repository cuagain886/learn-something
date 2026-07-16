# 工作负载控制器：所有权图、集合收敛与修订

Kubernetes controller 的价值不只是“故障后再建一个 Pod”，而是把业务期望拆成多个可独立收敛的不变量。Deployment、ReplicaSet 和 kubelet分别操作不同对象与状态，形成松耦合的恢复链。

## 1. 从单对象状态机到对象集合

kubelet关注单个已绑定 Pod 内的容器是否运行；ReplicaSet 关注一组匹配 Pod 的数量；Deployment 关注新旧 ReplicaSet 如何代表不同 Pod template。三层不变量是：

```text
kubelet: 已绑定本节点的 PodSpec → 容器实例状态
ReplicaSet: selector 所定义的 Pod 集合 → 目标副本数
Deployment: 当前 Pod template → 对应 ReplicaSet 的推进与可用性
```

所以“重启”必须说明层级：容器 restart 保留 Pod UID；ReplicaSet 补建产生新 Pod UID；Deployment rollout 还会产生新 ReplicaSet。

## 2. Selector 是控制器的集合定义

ReplicaSet 不按 Pod 名称前缀统计，而按 label selector 找候选对象，再结合 ownerReferences 判断管理关系。selector 重叠会让多个控制器对同一集合提出冲突目标，因此不是命名风格问题，而是控制正确性问题。

孤立且 selector 匹配的 Pod 可能被 ReplicaSet 收养。这个能力支持恢复和迁移，也意味着手工创建“看起来只是同标签”的 Pod 可能改变控制器计数。生产排障时先检查 ownerReferences，再决定是否改 label。

Deployment selector 在 `apps/v1` 创建后不可变，且必须匹配 template labels。否则它可能创建出自己无法管理的对象。Template 可以有 selector 之外的附加 label，用于版本、流量轨道和可观测维度。

## 3. OwnerReferences 与垃圾回收

ownerReferences 记录 owner UID，而不只记录名字，因此同名重建的 owner 不会意外拥有旧依赖。`controller: true` 标识管理该对象的控制器 owner；`blockOwnerDeletion` 与权限、传播策略共同影响删除。

常见删除传播：

- Foreground：owner 保持 terminating，先删除可阻塞的 dependents。
- Background：API 先删除 owner，垃圾回收异步清依赖，常为默认行为。
- Orphan：保留 dependents 并移除所有权关系。

不要只用名称通配符模拟级联删除；那会绕开 UID 所有权图并可能误删无关对象。

## 4. ReplicaSet 的收敛不是简单 for 循环

概念差值是 desired minus current，但 current 不是 `kubectl get pod | Measure-Object`：控制器还要处理 active、terminating、failed Pod，并使用 expectations 避免 informer 尚未观察到刚创建对象时重复创建。

控制器基于 list/watch 的本地缓存行动，因此短时间内看到 spec、status 和实际对象数量不一致是正常的最终一致窗口。异常判断应结合持续时间、Events、controller conditions 和 generation，而不是单个瞬时截图。

缩容时选择删除哪个 Pod也有策略；不能依赖名称排序预测幸存者。若业务要求特定实例顺序或稳定身份，应选择 StatefulSet 等更匹配的控制器。

## 5. Pod template 是修订边界

Deployment 仅在 `.spec.template` 改变时形成新 revision。修改 replicas 不改变未来 Pod 的结构，所以不需要新 ReplicaSet；修改镜像、环境变量、template label、probe 或 resources 都会改变 template。

Deployment controller 生成 `pod-template-hash`，把同一 template 的 ReplicaSet/Pod归到同一集合，同时避免新旧 ReplicaSet selector 冲突。哈希值是实现生成的身份辅助，不应由用户预测或修改。

Revision history 保存旧 ReplicaSet 的 template 以支持回滚。它不是应用数据库回滚，也不会逆转外部副作用、ConfigMap 当前内容或 schema migration。

## 6. RollingUpdate 是两个副本集合之间的预算

假设期望副本数为 N：

- `maxSurge` 限制更新期间总 Pod 可超过 N 多少；
- `maxUnavailable` 限制更新期间可少于期望可用数多少；
- readiness 与 `minReadySeconds` 决定新 Pod何时计入 available。

`maxUnavailable: 0` 并不保证零错误：终止端点传播、连接排空、应用内部错误和节点故障仍可能造成失败。它只约束 Deployment 计数模型。

百分比会按 API 规定取整，且实际过程中还受 terminating Pod、调度容量、镜像拉取和 resource quota 影响。若 maxSurge 需要额外容量但集群没有，rollout 会停滞而非突破资源约束。

## 7. Conditions 是控制器判断，不是端到端 SLO

Deployment status 的 replicas、updatedReplicas、readyReplicas、availableReplicas描述不同集合。Conditions 常见：

- Progressing：新 ReplicaSet 创建或副本推进；长时间无进展可能触发 progress deadline exceeded。
- Available：满足 Deployment 定义下的最低可用要求。

控制器报告 `observedGeneration` 表示已处理到哪一代 spec。客户端等待发布时，应至少确认 observed generation、updated replicas、available replicas 和 conditions，而不是看到 apply 成功就结束。

Deployment controller 记录进度超时，但不会自动把坏版本回滚成好版本；发布系统需要明确判断与回滚策略。

## 8. 自愈的边界

自愈能修复“副本对象缺少”或“容器进程退出”等已编码状态差异，不能判断：

- 返回了错误业务数据但 probe 仍为 200；
- 所有副本共同依赖同一个故障数据库；
- 新版本逻辑错误但进程健康；
- 数据迁移是否可逆；
- 容量是否足以创建替代 Pod。

控制器只会忠实收敛声明。错误的期望状态也会被可靠地放大，因此变更验证、渐进发布与 SLO 观测属于同一系统设计。

## 9. 删除、驱逐与节点故障的区别

用户删除 Pod 会设置删除流程；驱逐是基于策略请求删除 Pod；节点永久丢失时控制面依据心跳和容忍时间处理对象。对 ReplicaSet 而言，最终结果可能都是集合副本不足，但时序、终止保证和 Events 不同。

旧节点网络隔离时，控制面创建新 Pod不意味着旧进程已物理停止。有状态系统需要租约、fencing 或一致性协议，不能把 ReplicaSet 副本数当作全局唯一执行保证。

## 10. 证据式排障顺序

```text
Deployment generation/conditions
→ 新旧 ReplicaSet desired/current/ready
→ ownerReferences 与 selector
→ Pod Scheduled/Ready/container state
→ Events、previous logs、节点资源
```

若新 ReplicaSet 为 0，先看 Deployment 策略和控制器；若 desired 已增加但 Pod Pending，看调度；若 Running 不 Ready，看 probe/应用。按层定位比反复 rollout restart 更能保留根因。

实验入口：[14 Deployment 与 ReplicaSet](../code/14_deployment_replicaset/README.md)。
