//go:build linux

// 02_cgroup_limit — cgroup v2 实战：限制 CPU/内存/进程数，挡住 fork bomb
//
// 学什么：
//  1. cgroup v2 的操作就是【读写目录里的文件】—— 没有魔法
//  2. 三个核心限制：cpu.max（配额+周期）、memory.max（硬上限）、pids.max（防 fork bomb）
//  3. ⚠️ pids.max 是防 fork bomb 的唯一可靠手段：
//     RLIMIT_NPROC 按 UID 统计，多任务共用 uid 时额度互相干扰（第 10 章 §2.1）
//  4. cgroup.kill（5.14+）原子杀光全组 —— 比遍历 PID 可靠，无法逃逸
//
// 运行（需要 root）：
//   cd os/code && sudo go run ./06_sandbox/02_cgroup_limit
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const cgroupRoot = "/sys/fs/cgroup"

type Cgroup struct{ path string }

// NewCgroup 创建一个 cgroup —— v2 下就是建个目录，内核自动生成控制文件
func NewCgroup(name string) (*Cgroup, error) {
	// 先确认是 cgroup v2（v1 的文件布局完全不同）
	var st syscall.Statfs_t
	if err := syscall.Statfs(cgroupRoot, &st); err != nil {
		return nil, fmt.Errorf("statfs %s: %w", cgroupRoot, err)
	}
	const cgroup2Magic = 0x63677270
	if st.Type != cgroup2Magic {
		return nil, fmt.Errorf("不是 cgroup v2（stat -fc %%T %s 确认）", cgroupRoot)
	}

	path := filepath.Join(cgroupRoot, name)
	if err := os.Mkdir(path, 0o755); err != nil && !os.IsExist(err) {
		return nil, fmt.Errorf("创建 cgroup: %w", err)
	}
	return &Cgroup{path: path}, nil
}

func (c *Cgroup) set(file, value string) error {
	err := os.WriteFile(filepath.Join(c.path, file), []byte(value), 0o644)
	if err != nil {
		return fmt.Errorf("写 %s=%s: %w", file, value, err)
	}
	return nil
}

func (c *Cgroup) get(file string) string {
	raw, err := os.ReadFile(filepath.Join(c.path, file))
	if err != nil {
		return "(不可用)"
	}
	return strings.TrimSpace(string(raw))
}

// AddProcess 把进程放进 cgroup —— 它的所有子孙自动继承，这是关键
func (c *Cgroup) AddProcess(pid int) error {
	return c.set("cgroup.procs", strconv.Itoa(pid))
}

// Kill 原子杀光组内所有进程（cgroup v2, Linux 5.14+）
// ⚠️ 这是比"杀进程组"更可靠的方案：进程无法通过 setsid/setpgid 逃出 cgroup
func (c *Cgroup) Kill() error {
	if err := c.set("cgroup.kill", "1"); err != nil {
		// 老内核没有 cgroup.kill，退回遍历杀（可能有竞态：杀的同时对方在 fork）
		return c.killLegacy()
	}
	return nil
}

func (c *Cgroup) killLegacy() error {
	for i := 0; i < 5; i++ { // 多轮：杀的过程中可能有新 fork
		pids := strings.Fields(c.get("cgroup.procs"))
		if len(pids) == 0 {
			return nil
		}
		for _, s := range pids {
			if pid, err := strconv.Atoi(s); err == nil {
				syscall.Kill(pid, syscall.SIGKILL)
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("仍有进程存活")
}

func (c *Cgroup) Destroy() error {
	c.Kill()
	time.Sleep(100 * time.Millisecond)
	return os.Remove(c.path) // cgroup 目录必须为空（无进程）才能删
}

func (c *Cgroup) Status() {
	fmt.Printf("     memory.current=%-12s pids.current=%-6s 组内进程数=%d\n",
		c.get("memory.current"), c.get("pids.current"),
		len(strings.Fields(c.get("cgroup.procs"))))
}

// ---- 演示 ----------------------------------------------------------------

func demoPidsLimit(cg *Cgroup) {
	fmt.Println("\n== ① pids.max：挡住 fork bomb ==")
	if err := cg.set("pids.max", "20"); err != nil {
		fmt.Printf("   设置失败: %v\n", err)
		return
	}
	fmt.Printf("   已设 pids.max=20（当前 %s）\n", cg.get("pids.max"))

	// 温和版 fork bomb：不断 fork，看能撑到多少
	// ⚠️ 真正的 :(){ :|:& };: 会瞬间打满，这里用可控版本演示同样的防线
	script := `n=0
while [ $n -lt 100 ]; do
  sleep 5 &
  if [ $? -ne 0 ]; then break; fi
  n=$((n+1))
done
echo "成功创建 $n 个子进程后被挡住"`

	cmd := exec.Command("sh", "-c", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		fmt.Printf("   启动失败: %v\n", err)
		return
	}
	// ⚠️ 立刻放进 cgroup —— 子进程自动继承限制
	if err := cg.AddProcess(cmd.Process.Pid); err != nil {
		fmt.Printf("   加入 cgroup 失败: %v\n", err)
	}

	out := make(chan error, 1)
	go func() { out <- cmd.Wait() }()
	select {
	case <-out:
	case <-time.After(3 * time.Second):
	}
	cg.Status()
	fmt.Println("   ✅ 进程数被限制在 20 —— 宿主机毫发无伤")
	fmt.Println("   ⚠️ 对比 RLIMIT_NPROC：它按 UID 统计，多任务共用 uid 时会互相干扰")
	cg.Kill()
	time.Sleep(200 * time.Millisecond)
}

func demoMemoryLimit(cg *Cgroup) {
	fmt.Println("\n== ② memory.max：超限即 OOM Kill ==")
	limit := 64 << 20 // 64MB
	if err := cg.set("memory.max", strconv.Itoa(limit)); err != nil {
		fmt.Printf("   设置失败: %v\n", err)
		return
	}
	cg.set("memory.swap.max", "0") // 禁 swap，否则会先换出而不是 OOM
	fmt.Printf("   已设 memory.max=64MB, memory.swap.max=0\n")

	// 让子进程不断吃内存
	script := `python3 -c "
a = []
import sys
for i in range(200):
    a.append(bytearray(2*1024*1024))   # 每次 2MB
    sys.stdout.write('\r已分配 %d MB' % ((i+1)*2)); sys.stdout.flush()
" 2>/dev/null || (
  # 没有 python3 就用 dd 往 tmpfs 写(同样计入 cgroup 内存)
  dd if=/dev/zero of=/dev/shm/memtest bs=1M count=200 2>/dev/null
)`
	cmd := exec.Command("sh", "-c", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stdout = os.Stdout
	if err := cmd.Start(); err != nil {
		fmt.Printf("   启动失败: %v\n", err)
		return
	}
	cg.AddProcess(cmd.Process.Pid)

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		fmt.Println()
		if ee, ok := err.(*exec.ExitError); ok {
			if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
				fmt.Printf("   子进程被信号杀死: %v（exit code 会显示为 137=128+9）\n", ws.Signal())
			}
		}
	case <-time.After(10 * time.Second):
		fmt.Println("\n   超时，主动清理")
	}
	cg.Kill()
	os.Remove("/dev/shm/memtest")

	fmt.Printf("   memory.events: \n")
	for _, line := range strings.Split(cg.get("memory.events"), "\n") {
		fmt.Printf("     %s\n", line)
	}
	fmt.Println("   ✅ oom_kill 计数 > 0 就是被 cgroup OOM Kill 的铁证")
	fmt.Println("   （这就是容器 exit 137 时该查的第一个文件，第 10 章案例 A）")
	time.Sleep(200 * time.Millisecond)
}

func demoCPULimit(cg *Cgroup) {
	fmt.Println("\n== ③ cpu.max：配额 + 周期（不是简单的“核数”）==")
	if err := cg.set("cpu.max", "20000 100000"); err != nil { // 0.2 核
		fmt.Printf("   设置失败: %v\n", err)
		return
	}
	fmt.Println("   已设 cpu.max=\"20000 100000\" → 每 100ms 周期最多用 20ms CPU = 0.2 核")

	// 起 4 个烧 CPU 的进程 —— 它们会很快用光配额然后被冻结
	cmd := exec.Command("sh", "-c",
		`for i in 1 2 3 4; do (while :; do :; done) & done; sleep 3; kill $(jobs -p) 2>/dev/null`)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Start()
	cg.AddProcess(cmd.Process.Pid)

	time.Sleep(3200 * time.Millisecond)
	cg.Kill()

	fmt.Println("   cpu.stat:")
	for _, line := range strings.Split(cg.get("cpu.stat"), "\n") {
		if strings.Contains(line, "throttled") || strings.Contains(line, "usage_usec") {
			fmt.Printf("     %s\n", line)
		}
	}
	fmt.Println(`   ⚠️ nr_throttled/throttled_usec 持续增长 = 进程被【周期性冻结】
      多线程程序在 period 内提前用光配额 → 剩余时间全部冻结 → 【延迟毛刺】
      这就是 K8s 里"CPU limit 导致 P99 恶化"的著名问题（第 11 章 §4.3 坑 1）`)
	time.Sleep(200 * time.Millisecond)
}

func main() {
	if os.Geteuid() != 0 {
		fmt.Println("⚠️ 本示例需要 root（操作 /sys/fs/cgroup）")
		fmt.Println("   运行: sudo go run ./06_sandbox/02_cgroup_limit")
		os.Exit(1)
	}

	name := fmt.Sprintf("sandbox-demo-%d", os.Getpid())
	cg, err := NewCgroup(name)
	if err != nil {
		fmt.Printf("❌ %v\n", err)
		fmt.Println("   提示: cgroup v1 系统请用 /sys/fs/cgroup/<controller>/ 下的文件")
		os.Exit(1)
	}
	defer func() {
		if err := cg.Destroy(); err != nil {
			fmt.Printf("\n清理 cgroup 失败: %v（可手动 rmdir %s）\n", err, cg.path)
		} else {
			fmt.Printf("\ncgroup 已清理: %s\n", cg.path)
		}
	}()

	fmt.Printf("cgroup 已创建: %s\n", cg.path)
	fmt.Println("（cgroup v2 的操作就是读写这个目录里的文件——没有魔法）")

	demoPidsLimit(cg)
	demoMemoryLimit(cg)
	demoCPULimit(cg)

	fmt.Println(`
============================================================
Agent Sandbox 的 cgroup 清单（每任务一个 cgroup）:
  cpu.max          "50000 100000"   限 CPU（注意周期性冻结的副作用）
  memory.max       536870912        限内存（⚠️ 含 Page Cache，留余量）
  memory.swap.max  0                禁 swap（防绕过内存限制）
  pids.max         64               ⚠️ 防 fork bomb 的唯一可靠手段
  io.max           "8:0 wbps=..."   限磁盘 I/O
清理:
  echo 1 > cgroup.kill              原子杀光全组（5.14+），无法逃逸
  rmdir <cgroup 目录>                必须先清空进程
============================================================`)
}
