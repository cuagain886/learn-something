/*
31_allocator_gc_pacer —— 分配器、GC pacer、写屏障与 scavenger

【运行】

	go run ./31_allocator_gc_pacer -objects=10000 -size=256 -keep-every=10
	go test -race ./31_allocator_gc_pacer
	go test ./31_allocator_gc_pacer -run '^$' -bench '.' -benchmem
*/
package main

import (
	"flag"
	"fmt"
	"os"
	"runtime"
)

func main() {
	objects := flag.Int("objects", 10_000, "objects to allocate")
	size := flag.Int("size", 256, "bytes per object")
	keepEvery := flag.Int("keep-every", 10, "retain one of every N objects")
	gcPercent := flag.Int("gc-percent", 100, "temporary GOGC value")
	memoryLimit := flag.Int64("memory-limit", 256<<20, "temporary soft memory limit")
	flag.Parse()

	before := ReadMemorySnapshot()
	var retained [][]byte
	var allocated uint64
	var allocationErr error
	err := WithGCSettings(GCSettings{GCPercent: *gcPercent, MemoryLimit: *memoryLimit}, func() {
		retained, allocated, allocationErr = AllocateAndRetain(AllocationConfig{
			Objects: *objects, BytesPerObject: *size, KeepEvery: *keepEvery,
		})
		if allocationErr != nil {
			return
		}
		runtime.GC()
		runtime.KeepAlive(retained)
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return
	}
	if allocationErr != nil {
		fmt.Fprintln(os.Stderr, allocationErr)
		return
	}
	after := ReadMemorySnapshot()
	fmt.Printf("allocated=%d retained=%d\n", allocated, len(retained))
	fmt.Printf("before=%+v\nafter=%+v\n", before, after)
	fmt.Println("快照是一次观察，不把单次 GC 时间或字节差当作固定结论。")
}
