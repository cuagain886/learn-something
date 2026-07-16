# Kubernetes 网络：Pod 可达性、Service 虚拟入口与 EndpointSlice

Kubernetes 网络不是一个单独组件，而是多份状态与多段数据路径的组合：CNI 实现 Pod 网络，CoreDNS 提供名字发现，EndpointSlice 描述后端，Service proxy 实现虚拟入口，应用最终在容器端口监听。

## 1. Pod 网络模型

Kubernetes 期望每个 Pod 获得集群内地址，并能在不做应用侧 NAT 的抽象下与其他 Pod通信。具体 veth、bridge、overlay、路由或 eBPF 由网络实现决定，核心 API 不规定单一数据面。

同一 Pod 内容器共享网络 namespace 和端口空间；不同 Pod即使在同一节点也通过 Pod 网络地址通信。Pod 重建可获得新 IP，所以消费者不应把 Pod IP 当长期服务身份。

CNI 通常在 Pod sandbox 建立时配置接口、地址和路由。Pod 卡在 `ContainerCreating` 且 event 指向 sandbox/network setup 时，问题位于 Service 之前。

## 2. Service 是控制面声明，不是后端进程

带 selector 的 Service 建立如下控制链：

```text
Service selector + Pod labels/readiness
        ↓ EndpointSlice controller
EndpointSlice addresses/ports/conditions
        ↓ service proxy implementation watch
节点数据面规则或映射
        ↓
ClusterIP:port → selected PodIP:targetPort
```

Service ClusterIP 通常是虚拟地址，不对应某台固定主机上的用户态监听 socket。API Server 也不转发正常业务流量。

控制面对象创建成功与节点数据面编程完成之间存在传播窗口。极短时间的连接结果不能证明控制器永久错误。

## 3. EndpointSlice 是后端事实接口

EndpointSlice 按 Service、地址族、协议和端口等维度组织 endpoint，解决单个旧 Endpoints 对象的扩展和信息不足问题。旧 Endpoints API 已弃用，新工具应读取 `discovery.k8s.io/v1` EndpointSlice。

Endpoint condition 的三个维度：

- serving：endpoint 当前是否能提供服务；对 Pod后端通常映射 Ready。
- terminating：对应 Pod正在终止。
- ready：通常近似 serving 且非 terminating；`publishNotReadyAddresses` 会改变它的报告语义。

更新期间，消费者需要理解 terminating-but-serving 的边界。简单把 endpoint 数量等同 ready 副本数会遗漏条件与重复地址处理。

EndpointSlice 通常由控制面管理，有 Service ownerReference、`kubernetes.io/service-name` 和 managed-by label。不要手改 controller 管理的 slice；controller 会按源状态覆盖。

## 4. Selector 与 readiness 共同决定成员

Pod label 匹配只表示候选后端。默认情况下，未 Ready Pod不会作为正常可用 endpoint 接流量。由此形成：

```text
selector 错误 → 没有候选 Pod
readiness 失败 → 有候选 Pod但 endpoint 不可用
targetPort 错误 → endpoint 存在但连接到错误端口
应用没监听 → 网络可达但 TCP/应用失败
```

这四种现象可能都表现为“访问 Service 失败”，但修复位置完全不同。

## 5. Named targetPort 是接口契约

Service `port` 是消费者看到的端口；`targetPort` 是后端端口；Pod `containerPort` 主要提供命名和元数据，不会让未监听的进程自动监听。

使用 named targetPort 能让 Service 依赖逻辑端口名。不同 template 可把同名端口映射到不同数字，EndpointSlice controller 解析成实际 endpoint port。这给滚动迁移端口提供空间，但名称拼错会造成端点端口问题。

## 6. DNS 控制路径与请求数据路径

CoreDNS watch Service 等对象并回答 DNS。普通 ClusterIP Service 常得到：

```text
service.namespace.svc.cluster.local → ClusterIP
```

Pod `/etc/resolv.conf` 中的 search suffix 让同 namespace 可用短名。跨 namespace 短名会优先在调用方 namespace 搜索，因此应使用 namespace-qualified 名称。

DNS 查询只发生在连接前的名字解析阶段。DNS 成功不表示 EndpointSlice 非空；DNS 失败也不应先修改 Service selector。应用和语言 runtime 还可能缓存 DNS，TTL 与连接池会影响后端变化感知。

Headless Service 没有普通 ClusterIP，DNS 可直接返回后端地址。客户端因此承担 endpoint 选择、重试、缓存刷新和失效处理，适合协议明确需要成员发现的场景。

## 7. Service proxy、连接跟踪与负载分配

默认 kube-proxy 可使用平台支持的数据面模式；其他网络方案可能替代它。实现通常按连接而非每个 HTTP 请求选择后端，并依赖 conntrack。因此：

- HTTP keep-alive 上的多个请求常固定到同一 endpoint；
- endpoint 被移除后，已有连接与新连接行为可能不同；
- 重复 curl 看到分布不均不能直接证明规则错误；
- `sessionAffinity: ClientIP` 会进一步影响选择。

Service 是基本流量分发，不自动提供七层重试、熔断、请求级权重或一致性哈希。

## 8. 源地址与 NAT 边界

ClusterIP、NodePort、LoadBalancer 的数据路径可能发生 DNAT/SNAT，源 IP 是否保留取决于流量入口、策略和实现。应用若把源 IP 用作鉴权或审计，必须验证完整链路，不能假设 socket peer 就是最终用户。

NodePort 是在 ClusterIP 语义上增加节点端口；LoadBalancer 还需要外部实现把流量送进集群。YAML 中出现 external address 不代表云或裸机网络已经完成路由与防火墙配置。

## 9. NetworkPolicy 是另一条控制链

Service selector 选择“流量去哪里”，NetworkPolicy 约束“哪些流量允许”。创建 NetworkPolicy API 对象是否真正生效取决于 CNI 是否实现策略。

默认没有隔离策略时，namespace 通常不是网络边界。引入 default-deny 后还要明确允许 DNS、监控、入口和必要跨 namespace 通信，否则常出现 DNS timeout 被误诊为 Service 故障。

## 10. 分层排障

```text
Pod sandbox/IP/路由
→ 应用监听地址与端口
→ Pod Ready
→ Service selector/port/targetPort
→ EndpointSlice address/port/conditions
→ 集群内直连 PodIP 与访问 ClusterIP 对比
→ DNS 查询与 search suffix
→ service proxy / CNI / NetworkPolicy
→ 外部入口与防火墙
```

从集群内临时 client 测试能排除宿主到集群网络的差异。`kubectl port-forward` 走调试隧道，绕过部分正常数据面，只能作为对照实验。

实验入口：[15 Service 与服务发现](../code/15_service_discovery/README.md)。
