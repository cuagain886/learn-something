//go:build unix

// 01_basic_exec — 启动子进程：环境控制、退出码与"死因"判定
//
// 学什么：
//  1. exec.Command 的最小正确用法（Start/Wait 必须成对，如同 Open/Close）
//  2. 控制子进程的工作目录（Dir）和环境变量（Env 白名单，而不是继承全部）
//  3. 区分子进程的三种结局：正常退出(拿退出码) / 被信号杀死(拿信号) / 启动失败
//     ⚠️ 被信号杀死时 ExitCode() 返回 -1，必须从 WaitStatus 里取信号——
//     Agent 记录任务死因时混淆这两者，排障时就分不清"程序报错"和"被 OOM Kill"
//
// 运行：cd os/code && go run ./01_process/01_basic_exec
package main

import (
	"errors"
	"fmt"
	"os/exec"
	"syscall"
	"time"
)

// runAndReport 启动一条命令并报告它的完整结局。
// 返回值语义：exitCode >= 0 正常退出；signal != "" 表示被信号杀死。
func runAndReport(name string, arg ...string) {
	cmd := exec.Command(name, arg...)

	// 工作目录：Agent 场景永远显式指定（任务隔离目录），绝不用继承的当前目录
	cmd.Dir = "/tmp"

	// 环境变量白名单：默认继承父进程全部环境（可能含密钥/凭证）。
	// ⚠️ 跑不可信命令时必须收窄成白名单：
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=/tmp", "LANG=C"}

	start := time.Now()
	err := cmd.Run() // Run = Start + Wait，内部保证收尸，不会留僵尸
	cost := time.Since(start).Round(time.Millisecond)

	switch {
	case err == nil:
		// 结局 1：正常退出且退出码为 0
		fmt.Printf("[ok]      %-28s cost=%v exit=0\n", name, cost)

	case isExitError(err):
		ee := err.(*exec.ExitError)
		ws := ee.Sys().(syscall.WaitStatus) // Unix 下必为 WaitStatus
		if ws.Signaled() {
			// 结局 2：被信号杀死。ExitCode() 此时是 -1，没有信息量！
			fmt.Printf("[killed]  %-28s cost=%v signal=%s (shell 视角退出码=%d)\n",
				name, cost, ws.Signal(), 128+int(ws.Signal()))
		} else {
			// 结局 3：程序自己 exit(n)，n != 0
			fmt.Printf("[fail]    %-28s cost=%v exit=%d\n", name, cost, ws.ExitStatus())
		}

	default:
		// 结局 4：根本没启动起来（命令不存在/无权限/Dir 不存在……）
		// ⚠️ 这类错误没有子进程、没有退出码，Agent 要单独归类为"启动失败"
		fmt.Printf("[nostart] %-28s err=%v\n", name, err)
	}
}

func isExitError(err error) bool {
	var ee *exec.ExitError
	return errors.As(err, &ee)
}

func main() {
	fmt.Println("== 子进程的四种结局 ==")

	// 1. 正常成功：exit 0
	runAndReport("sh", "-c", "echo hello >/dev/null")

	// 2. 程序报错：exit 3 —— 工具"自己"失败，日志里应记 exit=3
	runAndReport("sh", "-c", "exit 3")

	// 3. 被信号杀死：子进程给自己发 SIGTERM（$$ 是 sh 自身 PID）
	//    等价于外界 kill 它。注意输出：signal=terminated，shell 视角 143=128+15
	runAndReport("sh", "-c", "kill -TERM $$")

	// 4. 启动失败：命令不存在。注意这和"exit 127"不同——
	//    exit 127 是【shell 找不到命令】，这里是【Go 直接没 fork 成】
	runAndReport("no_such_binary_xyz")

	fmt.Println("\n对照：让 shell 去找不存在的命令（结局是 exit=127 而非 nostart）")
	runAndReport("sh", "-c", "no_such_binary_xyz")
}
