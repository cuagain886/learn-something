/*
═══════════════════════════════════════════════════════════════════

	15_goroutines —— 并发入门：goroutine 与 sync 包

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. goroutine：go 关键字一键并发
 2. sync.WaitGroup：等待一批 goroutine 全部完成
 3. 竞态条件（race condition）与 sync.Mutex 互斥锁
 4. sync.Once、原子操作 atomic 一瞥

【运行】

	go run ./15_goroutines
	go run -race ./15_goroutines   ★ 加 -race 开启竞态检测器（强烈建议跑一次）

【为什么 Go 以并发闻名】
  - goroutine 是 Go 运行时调度的"轻量线程"：初始栈仅 2KB（线程约 1MB），
    创建销毁极廉价，开十万个不眨眼；运行时把它们复用到少量 OS 线程上
  - 语法层面只需要一个 go 关键字，没有线程池样板代码
  - 配套哲学："不要通过共享内存来通信，而要通过通信来共享内存"
    ——channel（下一节）是主角，本节的锁是配角
*/
package main

import (
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

func main() {
	fmt.Println("══════ 1. 启动 goroutine：go 关键字 ══════")
	// 在任何函数调用前加 go，它就在一个新 goroutine 里【异步】执行，
	// 主流程不等它，立刻继续往下走
	go say("世界") // 并发执行
	say("你好")    // 当前 goroutine（main）同步执行

	// ⚠️ 陷阱：main 函数返回时【整个程序立即退出】，
	// 不管还有多少 goroutine 没跑完——它们会被直接掐死。
	// 上面 go say("世界") 能打印出来，纯粹因为 say("你好") 的 Sleep
	// 给了它运行时间。真实代码绝不能靠 Sleep 同步！下面看正确做法。

	fmt.Println("\n══════ 2. sync.WaitGroup：等大家干完活 ══════")
	// WaitGroup 是一个并发安全的计数器：
	//   Add(n) 计数 +n（启动前调用）
	//   Done() 计数 -1（goroutine 结束时调用）
	//   Wait() 阻塞直到计数归零
	var wg sync.WaitGroup

	for i := 1; i <= 3; i++ {
		wg.Add(1) // ★ 必须在 go 之前 Add，否则 Wait 可能先跑过去
		go func() {
			defer wg.Done()                                      // ★ 用 defer 保证就算 panic 也会 Done
			fmt.Printf("  工人 %d 开工\n", i)                        // Go 1.22+ 每轮 i 是新变量，放心捕获
			time.Sleep(time.Duration(i) * 50 * time.Millisecond) // 模拟干活
			fmt.Printf("  工人 %d 收工\n", i)
		}()
	}
	wg.Wait() // 阻塞到 3 个工人全部 Done
	fmt.Println("所有工人完工")
	// Go 1.25+ 还提供了 wg.Go(func(){...}) 把 Add/Done 包掉，更简洁

	fmt.Println("\n══════ 3. ⚠️ 竞态条件：并发修改共享变量 ══════")
	// 1000 个 goroutine 同时 counter++，结果几乎必然小于 1000！
	// 因为 counter++ 实际是 读->加->写 三步，两个 goroutine 交错执行会互相覆盖
	counter := 0
	var wg2 sync.WaitGroup
	for range 1000 {
		wg2.Add(1)
		go func() {
			defer wg2.Done()
			counter++ // ⚠️ 数据竞争！go run -race 会在这里报 DATA RACE
		}()
	}
	wg2.Wait()
	fmt.Println("无锁累加结果:", counter, "（期望 1000，大概率更少）")

	fmt.Println("\n══════ 4. sync.Mutex：互斥锁保护临界区 ══════")
	// 修复方案一：Mutex（mutual exclusion）。
	// Lock 和 Unlock 之间的代码同一时刻只有一个 goroutine 能执行
	var (
		mu        sync.Mutex
		safeCount int
		wg3       sync.WaitGroup
	)
	for range 1000 {
		wg3.Add(1)
		go func() {
			defer wg3.Done()
			mu.Lock()         // 拿锁（别人持有时阻塞等待）
			defer mu.Unlock() // ★ defer 解锁，绝不会忘
			safeCount++       // 临界区：同一时刻只有一个 goroutine 在这
		}()
	}
	wg3.Wait()
	fmt.Println("加锁累加结果:", safeCount) // 恒为 1000 ✓

	// 惯用法：把锁和它保护的数据放进同一个结构体（见下方 SafeCounter）
	sc := SafeCounter{counts: make(map[string]int)}
	var wg4 sync.WaitGroup
	for range 100 {
		wg4.Add(1)
		go func() {
			defer wg4.Done()
			sc.Inc("clicks") // 方法内部自己加锁，调用方无感知
		}()
	}
	wg4.Wait()
	fmt.Println("SafeCounter:", sc.Get("clicks")) // 100

	fmt.Println("\n══════ 5. atomic：无锁原子操作 ══════")
	// 修复方案二：对单个数值的简单加减，atomic 比锁更轻
	var atomicCount atomic.Int64 // 自带原子方法的整数类型
	var wg5 sync.WaitGroup
	for range 1000 {
		wg5.Add(1)
		go func() {
			defer wg5.Done()
			atomicCount.Add(1) // 原子加：硬件级别保证不被打断
		}()
	}
	wg5.Wait()
	fmt.Println("原子累加结果:", atomicCount.Load()) // 1000 ✓

	fmt.Println("\n══════ 6. sync.Once：只执行一次 ══════")
	// 经典场景：懒加载单例、一次性初始化。无论多少 goroutine 同时调，
	// Do 里的函数保证只执行一次，其他调用阻塞等它完成
	var once sync.Once
	var wg6 sync.WaitGroup
	for i := 1; i <= 3; i++ {
		wg6.Add(1)
		go func() {
			defer wg6.Done()
			once.Do(func() { fmt.Println("  初始化！（只会打印一次）") })
			fmt.Printf("  goroutine %d 拿到已初始化的资源\n", i)
		}()
	}
	wg6.Wait()

	fmt.Println("\n══════ 小结 ══════")
	fmt.Println(`  go f()        启动并发任务，main 退出会杀死一切
  WaitGroup     等一批任务结束（Add -> go -> defer Done -> Wait）
  Mutex         保护复杂共享状态（map、多个字段）
  atomic        单个数值的计数器
  ★ 但 Go 更推荐的同步方式是 channel —— 见下一节 16_channels
  ★ 永远用 go run -race 跑并发代码，它能逮住绝大多数数据竞争`)
}

// say 打印 3 次，每次间隔 50ms —— 用来观察两个 goroutine 交错输出
func say(s string) {
	for i := 0; i < 3; i++ {
		time.Sleep(50 * time.Millisecond) // 让出 CPU，给其他 goroutine 机会
		fmt.Println("  say:", s)
	}
}

// SafeCounter 并发安全的计数 map：锁与数据封装在一起 ★工程惯用法
type SafeCounter struct {
	mu     sync.Mutex     // 惯例：锁放在它保护的字段上方
	counts map[string]int // ⚠️ map 本身不是并发安全的，必须配锁
}

// Inc 并发安全地 +1
func (c *SafeCounter) Inc(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.counts[key]++
}

// Get 并发安全地读取（读也要加锁！读写并发同样是竞态）
func (c *SafeCounter) Get(key string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.counts[key]
}
