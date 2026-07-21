package dev.deepjava.jmh;

import java.util.concurrent.TimeUnit;
import org.openjdk.jmh.annotations.Benchmark;
import org.openjdk.jmh.annotations.BenchmarkMode;
import org.openjdk.jmh.annotations.Mode;
import org.openjdk.jmh.annotations.OutputTimeUnit;
import org.openjdk.jmh.annotations.Param;
import org.openjdk.jmh.annotations.Scope;
import org.openjdk.jmh.annotations.State;

@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.NANOSECONDS)
@State(Scope.Thread)
public class BenchmarkPitfalls {
    @Param({"42.0"})
    double input;

    /** Deliberately wrong: constant work and unused result can disappear completely. */
    @Benchmark
    public void wrongDeadCodeAndConstantFold() {
        Math.log(42.0);
    }

    /** Returning a non-constant result makes it observable; JMH consumes returned values. */
    @Benchmark
    public double observableResult() {
        return Math.log(input);
    }
}
