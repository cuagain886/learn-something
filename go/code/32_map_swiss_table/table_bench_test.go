package main

import "testing"

var tableIntSink int

func BenchmarkTeachingTableHit(b *testing.B) {
	t, _ := NewTable[int, int](1024, HashInt)
	for i := range 1024 {
		t.Set(i, i)
	}
	b.ReportAllocs()
	for b.Loop() {
		tableIntSink, _ = t.Get(511)
	}
}
func BenchmarkTeachingTableMiss(b *testing.B) {
	t, _ := NewTable[int, int](1024, HashInt)
	for i := range 1024 {
		t.Set(i, i)
	}
	b.ReportAllocs()
	for b.Loop() {
		tableIntSink, _ = t.Get(2048)
	}
}
func BenchmarkBuiltinMapHit(b *testing.B) {
	m := make(map[int]int, 1024)
	for i := range 1024 {
		m[i] = i
	}
	b.ReportAllocs()
	for b.Loop() {
		tableIntSink = m[511]
	}
}
func BenchmarkStringKeys(b *testing.B) {
	t, _ := NewTable[string, int](64, HashString)
	t.Set("runtime", 1)
	b.ReportAllocs()
	for b.Loop() {
		tableIntSink, _ = t.Get("runtime")
	}
}
