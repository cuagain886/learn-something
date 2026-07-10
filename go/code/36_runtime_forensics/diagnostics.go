package main

import (
	"context"
	"fmt"
	"os"
	"runtime/pprof"
	"runtime/trace"
)

type DiagnosticsOptions struct{ CPUProfile, Trace string }

func RunWithDiagnostics(ctx context.Context, cfg ScenarioConfig, options DiagnosticsOptions) (Report, error) {
	var cpuFile, traceFile *os.File
	cpuStarted, traceStarted := false, false
	cleanup := func() {
		if traceStarted {
			trace.Stop()
		}
		if traceFile != nil {
			_ = traceFile.Close()
		}
		if cpuStarted {
			pprof.StopCPUProfile()
		}
		if cpuFile != nil {
			_ = cpuFile.Close()
		}
	}
	if options.CPUProfile != "" {
		var err error
		cpuFile, err = os.Create(options.CPUProfile)
		if err != nil {
			return Report{}, fmt.Errorf("create CPU profile: %w", err)
		}
		if err = pprof.StartCPUProfile(cpuFile); err != nil {
			_ = cpuFile.Close()
			return Report{}, fmt.Errorf("start CPU profile: %w", err)
		}
		cpuStarted = true
	}
	if options.Trace != "" {
		var err error
		traceFile, err = os.Create(options.Trace)
		if err != nil {
			cleanup()
			return Report{}, fmt.Errorf("create trace: %w", err)
		}
		if err = trace.Start(traceFile); err != nil {
			cleanup()
			return Report{}, fmt.Errorf("start trace: %w", err)
		}
		traceStarted = true
	}
	report, err := RunScenario(ctx, cfg)
	cleanup()
	return report, err
}
