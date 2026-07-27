//go:build linux

// 01_fd_leak — 三种 fd 泄漏：构造、探测、修复
//
// 学什么：
//  1. 用 /proc/self/fd 数 fd —— 这就是 `lsof -p` 和 `ls /proc/<pid>/fd | wc -l` 的原理
//  2. 三种泄漏路径：错误路径提前 return / 循环里 defer / HTTP body 不关
//  3. ⚠️ 泄漏的共同特征：函数返回了，fd 还开着，且再也没有引用能关掉它
//     —— 和 goroutine 泄漏一样，本质是"没有可达的释放路径"
//
// 运行：cd os/code && go run ./04_io/01_fd_leak   （仅 Linux/WSL2）
package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// fdCount 数当前进程打开的 fd 数量。
// /proc/self/fd 是个特殊目录，每个 fd 一个符号链接，指向它打开的东西。
func fdCount() int {
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		return -1
	}
	return len(entries) - 1 // 减 1: ReadDir 自己打开这个目录也占一个 fd
}

// listFds 打印 fd → 目标的映射，看清楚泄漏的是什么
func listFds(limit int) {
	entries, _ := os.ReadDir("/proc/self/fd")
	for i, e := range entries {
		if i >= limit {
			fmt.Printf("     ... 还有 %d 个\n", len(entries)-limit)
			break
		}
		target, _ := os.Readlink(filepath.Join("/proc/self/fd", e.Name()))
		fmt.Printf("     fd %-3s → %s\n", e.Name(), target)
	}
}

func mkTempFile() string {
	f, err := os.CreateTemp("", "fdlab-*")
	if err != nil {
		panic(err)
	}
	f.WriteString("hello fd\n")
	f.Close()
	return f.Name()
}

// ---- 泄漏 1: 错误路径提前 return -----------------------------------------

// ⚠️ 错误版：Close 写在最后一行，任何提前 return 都会跳过它
func readBuggy(path string, simulateErr bool) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	if simulateErr {
		return fmt.Errorf("模拟处理失败") // ← f 泄漏！Close 在下面，永远执行不到
	}
	io.ReadAll(f)
	f.Close()
	return nil
}

// ✅ 修复版：defer 紧跟 open 成功之后 —— 无论从哪条路径返回都会执行
func readFixed(path string, simulateErr bool) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close() // 这一行的位置就是全部要点
	if simulateErr {
		return fmt.Errorf("模拟处理失败")
	}
	_, err = io.ReadAll(f)
	return err
}

// ---- 泄漏 2: 循环里 defer -------------------------------------------------

// ⚠️ 错误版：defer 绑定的是【函数】作用域，不是循环体
func loopBuggy(paths []string) {
	for _, p := range paths {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		defer f.Close() // ← 全部堆到函数结束才关；循环 10000 次就同时开 10000 个
		io.ReadAll(f)
	}
	// 只有到这里才开始逐个 Close —— 期间 fd 峰值 = 文件数
}

// ✅ 修复版：用闭包/独立函数把每次迭代变成一个函数作用域
func loopFixed(paths []string) {
	for _, p := range paths {
		func() { // 立即执行的闭包 —— defer 在每次迭代结束时生效
			f, err := os.Open(p)
			if err != nil {
				return
			}
			defer f.Close()
			io.ReadAll(f)
		}()
	}
}

func demo(name string, fn func()) {
	before := fdCount()
	fn()
	after := fdCount()
	verdict := "✅ 无泄漏"
	if after > before {
		verdict = fmt.Sprintf("⚠️ 泄漏 %d 个 fd!", after-before)
	}
	fmt.Printf("  %-38s fd: %d → %d   %s\n", name, before, after, verdict)
}

func main() {
	path := mkTempFile()
	defer os.Remove(path)

	fmt.Printf("== 启动时的 fd (基线 %d 个) ==\n", fdCount())
	listFds(5)

	fmt.Println("\n== 泄漏 1: 错误路径提前 return（各调用 20 次）==")
	demo("readBuggy(模拟失败)", func() {
		for i := 0; i < 20; i++ {
			readBuggy(path, true)
		}
	})
	demo("readFixed(模拟失败)", func() {
		for i := 0; i < 20; i++ {
			readFixed(path, true)
		}
	})

	fmt.Println("\n== 泄漏 2: 循环里 defer（20 个文件）==")
	paths := make([]string, 20)
	for i := range paths {
		paths[i] = path
	}
	demo("loopBuggy(峰值 fd 高)", func() { loopBuggy(paths) })
	demo("loopFixed", func() { loopFixed(paths) })
	fmt.Println("     注: loopBuggy 函数【返回后】fd 会释放，但【运行期间】峰值 = 文件数，")
	fmt.Println("        处理一万个文件时就会撞上 ulimit -n。")

	fmt.Println("\n== 当前泄漏现场（readBuggy 泄漏的 fd 还开着）==")
	listFds(8)

	fmt.Println(`
生产排查:
  ls /proc/<pid>/fd | wc -l              # 当前 fd 数
  cat /proc/<pid>/limits | grep files    # 上限
  lsof -p <pid> | awk '{print $5}' | sort | uniq -c | sort -rn   # 按类型: REG? sock?
  lsof -p <pid> | awk '{print $9}' | sort | uniq -c | sort -rn   # 哪个目标最多
⚠️ 大量 socket 处于 CLOSE_WAIT = 对端已关而我方没 Close，最常见是 HTTP body 未关。`)
}
