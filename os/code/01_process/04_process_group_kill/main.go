//go:build unix

// 04_process_group_kill — 复现"杀了 bash，python 还活着"，再用进程组整树击杀
//
// 学什么：
//  1. 亲手复现 Agent 最经典的泄漏：kill 只打中直接子进程(sh)，
//     它 fork 的孙进程(sleep, 模拟 python)变成孤儿继续跑
//  2. 修复：Setpgid 让子进程自立进程组 → kill(-PGID) 信号群发全组
//  3. 学会"验尸"：扫 /proc 按 PGID 找幸存者——Runner 结束后这一步应该为空
//
// 运行：cd os/code && go run ./01_process/04_process_group_kill
package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// procsInGroup 扫描 /proc，返回属于指定进程组的所有 (pid, comm)。
// /proc/<pid>/stat 第 5 个字段是 PGID（第 2 字段 comm 可能含空格，要先剥掉）。
func procsInGroup(pgid int) []string {
	var out []string
	entries, _ := os.ReadDir("/proc")
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue // 不是数字目录
		}
		raw, err := os.ReadFile(filepath.Join("/proc", e.Name(), "stat"))
		if err != nil {
			continue // 进程刚好退出，正常
		}
		s := string(raw)
		rp := strings.LastIndexByte(s, ')') // comm 以 ") " 结束，从它后面切字段
		if rp < 0 {
			continue
		}
		fields := strings.Fields(s[rp+2:]) // fields[0]=state fields[1]=ppid fields[2]=pgid
		if len(fields) < 3 {
			continue
		}
		if g, _ := strconv.Atoi(fields[2]); g == pgid {
			comm := s[strings.IndexByte(s, '(')+1 : rp]
			out = append(out, fmt.Sprintf("pid=%d(%s)", pid, comm))
		}
	}
	return out
}

// childPidOf 从子进程 stdout 里读一行它汇报的孙进程 PID
func childPidOf(r *bufio.Scanner) int {
	if r.Scan() {
		if pid, err := strconv.Atoi(strings.TrimSpace(r.Text())); err == nil {
			return pid
		}
	}
	return 0
}

// 三级进程树脚本：sh(我们 kill 的目标) → sleep(模拟 python 工具，孙进程)
// `$!` 是 sh 最近一个后台子进程的 PID——它先汇报孙进程 PID 再等待。
const script = `sleep 300 &
echo $!
wait`

func demoBuggy() {
	fmt.Println("== 复现事故：kill 只打中 sh，孙进程 sleep 逃生 ==")
	cmd := exec.Command("sh", "-c", script)
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		panic(err)
	}
	grandchild := childPidOf(bufio.NewScanner(stdout))
	fmt.Printf("   进程树: agent(%d) → sh(%d) → sleep(%d)\n",
		os.Getpid(), cmd.Process.Pid, grandchild)

	_ = cmd.Process.Kill() // ⚠️ 事故写法: 等价 kill(sh_pid, SIGKILL)，只杀 sh
	_ = cmd.Wait()
	time.Sleep(200 * time.Millisecond)

	if err := syscall.Kill(grandchild, 0); err == nil { // 信号 0 = 只探活不打击
		var ppid string
		if raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", grandchild)); err == nil {
			rp := strings.LastIndexByte(string(raw), ')')
			ppid = strings.Fields(string(raw)[rp+2:])[1]
		}
		fmt.Printf("   ⚠️ sh 死了，但 sleep(%d) 还活着！新 PPID=%s（被 init 收养成孤儿）\n",
			grandchild, ppid)
		fmt.Println("   —— 这就是\"任务取消了，python 还在烧 CPU\"的现场")
		_ = syscall.Kill(grandchild, syscall.SIGKILL) // 收拾现场
	} else {
		fmt.Println("   (本环境下孙进程未存活，少见，可能 shell 行为差异)")
	}
	fmt.Println()
}

func demoFixed() {
	fmt.Println("== 修复：Setpgid 自立进程组 + kill(-PGID) 整组击杀 ==")
	cmd := exec.Command("sh", "-c", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // 关键一行
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		panic(err)
	}
	grandchild := childPidOf(bufio.NewScanner(stdout))
	pgid := cmd.Process.Pid // Setpgid 后：PGID == 子进程 PID

	fmt.Printf("   进程树: agent(%d) → sh(%d) → sleep(%d)，独立进程组 PGID=%d\n",
		os.Getpid(), cmd.Process.Pid, grandchild, pgid)
	fmt.Printf("   击杀前组内成员: %v\n", procsInGroup(pgid))

	// 生产中这里是 TERM → 宽限 → KILL（见 03 示例）；demo 直接 KILL 展示"整组"效果
	_ = syscall.Kill(-pgid, syscall.SIGKILL) // 负号 = 群发整组
	_ = cmd.Wait()
	time.Sleep(200 * time.Millisecond)

	fmt.Printf("   击杀后组内成员: %v  ← 验尸：必须为空\n", procsInGroup(pgid))
	fmt.Println("   sh 和 sleep 一个都没跑掉。Runner 每次任务结束都该做这个验尸检查。")
}

func main() {
	demoBuggy()
	demoFixed()
}
