//go:build unix

// 03_timeout_kill — 超时终止：从"默认 Kill"到"TERM → 宽限 → KILL"分级击杀
//
// 学什么：
//  1. exec.CommandContext 的默认行为：ctx 到期 → os.Process.Kill()
//     ⚠️ 两个不足：a) SIGKILL 不给子进程任何清理机会  b) 只杀直接子进程，不杀孙进程
//  2. 生产级姿势（Go 1.20+）：
//     - SysProcAttr.Setpgid    → 子进程自立进程组（后代全在组里）
//     - cmd.Cancel             → ctx 到期时先给【整组】发 SIGTERM（商量）
//     - cmd.WaitDelay          → 宽限期过后强杀 + 放弃管道（处决 + 防泄漏）
//  3. 用一个"无赖子进程"（trap 忽略 TERM）验证 KILL 兜底真的会咬人
//
// 运行：cd os/code && go run ./01_process/03_timeout_kill
package main

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"syscall"
	"time"
)

// runWithTimeout 是可以直接抄进项目的模板：
// 超时/取消后先礼后兵——SIGTERM 发给整个进程组，宽限 grace 后 SIGKILL 兜底。
func runWithTimeout(parent context.Context, timeout, grace time.Duration, script string) error {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "sh", "-c", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // 自立门户：后代同组

	// Cancel: ctx 到期时干什么。默认是 Kill(直接子进程)；换成"整组 SIGTERM"。
	cmd.Cancel = func() error {
		// 负 PID = 发给整个进程组；Setpgid 后 PGID == 子进程 PID
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
		if errors.Is(err, syscall.ESRCH) { // 组已不存在 = 已经退干净了
			return nil
		}
		return err
	}

	// WaitDelay: Cancel 之后再等多久。到点 runtime 会 SIGKILL 子进程并放弃 I/O 管道，
	// 保证 Wait 一定能返回（哪怕孙进程还占着管道写端）。
	cmd.WaitDelay = grace

	out, err := cmd.CombinedOutput() // 演示从简；生产用 02 示例的流式排水
	fmt.Printf("   输出: %q\n", string(out))

	// 兜底：WaitDelay 的 SIGKILL 只发给直接子进程，孙进程可能还活着——
	// 最后再对整组补一枪 KILL（组里没人时 ESRCH，无害）。
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	return err
}

func main() {
	fmt.Println("== 场景 1：听话的子进程，SIGTERM 阶段就体面退出 ==")
	// trap 捕获 TERM：打印遗言、清理、退出——这就是"给清理机会"的意义
	polite := `trap 'echo "[child] 收到 TERM, 清理临时文件后退出"; exit 143' TERM
echo "[child] 干活中..."
sleep 30`
	start := time.Now()
	err := runWithTimeout(context.Background(), 2*time.Second, 3*time.Second, polite)
	fmt.Printf("   结果: err=%v, 耗时=%v (≈2s, TERM 阶段解决)\n\n",
		err, time.Since(start).Round(100*time.Millisecond))

	fmt.Println("== 场景 2：无赖子进程忽略 TERM，宽限期后被 KILL 处决 ==")
	// ⚠️ 注意脚本写法：不能用一句 `sleep 30`——群发的 TERM 会先杀死 sleep（孙进程），
	// sh 反而顺利跑完脚本"正常退出"，演示不出 KILL。让 sh 循环重启短 sleep，
	// 它才能真正"扛过" TERM 活到被 KILL。
	stubborn := `trap '' TERM        # 无赖：忽略 SIGTERM
echo "[child] 我不听 TERM"
while :; do sleep 1; done`
	start = time.Now()
	err = runWithTimeout(context.Background(), 2*time.Second, 3*time.Second, stubborn)
	fmt.Printf("   结果: err=%v, 耗时=%v (≈2s+3s: TERM 无效, WaitDelay 到点 KILL)\n\n",
		err, time.Since(start).Round(100*time.Millisecond))

	fmt.Println("== 场景 3：正常完成，超时机制零打扰 ==")
	start = time.Now()
	err = runWithTimeout(context.Background(), 5*time.Second, 3*time.Second,
		`echo "[child] 秒完成"`)
	fmt.Printf("   结果: err=%v, 耗时=%v\n", err, time.Since(start).Round(10*time.Millisecond))

	// ⚠️ 用户取消和超时是同一条路径：把 context.WithTimeout 换成 WithCancel，
	// 用户点"停止"时调 cancel()，后面的 TERM→宽限→KILL 一模一样。
	// 不要为取消另写一套杀进程逻辑——两套逻辑必有一套没测过。
}
