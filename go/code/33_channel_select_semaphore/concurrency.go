package main

import (
	"errors"
	"fmt"
	"sync"
)

var ErrQueueClosed = errors.New("condition queue is closed")
var ErrInvalidIterations = errors.New("iterations must be positive")

type CondQueue[T any] struct {
	mu     sync.Mutex
	ready  *sync.Cond
	items  []T
	head   int
	closed bool
}

func NewCondQueue[T any]() *CondQueue[T] {
	q := &CondQueue[T]{}
	q.ready = sync.NewCond(&q.mu)
	return q
}
func (q *CondQueue[T]) Push(value T) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return ErrQueueClosed
	}
	q.items = append(q.items, value)
	q.ready.Signal()
	return nil
}
func (q *CondQueue[T]) Pop() (T, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for q.head == len(q.items) && !q.closed {
		q.ready.Wait()
	}
	if q.head == len(q.items) {
		var zero T
		return zero, false
	}
	value := q.items[q.head]
	var zero T
	q.items[q.head] = zero
	q.head++
	if q.head == len(q.items) {
		q.items = nil
		q.head = 0
	} else if q.head >= 1024 && q.head*2 >= len(q.items) {
		q.items = append([]T(nil), q.items[q.head:]...)
		q.head = 0
	}
	return value, true
}
func (q *CondQueue[T]) Close() {
	q.mu.Lock()
	if !q.closed {
		q.closed = true
		q.ready.Broadcast()
	}
	q.mu.Unlock()
}

type SelectStats struct{ Left, Right int }

func MeasureReadySelect(iterations int) (SelectStats, error) {
	if iterations <= 0 {
		return SelectStats{}, fmt.Errorf("%w: %d", ErrInvalidIterations, iterations)
	}
	left, right := make(chan struct{}, 1), make(chan struct{}, 1)
	stats := SelectStats{}
	for range iterations {
		left <- struct{}{}
		right <- struct{}{}
		select {
		case <-left:
			stats.Left++
			<-right
		case <-right:
			stats.Right++
			<-left
		}
	}
	return stats, nil
}
