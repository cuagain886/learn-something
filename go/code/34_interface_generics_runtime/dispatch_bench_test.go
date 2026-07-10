package main

import "testing"

var dispatchIntSink int
var dispatchInt64Sink int64

func benchmarkValues() []int {
	v := make([]int, 1024)
	for i := range v {
		v[i] = i
	}
	return v
}
func BenchmarkConcrete(b *testing.B) {
	v := benchmarkValues()
	b.ReportAllocs()
	for b.Loop() {
		dispatchIntSink = CallConcrete(v)
	}
}
func BenchmarkGeneric(b *testing.B) {
	v := benchmarkValues()
	b.ReportAllocs()
	for b.Loop() {
		dispatchIntSink = CallGeneric(v)
	}
}
func BenchmarkInterface(b *testing.B) {
	v := IntValues(benchmarkValues())
	b.ReportAllocs()
	for b.Loop() {
		dispatchIntSink = CallInterface(v)
	}
}
func BenchmarkReflect(b *testing.B) {
	v := benchmarkValues()
	b.ReportAllocs()
	for b.Loop() {
		dispatchInt64Sink = CallReflect(v)
	}
}
