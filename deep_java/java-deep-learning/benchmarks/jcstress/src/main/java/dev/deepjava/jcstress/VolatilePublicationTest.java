package dev.deepjava.jcstress;

import org.openjdk.jcstress.annotations.Actor;
import org.openjdk.jcstress.annotations.JCStressTest;
import org.openjdk.jcstress.annotations.Outcome;
import org.openjdk.jcstress.annotations.State;
import org.openjdk.jcstress.infra.results.I_Result;

import static org.openjdk.jcstress.annotations.Expect.ACCEPTABLE;
import static org.openjdk.jcstress.annotations.Expect.FORBIDDEN;

@JCStressTest
@Outcome(id = "-1", expect = ACCEPTABLE, desc = "读线程先执行，尚未观察到发布")
@Outcome(id = "42", expect = ACCEPTABLE, desc = "volatile acquire 观察到 release 及其前序写")
@Outcome(id = "0", expect = FORBIDDEN, desc = "看到 ready=true 却看不到 payload=42")
@State
public class VolatilePublicationTest {
    int payload;
    volatile boolean ready;

    @Actor
    public void writer() {
        payload = 42;
        ready = true;
    }

    @Actor
    public void reader(I_Result result) {
        result.r1 = ready ? payload : -1;
    }
}
