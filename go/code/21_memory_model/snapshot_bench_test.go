package main

import (
	"sync"
	"sync/atomic"
	"testing"
)

var snapshotSink Config

func BenchmarkAtomicSnapshotLoad(b *testing.B) {
	snapshot := NewAtomicSnapshot(Config{Version: 1, Endpoint: "atomic"})
	b.ReportAllocs()
	for b.Loop() {
		snapshotSink = snapshot.Load()
	}
}

func BenchmarkLockedSnapshotLoad(b *testing.B) {
	snapshot := NewLockedSnapshot(Config{Version: 1, Endpoint: "locked"})
	b.ReportAllocs()
	for b.Loop() {
		snapshotSink = snapshot.Load()
	}
}

type adjacentCounters struct {
	left  atomic.Uint64
	right atomic.Uint64
}

// paddedCounter 假设常见的 64-byte cache line，只用于演示趋势。
// cache line 大小属于平台属性，生产代码不能把这个数字当作语言保证。
type paddedCounter struct {
	value atomic.Uint64
	_     [56]byte
}

type separatedCounters struct {
	left  paddedCounter
	right paddedCounter
}

func BenchmarkFalseSharing(b *testing.B) {
	var counters adjacentCounters
	benchmarkCounterPair(b, &counters.left, &counters.right)
}

func BenchmarkPaddedCounters(b *testing.B) {
	var counters separatedCounters
	benchmarkCounterPair(b, &counters.left.value, &counters.right.value)
}

func benchmarkCounterPair(b *testing.B, left, right *atomic.Uint64) {
	b.Helper()
	b.ReportAllocs()
	b.ResetTimer()

	var workers sync.WaitGroup
	workers.Add(2)
	go func() {
		defer workers.Done()
		for range b.N {
			left.Add(1)
		}
	}()
	go func() {
		defer workers.Done()
		for range b.N {
			right.Add(1)
		}
	}()
	workers.Wait()
}
