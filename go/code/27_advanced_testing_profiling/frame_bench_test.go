package main

import (
	"fmt"
	"testing"
)

var (
	frameBytesSink []byte
	frameValueSink Frame
)

func BenchmarkFrameCodec(b *testing.B) {
	for _, size := range []int{32, 1024, 60_000} {
		payload := make([]byte, size)
		frame := Frame{Version: 1, Flags: 2, Payload: payload}
		encoded, err := Encode(frame)
		if err != nil {
			b.Fatal(err)
		}

		b.Run(fmt.Sprintf("encode/%dB", size), func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				frameBytesSink, err = Encode(frame)
				if err != nil {
					b.Fatal(err)
				}
			}
		})
		b.Run(fmt.Sprintf("decode/%dB", size), func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				frameValueSink, err = Decode(encoded)
				if err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
