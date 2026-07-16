# 03 · 端口发布与环境注入：配置边界和网络路径

> 核心问题：容器内服务监听在哪里？`-p` 改变了什么？环境变量进入了哪一层？为什么“端口已映射”仍然可能访问失败？

## 学习目标

- 区分容器端口、宿主端口、监听地址和镜像 EXPOSE 声明。
- 画出从 Windows 客户端到容器进程的连接路径。
- 使用环境变量创建两个配置不同、镜像相同的容器。
- 理解环境变量适合普通配置，但不是理想的秘密传递机制。
- 用 inspect、port、logs 和容器内监听状态定位访问失败。

---

## 1. `-p` 的准确语义

```powershell
docker run -p 127.0.0.1:18081:8080 IMAGE
```

格式是：

```text
[宿主绑定地址:]宿主端口:容器端口[/协议]
```

本课程的 Linux containers 运行在 Docker Desktop 后端中，Docker Desktop 负责把 Windows 侧连接转发到 Linux VM，再由 Docker 网络规则送到容器地址和端口：

```text
浏览器 / Invoke-WebRequest
  → Windows 127.0.0.1:18081
  → Docker Desktop 端口转发
  → 容器网络接口:8080
  → 容器进程监听的地址:8080
```

四个结论：

1. `-p` 不会修改应用监听端口。
2. 宿主端口与容器端口可以不同。
3. 两个容器可以都监听 8080，但不能同时占用同一个宿主 IP:port。
4. 绑定 `127.0.0.1` 只允许本机访问；省略宿主 IP 常会绑定所有接口，扩大暴露面。

`EXPOSE 8080` 只是镜像元数据/文档，不等价于发布端口。

---

## 2. 用同一镜像启动两个不同配置实例

使用 Alpine 中的 BusyBox httpd；启动命令先把环境变量写入页面，再以前台模式运行 HTTP server：

```powershell
docker run --detach `
  --name dk-lab-blue `
  --env APP_NAME=blue `
  --env APP_MESSAGE='hello from blue' `
  --publish 127.0.0.1:18081:8080 `
  alpine:3.22 `
  sh -c 'mkdir -p /www; printf "%s: %s\n" "$APP_NAME" "$APP_MESSAGE" > /www/index.html; exec httpd -f -p 0.0.0.0:8080 -h /www'

docker run --detach `
  --name dk-lab-green `
  --env APP_NAME=green `
  --env APP_MESSAGE='hello from green' `
  --publish 127.0.0.1:18082:8080 `
  alpine:3.22 `
  sh -c 'mkdir -p /www; printf "%s: %s\n" "$APP_NAME" "$APP_MESSAGE" > /www/index.html; exec httpd -f -p 0.0.0.0:8080 -h /www'
```

验证：

```powershell
(Invoke-WebRequest http://127.0.0.1:18081).Content
(Invoke-WebRequest http://127.0.0.1:18082).Content
docker port dk-lab-blue
docker port dk-lab-green
```

两个容器共享同一个 image ID，但容器配置、可写层、网络地址和宿主端口彼此独立。这就是“构建一次镜像，在运行时注入环境差异”的基本模式。

---

## 3. 环境变量究竟存在哪里

```powershell
docker inspect --format '{{json .Config.Env}}' dk-lab-blue
docker exec dk-lab-blue sh -c 'printf "APP_NAME=%s\n" "$APP_NAME"'
```

创建容器时，环境数组写入容器配置；runtime 启动进程时把它加入进程环境。因此：

- 修改宿主 PowerShell 的环境变量不会自动修改已创建容器。
- `docker stop` / `start` 复用同一容器配置，环境值不变。
- 要改变环境配置，通常重新创建容器，而不是进入容器手改。
- `docker inspect` 能读取环境数组，有权限访问 Docker API 的用户通常也能看到它。

所以数据库地址、特性开关等普通配置可用环境变量；长期密钥不应仅因使用 `-e` 就被认为安全。后续会学习 Compose secrets、Kubernetes Secret 及外部秘密系统的边界。

### PowerShell 的引号陷阱

外层使用单引号：

```powershell
sh -c 'echo "$APP_NAME"'
```

可避免 PowerShell 提前展开 `$APP_NAME`，让它进入容器后由 `/bin/sh` 展开。若外层使用双引号，宿主 PowerShell 会先尝试读取自己的变量，导致传入命令与预期不同。

---

## 4. 名称、DNS 与端口不是一回事

容器名 `dk-lab-blue` 提供稳定的人类标识，但默认 bridge 网络中的跨容器 DNS 行为有限。后续第 09 课会创建 user-defined bridge network，让容器通过服务名发现彼此。

当前可观察每个容器的网络地址：

```powershell
docker inspect --format 'name={{.Name}} ip={{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' dk-lab-blue dk-lab-green
```

不要让宿主应用依赖这个容器 IP：容器重建后它可能变化。宿主访问使用发布端口；容器间访问使用自定义网络中的 DNS 名称。

---

## 5. 为什么端口映射存在却访问失败

按数据路径逐跳检查：

### 5.1 容器是否在运行

```powershell
docker ps -a --filter name=dk-lab-blue
docker inspect --format '{{json .State}}' dk-lab-blue
```

### 5.2 Engine 是否记录了发布映射

```powershell
docker port dk-lab-blue
docker inspect --format '{{json .NetworkSettings.Ports}}' dk-lab-blue
```

### 5.3 应用是否监听正确地址和端口

```powershell
docker exec dk-lab-blue sh -c 'netstat -lnt 2>/dev/null || ss -lnt'
```

服务应监听 `0.0.0.0:8080` 或容器接口地址。如果只监听容器内的 `127.0.0.1:8080`，从容器网络接口抵达的连接无法交给该 socket；端口发布本身不能修复应用监听范围。

### 5.4 应用是否返回错误

```powershell
docker logs --tail 50 dk-lab-blue
Invoke-WebRequest http://127.0.0.1:18081 -TimeoutSec 3
```

连接拒绝、超时和 HTTP 500 属于不同层：

- 拒绝：目标可达，但没有 socket 接受连接，或转发目标不存在。
- 超时：路径、代理、防火墙或应用阻塞，需要逐跳判断。
- HTTP 500：网络链路通常已经通了，应用处理失败。

---

## 6. 故障实验

### A. 宿主端口冲突

```powershell
docker run --name dk-lab-port-conflict `
  -p 127.0.0.1:18081:8080 alpine:3.22 `
  httpd -f -p 0.0.0.0:8080
```

记录错误后检查：

```powershell
docker ps -a --filter name=dk-lab-port-conflict
```

判断失败发生在创建阶段还是启动/网络配置阶段，并精确删除遗留对象。

### B. 错误的容器端口

将宿主 18083 映射到容器 9999，但应用仍监听 8080。用 `docker port` 证明规则存在，用容器内 `netstat` 证明规则指向了没有监听者的端口。

### C. 环境变量未更新

在宿主设置 `$env:APP_MESSAGE='changed'` 后 restart `dk-lab-blue`。解释页面为何不变：容器配置创建时已经固化，而且页面是在主进程启动脚本中生成的。正确做法是删除并用新配置重建。

### D. 暴露范围

比较以下配置在 `docker port` 与 inspect 中的差别：

```text
127.0.0.1:18081:8080
0.0.0.0:18081:8080
18081:8080
```

不要在不可信网络上为了实验随意绑定所有接口。

---

## 7. 验收与清理

- [ ] 能画出宿主请求到容器 socket 的完整路径。
- [ ] 能解释 EXPOSE 与 publish 的差别。
- [ ] 能使用同一镜像运行两个环境配置不同的实例。
- [ ] 能说明为何环境变量不是安全保险箱。
- [ ] 能按运行状态 → 映射 → 监听 → 应用输出定位端口故障。

```powershell
docker rm --force dk-lab-blue dk-lab-green dk-lab-port-conflict dk-lab-wrong-port 2>$null
```

## 8. 官方依据

- [Publishing and exposing ports](https://docs.docker.com/get-started/docker-concepts/running-containers/publishing-ports/)
- [docker container run](https://docs.docker.com/reference/cli/docker/container/run/)
- [Docker networking overview](https://docs.docker.com/engine/network/)
- [Docker Engine security](https://docs.docker.com/engine/security/)

> 下一课：[`04_images_and_registry`](../04_images_and_registry/README.md)。
