package dev.deepjava.agent;

import net.bytebuddy.asm.Advice;

public final class TimingAdvice {
    private TimingAdvice() { }

    @Advice.OnMethodEnter
    public static long enter() {
        return System.nanoTime();
    }

    @Advice.OnMethodExit(onThrowable = Throwable.class)
    public static void exit(@Advice.Enter long started,
                            @Advice.Origin("#t.#m") String method,
                            @Advice.Thrown Throwable failure) {
        long elapsed = System.nanoTime() - started;
        System.out.println("timed " + method + " elapsedNanos=" + elapsed
                + " outcome=" + (failure == null ? "success" : failure.getClass().getSimpleName()));
    }
}
