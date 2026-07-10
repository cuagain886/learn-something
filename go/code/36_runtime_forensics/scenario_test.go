package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRunWithDiagnosticsWritesFiles(t *testing.T) {
	cpuPath := filepath.Join(t.TempDir(), "cpu.pprof")
	tracePath := filepath.Join(t.TempDir(), "trace.out")
	_, err := RunWithDiagnostics(context.Background(), ScenarioConfig{Scenario: ScenarioCPU, Duration: 30 * time.Millisecond, Workers: 2}, DiagnosticsOptions{CPUProfile: cpuPath, Trace: tracePath})
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{cpuPath, tracePath} {
		info, err := os.Stat(path)
		if err != nil || info.Size() == 0 {
			t.Fatalf("path=%s info=%v err=%v", path, info, err)
		}
	}
}

func TestRunScenarioSupportsSafeModes(t *testing.T) {
	for _, scenario := range []Scenario{ScenarioCPU, ScenarioAlloc, ScenarioMutex, ScenarioBlock} {
		t.Run(string(scenario), func(t *testing.T) {
			got, err := RunScenario(context.Background(), ScenarioConfig{Scenario: scenario, Duration: 5 * time.Millisecond, Workers: 4})
			if err != nil {
				t.Fatal(err)
			}
			if got.Operations == 0 || got.Scenario != scenario {
				t.Fatalf("report=%+v", got)
			}
		})
	}
}

func TestRunScenarioValidatesAndCancels(t *testing.T) {
	if _, err := RunScenario(context.Background(), ScenarioConfig{}); !errors.Is(err, ErrInvalidScenario) {
		t.Fatalf("error=%v", err)
	}
	if _, err := RunScenario(context.Background(), ScenarioConfig{Scenario: "mystery", Duration: time.Millisecond, Workers: 1}); !errors.Is(err, ErrUnknownScenario) {
		t.Fatalf("error=%v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := RunScenario(ctx, ScenarioConfig{Scenario: ScenarioCPU, Duration: time.Second, Workers: 1}); !errors.Is(err, context.Canceled) {
		t.Fatalf("error=%v", err)
	}
}

func TestReadRuntimeSnapshot(t *testing.T) {
	got, err := ReadRuntimeSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	if got.Goroutines == 0 || got.HeapGoal == 0 {
		t.Fatalf("snapshot=%+v", got)
	}
}
