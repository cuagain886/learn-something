package resilience

import (
	"errors"
	"math"
	"sync"
	"time"
)

var ErrInvalidLimiterConfig = errors.New("invalid token bucket configuration")

type TokenBucket struct {
	mu    sync.Mutex
	rate  float64
	burst float64
	now   func() time.Time

	tokens float64
	last   time.Time
}

func NewTokenBucket(rate float64, burst int, now func() time.Time) (*TokenBucket, error) {
	if rate <= 0 || burst <= 0 || now == nil {
		return nil, ErrInvalidLimiterConfig
	}
	current := now()
	return &TokenBucket{
		rate:   rate,
		burst:  float64(burst),
		now:    now,
		tokens: float64(burst),
		last:   current,
	}, nil
}

func (b *TokenBucket) Allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	current := b.now()
	if current.After(b.last) {
		b.tokens = math.Min(b.burst, b.tokens+current.Sub(b.last).Seconds()*b.rate)
		b.last = current
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
