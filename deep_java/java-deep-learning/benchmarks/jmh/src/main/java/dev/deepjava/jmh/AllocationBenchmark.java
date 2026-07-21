package dev.deepjava.jmh;

import java.util.concurrent.TimeUnit;
import org.openjdk.jmh.annotations.Benchmark;
import org.openjdk.jmh.annotations.BenchmarkMode;
import org.openjdk.jmh.annotations.Fork;
import org.openjdk.jmh.annotations.Measurement;
import org.openjdk.jmh.annotations.Mode;
import org.openjdk.jmh.annotations.OutputTimeUnit;
import org.openjdk.jmh.annotations.Param;
import org.openjdk.jmh.annotations.Scope;
import org.openjdk.jmh.annotations.State;
import org.openjdk.jmh.annotations.Warmup;

@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.NANOSECONDS)
@Warmup(iterations = 3, time = 500, timeUnit = TimeUnit.MILLISECONDS)
@Measurement(iterations = 5, time = 500, timeUnit = TimeUnit.MILLISECONDS)
@Fork(2)
@State(Scope.Thread)
public class AllocationBenchmark {
    @Param({"41"})
    int value;

    static final class Pair {
        final int left;
        final int right;
        Pair(int left, int right) { this.left = left; this.right = right; }
        int sum() { return left + right; }
    }

    /** Pair does not escape semantically; C2 may scalar-replace it. */
    @Benchmark
    public int scalarReplacementCandidate() {
        return new Pair(value, value + 1).sum();
    }

    /** Returning the identity makes the allocation observable to the harness. */
    @Benchmark
    public Pair escapingAllocation() {
        return new Pair(value, value + 1);
    }
}
