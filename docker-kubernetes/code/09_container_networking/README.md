# 09 · 容器网络与 DNS：从 socket 到 bridge、NAT 和服务发现

> 核心问题：容器为什么有自己的 IP？同一网络为何无需发布端口？服务名如何解析？宿主 `-p` 的流量走了另一条什么路径？

## 1. 三条容易混淆的数据路径

```text
同一 bridge 内：client container → veth → bridge → veth → server:8080
访问外网：container → bridge → forwarding/NAT masquerade → host/VM uplink
宿主入站：host:18089 → port publishing/DNAT → container:8080
```

`EXPOSE` 是元数据；同一 user-defined bridge 上的容器可直接访问对方监听端口。`-p` 只为 bridge 外部（Windows 宿主/其他网络）创建入口。

---

## 2. 创建有边界的 user-defined bridge

```powershell
docker network create `
  --driver bridge `
  --label fighting.course=docker-kubernetes `
  --label fighting.lesson=09 `
  dk-course-net
docker network inspect dk-course-net
```

不要在共享机器随意写死 subnet；Docker IPAM 会从可用地址池选择，避免与 VPN/局域网冲突的概率更高。若生产必须固定地址规划，应先与宿主路由和组织网络协调。

启动服务，故意不发布端口：

```powershell
docker run --detach --name dk-net-api `
  --network dk-course-net `
  --network-alias api `
  alpine:3.22 `
  sh -c 'mkdir -p /www; echo api-ok > /www/index.html; exec httpd -f -p 0.0.0.0:8080 -h /www'

docker run --rm --network dk-course-net alpine:3.22 `
  wget -qO- http://api:8080/
```

服务名 `api` 由 Docker 内置 DNS 解析到当前网络 endpoint 地址；客户端不需要知道容器 IP。

---

## 3. 观察 namespace 内的网络事实

```powershell
docker exec dk-net-api ip address
docker exec dk-net-api ip route
docker exec dk-net-api cat /etc/resolv.conf
docker network inspect dk-course-net --format '{{json .Containers}}'
```

分别回答：接口/IP、默认路由、DNS 配置、Engine 记录的 endpoint。Docker 自定义网络通常向容器提供嵌入式 DNS；不要把某个运行时 IP 写进应用配置，因为重建后地址可能变化。

证明名称稳定、IP 可变：

```powershell
$oldIP = docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' dk-net-api
docker rm --force dk-net-api
# 重新执行上一节的 dk-net-api docker run
$newIP = docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' dk-net-api
"old=$oldIP new=$newIP; clients still use http://api:8080"
```

即使恰好分到相同 IP，也不能把它当稳定契约。

---

## 4. 网络隔离由共同 membership 决定

```powershell
docker network create dk-isolated
docker run --rm --network dk-isolated alpine:3.22 `
  sh -c 'wget -T 2 -qO- http://api:8080 || echo expected-isolation'
```

两个不同 user-defined bridge 默认不直接互通。把一个容器同时接入两网会使它成为 multi-homed endpoint，但不会自动成为安全代理或路由器：

```powershell
docker network connect --alias api-on-isolated dk-isolated dk-net-api
docker run --rm --network dk-isolated alpine:3.22 `
  wget -qO- http://api-on-isolated:8080/
docker network disconnect dk-isolated dk-net-api
```

应用架构应只把需要跨边界的代理/API 接入两网，数据库只留在 backend；“都放默认 bridge”会让无关项目共享可达面。

---

## 5. 发布端口建立外部入口

已创建容器不能追加 port binding；需重建：

```powershell
docker rm --force dk-net-api
docker run --detach --name dk-net-api `
  --network dk-course-net --network-alias api `
  --publish 127.0.0.1:18089:8080 `
  alpine:3.22 `
  sh -c 'mkdir -p /www; echo api-published > /www/index.html; exec httpd -f -p 0.0.0.0:8080 -h /www'

Invoke-WebRequest http://127.0.0.1:18089
docker port dk-net-api
```

Linux Engine 通常用 iptables/nftables forwarding、NAT 和 connection tracking 实现 bridge 隔离与发布；Docker Desktop 还要跨 Windows 与 Linux VM 边界。不要通过手工修改 Docker 管理的规则修复单个容器问题。

绑定 127.0.0.1 限定本机入口；绑定所有接口通常允许外部主机访问，还要结合宿主防火墙。未发布的 Redis/数据库不应为了“方便调试”长期暴露。

---

## 6. 分层排障

```text
1. 进程：容器 running？应用监听 0.0.0.0:目标端口？
2. membership：两端是否共享同一 network？
3. DNS：名称解析到哪个 endpoint？是否误用 localhost？
4. L3/L4：路由、连接拒绝还是超时？
5. publish：HostConfig/NetworkSettings 是否有正确绑定？
6. 应用：TCP 通后是否返回 HTTP/协议错误？
```

容器内 `localhost` 永远首先指向该容器自己的 network namespace，不指 Redis 容器，也不等同 Windows 宿主。Compose 中应用连接 `redis:6379`，宿主访问应用才使用 `localhost:18090`。

---

## 7. 验收与清理

- [ ] 能画出 container-to-container、egress、published ingress 三条路径。
- [ ] 能解释 user-defined bridge 相比默认 bridge 的 DNS 与隔离优势。
- [ ] 能证明服务名稳定而容器 IP 非契约。
- [ ] 能说明为什么同网通信使用容器端口而不是宿主端口。

```powershell
docker rm --force dk-net-api 2>$null
docker network rm dk-course-net dk-isolated
```

官方依据：[Bridge driver](https://docs.docker.com/engine/network/drivers/bridge/)、[Networking overview](https://docs.docker.com/engine/network/)、[Docker firewall rules](https://docs.docker.com/engine/network/firewall-iptables/)。

> 下一课：[10 Docker Compose](../10_compose/README.md)。
