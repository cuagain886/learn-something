package main

import (
	"context"
	"errors"
	"testing"
)

func TestRunCPUWorkloadCompletesEveryTask(t *testing.T) {
	cfg := WorkloadConfig{Tasks: 64, Parallelism: 4, Iterations: 200}
	got, err := RunCPUWorkload(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if got.Completed != cfg.Tasks {
		t.Fatalf("Completed = %d, want %d", got.Completed, cfg.Tasks)
	}
	want, err := RunCPUWorkload(context.Background(), WorkloadConfig{
		Tasks: cfg.Tasks, Parallelism: 1, Iterations: cfg.Iterations,
	})
	if err != nil || got.Checksum != want.Checksum {
		t.Fatalf("parallel checksum = %d, sequential = %d, err = %v", got.Checksum, want.Checksum, err)
	}
}

func TestRunCPUWorkloadRejectsInvalidConfig(t *testing.T) {
	_, err := RunCPUWorkload(context.Background(), WorkloadConfig{})
	if !errors.Is(err, ErrInvalidWorkload) {
		t.Fatalf("error = %v, want ErrInvalidWorkload", err)
	}
}

func TestRunCPUWorkloadObservesCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := RunCPUWorkload(ctx, WorkloadConfig{Tasks: 10, Parallelism: 2, Iterations: 10})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}

func TestReadSchedulerSnapshot(t *testing.T) {
	got, err := ReadSchedulerSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	if got.Goroutines == 0 || got.GOMAXPROCS == 0 {
		t.Fatalf("snapshot = %+v, want positive counts", got)
	}
}
