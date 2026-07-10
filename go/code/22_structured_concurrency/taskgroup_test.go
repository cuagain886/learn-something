package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestTaskGroupCancelsSiblingsOnFirstError(t *testing.T) {
	want := errors.New("boom")
	group, err := NewTaskGroup(context.Background(), 2)
	if err != nil {
		t.Fatal(err)
	}

	canceled := make(chan struct{})
	started := make(chan struct{})
	if err := group.Go(func(ctx context.Context) error {
		close(started)
		<-ctx.Done()
		close(canceled)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	<-started
	if err := group.Go(func(context.Context) error { return want }); err != nil {
		t.Fatal(err)
	}

	if got := group.Wait(); !errors.Is(got, want) {
		t.Fatalf("Wait() = %v, want %v", got, want)
	}
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("sibling was not canceled")
	}
}

func TestTaskGroupHonorsLimit(t *testing.T) {
	group, err := NewTaskGroup(context.Background(), 2)
	if err != nil {
		t.Fatal(err)
	}

	entered := make(chan struct{}, 3)
	release := make(chan struct{})
	for range 3 {
		if err := group.Go(func(context.Context) error {
			entered <- struct{}{}
			<-release
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}

	<-entered
	<-entered
	select {
	case <-entered:
		close(release)
		t.Fatal("third task entered before a limit slot was released")
	case <-time.After(50 * time.Millisecond):
	}

	close(release)
	if err := group.Wait(); err != nil {
		t.Fatalf("Wait() = %v, want nil", err)
	}
}

func TestTaskGroupConvertsPanic(t *testing.T) {
	group, err := NewTaskGroup(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := group.Go(func(context.Context) error {
		panic("broken task")
	}); err != nil {
		t.Fatal(err)
	}

	got := group.Wait()
	var panicErr *PanicError
	if !errors.As(got, &panicErr) {
		t.Fatalf("Wait() = %T %v, want *PanicError", got, got)
	}
	if panicErr.Value != "broken task" {
		t.Fatalf("PanicError.Value = %v, want broken task", panicErr.Value)
	}
	if len(panicErr.Stack) == 0 {
		t.Fatal("PanicError.Stack is empty")
	}
}

func TestNewTaskGroupRejectsInvalidInputs(t *testing.T) {
	if _, err := NewTaskGroup(nil, 1); !errors.Is(err, ErrNilContext) {
		t.Fatalf("NewTaskGroup(nil, 1) error = %v, want ErrNilContext", err)
	}
	if _, err := NewTaskGroup(context.Background(), -1); !errors.Is(err, ErrInvalidLimit) {
		t.Fatalf("NewTaskGroup(ctx, -1) error = %v, want ErrInvalidLimit", err)
	}
}

func TestTaskGroupRejectsNilTask(t *testing.T) {
	group, err := NewTaskGroup(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := group.Go(nil); !errors.Is(err, ErrNilTask) {
		t.Fatalf("Go(nil) = %v, want ErrNilTask", err)
	}
}

func TestTaskGroupRejectsGoAfterWait(t *testing.T) {
	group, err := NewTaskGroup(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := group.Wait(); err != nil {
		t.Fatal(err)
	}
	if err := group.Go(func(context.Context) error { return nil }); !errors.Is(err, ErrGroupClosed) {
		t.Fatalf("Go() after Wait = %v, want ErrGroupClosed", err)
	}
}

func TestTaskGroupWaitIsIdempotent(t *testing.T) {
	want := errors.New("stable result")
	group, err := NewTaskGroup(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := group.Go(func(context.Context) error { return want }); err != nil {
		t.Fatal(err)
	}
	if first := group.Wait(); !errors.Is(first, want) {
		t.Fatalf("first Wait() = %v, want %v", first, want)
	}
	if second := group.Wait(); !errors.Is(second, want) {
		t.Fatalf("second Wait() = %v, want %v", second, want)
	}
}

func TestTaskGroupReturnsParentCancellation(t *testing.T) {
	parent, cancel := context.WithCancelCause(context.Background())
	want := errors.New("parent stopped")
	group, err := NewTaskGroup(parent, 0)
	if err != nil {
		t.Fatal(err)
	}
	cancel(want)
	if got := group.Wait(); !errors.Is(got, want) {
		t.Fatalf("Wait() = %v, want parent cause %v", got, want)
	}
}
