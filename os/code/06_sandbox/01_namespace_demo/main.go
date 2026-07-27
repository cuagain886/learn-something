//go:build linux

// 01_namespace_demo — 用 Go 亲手创建 namespace：观察"视野隔离"
//
// 学什么：
//  1. SysProcAttr.Cloneflags 就是 clone() 的 flag —— 容器运行时也是这么干的
//  2. PID namespace: 子进程看到自己是 PID 1，看不见宿主机的进程
//     ⚠️ 必须重新挂载 /proc，否则 ps 读的还是宿主机的 —— 这印证了
//        "/proc 不是 namespace 化的"（第 10 章 §2.7）
//  3. PID 1 的三个特殊性：死则全灭 / 信号语义特殊 / 有收养义务
//
// 运行（需要 root 或有 CAP_SYS_ADMIN）：
//   cd os/code && sudo go run ./06_sandbox/01_namespace_demo
// 非 root 时可以试试 user namespace 模式：
//   go run ./06_sandbox/01_namespace_demo -userns
package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
)

// child 是在新 namespace 里执行的逻辑（通过重新执行自己 + 特殊参数实现）
func child() {
	fmt.Println("========== 我在新的 namespace 里 ==========")
	fmt.Printf("我的 PID:        %d   ← PID namespace 生效的话这里是 1\n", os.Getpid())
	fmt.Printf("我的 PPID:       %d\n", os.Getppid())

	hostname, _ := os.Hostname()
	fmt.Printf("主机名:          %s   ← UTS namespace 隔离\n", hostname)

	// 改主机名：只影响本 namespace，宿主机不受影响
	if err := syscall.Sethostname([]byte("sandbox-demo")); err == nil {
		hostname, _ = os.Hostname()
		fmt.Printf("改成:            %s   ← 宿主机的主机名【不会】变\n", hostname)
	}

	// ⚠️ 关键一步：重新挂载 /proc
	// 不挂的话，ps/top 读的还是宿主机的 /proc，看到的是宿主机全部进程！
	// 这就是 unshare 必须加 --mount-proc 的原因。
	mounted := false
	if err := syscall.Mount("proc", "/proc", "proc",
		uintptr(syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC), ""); err == nil {
		mounted = true
		fmt.Println("已重新挂载 /proc（带 nosuid,nodev,noexec —— Sandbox 三件套）")
	} else {
		fmt.Printf("挂载 /proc 失败: %v（需要 Mount namespace + root）\n", err)
	}

	fmt.Println("\n--- 本 namespace 内可见的进程 ---")
	out, err := exec.Command("ps", "-eo", "pid,ppid,comm").Output()
	if err == nil {
		lines := strings.Split(strings.TrimSpace(string(out)), "\n")
		for _, l := range lines {
			fmt.Println("  " + l)
		}
		fmt.Printf("  → 共 %d 个进程", len(lines)-1)
		if mounted {
			fmt.Println("。宿主机上有几百个，这里只有寥寥几个 —— 这就是隔离 ✅")
		} else {
			fmt.Println("。⚠️ 没挂 /proc 的话这里会显示宿主机的全部进程")
		}
	} else {
		fmt.Printf("  (ps 不可用: %v)\n", err)
	}

	// 演示 PID 1 的收养义务：起一个会变成孤儿的孙进程
	fmt.Println("\n--- PID 1 的收养义务 ---")
	orphan := exec.Command("sh", "-c", "sleep 0.3 & exit 0") // sh 立刻退出，sleep 变孤儿
	if err := orphan.Run(); err == nil {
		fmt.Println("  孤儿进程会被过继给本 namespace 的 PID 1（也就是我）")
		fmt.Println("  ⚠️ 如果我不 wait，它死后就变成僵尸堆在容器里 →")
		fmt.Println("     撞上 pids.max 后任务再也创建不了进程。用 tini/--init 解决。")
	}

	fmt.Println("\n--- User namespace 的 uid 映射 ---")
	fmt.Printf("  容器内 uid=%d gid=%d\n", os.Getuid(), os.Getgid())
	if raw, err := os.ReadFile("/proc/self/uid_map"); err == nil {
		fmt.Printf("  uid_map: %s", raw)
		fmt.Println("  （格式: 容器内起始uid  宿主机起始uid  数量）")
	}
	fmt.Println("========================================")
}

func parent(useUserNS bool) {
	fmt.Println("========== 宿主机视角 ==========")
	hostname, _ := os.Hostname()
	fmt.Printf("我的 PID: %d   主机名: %s   uid: %d\n\n", os.Getpid(), hostname, os.Getuid())

	// 重新执行自己，但带上标记参数，让子进程走 child() 分支
	cmd := exec.Command("/proc/self/exe", "-child")
	cmd.Stdout, cmd.Stderr, cmd.Stdin = os.Stdout, os.Stderr, os.Stdin

	// 这就是容器运行时创建"容器"的核心一行 —— clone 时指定要新建哪些 namespace
	flags := syscall.CLONE_NEWPID | // 进程号空间：子进程成为 PID 1
		syscall.CLONE_NEWUTS | // 主机名
		syscall.CLONE_NEWNS | // 挂载点（才能重新挂 /proc）
		syscall.CLONE_NEWIPC // System V IPC

	cmd.SysProcAttr = &syscall.SysProcAttr{
		Cloneflags: uintptr(flags),
		// 让新挂载的东西不传播回宿主机（否则 /proc 会被改坏）
		Unshareflags: syscall.CLONE_NEWNS,
	}

	if useUserNS {
		// User namespace: 容器内 uid 0 映射到宿主机的当前 uid
		// ⚠️ 这是唯一可以让【非 root】创建其他 namespace 的途径
		cmd.SysProcAttr.Cloneflags |= syscall.CLONE_NEWUSER
		cmd.SysProcAttr.UidMappings = []syscall.SysProcIDMap{
			{ContainerID: 0, HostID: os.Getuid(), Size: 1},
		}
		cmd.SysProcAttr.GidMappings = []syscall.SysProcIDMap{
			{ContainerID: 0, HostID: os.Getgid(), Size: 1},
		}
		cmd.SysProcAttr.GidMappingsEnableSetgroups = false
		fmt.Println("(启用 user namespace：容器内 root 映射为宿主机 uid",
			os.Getuid(), "—— 逃逸的收益被大幅削减)")
	}

	if err := cmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "\n❌ 创建 namespace 失败: %v\n", err)
		fmt.Fprintln(os.Stderr, "   需要 root（sudo）或加 -userns 用 user namespace 模式")
		fmt.Fprintln(os.Stderr, "   某些发行版会限制非特权用户创建 user namespace:")
		fmt.Fprintln(os.Stderr, "   sysctl kernel.unprivileged_userns_clone")
		os.Exit(1)
	}

	// 回到宿主机：验证隔离确实是双向的
	hostname, _ = os.Hostname()
	fmt.Printf("\n宿主机主机名仍然是: %s   ← 子进程改的名字没有泄漏出来 ✅\n", hostname)
	fmt.Println(`
要点回顾:
  1. Cloneflags 就是容器运行时"创建容器"的核心 —— 没有魔法，就是 clone 的参数
  2. /proc 必须在 Mount namespace 里重新挂载，否则 ps 看到的还是宿主机
  3. PID namespace 的三个特性:
     · PID 1 死 → 内核杀光整个 namespace（终止进程树的【终极方案】，第 02 章）
     · PID 1 的信号语义特殊（未注册的信号不投递 → docker stop 慢）
     · PID 1 有收养义务（不 wait 就堆僵尸 → 用 tini / docker run --init）
  4. User namespace 让容器 root 映射成宿主机普通用户 —— 纵深防御的典范`)
}

func main() {
	// 用参数区分父子分支（容器运行时的常见手法：re-exec self）
	if len(os.Args) > 1 && os.Args[1] == "-child" {
		child()
		return
	}
	useUserNS := flag.Bool("userns", false, "启用 user namespace（非 root 可用）")
	flag.Parse()
	parent(*useUserNS)
}
