package config

import (
	"errors"
	"testing"
	"time"
)

func TestDefaultIsValid(t *testing.T) {
	config := Default()
	if err := config.Validate(); err != nil {
		t.Fatalf("Default().Validate() = %v", err)
	}
}

func TestConfigValidateRejectsInvalidFields(t *testing.T) {
	valid := Default()
	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{"empty addr", func(config *Config) { config.Addr = "" }},
		{"empty debug addr", func(config *Config) { config.DebugAddr = "" }},
		{"workers", func(config *Config) { config.Workers = 0 }},
		{"queue", func(config *Config) { config.QueueSize = 0 }},
		{"body", func(config *Config) { config.MaxBodyBytes = 0 }},
		{"task timeout", func(config *Config) { config.TaskTimeout = 0 }},
		{"shutdown timeout", func(config *Config) { config.ShutdownTimeout = 0 }},
		{"rate", func(config *Config) { config.RatePerSecond = 0 }},
		{"burst", func(config *Config) { config.Burst = 0 }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			config := valid
			tt.mutate(&config)
			if err := config.Validate(); !errors.Is(err, ErrInvalidConfig) {
				t.Fatalf("Validate() = %v, want ErrInvalidConfig", err)
			}
		})
	}
}

func TestSnapshotPublishesValidatedCopies(t *testing.T) {
	initial := Default()
	snapshot, err := NewSnapshot(initial)
	if err != nil {
		t.Fatal(err)
	}
	initial.Addr = "mutated"
	if got := snapshot.Load().Addr; got == "mutated" {
		t.Fatal("Snapshot retained caller-owned Config")
	}

	next := snapshot.Load()
	next.TaskTimeout = 3 * time.Second
	if err := snapshot.Store(next); err != nil {
		t.Fatal(err)
	}
	if got := snapshot.Load().TaskTimeout; got != 3*time.Second {
		t.Fatalf("Load().TaskTimeout = %v, want 3s", got)
	}

	invalid := next
	invalid.Workers = 0
	if err := snapshot.Store(invalid); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("Store(invalid) = %v, want ErrInvalidConfig", err)
	}
	if got := snapshot.Load().Workers; got != next.Workers {
		t.Fatalf("invalid Store changed snapshot workers to %d", got)
	}
}
