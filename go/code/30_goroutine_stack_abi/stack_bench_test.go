package main

import "testing"

var stackIntSink int

func BenchmarkRecursiveSum(b *testing.B) {
	for b.Loop() {
		stackIntSink, _ = RecursiveSum(128)
	}
}

func BenchmarkIterativeSum(b *testing.B) {
	for b.Loop() {
		stackIntSink, _ = IterativeSum(128)
	}
}

func BenchmarkDeferCleanup(b *testing.B) {
	for b.Loop() {
		value := 0
		func() { defer func() { value++ }() }()
		stackIntSink = value
	}
}

func BenchmarkExplicitCleanup(b *testing.B) {
	for b.Loop() {
		value := 0
		value++
		stackIntSink = value
	}
}

func BenchmarkAddSix(b *testing.B) {
	for b.Loop() {
		stackIntSink = CallAddSix()
	}
}
