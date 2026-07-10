package resilience

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestTokenBucketRefillsAndCapsBurst(t *testing.T) {
	var mu sync.Mutex
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	advance := func(duration time.Duration) {
		mu.Lock()
		now = now.Add(duration)
		mu.Unlock()
	}

	bucket, err := NewTokenBucket(2, 2, clock)
	if err != nil {
		t.Fatal(err)
	}
	if !bucket.Allow() || !bucket.Allow() || bucket.Allow() {
		t.Fatal("initial burst did not allow exactly two calls")
	}
	advance(250 * time.Millisecond)
	if bucket.Allow() {
		t.Fatal("half token should not allow a request")
	}
	advance(250 * time.Millisecond)
	if !bucket.Allow() {
		t.Fatal("one refilled token should allow a request")
	}
	advance(10 * time.Second)
	if !bucket.Allow() || !bucket.Allow() || bucket.Allow() {
		t.Fatal("refill exceeded burst cap")
	}
}

func TestTokenBucketIsConcurrentSafe(t *testing.T) {
	bucket, err := NewTokenBucket(1, 100, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	var allowed atomic.Int64
	var workers sync.WaitGroup
	for range 100 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			if bucket.Allow() {
				allowed.Add(1)
			}
		}()
	}
	workers.Wait()
	if got := allowed.Load(); got != 100 {
		t.Fatalf("allowed = %d, want 100", got)
	}
}

func TestNewTokenBucketRejectsInvalidConfiguration(t *testing.T) {
	for index, args := range []struct {
		rate  float64
		burst int
		now   func() time.Time
	}{
		{0, 1, time.Now},
		{1, 0, time.Now},
		{1, 1, nil},
	} {
		if _, err := NewTokenBucket(args.rate, args.burst, args.now); err != ErrInvalidLimiterConfig {
			t.Fatalf("case %d: NewTokenBucket() = %v, want ErrInvalidLimiterConfig", index, err)
		}
	}
}
