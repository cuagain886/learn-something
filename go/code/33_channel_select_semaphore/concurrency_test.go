package main

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func TestCondQueueConcurrentProducersConsumers(t *testing.T) {
	q := NewCondQueue[int]()
	const total = 4000
	seen := make([]bool, total)
	var seenMu sync.Mutex
	var consumers sync.WaitGroup
	for range 8 {
		consumers.Add(1)
		go func() {
			defer consumers.Done()
			for {
				value, ok := q.Pop()
				if !ok {
					return
				}
				seenMu.Lock()
				if value < 0 || value >= total || seen[value] {
					t.Errorf("invalid or duplicate value %d", value)
				} else {
					seen[value] = true
				}
				seenMu.Unlock()
			}
		}()
	}
	var producers sync.WaitGroup
	for worker := range 8 {
		producers.Add(1)
		go func() {
			defer producers.Done()
			for value := worker; value < total; value += 8 {
				if err := q.Push(value); err != nil {
					t.Error(err)
					return
				}
			}
		}()
	}
	producers.Wait()
	q.Close()
	consumers.Wait()
	for value, ok := range seen {
		if !ok {
			t.Fatalf("missing %d", value)
		}
	}
}

func TestCondQueueBlocksThenWakes(t *testing.T) {
	q := NewCondQueue[int]()
	started := make(chan struct{})
	result := make(chan int, 1)
	go func() {
		close(started)
		v, ok := q.Pop()
		if ok {
			result <- v
		}
	}()
	<-started
	select {
	case <-result:
		t.Fatal("Pop returned before Push")
	default:
	}
	if err := q.Push(42); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-result:
		if got != 42 {
			t.Fatalf("got=%d", got)
		}
	case <-time.After(time.Second):
		t.Fatal("Pop did not wake")
	}
}
func TestCondQueueCloseDrainsAndRejects(t *testing.T) {
	q := NewCondQueue[int]()
	q.Push(1)
	q.Push(2)
	q.Close()
	if err := q.Push(3); !errors.Is(err, ErrQueueClosed) {
		t.Fatalf("error=%v", err)
	}
	for _, want := range []int{1, 2} {
		got, ok := q.Pop()
		if !ok || got != want {
			t.Fatalf("got=%d,%v want=%d", got, ok, want)
		}
	}
	if _, ok := q.Pop(); ok {
		t.Fatal("closed drained queue returned value")
	}
	q.Close()
}
func TestMeasureReadySelectCountsEveryIteration(t *testing.T) {
	got, err := MeasureReadySelect(1000)
	if err != nil {
		t.Fatal(err)
	}
	if got.Left+got.Right != 1000 {
		t.Fatalf("stats=%+v", got)
	}
}
