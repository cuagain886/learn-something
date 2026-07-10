package main

import (
	"errors"
	"fmt"
	"runtime"
)

const MaxTeachingDepth = 16_384

var ErrInvalidDepth = errors.New("depth is outside teaching limit")

func RecursiveSum(depth int) (int, error) {
	if err := validateDepth(depth); err != nil {
		return 0, err
	}
	return recursiveSum(depth), nil
}

func recursiveSum(depth int) int {
	if depth == 0 {
		return 0
	}
	return depth + recursiveSum(depth-1)
}

func IterativeSum(depth int) (int, error) {
	if err := validateDepth(depth); err != nil {
		return 0, err
	}
	total := 0
	for value := 1; value <= depth; value++ {
		total += value
	}
	return total, nil
}

func CaptureStackAtDepth(depth int) ([]byte, error) {
	if err := validateDepth(depth); err != nil {
		return nil, err
	}
	return captureStackAtDepth(depth), nil
}

func captureStackAtDepth(depth int) []byte {
	marker := [64]byte{byte(depth)}
	if depth == 0 {
		for size := 4 << 10; size <= 1<<20; size *= 2 {
			buffer := make([]byte, size)
			length := runtime.Stack(buffer, false)
			if length < len(buffer) {
				return buffer[:length]
			}
		}
		return []byte("stack exceeds 1 MiB capture limit")
	}
	stack := captureStackAtDepth(depth - 1)
	runtime.KeepAlive(marker)
	return stack
}

func InvokeWithRecovery(fn func()) (recovered any) {
	defer func() {
		recovered = recover()
	}()
	fn()
	return nil
}

func MakeCounter(start int) func() int {
	value := start
	return func() int {
		value++
		return value
	}
}

//go:noinline
func AddSix(a, b, c, d, e, f int) int {
	return a + b + c + d + e + f
}

//go:noinline
func CallAddSix() int {
	return AddSix(1, 2, 3, 4, 5, 6)
}

func validateDepth(depth int) error {
	if depth < 0 || depth > MaxTeachingDepth {
		return fmt.Errorf("%w: got %d, want 0..%d", ErrInvalidDepth, depth, MaxTeachingDepth)
	}
	return nil
}
