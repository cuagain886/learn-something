package resilience

import (
	"context"
	"errors"
	"fmt"
	"time"

	"learn_go/28_production_service/internal/jobs"
)

var ErrInvalidRetryConfig = errors.New("invalid retry configuration")

type Temporary interface {
	Temporary() bool
}

type SleepFunc func(context.Context, time.Duration) error

type RetryConfig struct {
	MaxAttempts int
	BaseDelay   time.Duration
	MaxDelay    time.Duration
}

type RetryExecutor struct {
	Next   jobs.Executor
	Config RetryConfig
	Sleep  SleepFunc
}

func (e *RetryExecutor) Execute(ctx context.Context, payload string) (string, error) {
	if ctx == nil {
		return "", jobs.ErrNilContext
	}
	if e == nil || e.Next == nil || e.Config.MaxAttempts <= 0 || e.Config.BaseDelay < 0 || e.Config.MaxDelay < 0 ||
		(e.Config.MaxDelay > 0 && e.Config.BaseDelay > e.Config.MaxDelay) {
		return "", ErrInvalidRetryConfig
	}
	if cause := context.Cause(ctx); cause != nil {
		return "", cause
	}

	sleep := e.Sleep
	if sleep == nil {
		sleep = sleepWithContext
	}
	delay := e.Config.BaseDelay
	for attempt := 1; attempt <= e.Config.MaxAttempts; attempt++ {
		if cause := context.Cause(ctx); cause != nil {
			return "", cause
		}
		jobs.RecordAttempt(ctx)
		result, err := e.Next.Execute(ctx, payload)
		if err == nil {
			return result, nil
		}
		if cause := context.Cause(ctx); cause != nil {
			return "", cause
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || !isTemporary(err) || attempt == e.Config.MaxAttempts {
			return "", err
		}
		if err := sleep(ctx, delay); err != nil {
			return "", fmt.Errorf("retry backoff: %w", err)
		}
		delay = nextDelay(delay, e.Config.MaxDelay)
	}
	panic("unreachable")
}

func isTemporary(err error) bool {
	var temporary Temporary
	return errors.As(err, &temporary) && temporary.Temporary()
}

func sleepWithContext(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return context.Cause(ctx)
	}
}

func nextDelay(current, maximum time.Duration) time.Duration {
	if current <= 0 {
		return 0
	}
	if maximum > 0 && current >= maximum/2 {
		return maximum
	}
	next := current * 2
	if next < current {
		if maximum > 0 {
			return maximum
		}
		return time.Duration(1<<63 - 1)
	}
	if maximum > 0 && next > maximum {
		return maximum
	}
	return next
}
