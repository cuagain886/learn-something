package dev.deepjava.jmh;

import java.util.concurrent.TimeUnit;
import org.openjdk.jmh.annotations.Benchmark;
import org.openjdk.jmh.annotations.BenchmarkMode;
import org.openjdk.jmh.annotations.Level;
import org.openjdk.jmh.annotations.Mode;
import org.openjdk.jmh.annotations.OutputTimeUnit;
import org.openjdk.jmh.annotations.Param;
import org.openjdk.jmh.annotations.Scope;
import org.openjdk.jmh.annotations.Setup;
import org.openjdk.jmh.annotations.State;

@BenchmarkMode(Mode.Throughput)
@OutputTimeUnit(TimeUnit.MICROSECONDS)
@State(Scope.Thread)
public class DispatchBenchmark {
    interface Operation { int apply(int value); }
    static final class Add1 implements Operation { public int apply(int v) { return v + 1; } }
    static final class Add2 implements Operation { public int apply(int v) { return v + 2; } }
    static final class Add3 implements Operation { public int apply(int v) { return v + 3; } }
    static final class Add4 implements Operation { public int apply(int v) { return v + 4; } }
    static final class Add5 implements Operation { public int apply(int v) { return v + 5; } }
    static final class Add6 implements Operation { public int apply(int v) { return v + 6; } }
    static final class Add7 implements Operation { public int apply(int v) { return v + 7; } }
    static final class Add8 implements Operation { public int apply(int v) { return v + 8; } }

    @Param({"1", "8"})
    int typeCount;
    private Operation[] operations;
    private int cursor;

    @Setup(Level.Trial)
    public void setup() {
        Operation[] all = {new Add1(), new Add2(), new Add3(), new Add4(),
                new Add5(), new Add6(), new Add7(), new Add8()};
        operations = new Operation[typeCount];
        System.arraycopy(all, 0, operations, 0, typeCount);
    }

    @Benchmark
    public int dispatch() {
        Operation operation = operations[cursor++ & (operations.length - 1)];
        return operation.apply(cursor);
    }
}
