package main

import (
	"bytes"
	"context"
	"fmt"
	"testing"
)

var pollBytesSink []byte

func BenchmarkLoopbackRoundTrip(b *testing.B) {
	for _, size := range []int{32, 1024, 64 << 10} {
		payload := bytes.Repeat([]byte{'G'}, size)
		b.Run(fmt.Sprintf("%dB", size), func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				var err error
				pollBytesSink, err = LoopbackRoundTrip(context.Background(), payload)
				if err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
