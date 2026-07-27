//go:build linux

// 02_rlimit — 资源限制实测：rlimit 全家、EMFILE 复现、容器视图失真
//
// 学什么：
//  1. 读取/调整自身 rlimit（软限可自行提到硬限，硬限要 root）
//  2. 亲手撞上 EMFILE —— "too many open files" 的真实触发点
//  3. ⚠️ 容器视图失真：runtime.NumCPU() 读的是宿主机，真配额在 cgroup 文件里
//     这是"容器里 nproc/free 骗人"的实证，也是 GOMAXPROCS 踩坑的根源
//
// 运行：cd os/code && go run ./05_profiling/02_rlimit   （仅 Linux/WSL2）
//   对比实验：ulimit -n 64 && go run ./05_profiling/02_rlimit
package main

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

type limitSpec struct {
	name     string
	resource int
	unit     string
	note     string
}

var specs = []limitSpec{
	{"打开文件数 (NOFILE)", syscall.RLIMIT_NOFILE, "个", "最常撞的一个"},
	{"栈大小 (STACK)", syscall.RLIMIT_STACK, "字节", "默认 8MB, 影响线程默认栈"},
	{"虚拟内存 (AS)", syscall.RLIMIT_AS, "字节", "⚠️ 限 VSZ 不是 RSS, 不适合限 Go"},
	{"CPU 时间 (CPU)", syscall.RLIMIT_CPU, "秒", "超时收到 SIGXCPU"},
	{"core 文件 (CORE)", syscall.RLIMIT_CORE, "字节", "默认 0 = 不生成"},
}

func fmtLimit(v uint64, unit string) string {
	if v == ^uint64(0) { // RLIM_INFINITY
		return "unlimited"
	}
	if unit == "字节" && v >= 1<<20 {
		return fmt.Sprintf("%d MB", v>>20)
	}
	return fmt.Sprintf("%d %s", v, unit)
}

func showLimits() {
	fmt.Println("== 当前进程的 rlimit（等价于 ulimit -a）==")
	for _, s := range specs {
		var rl syscall.Rlimit
		if err := syscall.Getrlimit(s.resource, &rl); err != nil {
			continue
		}
		fmt.Printf("  %-22s 软限=%-14s 硬限=%-14s %s\n",
			s.name, fmtLimit(rl.Cur, s.unit), fmtLimit(rl.Max, s.unit), s.note)
	}
	fmt.Println("  （运行中的进程可查 /proc/<pid>/limits —— 排障时最直接的证据）")
	fmt.Println()
}

// raiseNofile 把软限提到硬限 —— 服务启动时的常见自我调优
func raiseNofile() {
	var rl syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &rl); err != nil {
		return
	}
	old := rl.Cur
	rl.Cur = rl.Max
	if err := syscall.Setrlimit(syscall.RLIMIT_NOFILE, &rl); err != nil {
		fmt.Printf("== 提高软限失败: %v ==\n\n", err)
		return
	}
	fmt.Printf("== 软限提升: NOFILE %s → %s（软限可自行提到硬限，硬限需 root）==\n\n",
		fmtLimit(old, "个"), fmtLimit(rl.Max, "个"))
}

// demoEMFILE 一直开文件直到撞上 NOFILE
func demoEMFILE() {
	fmt.Println("== 撞上 EMFILE：too many open files 的真实触发点 ==")

	// 先把软限降到一个小值，方便快速复现（降低软限任何人都能做）
	var orig syscall.Rlimit
	syscall.Getrlimit(syscall.RLIMIT_NOFILE, &orig)
	small := orig
	small.Cur = 64
	if err := syscall.Setrlimit(syscall.RLIMIT_NOFILE, &small); err != nil {
		fmt.Printf("  跳过（无法调整软限: %v）\n\n", err)
		return
	}
	defer syscall.Setrlimit(syscall.RLIMIT_NOFILE, &orig) // 恢复

	fmt.Println("  已把 NOFILE 软限降到 64，现在不断打开文件...")
	var files []*os.File
	defer func() {
		for _, f := range files {
			f.Close()
		}
	}()

	for i := 0; ; i++ {
		f, err := os.Open("/etc/hostname")
		if err != nil {
			fmt.Printf("  第 %d 次 open 失败: %v\n", i+1, err)
			fmt.Printf("  errno 判定: EMFILE=%v （EMFILE 是进程级, ENFILE 才是系统级）\n",
				strings.Contains(err.Error(), "too many open files"))
			break
		}
		files = append(files, f)
		if i > 200 { // 保险丝
			fmt.Println("  （未触发，本环境限制可能更高）")
			break
		}
	}
	fmt.Printf("  成功打开 %d 个后失败 —— 加上启动时已占用的 fd，正好是 64\n", len(files))
	fmt.Println("  ⚠️ 线上遇到这个错误：先 ls /proc/<pid>/fd | wc -l 对比 limits，")
	fmt.Println("     再用 lsof 按类型聚合找泄漏源（第 07 章 §9）。只调 ulimit 是拖延。")
	fmt.Println()
}

// readCgroupInt 读 cgroup v2 的单值文件
func readCgroupInt(path string) (string, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(raw)), true
}

// demoContainerView 演示容器视图失真 —— 本章最重要的一个认知
func demoContainerView() {
	fmt.Println("== 容器视图失真：Go 看到的 CPU 数 vs cgroup 真实配额 ==")
	fmt.Printf("  runtime.NumCPU()   = %d   ← 读 /proc/cpuinfo，容器里就是【宿主机】核数\n",
		runtime.NumCPU())
	fmt.Printf("  GOMAXPROCS         = %d   ← Go 1.25+ 会感知 cgroup 配额，之前不会\n",
		runtime.GOMAXPROCS(0))

	// cgroup v2
	if v, ok := readCgroupInt("/sys/fs/cgroup/cpu.max"); ok {
		fmt.Printf("  cgroup cpu.max     = %-14s ← 真实 CPU 配额", v)
		parts := strings.Fields(v)
		if len(parts) == 2 && parts[0] != "max" {
			quota, _ := strconv.Atoi(parts[0])
			period, _ := strconv.Atoi(parts[1])
			if period > 0 {
				fmt.Printf(" = %.2f 核", float64(quota)/float64(period))
			}
		}
		fmt.Println()
	}
	if v, ok := readCgroupInt("/sys/fs/cgroup/memory.max"); ok {
		display := v
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			display = fmt.Sprintf("%d MB", n>>20)
		}
		fmt.Printf("  cgroup memory.max  = %-14s ← 真实内存上限（free -m 看到的是宿主机）\n", display)
	}
	if v, ok := readCgroupInt("/sys/fs/cgroup/pids.max"); ok {
		fmt.Printf("  cgroup pids.max    = %-14s ← 防 fork bomb 的唯一可靠手段\n", v)
	}
	if _, ok := readCgroupInt("/sys/fs/cgroup/cpu.max"); !ok {
		fmt.Println("  （本环境不在 cgroup v2 统一层级下，或未挂载 —— 容器里跑可看到真实值）")
	}

	fmt.Println(`
  ⚠️ 后果链条：
     /proc 不是 namespace 化的 → nproc/free/top 显示宿主机数据
       → Go 的 GOMAXPROCS 过大(1.25 前) / JVM 堆超 limit / 线程池开太大
       → cgroup 节流 + 调度开销 + OOMKilled
     正解：读 cgroup 文件，别信 /proc；Go 1.25+ 已内置，老版本用 automaxprocs。`)
}

func main() {
	fmt.Printf("pid=%d  Go %s\n\n", os.Getpid(), runtime.Version())
	showLimits()
	raiseNofile()
	demoEMFILE()
	demoContainerView()
}
