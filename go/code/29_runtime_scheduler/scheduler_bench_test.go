package main

import (
	"context"
	"runtime"
	"testing"
)

var schedulerResultSink WorkloadResult

func BenchmarkCPUWorkloadParallelism1(b *testing.B) {
	benchmarkWorkload(b, WorkloadConfig{Tasks: 16, Parallelism: 1, Iterations: 128})
}

func BenchmarkCPUWorkloadGOMAXPROCS(b *testing.B) {
	benchmarkWorkload(b, WorkloadConfig{Tasks: 16, Parallelism: runtime.GOMAXPROCS(0), Iterations: 128})
}

func BenchmarkFineGrainedTasks(b *testing.B) {
	benchmarkWorkload(b, WorkloadConfig{Tasks: 128, Parallelism: runtime.GOMAXPROCS(0), Iterations: 64})
}

func BenchmarkCoarseGrainedTasks(b *testing.B) {
	benchmarkWorkload(b, WorkloadConfig{Tasks: 8, Parallelism: runtime.GOMAXPROCS(0), Iterations: 1_024})
}

func benchmarkWorkload(b *testing.B, cfg WorkloadConfig) {
	b.Helper()
	b.ReportAllocs()
	for b.Loop() {
		result, err := RunCPUWorkload(context.Background(), cfg)
		if err != nil {
			b.Fatal(err)
		}
		schedulerResultSink = result
	}
}
