// 01_syscall_cost — 系统调用的成本量表：把"贵"变成可测量的数字
//
// 学什么：
//  1. 量化四种典型开销：无缓冲 write vs bufio、逐字节读 vs 分块读、
//     fork+exec vs 函数调用、fsync 开关
//  2. 每个场景都打印【syscall 次数估算】——性能优化的本质是【减少次数】，
//     而不是让单次更快
//  3. ⚠️ 配合 strace -c 验证：go build -o /tmp/sc . && strace -c /tmp/sc
//     看 write/read/clone 的实际 calls 数，和这里的估算对得上
//
// 运行：cd os/code && go run ./05_profiling/01_syscall_cost
package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

const dataSize = 4 << 20 // 4MB 测试数据

func timeIt(label string, syscallEstimate int, fn func()) time.Duration {
	start := time.Now()
	fn()
	d := time.Since(start)
	perCall := "—"
	if syscallEstimate > 0 {
		perCall = fmt.Sprintf("%.2f μs", float64(d.Microseconds())/float64(syscallEstimate))
	}
	fmt.Printf("  %-38s %8v   syscall≈%-8d 每次≈%s\n", label, d.Round(time.Microsecond), syscallEstimate, perCall)
	return d
}

// ---- ① 小写 vs 缓冲写 ----------------------------------------------------

func demoWriteBuffering(dir string) {
	fmt.Println("== ① 写 4MB：写入粒度决定一切 ==")
	data := make([]byte, dataSize)

	// ⚠️ 最坏情况：每次 write 4 字节 —— 这就是"无缓冲日志"的极端形态
	small := timeIt("每次 write 4 字节", dataSize/4, func() {
		f, _ := os.Create(filepath.Join(dir, "a.bin"))
		defer f.Close()
		for i := 0; i < dataSize; i += 4 {
			f.Write(data[i : i+4]) // 每次一个 syscall
		}
	})

	// 中等：每次 4KB（一页）
	timeIt("每次 write 4KB", dataSize/4096, func() {
		f, _ := os.Create(filepath.Join(dir, "b.bin"))
		defer f.Close()
		for i := 0; i < dataSize; i += 4096 {
			f.Write(data[i : i+4096])
		}
	})

	// ✅ 正确：bufio 攒批，默认 4KB 缓冲（这里设 64KB 更明显）
	buffered := timeIt("bufio 64KB 缓冲", dataSize/(64*1024), func() {
		f, _ := os.Create(filepath.Join(dir, "c.bin"))
		defer f.Close()
		w := bufio.NewWriterSize(f, 64*1024)
		defer w.Flush() // ⚠️ 绝不能忘：缓冲里的数据还没进内核
		for i := 0; i < dataSize; i += 4 {
			w.Write(data[i : i+4]) // 写进用户态缓冲，不是 syscall
		}
	})

	fmt.Printf("  → 4 字节 vs bufio 差 %.0f 倍。差的不是搬运速度，是 syscall 次数。\n\n",
		float64(small)/float64(buffered))
}

// ---- ② 小读 vs 分块读 ----------------------------------------------------

func demoReadBuffering(dir string) {
	fmt.Println("== ② 读 4MB：同样的道理 ==")
	path := filepath.Join(dir, "c.bin")

	timeIt("每次 read 16 字节", dataSize/16, func() {
		f, _ := os.Open(path)
		defer f.Close()
		buf := make([]byte, 16)
		for {
			if _, err := f.Read(buf); err != nil {
				break
			}
		}
	})

	timeIt("bufio.Scanner(默认缓冲)", dataSize/(64*1024), func() {
		f, _ := os.Open(path)
		defer f.Close()
		r := bufio.NewReaderSize(f, 64*1024)
		io.Copy(io.Discard, r)
	})

	timeIt("os.ReadFile(一次性)", 4, func() {
		os.ReadFile(path) // open + fstat + 若干大 read + close
	})
	fmt.Println("  → ⚠️ ReadFile 快但把整个文件读进内存：4MB 可以，4GB 就是 OOM(第06章)")
	fmt.Println()
}

// ---- ③ fsync 的代价 -------------------------------------------------------

func demoFsync(dir string) {
	fmt.Println("== ③ fsync：write 只到 Page Cache，fsync 才到磁盘 ==")
	const n = 200
	line := []byte("2026-07-26 12:00:00 INFO 一条典型的日志\n")

	timeIt(fmt.Sprintf("写 %d 条不 fsync", n), n, func() {
		f, _ := os.Create(filepath.Join(dir, "log1.txt"))
		defer f.Close()
		for i := 0; i < n; i++ {
			f.Write(line)
		}
	})

	timeIt(fmt.Sprintf("写 %d 条每条 fsync", n), n*2, func() {
		f, _ := os.Create(filepath.Join(dir, "log2.txt"))
		defer f.Close()
		for i := 0; i < n; i++ {
			f.Write(line)
			f.Sync() // ⚠️ 真正落盘，SSD 上 ~0.1-1ms，HDD 更慢
		}
	})
	fmt.Println("  → 这就是数据库写入延迟的物理下限。业务日志用第一档，交易流水用第二档。")
	fmt.Println()
}

// ---- ④ 起进程 vs 函数调用 -------------------------------------------------

func trivialFunc(n int) int { return n * 2 }

func demoProcessCost() {
	fmt.Println("== ④ fork+exec：Agent 最该关心的一笔账 ==")
	const n = 30

	timeIt(fmt.Sprintf("%d 次函数调用", n), 0, func() {
		for i := 0; i < n; i++ {
			_ = trivialFunc(i)
		}
	})

	procTime := timeIt(fmt.Sprintf("%d 次 exec(/bin/true)", n), n*3, func() {
		for i := 0; i < n; i++ {
			exec.Command("/bin/true").Run() // clone + execve + wait4
		}
	})

	fmt.Printf("  → 单次起进程 ≈ %v。函数调用 ≈ 1ns —— 差约百万倍。\n",
		(procTime / n).Round(time.Microsecond))
	fmt.Println(`  ⚠️ Agent 推论:
     · 一次工具调用付 ~1ms 固定成本：可接受
     · 循环里对每行数据起一个进程：1 万行 = 10 秒纯开销 → 改批处理/库调用
     · Python 解释器启动 ~30-100ms，比 fork 本身贵一个数量级 → 用常驻 worker`)
	fmt.Println()
}

func main() {
	dir, err := os.MkdirTemp("", "syscall-cost-*")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(dir)

	fmt.Printf("测试目录: %s (pid=%d)\n\n", dir, os.Getpid())

	demoWriteBuffering(dir)
	demoReadBuffering(dir)
	demoFsync(dir)
	if _, err := os.Stat("/bin/true"); err == nil {
		demoProcessCost()
	} else {
		fmt.Println("== ④ 跳过(本环境无 /bin/true) ==")
	}

	fmt.Println(`验证方式:
  go build -o /tmp/sc ./05_profiling/01_syscall_cost && strace -c -f /tmp/sc
  对照 calls 列与上面的 syscall 估算 —— 数量级应当吻合。

统一结论: 优化 I/O 的手段永远是【减少 syscall 次数】(缓冲/批量/复用)，
         而不是指望单次调用变快。这条规律贯穿日志、网络、数据库、进程管理。`)
}
