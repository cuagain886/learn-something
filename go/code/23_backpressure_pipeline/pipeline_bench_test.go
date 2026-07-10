package main

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync/atomic"
	"testing"
)

var pipelineBenchmarkSink atomic.Int64

func BenchmarkPipeline(b *testing.B) {
	tests := []struct {
		workers  int
		capacity int
		policy   Policy
	}{
		{1, 0, PolicyBlock},
		{runtime.GOMAXPROCS(0), 64, PolicyBlock},
		{runtime.GOMAXPROCS(0), 64, PolicyReject},
		{runtime.GOMAXPROCS(0), 64, PolicyKeepLatest},
		{runtime.GOMAXPROCS(0), 1024, PolicyBlock},
	}

	for _, tt := range tests {
		name := fmt.Sprintf("workers=%d/queue=%d/policy=%d", tt.workers, tt.capacity, tt.policy)
		b.Run(name, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				pipeline, err := NewPipeline(context.Background(), tt.workers, tt.capacity, tt.policy,
					func(_ context.Context, value int) (int, error) { return value * 2, nil })
				if err != nil {
					b.Fatal(err)
				}
				consumed := make(chan struct{})
				go func() {
					defer close(consumed)
					for result := range pipeline.Results() {
						pipelineBenchmarkSink.Add(int64(result.Value))
					}
				}()
				for value := range 128 {
					err := pipeline.Submit(context.Background(), value)
					if err != nil && !errors.Is(err, ErrQueueFull) {
						b.Fatal(err)
					}
				}
				if err := pipeline.Close(); err != nil {
					b.Fatal(err)
				}
				if err := pipeline.Wait(); err != nil {
					b.Fatal(err)
				}
				<-consumed
			}
		})
	}
}
