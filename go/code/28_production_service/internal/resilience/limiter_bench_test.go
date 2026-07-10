package resilience

import (
	"testing"
	"time"
)

var limiterBenchmarkSink bool

func BenchmarkTokenBucketAllow(b *testing.B) {
	bucket, err := NewTokenBucket(1e12, 1<<30, time.Now)
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for b.Loop() {
		limiterBenchmarkSink = bucket.Allow()
	}
}
