package main

import (
	"context"
	"errors"
	"fmt"
	"math/bits"
	"runtime/metrics"
	"sync"
	"sync/atomic"
)

var ErrInvalidWorkload = errors.New("invalid scheduler workload")

type WorkloadConfig struct {
	Tasks       int
	Parallelism int
	Iterations  int
}

type WorkloadResult struct {
	Completed int
	Checksum  uint64
}

type SchedulerSnapshot struct {
	Goroutines uint64
	GOMAXPROCS uint64
}

func RunCPUWorkload(ctx context.Context, cfg WorkloadConfig) (WorkloadResult, error) {
	if cfg.Tasks <= 0 || cfg.Parallelism <= 0 || cfg.Iterations <= 0 {
		return WorkloadResult{}, fmt.Errorf("%w: tasks, parallelism and iterations must be positive", ErrInvalidWorkload)
	}
	if err := ctx.Err(); err != nil {
		return WorkloadResult{}, err
	}

	workers := min(cfg.Parallelism, cfg.Tasks)
	type partial struct {
		completed int
		checksum  uint64
	}
	partials := make(chan partial, workers)
	var next atomic.Int64
	var group sync.WaitGroup
	group.Add(workers)
	for range workers {
		go func() {
			defer group.Done()
			local := partial{}
			for {
				select {
				case <-ctx.Done():
					partials <- local
					return
				default:
				}
				index := int(next.Add(1) - 1)
				if index >= cfg.Tasks {
					partials <- local
					return
				}
				local.completed++
				local.checksum += taskChecksum(index, cfg.Iterations)
			}
		}()
	}
	group.Wait()
	close(partials)

	result := WorkloadResult{}
	for item := range partials {
		result.Completed += item.completed
		result.Checksum += item.checksum
	}
	if result.Completed == cfg.Tasks {
		return result, nil
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	return result, errors.New("scheduler workload stopped before completing all tasks")
}

func taskChecksum(task, iterations int) uint64 {
	value := uint64(task+1) * 0x9e3779b97f4a7c15
	for index := range iterations {
		value = bits.RotateLeft64(value^uint64(index+1), 13) * 0xbf58476d1ce4e5b9
	}
	return value
}

func ReadSchedulerSnapshot() (SchedulerSnapshot, error) {
	samples := []metrics.Sample{
		{Name: "/sched/goroutines:goroutines"},
		{Name: "/sched/gomaxprocs:threads"},
	}
	metrics.Read(samples)
	values := make([]uint64, len(samples))
	for index, sample := range samples {
		if sample.Value.Kind() != metrics.KindUint64 {
			return SchedulerSnapshot{}, fmt.Errorf("metric %s has kind %v, want uint64", sample.Name, sample.Value.Kind())
		}
		values[index] = sample.Value.Uint64()
	}
	return SchedulerSnapshot{Goroutines: values[0], GOMAXPROCS: values[1]}, nil
}
