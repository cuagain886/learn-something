// 03_race_deadlock — 竞态两种形态与锁序死锁：构造、抓现行、修复
//
// 学什么：
//  1. 竞态形态 A（read-modify-write）：counter++ 丢更新
//  2. 竞态形态 B（check-then-act）：重复启动任务——Agent 事故原型
//  3. 锁序死锁：转账经典案例，两把锁相反顺序 → 互持等待；修法 = 全局锁序
//  4. -race 检测器的正确用法与局限（只报跑到的路径）
//
// 运行：
//   go run -race ./02_concurrency/03_race_deadlock          # 看 race 报告
//   go run ./02_concurrency/03_race_deadlock -deadlock      # 死锁演示(2 秒后自动诊断)
package main

import (
	"flag"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// ---- 形态 A: read-modify-write ------------------------------------------

func raceCounter() {
	var wrong int64 // ⚠️ 裸自增
	var right atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 1000; j++ {
				wrong++          // 三步操作被交错 → 丢加。-race 在这里报警
				right.Add(1)     // 原子指令一步到位
			}
		}()
	}
	wg.Wait()
	fmt.Printf("[形态A] 期望 100000: 裸自增=%d (丢了 %d 次), atomic=%d ✅\n",
		wrong, 100000-wrong, right.Load())
}

// ---- 形态 B: check-then-act ---------------------------------------------

func raceCheckThenAct() {
	var started int32 // 统计任务被真正启动了几次

	// ⚠️ 错误版：检查和登记之间存在窗口
	buggy := struct {
		mu    sync.Mutex
		tasks map[string]bool
	}{tasks: map[string]bool{}}

	startBuggy := func(id string) {
		buggy.mu.Lock()
		exists := buggy.tasks[id]
		buggy.mu.Unlock() // ⚠️ 锁在"检查"后就放了——检查与行动不在同一临界区
		if !exists {
			time.Sleep(time.Microsecond) // 放大窗口(模拟准备工作)
			buggy.mu.Lock()
			buggy.tasks[id] = true
			buggy.mu.Unlock()
			atomic.AddInt32(&started, 1) // 两个 G 都可能走到这
		}
	}

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ { // 8 个请求并发提交同一个任务
		wg.Add(1)
		go func() { defer wg.Done(); startBuggy("task-1") }()
	}
	wg.Wait()
	fmt.Printf("[形态B] 错误版: 同一任务被启动 %d 次 (期望 1)\n", started)

	// ✅ 修复版：LoadOrStore 把"查 + 占坑"压成一个原子点
	started = 0
	var tasks sync.Map
	startFixed := func(id string) {
		if _, loaded := tasks.LoadOrStore(id, true); loaded {
			return // 坑已被占：幂等返回，绝不双开
		}
		atomic.AddInt32(&started, 1)
	}
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); startFixed("task-1") }()
	}
	wg.Wait()
	fmt.Printf("[形态B] 修复版: 同一任务被启动 %d 次 ✅ (LoadOrStore 原子占坑)\n", started)
}

// ---- 锁序死锁 ------------------------------------------------------------

type account struct {
	id int
	mu sync.Mutex
}

// ⚠️ 错误版：按参数顺序加锁。transfer(a,b) 与 transfer(b,a) 并发 → 互持等待
func transferBuggy(from, to *account) {
	from.mu.Lock()
	time.Sleep(time.Millisecond) // 放大窗口
	to.mu.Lock()
	to.mu.Unlock()
	from.mu.Unlock()
}

// ✅ 修复版：全局锁序——永远先锁 id 小的。循环等待条件被打破，死锁不可能发生
func transferFixed(from, to *account) {
	first, second := from, to
	if first.id > second.id {
		first, second = second, first
	}
	first.mu.Lock()
	defer first.mu.Unlock()
	second.mu.Lock()
	defer second.mu.Unlock()
}

func demoDeadlock() {
	a, b := &account{id: 1}, &account{id: 2}

	fmt.Println("[死锁] 错误版: transfer(a,b) 与 transfer(b,a) 并发...")
	done := make(chan struct{})
	go func() {
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); transferBuggy(a, b) }()
		go func() { defer wg.Done(); transferBuggy(b, a) }()
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		fmt.Println("  侥幸没死锁(时序没撞上)，多跑几次必现")
	case <-time.After(2 * time.Second):
		fmt.Println("  ⚠️ 2 秒无进展 = 死锁实锤：G1 持 a 等 b，G2 持 b 等 a")
		fmt.Println("  注意：进程没有崩！因为 main goroutine 还活着——")
		fmt.Println("  runtime 只在【全部】G 睡死时才报 fatal。局部死锁要靠")
		fmt.Println("  goroutine dump 里长时间 semacquire 的 G 来发现(第12章)。")
	}

	fmt.Println("[死锁] 修复版: 全局锁序(先锁 id 小的)...")
	// ⚠️ 必须用新账户：上面死锁的两个 goroutine 还永久持有 a/b 的锁，
	// 复用旧账户会让修复版也跟着挂死——死锁不会自愈，只能预防
	c, d := &account{id: 1}, &account{id: 2}
	var wg sync.WaitGroup
	for i := 0; i < 1000; i++ { // 高强度对冲也不会死
		wg.Add(2)
		go func() { defer wg.Done(); transferFixed(c, d) }()
		go func() { defer wg.Done(); transferFixed(d, c) }()
	}
	wg.Wait()
	fmt.Println("  1000 轮双向转账无死锁 ✅")
}

func main() {
	deadlock := flag.Bool("deadlock", false, "运行死锁演示")
	flag.Parse()
	if *deadlock {
		demoDeadlock()
		return
	}
	raceCounter()
	raceCheckThenAct()
	fmt.Println("\n提示: 用 `go run -race` 重跑本程序看竞态报告——")
	fmt.Println("      报告会精确给出两个冲突访问的 goroutine 创建栈和读写位置。")
	fmt.Println("      ⚠️ -race 只报【跑到的路径】：绿灯≠无竞态，覆盖率决定检出率。")
	fmt.Println("加 -deadlock 参数看锁序死锁演示。")
}
