/*
22_structured_concurrency —— 结构化并发与任务生命周期

【本节学什么】
 1. goroutine 必须属于一个明确的父生命周期
 2. 首错取消和 context 取消原因如何传播
 3. 如何限制执行并发、隔离 panic、等待全部清理完成
 4. 为什么“取消”是协作协议，不是强制杀死 goroutine

【运行】

	go run ./22_structured_concurrency
	go test -race ./22_structured_concurrency
	go test -run='^$' -bench=. -benchmem ./22_structured_concurrency
*/
package main

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"time"
)

func main() {
	fmt.Println("══════ 1. 全部成功 ══════")
	success, _ := NewTaskGroup(context.Background(), 2)
	for id := range 3 {
		_ = success.Go(func(context.Context) error {
			fmt.Println("完成任务", id)
			return nil
		})
	}
	fmt.Println("Wait:", success.Wait())

	fmt.Println("\n══════ 2. 首错取消兄弟任务 ══════")
	firstError, _ := NewTaskGroup(context.Background(), 2)
	started := make(chan struct{})
	_ = firstError.Go(func(ctx context.Context) error {
		close(started)
		<-ctx.Done()
		fmt.Println("兄弟任务收到取消原因:", context.Cause(ctx))
		return nil
	})
	<-started
	_ = firstError.Go(func(context.Context) error { return errors.New("上游失败") })
	fmt.Println("Wait:", firstError.Wait())

	fmt.Println("\n══════ 3. 父级超时 ══════")
	parent, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	timed, _ := NewTaskGroup(parent, 1)
	_ = timed.Go(func(ctx context.Context) error {
		<-ctx.Done()
		return context.Cause(ctx)
	})
	fmt.Println("Wait:", timed.Wait())

	fmt.Println("\n══════ 4. panic 被任务边界隔离 ══════")
	panics, _ := NewTaskGroup(context.Background(), 1)
	_ = panics.Go(func(context.Context) error { panic("bad task") })
	var panicErr *PanicError
	err := panics.Wait()
	if errors.As(err, &panicErr) {
		fmt.Printf("捕获 panic=%v，stack=%d bytes\n", panicErr.Value, len(panicErr.Stack))
	}

	fmt.Println("\n══════ 5. 限制的是执行并发 ══════")
	limited, _ := NewTaskGroup(context.Background(), 2)
	var running, maximum atomic.Int64
	for range 6 {
		_ = limited.Go(func(context.Context) error {
			current := running.Add(1)
			for {
				old := maximum.Load()
				if current <= old || maximum.CompareAndSwap(old, current) {
					break
				}
			}
			time.Sleep(20 * time.Millisecond)
			running.Add(-1)
			return nil
		})
	}
	_ = limited.Wait()
	fmt.Println("观察到的最大执行并发:", maximum.Load())
}
