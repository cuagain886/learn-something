/*
═══════════════════════════════════════════════════════════════════

	17_context —— context：取消信号与超时的标准传播方式

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. context 解决什么问题：优雅地"叫停"一棵 goroutine 调用树
 2. WithCancel：手动取消
 3. WithTimeout / WithDeadline：超时自动取消
 4. ctx.Done() / ctx.Err() 的标准用法
 5. 防止 goroutine 泄漏

【运行】go run ./17_context

【为什么重要】

	goroutine 没有外部"杀死"机制 —— 只能它自己检查信号后主动退出。
	context.Context 就是整个 Go 生态统一的"信号载体"：
	HTTP 请求处理、数据库查询、RPC 调用……所有标准库和主流框架的
	阻塞型 API 第一个参数都是 ctx。服务端开发天天和它打交道。

【惯例】
  - ctx 永远是函数的【第一个参数】，命名就叫 ctx
  - 不要把 ctx 存进结构体字段（随调用链显式传递）
  - cancel 函数拿到后必须调用（defer cancel()），否则泄漏资源
*/
package main

import (
	"context"
	"errors"
	"fmt"
	"time"
)

func main() {
	fmt.Println("══════ 1. WithCancel：手动喊停 ══════")
	// context.Background() 是根 context：空白、永不取消，一切 ctx 的祖先
	// WithCancel 从父 ctx 派生出【可取消】的子 ctx + 一个 cancel 函数
	ctx, cancel := context.WithCancel(context.Background())

	// 启动一个一直干活的 goroutine，把 ctx 传给它
	go workLoop(ctx, "打工人A")

	time.Sleep(180 * time.Millisecond) // 让它干一会儿
	fmt.Println("老板：下班了！")
	cancel()                          // ★ 广播取消信号：所有持有这个 ctx（及其子 ctx）的人都能收到
	time.Sleep(50 * time.Millisecond) // 给 goroutine 一点时间打印退出日志

	fmt.Println("\n══════ 2. WithTimeout：超时自动取消 ══════")
	// 超过 100ms 自动触发取消 —— 最常见的用法（外部调用必设超时！）
	ctx2, cancel2 := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel2() // ★ 惯例：拿到 cancel 立刻 defer。即使超时自动触发了，
	//                 显式调用也能提前释放计时器资源，永远写上它

	// 模拟一个需要 300ms 的慢操作 —— 必然超时
	result, err := slowOperation(ctx2, 300*time.Millisecond)
	if err != nil {
		fmt.Println("操作失败:", err) // context deadline exceeded
		// 标准判别方式：用 errors.Is 区分"超时"还是"被手动取消"
		fmt.Println("  是超时吗?", errors.Is(err, context.DeadlineExceeded)) // true
		fmt.Println("  是手动取消吗?", errors.Is(err, context.Canceled))       // false
	} else {
		fmt.Println("操作成功:", result)
	}

	// 同样的操作，时间充裕时就能成功
	ctx3, cancel3 := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel3()
	result, err = slowOperation(ctx3, 50*time.Millisecond) // 50ms < 200ms
	fmt.Println("快操作:", result, err)                       // 成功 <nil>

	// WithDeadline 与 WithTimeout 等价，只是参数是"绝对时刻"而非"时长"：
	//   context.WithDeadline(parent, time.Now().Add(100*time.Millisecond))

	fmt.Println("\n══════ 3. 取消信号沿调用树传播 ══════")
	// 从一个 ctx 派生的所有子孙 ctx，会在父辈取消时【一起】被取消。
	// 模拟：处理请求 -> 并行查数据库 + 调外部 API，请求超时则全体撤退
	reqCtx, reqCancel := context.WithTimeout(context.Background(), 120*time.Millisecond)
	defer reqCancel()
	handleRequest(reqCtx)

	fmt.Println("\n══════ 4. goroutine 泄漏与防治 ══════")
	// ⚠️ 泄漏：goroutine 阻塞在没人收的通道上，永远无法退出，内存只增不减
	//
	//   leaky := func() <-chan int {
	//       ch := make(chan int)
	//       go func() { ch <- expensiveCompute() }() // 若调用方放弃接收……
	//       return ch                                 // 这个 goroutine 卡死一辈子
	//   }
	//
	// 防治公式：凡是可能阻塞的发送/接收，都用 select 加一条 ctx.Done() 退路
	ctx4, cancel4 := context.WithCancel(context.Background())
	ch := safeProducer(ctx4) // 带逃生通道的生产者
	fmt.Println("收一个值:", <-ch)
	cancel4() // 不想要了 —— 生产者会从 Done 分支安全退出，不泄漏
	time.Sleep(30 * time.Millisecond)

	fmt.Println("\n══════ 小结 ══════")
	fmt.Println(`  Background()        根 ctx，main/初始化处使用
  WithCancel(p)       手动取消
  WithTimeout(p, d)   d 时长后自动取消 ★最常用
  WithDeadline(p, t)  到时刻 t 自动取消
  <-ctx.Done()        在 select 中监听取消信号
  ctx.Err()           取消原因：Canceled / DeadlineExceeded
  规矩：ctx 放第一参；defer cancel()；阻塞操作必配 Done 退路`)
}

// workLoop 模拟常驻工作循环：每轮干一点活，同时监听取消信号
// ★ 这是"响应取消"的标准模板
func workLoop(ctx context.Context, name string) {
	for i := 1; ; i++ {
		select {
		case <-ctx.Done():
			// Done() 返回一个通道：ctx 被取消时该通道被关闭 => 此分支就绪
			// Err() 说明取消原因
			fmt.Printf("  %s 收到信号(%v)，清理现场，退出\n", name, ctx.Err())
			return // ★ 自己主动 return —— 没有人能从外部杀死 goroutine
		case <-time.After(50 * time.Millisecond): // 模拟一轮工作的耗时
			fmt.Printf("  %s 完成第 %d 轮工作\n", name, i)
		}
	}
}

// slowOperation 模拟一个"可被取消的耗时操作"
// 真实世界里 http.NewRequestWithContext / db.QueryContext 内部就是这种结构
func slowOperation(ctx context.Context, cost time.Duration) (string, error) {
	select {
	case <-time.After(cost): // 模拟干活干了 cost 这么久
		return "操作结果数据", nil
	case <-ctx.Done(): // 干到一半 ctx 先到期/被取消
		return "", ctx.Err() // 把取消原因作为错误返回 ★标准写法
	}
}

// handleRequest 模拟服务端处理一个请求：并行做两件子任务，
// 共享同一个 ctx —— 请求超时则两个子任务一起被取消
func handleRequest(ctx context.Context) {
	dbCh := make(chan string, 1) // 容量 1：就算没人收，发送也不阻塞（防泄漏小技巧）
	apiCh := make(chan string, 1)

	go func() { // 子任务一：查数据库（模拟 60ms，能赶上）
		if r, err := slowOperation(ctx, 60*time.Millisecond); err == nil {
			dbCh <- "DB:" + r
		} else {
			dbCh <- "DB失败:" + err.Error()
		}
	}()
	go func() { // 子任务二：调外部 API（模拟 500ms，必超时）
		if r, err := slowOperation(ctx, 500*time.Millisecond); err == nil {
			apiCh <- "API:" + r
		} else {
			apiCh <- "API失败:" + err.Error()
		}
	}()

	fmt.Println(" ", <-dbCh)  // 60ms 时返回成功
	fmt.Println(" ", <-apiCh) // 120ms 时 ctx 超时，被一起取消
}

// safeProducer 不会泄漏的生产者：每次发送都带 ctx.Done() 逃生口
func safeProducer(ctx context.Context) <-chan int {
	ch := make(chan int)
	go func() {
		defer close(ch) // 退出时关闭通道，通知下游
		for i := 1; ; i++ {
			select {
			case ch <- i * 7: // 正常发送（可能阻塞等接收方）
			case <-ctx.Done(): // 阻塞期间若被取消，从这里逃生
				fmt.Println("  生产者安全退出:", ctx.Err())
				return
			}
		}
	}()
	return ch
}
