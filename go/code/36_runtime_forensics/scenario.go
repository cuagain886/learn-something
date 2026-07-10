package main

import (
	"context"
	"errors"
	"fmt"
	"math/bits"
	"runtime"
	"runtime/metrics"
	"sync"
	"sync/atomic"
	"time"
)

type Scenario string

const (
	ScenarioCPU   Scenario = "cpu"
	ScenarioAlloc Scenario = "alloc"
	ScenarioMutex Scenario = "mutex"
	ScenarioBlock Scenario = "block"
)

var (
	ErrUnknownScenario = errors.New("unknown runtime scenario")
	ErrInvalidScenario = errors.New("invalid runtime scenario")
)

type ScenarioConfig struct {
	Scenario Scenario
	Duration time.Duration
	Workers  int
}
type RuntimeSnapshot struct {
	Goroutines, HeapObjectBytes, HeapObjects, HeapGoal uint64
	NumGC                                              uint32
}
type Report struct {
	Scenario      Scenario
	Operations    uint64
	Before, After RuntimeSnapshot
}

func RunScenario(parent context.Context, cfg ScenarioConfig) (Report, error) {
	if cfg.Duration <= 0 || cfg.Workers <= 0 {
		return Report{}, fmt.Errorf("%w: duration and workers must be positive", ErrInvalidScenario)
	}
	if cfg.Scenario != ScenarioCPU && cfg.Scenario != ScenarioAlloc && cfg.Scenario != ScenarioMutex && cfg.Scenario != ScenarioBlock {
		return Report{}, fmt.Errorf("%w: %s", ErrUnknownScenario, cfg.Scenario)
	}
	if err := parent.Err(); err != nil {
		return Report{}, err
	}
	before, err := ReadRuntimeSnapshot()
	if err != nil {
		return Report{}, err
	}
	ctx, cancel := context.WithTimeout(parent, cfg.Duration)
	defer cancel()
	var operations atomic.Uint64
	var group sync.WaitGroup
	switch cfg.Scenario {
	case ScenarioCPU:
		for worker := range cfg.Workers {
			group.Add(1)
			go func() {
				defer group.Done()
				value := uint64(worker + 1)
				for {
					value = bits.RotateLeft64(value^operations.Add(1), 13)
					select {
					case <-ctx.Done():
						runtime.KeepAlive(value)
						return
					default:
					}
				}
			}()
		}
	case ScenarioAlloc:
		for range cfg.Workers {
			group.Add(1)
			go func() {
				defer group.Done()
				retained := make([][]byte, 64)
				index := 0
				for {
					block := make([]byte, 1024)
					block[0] = byte(index)
					retained[index%len(retained)] = block
					index++
					operations.Add(1)
					select {
					case <-ctx.Done():
						runtime.KeepAlive(retained)
						return
					default:
					}
				}
			}()
		}
	case ScenarioMutex:
		var mu sync.Mutex
		counter := uint64(0)
		for range cfg.Workers {
			group.Add(1)
			go func() {
				defer group.Done()
				for {
					mu.Lock()
					counter++
					mu.Unlock()
					operations.Add(1)
					select {
					case <-ctx.Done():
						return
					default:
					}
				}
			}()
		}
		runtime.KeepAlive(&counter)
	case ScenarioBlock:
		values := make(chan uint64)
		group.Add(1)
		go func() {
			defer group.Done()
			for {
				select {
				case <-values:
					operations.Add(1)
				case <-ctx.Done():
					return
				}
			}
		}()
		for worker := range cfg.Workers {
			group.Add(1)
			go func() {
				defer group.Done()
				value := uint64(worker)
				for {
					select {
					case values <- value:
						value++
					case <-ctx.Done():
						return
					}
				}
			}()
		}
	}
	group.Wait()
	after, err := ReadRuntimeSnapshot()
	if err != nil {
		return Report{}, err
	}
	report := Report{Scenario: cfg.Scenario, Operations: operations.Load(), Before: before, After: after}
	if err := parent.Err(); err != nil {
		return report, err
	}
	return report, nil
}

func ReadRuntimeSnapshot() (RuntimeSnapshot, error) {
	names := []string{"/sched/goroutines:goroutines", "/memory/classes/heap/objects:bytes", "/gc/heap/objects:objects", "/gc/heap/goal:bytes"}
	samples := make([]metrics.Sample, len(names))
	for i, name := range names {
		samples[i].Name = name
	}
	metrics.Read(samples)
	values := make([]uint64, len(samples))
	for i, sample := range samples {
		if sample.Value.Kind() != metrics.KindUint64 {
			return RuntimeSnapshot{}, fmt.Errorf("metric %s has kind %v", sample.Name, sample.Value.Kind())
		}
		values[i] = sample.Value.Uint64()
	}
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	return RuntimeSnapshot{Goroutines: values[0], HeapObjectBytes: values[1], HeapObjects: values[2], HeapGoal: values[3], NumGC: stats.NumGC}, nil
}
