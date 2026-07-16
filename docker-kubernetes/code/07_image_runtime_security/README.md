# 07 · 镜像与运行时安全：把默认权限缩到应用真正需要的范围

> 安全目标不是“镜像越小越安全”，而是针对威胁模型缩小身份、文件系统、能力、资源、构建输入和供应链的权限边界，并保留可运维性。

## 1. 先定义威胁模型

本课假设攻击者可能通过应用漏洞取得容器进程权限。我们希望限制：

- 修改镜像文件、植入持久后门。
- 使用 root/capabilities 改变内核或网络状态。
- fork/内存/CPU 消耗拖垮同一节点。
- 从镜像 layer、history、环境和构建证明中获得秘密。
- 利用镜像内多余工具下载或执行第二阶段载荷。

容器仍共享 Linux 内核，这些措施是纵深防御，不是数学意义的绝对隔离。

---

## 2. hardened image 的静态设计

最终 stage：

```dockerfile
FROM scratch
COPY --from=build --chown=65532:65532 /out/server /server
USER 65532:65532
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK ... CMD ["/server", "healthcheck"]
ENTRYPOINT ["/server"]
```

### scratch 的收益与代价

收益：没有 shell、包管理器、系统工具和无关共享库。代价：

- 无法 `docker exec ... sh`。
- 没有 `/etc/passwd`，所以使用数值 UID/GID。
- 没有 CA certificates，访问外部 HTTPS 的程序必须显式复制可信 CA bundle。
- 没有 timezone 数据；优先使用 UTC，确有需求再显式加入。
- 动态链接二进制无法运行，因此构建使用 `CGO_ENABLED=0`。

极简不是盲目删除：应用若需要 TLS、字体、时区或 libc，就必须把它们作为明确运行依赖交付。

### 为什么使用 8080

非 root 进程绑定高端口无需 `CAP_NET_BIND_SERVICE`。让外部负载均衡/端口映射把 80/443 转到容器 8080，比为应用增加 capability 更符合最小权限。

---

## 3. 构建并验证镜像身份

```powershell
docker build `
  --build-arg VERSION=1.0.0 `
  --build-arg COMMIT=lesson07 `
  --tag dk-course/server:07 .

docker image inspect dk-course/server:07 --format `
  'user={{.Config.User}} entrypoint={{json .Config.Entrypoint}} health={{json .Config.Healthcheck}} size={{.Size}}'
```

证明没有 shell：

```powershell
docker run --rm --entrypoint /bin/sh dk-course/server:07
```

预期失败是设计结果。但“没有 shell”不能替代修复应用漏洞，也不能阻止攻击者利用应用自身能力完成网络请求或内存中执行。

---

## 4. 运行时限制必须在 create/run 层设置

Dockerfile 不能替部署环境决定全部资源和安全策略。使用：

```powershell
docker run --detach --name dk-server-07 `
  --publish 127.0.0.1:18087:8080 `
  --read-only `
  --cap-drop ALL `
  --security-opt no-new-privileges=true `
  --memory 128m `
  --memory-swap 128m `
  --cpus 0.50 `
  --pids-limit 100 `
  dk-course/server:07
```

逐项含义：

| 约束 | 防御目标 | 边界 |
|------|----------|------|
| `USER 65532:65532` | 避免应用以 UID 0 运行 | 不等同于 daemon rootless 或 user namespace |
| `--read-only` | 阻止修改 rootfs | 需要写入时应挂精确 volume/tmpfs，而非关闭限制 |
| `--cap-drop ALL` | 去掉 Linux capabilities | 若应用确有能力需求，只加单个并记录理由 |
| `no-new-privileges` | 禁止 exec 通过 setuid/file caps 获得新权限 | 不修复已有权限或应用漏洞 |
| memory/cpu/pids | 限制资源耗尽影响 | 数值必须基于压测，不是越低越安全 |

本应用不写磁盘，所以不需要 tmpfs。若应用需要临时目录，使用窄范围可写点：

```powershell
docker run --rm --read-only `
  --tmpfs /tmp:rw,noexec,nosuid,size=16m `
  dk-course/server:07
```

不要把整个 rootfs 改回可写。

验证真实运行配置：

```powershell
Invoke-RestMethod http://127.0.0.1:18087/
$format = @'
user={{.Config.User}}
readonly={{.HostConfig.ReadonlyRootfs}}
capDrop={{json .HostConfig.CapDrop}}
securityOpt={{json .HostConfig.SecurityOpt}}
memory={{.HostConfig.Memory}}
nanoCpus={{.HostConfig.NanoCpus}}
pidsLimit={{.HostConfig.PidsLimit}}
'@
docker inspect dk-server-07 --format $format
```

响应中的 UID/GID 应为 65532。注意 Config.User 证明容器配置，不直接证明 user namespace 映射后的宿主身份。

---

## 5. 无 shell 镜像如何做 HEALTHCHECK

同一个二进制提供 `healthcheck` 子命令，向 loopback `/livez` 发起 2 秒超时请求并用退出码表示结果：

```powershell
docker inspect --format 'health={{.State.Health.Status}}' dk-server-07
docker inspect --format '{{json .State.Health.Log}}' dk-server-07
```

健康状态与生命周期状态独立：进程可以 running 但 unhealthy。Docker 单机默认不会因为 unhealthy 自动重启容器；restart policy主要响应进程退出。后续 Compose/Kubernetes 会决定如何消费探针结果。

探针原则：

- 有严格 timeout，避免探针自身堆积。
- 不依赖 shell/curl 等最终镜像没有的工具。
- 输出不含秘密；Docker 会保存部分探针输出供 inspect。
- liveness 只判断是否需要重启，不把短暂外部依赖故障直接当“杀进程”理由。

---

## 6. 构建秘密：ARG 和 ENV 都不安全

错误模式：

```dockerfile
ARG TOKEN
RUN curl -H "Authorization: Bearer $TOKEN" ...
```

build args 可能出现在 image history、缓存元数据和 provenance；ENV 还会保留在最终 config。正确模式是 BuildKit secret mount：

```dockerfile
RUN --mount=type=secret,id=repo_token,required=true \
    TOKEN="$(cat /run/secrets/repo_token)" && fetch-private-artifact
```

PowerShell 传入环境变量秘密：

```powershell
$env:REPO_TOKEN = 'example-only-never-commit-real-values'
docker build --secret id=repo_token,env=REPO_TOKEN .
Remove-Item Env:REPO_TOKEN
```

secret mount 只在该 RUN 中临时出现，不自动进入 layer。仍要防止命令把秘密复制到输出、日志或生成文件。

---

## 7. 供应链边界

最低检查链：

```text
基础镜像 digest
  → 依赖锁定与测试
  → 最小 runtime 内容
  → SBOM / 漏洞扫描
  → provenance（源码、builder、参数）
  → 签名/策略验证
  → 部署实际 digest
```

可探索：

```powershell
docker scout quickview dk-course/server:07
docker sbom dk-course/server:07
```

工具无发现不等于绝对安全；scratch 镜像的 OS 包很少，但应用二进制、Go 标准库、构建器和源码漏洞仍在范围内。SBOM 解决“有什么”，扫描解决“已知风险匹配”，provenance 解决“怎么构建”，签名/策略解决“谁允许它进入环境”。

---

## 8. 禁止的快捷修复

- `--privileged`：显著放宽设备、capabilities 和隔离，不是权限报错通用解法。
- 挂载 Docker socket：通常把高权限控制面交给容器。
- 改回 root：应先确认具体文件/端口/系统调用需求。
- 关闭 seccomp/LSM：应定位被拒绝调用并采用最小策略。
- 取消资源限制：应压测并调整上限，而不是让单实例拖垮节点。

---

## 9. 故障实验与验收

### 只读文件系统

应用当前无需写盘。若修改代码尝试写 `/state.json`，在 `--read-only` 下应失败。正确修复是决定数据属于临时 tmpfs、持久 volume 还是外部存储，而不是默认开放整个根目录。

### 健康检查失败

用错误 `--entrypoint` 启动一次性进程会直接退出，不会形成 unhealthy；要观察 unhealthy，需让主进程保持运行但 `/livez` 不可达。区分生命周期失败和健康失败。

验收：

- [ ] 能区分 image USER、user namespace 与 rootless daemon。
- [ ] 能解释 scratch 的运行依赖代价。
- [ ] 能证明 read-only、cap drop、no-new-privileges 与资源限制已生效。
- [ ] 能解释为何 ARG/ENV 不能传秘密。
- [ ] 能说明 SBOM、扫描、provenance、签名各回答什么问题。

```powershell
docker rm --force dk-server-07 2>$null
docker image rm dk-course/server:07
```

官方依据：[Docker Engine security](https://docs.docker.com/engine/security/)、[Build secrets](https://docs.docker.com/build/building/secrets/)、[Resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)、[Build attestations](https://docs.docker.com/build/metadata/attestations/)。

> 下一阶段：08 持久化、09 容器网络、10 Compose。
