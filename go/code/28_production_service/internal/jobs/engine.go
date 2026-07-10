package jobs

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

type Executor interface {
	Execute(context.Context, string) (string, error)
}

type workItem struct {
	id      string
	payload string
}

type Engine struct {
	ctx         context.Context
	cancel      context.CancelCauseFunc
	taskTimeout time.Duration
	executor    Executor
	queue       chan workItem
	store       *Store
	nextID      atomic.Uint64

	stateMu sync.Mutex
	closed  bool
	waitErr error

	submitters sync.WaitGroup
	workers    sync.WaitGroup
	shutdown   sync.Once
	done       chan struct{}
}

func NewEngine(parent context.Context, workers, queueSize int, taskTimeout time.Duration, executor Executor) (*Engine, error) {
	if parent == nil {
		return nil, ErrNilContext
	}
	if workers <= 0 || queueSize <= 0 || taskTimeout <= 0 {
		return nil, ErrInvalidConfig
	}
	if executor == nil {
		return nil, ErrNilExecutor
	}
	ctx, cancel := context.WithCancelCause(parent)
	engine := &Engine{
		ctx:         ctx,
		cancel:      cancel,
		taskTimeout: taskTimeout,
		executor:    executor,
		queue:       make(chan workItem, queueSize),
		store:       NewStore(),
		done:        make(chan struct{}),
	}
	engine.workers.Add(workers)
	for range workers {
		go engine.work()
	}
	go func() {
		<-ctx.Done()
		engine.startShutdown()
	}()
	return engine, nil
}

func (e *Engine) Submit(ctx context.Context, payload string) (Job, error) {
	if ctx == nil {
		return Job{}, ErrNilContext
	}
	e.stateMu.Lock()
	if e.closed {
		e.stateMu.Unlock()
		return Job{}, ErrClosed
	}
	e.submitters.Add(1)
	e.stateMu.Unlock()
	defer e.submitters.Done()

	job := Job{
		ID:        "job-" + strconv.FormatUint(e.nextID.Add(1), 36),
		Payload:   payload,
		Status:    Queued,
		CreatedAt: time.Now().UTC(),
	}
	e.store.Put(job)
	item := workItem{id: job.ID, payload: payload}

	if cause := context.Cause(e.ctx); cause != nil {
		e.store.Delete(job.ID)
		return Job{}, cause
	}
	select {
	case e.queue <- item:
		return job, nil
	case <-ctx.Done():
		e.store.Delete(job.ID)
		return Job{}, context.Cause(ctx)
	case <-e.ctx.Done():
		e.store.Delete(job.ID)
		return Job{}, context.Cause(e.ctx)
	default:
		e.store.Delete(job.ID)
		return Job{}, ErrQueueFull
	}
}

func (e *Engine) Get(id string) (Job, bool) {
	return e.store.Get(id)
}

func (e *Engine) Shutdown(ctx context.Context) error {
	if ctx == nil {
		return ErrNilContext
	}
	e.startShutdown()
	select {
	case <-e.done:
		e.stateMu.Lock()
		defer e.stateMu.Unlock()
		return e.waitErr
	case <-ctx.Done():
		cause := context.Cause(ctx)
		e.cancel(cause)
		return cause
	}
}

func (e *Engine) startShutdown() {
	e.shutdown.Do(func() {
		e.stateMu.Lock()
		e.closed = true
		e.stateMu.Unlock()
		go func() {
			e.submitters.Wait()
			close(e.queue)
			e.workers.Wait()
			e.stateMu.Lock()
			e.waitErr = context.Cause(e.ctx)
			e.stateMu.Unlock()
			e.cancel(nil)
			close(e.done)
		}()
	})
}

func (e *Engine) work() {
	defer e.workers.Done()
	for item := range e.queue {
		if context.Cause(e.ctx) != nil {
			e.finishCanceled(item.id, context.Cause(e.ctx))
			continue
		}
		e.execute(item)
	}
}

func (e *Engine) execute(item workItem) {
	e.store.Update(item.id, func(job *Job) {
		job.Status = Running
		job.StartedAt = time.Now().UTC()
	})

	ctx, cancel := context.WithTimeout(e.ctx, e.taskTimeout)
	ctx, attempts := WithAttemptCounter(ctx)
	result, err := e.executeSafely(ctx, item.payload)
	cancel()
	attemptCount := attempts.Load()
	if attemptCount == 0 {
		attemptCount = 1
	}
	finishedAt := time.Now().UTC()
	e.store.Update(item.id, func(job *Job) {
		job.FinishedAt = finishedAt
		job.Attempts = attemptCount
		switch {
		case err == nil:
			job.Status = Succeeded
			job.Result = result
		case context.Cause(e.ctx) != nil || errors.Is(err, context.Canceled):
			job.Status = Canceled
			job.Error = err.Error()
		default:
			job.Status = Failed
			job.Error = err.Error()
		}
	})
}

func (e *Engine) executeSafely(ctx context.Context, payload string) (result string, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("%w: %v", ErrExecutorPanic, recovered)
			slog.Error("job executor panicked", "panic", recovered, "stack", string(debug.Stack()))
		}
	}()
	return e.executor.Execute(ctx, payload)
}

func (e *Engine) finishCanceled(id string, cause error) {
	e.store.Update(id, func(job *Job) {
		job.Status = Canceled
		job.Error = cause.Error()
		job.FinishedAt = time.Now().UTC()
	})
}
