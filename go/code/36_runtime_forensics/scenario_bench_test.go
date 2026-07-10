package main

import (
	"math/bits"
	"sync"
	"testing"
)

var forensicsSink uint64

func BenchmarkCPUIncidentBatch(b *testing.B) {
	for b.Loop() {
		v := uint64(1)
		for i := range 1000 {
			v = bits.RotateLeft64(v^uint64(i), 13)
		}
		forensicsSink = v
	}
}
func BenchmarkAllocationIncidentBatch(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		retained := make([][]byte, 64)
		for i := range retained {
			retained[i] = make([]byte, 1024)
		}
		forensicsSink = uint64(len(retained))
	}
}
func BenchmarkMutexIncidentBatch(b *testing.B) {
	var mu sync.Mutex
	for b.Loop() {
		for range 1000 {
			mu.Lock()
			forensicsSink++
			mu.Unlock()
		}
	}
}
func BenchmarkBlockIncidentBatch(b *testing.B) {
	ch := make(chan uint64)
	done := make(chan struct{})
	go func() {
		for v := range ch {
			forensicsSink = v
		}
		close(done)
	}()
	b.ResetTimer()
	for i := range b.N {
		ch <- uint64(i)
	}
	close(ch)
	<-done
}
