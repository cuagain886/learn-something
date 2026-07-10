/*
29_runtime_scheduler —— 从可观察行为走进 Go 调度器

【本节学什么】
 1. G、M、P 如何协作，而不是把 goroutine 简化成“轻量线程”
 2. 本地/全局运行队列、work stealing、sysmon 与异步抢占
 3. 为什么任务粒度、GOMAXPROCS、系统调用和 LockOSThread 会影响吞吐
 4. 如何用 runtime/metrics、schedtrace 和 trace 证明调度结论

【运行】

	go run ./29_runtime_scheduler -mode=metrics
	go run ./29_runtime_scheduler -mode=cpu -tasks=128 -parallelism=4
	go run ./29_runtime_scheduler -mode=locked
	go test -race ./29_runtime_scheduler
	go test -run='^$' -bench=. -benchmem ./29_runtime_scheduler
*/
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"runtime"
)

func main() {
	mode := flag.String("mode", "metrics", "metrics|cpu|locked")
	tasks := flag.Int("tasks", 64, "number of deterministic CPU tasks")
	parallelism := flag.Int("parallelism", runtime.GOMAXPROCS(0), "worker goroutines")
	iterations := flag.Int("iterations", 2_000, "mixing iterations per task")
	flag.Parse()

	switch *mode {
	case "metrics":
		snapshot, err := ReadSchedulerSnapshot()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return
		}
		fmt.Printf("goroutines=%d gomaxprocs=%d\n", snapshot.Goroutines, snapshot.GOMAXPROCS)
	case "cpu":
		result, err := RunCPUWorkload(context.Background(), WorkloadConfig{
			Tasks: *tasks, Parallelism: *parallelism, Iterations: *iterations,
		})
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return
		}
		fmt.Printf("completed=%d checksum=%d parallelism=%d\n", result.Completed, result.Checksum, *parallelism)
	case "locked":
		done := make(chan struct{})
		go func() {
			runtime.LockOSThread()
			defer runtime.UnlockOSThread()
			fmt.Println("goroutine temporarily pinned to its current OS thread")
			close(done)
		}()
		<-done
		fmt.Println("pin released; no thread ID assumption was made")
	default:
		fmt.Fprintf(os.Stderr, "unknown mode %q\n", *mode)
	}
}
