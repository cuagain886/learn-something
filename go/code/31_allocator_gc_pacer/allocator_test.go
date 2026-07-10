package main

import (
	"errors"
	"runtime/debug"
	"testing"
)

func TestAllocateAndRetain(t *testing.T) {
	retained, allocated, err := AllocateAndRetain(AllocationConfig{
		Objects: 10, BytesPerObject: 32, KeepEvery: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	if allocated != 320 || len(retained) != 4 {
		t.Fatalf("allocated=%d retained=%d", allocated, len(retained))
	}
	for _, object := range retained {
		if len(object) != 32 || object[0] == 0 || object[len(object)-1] == 0 {
			t.Fatalf("object was not fully touched: len=%d first=%d last=%d", len(object), object[0], object[len(object)-1])
		}
	}
}

func TestAllocateAndRetainRejectsInvalidConfig(t *testing.T) {
	_, _, err := AllocateAndRetain(AllocationConfig{})
	if !errors.Is(err, ErrInvalidAllocation) {
		t.Fatalf("error=%v, want ErrInvalidAllocation", err)
	}
}

func TestWithGCSettingsCallsBodyAndRestoresSettings(t *testing.T) {
	originalPercent := debug.SetGCPercent(91)
	defer debug.SetGCPercent(originalPercent)
	originalLimit := debug.SetMemoryLimit(128 << 20)
	defer debug.SetMemoryLimit(originalLimit)

	called := false
	err := WithGCSettings(GCSettings{GCPercent: 50, MemoryLimit: 64 << 20}, func() {
		called = true
	})
	if err != nil || !called {
		t.Fatalf("called=%v err=%v", called, err)
	}
	if current := debug.SetGCPercent(91); current != 91 {
		t.Fatalf("GCPercent restored to %d, want 91", current)
	}
	if current := debug.SetMemoryLimit(128 << 20); current != 128<<20 {
		t.Fatalf("MemoryLimit restored to %d, want %d", current, 128<<20)
	}
}

func TestReadMemorySnapshotReturnsConsistentValues(t *testing.T) {
	got := ReadMemorySnapshot()
	if got.HeapInuse+got.HeapIdle == 0 {
		t.Fatalf("snapshot=%+v, want managed heap pages", got)
	}
}
