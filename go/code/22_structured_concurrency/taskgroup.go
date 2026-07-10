package main

import (
	"context"
	"errors"
	"fmt"
	"runtime/debug"
	"sync"
)

var (
	ErrGroupClosed  = errors.New("task group is waiting or closed")
	ErrInvalidLimit = errors.New("task group limit must be non-negative")
	ErrNilContext   = errors.New("task group parent context is nil")
	ErrNilTask      = errors.New("task is nil")
)

type Task func(context.Context) error

type PanicError struct {
	Value any
	Stack []byte
}

func (e *PanicError) Error() string {
	return fmt.Sprintf("task panic: %v", e.Value)
}

type TaskGroup struct {
	ctx    context.Context
	cancel context.CancelCauseFunc
	limit  chan struct{}

	wg sync.WaitGroup

	mu      sync.Mutex
	waiting bool
	first   error

	waitOnce sync.Once
	done     chan struct{}
}

func NewTaskGroup(parent context.Context, limit int) (*TaskGroup, error) {
	if parent == nil {
		return nil, ErrNilContext
	}
	if limit < 0 {
		return nil, ErrInvalidLimit
	}
	ctx, cancel := context.WithCancelCause(parent)
	var semaphore chan struct{}
	if limit > 0 {
		semaphore = make(chan struct{}, limit)
	}
	return &TaskGroup{
		ctx:    ctx,
		cancel: cancel,
		limit:  semaphore,
		done:   make(chan struct{}),
	}, nil
}

func (g *TaskGroup) Go(task Task) error {
	if task == nil {
		return ErrNilTask
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.waiting {
		return ErrGroupClosed
	}

	g.wg.Add(1)
	go func() {
		defer g.wg.Done()
		defer func() {
			if recovered := recover(); recovered != nil {
				g.record(&PanicError{Value: recovered, Stack: debug.Stack()})
			}
		}()
		if g.limit != nil {
			select {
			case g.limit <- struct{}{}:
				defer func() { <-g.limit }()
			case <-g.ctx.Done():
				g.record(context.Cause(g.ctx))
				return
			}
		}
		if err := task(g.ctx); err != nil {
			g.record(err)
		}
	}()
	return nil
}

func (g *TaskGroup) Wait() error {
	g.waitOnce.Do(func() {
		g.mu.Lock()
		g.waiting = true
		g.mu.Unlock()

		go func() {
			g.wg.Wait()
			g.mu.Lock()
			if g.first == nil {
				g.first = context.Cause(g.ctx)
			}
			g.mu.Unlock()
			g.cancel(nil)
			close(g.done)
		}()
	})

	<-g.done
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.first
}

func (g *TaskGroup) record(err error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.first != nil {
		return
	}
	g.first = err
	g.cancel(err)
}
