package main

import (
	"sync"
	"testing"
)

type pointerNode struct {
	next *pointerNode
	data [56]byte
}

var (
	allocatorBytesSink []byte
	allocatorNodeSink  *pointerNode
	allocatorWordsSink []uint64
	bufferPool         = sync.Pool{New: func() any { return make([]byte, 4<<10) }}
)

func BenchmarkAllocateSmallObject(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		allocatorBytesSink = make([]byte, 32)
	}
}

func BenchmarkAllocateLargeObject(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		allocatorBytesSink = make([]byte, 32<<10)
	}
}

func BenchmarkPointerRichObject(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		allocatorNodeSink = &pointerNode{}
	}
}

func BenchmarkPointerFreeWords(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		allocatorWordsSink = make([]uint64, 8)
	}
}

func BenchmarkDirectBuffer(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		buffer := make([]byte, 4<<10)
		buffer[0] = 1
		allocatorBytesSink = buffer
	}
}

func BenchmarkPooledBuffer(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		buffer := bufferPool.Get().([]byte)
		buffer[0] = 1
		allocatorBytesSink = buffer
		bufferPool.Put(buffer)
	}
}
