package config

import (
	"errors"
	"fmt"
	"runtime"
	"sync/atomic"
	"time"
)

var ErrInvalidConfig = errors.New("invalid service configuration")

type Config struct {
	Addr            string
	DebugAddr       string
	Workers         int
	QueueSize       int
	MaxBodyBytes    int64
	TaskTimeout     time.Duration
	ShutdownTimeout time.Duration
	RatePerSecond   float64
	Burst           int
}

func Default() Config {
	return Config{
		Addr:            "127.0.0.1:8080",
		DebugAddr:       "127.0.0.1:6060",
		Workers:         runtime.GOMAXPROCS(0),
		QueueSize:       128,
		MaxBodyBytes:    1 << 20,
		TaskTimeout:     5 * time.Second,
		ShutdownTimeout: 10 * time.Second,
		RatePerSecond:   100,
		Burst:           200,
	}
}

func (c Config) Validate() error {
	switch {
	case c.Addr == "":
		return fmt.Errorf("%w: Addr is empty", ErrInvalidConfig)
	case c.DebugAddr == "":
		return fmt.Errorf("%w: DebugAddr is empty", ErrInvalidConfig)
	case c.Workers <= 0:
		return fmt.Errorf("%w: Workers must be positive", ErrInvalidConfig)
	case c.QueueSize <= 0:
		return fmt.Errorf("%w: QueueSize must be positive", ErrInvalidConfig)
	case c.MaxBodyBytes <= 0:
		return fmt.Errorf("%w: MaxBodyBytes must be positive", ErrInvalidConfig)
	case c.TaskTimeout <= 0:
		return fmt.Errorf("%w: TaskTimeout must be positive", ErrInvalidConfig)
	case c.ShutdownTimeout <= 0:
		return fmt.Errorf("%w: ShutdownTimeout must be positive", ErrInvalidConfig)
	case c.RatePerSecond <= 0:
		return fmt.Errorf("%w: RatePerSecond must be positive", ErrInvalidConfig)
	case c.Burst <= 0:
		return fmt.Errorf("%w: Burst must be positive", ErrInvalidConfig)
	default:
		return nil
	}
}

type Snapshot struct {
	value atomic.Pointer[Config]
}

func NewSnapshot(initial Config) (*Snapshot, error) {
	if err := initial.Validate(); err != nil {
		return nil, err
	}
	snapshot := &Snapshot{}
	copyOfInitial := initial
	snapshot.value.Store(&copyOfInitial)
	return snapshot, nil
}

func (s *Snapshot) Load() Config {
	current := s.value.Load()
	if current == nil {
		return Config{}
	}
	return *current
}

func (s *Snapshot) Store(next Config) error {
	if err := next.Validate(); err != nil {
		return err
	}
	copyOfNext := next
	s.value.Store(&copyOfNext)
	return nil
}
