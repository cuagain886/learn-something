/*
21_memory_model —— Go 内存模型、原子发布与伪共享

【本节学什么】
 1. happens-before 不是“代码看起来在前面”，而是可证明的同步顺序
 2. Mutex、channel 和 atomic 如何安全发布跨 goroutine 状态
 3. CAS 为什么必须放在重试循环里
 4. 伪共享为什么会让互不相关的计数器互相拖慢

【运行】

		go run ./21_memory_model
		go test -race ./21_memory_model
	  go test -run='^$' -bench=. -benchmem ./21_memory_model
*/
package main

import (
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

func main() {
	fmt.Println("══════ 1. channel 建立 happens-before ══════")
	var message string
	ready := make(chan struct{})
	go func() {
		message = "写入发生在 close 之前"
		close(ready)
	}()
	<-ready
	fmt.Println(message)

	fmt.Println("\n══════ 2. Mutex 发布整份配置 ══════")
	locked := NewLockedSnapshot(Config{Version: 1, Endpoint: "locked", Timeout: time.Second})
	locked.Store(Config{Version: 2, Endpoint: "locked-v2", Timeout: 2 * time.Second})
	fmt.Printf("锁快照: %+v\n", locked.Load())

	fmt.Println("\n══════ 3. atomic.Pointer 发布只读快照 ══════")
	atomicSnapshot := NewAtomicSnapshot(Config{Version: 1, Endpoint: "atomic", Timeout: time.Second})
	var readers sync.WaitGroup
	for id := range 3 {
		readers.Add(1)
		go func() {
			defer readers.Done()
			fmt.Printf("reader-%d: %+v\n", id, atomicSnapshot.Load())
		}()
	}
	readers.Wait()

	fmt.Println("\n══════ 4. CAS 是读-改-写重试循环 ══════")
	var counter atomic.Int64
	for range 5 {
		for {
			old := counter.Load()
			if counter.CompareAndSwap(old, old+1) {
				break
			}
		}
	}
	fmt.Println("CAS counter:", counter.Load())

	fmt.Println("\n══════ 5. 伪共享用 Benchmark 观察 ══════")
	fmt.Println("运行 go test -run='^$' -bench='FalseSharing|Padded' -benchmem ./21_memory_model")
	fmt.Println("注意：无同步的 busy-wait/双重检查存在数据竞争，不能靠运行结果证明正确。")
}
