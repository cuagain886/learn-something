# 10 · Docker Compose：声明多服务期望状态与生命周期

> 本课交付 Go HTTP + Redis 计数系统。重点是配置合并、服务发现、健康依赖、故障期间行为、volume 生命周期和项目级清理，不是只会 `compose up`。

## 1. 系统结构

```text
Windows localhost:${APP_PORT}
        │ published port
        ▼
app:8080 ── DNS redis ──→ redis:6379
   │                        │
   │ /livez                 └─ redis-data volume (AOF)
   └ /readyz = Redis PING
```

Redis 不发布宿主端口，只在 `backend` 网络可达。app 使用服务名 `redis`，不使用动态 IP。每次 `/` 通过 RESP `INCR page_hits` 返回累计次数。

本课为看清连接失败语义，用标准库实现最小 RESP 客户端：每个操作独立连接、带 deadline、严格解析 CRLF/长度/类型。它不是生产连接池替代品；真实系统应使用成熟客户端实现复用、拓扑发现、TLS、认证与指标。

先验证代码：

```powershell
go test ./...
go vet ./...
```

---

## 2. 先渲染最终配置

Compose 配置来自 YAML、环境插值、可选 env file 和 CLI。复制本地配置：

```powershell
Copy-Item .env.example .env
docker compose config
docker compose config --services
docker compose config --volumes
docker compose config --networks
```

`docker compose config` 是排查变量和合并结果的首选证据。`.env` 用于 Compose 插值，不应提交；它也不会自动把所有变量注入容器，只有 compose.yaml 的 `environment`/`env_file` 决定容器环境。

项目名由顶层 `name: dk-course` 固定，因此资源获得稳定前缀和 Compose labels，避免目录重命名改变资源身份。

---

## 3. 服务定义中的关键约束

### app

- `build` 产生本地 image，并用 `image` 赋名。
- 仅把 `127.0.0.1:${APP_PORT}` 发布到宿主。
- `REDIS_ADDR=redis:6379` 使用容器网络服务发现。
- read-only、drop ALL、no-new-privileges 与资源限制延续第 07 课。
- healthcheck 继承 Dockerfile，检查 `/readyz`，因此依赖不可用时 app 为 unhealthy 而进程仍 running。
- 日志设置轮转，避免 json-file 无限增长。

### redis

- AOF `everysec` 提供教学所需持久性；它不等于零数据丢失保证。
- healthcheck 用 `redis-cli ping` 判断 Redis 已能处理命令。
- `/data` 使用 named volume，容器替换不删除数据。
- 不发布 6379；实验没有密码，只允许 backend 网络访问，不能照搬为生产安全方案。

---

## 4. 启动顺序不等于持续可用性

```yaml
depends_on:
  redis:
    condition: service_healthy
    restart: true
```

`service_healthy` 让 Compose 等 Redis healthcheck 成功再创建 app，解决首次启动竞态。它不能保证 Redis 永远在线；运行中 Redis 仍会故障。因此应用每次操作有超时，根路径返回 503，readiness 变失败，而不是永久阻塞。

长语法中的 `restart: true` 指 Compose 显式更新/重启 dependency 时同步重启 dependent，不是容器进程崩溃时的通用 restart policy。

启动并等待健康：

```powershell
docker compose up --detach --build --wait
docker compose ps
Invoke-RestMethod http://127.0.0.1:18090/
Invoke-RestMethod http://127.0.0.1:18090/
```

若 `.env` 改了 APP_PORT，使用实际端口。

---

## 5. 观察 Compose 创建的真实对象

```powershell
docker compose images
docker compose top
docker compose logs --timestamps --tail 50
docker network inspect dk-course_backend
docker volume inspect dk-course_redis-data
docker compose exec redis redis-cli GET page_hits
```

Compose 不是另一个容器 runtime；它把声明转换为 Engine 的 image、container、network、volume 对象，并用 project/service labels 管理集合。可以用普通 docker inspect 继续下钻。

服务更新时容器可能被替换并获得新 IP，但网络别名 `redis` 稳定。已有长连接会断，客户端必须重新解析并连接；本课每操作新建连接，显式展示这一点。

---

## 6. 故障演练：依赖消失时系统如何退化

```powershell
docker compose stop redis
curl.exe -i http://127.0.0.1:18090/readyz
curl.exe -i http://127.0.0.1:18090/
docker compose ps
docker inspect --format '{{json .State.Health}}' dk-course-app-1
```

预期：app 主进程仍运行，livez 可成功，readyz 与业务请求返回 503，health 最终 unhealthy。这个状态比让进程崩溃循环更利于区分“应用死了”和“依赖暂不可用”。

恢复：

```powershell
docker compose start redis
docker compose up --detach --wait
Invoke-RestMethod http://127.0.0.1:18090/readyz
```

`docker compose wait` 等待容器停止，不是 health wait；不要在恢复流程中误用。这里重新执行 `up --wait`，让 Compose 等项目服务达到 running/healthy。

### 配置更新

```powershell
docker compose up --detach --build --wait
```

Compose 比较期望配置并只重建需要变化的服务。它不是 Kubernetes 控制器：进程崩溃后的持续调谐、自愈和多节点调度能力不同。

---

## 7. down、volume 与“数据为什么还在”

```powershell
docker compose down
docker volume ls --filter label=fighting.lesson=10
docker compose up --detach --wait
Invoke-RestMethod http://127.0.0.1:18090/
```

默认 down 删除项目容器和网络，保留 named volume，因此计数延续。真正删除实验数据：

```powershell
docker compose down --volumes --remove-orphans
```

不要把 `down -v` 当日常停止命令。生产数据删除应有独立授权、备份与恢复检查。

---

## 8. 验收清单

- [ ] 能用 `compose config` 解释最终端口、环境、网络和 volume 名称。
- [ ] 能区分 container running、Redis healthy、app ready 和业务成功。
- [ ] 能解释 depends_on 只解决初始顺序，应用仍需超时/重连/降级。
- [ ] 能证明 Redis 未发布宿主端口但 app 能通过服务名访问。
- [ ] 能解释 down 与 down --volumes 的数据结果。
- [ ] 能从 Compose labels 下钻到 Engine 对象排障。

官方依据：[Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/)、[Compose networking](https://docs.docker.com/compose/how-tos/networking/)、[Compose Quickstart](https://docs.docker.com/compose/gettingstarted/)。

> 下一阶段进入 Kubernetes；先完成 08–10 的阶段验收。
