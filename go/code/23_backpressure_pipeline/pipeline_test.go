package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestPipelineRejectsWhenQueueIsFull(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	pipeline, err := NewPipeline(context.Background(), 1, 1, PolicyReject,
		func(context.Context, int) (int, error) {
			select {
			case started <- struct{}{}:
			default:
			}
			<-release
			return 0, nil
		})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		close(release)
		_ = pipeline.Close()
		for range pipeline.Results() {
		}
		_ = pipeline.Wait()
	})

	if err := pipeline.Submit(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	<-started
	if err := pipeline.Submit(context.Background(), 2); err != nil {
		t.Fatal(err)
	}
	if err := pipeline.Submit(context.Background(), 3); !errors.Is(err, ErrQueueFull) {
		t.Fatalf("Submit() = %v, want ErrQueueFull", err)
	}
	if got := pipeline.Stats(); got.Accepted != 2 || got.Rejected != 1 || got.QueueLength != 1 {
		t.Fatalf("Stats() = %+v, want accepted=2 rejected=1 queue=1", got)
	}
}

func TestPipelineBlockHonorsSubmitContext(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	pipeline, err := NewPipeline(context.Background(), 1, 1, PolicyBlock,
		func(context.Context, int) (int, error) {
			select {
			case started <- struct{}{}:
			default:
			}
			<-release
			return 0, nil
		})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		close(release)
		_ = pipeline.Close()
		for range pipeline.Results() {
		}
		_ = pipeline.Wait()
	})

	if err := pipeline.Submit(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	<-started
	if err := pipeline.Submit(context.Background(), 2); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := pipeline.Submit(ctx, 3); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Submit() = %v, want context.DeadlineExceeded", err)
	}
}

func TestPipelineKeepLatestDropsOldestQueuedItem(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	pipeline, err := NewPipeline(context.Background(), 1, 1, PolicyKeepLatest,
		func(_ context.Context, value int) (int, error) {
			select {
			case started <- struct{}{}:
			default:
			}
			<-release
			return value, nil
		})
	if err != nil {
		t.Fatal(err)
	}

	if err := pipeline.Submit(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	<-started
	if err := pipeline.Submit(context.Background(), 2); err != nil {
		t.Fatal(err)
	}
	if err := pipeline.Submit(context.Background(), 3); err != nil {
		t.Fatal(err)
	}

	close(release)
	if err := pipeline.Close(); err != nil {
		t.Fatal(err)
	}
	var values []int
	for result := range pipeline.Results() {
		if result.Err != nil {
			t.Fatal(result.Err)
		}
		values = append(values, result.Value)
	}
	if err := pipeline.Wait(); err != nil {
		t.Fatal(err)
	}
	if len(values) != 2 || values[0] != 1 || values[1] != 3 {
		t.Fatalf("results = %v, want [1 3]", values)
	}
	if got := pipeline.Stats(); got.Accepted != 3 || got.Dropped != 1 || got.Processed != 2 {
		t.Fatalf("Stats() = %+v, want accepted=3 dropped=1 processed=2", got)
	}
}

func TestPipelineDrainsAcceptedItemsOnClose(t *testing.T) {
	pipeline, err := NewPipeline(context.Background(), 2, 2, PolicyBlock,
		func(_ context.Context, value int) (int, error) { return value * 2, nil })
	if err != nil {
		t.Fatal(err)
	}

	for value := 1; value <= 6; value++ {
		if err := pipeline.Submit(context.Background(), value); err != nil {
			t.Fatal(err)
		}
	}
	if err := pipeline.Close(); err != nil {
		t.Fatal(err)
	}

	seen := make(map[int]bool)
	for result := range pipeline.Results() {
		if result.Err != nil {
			t.Fatal(result.Err)
		}
		seen[result.Value] = true
	}
	if err := pipeline.Wait(); err != nil {
		t.Fatal(err)
	}
	for value := 1; value <= 6; value++ {
		if !seen[value*2] {
			t.Fatalf("missing processed value %d in %v", value*2, seen)
		}
	}
}

func TestPipelineReturnsParentCancellation(t *testing.T) {
	parent, cancel := context.WithCancelCause(context.Background())
	started := make(chan struct{})
	pipeline, err := NewPipeline(parent, 1, 1, PolicyBlock,
		func(ctx context.Context, _ int) (int, error) {
			close(started)
			<-ctx.Done()
			return 0, context.Cause(ctx)
		})
	if err != nil {
		t.Fatal(err)
	}
	if err := pipeline.Submit(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	<-started
	want := errors.New("parent canceled pipeline")
	cancel(want)
	for range pipeline.Results() {
	}
	if got := pipeline.Wait(); !errors.Is(got, want) {
		t.Fatalf("Wait() = %v, want %v", got, want)
	}
}

func TestPipelineCloseIsIdempotentAndRejectsNewSubmissions(t *testing.T) {
	pipeline, err := NewPipeline(context.Background(), 1, 1, PolicyReject,
		func(_ context.Context, value int) (int, error) { return value, nil })
	if err != nil {
		t.Fatal(err)
	}
	if err := pipeline.Close(); err != nil {
		t.Fatal(err)
	}
	if err := pipeline.Close(); err != nil {
		t.Fatalf("second Close() = %v, want nil", err)
	}
	if err := pipeline.Submit(context.Background(), 1); !errors.Is(err, ErrClosed) {
		t.Fatalf("Submit() after Close = %v, want ErrClosed", err)
	}
	for range pipeline.Results() {
	}
	if err := pipeline.Wait(); err != nil {
		t.Fatal(err)
	}
}

func TestNewPipelineRejectsInvalidConfiguration(t *testing.T) {
	processor := func(context.Context, int) (int, error) { return 0, nil }
	tests := []struct {
		name     string
		parent   context.Context
		workers  int
		capacity int
		policy   Policy
		fn       Processor[int, int]
	}{
		{"nil context", nil, 1, 1, PolicyBlock, processor},
		{"zero workers", context.Background(), 0, 1, PolicyBlock, processor},
		{"negative capacity", context.Background(), 1, -1, PolicyBlock, processor},
		{"keep latest unbuffered", context.Background(), 1, 0, PolicyKeepLatest, processor},
		{"unknown policy", context.Background(), 1, 1, Policy(99), processor},
		{"nil processor", context.Background(), 1, 1, PolicyBlock, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := NewPipeline(tt.parent, tt.workers, tt.capacity, tt.policy, tt.fn); !errors.Is(err, ErrInvalidConfig) {
				t.Fatalf("NewPipeline() = %v, want ErrInvalidConfig", err)
			}
		})
	}
}
