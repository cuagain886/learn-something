package main

import "testing"

var (
	compilerBenchmarkValues = func() []int {
		values := make([]int, 1024)
		for index := range values {
			values[index] = index
		}
		return values
	}()
	compilerIntSink     int
	compilerPointerSink *int
)

func BenchmarkSumDispatch(b *testing.B) {
	b.Run("checked", func(b *testing.B) {
		for b.Loop() {
			compilerIntSink = SumChecked(compilerBenchmarkValues)
		}
	})
	b.Run("explicit-bce", func(b *testing.B) {
		for b.Loop() {
			compilerIntSink = SumBCE(compilerBenchmarkValues)
		}
	})
	b.Run("generic", func(b *testing.B) {
		for b.Loop() {
			compilerIntSink = GenericSum(compilerBenchmarkValues)
		}
	})
	b.Run("interface", func(b *testing.B) {
		var source IntSource = IntSlice(compilerBenchmarkValues)
		for b.Loop() {
			compilerIntSink = InterfaceSum(source)
		}
	})
}

func BenchmarkInlining(b *testing.B) {
	b.Run("inline", func(b *testing.B) {
		for b.Loop() {
			compilerIntSink = InlineAdd(20, 22)
		}
	})
	b.Run("noinline", func(b *testing.B) {
		for b.Loop() {
			compilerIntSink = NoInlineAdd(20, 22)
		}
	})
}

func BenchmarkEscape(b *testing.B) {
	b.Run("value", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			compilerIntSink = StackValue()
		}
	})
	b.Run("pointer-escapes", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			compilerPointerSink = EscapingValue()
		}
	})
}
