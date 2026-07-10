package main

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

type configSnapshot interface {
	Load() Config
	Store(Config)
}

func TestAtomicSnapshotPublishesImmutableCopy(t *testing.T) {
	original := Config{Version: 1, Endpoint: "v1", Timeout: time.Second}
	snapshot := NewAtomicSnapshot(original)

	original.Endpoint = "mutated"
	if got := snapshot.Load().Endpoint; got != "v1" {
		t.Fatalf("Load().Endpoint = %q, want v1", got)
	}

	next := Config{Version: 2, Endpoint: "v2", Timeout: 2 * time.Second}
	snapshot.Store(next)
	next.Endpoint = "mutated-again"

	if got := snapshot.Load(); got.Version != 2 || got.Endpoint != "v2" {
		t.Fatalf("Load() = %+v, want published v2 snapshot", got)
	}
}

func TestLockedSnapshotPublishesImmutableCopy(t *testing.T) {
	original := Config{Version: 1, Endpoint: "locked-v1", Timeout: time.Second}
	snapshot := NewLockedSnapshot(original)

	original.Endpoint = "mutated"
	if got := snapshot.Load().Endpoint; got != "locked-v1" {
		t.Fatalf("Load().Endpoint = %q, want locked-v1", got)
	}

	snapshot.Store(Config{Version: 2, Endpoint: "locked-v2", Timeout: 2 * time.Second})
	if got := snapshot.Load(); got.Version != 2 || got.Endpoint != "locked-v2" {
		t.Fatalf("Load() = %+v, want published locked-v2 snapshot", got)
	}
}

func TestSnapshotsPublishCoherentVersionsConcurrently(t *testing.T) {
	tests := []struct {
		name string
		new  func(Config) configSnapshot
	}{
		{"atomic", func(initial Config) configSnapshot { return NewAtomicSnapshot(initial) }},
		{"locked", func(initial Config) configSnapshot { return NewLockedSnapshot(initial) }},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			snapshot := tt.new(Config{Version: 0, Endpoint: "v-0"})
			start := make(chan struct{})
			done := make(chan struct{})
			errCh := make(chan error, 8)

			var readers sync.WaitGroup
			for range 8 {
				readers.Add(1)
				go func() {
					defer readers.Done()
					<-start
					for {
						got := snapshot.Load()
						if want := fmt.Sprintf("v-%d", got.Version); got.Endpoint != want {
							errCh <- fmt.Errorf("Load() = %+v, want Endpoint %q", got, want)
							return
						}
						select {
						case <-done:
							return
						default:
						}
					}
				}()
			}

			close(start)
			for version := int64(1); version <= 2_000; version++ {
				snapshot.Store(Config{Version: version, Endpoint: fmt.Sprintf("v-%d", version)})
			}
			close(done)
			readers.Wait()
			close(errCh)

			for err := range errCh {
				t.Error(err)
			}
		})
	}
}
