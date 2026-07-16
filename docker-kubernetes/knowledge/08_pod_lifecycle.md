# Pod 生命周期：身份、状态机、重启与优雅终止

Pod 是 Kubernetes 可调度的最小单元，也是一个或多个容器共享网络与部分存储的执行边界。它不是永久机器：Pod 一旦被替换，即使名称相似，UID、网络身份和容器实例都可能改变。

## 1. Pod sandbox 与共享边界

同一 Pod 的容器通常共享：

- 一个网络命名空间：同一 Pod IP、端口空间，通过 localhost 通信；
- Pod 级 volume：是否挂载到某容器由各自 volumeMount 决定；
- 调度与生命周期位置：一起放到同一节点。

它们不自动共享根文件系统，也不应靠修改另一个容器的镜像层协作。紧耦合辅助进程适合 sidecar；独立扩缩、独立故障域的服务应拆成不同 Pod。

## 2. Phase 只有粗粒度摘要

Pod `status.phase` 的典型值：

- Pending：API 已接受，但至少一个容器尚未完成启动准备，包括等待调度或拉镜像。
- Running：Pod 已绑定节点，至少一个容器正在运行/启动/重启；不代表 Ready。
- Succeeded：所有容器成功终止且不会重启。
- Failed：所有容器已终止，至少一个失败或被系统终止，且不会重启。
- Unknown：节点通信等原因使状态无法取得。

kubectl `STATUS` 列是面向人的综合展示，可能出现 `Terminating`、`CrashLoopBackOff`、`ImagePullBackOff`；这些并非新增 phase。自动化应读取结构化字段，不解析表格字符串。

## 3. Conditions 描述正交事实

常见 Pod conditions 包括 `PodScheduled`、`Initialized`、`ContainersReady`、`Ready`。condition 带 status、reason、message、lastTransitionTime，可回答“哪一个门槛尚未满足”。

自定义 readiness gates 可把外部系统条件纳入 Pod Ready 判定。如果对应 condition 尚未被 controller 写为 True，它默认为 False。这样可以阻止“进程健康但负载均衡器注册尚未完成”的实例提前接流量。

## 4. 容器 state 与 lastState

每个 `containerStatuses` 包含：

- `state.waiting`：尚未运行，reason 可能是镜像或配置问题；
- `state.running`：有 startedAt；
- `state.terminated`：有 exitCode、reason、signal、startedAt、finishedAt；
- `lastState`：前一个实例的终止证据；
- `restartCount`、`ready`、`containerID`、`imageID`。

排查重启应把 `lastState.terminated` 与 `kubectl logs --previous` 配对。当前日志属于当前容器实例，可能完全没有上一实例崩溃前的信息。

## 5. Restart policy 与控制器替换是两层机制

Pod 级 `restartPolicy` 取 `Always`、`OnFailure`、`Never`，由节点 kubelet决定同一 Pod 中容器退出后的行为。容器重启时：Pod UID 与调度节点不变，容器 ID 改变，restartCount 增加。

Deployment/ReplicaSet 保持 Pod 副本数则是控制面行为。Pod 被删除或节点被判定不可用时，控制器可能创建一个新 UID 的 Pod。新 Pod 不是旧 Pod “迁移过去”。

`CrashLoopBackOff` 表示 kubelet对连续失败采用指数退避，避免节点被高速重启循环压垮。根因仍是退出码、信号、OOM、配置、依赖或 probe 失败。

## 6. 三类 probe 的控制效果

startup probe 成功之前，liveness 和 readiness 不执行，适合保护慢启动应用。达到 failure threshold 仍失败则按 liveness 类机制处理容器。

readiness 失败会使 Ready=False，流量端点控制器据此把 Pod 从服务端点移除；容器通常继续运行。这适合暂时过载、缓存预热或依赖未就绪。

liveness 失败触发容器重启，只适合检测“重启才可能修复”的失活。把下游数据库健康放进 liveness，会在数据库故障时同时重启所有正常应用实例，放大事故。

阈值应按公式估算而非复制模板：

```text
判定失败时间约为 initialDelay + failureThreshold × period
```

还需考虑 timeout、startup probe 是否屏蔽其他 probe，以及最坏情况下应用正常响应延迟。

## 7. 资源 request、limit 与 QoS

request 是调度和资源份额的重要输入；limit 是运行时约束。CPU limit 常表现为 throttling，内存 limit 超出可能导致容器 OOMKilled。应用自己的堆限制、缓存行为必须与容器 limit 协调，否则“节点仍有空闲内存”也不能阻止 cgroup 内 OOM。

Pod QoS 大致由 requests/limits 组合决定：Guaranteed、Burstable、BestEffort。节点资源压力下，QoS、使用量相对 request、优先级等共同影响驱逐顺序；QoS 不是绝对不被驱逐承诺。

调度成功只说明 requests 在当时满足约束，不说明运行期一定无资源竞争，也不说明 limit 足够。

## 8. 终止不是一个瞬时动作

正常删除时，宽限期倒计时先开始。若配置 `preStop`，hook 在容器 TERM 之前执行，但消耗同一个 `terminationGracePeriodSeconds` 预算。随后 runtime 向容器主进程发送终止信号；预算耗尽仍未退出则强制杀死。

应用必须做到：

1. 主进程正确接收信号，避免 shell 包装层吞掉 TERM；
2. 先停止接收新请求，再等待在途请求；
3. 排空上限小于 Pod 总宽限期；
4. 退出路径幂等，因为 hook/网络/节点故障可能使理想顺序无法保证。

流量摘除与进程终止存在分布式传播窗口。仅依赖固定 sleep 的 preStop 会把偶然延迟伪装成策略；更好的设计结合 readiness、入口负载均衡行为、连接排空与足够宽限期。

## 9. Init container、sidecar 与生命周期顺序

普通 init containers 按顺序成功完成后，应用容器才启动。它们适合有限的初始化工作，但不应无限等待外部依赖，否则 Pod 永久卡在初始化阶段。

sidecar 与主容器共享 Pod 命运，但仍是独立进程和容器状态。日志代理、代理网关等 sidecar 的启动/终止顺序必须纳入总宽限期，不能假设主进程退出后数据必然全部上传。

## 10. 节点故障与终止的不确定性

优雅终止依赖 kubelet与 runtime 仍可工作。节点突然断电或网络隔离时，控制面无法保证 preStop 与 TERM 执行。应用一致性不能建立在“终止 hook 必定运行”上。

对有状态系统，应使用幂等写、租约/栅栏令牌、复制协议和恢复日志等机制处理旧实例可能暂时存活、新实例已被创建的边界。

## 11. 一条可复用的排障顺序

```text
对象存在吗
  → 已调度吗（nodeName / FailedScheduling）
  → sandbox、网络、volume 准备了吗（Events）
  → 镜像可取且架构匹配吗
  → 进程启动了吗（state / exitCode / previous logs）
  → startup/liveness 是否让它重启
  → readiness 为什么未通过
  → 上层 Service/Ingress 是否选择到它
```

每一步先取证再修改。重复删除 Pod 可能暂时恢复服务，却也会销毁 lastState、上一实例日志与节点现场。

实验入口：[13 Pod 生命周期](../code/13_pod_lifecycle/README.md)。
