# 03_tcp_states —— 把 TCP 状态机跑出来

配套知识章节：[`net/knowledge/05_tcp_connection.md`](../../knowledge/05_tcp_connection.md)（TCP 连接管理与状态机）

一个终端跑程序制造现象，另一个终端用 `ss` / `Get-NetTCPConnection` 盯着内核里的连接状态看。
目标不是"知道有这么个状态"，而是**线上看到这个状态，能立刻说出是谁的锅**。

```bash
cd net/code/03_tcp_states
go run . -h                  # 列出全部子命令
go run . -mode rst           # 单终端就能跑，先从这个开始
go run . -mode halfclose     # 单终端就能跑
```

---

## 1. 覆盖的知识点

| 知识点（对应 05 章） | 由哪个 `-mode` 复现 |
|---|---|
| 四次挥手完整状态轨迹 | `server-good`（被动方）、`server-timewait`（主动方） |
| CLOSE_WAIT 堆积意味着什么、是谁的 bug | `server-bad` + `client-close` |
| 为什么主动关闭方会进 TIME_WAIT | `client-timewait`（客户端侧）、`server-timewait`（服务端侧） |
| 大量 TIME_WAIT 的影响：临时端口耗尽 | `client-timewait` 跑完的推算输出 |
| RST 的产生场景：端口无监听 / 异常关闭 / 连接已不存在 | `rst` 三个场景 |
| `connection refused` / `reset by peer` / `broken pipe` / `i/o timeout` 分别对应什么底层事件 | `rst`（每个错误都打印 errno + 中文含义） |
| 半关闭：`shutdown(SHUT_WR)` 与 `close()` 的区别 | `halfclose` |
| SO_LINGER 的语义与代价 | `rst` 场景二 |
| 连接建立与关闭在 Go `net` 包中的对应行为 | 全部（每个 `Close()` 的位置都有注释说明它触发了哪个状态迁移） |

### 文件结构

```text
03_tcp_states/
├── go.mod              module nettutorial/tcpstates，零第三方依赖
├── main.go             统一入口：-mode 分发、全局 flag、usage
├── observe.go          公共工具：观察点打印 + 错误码翻译（explainErr）
├── server_good.go      ✅ 正确示例：读到 io.EOF 立刻 Close()
├── server_bad.go       ❌ 错误示例：复现 CLOSE_WAIT 堆积
├── server_timewait.go  服务端主动关闭 → TIME_WAIT 堆在服务端
├── client.go           client-timewait / client-close
├── rst.go              RST 三场景（进程内自带对端）
└── halfclose.go        CloseWrite() vs Close() 对照（进程内自带对端）
```

`_good` / `_bad` 成对阅读：两个文件的 handler 差别**只有一行 `defer c.Close()`**，
但一个健康、一个能把线上服务的 fd 耗光。

---

## 2. 每个 `-mode` 怎么跑

单终端就能跑的两个先做，建立直觉；再做双终端的。

### 2.1 `rst`（单终端）

```bash
go run . -mode rst
```

依次演示三个场景，各自打印原始 error + errno 数字 + 中文含义：

1. 连一个没人 listen 的端口 → `connection refused`（对端内核回 RST，**耗时微秒级**）
2. `SetLinger(0)` 后 `Close()` → 发 RST 而不是 FIN → 对端读到 `connection reset by peer`
3. 对端已完全 `Close()`，我方继续 write → **第 1 次返回 nil，第 2 次才报错**

第 1 个场景还带一个对照：连不可路由地址 `192.0.2.1:80`（RFC 5737 文档保留段）→ `i/o timeout`。
**refused（微秒） vs timeout（秒级）是排障的第一个分水岭**：前者说明包到了、被明确拒绝；后者说明包可能压根没到。

### 2.2 `halfclose`（单终端）

```bash
go run . -mode halfclose
```

同一个请求-响应流程做两遍：

- 演示 A：客户端 `CloseWrite()` → **仍能完整读到服务端的响应** ✅
- 演示 B：客户端 `Close()` → 服务端的响应撞上 RST，客户端**一个字节都收不到** ❌

每个演示中间留了 1.2 秒窗口，方便另开终端抓 `FIN_WAIT_2` / `CLOSE_WAIT` 成对出现。

### 2.3 复现 CLOSE_WAIT 堆积（双终端，先 A 后 B）

```bash
# 终端 A —— 先起
go run . -mode server-bad

# 终端 B —— 后跑
go run . -mode client-close -n 20

# 终端 C —— 观察（客户端跑完后敲，不用抢时间，CLOSE_WAIT 不会自己消失）
ss -tan state close-wait '( sport = :9000 )'                      # Linux/WSL2
Get-NetTCPConnection -LocalPort 9000 | Group-Object State          # Windows
```

关键动作：**客户端进程跑完退出后再看一次**。CLOSE_WAIT 数量纹丝不动 —— 这就是"泄漏"与"慢"的区别。
再跑一次 `client-close -n 5`，数字变成 25，只增不减。

对照组：把终端 A 换成 `go run . -mode server-good`，同样的客户端，服务端侧什么都留不下。

### 2.4 复现客户端侧 TIME_WAIT + 临时端口耗尽推算（双终端，先 A 后 B）

```bash
# 终端 A
go run . -mode server-good

# 终端 B（默认 500 条）
go run . -mode client-timewait -n 500
```

跑完立刻在终端 C 数客户端侧的 TIME_WAIT（会留 60~120 秒，不用抢）：

```bash
ss -tan state time-wait '( dport = :9000 )' | wc -l                # Linux/WSL2
Get-NetTCPConnection -RemotePort 9000 | Group-Object State         # Windows
```

程序跑完会按**实测建连速率**推算端口耗尽风险，例如：

```text
建连速率 ≈ 3202 conn/s
Linux  ：端口 28232 个 / 2MSL 60s  → 可持续上限 ≈ 471 conn/s  ❌ 会耗尽
Windows：端口 16384 个 / 2MSL 120s → 可持续上限 ≈ 137 conn/s  ❌ 会耗尽
```

用 `-delay 5ms` 把速率压下来，可以看到推算结论从 ❌ 变成 ✅。

### 2.5 复现服务端侧 TIME_WAIT（双终端，先 A 后 B）

```bash
# 终端 A —— 服务端回完一条响应就主动 Close（等价于 HTTP 的 Connection: close）
go run . -mode server-timewait

# 终端 B —— -passive 让客户端等对端先发 FIN，做被动关闭方
go run . -mode client-timewait -passive -n 300
```

这是 2.4 的镜像实验：**只是换了谁先发 FIN，TIME_WAIT 就整体搬了个家。**

### 2.6 全局 flag

| flag | 默认值 | 作用 |
|---|---|---|
| `-mode` | 必填 | 选子命令 |
| `-addr` | `127.0.0.1:9000` | 服务端监听地址 / 客户端连接地址 |
| `-n` | 0（用子命令默认值） | 连接条数。`client-timewait` 默认 500，`client-close` 默认 1 |
| `-hold` | `10m` | `server-bad` 模拟"卡在下游调用"的时长 |
| `-idle` | `2m` | `server-good` 的读空闲超时（Deadline） |
| `-delay` | `0` | `client-timewait` 每条连接之间的间隔，用来压低速率 |
| `-passive` | `false` | `client-timewait` 改为被动关闭方 |

服务端支持 Ctrl+C 优雅关闭：先关 Listener 停止收新连接，再等存量连接跑完，最后打印一次收尾观察点。

---

## 3. 观察命令速查表

### 3.1 ss（Linux/WSL2） ↔ PowerShell（Windows）

| 想干什么 | Linux / WSL2 | Windows PowerShell |
|---|---|---|
| 看某端口相关的所有连接 | `ss -tan '( sport = :9000 or dport = :9000 )'` | `Get-NetTCPConnection -LocalPort 9000`<br>`Get-NetTCPConnection -RemotePort 9000` |
| 按状态分组计数 | `ss -tan \| awk 'NR>1{print $1}' \| sort \| uniq -c` | `Get-NetTCPConnection -LocalPort 9000 \| Group-Object State` |
| 只看 CLOSE_WAIT | `ss -tan state close-wait` | `Get-NetTCPConnection -State CloseWait` |
| 只看 TIME_WAIT | `ss -tan state time-wait` | `Get-NetTCPConnection -State TimeWait` |
| 数某状态有几条 | `ss -tan state time-wait '( dport = :9000 )' \| wc -l` | `(Get-NetTCPConnection -RemotePort 9000 -State TimeWait).Count` |
| 全机概览 | `ss -s` | `Get-NetTCPConnection \| Group-Object State` |
| 连接归属哪个进程 | `sudo ss -tanp` | `Get-NetTCPConnection \| Select LocalPort,State,OwningProcess` |
| 持续盯着看 | `watch -n1 "ss -tan state close-wait"` | `while($true){ Get-NetTCPConnection -LocalPort 9000 \| Group-Object State; sleep 1 }` |
| 临时端口范围 | `cat /proc/sys/net/ipv4/ip_local_port_range` | `netsh int ipv4 show dynamicport tcp` |
| TIME_WAIT 时长 | 固定 60s，内核常量 `TCP_TIMEWAIT_LEN`，**不可调** | `reg query "HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters" /v TcpTimedWaitDelay`（无此键 = 用默认 120s） |
| 抓 RST 报文 | `sudo tcpdump -i lo -nn 'tcp[tcpflags] & tcp-rst != 0'` | Wireshark 选 Npcap Loopback Adapter，过滤 `tcp.flags.reset == 1` |
| 端口连通性探测 | `nc -vz 127.0.0.1 9000` | `Test-NetConnection 127.0.0.1 -Port 9000` |
| 杀掉占端口的进程 | `sudo fuser -k 9000/tcp` | `Stop-Process -Id (Get-NetTCPConnection -LocalPort 9000 -State Listen).OwningProcess -Force` |

### 3.2 状态名对照（三套写法互不相同，别混用）

| TCP 标准名 | `ss` 过滤关键字 | `ss` 输出显示 | PowerShell State |
|---|---|---|---|
| LISTEN | `listening` | `LISTEN` | `Listen` |
| SYN_SENT | `syn-sent` | `SYN-SENT` | `SynSent` |
| SYN_RCVD | `syn-recv` | `SYN-RECV` | `SynReceived` |
| ESTABLISHED | `established` | `ESTAB` ⚠️ | `Established` |
| FIN_WAIT_1 | `fin-wait-1` | `FIN-WAIT-1` | `FinWait1` |
| FIN_WAIT_2 | `fin-wait-2` | `FIN-WAIT-2` | `FinWait2` |
| CLOSE_WAIT | `close-wait` | `CLOSE-WAIT` | `CloseWait` |
| LAST_ACK | `last-ack` | `LAST-ACK` | `LastAck` |
| TIME_WAIT | `time-wait` | `TIME-WAIT` | `TimeWait` |

⚠️ `ss` 输出里 ESTABLISHED 显示成 **`ESTAB`**，`grep ESTABLISHED` 会一条都搜不到。

### 3.3 本机自测时怎么区分"谁是服务端、谁是客户端"

用 `127.0.0.1` 时两侧都在同一台机器上，同一条 `ss` 输出里会同时出现两侧的记录：

- `sport = :9000` → **本地**端口是 9000 → 服务端侧
- `dport = :9000` → **对端**端口是 9000 → 客户端侧

Windows 对应：`-LocalPort 9000` = 服务端侧，`-RemotePort 9000` = 客户端侧。

---

## 4. 「预期观察 → 结论」对照表

| 观察到的现象 | 结论 | 该查什么 |
|---|---|---|
| 某一侧大量 **CLOSE_WAIT**，且**只增不减** | 这一侧收到了 FIN 却迟迟不 `Close()`，**100% 是这一侧的应用层 bug** | 打 goroutine 全栈（`kill -QUIT` / `/debug/pprof/goroutine?debug=2`），找卡在同一行的那一坨 |
| CLOSE_WAIT 出现但**很快消散** | 正常。被动关闭方生成响应期间必然经过这个状态 | 不用查 |
| 某一侧大量 **TIME_WAIT** | 这一侧是**主动关闭方**（先发 FIN 的那一方） | 先问"我为什么在主动关连接"，而不是去调内核参数 |
| **客户端侧** TIME_WAIT 逼近临时端口数 | 短连接速率超过 `端口数 / 2MSL`，即将端口耗尽 | 改长连接 / 连接池复用；扩端口范围只是治标 |
| **服务端侧** TIME_WAIT 很多 | 通常**不会**耗尽端口（本地端口固定是监听端口），代价是内存 / conntrack | 查是不是 `Connection: close`、idle timeout 设太短、网关 keepalive 比上游短 |
| 大量 **FIN_WAIT_2** | 对端收了我的 FIN 但不发自己的 FIN → **对端在 CLOSE_WAIT**，是对端的锅 | Linux 有 `tcp_fin_timeout`（默认 60s）兜底，CLOSE_WAIT 侧没有任何兜底 |
| `connection refused`，**耗时微秒级** | 包到了对端主机，端口无人 listen，内核回 RST | 服务起没起、端口写没写错、容器端口映射对不对 |
| `i/o timeout`，**耗时秒级** | 连 RST 都收不到，包可能压根没到 | DROP 型防火墙 / 安全组 / 路由不通 / 对端宕机 |
| `connection reset by peer` | 收到 RST，连接在对端已不存在 | 对端进程崩溃重启？`SO_LINGER=0`？中间 LB/NAT 回收了空闲连接？ |
| 第 1 次 write 成功、第 2 次报错 | 第 1 次只是拷进了本机发送缓冲区；对端回的 RST 要下一次系统调用才暴露 | **write 返回 nil ≠ 对端收到**。要确认送达只能靠应用层 ACK |
| `CloseWrite()` 之后还能读到数据 | 正常。FIN 是单向的，只说明"我不再发"，不代表"我不再收" | 这正是四次挥手为什么是四次 |

### 本机实测样例（Windows 11，回环）

```text
# client-timewait -n 120 打完 server-good
客户端侧 (RemotePort 9101): 120 TimeWait
服务端侧 (LocalPort  9101): 1 Listen          ← 服务端干干净净，一条残留都没有

# client-close -n 15 打完 server-bad
服务端侧 (LocalPort  9102): 15 CloseWait + 1 Listen
客户端侧 (RemotePort 9102): 15 FinWait2       ← 成对出现，你不 Close 上游也跟着漏
再补 -n 5                 : 20 CloseWait      ← 只增不减
杀掉 server-bad 进程       : 全部消失          ← "重启一下就好了"的真相

# client-timewait -passive -n 80 打完 server-timewait
服务端侧 (LocalPort  9103): 80 TimeWait + 1 Listen
客户端侧 (RemotePort 9103): 无                ← 换了谁先发 FIN，TIME_WAIT 整体搬家
```

---

## 5. ⚠️ 常见踩坑

### 环境类

1. **WSL2 有自己的网络命名空间**。在 Windows 侧跑服务端、在 WSL2 里敲 `ss`，看到的是两个世界 —— WSL2 的 `ss` 只能看到 WSL2 自己的连接。
   **务必把服务端和客户端跑在同一个环境里**（都在 WSL2，或都在 Windows）。
   WSL2 的 localhost 转发会让"能连上但 ss 里查无此连接"这种诡异现象出现，纯属环境问题，不是 TCP 问题。

2. **TIME_WAIT 时长两个平台不一样**：
   - Linux：固定 **60 秒**（`TCP_TIMEWAIT_LEN` 是编译期常量，`sysctl` 里根本没有这个可调项）
   - Windows：注册表 `TcpTimedWaitDelay`，较新版本默认 **120 秒**（老版本 240 秒）
   所以同一个实验，Windows 上 TIME_WAIT 消散得更慢、堆得更高。

3. **临时端口范围也不一样**：Linux 默认 `32768-60999`（28232 个），Windows 默认从 49152 起共 16384 个。
   Windows 的端口预算只有 Linux 的一半多一点，`2MSL` 还长一倍 —— 可持续短连接速率上限差了约 3.4 倍。

4. **反复跑 `client-timewait` 会叠加**。上一轮的 TIME_WAIT 还没散，下一轮又来 500 条。
   要干净的实验数据就等 60s（Linux）/ 120s（Windows），或者换个 `-addr` 端口。

5. **改成 `-addr 0.0.0.0:9000` 时 Windows 会弹防火墙授权**，必须选"允许"，否则实验结论会失真。

### 命令类

6. **`ss ... | wc -l` 把表头也算进去了**，实际条数要减 1。看到 `1` 就是"一条都没有"。

7. **`ss -tan state close-wait` 不加过滤器时看的是整机**，会混进浏览器、IDE 等无关连接。
   一定要加 `'( sport = :9000 )'` 之类的过滤器缩小范围。

8. **`ss` 输出里 ESTABLISHED 显示成 `ESTAB`**，PowerShell 的状态名是驼峰式（`CloseWait` 不是 `CLOSE_WAIT`）。三套写法见 3.2 的对照表。

9. **`go run` 起的服务端，Ctrl+C 有时杀不干净**：`go run` 会先编译出一个临时二进制再执行，父进程被杀时子进程可能还活着。
   按端口杀最稳：
   ```powershell
   Stop-Process -Id (Get-NetTCPConnection -LocalPort 9000 -State Listen).OwningProcess -Force
   ```

10. **Windows 上抓不到 127.0.0.1 的包**，除非装 Wireshark 时勾选了 Npcap 的 loopback 支持。想抓 RST 建议直接在 WSL2 用 `tcpdump -i lo`。

### 代码类

11. **`errors.Is(err, syscall.ECONNREFUSED)` 在 Windows 上恒为 `false`**。
    Windows 的真实错误码是 `WSAECONNREFUSED = 10061`，而 `syscall.ECONNREFUSED` 在 Windows 上只是 Go 造的占位值（536870934），两者对不上。
    跨平台的错误分类写法见 `observe.go` 的 `explainErr()`：先 `errors.Is` 走 Unix 路径，再用数字兜 Windows 路径。

12. **同一个事件在 Windows 上错误码可能是 10054 也可能是 10053**（取决于 RST 到达和这次 `send` 的先后），Linux 上则可能是 `EPIPE(32)` 或 `ECONNRESET(104)`。
    **业务代码不要 match 错误字符串**，要按语义分类。

13. **别指望 GC 帮你收连接**。Go 的 `net.netFD` 上确实挂了 finalizer，但何时触发没有任何保证，高并发下必然先撞上 fd 上限。
    （`server_bad.go` 显式把泄漏的 conn 存进全局切片，正是为了绕开 finalizer、让泄漏稳定复现 —— 这也精确对应真实线上"conn 被某个 goroutine 或 map 持有着"的形态。）

14. **`CloseWrite()` 之后仍然要 `Close()`**，否则 fd 泄漏。半关闭只关了协议上的一个方向，没有释放文件描述符。

15. **`CloseWrite()` / `CloseRead()` 只在 `*net.TCPConn` / `*net.UnixConn` 上有**，`net.Conn` 接口没有，必须类型断言。
    另外别在 `net/http` 里手动 `CloseWrite`：HTTP/1.1 连接由 Transport 管理复用，手动半关闭会往连接池里塞一条残废连接。

---

## 6. 自测清单

跑完全部实验后，不查资料回答：

- [ ] `ss` 里看到某服务大量 CLOSE_WAIT，你的第一句结论是什么？下一步做什么？
- [ ] 服务端大量 TIME_WAIT 和客户端大量 TIME_WAIT，危害分别是什么？为什么不一样？
- [ ] "TIME_WAIT 太多，把 2MSL 调小"这个方案，在 Linux 上为什么根本做不到？正确解法是什么？
- [ ] `connection refused` 和 `i/o timeout`，光看**耗时**怎么区分？各自对应网络里的什么事？
- [ ] 日志显示"发送成功"但对端说没收到，可能是什么原因？怎么证明？
- [ ] `CloseWrite()` 和 `Close()` 的区别是什么？各自会让本端进入哪个状态？
- [ ] 为什么说"CLOSE_WAIT 是泄漏，TIME_WAIT 是等待"？

答不上来的，回去重跑对应的 `-mode`，对照程序打印的「观察点」逐条核。
