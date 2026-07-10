package jobs

import "testing"

var storeBenchmarkSink Job

func BenchmarkStoreGet(b *testing.B) {
	store := NewStore()
	store.Put(Job{ID: "job-bench", Status: Succeeded, Result: "done"})
	b.ReportAllocs()
	for b.Loop() {
		var ok bool
		storeBenchmarkSink, ok = store.Get("job-bench")
		if !ok {
			b.Fatal("job disappeared")
		}
	}
}
