/*
27_advanced_testing_profiling —— Fuzz、Race、Benchmark、pprof 与 trace

【本节学什么】
 1. 单元、属性、Golden 与 Fuzz 测试各自发现什么问题
 2. 怎样写不会被编译器消除、能报告分配的 Benchmark
 3. CPU/heap/mutex/block profile 与 trace 应该怎样选择
 4. 为什么“采样 → 修改 → 回归”比凭感觉优化可靠

【运行】

		go test -race ./27_advanced_testing_profiling
		go test -fuzz=FuzzFrameRoundTrip -fuzztime=10s ./27_advanced_testing_profiling
		go test -run='^$' -bench=. -benchmem ./27_advanced_testing_profiling
	  go run ./27_advanced_testing_profiling -mode=cpu -duration=2s -out cpu.pprof
	  go run ./27_advanced_testing_profiling -mode=trace -duration=2s -out trace.out
*/
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"math/bits"
	"os"
	"runtime"
	"runtime/pprof"
	"runtime/trace"
	"sync"
	"sync/atomic"
	"time"
)

var ErrUnknownMode = errors.New("unknown workload mode")

var workloadSink atomic.Uint64

func main() {
	mode := flag.String("mode", "cpu", "cpu|alloc|mutex|block|trace")
	duration := flag.Duration("duration", time.Second, "workload duration")
	outputPath := flag.String("out", "", "optional profile/trace output path")
	flag.Parse()

	if *duration <= 0 {
		fmt.Fprintln(os.Stderr, "duration must be positive")
		return
	}
	if *mode == "trace" && *outputPath == "" {
		fmt.Fprintln(os.Stderr, "trace mode requires -out")
		return
	}

	var output *os.File
	var err error
	if *outputPath != "" {
		output, err = os.Create(*outputPath)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return
		}
		defer output.Close()
	}

	if *mode == "cpu" && output != nil {
		if err := pprof.StartCPUProfile(output); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return
		}
	}
	if *mode == "trace" {
		if err := trace.Start(output); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), *duration)
	err = runWorkload(ctx, *mode)
	cancel()

	if *mode == "cpu" && output != nil {
		pprof.StopCPUProfile()
	}
	if *mode == "trace" {
		trace.Stop()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return
	}

	if output != nil {
		profileName := map[string]string{"alloc": "heap", "mutex": "mutex", "block": "block"}[*mode]
		if profileName != "" {
			if err := pprof.Lookup(profileName).WriteTo(output, 0); err != nil {
				fmt.Fprintln(os.Stderr, err)
				return
			}
		}
	}
	fmt.Printf("mode=%s duration=%v sink=%d output=%q\n", *mode, *duration, workloadSink.Load(), *outputPath)
}

func runWorkload(ctx context.Context, mode string) error {
	switch mode {
	case "cpu", "trace":
		runCPUWorkload(ctx)
	case "alloc":
		runAllocationWorkload(ctx)
	case "mutex":
		runMutexWorkload(ctx)
	case "block":
		runBlockWorkload(ctx)
	default:
		return fmt.Errorf("%w: %s", ErrUnknownMode, mode)
	}
	return nil
}

func runCPUWorkload(ctx context.Context) {
	value := uint64(0x9e3779b97f4a7c15)
	for {
		select {
		case <-ctx.Done():
			workloadSink.Store(value)
			return
		default:
			for index := 0; index < 2_000; index++ {
				value = bits.RotateLeft64(value^uint64(index), 13) * 0xbf58476d1ce4e5b9
			}
		}
	}
}

func runAllocationWorkload(ctx context.Context) {
	retained := make([][]byte, 0, 128)
	for {
		select {
		case <-ctx.Done():
			runtime.KeepAlive(retained)
			return
		default:
			block := make([]byte, 4<<10)
			block[0] = byte(len(retained))
			retained = append(retained, block)
			if len(retained) == cap(retained) {
				workloadSink.Add(uint64(retained[len(retained)-1][0]))
				retained = retained[:0]
			}
		}
	}
}

func runMutexWorkload(ctx context.Context) {
	previous := runtime.SetMutexProfileFraction(1)
	defer runtime.SetMutexProfileFraction(previous)
	var mu sync.Mutex
	var counter uint64
	var workers sync.WaitGroup
	for range 8 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for ctx.Err() == nil {
				mu.Lock()
				counter++
				mu.Unlock()
			}
		}()
	}
	workers.Wait()
	workloadSink.Store(counter)
}

func runBlockWorkload(ctx context.Context) {
	runtime.SetBlockProfileRate(1)
	defer runtime.SetBlockProfileRate(0)
	values := make(chan uint64)
	var total atomic.Uint64
	var workers sync.WaitGroup
	workers.Add(2)
	go func() {
		defer workers.Done()
		for value := uint64(0); ; value++ {
			select {
			case values <- value:
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() {
		defer workers.Done()
		for {
			select {
			case value := <-values:
				total.Add(value)
			case <-ctx.Done():
				return
			}
		}
	}()
	workers.Wait()
	workloadSink.Store(total.Load())
}
