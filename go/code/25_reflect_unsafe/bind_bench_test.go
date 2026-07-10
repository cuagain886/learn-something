package main

import (
	"strconv"
	"testing"
	"time"
)

var (
	benchmarkValues = map[string]string{
		"ADDR":    "127.0.0.1",
		"PORT":    "8080",
		"DEBUG":   "true",
		"TIMEOUT": "2s",
	}
	bindBenchmarkSink   testConfig
	stringBenchmarkSink string
)

func BenchmarkConfigBinding(b *testing.B) {
	b.Run("direct", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			port, err := strconv.Atoi(benchmarkValues["PORT"])
			if err != nil {
				b.Fatal(err)
			}
			debug, err := strconv.ParseBool(benchmarkValues["DEBUG"])
			if err != nil {
				b.Fatal(err)
			}
			timeout, err := time.ParseDuration(benchmarkValues["TIMEOUT"])
			if err != nil {
				b.Fatal(err)
			}
			bindBenchmarkSink = testConfig{benchmarkValues["ADDR"], port, debug, timeout}
		}
	})

	b.Run("generic-integer", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			port, err := ParseSigned[int](benchmarkValues["PORT"])
			if err != nil {
				b.Fatal(err)
			}
			debug, _ := strconv.ParseBool(benchmarkValues["DEBUG"])
			timeout, _ := time.ParseDuration(benchmarkValues["TIMEOUT"])
			bindBenchmarkSink = testConfig{benchmarkValues["ADDR"], port, debug, timeout}
		}
	})

	b.Run("reflect", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			var config testConfig
			if err := Bind(&config, benchmarkValues); err != nil {
				b.Fatal(err)
			}
			bindBenchmarkSink = config
		}
	})
}

func BenchmarkBytesToString(b *testing.B) {
	source := []byte("a stable byte slice used for conversion benchmarks")
	b.Run("safe-copy", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			stringBenchmarkSink = SafeBytesToString(source)
		}
	})
	b.Run("unsafe-view", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			stringBenchmarkSink = UnsafeBytesToReadOnlyString(source)
		}
	})
}
