//go:build !linux

package main

import (
	"context"
	"errors"
	"runtime"
	"testing"
)

func TestPlatformPollerAndUnsupportedExperiment(t *testing.T) {
	want := "unsupported"
	switch runtime.GOOS {
	case "windows":
		want = "iocp"
	case "darwin", "freebsd", "openbsd", "netbsd", "dragonfly":
		want = "kqueue"
	}
	if got := PlatformPoller(); got != want {
		t.Fatalf("PlatformPoller() = %q, want %q", got, want)
	}
	if _, err := RunPlatformPoll(context.Background()); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("RunPlatformPoll() = %v, want ErrUnsupported", err)
	}
}
