package resilience

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestCircuitBreakerTransitionsClosedOpenHalfOpenClosed(t *testing.T) {
	var clockMu sync.Mutex
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time {
		clockMu.Lock()
		defer clockMu.Unlock()
		return now
	}
	advance := func(duration time.Duration) {
		clockMu.Lock()
		now = now.Add(duration)
		clockMu.Unlock()
	}

	breaker, err := NewBreaker(2, time.Second, clock)
	if err != nil {
		t.Fatal(err)
	}
	downstreamErr := errors.New("downstream unavailable")
	attempts := 0
	circuit := &CircuitExecutor{
		Next: executorFunc(func(context.Context, string) (string, error) {
			attempts++
			return "", downstreamErr
		}),
		Breaker: breaker,
	}

	for range 2 {
		if _, err := circuit.Execute(context.Background(), ""); !errors.Is(err, downstreamErr) {
			t.Fatalf("Execute() = %v, want downstream error", err)
		}
	}
	if breaker.State() != Open {
		t.Fatalf("State() = %v, want Open", breaker.State())
	}
	if _, err := circuit.Execute(context.Background(), ""); !errors.Is(err, ErrCircuitOpen) || attempts != 2 {
		t.Fatalf("open Execute() = %v attempts=%d", err, attempts)
	}

	advance(time.Second)
	probeStarted := make(chan struct{})
	probeRelease := make(chan struct{})
	circuit.Next = executorFunc(func(context.Context, string) (string, error) {
		close(probeStarted)
		<-probeRelease
		return "recovered", nil
	})
	probeResult := make(chan error, 1)
	go func() {
		_, err := circuit.Execute(context.Background(), "")
		probeResult <- err
	}()
	<-probeStarted
	if breaker.State() != HalfOpen {
		t.Fatalf("State() during probe = %v, want HalfOpen", breaker.State())
	}
	if _, err := circuit.Execute(context.Background(), ""); !errors.Is(err, ErrCircuitOpen) {
		t.Fatalf("second half-open probe = %v, want ErrCircuitOpen", err)
	}
	close(probeRelease)
	if err := <-probeResult; err != nil {
		t.Fatal(err)
	}
	if breaker.State() != Closed {
		t.Fatalf("State() after successful probe = %v, want Closed", breaker.State())
	}
}

func TestCircuitBreakerFailedProbeReopensAndCancellationDoesNotTrip(t *testing.T) {
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	breaker, err := NewBreaker(1, time.Second, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	downstreamErr := errors.New("downstream")
	circuit := &CircuitExecutor{
		Next:    executorFunc(func(context.Context, string) (string, error) { return "", downstreamErr }),
		Breaker: breaker,
	}
	_, _ = circuit.Execute(context.Background(), "")
	now = now.Add(time.Second)
	if _, err := circuit.Execute(context.Background(), ""); !errors.Is(err, downstreamErr) {
		t.Fatalf("failed probe = %v", err)
	}
	if breaker.State() != Open {
		t.Fatalf("State() = %v, want Open after failed probe", breaker.State())
	}

	now = now.Add(time.Second)
	circuit.Next = executorFunc(func(context.Context, string) (string, error) { return "ok", nil })
	if _, err := circuit.Execute(context.Background(), ""); err != nil || breaker.State() != Closed {
		t.Fatalf("successful probe err=%v state=%v", err, breaker.State())
	}

	cancelCtx, cancel := context.WithCancel(context.Background())
	circuit.Next = executorFunc(func(context.Context, string) (string, error) {
		cancel()
		return "", context.Canceled
	})
	if _, err := circuit.Execute(cancelCtx, ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled Execute() = %v", err)
	}
	if breaker.State() != Closed {
		t.Fatalf("caller cancellation tripped breaker: %v", breaker.State())
	}
}

func TestNewBreakerRejectsInvalidConfiguration(t *testing.T) {
	for index, args := range []struct {
		threshold int
		cooldown  time.Duration
		now       func() time.Time
	}{
		{0, time.Second, time.Now},
		{1, 0, time.Now},
		{1, time.Second, nil},
	} {
		if _, err := NewBreaker(args.threshold, args.cooldown, args.now); !errors.Is(err, ErrInvalidBreakerConfig) {
			t.Fatalf("case %d: NewBreaker() = %v", index, err)
		}
	}
}
