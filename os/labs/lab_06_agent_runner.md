# Lab 06 · Sandbox 与 Agent Runner：隔离攻防

> 配套章节：[11 容器与 Sandbox](../knowledge/11_container_and_sandbox.md)、[13 Agent Code Runner 项目](../knowledge/13_agent_code_runner_project.md) · 配套代码：[`code/06_sandbox`](../code/06_sandbox)
>
> 实验 1–5 对应 11 章（隔离机制与攻防），实验 6–10 对应 13 章（项目验收）。
> ⚠️ **本 lab 全部需要 Linux/WSL2，多数需要 root**。请在虚拟机或 WSL2 里做，不要在生产机器上做。

---

## 实验 1：手工创建 PID Namespace

**目的**：亲眼看到"容器就是被 namespace 限制了视野的进程"。

```bash
# 方式一：用 unshare 命令
sudo unshare --pid --fork --mount-proc bash
  echo $$          # 1  ← 我就是 PID 1
  ps aux           # 只有 bash 和 ps 两个进程
  # 另开一个终端: ps -ef | grep bash  ← 宿主机上它有一个正常的大 PID
  exit

# 方式二：用 Go 程序（看清 Cloneflags 的作用）
cd <repo>/os/code && sudo go run ./06_sandbox/01_namespace_demo
```

**预期观察**：容器内 PID 从 1 开始，`ps` 只见寥寥几个进程；改主机名不影响宿主机。

**关键验证**——不挂 `/proc` 会怎样：
```bash
sudo unshare --pid --fork bash      # ⚠️ 故意不加 --mount-proc
  echo $$      # 1
  ps aux       # 却看到宿主机的全部进程！
  exit
```
**思考题**：为什么 `echo $$` 显示 1 但 `ps` 看到宿主机进程？（提示：`$$` 是内核给的真实 PID namespace 视图，`ps` 读的是 `/proc`——第 10 章 §2.7 "`/proc` 不是 namespace 化的"）

**验证 PID 1 死则全灭**：
```bash
sudo unshare --pid --fork --mount-proc bash -c '
  sleep 300 &
  echo "起了个子进程 $!, 现在我(PID 1)要退出了"
'
sleep 1
pgrep -a "sleep 300"      # 空 —— 内核连坐杀光了整个 namespace ✅
```

## 实验 2：cgroup 限制三件套 🔑root

```bash
cd <repo>/os/code && sudo go run ./06_sandbox/02_cgroup_limit
```

**手工版**（更能理解"就是读写文件"）：
```bash
sudo mkdir /sys/fs/cgroup/lab
cd /sys/fs/cgroup/lab
ls                                          # 内核自动生成的控制文件

# CPU：0.2 核
echo "20000 100000" | sudo tee cpu.max
# 内存：50MB，禁 swap
echo $((50*1024*1024)) | sudo tee memory.max
echo 0 | sudo tee memory.swap.max
# 进程数：10
echo 10 | sudo tee pids.max

# 把当前 shell 放进去，之后起的所有进程都受限
sudo sh -c "echo $$ > /sys/fs/cgroup/lab/cgroup.procs"
cat /sys/fs/cgroup/lab/cgroup.procs

# 测试 CPU 限制
time (yes > /dev/null & sleep 3; kill %1)
cat /sys/fs/cgroup/lab/cpu.stat | grep throttled    # nr_throttled 在涨

exit    # 退出这个 shell
sudo rmdir /sys/fs/cgroup/lab
```

**预期观察**：`cpu.stat` 的 `nr_throttled` 持续增长——进程被周期性冻结。

**思考题**：一个 4 线程程序在 `cpu.max="20000 100000"` 下，会均匀地慢 5 倍，还是周期性卡顿？为什么？（提示：11 章 §4.3 坑 1——4 线程在 5ms 内就用光 20ms 配额，剩余 95ms 全部冻结）

## 实验 3：fork bomb 攻防 🔑root

⚠️ **只在有 pids 限制的 cgroup 里做，否则会打死你的机器**。

```bash
# ① 先建好防线
sudo mkdir /sys/fs/cgroup/forkbomb-lab
echo 20 | sudo tee /sys/fs/cgroup/forkbomb-lab/pids.max

# ② 在防线内引爆
sudo bash -c '
  echo $$ > /sys/fs/cgroup/forkbomb-lab/cgroup.procs
  echo "已进入 cgroup, pids.max=20"
  # 温和版 fork bomb（可控，不用真的 :(){ :|:& };: ）
  n=0
  while [ $n -lt 100 ]; do
    sleep 30 & 2>/dev/null || break
    n=$((n+1))
  done
  echo "只创建了 $n 个进程就被挡住了"
  cat /sys/fs/cgroup/forkbomb-lab/pids.current
'

# ③ 清理
echo 1 | sudo tee /sys/fs/cgroup/forkbomb-lab/cgroup.kill    # 原子杀光全组
sleep 1 && sudo rmdir /sys/fs/cgroup/forkbomb-lab
```

**预期观察**：进程数卡在 20，宿主机毫发无伤；`cgroup.kill` 一步清干净。

**对照实验**——验证 `RLIMIT_NPROC` 为什么不可靠：
```bash
# 开两个终端，都用同一个用户
# 终端 1:
ulimit -u 50 && bash -c 'n=0; while [ $n -lt 100 ]; do sleep 30 & n=$((n+1)); done; echo "创建了 $n"'
# 终端 2（同一用户）: 现在试着起一个新进程
sleep 1    # ← 可能失败！因为 NPROC 是【按 UID】统计的，额度被终端 1 吃光了
killall sleep
```
**思考题**：多租户 Agent 平台上，如果所有任务都用同一个 uid 运行并靠 `RLIMIT_NPROC` 限制，会发生什么？（提示：一个租户的 fork bomb 会让所有租户都无法创建进程——这就是必须用 cgroup 的原因）

## 实验 4：Docker 默认配置 vs 加固配置

**目的**：亲手验证"为什么不能只依赖 Docker 默认配置"。

```bash
# ① 默认配置：看看你被赋予了什么
docker run --rm alpine sh -c '
  echo "== 我是谁 =="
  id                                    # uid=0(root) ← 默认就是 root！
  echo "== 我能用多少内存 =="
  cat /sys/fs/cgroup/memory.max 2>/dev/null || echo "max（无限制！）"
  echo "== 我能起多少进程 =="
  cat /sys/fs/cgroup/pids.max 2>/dev/null || echo "max（无限制！fork bomb 通行）"
  echo "== 我有哪些 capabilities =="
  grep CapEff /proc/self/status
  echo "== 我能访问内网吗 =="
  (wget -q -T2 -O- http://169.254.169.254/ 2>/dev/null && echo "⚠️ 能访问元数据服务!") || echo "(本机无元数据服务，云上会成功)"
'

# ② 加固配置：对比一下
docker run --rm \
  --user 65534:65534 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop=ALL \
  --security-opt no-new-privileges \
  --network none \
  --memory 64m --memory-swap 64m \
  --cpus 0.5 \
  --pids-limit 16 \
  alpine sh -c '
  id                                    # uid=65534(nobody)
  cat /sys/fs/cgroup/memory.max         # 67108864
  cat /sys/fs/cgroup/pids.max           # 16
  grep CapEff /proc/self/status         # 0000000000000000 ← 一个能力都没有
  touch /test 2>&1 || echo "根文件系统只读 ✅"
  ping -c1 8.8.8.8 2>&1 | head -1       # 网络不通 ✅
'
```

**预期观察**：默认配置下你是 root、无内存/进程数限制、有 14 个 capabilities、网络畅通；加固后全部收紧。

**思考题**：把 `--pids-limit` 去掉，在容器里跑 fork bomb 会怎样？（不用真试——想清楚后果：容器共享宿主机内核和 PID 空间，宿主机会被拖垮）

## 实验 5：元数据服务攻防（云上必做）

**目的**：理解 Sandbox 最容易被忽略的致命点。

```bash
# 在云主机上（本地虚拟机没有元数据服务，可跳过验证步骤只做防御）
# ① 攻击视角：一行命令拿到云账号临时凭证
curl -s -m2 http://169.254.169.254/latest/meta-data/iam/security-credentials/
# 有输出 = 拿到角色名 → 再 curl 一次就是 AccessKey/SecretKey/Token

# ② 防御：在 Sandbox 的 network namespace 里屏蔽
sudo ip netns add sandbox-ns
sudo ip netns exec sandbox-ns iptables -A OUTPUT -d 169.254.169.254 -j REJECT
sudo ip netns exec sandbox-ns iptables -A OUTPUT -d 10.0.0.0/8 -j REJECT
sudo ip netns exec sandbox-ns iptables -A OUTPUT -d 172.16.0.0/12 -j REJECT
sudo ip netns exec sandbox-ns iptables -A OUTPUT -d 192.168.0.0/16 -j REJECT
sudo ip netns exec sandbox-ns iptables -L OUTPUT -n

# ③ 验证屏蔽生效
sudo ip netns exec sandbox-ns curl -s -m2 http://169.254.169.254/ || echo "✅ 已屏蔽"

sudo ip netns del sandbox-ns
```

**最简单的防御**：`--network none`。**不需要联网的任务应该默认禁网**——这消除了整类风险。

**思考题**：如果任务确实需要 `pip install`，怎么在允许访问 PyPI 的同时屏蔽元数据服务和内网？（提示：白名单出网——只放行特定域名解析出的 IP，或走一个受控的代理）

---

## 实验 6：Sandbox 生命周期完整演练

```bash
cd <repo>/os/code
sudo go run ./06_sandbox/03_sandbox_lifecycle    # 完整功能（含 cgroup）
go run ./06_sandbox/03_sandbox_lifecycle         # 降级模式（仅进程组）
```

**预期观察**：五个场景各自的终态判定正确（succeeded/failed/timeout/killed），每个场景结束后**验尸检查全部通过**。

**思考题**：为什么 `Cleanup()` 要用 `sync.Once` 包起来？如果 defer 里调一次、信号处理器里又调一次会怎样？（提示：重复删除、重复杀进程可能误伤已被复用的 PID）

## 实验 7–10：Agent Code Runner 项目验收

> 这几个实验对应 [13 章](../knowledge/13_agent_code_runner_project.md) 的十阶段项目，在项目完成后逐一验收。

- **实验 7**：并发压测——100 个任务并发提交，验证并发数受控、无竞态（`-race`）
- **实验 8**：攻击测试——重复提交、迟到取消、双完成三类并发攻击
- **实验 9**：资源攻击——无限输出、fork bomb、路径穿越、超时不退出四类攻击
- **实验 10**：可观测性——指标齐全、能用 pprof 定位 Runner 自身的问题

---

## 验收清单

**实验 1–6（隔离机制）**
- [ ] 我手工创建过 PID namespace，验证过"不挂 /proc 就看到宿主机进程"
- [ ] 我验证过 PID 1 死则全灭，理解它为什么比进程组更可靠
- [ ] 我用 cgroup 限制过 CPU/内存/进程数，见过 `nr_throttled` 增长
- [ ] 我在防线内引爆过 fork bomb，并理解 `RLIMIT_NPROC` 为什么不可靠
- [ ] 我对比过 Docker 默认与加固配置，能逐项说出默认缺了什么
- [ ] 我知道元数据服务的地址与危害，能写出屏蔽规则
- [ ] 我跑通了 Sandbox 生命周期的五个场景，验尸检查全绿

**实验 7–10（项目验收）**
- [ ] 见 13 章的十阶段验收标准
