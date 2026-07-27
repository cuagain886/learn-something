//go:build unix

// executor.go — 执行器：进程管理、流式输出、超时击杀、资源限制（阶段 ①②③④⑦）
//
// ⚠️ 最关键的设计决策：
//   Executor 只负责【怎么跑】，不碰状态机、不碰幂等、不碰指标——那些在 Runner 层。
//   这样新增执行后端（本地/容器/远程）时不会重复实现，也不会重复出 bug。
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

// OutputSink 接收流式输出。真实系统里它把行推给 SSE/WebSocket。
type OutputSink func(stream, line string)

type Executor interface {
	Execute(ctx context.Context, t *Task, sink OutputSink) error
	Name() string
}

// ============================================================================
// CappedWriter — 输出限额（阶段 ③，第 06 章板斧⑤）
// ============================================================================

type CappedWriter struct {
	mu        sync.Mutex
	sb        strings.Builder
	limit     int
	total     int64
	truncated bool
}

func (c *CappedWriter) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.total += int64(len(p))
	if room := c.limit - c.sb.Len(); room > 0 {
		if len(p) > room {
			p = p[:room]
			c.truncated = true
		}
		c.sb.Write(p)
	} else {
		c.truncated = true
	}
	return len(p), nil // ⚠️ 永远报成功：限的是我方存储，不是子进程的命
}

func (c *CappedWriter) Snapshot() (text string, total int64, truncated bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sb.String(), c.total, c.truncated
}

// ============================================================================
// LocalExecutor — 本地进程执行器
// ============================================================================

type LocalExecutor struct {
	BaseDir   string // 工作目录的父目录
	UseCgroup bool   // 有 root 时启用 cgroup 限额
}

func (e *LocalExecutor) Name() string {
	if e.UseCgroup {
		return "local+cgroup"
	}
	return "local"
}

func (e *LocalExecutor) Execute(ctx context.Context, t *Task, sink OutputSink) error {
	// ── 阶段 ①：独立工作目录（第 07 章）────────────────────────────────
	if err := os.MkdirAll(e.BaseDir, 0o755); err != nil {
		return fmt.Errorf("准备 base 目录: %w", err)
	}
	workDir, err := os.MkdirTemp(e.BaseDir, "task-"+t.ID+"-*")
	if err != nil {
		return fmt.Errorf("创建工作目录: %w", err)
	}
	os.Chmod(workDir, 0o700) // 0700：防他人窥探中间产物
	t.setResult(func(t *Task) { t.workDir = workDir })

	// ── 阶段 ⑦：cgroup 资源限额（第 11 章）─────────────────────────────
	var cgPath string
	if e.UseCgroup {
		if p, err := setupCgroup(t); err == nil {
			cgPath = p
			t.setResult(func(t *Task) { t.cgroupPath = p })
		}
	}

	// ── 阶段 ②：超时（与取消同一条路径）───────────────────────────────
	runCtx, cancel := context.WithTimeout(ctx, t.Limits.Timeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, "sh", "-c", t.Script)
	cmd.Dir = workDir
	// 环境变量白名单：绝不把宿主机凭证泄露给不可信代码
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + workDir, "LANG=C",
		"TASK_ID=" + t.ID}

	// ── 阶段 ④：进程组隔离（第 02 章 §4.2）────────────────────────────
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setpgid:   true,             // 子进程自立门户，后代全在组里
		Pdeathsig: syscall.SIGKILL,  // 辅助：Runner 死了它也跟着死
	}

	stdout := &CappedWriter{limit: t.Limits.MaxOutput}
	stderr := &CappedWriter{limit: t.Limits.MaxOutput}
	outPipe, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	errPipe, err := cmd.StderrPipe()
	if err != nil {
		return err
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动失败: %w", err) // 启动失败没有子进程，单独归类
	}
	pgid := cmd.Process.Pid // Setpgid 后 PGID == 子进程 PID
	t.setResult(func(t *Task) { t.pgid = pgid })

	// 放进 cgroup —— 所有子孙自动继承限制
	if cgPath != "" {
		os.WriteFile(filepath.Join(cgPath, "cgroup.procs"),
			[]byte(strconv.Itoa(pgid)), 0o644)
	}

	// 超时/取消时先礼后兵：SIGTERM 给整组 → 宽限期 → SIGKILL
	cmd.Cancel = func() error { return killGroup(pgid, cgPath, syscall.SIGTERM) }
	cmd.WaitDelay = t.Limits.GracePeriod

	// ── 阶段 ③：两根管道并发排水（第 02 章 §5）────────────────────────
	// ⚠️ 不排水就死锁：管道 64KB 写满后子进程 write 永久阻塞
	var wg sync.WaitGroup
	wg.Add(2)
	drain := func(r io.Reader, w *CappedWriter, stream string) {
		defer wg.Done()
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 64<<10), 1<<20) // 行缓冲上限，防超长行撑爆内存
		for sc.Scan() {
			line := sc.Text()
			w.Write(append(sc.Bytes(), '\n'))
			if sink != nil {
				sink(stream, line) // 流式转发，不等任务结束
			}
		}
	}
	go drain(outPipe, stdout, "stdout")
	go drain(errPipe, stderr, "stderr")

	wg.Wait()               // ① 先排空管道（读到 EOF）
	waitErr := cmd.Wait()   // ② 再收尸 —— 顺序不能反

	// 兜底：WaitDelay 的 SIGKILL 只打直接子进程，对整组再补一枪
	killGroup(pgid, cgPath, syscall.SIGKILL)

	// 收集结果
	so, soTotal, soTrunc := stdout.Snapshot()
	se, seTotal, seTrunc := stderr.Snapshot()
	t.setResult(func(t *Task) {
		t.Stdout, t.Stderr = so, se
		t.TotalBytes = soTotal + seTotal
		t.Truncated = soTrunc || seTrunc
	})

	return classify(t, waitErr, runCtx, cgPath)
}

// classify 判定终态并写入 Task —— ⚠️ 死因必须能区分，否则排障抓瞎
func classify(t *Task, waitErr error, ctx context.Context, cgPath string) error {
	if waitErr == nil {
		t.setResult(func(t *Task) { t.ExitCode = 0 })
		t.To(StateSucceeded)
		return nil
	}

	var ee *exec.ExitError
	if errors.As(waitErr, &ee) {
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok {
			if ws.Signaled() {
				sig := ws.Signal()
				t.setResult(func(t *Task) { t.Signal = sig; t.ExitCode = -1 })
				// ⚠️ 被 SIGKILL 有三种可能，必须查清是哪一种
				switch {
				case wasOOMKilled(cgPath):
					t.To(StateOOMKilled)
				case errors.Is(ctx.Err(), context.DeadlineExceeded):
					t.To(StateTimeout)
				case errors.Is(ctx.Err(), context.Canceled):
					t.To(StateCanceled)
				default:
					t.To(StateFailed)
				}
				return nil
			}
			code := ws.ExitStatus()
			t.setResult(func(t *Task) { t.ExitCode = code })
		}
	}
	// 进程正常退出但码非 0，或 ctx 已经结束
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		t.To(StateTimeout)
	case errors.Is(ctx.Err(), context.Canceled):
		t.To(StateCanceled)
	default:
		t.To(StateFailed)
	}
	return nil
}

// ============================================================================
// 进程组 / cgroup 操作
// ============================================================================

// killGroup 终止整个任务的进程 —— 双保险
func killGroup(pgid int, cgPath string, sig syscall.Signal) error {
	// 优先 cgroup.kill：原子、无法通过 setsid 逃逸（第 11 章 §4.2）
	if cgPath != "" && sig == syscall.SIGKILL {
		if err := os.WriteFile(filepath.Join(cgPath, "cgroup.kill"),
			[]byte("1"), 0o644); err == nil {
			return nil
		}
	}
	if pgid <= 0 {
		return nil
	}
	err := syscall.Kill(-pgid, sig) // 负号 = 发给整个进程组
	if errors.Is(err, syscall.ESRCH) {
		return nil // 组已空，正常
	}
	return err
}

func setupCgroup(t *Task) (string, error) {
	const root = "/sys/fs/cgroup"
	var st syscall.Statfs_t
	if err := syscall.Statfs(root, &st); err != nil {
		return "", err
	}
	if st.Type != 0x63677270 { // cgroup2fs
		return "", errors.New("需要 cgroup v2")
	}
	// 两级路径：租户配额 / 任务配额（阶段 ⑨）
	path := filepath.Join(root, "agent", t.TenantID, t.ID)
	if err := os.MkdirAll(path, 0o755); err != nil {
		return "", err
	}
	w := func(f, v string) { os.WriteFile(filepath.Join(path, f), []byte(v), 0o644) }
	w("cpu.max", fmt.Sprintf("%d 100000", int(t.Limits.CPUQuota*100000)))
	w("memory.max", strconv.FormatInt(t.Limits.MemoryBytes, 10))
	w("memory.swap.max", "0") // 禁 swap，否则内存限制形同虚设
	w("pids.max", strconv.Itoa(t.Limits.MaxPids))
	return path, nil
}

// wasOOMKilled 查 memory.events —— 这是 OOM 的铁证（第 10 章案例 A）
func wasOOMKilled(cgPath string) bool {
	if cgPath == "" {
		return false
	}
	raw, err := os.ReadFile(filepath.Join(cgPath, "memory.events"))
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

// cleanupTask 回收任务的全部资源 —— 由状态机的终态钩子调用，保证恰好一次
func cleanupTask(t *Task) []string {
	var problems []string

	// ① 杀光残留进程（先 TERM 后 KILL）
	killGroup(t.pgid, t.cgroupPath, syscall.SIGTERM)
	time.Sleep(50 * time.Millisecond)
	killGroup(t.pgid, t.cgroupPath, syscall.SIGKILL)
	time.Sleep(50 * time.Millisecond)

	// ② 删 cgroup（必须先清空进程）
	if t.cgroupPath != "" {
		if err := os.Remove(t.cgroupPath); err != nil {
			problems = append(problems, "删除 cgroup 失败: "+err.Error())
		}
	}
	// ③ 删工作目录
	if t.workDir != "" {
		if err := os.RemoveAll(t.workDir); err != nil {
			problems = append(problems, "删除工作目录失败: "+err.Error())
		}
	}
	return problems
}

// autopsy 验尸检查（阶段 ⑩，第 12 章 §7）——做成自动断言比任何监控都早发现问题
func autopsy(t *Task) []string {
	var problems []string

	// 检查 1：cgroup 里还有进程吗？（比 pgrep 可靠——不会漏掉逃出进程组的）
	if t.cgroupPath != "" {
		if raw, err := os.ReadFile(filepath.Join(t.cgroupPath, "cgroup.procs")); err == nil {
			if pids := strings.Fields(string(raw)); len(pids) > 0 {
				problems = append(problems,
					fmt.Sprintf("cgroup 内残留 %d 个进程", len(pids)))
			}
		}
	}
	// 检查 2：进程组里还有存活进程吗？（信号 0 = 只探活）
	if t.pgid > 0 && syscall.Kill(-t.pgid, 0) == nil {
		problems = append(problems, fmt.Sprintf("进程组 %d 仍有存活进程", t.pgid))
	}
	// 检查 3：工作目录清了吗？
	if t.workDir != "" {
		if _, err := os.Stat(t.workDir); err == nil {
			problems = append(problems, "工作目录未删除: "+t.workDir)
		}
	}
	// 检查 4：cgroup 目录清了吗？
	if t.cgroupPath != "" {
		if _, err := os.Stat(t.cgroupPath); err == nil {
			problems = append(problems, "cgroup 目录未删除")
		}
	}
	return problems
}

// CleanOrphans 启动时扫描遗留目录（清理的第三层——SIGKILL 时 defer 不会执行）
func CleanOrphans(baseDir string, maxAge time.Duration) int {
	entries, err := os.ReadDir(baseDir)
	if err != nil {
		return 0
	}
	cutoff := time.Now().Add(-maxAge)
	removed := 0
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "task-") {
			continue
		}
		info, err := e.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue // 还新，可能是活跃任务
		}
		if os.RemoveAll(filepath.Join(baseDir, e.Name())) == nil {
			removed++
		}
	}
	return removed
}
