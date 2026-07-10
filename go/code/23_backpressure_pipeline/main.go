/*
23_backpressure_pipeline —— 有界队列、背压与关闭权

【本节学什么】
 1. 为什么有界队列是生产系统的安全边界
 2. 阻塞、立即拒绝、保留最新三种策略的业务语义
 3. 如何让 Submit 与 Close 并发而不发生 send on closed channel
 4. 正常关闭排空与 context 取消中止的区别

【运行】

	go run ./23_backpressure_pipeline
	go test -race ./23_backpressure_pipeline
	go test -run='^$' -bench=. -benchmem ./23_backpressure_pipeline
*/
package main

import (
	"context"
	"errors"
	"fmt"
)

func main() {
	fmt.Println("══════ 1. PolicyBlock：把压力传回生产者 ══════")
	blocking, _ := NewPipeline(context.Background(), 2, 2, PolicyBlock,
		func(_ context.Context, value int) (int, error) { return value * value, nil })
	blockDone := make(chan struct{})
	go func() {
		defer close(blockDone)
		for result := range blocking.Results() {
			fmt.Println("block result:", result.Value)
		}
	}()
	for value := 1; value <= 5; value++ {
		_ = blocking.Submit(context.Background(), value)
	}
	_ = blocking.Close()
	_ = blocking.Wait()
	<-blockDone
	fmt.Printf("stats: %+v\n", blocking.Stats())

	fmt.Println("\n══════ 2. PolicyReject：队列满时快速失败 ══════")
	started := make(chan struct{})
	release := make(chan struct{})
	rejecting, _ := NewPipeline(context.Background(), 1, 1, PolicyReject,
		func(_ context.Context, value int) (int, error) {
			select {
			case started <- struct{}{}:
			default:
			}
			<-release
			return value, nil
		})
	_ = rejecting.Submit(context.Background(), 1)
	<-started
	_ = rejecting.Submit(context.Background(), 2)
	err := rejecting.Submit(context.Background(), 3)
	fmt.Println("third submit is queue full:", errors.Is(err, ErrQueueFull))
	close(release)
	_ = rejecting.Close()
	for range rejecting.Results() {
	}
	_ = rejecting.Wait()
	fmt.Printf("stats: %+v\n", rejecting.Stats())

	fmt.Println("\n══════ 3. PolicyKeepLatest：旧更新可以被新更新覆盖 ══════")
	latestStarted := make(chan struct{})
	latestRelease := make(chan struct{})
	latest, _ := NewPipeline(context.Background(), 1, 1, PolicyKeepLatest,
		func(_ context.Context, value int) (int, error) {
			select {
			case latestStarted <- struct{}{}:
			default:
			}
			<-latestRelease
			return value, nil
		})
	_ = latest.Submit(context.Background(), 1)
	<-latestStarted
	_ = latest.Submit(context.Background(), 2)
	_ = latest.Submit(context.Background(), 3)
	close(latestRelease)
	_ = latest.Close()
	for result := range latest.Results() {
		fmt.Println("latest result:", result.Value)
	}
	_ = latest.Wait()
	fmt.Printf("stats: %+v\n", latest.Stats())

	fmt.Println("\n要点：Pipeline 拥有内部 channel 的关闭权；调用方必须持续消费 Results。")
}
