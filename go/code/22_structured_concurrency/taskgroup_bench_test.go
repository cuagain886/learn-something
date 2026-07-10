package main

import (
	"context"
	"testing"
)

var taskResultSink int

func BenchmarkDirectTaskCall(b *testing.B) {
	task := func(context.Context) error {
		taskResultSink++
		return nil
	}
	b.ReportAllocs()
	for b.Loop() {
		_ = task(context.Background())
	}
}

func BenchmarkTaskGroupUnlimited(b *testing.B) {
	benchmarkTaskGroup(b, 0)
}

func BenchmarkTaskGroupLimited(b *testing.B) {
	benchmarkTaskGroup(b, 4)
}

func benchmarkTaskGroup(b *testing.B, limit int) {
	b.Helper()
	b.ReportAllocs()
	for b.Loop() {
		group, err := NewTaskGroup(context.Background(), limit)
		if err != nil {
			b.Fatal(err)
		}
		for range 16 {
			if err := group.Go(func(context.Context) error { return nil }); err != nil {
				b.Fatal(err)
			}
		}
		if err := group.Wait(); err != nil {
			b.Fatal(err)
		}
	}
}
