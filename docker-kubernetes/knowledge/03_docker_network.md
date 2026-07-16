# 03 · Docker 网络：namespace、veth、bridge、DNS 与 NAT

> 对应实验：[03 端口与环境](../code/03_ports_and_environment/README.md)、[09 容器网络](../code/09_container_networking/README.md)、[10 Compose](../code/10_compose/README.md)。

## 1. network namespace 提供独立网络栈

每个典型 bridge 容器拥有独立 network namespace，其中有接口、地址、路由、socket、conntrack/DNS 相关视图。容器内 `127.0.0.1` 只回到该 namespace：

```text
container A localhost ≠ container B localhost ≠ Windows localhost
```

应用监听 `127.0.0.1:8080` 时，只接受容器 loopback 流量；监听 `0.0.0.0:8080` 才覆盖容器接口地址。端口发布无法替应用改变 bind address。

---

## 2. veth pair 与 Linux bridge

典型 user-defined bridge 数据面：

```text
container ns                       host/VM ns
eth0 ── veth end A ══ veth end B ── software bridge br-xxx
                                             │
                                   other container veth
```

veth pair 像一根虚拟网线，一端进入容器 namespace，另一端接 Linux bridge。bridge 根据二层转发表转发同网帧；IP 子网和路由提供三层语义。Docker Engine 负责创建 endpoint、分配地址和配置规则。

bridge 只覆盖同一 daemon host。跨宿主需要 overlay、路由/CNI 或外部网络方案，不能把单机 bridge 思维直接当集群网络。

---

## 3. user-defined bridge 的服务发现

默认 `bridge` 是历史共享网络；user-defined bridge 提供按网络作用域的自动 DNS、动态 connect/disconnect 和更好的项目隔离。

```text
query redis
  → Docker embedded DNS
  → 当前网络中 alias/service name 的 endpoint address
```

DNS 名称是发现入口，不保证连接永生。容器替换后：

- 名称仍可解析。
- IP 可能改变。
- 指向旧 IP 的现存 TCP 连接会断。
- 客户端需要关闭坏连接、重新解析并重连。

因此“用了 DNS”不等于拥有完整故障恢复，还需要 timeout、重试预算、连接池失效和幂等性设计。

---

## 4. 三类数据路径

### 同 bridge 东西向

数据从源 veth 经 bridge 到目标 veth，使用目标容器端口，不需要宿主端口发布。同网容器通常能访问彼此所有监听端口，因此网络 membership 本身就是权限边界之一。

### 出站

容器源地址通常经 masquerade/SNAT 变成宿主/VM 地址再出站。外部服务看到的可能是 Docker host/NAT 地址，而非容器地址。

### 发布端口入站

`hostIP:hostPort → containerIP:containerPort` 通常由 firewall/NAT/forwarding 规则实现。Docker Desktop 还增加宿主 OS 到 Linux VM 的转发层。发布到 `0.0.0.0` 与只绑定 `127.0.0.1` 的暴露范围不同。

Docker Engine 版本可选择 iptables/nftables 等 backend；稳定知识是转发/NAT/过滤语义，不应依赖某条内部 chain 名永远不变。

---

## 5. 网络安全不是只看 EXPOSE

EXPOSE 是 image metadata，不创建防火墙。安全评审要问：

- 进程监听哪些地址/端口？
- 容器加入哪些网络，谁也在这些网络？
- 哪些端口发布到哪些宿主接口？
- 宿主/云防火墙允许哪些来源？
- 是否需要出站限制和 DNS 策略？
- TLS/认证是在代理、应用还是服务网格终止？

数据库只加入 backend 且不 publish，比“发布后希望没人访问”更符合最小暴露。网络隔离仍不能代替 Redis/数据库自身认证与加密。

---

## 6. 证据式排障

```text
应用层：HTTP/Redis 返回什么？
L4：拒绝、超时、reset 各是什么？
socket：目标进程是否监听正确地址/端口？
DNS：名称在调用方 namespace 中解析为何值？
membership：两端是否有共同 network？
route/interface：容器内路由和地址是否存在？
publish/firewall：外部入口是否真的建立、绑定范围是什么？
```

ping 失败不能单独证明网络断，因为 ICMP 可能被禁而 TCP 正常；curl 成功也只证明该 HTTP 路径。测试应尽量使用应用真实协议。

## 7. 官方资料

- [Bridge network driver](https://docs.docker.com/engine/network/drivers/bridge/)
- [Docker networking overview](https://docs.docker.com/engine/network/)
- [Docker with iptables](https://docs.docker.com/engine/network/firewall-iptables/)
- [Compose networking](https://docs.docker.com/compose/how-tos/networking/)

## 小结

容器网络是 namespace 中的 socket 通过 veth 接入 bridge，再由路由、DNS、过滤和 NAT 连接其他边界。服务名解决动态地址发现，发布端口解决外部入口；二者都不能替代应用的超时、重连、认证与协议级健康判断。
