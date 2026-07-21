package dev.deepjava.jcstress;

import org.openjdk.jcstress.annotations.Actor;
import org.openjdk.jcstress.annotations.JCStressTest;
import org.openjdk.jcstress.annotations.Outcome;
import org.openjdk.jcstress.annotations.State;
import org.openjdk.jcstress.infra.results.II_Result;

import static org.openjdk.jcstress.annotations.Expect.ACCEPTABLE;
import static org.openjdk.jcstress.annotations.Expect.ACCEPTABLE_INTERESTING;

@JCStressTest
@Outcome(id = {"0, 1", "1, 0", "1, 1"}, expect = ACCEPTABLE,
        desc = "普通交错或观察到对方写入")
@Outcome(id = "0, 0", expect = ACCEPTABLE_INTERESTING,
        desc = "JMM 允许：两个普通读都没有 happens-before 到对方写")
@State
public class PlainReorderingTest {
    int x;
    int y;

    @Actor
    public void actor1(II_Result result) {
        x = 1;
        result.r1 = y;
    }

    @Actor
    public void actor2(II_Result result) {
        y = 1;
        result.r2 = x;
    }
}
