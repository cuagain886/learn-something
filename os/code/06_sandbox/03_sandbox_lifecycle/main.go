//go:build linux

// 03_sandbox_lifecycle — Sandbox 生命周期管理器：创建 → 运行 → 回收 → 验尸
//
// 学什么：
//  1. 把前面所有章节的防线组装成一个完整的生命周期：
//     工作目录(第07章) + 进程组(第02章) + cgroup(第11章) + 超时取消(第02/04章)
//     + 输出限额(第06章) + 三层清理(第07章) + 验尸(第12章)
//  2. ⚠️ 核心设计原则：【清理必须幂等且不可跳过】——
//     无论成功、失败、超时、取消、panic，回收路径都必须走完
//  3. 验尸检查（cgroup 残留 / 目录残留 / fd 泄漏）是能自动化的质量保证
//
// 运行：
//   cd os/code && sudo go run ./06_sandbox/03_sandbox_lifecycle   （完整功能，含 cgroup）
//   cd os/code && go run ./06_sandbox/03_sandbox_lifecycle        （降级模式，无 cgroup）
package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ============================================================================
// 资源限制配置
// ============================================================================

type Limits struct {
	CPUQuota    float64       // CPU 核数，如 0.5
	MemoryBytes int64         // 内存上限
	MaxPids     int           // 进程数上限 ← 防 fork bomb
	MaxOutput   int           // 输出字节上限
	Timeout     time.Duration // wall-clock 超时
	GracePeriod time.Duration // SIGTERM 后的宽限期
}

func DefaultLimits() Limits {
	return Limits{
		CPUQuota:    0.5,
		MemoryBytes: 128 << 20,
		MaxPids:     32,
		MaxOutput:   64 << 10,
		Timeout:     5 * time.Second,
		GracePeriod: 2 * time.Second,
	}
}

// ============================================================================
// CappedWriter：输出限额（第 06 章板斧⑤）
// ============================================================================

type CappedWriter struct {
	mu        sync.Mutex
	buf       strings.Builder
	limit     int
	total     int64
	Truncated bool
}

func (c *CappedWriter) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.total += int64(len(p))
	if room := c.limit - c.buf.Len(); room > 0 {
		if len(p) > room {
			p = p[:room]
			c.Truncated = true
		}
		c.buf.Write(p)
	} else {
		c.Truncated = true
	}
	return len(p), nil // ⚠️ 永远报成功：限的是我们的存储，不是子进程的命
}

func (c *CappedWriter) String() string { c.mu.Lock(); defer c.mu.Unlock(); return c.buf.String() }

// ============================================================================
// Sandbox：一个任务的完整隔离环境
// ============================================================================

type Sandbox struct {
	ID      string
	WorkDir string
	limits  Limits

	cgroupPath string // 空 = 降级模式（无 root）
	pgid       int    // 进程组 ID，cgroup 不可用时的兜底

	cleanupOnce sync.Once // ⚠️ 保证清理只执行一次（幂等）
	cleanupErrs []error
}

func NewSandbox(id string, limits Limits) (*Sandbox, error) {
	sb := &Sandbox{ID: id, limits: limits}

	// ① 工作目录（第 07 章）：随机后缀防预测，0700 防他人窥探
	dir, err := os.MkdirTemp("", "sandbox-"+id+"-*")
	if err != nil {
		return nil, fmt.Errorf("创建工作目录: %w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	sb.WorkDir = dir

	// ② cgroup（第 11 章）：有 root 才能建；没有就降级到进程组方案
	if os.Geteuid() == 0 {
		if err := sb.setupCgroup(); err != nil {
			fmt.Printf("   [warn] cgroup 不可用，降级到进程组模式: %v\n", err)
		}
	}
	return sb, nil
}

func (sb *Sandbox) setupCgroup() error {
	const root = "/sys/fs/cgroup"
	var st syscall.Statfs_t
	if err := syscall.Statfs(root, &st); err != nil {
		return err
	}
	if st.Type != 0x63677270 { // cgroup2fs magic
		return errors.New("需要 cgroup v2")
	}

	path := filepath.Join(root, "sandbox-"+sb.ID)
	if err := os.Mkdir(path, 0o755); err != nil && !os.IsExist(err) {
		return err
	}
	sb.cgroupPath = path

	write := func(file, val string) {
		os.WriteFile(filepath.Join(path, file), []byte(val), 0o644)
	}
	// CPU：quota/period（⚠️ 周期性冻结的副作用见第 11 章 §4.3 坑 1）
	write("cpu.max", fmt.Sprintf("%d 100000", int(sb.limits.CPUQuota*100000)))
	// 内存：硬上限 + 禁 swap（防绕过限制）
	write("memory.max", strconv.FormatInt(sb.limits.MemoryBytes, 10))
	write("memory.swap.max", "0")
	// 进程数：⚠️ 防 fork bomb 的唯一可靠手段
	write("pids.max", strconv.Itoa(sb.limits.MaxPids))
	return nil
}

// Run 执行命令，全程受限、可取消、必清理
func (sb *Sandbox) Run(ctx context.Context, script string) (*Result, error) {
	ctx, cancel := context.WithTimeout(ctx, sb.limits.Timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "sh", "-c", script)
	cmd.Dir = sb.WorkDir
	// 环境变量白名单（第 02 章）：不泄露宿主机凭证
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + sb.WorkDir, "LANG=C"}
	// ③ 进程组隔离（第 02 章 §4.2）：cgroup 不可用时的兜底击杀手段
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	stdout := &CappedWriter{limit: sb.limits.MaxOutput}
	stderr := &CappedWriter{limit: sb.limits.MaxOutput}

	outPipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	errPipe, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}

	// ④ 超时/取消：先礼后兵（第 02 章 §3.4）
	cmd.Cancel = func() error { return sb.killAll(syscall.SIGTERM) }
	cmd.WaitDelay = sb.limits.GracePeriod

	start := time.Now()
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("启动失败: %w", err)
	}
	sb.pgid = cmd.Process.Pid // Setpgid 后 PGID == 子进程 PID

	// 把进程放进 cgroup —— 它的所有子孙自动继承限制
	if sb.cgroupPath != "" {
		os.WriteFile(filepath.Join(sb.cgroupPath, "cgroup.procs"),
			[]byte(strconv.Itoa(cmd.Process.Pid)), 0o644)
	}

	// ⑤ 两根管道并发排水（第 02 章 §5）：不排水就死锁
	var wg sync.WaitGroup
	wg.Add(2)
	drain := func(r io.Reader, w io.Writer) {
		defer wg.Done()
		bufio.NewReader(r).WriteTo(w) // 流式，不在内存里攒全量
	}
	go drain(outPipe, stdout)
	go drain(errPipe, stderr)

	wg.Wait() // 先排空管道
	waitErr := cmd.Wait()
	elapsed := time.Since(start)

	res := &Result{
		Stdout: stdout.String(), Stderr: stderr.String(),
		Truncated:  stdout.Truncated || stderr.Truncated,
		TotalBytes: stdout.total + stderr.total,
		Duration:   elapsed,
	}
	sb.classify(res, waitErr, ctx)
	return res, nil
}

type Result struct {
	State      string // succeeded / failed / timeout / oom_killed / canceled
	ExitCode   int
	Signal     syscall.Signal
	Stdout     string
	Stderr     string
	Truncated  bool
	TotalBytes int64
	Duration   time.Duration
}

// classify 判定任务终态 —— 排障时"死因"必须能区分开
func (sb *Sandbox) classify(res *Result, waitErr error, ctx context.Context) {
	res.ExitCode = -1
	if waitErr == nil {
		res.State, res.ExitCode = "succeeded", 0
		return
	}
	var ee *exec.ExitError
	if errors.As(waitErr, &ee) {
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok {
			if ws.Signaled() {
				res.Signal = ws.Signal()
				// ⚠️ 被 SIGKILL 时要区分三种可能：超时强杀 / OOM / 人为
				switch {
				case sb.wasOOMKilled():
					res.State = "oom_killed"
				case errors.Is(ctx.Err(), context.DeadlineExceeded):
					res.State = "timeout"
				case errors.Is(ctx.Err(), context.Canceled):
					res.State = "canceled"
				default:
					res.State = "killed"
				}
				return
			}
			res.ExitCode = ws.ExitStatus()
		}
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		res.State = "timeout"
	} else if errors.Is(ctx.Err(), context.Canceled) {
		res.State = "canceled"
	} else {
		res.State = "failed"
	}
}

// wasOOMKilled 查 cgroup 的 memory.events —— 这是 OOM 的铁证（第 10 章案例 A）
func (sb *Sandbox) wasOOMKilled() bool {
	if sb.cgroupPath == "" {
		return false
	}
	raw, err := os.ReadFile(filepath.Join(sb.cgroupPath, "memory.events"))
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(line, "oom_kill ") {
			n, _ := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "oom_kill")))
			return n > 0
		}
	}
	return false
}

// killAll 终止 sandbox 内所有进程 —— 双保险
func (sb *Sandbox) killAll(sig syscall.Signal) error {
	// 优先 cgroup.kill：原子、无法逃逸（第 11 章 §4.2）
	if sb.cgroupPath != "" && sig == syscall.SIGKILL {
		if err := os.WriteFile(filepath.Join(sb.cgroupPath, "cgroup.kill"),
			[]byte("1"), 0o644); err == nil {
			return nil
		}
	}
	// 兜底：负 PID 发给整个进程组（第 02 章 §4.2）
	if sb.pgid > 0 {
		err := syscall.Kill(-sb.pgid, sig)
		if errors.Is(err, syscall.ESRCH) {
			return nil // 组已空，正常
		}
		return err
	}
	return nil
}

// Cleanup 是回收路径 —— ⚠️ 幂等，无论走哪条路径都必须执行
func (sb *Sandbox) Cleanup() []error {
	sb.cleanupOnce.Do(func() {
		// ① 杀光所有残留进程（先 TERM 后 KILL）
		sb.killAll(syscall.SIGTERM)
		time.Sleep(100 * time.Millisecond)
		sb.killAll(syscall.SIGKILL)
		time.Sleep(100 * time.Millisecond)

		// ② 删 cgroup（必须先清空进程）
		if sb.cgroupPath != "" {
			if err := os.Remove(sb.cgroupPath); err != nil {
				sb.cleanupErrs = append(sb.cleanupErrs,
					fmt.Errorf("删除 cgroup: %w", err))
			}
		}
		// ③ 删工作目录
		if err := os.RemoveAll(sb.WorkDir); err != nil {
			sb.cleanupErrs = append(sb.cleanupErrs, fmt.Errorf("删除工作目录: %w", err))
		}
	})
	return sb.cleanupErrs
}

// Autopsy 验尸检查 —— 每个任务结束后自检，异常就告警（第 12 章 §7）
func (sb *Sandbox) Autopsy() []string {
	var problems []string

	// 检查 1：cgroup 里还有进程吗？（比 pgrep 可靠——不会漏掉逃出进程组的）
	if sb.cgroupPath != "" {
		if raw, err := os.ReadFile(filepath.Join(sb.cgroupPath, "cgroup.procs")); err == nil {
			if pids := strings.Fields(string(raw)); len(pids) > 0 {
				problems = append(problems,
					fmt.Sprintf("⚠️ cgroup 内仍有 %d 个进程存活: %v", len(pids), pids))
			}
		}
	}
	// 检查 2：进程组里还有进程吗？
	if sb.pgid > 0 {
		if err := syscall.Kill(-sb.pgid, 0); err == nil { // 信号 0 = 探活
			problems = append(problems,
				fmt.Sprintf("⚠️ 进程组 %d 仍有存活进程（逃逸者？）", sb.pgid))
		}
	}
	// 检查 3：工作目录清了吗？
	if _, err := os.Stat(sb.WorkDir); err == nil {
		problems = append(problems, "⚠️ 工作目录未删除: "+sb.WorkDir)
	}
	// 检查 4：cgroup 目录清了吗？
	if sb.cgroupPath != "" {
		if _, err := os.Stat(sb.cgroupPath); err == nil {
			problems = append(problems, "⚠️ cgroup 目录未删除: "+sb.cgroupPath)
		}
	}
	return problems
}

// ============================================================================

func runCase(name, script string, limits Limits) {
	fmt.Printf("\n─── %s ───\n", name)
	sb, err := NewSandbox(fmt.Sprintf("%d-%d", os.Getpid(), time.Now().UnixNano()%10000), limits)
	if err != nil {
		fmt.Printf("   创建失败: %v\n", err)
		return
	}
	// ⚠️ defer 是清理的第一层，且 Cleanup 内部幂等
	defer func() {
		if errs := sb.Cleanup(); len(errs) > 0 {
			fmt.Printf("   清理警告: %v\n", errs)
		}
		// 验尸必须在清理【之后】做
		if problems := sb.Autopsy(); len(problems) > 0 {
			for _, p := range problems {
				fmt.Printf("   %s\n", p)
			}
		} else {
			fmt.Println("   验尸: ✅ 无进程残留、无目录残留、无 cgroup 残留")
		}
	}()

	mode := "降级(进程组)"
	if sb.cgroupPath != "" {
		mode = "完整(cgroup)"
	}
	fmt.Printf("   模式=%s  限制: cpu=%.1f核 mem=%dMB pids=%d 输出=%dKB 超时=%v\n",
		mode, limits.CPUQuota, limits.MemoryBytes>>20, limits.MaxPids,
		limits.MaxOutput>>10, limits.Timeout)

	res, err := sb.Run(context.Background(), script)
	if err != nil {
		fmt.Printf("   执行错误: %v\n", err)
		return
	}
	fmt.Printf("   终态=%-11s exit=%-3d signal=%-10v 耗时=%v\n",
		res.State, res.ExitCode, res.Signal, res.Duration.Round(10*time.Millisecond))
	if res.Truncated {
		fmt.Printf("   输出被截断: 工具产出 %d KB，只保留 %d KB ✅ 内存无恙\n",
			res.TotalBytes>>10, len(res.Stdout)>>10)
	}
	if s := strings.TrimSpace(res.Stdout); s != "" && !res.Truncated {
		if len(s) > 120 {
			s = s[:120] + "..."
		}
		fmt.Printf("   stdout: %s\n", s)
	}
}

func main() {
	fmt.Println("╔══════════════════════════════════════════════════════════════╗")
	fmt.Println("║  Sandbox 生命周期：创建 → 运行 → 回收 → 验尸                  ║")
	fmt.Println("╚══════════════════════════════════════════════════════════════╝")
	if os.Geteuid() != 0 {
		fmt.Println("\n提示: 非 root 运行 → cgroup 不可用 → 降级到进程组方案")
		fmt.Println("      完整功能: sudo go run ./06_sandbox/03_sandbox_lifecycle")
	}

	limits := DefaultLimits()

	runCase("场景 1: 正常任务", `echo "任务完成"; echo "工作目录: $PWD"`, limits)

	runCase("场景 2: 任务失败（退出码非 0）", `echo "出错了" >&2; exit 3`, limits)

	runCase("场景 3: 超时 —— 分级击杀整个进程树",
		`sleep 60 & echo "起了个后台进程 $!"; sleep 60`, limits)

	runCase("场景 4: 无限输出 —— 限额保护内存",
		`i=0; while [ $i -lt 200000 ]; do echo "刷屏刷屏刷屏刷屏刷屏刷屏刷屏刷屏"; i=$((i+1)); done`,
		limits)

	forkLimits := limits
	forkLimits.Timeout = 3 * time.Second
	runCase("场景 5: fork bomb —— pids.max 挡住（需 root 才有 cgroup）",
		`n=0; while [ $n -lt 200 ]; do sleep 10 & n=$((n+1)); done; echo "创建了 $n 个"`,
		forkLimits)

	fmt.Println(`
════════════════════════════════════════════════════════════════
生命周期设计的三条铁律:
  1. 清理路径【幂等且不可跳过】—— sync.Once + defer + 信号处理 + 启动扫孤儿
  2. 终态必须【可区分】—— succeeded/failed/timeout/oom_killed/canceled
     混在一起就无法排障（"为什么失败"是运维的第一个问题）
  3. 验尸检查【自动化】—— cgroup 残留/进程残留/目录残留，
     做成集成测试比任何监控都早发现问题

组装了哪些章节的防线:
  第 02 章  进程组 Setpgid + 分级击杀 + 管道并发排水 + Wait 收尸
  第 04 章  context 取消传播
  第 06 章  输出限额（CappedWriter）+ 流式转发
  第 07 章  工作目录随机名 + 0700 + 三层清理
  第 10 章  memory.events 判定 OOM
  第 11 章  cgroup cpu/memory/pids + cgroup.kill 原子清理
  第 12 章  验尸检查清单
════════════════════════════════════════════════════════════════`)
}
