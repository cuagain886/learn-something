// 04_worker_pool — 固定 worker 池 + 有界队列：并发受控与优雅关闭
//
// 学什么：
//  1. Runner 的并发骨架：N 个常驻 worker 消费一条【有界】任务队列
//  2. 队列满时的三种策略：阻塞(带 ctx) / 立即拒绝 / 超时拒绝——拒绝即背压
//     ⚠️ 无界队列 = 把"拒绝"推迟成"OOM"，第 06 章的核心教训在这里预演
//  3. 优雅关闭的两种语义：drain(排空存量) vs abort(丢弃存量)，都不能丢 worker
//
// 运行：cd os/code && go run ./02_concurrency/04_worker_pool
package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

var ErrBusy = errors.New("queue full: 系统繁忙，请稍后重试") // 背压信号，给上游看的

type Task struct {
	ID   int
	Work time.Duration // 模拟负载
}

type Pool struct {
	queue   chan Task // 有界队列：容量就是"允许积压的上限"
	wg      sync.WaitGroup
	done    atomic.Int64
	dropped atomic.Int64
}

// NewPool 启动 workers 个常驻 worker。
// worker 数怎么定：CPU 型 ≈ GOMAXPROCS；I/O 型 ≈ 下游能扛的并发(连接池大小等)。
func NewPool(workers, queueCap int) *Pool {
	p := &Pool{queue: make(chan Task, queueCap)}
	for i := 0; i < workers; i++ {
		p.wg.Add(1)
		go p.worker(i)
	}
	return p
}

func (p *Pool) worker(id int) {
	defer p.wg.Done()
	for t := range p.queue { // 队列被 close 且排空后，range 结束，worker 退出
		time.Sleep(t.Work) // 真实场景：执行工具/处理请求（应带 ctx，见第 02 章）
		p.done.Add(1)
	}
}

// Submit 阻塞式提交：队列满时等待，但 ctx 到期就放弃——调用方决定最多等多久。
// 这是"背压传导"：这里拒绝 → HTTP 层返回 429/503 → 客户端退避重试。
func (p *Pool) Submit(ctx context.Context, t Task) error {
	select {
	case p.queue <- t:
		return nil
	case <-ctx.Done():
		p.dropped.Add(1)
		return fmt.Errorf("%w (%v)", ErrBusy, ctx.Err())
	}
}

// TrySubmit 非阻塞提交：满了立即拒绝。适合"宁可丢也不能等"的场景（如指标上报）。
func (p *Pool) TrySubmit(t Task) error {
	select {
	case p.queue <- t:
		return nil
	default:
		p.dropped.Add(1)
		return ErrBusy
	}
}

// ShutdownDrain 优雅关闭：不再收新任务，把队列里的存量做完。
// ⚠️ close(queue) 后再 Submit 会 panic——真实系统要先原子地翻"已关闭"标志
// 挡住入口（本 demo 从简，靠调用顺序保证）。
func (p *Pool) ShutdownDrain() {
	close(p.queue)
	p.wg.Wait() // 等全部 worker 把存量消化完并退出
}

func main() {
	pool := NewPool(4, 8) // 4 个 worker，最多积压 8 个
	fmt.Println("== 4 worker + 容量 8 的有界队列，瞬间涌入 30 个任务 ==")

	var accepted, rejected int
	for i := 0; i < 30; i++ {
		// 每次提交最多等 30ms：队列一直满就把压力还给上游
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
		err := pool.Submit(ctx, Task{ID: i, Work: 40 * time.Millisecond})
		cancel()
		if err != nil {
			rejected++
			if rejected == 1 {
				fmt.Printf("  第 %d 个任务开始被拒绝: %v\n", i, err)
			}
		} else {
			accepted++
		}
	}
	fmt.Printf("  提交结果: 接受=%d 拒绝=%d（拒绝不是故障，是背压在工作）\n", accepted, rejected)

	fmt.Println("== 优雅关闭(drain): 等存量做完 ==")
	start := time.Now()
	pool.ShutdownDrain()
	fmt.Printf("  完成任务=%d, 关闭耗时=%v（≈ 存量/并发 × 单任务时长）\n",
		pool.done.Load(), time.Since(start).Round(10*time.Millisecond))

	fmt.Println(`
要点回顾:
  1. 队列容量是【故意设小】的——积压上限 = 最大延迟预算 ÷ 单任务耗时
  2. 拒绝策略三选一: 带 ctx 等待 / 立即拒 / 超时拒, 但必须有一种
  3. 关闭语义想清楚: drain(不丢活, 慢) vs abort(丢活, 快)——
     Runner 收到 SIGTERM 用 drain + 总超时, 超时后转 abort(第 02 章分级击杀同思想)`)
}
