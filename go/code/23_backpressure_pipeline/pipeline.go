package main

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
)

type Policy uint8

const (
	PolicyBlock Policy = iota
	PolicyReject
	PolicyKeepLatest
)

var (
	ErrQueueFull     = errors.New("pipeline queue is full")
	ErrClosed        = errors.New("pipeline is closed")
	ErrInvalidConfig = errors.New("invalid pipeline configuration")
)

type Result[T any] struct {
	Value T
	Err   error
}

type Stats struct {
	Accepted    uint64
	Processed   uint64
	Rejected    uint64
	Dropped     uint64
	QueueLength int
}

type Processor[I, O any] func(context.Context, I) (O, error)

type Pipeline[I, O any] struct {
	ctx    context.Context
	cancel context.CancelFunc
	policy Policy
	fn     Processor[I, O]

	jobs    chan I
	results chan Result[O]
	done    chan struct{}

	stateMu   sync.Mutex
	replaceMu sync.Mutex
	closed    bool

	submitters sync.WaitGroup
	workers    sync.WaitGroup

	accepted  atomic.Uint64
	processed atomic.Uint64
	rejected  atomic.Uint64
	dropped   atomic.Uint64

	waitErr error
}

func NewPipeline[I, O any](parent context.Context, workers, capacity int, policy Policy, fn Processor[I, O]) (*Pipeline[I, O], error) {
	if parent == nil || workers <= 0 || capacity < 0 || fn == nil {
		return nil, ErrInvalidConfig
	}
	if policy < PolicyBlock || policy > PolicyKeepLatest {
		return nil, ErrInvalidConfig
	}
	if policy == PolicyKeepLatest && capacity == 0 {
		return nil, ErrInvalidConfig
	}

	ctx, cancel := context.WithCancel(parent)
	resultCapacity := capacity + workers
	if resultCapacity < 1 {
		resultCapacity = 1
	}
	pipeline := &Pipeline[I, O]{
		ctx:     ctx,
		cancel:  cancel,
		policy:  policy,
		fn:      fn,
		jobs:    make(chan I, capacity),
		results: make(chan Result[O], resultCapacity),
		done:    make(chan struct{}),
	}

	pipeline.workers.Add(workers)
	for range workers {
		go pipeline.work()
	}
	go pipeline.finish()
	go func() {
		<-ctx.Done()
		_ = pipeline.Close()
	}()
	return pipeline, nil
}

func (p *Pipeline[I, O]) Submit(ctx context.Context, item I) error {
	if ctx == nil {
		return ErrInvalidConfig
	}
	if err := p.beginSubmit(); err != nil {
		return err
	}
	defer p.submitters.Done()

	if cause := context.Cause(p.ctx); cause != nil {
		p.rejected.Add(1)
		return cause
	}

	if p.policy == PolicyBlock {
		select {
		case p.jobs <- item:
			p.accepted.Add(1)
			return nil
		case <-ctx.Done():
			p.rejected.Add(1)
			return context.Cause(ctx)
		case <-p.ctx.Done():
			p.rejected.Add(1)
			return context.Cause(p.ctx)
		}
	}
	if p.policy == PolicyKeepLatest {
		p.replaceMu.Lock()
		defer p.replaceMu.Unlock()
		select {
		case p.jobs <- item:
			p.accepted.Add(1)
			return nil
		case <-ctx.Done():
			p.rejected.Add(1)
			return context.Cause(ctx)
		case <-p.ctx.Done():
			p.rejected.Add(1)
			return context.Cause(p.ctx)
		default:
		}

		select {
		case <-p.jobs:
			p.dropped.Add(1)
		default:
		}
		select {
		case p.jobs <- item:
			p.accepted.Add(1)
			return nil
		case <-ctx.Done():
			p.rejected.Add(1)
			return context.Cause(ctx)
		case <-p.ctx.Done():
			p.rejected.Add(1)
			return context.Cause(p.ctx)
		}
	}

	if p.policy != PolicyReject {
		return ErrInvalidConfig
	}
	select {
	case p.jobs <- item:
		p.accepted.Add(1)
		return nil
	case <-ctx.Done():
		p.rejected.Add(1)
		return context.Cause(ctx)
	case <-p.ctx.Done():
		p.rejected.Add(1)
		return context.Cause(p.ctx)
	default:
		p.rejected.Add(1)
		return ErrQueueFull
	}
}

func (p *Pipeline[I, O]) Results() <-chan Result[O] {
	return p.results
}

func (p *Pipeline[I, O]) Close() error {
	p.stateMu.Lock()
	if p.closed {
		p.stateMu.Unlock()
		return nil
	}
	p.closed = true
	p.stateMu.Unlock()

	p.submitters.Wait()
	close(p.jobs)
	return nil
}

func (p *Pipeline[I, O]) Wait() error {
	_ = p.Close()
	<-p.done
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	return p.waitErr
}

func (p *Pipeline[I, O]) Stats() Stats {
	return Stats{
		Accepted:    p.accepted.Load(),
		Processed:   p.processed.Load(),
		Rejected:    p.rejected.Load(),
		Dropped:     p.dropped.Load(),
		QueueLength: len(p.jobs),
	}
}

func (p *Pipeline[I, O]) beginSubmit() error {
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	if p.closed {
		return ErrClosed
	}
	p.submitters.Add(1)
	return nil
}

func (p *Pipeline[I, O]) work() {
	defer p.workers.Done()
	for item := range p.jobs {
		if p.ctx.Err() != nil {
			continue
		}
		value, err := p.fn(p.ctx, item)
		p.processed.Add(1)
		select {
		case p.results <- Result[O]{Value: value, Err: err}:
		case <-p.ctx.Done():
		}
	}
}

func (p *Pipeline[I, O]) finish() {
	p.workers.Wait()
	p.stateMu.Lock()
	p.waitErr = context.Cause(p.ctx)
	p.stateMu.Unlock()
	p.cancel()
	close(p.results)
	close(p.done)
}
