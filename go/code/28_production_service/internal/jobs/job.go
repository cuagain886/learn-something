package jobs

import (
	"context"
	"errors"
	"sync/atomic"
	"time"
)

type Status string

const (
	Queued    Status = "queued"
	Running   Status = "running"
	Succeeded Status = "succeeded"
	Failed    Status = "failed"
	Canceled  Status = "canceled"
)

var (
	ErrQueueFull     = errors.New("job queue is full")
	ErrClosed        = errors.New("job engine is closed")
	ErrInvalidConfig = errors.New("invalid job engine configuration")
	ErrNilContext    = errors.New("context is nil")
	ErrNilExecutor   = errors.New("executor is nil")
	ErrExecutorPanic = errors.New("executor panicked")
)

type Job struct {
	ID         string    `json:"id"`
	Payload    string    `json:"payload,omitempty"`
	Result     string    `json:"result,omitempty"`
	Error      string    `json:"error,omitempty"`
	Status     Status    `json:"status"`
	CreatedAt  time.Time `json:"created_at"`
	StartedAt  time.Time `json:"started_at,omitempty"`
	FinishedAt time.Time `json:"finished_at,omitempty"`
	Attempts   int       `json:"attempts"`
}

type attemptCounterKey struct{}

type AttemptCounter struct {
	value atomic.Int32
}

func WithAttemptCounter(ctx context.Context) (context.Context, *AttemptCounter) {
	counter := &AttemptCounter{}
	return context.WithValue(ctx, attemptCounterKey{}, counter), counter
}

func RecordAttempt(ctx context.Context) {
	counter, _ := ctx.Value(attemptCounterKey{}).(*AttemptCounter)
	if counter != nil {
		counter.value.Add(1)
	}
}

func (c *AttemptCounter) Load() int {
	return int(c.value.Load())
}
