package main

import (
	"sync"
	"testing"
)

var concurrencySink int

func BenchmarkBufferedChannel(b *testing.B) {
	ch := make(chan int, 1)
	b.ReportAllocs()
	for b.Loop() {
		ch <- 1
		concurrencySink = <-ch
	}
}
func BenchmarkCondQueue(b *testing.B) {
	q := NewCondQueue[int]()
	b.ReportAllocs()
	for b.Loop() {
		q.Push(1)
		concurrencySink, _ = q.Pop()
	}
}
func BenchmarkChannelPingPong(b *testing.B) {
	ch := make(chan int)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for value := range ch {
			concurrencySink = value
		}
	}()
	b.ResetTimer()
	for i := range b.N {
		ch <- i
	}
	close(ch)
	wg.Wait()
}
