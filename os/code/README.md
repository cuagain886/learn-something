# OS 模块示例代码

配合 [`../knowledge/`](../knowledge) 各章阅读。每个示例独立可运行，头部注释即教材。

## 环境要求

- **Linux 或 WSL2**（⚠️ 全部示例使用 Unix API：进程组、信号、/proc——Windows 原生与 macOS 部分不可用；文件带 `//go:build unix` 标签，Windows 下 `go run` 会提示无可构建文件，请在 WSL2 里跑）
- Go 1.22+（仓库当前 1.26）
- 建议安装：`strace`、`psmisc`（pstree）、`procps`（ps/pgrep）

## 运行方式

```bash
cd os/code
go run ./01_process/01_basic_exec        # 直接跑某个示例
go vet ./...                             # 静态检查全部
```

## 目录索引

| 目录 | 主题 | 对应章节 |
|---|---|---|
| `01_process/01_basic_exec` | 启动子进程、退出码与死因判定 | [02 章](../knowledge/02_process.md) §3.2/3.5 |
| `01_process/02_capture_output` | 输出捕获与 ⚠️ 管道死锁复现/修复 | [02 章](../knowledge/02_process.md) §5 |
| `01_process/03_timeout_kill` | 超时分级击杀：TERM → 宽限 → KILL | [02 章](../knowledge/02_process.md) §3.4/4.2 |
| `01_process/04_process_group_kill` | 复现"杀 bash 留 python"与进程组整树击杀 | [02 章](../knowledge/02_process.md) §4.2 |
| `01_process/05_zombie_reap` | 亲手制造僵尸进程并回收 | [02 章](../knowledge/02_process.md) §3.3 |
| `02_concurrency/01_goroutine_leak` | 三种泄漏构造/探测/修复（跨平台） | [03 章](../knowledge/03_thread_coroutine_scheduling.md) §5/9 |
| `02_concurrency/02_cpu_starvation` | CPU 密集拖高延迟 + 信号量限流（跨平台） | [03 章](../knowledge/03_thread_coroutine_scheduling.md) §2.3/7 |
| `02_concurrency/03_race_deadlock` | 竞态两形态、-race、锁序死锁（跨平台） | [04 章](../knowledge/04_concurrency_synchronization.md) §2.2/3.6 |
| `02_concurrency/04_worker_pool` | 固定 worker + 有界队列 + 背压拒绝（跨平台） | [04 章](../knowledge/04_concurrency_synchronization.md) §4.3 |
| `02_concurrency/05_task_state_machine` | 幂等占坑 + 状态机 + 并发攻击测试（跨平台） | [04 章](../knowledge/04_concurrency_synchronization.md) §4.1/4.2 |
| `03_memory/01_vsz_rss` | VSZ/RSS/minor fault 与 demand paging（Linux） | [05 章](../knowledge/05_memory_management.md) §2.3/2.9 |
| `03_memory/02_escape_analysis` | 六种逃逸场景 + 分配实测（跨平台） | [06 章](../knowledge/06_go_memory_and_gc.md) §2.1 |
| `03_memory/03_gc_observe` | MemStats/GOGC/GOMEMLIMIT/归还 OS（跨平台） | [06 章](../knowledge/06_go_memory_and_gc.md) §2.3–2.5 |
| `03_memory/04_leak_patterns` | 子切片钉数组、只增 map 两种逻辑泄漏（跨平台） | [06 章](../knowledge/06_go_memory_and_gc.md) §2.6 |
| `03_memory/05_stream_backpressure` | 防 OOM 五板斧：流式/限额/背压实测（跨平台） | [06 章](../knowledge/06_go_memory_and_gc.md) §3 |
| `04_io/01_fd_leak` | 三种 fd 泄漏 + /proc/self/fd 探测（Linux） | [07 章](../knowledge/07_file_system.md) §4.1 |
| `04_io/02_safe_path` | 路径穿越/符号链接攻击与三层防御（跨平台） | [07 章](../knowledge/07_file_system.md) §4.2 |
| `04_io/03_workdir_lifecycle` | 工作目录配额与三层清理（跨平台） | [07 章](../knowledge/07_file_system.md) §4.3 |
| `04_io/04_epoll_echo` | 裸 epoll echo server vs net 包对照（Linux） | [08 章](../knowledge/08_io_model.md) §2.2/3 |
| `04_io/05_slow_client` | 慢客户端内存堆积与四层防御（跨平台） | [08 章](../knowledge/08_io_model.md) §4 |
| `05_profiling/01_syscall_cost` | syscall 成本量表：缓冲/批量/起进程的代价（跨平台） | [09 章](../knowledge/09_system_calls.md) §4 |
| `05_profiling/02_rlimit` | rlimit 全家、EMFILE 复现、容器视图失真（Linux） | [10 章](../knowledge/10_linux_resource_management.md) §2.1/2.7 |
| `05_profiling/03_pprof_targets` | **五个故障靶场**：CPU/goroutine/内存/fd/锁竞争（跨平台） | [12 章](../knowledge/12_observability_and_debugging.md) §5 |
| `06_sandbox/01_namespace_demo` | 创建 PID/UTS/Mount/User namespace（Linux，需 root） | [11 章](../knowledge/11_container_and_sandbox.md) §3 |
| `06_sandbox/02_cgroup_limit` | cgroup v2 限 CPU/内存/pids + fork bomb 攻防（Linux，需 root） | [11 章](../knowledge/11_container_and_sandbox.md) §4 |
| `06_sandbox/03_sandbox_lifecycle` | **Sandbox 生命周期**：创建→运行→回收→验尸（Linux） | [11 章](../knowledge/11_container_and_sandbox.md) §7 |
| `06_sandbox/04_agent_runner` | **Agent Code Runner**：十阶段毕业项目（含测试） | [13 章](../knowledge/13_agent_code_runner_project.md) |

## 毕业项目

`06_sandbox/04_agent_runner` 是本模块的综合项目，组装了第 02/04/06/07/10/11/12 章的全部机制：

```bash
go run  ./06_sandbox/04_agent_runner            # 完整演示（降级模式）
sudo go run ./06_sandbox/04_agent_runner        # 启用 cgroup 硬限额
go run  ./06_sandbox/04_agent_runner -attack    # 只跑四类攻击测试
go run  ./06_sandbox/04_agent_runner -v         # 打印结构化事件日志
go test -race ./06_sandbox/04_agent_runner -v   # 并发攻击的自动化测试
```
