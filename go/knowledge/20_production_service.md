# 20 · 生产级并发 HTTP 服务：把前七讲连成系统 ⭐⭐⭐

> 对应代码：[`../code/28_production_service`](../code/28_production_service)

本章构建纯标准库的异步任务服务。重点不是业务功能，而是把内存模型、结构化并发、背压、HTTP、原子配置、测试与诊断工具组合成一套可解释、可验证的生产骨架。

---

## 1. 架构

```text
Business Server
  POST /v1/jobs
  GET  /v1/jobs/{id}
        │
        ▼
request ID → access log/metrics → panic recovery → token bucket
        │
        ▼
JSON size/schema validation
        │
        ▼
bounded jobs.Engine queue
        │
        ▼
workers → CircuitExecutor → RetryExecutor → hashExecutor
        │
        ▼
concurrent-safe Job Store

Debug Server（独立地址）
  /healthz  /readyz  /metrics  /debug/pprof/*
```

业务端与诊断端分离的原因：

- 可以让 pprof 只绑定内网/localhost；
- 业务路由不会意外暴露诊断入口；
- 业务过载时仍有机会访问健康和 profile；
- 可以为两个 listener 使用不同访问控制和超时。

示例没有实现认证，因此默认地址只适合本机学习；真实部署必须保护 debug 端口。

---

## 2. 包边界

| 包 | 单一职责 |
|---|---|
| `config` | 默认值、校验、原子配置快照 |
| `jobs` | Job 状态、并发 Store、有界队列、worker、Shutdown |
| `resilience` | Retry、Circuit Breaker、Token Bucket |
| `api` | 路由、JSON、错误映射、中间件 |
| `observability` | typed atomic 指标和文本导出 |
| `app` | 依赖组装、双服务器、readiness、关闭编排 |
| `main` | flags、signal root context、日志和进程边界 |

依赖方向保持单向：API 依赖 JobService 接口，不依赖 Engine 具体实现；resilience 实现 jobs.Executor；app 在最外层组装。

---

## 3. 请求处理顺序

中间件顺序：

```text
request ID
  → observation（计数、in-flight、访问日志）
    → recover（panic→500+stack log）
      → limiter（拒绝→429）
        → route
```

request ID 放最外层，确保后续日志和错误都有标识。observation 在 recover 外层，才能记录 panic 转换后的 500。

请求 JSON 使用：

- `http.MaxBytesReader` 限制 Body；
- `json.Decoder.DisallowUnknownFields` 拒绝未知字段；
- 第二次 Decode 必须得到 EOF，拒绝拼接多个 JSON；
- payload 去空白后不能为空。

所有业务响应和 404/405 都返回 JSON，并带 `X-Request-ID`。

---

## 4. 稳定错误映射

| 场景 | HTTP | code |
|---|---:|---|
| JSON/schema/payload 非法 | 400 | invalid_json / invalid_payload |
| Body 超上限 | 413 | body_too_large |
| token bucket 拒绝 | 429 | rate_limited |
| Job 不存在 | 404 | job_not_found |
| 方法不支持 | 405 | method_not_allowed |
| 队列满或 Engine 关闭 | 503 | service_overloaded |
| 提交 deadline | 504 | deadline_exceeded |
| panic/未分类失败 | 500 | internal_error |

错误响应不包含堆栈、内部包名或下游详情；完整 error 和 stack 只进入结构化日志。

429 表示当前调用速率超过策略，503 表示服务整体暂时没有接收容量。客户端重试必须有上限、指数退避和 jitter，不能立刻循环制造重试风暴。

---

## 5. 有界任务引擎

状态机：

```text
queued → running → succeeded
                 → failed
                 → canceled
queued ─────────→ canceled（强制关闭时尚未执行）
```

Submit：

1. 在状态锁下确认 Engine 仍开放，并登记活跃 submitter；
2. 创建 queued Job 并写 Store；
3. 非阻塞放入有界队列；
4. 队列满则删除临时 Job 并返回 `ErrQueueFull`；
5. submitter Done。

Shutdown 先禁止新 Submit，再等待所有已登记 Submit 完成，最后关闭 queue，因此不会发生 send-on-closed-channel。

正常 Shutdown 排空已接受任务；Shutdown context 到期会取消 Engine context，活动 executor 收到取消，排队任务被标记 canceled。

---

## 6. Job Store 与快照

Store 使用 RWMutex 保护 map，并始终按值存取 Job：

```go
job, ok := store.Get(id) // 返回值副本
job.Status = Failed      // 不会绕过 Store 修改内部状态
```

如果 Job 将来包含 slice/map/pointer，仅复制结构体不再等于深拷贝，需要重新定义不可变边界。

示例 Store 是进程内内存：重启后丢失、不支持多实例一致性。这是第一阶段明确非目标；真实任务系统通常需要持久化、幂等键、租约和消息投递语义。

---

## 7. Retry：只重试可恢复错误

`RetryExecutor` 只重试错误链中实现：

```go
interface { Temporary() bool }
```

且返回 true 的错误。

不重试：

- 永久业务错误；
- caller context 取消；
- deadline exceeded；
- panic（由 Engine goroutine 边界处理）；
- 达到 MaxAttempts。

退避：

```text
delay_n = min(BaseDelay × 2^(n-1), MaxDelay)
```

Sleep 使用 timer + select，服从同一个 context 预算。教学实现不加随机 jitter，以便测试精确断言；生产重试通常必须加 jitter，避免大量实例同步重试。

Job 的 Attempts 通过 request context 中的 `AttemptCounter` 从 Retry 传回 Engine。直接 executor 未报告次数时，Engine 记为 1；重试成功则记录真实尝试数。

---

## 8. 熔断器

```text
Closed
  ├── 连续失败达到阈值 → Open
  └── 成功 → 清零连续失败

Open
  ├── cooldown 未到 → fail fast: ErrCircuitOpen
  └── cooldown 到 → 允许一个探针，进入 HalfOpen

HalfOpen
  ├── 探针成功 → Closed
  └── 探针失败/取消 → Open
```

HalfOpen 只允许一个探针，其他请求继续快速失败，防止刚恢复的下游被瞬间压垮。

本章组合顺序是：

```text
CircuitExecutor(RetryExecutor(real executor))
```

Breaker 观察一轮有限重试后的最终结果，而不是把每次内部尝试都记作独立请求。选择顺序必须结合业务：有时希望 breaker 观察每次下游调用，则可以把 Retry 放外层，但状态统计和流量行为会不同。

caller 取消不累计 Closed 状态失败；HalfOpen 探针被取消时保守回 Open，因为恢复状态仍未被证明。

---

## 9. Token Bucket

Token Bucket 参数：

- rate：每秒补充 token；
- burst：最多积累 token，也是瞬时突发上限；
- 每个请求消耗 1 token。

```text
tokens = min(burst, tokens + elapsed_seconds × rate)
allow  = tokens >= 1
```

Mutex 保护浮点 token、last time 和扣减的复合不变量。单独把 tokens 改为 atomic 并不能原子维护“按时间补充 + 上限 + 扣减”。

这是单进程限流；多实例全局配额需要集中式协调或在入口网关执行。

---

## 10. panic 边界

两层边界：

- HTTP middleware：handler panic → 500，panics_total++，日志记录 stack；
- Engine worker：executor panic → Job failed，错误文本稳定，日志记录 stack，worker 继续服务后续任务。

recover 必须位于发生 panic 的 goroutine。恢复后不能静默成功；必须更新状态、释放资源并留下可观测证据。

如果已经向客户端写出部分响应，再 panic，HTTP 状态可能无法重写。复杂生产框架可以先缓冲响应或严格保证可能 panic 的逻辑发生在写头之前。

---

## 11. 可观测性

业务访问日志包含：request_id、method、path、status、duration。

教学指标：

```text
requests_total
request_errors_total
jobs_submitted_total
jobs_rejected_total
panics_total
in_flight
```

指标使用 typed atomic，文本顺序固定便于测试。真实 Prometheus 环境应使用成熟客户端库处理 labels、HELP/TYPE、直方图和注册冲突；本章坚持标准库，因此只实现最小格式。

诊断端：

- healthz：进程/HTTP handler 存活；
- readyz：是否接受新流量；
- metrics：聚合计数；
- pprof：CPU、heap、goroutine、mutex、block 等。

health 与 ready 不等价。关闭时先 ready=false，进程仍然 health=ok，给负载均衡留出摘流时间。

---

## 12. 优雅关闭顺序

```text
1. readiness=false
2. business Server.Shutdown
3. Engine.Shutdown：停止提交、排空队列、等待 worker
4. debug Server.Shutdown
```

所有步骤共享一个 ShutdownTimeout context。使用 `errors.Join` 聚合错误，确保前一步失败后后续清理仍会执行。

Engine 使用 `context.WithoutCancel(root)`：收到 SIGTERM 时不是立即取消任务，而是由 Coordinator 在关闭预算内排空；如果预算到期，Shutdown context 再强制取消。

根信号和 `-run-for` 只触发关闭，不在库中调用 `os.Exit`。main 是唯一进程边界。

---

## 13. 运行与调用

自动 smoke：

```powershell
go run ./28_production_service -addr 127.0.0.1:0 -debug-addr 127.0.0.1:0 -run-for 1s
```

固定端口运行后提交：

```powershell
$job = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/v1/jobs `
  -ContentType 'application/json' -Body '{"payload":"hello"}'
Invoke-RestMethod -Uri "http://127.0.0.1:8080/v1/jobs/$($job.id)"
Invoke-WebRequest -Uri http://127.0.0.1:6060/metrics
```

验证：

```powershell
go test -race ./28_production_service/...
go test -run='^$' -bench=. -benchmem ./28_production_service/...
go vet ./28_production_service/...
```

---

## 14. 故障注入矩阵

| 故障 | 测试方式 | 期望 |
|---|---|---|
| 队列满 | worker gate + queue=1 | Submit ErrQueueFull / HTTP 503 |
| token 耗尽 | fake clock/burst | HTTP 429 |
| 临时错误 | 前两次 temporary | 第三次成功，Attempts=3 |
| 永久错误 | ordinary error | 不重试，Job failed |
| executor panic | fake panic | Job failed，worker 存活 |
| handler panic | fake service panic | HTTP 500，panics_total++ |
| task timeout | executor 等 ctx | Job failed deadline |
| Shutdown deadline | executor 等 ctx | Job canceled，Shutdown deadline error |
| 熔断探针失败 | fake clock | HalfOpen → Open |
| 客户端非法 JSON | httptest | 400 JSON error |

测试使用 fake executor/clock 和本地 httptest，不访问公网、不依赖真实 Sleep 推断复杂调度。

---

## 15. 明确未实现的生产能力

- 身份认证、授权、TLS 终止；
- 持久化和多实例 Job Store；
- 幂等提交键和去重；
- 分布式限流/熔断状态；
- 动态配置来源和审计；
- OpenTelemetry trace；
- 成熟 Prometheus 指标；
- Job TTL、分页和容量回收；
- 重试 jitter 与 Retry-After；
- Kubernetes termination grace/readiness preStop 协调。

知道骨架缺什么，比把教学服务误称为“可直接上线”更重要。

---

## 16. 高频面试题与参考答案

### Q1. 为什么既有限流又要有界队列？

限流约束入口速率，有界队列约束等待数量；短时 burst、处理抖动和不同调用方仍可能让队列满，两层保护解决不同问题。

### Q2. 429 和 503 怎么区分？

429 通常是调用方速率超过策略；503 是服务整体暂时无容量或关闭。客户端退避策略可能不同。

### Q3. 为什么重试必须服从原 context？

否则每次尝试重置完整超时，总时长会突破上游预算，产生完成后结果无人需要的僵尸工作。

### Q4. 重试与熔断器谁放外层？

取决于希望 breaker 统计“每次下游调用”还是“一轮重试后的最终请求”。本章 breaker 在外，观察最终结果。

### Q5. HalfOpen 为什么只允许一个探针？

避免 cooldown 到期后所有请求同时涌向刚恢复的下游，形成恢复风暴。

### Q6. 为什么 Job Store 返回值副本？

防止调用方绕过锁直接修改共享状态，保持所有状态转换都经过 Store 临界区。

### Q7. 为什么 Engine 用 WithoutCancel(root)？

根信号应触发“有预算的排空”，不是立即杀任务；真正强制取消由 Shutdown deadline 控制。

### Q8. Shutdown 为什么先关闭 HTTP 再关闭 Engine？

先停止新请求进入，再关闭任务提交并排空；反过来会让仍在途的 HTTP 请求提交到已关闭 Engine。

### Q9. healthz 和 readyz 有什么区别？

health 表示进程仍正常运行，ready 表示能否接受新流量；优雅关闭期间 health 可为真、ready 为假。

### Q10. recover 放在 main 能捕获 worker panic 吗？

不能。recover 只能捕获当前 goroutine 栈，HTTP 和每个 worker 都要在自己的边界处理。

### Q11. 单机 token bucket 能保证集群总 QPS 吗？

不能，每个实例有独立 bucket；集群配额需要入口层或分布式协调。

### Q12. 内存任务服务上线前最关键补什么？

取决于业务，但通常是持久化、幂等、认证、容量回收、真实可观测性和部署关闭协议；否则重启丢任务且无法安全扩容。

---

## 17. 官方资料

- [`net/http` package](https://pkg.go.dev/net/http)
- [`context` package](https://pkg.go.dev/context)
- [`log/slog` package](https://pkg.go.dev/log/slog)
- [`sync/atomic` package](https://pkg.go.dev/sync/atomic)
- [`runtime/pprof` package](https://pkg.go.dev/runtime/pprof)
- [Go Concurrency Patterns: Context](https://go.dev/blog/context)
- [The Go Memory Model](https://go.dev/ref/mem)

## 一句话总结

> 生产级 Go 服务不是“能监听端口”，而是让入口、队列、任务、错误、诊断和关闭都具有明确所有权、有限资源和可验证状态转换。
