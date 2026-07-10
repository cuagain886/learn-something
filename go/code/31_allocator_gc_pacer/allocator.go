package main

import (
	"errors"
	"fmt"
	"math"
	"runtime"
	"runtime/debug"
)

var (
	ErrInvalidAllocation = errors.New("invalid allocation experiment")
	ErrInvalidGCSettings = errors.New("invalid GC settings")
)

type AllocationConfig struct {
	Objects        int
	BytesPerObject int
	KeepEvery      int
}

type GCSettings struct {
	GCPercent   int
	MemoryLimit int64
}

type MemorySnapshot struct {
	HeapAlloc   uint64
	HeapObjects uint64
	HeapInuse   uint64
	HeapIdle    uint64
	NumGC       uint32
}

func AllocateAndRetain(cfg AllocationConfig) ([][]byte, uint64, error) {
	if cfg.Objects <= 0 || cfg.BytesPerObject <= 0 || cfg.KeepEvery <= 0 {
		return nil, 0, fmt.Errorf("%w: all values must be positive", ErrInvalidAllocation)
	}
	objectSize := uint64(cfg.BytesPerObject)
	if uint64(cfg.Objects) > math.MaxUint64/objectSize {
		return nil, 0, fmt.Errorf("%w: allocated byte count overflows uint64", ErrInvalidAllocation)
	}

	retained := make([][]byte, 0, (cfg.Objects+cfg.KeepEvery-1)/cfg.KeepEvery)
	for index := range cfg.Objects {
		object := make([]byte, cfg.BytesPerObject)
		marker := byte(index%251 + 1)
		object[0] = marker
		object[len(object)-1] = marker
		if index%cfg.KeepEvery == 0 {
			retained = append(retained, object)
		}
	}
	return retained, uint64(cfg.Objects) * objectSize, nil
}

func WithGCSettings(settings GCSettings, body func()) error {
	if settings.GCPercent < -1 || settings.MemoryLimit <= 0 || body == nil {
		return fmt.Errorf("%w: GCPercent must be >= -1, MemoryLimit positive and body non-nil", ErrInvalidGCSettings)
	}
	oldPercent := debug.SetGCPercent(settings.GCPercent)
	defer debug.SetGCPercent(oldPercent)
	oldLimit := debug.SetMemoryLimit(settings.MemoryLimit)
	defer debug.SetMemoryLimit(oldLimit)
	body()
	return nil
}

func ReadMemorySnapshot() MemorySnapshot {
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	return MemorySnapshot{
		HeapAlloc: stats.HeapAlloc, HeapObjects: stats.HeapObjects,
		HeapInuse: stats.HeapInuse, HeapIdle: stats.HeapIdle, NumGC: stats.NumGC,
	}
}
