package resilience

import (
	"context"
	"errors"
	"testing"
	"time"
)

type executorFunc func(context.Context, string) (string, error)

func (fn executorFunc) Execute(ctx context.Context, payload string) (string, error) {
	return fn(ctx, payload)
}

type temporaryError struct{ message string }

func (e temporaryError) Error() string   { return e.message }
func (e temporaryError) Temporary() bool { return true }

func TestRetryExecutorRetriesTemporaryErrorsWithCappedBackoff(t *testing.T) {
	attempts := 0
	executor := &RetryExecutor{
		Next: executorFunc(func(context.Context, string) (string, error) {
			attempts++
			if attempts < 3 {
				return "", temporaryError{"temporary"}
			}
			return "ok", nil
		}),
		Config: RetryConfig{MaxAttempts: 4, BaseDelay: 10 * time.Millisecond, MaxDelay: 15 * time.Millisecond},
	}
	var delays []time.Duration
	executor.Sleep = func(_ context.Context, delay time.Duration) error {
		delays = append(delays, delay)
		return nil
	}

	result, err := executor.Execute(context.Background(), "payload")
	if err != nil {
		t.Fatal(err)
	}
	if result != "ok" || attempts != 3 {
		t.Fatalf("Execute() = %q after %d attempts", result, attempts)
	}
	wantDelays := []time.Duration{10 * time.Millisecond, 15 * time.Millisecond}
	if len(delays) != len(wantDelays) || delays[0] != wantDelays[0] || delays[1] != wantDelays[1] {
		t.Fatalf("delays = %v, want %v", delays, wantDelays)
	}
}

func TestRetryExecutorDoesNotRetryPermanentCancellationOrPanic(t *testing.T) {
	permanent := errors.New("permanent")
	t.Run("permanent", func(t *testing.T) {
		attempts := 0
		executor := &RetryExecutor{
			Next: executorFunc(func(context.Context, string) (string, error) {
				attempts++
				return "", permanent
			}),
			Config: RetryConfig{MaxAttempts: 3},
		}
		if _, err := executor.Execute(context.Background(), ""); !errors.Is(err, permanent) || attempts != 1 {
			t.Fatalf("Execute() = %v after %d attempts", err, attempts)
		}
	})

	t.Run("cancellation", func(t *testing.T) {
		attempts := 0
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		executor := &RetryExecutor{
			Next: executorFunc(func(context.Context, string) (string, error) {
				attempts++
				return "", temporaryError{"temporary"}
			}),
			Config: RetryConfig{MaxAttempts: 3},
		}
		if _, err := executor.Execute(ctx, ""); !errors.Is(err, context.Canceled) || attempts != 0 {
			t.Fatalf("Execute() = %v after %d attempts", err, attempts)
		}
	})

	t.Run("panic", func(t *testing.T) {
		attempts := 0
		executor := &RetryExecutor{
			Next: executorFunc(func(context.Context, string) (string, error) {
				attempts++
				panic("do not retry")
			}),
			Config: RetryConfig{MaxAttempts: 3},
		}
		defer func() {
			if recovered := recover(); recovered == nil || attempts != 1 {
				t.Fatalf("panic=%v attempts=%d, want panic after one attempt", recovered, attempts)
			}
		}()
		_, _ = executor.Execute(context.Background(), "")
	})
}

func TestRetryExecutorRejectsInvalidConfiguration(t *testing.T) {
	validNext := executorFunc(func(context.Context, string) (string, error) { return "", nil })
	tests := []*RetryExecutor{
		nil,
		{Next: nil, Config: RetryConfig{MaxAttempts: 1}},
		{Next: validNext, Config: RetryConfig{MaxAttempts: 0}},
		{Next: validNext, Config: RetryConfig{MaxAttempts: 1, BaseDelay: -1}},
		{Next: validNext, Config: RetryConfig{MaxAttempts: 1, BaseDelay: 2, MaxDelay: 1}},
	}
	for index, executor := range tests {
		if _, err := executor.Execute(context.Background(), ""); !errors.Is(err, ErrInvalidRetryConfig) {
			t.Fatalf("case %d: Execute() = %v, want ErrInvalidRetryConfig", index, err)
		}
	}
}
