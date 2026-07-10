package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestRunChildCapturesAbnormalExit(t *testing.T) {
	result, err := RunChild(context.Background(), ChildSpec{Executable: os.Args[0], Args: []string{"-test.run=TestForensicsHelper"}, Env: append(os.Environ(), "GO_FORENSICS_HELPER=panic")})
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode == 0 || !strings.Contains(result.Output, "FORENSICS_PANIC") {
		t.Fatalf("result=%+v", result)
	}
}

func TestRunChildEnforcesTimeout(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	result, err := RunChild(ctx, ChildSpec{Executable: os.Args[0], Args: []string{"-test.run=TestForensicsHelper"}, Env: append(os.Environ(), "GO_FORENSICS_HELPER=sleep")})
	if !result.TimedOut || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestForensicsHelper(t *testing.T) {
	switch os.Getenv("GO_FORENSICS_HELPER") {
	case "panic":
		fmt.Fprintln(os.Stderr, "FORENSICS_PANIC")
		panic("child panic")
	case "sleep":
		time.Sleep(5 * time.Second)
	}
}
