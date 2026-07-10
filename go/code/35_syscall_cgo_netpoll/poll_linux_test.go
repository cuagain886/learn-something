//go:build linux

package main

import (
	"context"
	"testing"
	"time"
)

func TestRunPlatformPollObservesEpollReadiness(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	count, err := RunPlatformPoll(ctx)
	if err != nil || count == 0 {
		t.Fatalf("count=%d err=%v", count, err)
	}
}
