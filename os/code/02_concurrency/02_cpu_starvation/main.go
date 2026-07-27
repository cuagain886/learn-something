// 02_cpu_starvation — CPU 密集 goroutine 如何拖高别人的延迟
//
// 学什么：
//  1. 复现："几个 CPU 密集任务上线后，轻量请求的 P99 延迟涨了几十倍"
//  2. 理解机制：GOMAXPROCS 个 P 是硬上限，CPU 型 G 挤占 P，
//     I/O 型 G 就绪后只能在运行队列里排队（调度延迟）
//  3. 对策验证：用信号量限制 CPU 密集任务的并发数，给延迟敏感任务留 P
//     ⚠️ goroutine 便宜 ≠ 并发无代价——对 CPU 型任务，并行上限就是核数
//
// 运行：cd os/code && go run ./02_concurrency/02_cpu_starvation
// 建议配合观察：GODEBUG=schedtrace=200 go run ./02_concurrency/02_cpu_starvation
//   （看 runqueue 列：受挤压阶段全局队列明显变长）
package main

import (
	"fmt"
	"runtime"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// latencyProbe 模拟延迟敏感的轻量请求：每 5ms 发一笔，测"就绪→被调度执行"的耗时。
// 真实世界里它就是你的 HTTP handler。
func latencyProbe(stop <-chan struct{}, out *[]time.Duration, mu *sync.Mutex) {
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-stop:
			return
		case <-tick.C:
			start := time.Now()
			done := make(chan struct{})
			go func() { // 这笔"请求"只做一件事：被调度到就立刻完成
				close(done)
			}()
			<-done
			cost := time.Since(start) // ≈ 新 G 从创建到被某个 P 执行的调度延迟
			mu.Lock()
			*out = append(*out, cost)
			mu.Unlock()
		}
	}
}

// burnCPU 模拟 CPU 密集工具任务：纯计算紧循环 dur 时长。
// atomic 加法防止编译器把空循环优化没。
var sink atomic.Int64

func burnCPU(dur time.Duration) {
	deadline := time.Now().Add(dur)
	for time.Now().Before(deadline) {
		for i := 0; i < 1<<14; i++ {
			sink.Add(1)
		}
	}
}

func percentile(d []time.Duration, p float64) time.Duration {
	if len(d) == 0 {
		return 0
	}
	sort.Slice(d, func(i, j int) bool { return d[i] < d[j] })
	return d[int(float64(len(d)-1)*p)]
}

// measure 在指定负载下跑 1.5 秒探针，返回调度延迟分布
func measure(label string, launchLoad func(stop <-chan struct{})) {
	var (
		lat  []time.Duration
		mu   sync.Mutex
		stop = make(chan struct{})
	)
	go latencyProbe(stop, &lat, &mu)
	if launchLoad != nil {
		launchLoad(stop)
	}
	time.Sleep(1500 * time.Millisecond)
	close(stop)
	time.Sleep(50 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	fmt.Printf("%-28s 样本=%3d  P50=%-10v P99=%-10v max=%v\n",
		label, len(lat),
		percentile(lat, 0.50), percentile(lat, 0.99), percentile(lat, 1.0))
}

func main() {
	nCPU := runtime.GOMAXPROCS(0)
	fmt.Printf("GOMAXPROCS = %d（P 的数量 = 同时能跑 Go 代码的上限）\n\n", nCPU)

	// 场景 1：空载基线——调度延迟通常是微秒级
	measure("① 空载基线", nil)

	// 场景 2：⚠️ CPU 密集任务无限制 —— 起 2×GOMAXPROCS 个烧 CPU 的 G，
	// 所有 P 被占满，探针 G 就绪后要排队等 P（还好有 1.14+ 的 10ms 抢占兜底，
	// 否则更惨）。观察 P99 相比基线的倍数。
	measure(fmt.Sprintf("② 无限制: %d 个 CPU 密集 G", 2*nCPU), func(stop <-chan struct{}) {
		for i := 0; i < 2*nCPU; i++ {
			go func() {
				for {
					select {
					case <-stop:
						return
					default:
						burnCPU(20 * time.Millisecond)
					}
				}
			}()
		}
	})

	// 场景 3：✅ 信号量限流 —— CPU 密集任务最多占一半的 P，
	// 给延迟敏感的请求留出调度余量。总吞吐略降，P99 大幅回落——
	// 这是"吞吐换尾延迟"的经典交易，Agent 里工具执行并发上限就是这个旋钮。
	limit := nCPU / 2
	if limit < 1 {
		limit = 1
	}
	measure(fmt.Sprintf("③ 信号量限流: 最多 %d 并发", limit), func(stop <-chan struct{}) {
		sem := make(chan struct{}, limit)
		for i := 0; i < 2*nCPU; i++ {
			go func() {
				for {
					select {
					case <-stop:
						return
					case sem <- struct{}{}: // 拿到名额才烧
						burnCPU(20 * time.Millisecond)
						<-sem
					}
				}
			}()
		}
	})

	fmt.Println("\n结论: CPU 型任务的并发要【主动设上限】(≤ 核数的一个份额)，")
	fmt.Println("      否则延迟敏感的邻居为你的吞吐买单。Agent 的工具执行池同理。")
}
