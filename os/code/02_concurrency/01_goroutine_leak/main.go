// 01_goroutine_leak — 三种经典 goroutine 泄漏：构造、探测、修复
//
// 学什么：
//  1. 亲手制造三种最常见的泄漏：卡死的发送者 / 永不结束的 range / 没有超时的阻塞调用
//  2. 探测手法：runtime.NumGoroutine() 水位对比 + pprof 风格的创建栈聚类
//  3. 修复三板斧：带 ctx 的 select、谁生产谁 close、一切阻塞 I/O 都要超时
//     ⚠️ 泄漏的本质只有一句话：这个 goroutine 没有可达的退出路径
//
// 运行：cd os/code && go run ./02_concurrency/01_goroutine_leak
// （本示例跨平台，可在 Windows 直接跑）
package main

import (
	"context"
	"fmt"
	"runtime"
	"time"
)

func baseline() int { return runtime.NumGoroutine() }

// ---- 泄漏 1: 发送者卡死 --------------------------------------------------

// ⚠️ 错误版：worker 算完往无缓冲 channel 发结果，但调用方超时后已经不收了
func leakySender() {
	result := make(chan int) // 无缓冲：收发必须碰头
	go func() {
		v := slowCompute()
		result <- v // 调用方早跑了，这里永远碰不上头 → G 卡死在 send
	}()
	select {
	case v := <-result:
		_ = v
	case <-time.After(50 * time.Millisecond): // 超时放弃——但没人通知 worker
	}
}

// ✅ 修复版：容量 1 的缓冲让发送"放下就走"，G 自然退出
func fixedSender() {
	result := make(chan int, 1) // 关键：即使没人收，send 也不阻塞
	go func() { result <- slowCompute() }()
	select {
	case v := <-result:
		_ = v
	case <-time.After(50 * time.Millisecond):
	} // worker 稍后写入缓冲并退出；channel 无人引用后连同缓冲被 GC
}

// ---- 泄漏 2: range 一个永不 close 的 channel ------------------------------

// ⚠️ 错误版：生产者退出时没有 close，消费者 range 永远等下一个
func leakyRange() {
	ch := make(chan int)
	go func() { // 消费者
		for v := range ch { // close 之前这个循环不会结束
			_ = v
		}
	}()
	go func() { // 生产者
		for i := 0; i < 3; i++ {
			ch <- i
		}
		// 忘了 close(ch) → 消费者 G 永久泄漏
	}()
	time.Sleep(20 * time.Millisecond)
}

// ✅ 修复版：谁生产，谁负责关门
func fixedRange() {
	ch := make(chan int)
	go func() {
		for v := range ch {
			_ = v
		}
	}()
	go func() {
		defer close(ch) // 生产者退出即关门 → range 结束 → 消费者退出
		for i := 0; i < 3; i++ {
			ch <- i
		}
	}()
	time.Sleep(20 * time.Millisecond)
}

// ---- 泄漏 3: 没有取消手段的阻塞调用 ---------------------------------------

// ⚠️ 错误版：模拟一个永不返回的"远端调用"，goroutine 陪它耗一辈子
func leakyBlocking() {
	go func() {
		<-make(chan struct{}) // 模拟: 无超时的 http.Get / 数据库查询 / 锁等待
	}()
}

// ✅ 修复版：一切可能阻塞的操作都给 ctx / 超时留后门
func fixedBlocking() {
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	go func() {
		defer cancel()
		select {
		case <-make(chan struct{}): // 真实代码: req = req.WithContext(ctx)
		case <-ctx.Done(): // 超时/取消 → 有退出路径了
		}
	}()
	time.Sleep(80 * time.Millisecond)
}

func slowCompute() int { time.Sleep(200 * time.Millisecond); return 42 }

func demo(name string, n int, f func()) {
	before := baseline()
	for i := 0; i < n; i++ {
		f()
	}
	time.Sleep(300 * time.Millisecond) // 给"该退出的 G"留退出时间
	runtime.GC()
	after := baseline()
	verdict := "✅ 无泄漏"
	if after-before >= n { // 每次调用净剩 ≥1 个 G，就是泄漏
		verdict = fmt.Sprintf("⚠️ 泄漏! 净增 %d 个 goroutine", after-before)
	}
	fmt.Printf("%-16s 调用%d次: %d → %d  %s\n", name, n, before, after, verdict)
}

func main() {
	fmt.Println("== 用 NumGoroutine 水位对比探测泄漏（每种模式调用 10 次）==")
	demo("leakySender", 10, leakySender)
	demo("fixedSender", 10, fixedSender)
	demo("leakyRange", 10, leakyRange)
	demo("fixedRange", 10, fixedRange)
	demo("leakyBlocking", 10, leakyBlocking)
	demo("fixedBlocking", 10, fixedBlocking)

	fmt.Println("\n== 泄漏现场取证：按创建栈看所有存活 G（pprof debug=1 的原理）==")
	buf := make([]byte, 1<<20)
	n := runtime.Stack(buf, true) // true = 全部 goroutine
	fmt.Printf("(栈 dump 共 %d 字节, 前 600 字节预览)\n%s...\n", n, buf[:600])
	fmt.Println("生产环境用 /debug/pprof/goroutine?debug=1 按创建点聚合计数，")
	fmt.Println("隔 10 分钟采两次，【净增长】所在的栈就是泄漏点。")
}
