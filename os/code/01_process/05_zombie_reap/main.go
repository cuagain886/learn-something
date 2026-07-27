//go:build unix

// 05_zombie_reap — 亲手制造一只僵尸进程，观察它，再收尸
//
// 学什么：
//  1. 僵尸的诞生条件：子进程死了 + 父进程没 Wait —— 缺一不可
//  2. 亲眼看 /proc/<pid>/stat 里的状态变成 Z，理解"死亡证明等人签收"
//  3. Wait 之后僵尸才真正消失，PID 才可复用
//  4. ⚠️ 对僵尸 kill -9 是无效操作——它已经死了，能救它的只有父进程 Wait
//
// 运行：cd os/code && go run ./01_process/05_zombie_reap
package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// stateOf 读 /proc/<pid>/stat 的状态字段（") "后第一个字段）：R/S/D/Z/T
func stateOf(pid int) string {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return "已消失(task_struct 已释放)"
	}
	s := string(raw)
	rp := strings.LastIndexByte(s, ')')
	if rp < 0 || rp+2 >= len(s) {
		return "?"
	}
	return strings.Fields(s[rp+2:])[0]
}

func describe(state string) string {
	switch state {
	case "Z":
		return "Z ← 僵尸！已死但 task_struct 还在，等父进程签收死亡证明"
	case "S":
		return "S (可中断睡眠, 活着)"
	case "R":
		return "R (运行/就绪, 活着)"
	default:
		return state
	}
}

func main() {
	// 子进程 0.5 秒后自然死亡
	cmd := exec.Command("sleep", "0.5")
	if err := cmd.Start(); err != nil {
		panic(err)
	}
	pid := cmd.Process.Pid
	fmt.Printf("① 启动子进程 sleep 0.5 (pid=%d)，当前状态: %s\n", pid, describe(stateOf(pid)))

	// 等它死透，但故意【不】Wait —— 僵尸诞生条件达成
	time.Sleep(1 * time.Second)
	fmt.Printf("② 1 秒后它早已退出，但我们没 Wait，状态: %s\n", describe(stateOf(pid)))
	fmt.Printf("   （此刻另开终端执行 `ps -o pid,stat,cmd -p %d` 会看到 STAT=Z, <defunct>）\n", pid)

	// 演示 kill -9 对僵尸无效
	if p, err := os.FindProcess(pid); err == nil {
		_ = p.Kill()
	}
	time.Sleep(200 * time.Millisecond)
	fmt.Printf("③ 对它 kill -9 之后，状态: %s   ← 没用，死人不会再死一次\n", describe(stateOf(pid)))

	// 唯一正解：父进程 Wait 收尸
	_ = cmd.Wait()
	fmt.Printf("④ cmd.Wait() 之后，状态: %s\n", stateOf(pid))
	fmt.Println("\n结论: Start 必配 Wait（如同 Open 必配 Close）。")
	fmt.Println("      真实服务里大量僵尸堆积时，罪犯永远是【父进程】——修它的代码，")
	fmt.Println("      或杀掉它让僵尸被 init 收养回收。")
}
