package resilience

import (
	"context"
	"errors"
	"sync"
	"time"

	"learn_go/28_production_service/internal/jobs"
)

type State uint8

const (
	Closed State = iota
	Open
	HalfOpen
)

var (
	ErrCircuitOpen          = errors.New("circuit breaker is open")
	ErrInvalidBreakerConfig = errors.New("invalid circuit breaker configuration")
)

type Breaker struct {
	mu        sync.Mutex
	threshold int
	cooldown  time.Duration
	now       func() time.Time

	state         State
	failures      int
	openedAt      time.Time
	probeInFlight bool
}

func NewBreaker(threshold int, cooldown time.Duration, now func() time.Time) (*Breaker, error) {
	if threshold <= 0 || cooldown <= 0 || now == nil {
		return nil, ErrInvalidBreakerConfig
	}
	return &Breaker{threshold: threshold, cooldown: cooldown, now: now}, nil
}

func (b *Breaker) State() State {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.state
}

func (b *Breaker) allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	switch b.state {
	case Closed:
		return true
	case Open:
		if b.now().Sub(b.openedAt) < b.cooldown {
			return false
		}
		b.state = HalfOpen
		b.probeInFlight = true
		return true
	case HalfOpen:
		return false
	default:
		return false
	}
}

func (b *Breaker) complete(err error, canceled bool) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.state == HalfOpen {
		b.probeInFlight = false
		if err == nil {
			b.state = Closed
			b.failures = 0
			return
		}
		b.state = Open
		b.openedAt = b.now()
		return
	}
	if b.state != Closed {
		return
	}
	if err == nil {
		b.failures = 0
		return
	}
	if canceled {
		return
	}
	b.failures++
	if b.failures >= b.threshold {
		b.state = Open
		b.openedAt = b.now()
	}
}

type CircuitExecutor struct {
	Next    jobs.Executor
	Breaker *Breaker
}

func (e *CircuitExecutor) Execute(ctx context.Context, payload string) (string, error) {
	if ctx == nil {
		return "", jobs.ErrNilContext
	}
	if e == nil || e.Next == nil || e.Breaker == nil {
		return "", ErrInvalidBreakerConfig
	}
	if cause := context.Cause(ctx); cause != nil {
		return "", cause
	}
	if !e.Breaker.allow() {
		return "", ErrCircuitOpen
	}
	result, err := e.Next.Execute(ctx, payload)
	e.Breaker.complete(err, context.Cause(ctx) != nil)
	if cause := context.Cause(ctx); cause != nil {
		return "", cause
	}
	return result, err
}
