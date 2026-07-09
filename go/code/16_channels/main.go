/*
═══════════════════════════════════════════════════════════════════

	16_channels —— 通道：goroutine 之间的管道

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. channel 基础：创建、发送 <-、接收 <-
 2. 无缓冲 vs 有缓冲通道
 3. close、for range 遍历通道、单向通道
 4. select：多路复用 + 超时控制
 5. 实战模式：worker pool（工作池）

【运行】go run ./16_channels

【核心理念】

	"不要通过共享内存来通信，而要通过通信来共享内存。"
	上一节用锁保护共享变量；本节换思路：数据在 goroutine 之间
	【通过通道传递】，同一时刻只有一方持有数据 —— 天然无竞态。
*/
package main

import (
	"fmt"
	"time"
)

func main() {
	fmt.Println("══════ 1. channel 基础 ══════")
	// 创建：make(chan 元素类型)。channel 是类型安全的：chan int 只能传 int
	ch := make(chan string)

	// 箭头语法（记忆：箭头指向数据流动的方向）
	//   ch <- v    发送：把 v 送进通道
	//   v := <-ch  接收：从通道取出一个值
	go func() {
		time.Sleep(50 * time.Millisecond) // 模拟耗时工作
		ch <- "任务完成"                      // 发送结果（没人接收会一直阻塞）
	}()

	// 接收会【阻塞】直到有数据 —— 天然完成了"等待"的同步语义，
	// 这里不再需要 WaitGroup 或 Sleep！
	msg := <-ch
	fmt.Println("收到:", msg)

	fmt.Println("\n══════ 2. 无缓冲 vs 有缓冲 ══════")
	// ── 无缓冲 make(chan T)：容量 0，"一手交钱一手交货" ──
	// 发送方阻塞，直到接收方就位（反之亦然）——双方在这一刻【同步会合】
	// ⚠️ 同一个 goroutine 自发自收必死锁：
	//    c := make(chan int); c <- 1 // fatal error: all goroutines are asleep!

	// ── 有缓冲 make(chan T, n)：容量 n 的队列 ──
	// 缓冲没满 => 发送不阻塞；缓冲非空 => 接收不阻塞。解耦双方节奏
	buf := make(chan int, 3) // 容量 3
	buf <- 1                 // 不阻塞（缓冲 1/3）
	buf <- 2                 // 不阻塞（2/3）
	buf <- 3                 // 不阻塞（3/3 满了）
	// buf <- 4              // ⚠️ 这句会阻塞：缓冲已满且没人接收 => 死锁
	fmt.Println("缓冲长度:", len(buf), "容量:", cap(buf)) // 3 3
	fmt.Println("取出:", <-buf, <-buf, <-buf)         // 1 2 3（先进先出）

	fmt.Println("\n══════ 3. close 与 for range ══════")
	// 生产者完成后 close(ch)，告诉消费者"不会再有数据了"
	jobs := make(chan int, 5)
	go func() {
		for i := 1; i <= 5; i++ {
			jobs <- i * 11 // 生产 5 个数据
		}
		close(jobs) // ★ 关闭通道（只有发送方应该 close！）
	}()

	// for range 持续接收，直到通道【被关闭且取空】才退出循环
	for v := range jobs {
		fmt.Println("  消费:", v)
	}

	// 接收的 comma-ok 形式：ok=false 表示"通道已关闭且无数据"
	v, ok := <-jobs
	fmt.Println("关闭后再收:", v, ok) // 0 false（取到元素类型的零值）

	// ⚠️ close 三条规矩：
	//   1. 向已关闭的通道发送 => panic
	//   2. 重复 close       => panic
	//   3. close 不是必须的 —— 没人 range 它就不用关，GC 会回收

	fmt.Println("\n══════ 4. 单向通道：约束方向，接口更安全 ══════")
	// chan<- T 只能发送；<-chan T 只能接收。
	// 双向通道传参时可自动收窄为单向 —— 编译器帮你防止用反
	results := make(chan int, 3)
	go produce(results) // produce 的参数类型是 chan<- int（只许发）
	consume(results, 3) // consume 的参数类型是 <-chan int（只许收）

	fmt.Println("\n══════ 5. select：同时等多个通道 ══════")
	// select 像 switch，但每个 case 是一次通道操作；
	// 哪个先就绪执行哪个，多个就绪则【随机】挑一个（防饥饿）
	c1 := make(chan string)
	c2 := make(chan string)
	go func() { time.Sleep(30 * time.Millisecond); c1 <- "快服务" }()
	go func() { time.Sleep(80 * time.Millisecond); c2 <- "慢服务" }()

	for range 2 { // 收两条消息
		select {
		case m1 := <-c1:
			fmt.Println("  来自 c1:", m1)
		case m2 := <-c2:
			fmt.Println("  来自 c2:", m2)
		}
	}

	// ── select + time.After 实现超时 ★高频实战模式 ──
	slow := make(chan string)
	go func() { time.Sleep(200 * time.Millisecond); slow <- "太慢的结果" }()
	select {
	case r := <-slow:
		fmt.Println("  收到:", r)
	case <-time.After(100 * time.Millisecond): // 100ms 后该通道会来一个值
		fmt.Println("  超时放弃！(100ms)") // 走这条分支
	}

	// ── 带 default 的 select：非阻塞尝试 ──
	probe := make(chan int)
	select {
	case v := <-probe:
		fmt.Println("  有数据:", v)
	default: // 所有 case 都没就绪时立刻走 default，不阻塞
		fmt.Println("  没数据，不等了（非阻塞接收）")
	}

	fmt.Println("\n══════ 6. 实战：worker pool 工作池 ══════")
	// 固定数量的 worker 并发消费任务队列 —— Go 并发的"Hello World 进阶版"
	// 结构：jobs 通道发任务，results 通道收结果，3 个 worker 抢着干
	const numJobs = 9
	const numWorkers = 3
	jobsCh := make(chan int, numJobs)
	resultsCh := make(chan string, numJobs)

	// 启动 3 个常驻 worker，它们同时 range 同一个 jobs 通道，
	// 每个任务只会被【其中一个】worker 抢到（通道天然的负载均衡）
	for w := 1; w <= numWorkers; w++ {
		go worker(w, jobsCh, resultsCh)
	}

	// 投递 9 个任务后关闭通道（worker 的 range 才能退出）
	for j := 1; j <= numJobs; j++ {
		jobsCh <- j
	}
	close(jobsCh)

	// 收齐 9 个结果（已知数量，所以数着收即可）
	for range numJobs {
		fmt.Println(" ", <-resultsCh)
	}
	fmt.Println("全部任务处理完毕")
}

// produce 参数声明为 chan<- int：函数体内只能发送，写 <-ch 会编译错误
func produce(out chan<- int) {
	for i := 1; i <= 3; i++ {
		out <- i * 100
	}
	close(out)
}

// consume 参数声明为 <-chan int：只能接收
func consume(in <-chan int, n int) {
	for range n {
		fmt.Println("  consume 收到:", <-in)
	}
}

// worker 工作池中的一个工人：不断从 jobs 取任务，把结果发到 results
func worker(id int, jobs <-chan int, results chan<- string) {
	for j := range jobs { // 通道关闭且取空后自动退出循环
		time.Sleep(30 * time.Millisecond) // 模拟干活耗时
		results <- fmt.Sprintf("工人%d 完成了任务%d（结果 %d）", id, j, j*j)
	}
}
