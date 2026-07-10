package main

import (
	"bytes"
	"errors"
	"testing"
)

func TestRecursiveAndIterativeSumAgree(t *testing.T) {
	for _, depth := range []int{0, 1, 128, 4_096} {
		recursive, err := RecursiveSum(depth)
		if err != nil {
			t.Fatal(err)
		}
		iterative, err := IterativeSum(depth)
		if err != nil || recursive != iterative {
			t.Fatalf("depth=%d recursive=%d iterative=%d err=%v", depth, recursive, iterative, err)
		}
	}
}

func TestCaptureStackAtDepthContainsRecursiveFrames(t *testing.T) {
	stack, err := CaptureStackAtDepth(32)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(stack, []byte("captureStackAtDepth")) {
		t.Fatalf("stack does not contain recursive helper:\n%s", stack)
	}
}

func TestInvokeWithRecoveryReturnsPanicValue(t *testing.T) {
	got := InvokeWithRecovery(func() { panic("boom") })
	if got != "boom" {
		t.Fatalf("recovered = %#v, want boom", got)
	}
}

func TestMakeCounterCapturesIndependentState(t *testing.T) {
	left, right := MakeCounter(10), MakeCounter(100)
	if left() != 11 || left() != 12 || right() != 101 {
		t.Fatal("closure state is not independent")
	}
}

func TestDepthValidation(t *testing.T) {
	for _, depth := range []int{-1, MaxTeachingDepth + 1} {
		if _, err := CaptureStackAtDepth(depth); !errors.Is(err, ErrInvalidDepth) {
			t.Fatalf("depth=%d error=%v", depth, err)
		}
		if _, err := RecursiveSum(depth); !errors.Is(err, ErrInvalidDepth) {
			t.Fatalf("RecursiveSum(%d) error=%v", depth, err)
		}
	}
}
