/*
36_runtime_forensics —— runtime 综合事故实验室

【安全运行】 go run ./36_runtime_forensics -scenario=cpu -duration=100ms
【诊断产物】 go run ./36_runtime_forensics -scenario=alloc -cpu-profile cpu.pprof -trace trace.out
【危险隔离】 go run ./36_runtime_forensics -danger=panic
*/
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"
)

func main() {
	scenario := flag.String("scenario", "cpu", "cpu|alloc|mutex|block")
	duration := flag.Duration("duration", 100*time.Millisecond, "safe scenario duration")
	workers := flag.Int("workers", 4, "workers")
	cpuProfile := flag.String("cpu-profile", "", "optional CPU profile path")
	tracePath := flag.String("trace", "", "optional trace path")
	danger := flag.String("danger", "", "panic|deadlock in child process")
	child := flag.String("child", "", "internal dangerous child mode")
	flag.Parse()
	if *child != "" {
		fmt.Fprintln(os.Stderr, "FORENSICS_"+*child)
		switch *child {
		case "panic":
			panic("forensics child panic")
		case "deadlock":
			select {}
		default:
			fmt.Fprintln(os.Stderr, "unknown child")
		}
		return
	}
	if *danger != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		executable, err := os.Executable()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return
		}
		result, runErr := RunChild(ctx, ChildSpec{Executable: executable, Args: []string{"-child=" + *danger}, Env: os.Environ()})
		fmt.Printf("exit=%d timedout=%v err=%v\n%s", result.ExitCode, result.TimedOut, runErr, result.Output)
		return
	}
	report, err := RunWithDiagnostics(context.Background(), ScenarioConfig{Scenario: Scenario(*scenario), Duration: *duration, Workers: *workers}, DiagnosticsOptions{CPUProfile: *cpuProfile, Trace: *tracePath})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return
	}
	fmt.Printf("scenario=%s operations=%d\nbefore=%+v\nafter=%+v\n", report.Scenario, report.Operations, report.Before, report.After)
}
