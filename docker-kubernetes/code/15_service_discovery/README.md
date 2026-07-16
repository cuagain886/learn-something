# 15 · Service、EndpointSlice 与 DNS：稳定入口的数据路径

Pod IP 和 Pod UID 都会随重建变化。Service 的作用不是“保住 Pod IP”，而是提供稳定的虚拟入口，并由 EndpointSlice 持续描述当前可接收流量的后端集合。本课从 DNS 查询一直追踪到具体 Pod。

## 1. 准备后端和客户端

先完成第 14 课的镜像加载，再从仓库根目录执行：

```powershell
kubectl apply -f .\docker-kubernetes\code\12_declarative_api\namespace.yaml
kubectl apply -f .\docker-kubernetes\code\14_deployment_replicaset\manifests\deployment.yaml
kubectl apply -f .\docker-kubernetes\code\15_service_discovery\manifests\service.yaml
kubectl apply -f .\docker-kubernetes\code\15_service_discovery\manifests\headless-service.yaml
kubectl apply -f .\docker-kubernetes\code\15_service_discovery\manifests\client.yaml
kubectl wait deployment/lifecycle-api -n dk-course --for=condition=Available --timeout=120s
kubectl wait pod/network-client -n dk-course --for=condition=Ready --timeout=120s
```

若 client 出现 `ImagePullBackOff`，先检查公网镜像访问或把 `alpine:3.22` 预拉取并 `kind load docker-image`。这与后端 Service 故障不是一层问题。

## 2. Service、EndpointSlice、Pod 是三种对象

```powershell
kubectl get service lifecycle-api -n dk-course -o wide
kubectl get endpointslice -n dk-course -l kubernetes.io/service-name=lifecycle-api -o wide
kubectl get pod -n dk-course -l app.kubernetes.io/name=lifecycle-api -o wide
```

对照三组地址：

- Service `clusterIP`：稳定的集群内虚拟 IP。
- EndpointSlice `endpoints[].addresses`：当前后端 Pod IP。
- Pod `status.podIP`：单个 Pod 的网络身份。

EndpointSlice controller 根据 Service selector 与 Pod labels 计算候选集合，再结合 Pod readiness 维护 endpoint conditions。Service 本身不“包含”Pod，也不会因为存在就保证有后端。

查看所有权、端口和条件：

```powershell
kubectl get endpointslice -n dk-course -l kubernetes.io/service-name=lifecycle-api -o yaml
kubectl get endpointslice -n dk-course -l kubernetes.io/service-name=lifecycle-api `
  -o jsonpath='{range .items[*].endpoints[*]}{.addresses[0]}{" ready="}{.conditions.ready}{" serving="}{.conditions.serving}{" terminating="}{.conditions.terminating}{" pod="}{.targetRef.name}{"`n"}{end}'
```

通常 `ready=true` 近似表示 serving 且非 terminating。滚动更新和删除期间还要看 `serving`、`terminating`，不要只抓一个布尔值构建流量逻辑。

## 3. port、targetPort 与 named port

Service 暴露 TCP 80，而容器监听 8080：

```text
client → lifecycle-api:80 → Service data plane → PodIP:8080
```

`targetPort: http` 引用 Pod container port 的名字，而不是 Service port 名字的魔法映射。命名端口允许不同 Pod template 在保持逻辑端口名时使用不同数字；EndpointSlice 最终保存解析后的后端端口。

```powershell
kubectl get service lifecycle-api -n dk-course -o jsonpath='servicePort={.spec.ports[0].port} targetPort={.spec.ports[0].targetPort}{"`n"}'
kubectl get endpointslice -n dk-course -l kubernetes.io/service-name=lifecycle-api -o jsonpath='{range .items[*].ports[*]}name={.name} port={.port} protocol={.protocol}{"`n"}{end}'
```

若 selector 正确但 EndpointSlice 没有期望端口，应检查 Pod 是否声明对应 named port。Service 不会探测应用实际监听端口。

## 4. DNS 只负责发现入口

进入 client 查看 resolver 配置并解析名称：

```powershell
kubectl exec -n dk-course network-client -- cat /etc/resolv.conf
kubectl exec -n dk-course network-client -- nslookup lifecycle-api
kubectl exec -n dk-course network-client -- nslookup lifecycle-api.dk-course.svc.cluster.local
```

同 namespace 的短名 `lifecycle-api` 会通过 Pod 的 DNS search suffix 展开。跨 namespace 应使用 `lifecycle-api.dk-course` 或完整名称。CoreDNS 返回 Service ClusterIP；它不为每个 HTTP 请求选择后端。

若 DNS 失败，分层检查：

```powershell
kubectl get pod,service,endpointslice -n kube-system -l k8s-app=kube-dns -o wide
kubectl get service kube-dns -n kube-system
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=50
```

DNS 成功只说明名字可解析，不说明 Service 有 endpoint，也不说明应用端口可用。

## 5. ClusterIP 不是某个常驻监听进程

在常见实现中，节点上的 kube-proxy 观察 Service 和 EndpointSlice，使用 iptables、IPVS 或 nftables 等机制编程数据面；某些网络实现会用 eBPF 等方式替代 kube-proxy。关键语义是：Service API 对象驱动数据面把虚拟入口流量转给 endpoint，而不是 API Server 代理业务请求。

检查当前 kind 集群实现，不要预设模式：

```powershell
kubectl get daemonset kube-proxy -n kube-system -o yaml
kubectl logs daemonset/kube-proxy -n kube-system --tail=50
kubectl get configmap kube-proxy -n kube-system -o yaml
```

ClusterIP 通常只在集群网络内可达。从 Windows 宿主直接访问失败不等于 Service 坏了；应先从集群内 client 验证。临时调试可用 API Server 支持的 port-forward：

```powershell
kubectl port-forward -n dk-course service/lifecycle-api 18080:80
curl.exe http://127.0.0.1:18080/
```

port-forward 是调试隧道，不是生产入口，也不能证明正常 Service 数据面路径全部正确。

## 6. 验证多个动态后端

服务响应包含 Pod 名，多次建立连接观察后端变化：

```powershell
kubectl exec -n dk-course network-client -- sh -c 'for i in 1 2 3 4 5 6 7 8; do wget -qO- http://lifecycle-api/; done'
```

不要要求严格轮询。Service 通常在连接层选择 endpoint；HTTP keep-alive、连接跟踪、会话亲和和具体代理实现都可能让多次请求落到同一后端。本命令的 wget 每次新建连接，提高观察多个 Pod 的概率，但不构成均匀负载保证。

同时 watch EndpointSlice，然后删除一个后端 Pod：

```powershell
kubectl get endpointslice -n dk-course -l kubernetes.io/service-name=lifecycle-api -w
```

```powershell
$victim = kubectl get pod -n dk-course -l app.kubernetes.io/name=lifecycle-api -o jsonpath='{.items[0].metadata.name}'
kubectl delete pod $victim -n dk-course
```

观察旧 endpoint 进入终止/被移除、新 Pod 创建、readiness 通过后新 endpoint 加入。Service ClusterIP 不变，这正是入口与后端生命周期解耦。

## 7. selector 错误为何 DNS 仍然成功

```powershell
kubectl apply -f .\docker-kubernetes\code\15_service_discovery\manifests\broken-service.yaml
kubectl get service lifecycle-api-broken -n dk-course
kubectl get endpointslice -n dk-course -l kubernetes.io/service-name=lifecycle-api-broken -o yaml
kubectl exec -n dk-course network-client -- nslookup lifecycle-api-broken
kubectl exec -n dk-course network-client -- wget -T 2 -O- http://lifecycle-api-broken/
```

预期 DNS 能解析 Service ClusterIP，但请求失败，因为 selector 没有匹配 Pod，EndpointSlice 中没有可用 endpoint。排障顺序应是：

```text
DNS 名称 → Service port/targetPort → selector 与 Pod labels
→ EndpointSlice addresses/conditions → Pod Ready → 应用监听与 NetworkPolicy
```

## 8. Headless Service 改变发现语义

`clusterIP: None` 的 headless Service 不提供普通 ClusterIP 代理入口。DNS 返回后端地址，让客户端直接发现 Pod：

```powershell
kubectl get service lifecycle-api-headless -n dk-course
kubectl exec -n dk-course network-client -- nslookup lifecycle-api-headless
```

这不自动带来客户端负载均衡、重试或连接迁移；这些责任转移给客户端或上层协议。Headless Service 常用于需要发现成员身份的有状态系统，不是“性能更高的普通 Service”通用替代品。

## 9. Service 类型的边界

- ClusterIP：集群内部稳定虚拟入口，是默认类型。
- NodePort：在 ClusterIP 基础上增加每节点端口；可达性还取决于节点网络和防火墙。
- LoadBalancer：请求外部负载均衡能力，实际实现由云控制器或本地实现提供；Kubernetes 核心不会凭 YAML 生成云负载均衡器。
- ExternalName：DNS CNAME 映射，不创建代理数据路径，且可能产生 TLS/HTTP Host 语义问题。

外部 HTTP 路由将在第 19 课使用 Ingress；不要用 `externalIPs` 或手工 NodePort 掩盖入口架构问题。

## 10. 验收与清理

必须能独立解释：

- Service selector、EndpointSlice 和 Pod readiness 如何形成后端集合；
- DNS、ClusterIP 数据面、应用监听分别在哪一层；
- Service port、targetPort、containerPort 的不同作用；
- 为什么 DNS 正常时仍可能请求失败；
- 删除 Pod 时 Service 地址为何不变，而 endpoint 会变化。

```powershell
kubectl delete -f .\docker-kubernetes\code\15_service_discovery\manifests --ignore-not-found
kubectl delete deployment lifecycle-api -n dk-course --ignore-not-found
```

官方依据：[Service](https://kubernetes.io/docs/concepts/services-networking/service/)、[EndpointSlices](https://kubernetes.io/docs/concepts/services-networking/endpoint-slices/)、[DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)。

> 下一课：[16 Namespace 与标签治理](../16_namespace_labels/README.md)。
