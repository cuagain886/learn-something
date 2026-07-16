# Kubernetes 架构：控制回路、节点代理与持久状态

Kubernetes 的核心不是“远程执行一批容器命令”，而是把期望状态写入 API，再由多个相互解耦的控制回路逐步逼近它。理解这一点，才能解释为何一次 `kubectl apply` 后会出现调度、拉镜像、启动和就绪等多个阶段。

## 1. 两条路径：控制面与数据面

```text
用户/自动化 ──HTTPS──> kube-apiserver ──> etcd
                         ↑       │
                watch/list       │ bind/status
                         │       ↓
              controller / scheduler

kube-apiserver <──节点状态── kubelet ──CRI──> containerd ──> 容器进程
                              │
                              └── CNI/CSI 等节点侧能力
```

控制面决定“系统应该怎样变化”，节点侧把已分配到本节点的 Pod 变成进程、网络和挂载。两者通过 API 对象通信，而不是 scheduler 直接连接节点启动容器。

## 2. API Server 是唯一一致入口

`kube-apiserver` 负责 HTTP API、认证、授权、准入、默认值、校验、版本转换和持久化入口。kubectl、controller、scheduler、kubelet本质上都是 API 客户端。

这带来三个重要结论：

1. `kubectl` 不是集群状态本身。换一个客户端，只要身份和请求等价，语义不变。
2. 组件协作通过对象与 watch 解耦。scheduler 不需要知道 kubelet的进程实现。
3. 审计、权限与准入可以集中在 API 边界，而不是散落到每个控制器。

API Server 可以水平扩展，但请求最终必须围绕同一份持久状态协调。读取缓存、watch cache 和客户端本地缓存会改善性能，却不能把“刚才在终端看到的值”误当成永不变化的事实。

## 3. etcd 保存什么，不保存什么

etcd 是一致的键值存储，保存 Kubernetes API 对象的持久状态。它不负责：

- 调度 Pod；
- 运行容器；
- 保存容器镜像层；
- 充当应用数据库。

控制面灾难恢复的关键是 etcd 数据和加密配置，而不是复制某个 worker 的容器目录。生产环境要考虑奇数成员、跨故障域、定期快照、恢复演练和磁盘延迟；“有三个成员”不等于做过恢复验证。

## 4. Scheduler 只做放置决策

对尚未绑定节点的 Pod，scheduler 通常经历：

1. Filter：排除资源不足、约束不满足、污点不可容忍等节点。
2. Score：按资源、亲和性、拓扑分布等策略给可行节点排序。
3. Bind：把选择结果写回 API，使 Pod 的 `spec.nodeName` 确定。

它不会拉镜像、创建容器，也不持续“照看”已运行进程。Pod 绑定后启动失败，应沿 kubelet、runtime、镜像和应用方向排查；一直未绑定才优先看 scheduler Events 与约束。

## 5. Controller 是可重复的差异收敛

控制器大体执行同一种循环：

```text
观察实际状态 → 计算与期望状态的差异 → 执行有限动作 → 再观察
```

Deployment controller 不亲自启动容器，而是维护 ReplicaSet；ReplicaSet controller 再维护 Pod 数量。对象的 `ownerReferences` 形成所有权图，垃圾回收和级联删除据此工作。

可靠控制回路需要：

- 幂等：重复执行不会不断制造副作用；
- level-triggered：基于当前状态收敛，而非假设每个事件只消费一次；
- 最终一致：允许短暂差异，但持续重试；
- 有界动作：一次只做可以确认结果的变更。

因此控制器崩溃并重启通常不会丢失“任务队列真相”：真相仍在 API 当前状态中，它可以重新 list/watch 并继续收敛。

## 6. Kubelet 是节点上的 Pod 执行代理

kubelet观察已经分配到本节点的 PodSpec，并通过 CRI 调用 container runtime。它还负责 probe、容器重启、volume 挂载协作以及 Pod/节点状态上报。

边界要说准确：

- kubelet不会替 Deployment 保证副本数；
- runtime 负责容器生命周期底层操作，但不理解 Deployment；
- 应用收到 TERM 后如何排空，是应用责任；
- 节点失联时，控制面只能依据最后心跳与超时策略推断，不能瞬间知道进程真实状态。

控制面组件常以 static Pod 运行。static Pod 清单由节点 kubelet直接管理，API 中可见的 mirror Pod 是映射，不是通常 controller 创建的 Pod。这解释了为什么控制面暂时不可用时，kubelet仍可能维持这些本地组件。

## 7. 从 apply 到 Ready 的因果链

创建一个 Deployment 后，至少有如下异步步骤：

1. API Server 接收并持久化 Deployment。
2. Deployment controller 创建或更新 ReplicaSet。
3. ReplicaSet controller 创建 Pod。
4. Scheduler 为未绑定 Pod 选择节点并写入绑定结果。
5. 目标节点 kubelet观察到 PodSpec，准备 sandbox、网络、挂载和容器。
6. runtime 拉取/解包镜像并启动进程。
7. kubelet执行 probe，更新 container status 与 Pod conditions。
8. 服务发现相关控制器根据 Ready 状态更新流量端点。

任一步都可能暂时失败并重试。排障的价值在于定位链条断在哪一段，而不是重复 apply 掩盖现场。

## 8. List/Watch 与 resourceVersion

控制器通常先 list 建立本地视图，再从某个 `resourceVersion` watch 增量变化。watch 不是永久可靠的消息队列：连接会断、历史版本会压缩，客户端必须能重新 list。

`resourceVersion` 表示存储层并发版本，不是业务版本号，也不保证跨对象构成数据库事务。更新冲突意味着“你基于旧对象写入”，正确做法是重新读取、重算，而不是盲目覆盖。

## 9. 可用性边界

控制面不可用与现有业务容器立即停止不是同一件事：节点上已经运行的容器可能继续运行。但新的调度、对象变更、控制器修复和部分凭据轮换会受阻。

同样，一个 kind 单控制面集群适合学习组件边界，不代表生产高可用：控制面节点、etcd、入口负载均衡、升级与备份恢复都需要独立设计。

## 10. 用证据定位责任组件

| 现象 | 第一证据 | 主要责任边界 |
|---|---|---|
| kubectl 无法连接 | kubeconfig、API 地址、证书、API Server 日志 | 客户端/API 入口 |
| Pod 无 `nodeName` | `FailedScheduling` event、requests、taint/affinity | scheduler |
| 已绑定但拉镜像失败 | Pod Events、kubelet/runtime 日志、镜像引用 | 节点执行链 |
| 容器反复退出 | `lastState`、exit code、`logs --previous` | 应用/runtime/kubelet策略 |
| 副本数长期不符 | Deployment/ReplicaSet conditions 与 controller 日志 | 控制回路 |
| Ready 为 false | probe 结果、应用依赖、容器状态 | 应用与 kubelet probe |

实验入口：[11 集群架构](../code/11_cluster_architecture/README.md) 与 [13 Pod 生命周期](../code/13_pod_lifecycle/README.md)。
