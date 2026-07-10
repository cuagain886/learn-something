package jobs

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

type executorFunc func(context.Context, string) (string, error)

func (fn executorFunc) Execute(ctx context.Context, payload string) (string, error) {
	return fn(ctx, payload)
}

func TestEngineProcessesSubmittedJob(t *testing.T) {
	engine, err := NewEngine(context.Background(), 1, 2, time.Second,
		executorFunc(func(_ context.Context, payload string) (string, error) {
			return strings.ToUpper(payload), nil
		}))
	if err != nil {
		t.Fatal(err)
	}

	job, err := engine.Submit(context.Background(), "go")
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != Queued || job.ID == "" {
		t.Fatalf("Submit() = %+v, want queued job with ID", job)
	}

	completed := waitForStatus(t, engine, job.ID, Succeeded)
	if completed.Result != "GO" || completed.Attempts != 1 || completed.StartedAt.IsZero() || completed.FinishedAt.IsZero() {
		t.Fatalf("completed job = %+v", completed)
	}
	if err := engine.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func waitForStatus(t *testing.T, engine *Engine, id string, want Status) Job {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		job, ok := engine.Get(id)
		if !ok {
			t.Fatalf("job %s disappeared", id)
		}
		if job.Status == want {
			return job
		}
		time.Sleep(time.Millisecond)
	}
	job, _ := engine.Get(id)
	t.Fatalf("job %s status = %s, want %s", id, job.Status, want)
	return Job{}
}

func TestEngineRejectsWhenQueueIsFull(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	openGate := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(openGate)

	engine, err := NewEngine(context.Background(), 1, 1, time.Second,
		executorFunc(func(_ context.Context, payload string) (string, error) {
			select {
			case started <- struct{}{}:
			default:
			}
			<-release
			return payload, nil
		}))
	if err != nil {
		t.Fatal(err)
	}
	first, err := engine.Submit(context.Background(), "first")
	if err != nil {
		t.Fatal(err)
	}
	<-started
	second, err := engine.Submit(context.Background(), "second")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := engine.Submit(context.Background(), "third"); !errors.Is(err, ErrQueueFull) {
		t.Fatalf("third Submit() = %v, want ErrQueueFull", err)
	}
	openGate()
	waitForStatus(t, engine, first.ID, Succeeded)
	waitForStatus(t, engine, second.ID, Succeeded)
	if err := engine.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestEngineMarksTaskTimeoutAsFailed(t *testing.T) {
	engine, err := NewEngine(context.Background(), 1, 1, 20*time.Millisecond,
		executorFunc(func(ctx context.Context, _ string) (string, error) {
			<-ctx.Done()
			return "", context.Cause(ctx)
		}))
	if err != nil {
		t.Fatal(err)
	}
	job, err := engine.Submit(context.Background(), "slow")
	if err != nil {
		t.Fatal(err)
	}
	failed := waitForStatus(t, engine, job.ID, Failed)
	if !strings.Contains(failed.Error, context.DeadlineExceeded.Error()) {
		t.Fatalf("failed job error = %q, want deadline exceeded", failed.Error)
	}
	if err := engine.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestEngineConvertsExecutorPanicToFailure(t *testing.T) {
	originalLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { slog.SetDefault(originalLogger) })

	engine, err := NewEngine(context.Background(), 1, 1, time.Second,
		executorFunc(func(context.Context, string) (string, error) {
			panic("broken executor")
		}))
	if err != nil {
		t.Fatal(err)
	}
	job, err := engine.Submit(context.Background(), "panic")
	if err != nil {
		t.Fatal(err)
	}
	failed := waitForStatus(t, engine, job.ID, Failed)
	if !strings.Contains(failed.Error, ErrExecutorPanic.Error()) {
		t.Fatalf("failed job error = %q, want executor panic", failed.Error)
	}
	if err := engine.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestEngineShutdownDrainsAcceptedJobsAndIsIdempotent(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	engine, err := NewEngine(context.Background(), 1, 2, time.Second,
		executorFunc(func(_ context.Context, payload string) (string, error) {
			select {
			case started <- struct{}{}:
			default:
			}
			<-release
			return payload, nil
		}))
	if err != nil {
		t.Fatal(err)
	}

	var submitted []Job
	for _, payload := range []string{"one", "two", "three"} {
		job, err := engine.Submit(context.Background(), payload)
		if err != nil {
			t.Fatal(err)
		}
		submitted = append(submitted, job)
		if len(submitted) == 1 {
			<-started
		}
	}

	shutdownDone := make(chan error, 1)
	go func() { shutdownDone <- engine.Shutdown(context.Background()) }()
	deadline := time.Now().Add(time.Second)
	for {
		_, err := engine.Submit(context.Background(), "late")
		if errors.Is(err, ErrClosed) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("engine did not close submissions, last error %v", err)
		}
		time.Sleep(time.Millisecond)
	}
	close(release)
	if err := <-shutdownDone; err != nil {
		t.Fatal(err)
	}
	for _, job := range submitted {
		completed, ok := engine.Get(job.ID)
		if !ok || completed.Status != Succeeded {
			t.Fatalf("job %s after Shutdown = %+v, found=%v", job.ID, completed, ok)
		}
	}
	if err := engine.Shutdown(context.Background()); err != nil {
		t.Fatalf("second Shutdown() = %v", err)
	}
}

func TestEngineShutdownDeadlineCancelsRunningJob(t *testing.T) {
	started := make(chan struct{})
	engine, err := NewEngine(context.Background(), 1, 1, time.Second,
		executorFunc(func(ctx context.Context, _ string) (string, error) {
			close(started)
			<-ctx.Done()
			return "", context.Cause(ctx)
		}))
	if err != nil {
		t.Fatal(err)
	}
	job, err := engine.Submit(context.Background(), "blocked")
	if err != nil {
		t.Fatal(err)
	}
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := engine.Shutdown(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Shutdown() = %v, want deadline exceeded", err)
	}
	waitForStatus(t, engine, job.ID, Canceled)
	if err := engine.Shutdown(context.Background()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("second Shutdown() = %v, want stable deadline cause", err)
	}
}

func TestStoreReturnsValueSnapshots(t *testing.T) {
	store := NewStore()
	store.Put(Job{ID: "job-1", Status: Queued})
	first, ok := store.Get("job-1")
	if !ok {
		t.Fatal("job not found")
	}
	first.Status = Failed
	second, _ := store.Get("job-1")
	if second.Status != Queued {
		t.Fatalf("mutating Get result changed Store: %+v", second)
	}
}

func TestNewEngineRejectsInvalidConfiguration(t *testing.T) {
	executor := executorFunc(func(context.Context, string) (string, error) { return "", nil })
	tests := []struct {
		parent   context.Context
		workers  int
		queue    int
		timeout  time.Duration
		executor Executor
		want     error
	}{
		{nil, 1, 1, time.Second, executor, ErrNilContext},
		{context.Background(), 0, 1, time.Second, executor, ErrInvalidConfig},
		{context.Background(), 1, 0, time.Second, executor, ErrInvalidConfig},
		{context.Background(), 1, 1, 0, executor, ErrInvalidConfig},
		{context.Background(), 1, 1, time.Second, nil, ErrNilExecutor},
	}
	for index, tt := range tests {
		if _, err := NewEngine(tt.parent, tt.workers, tt.queue, tt.timeout, tt.executor); !errors.Is(err, tt.want) {
			t.Fatalf("case %d: NewEngine() = %v, want %v", index, err, tt.want)
		}
	}
}
