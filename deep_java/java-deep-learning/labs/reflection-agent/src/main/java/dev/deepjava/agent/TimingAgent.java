package dev.deepjava.agent;

import java.lang.instrument.Instrumentation;
import net.bytebuddy.agent.builder.AgentBuilder;
import net.bytebuddy.asm.Advice;
import static net.bytebuddy.matcher.ElementMatchers.isSynthetic;
import static net.bytebuddy.matcher.ElementMatchers.nameStartsWith;
import static net.bytebuddy.matcher.ElementMatchers.named;

/** Startup agent: transforms only the lab target and leaves all other class bytes unchanged. */
public final class TimingAgent {
    private TimingAgent() { }

    public static void premain(String arguments, Instrumentation instrumentation) {
        System.out.println("agent premain, retransform=" + instrumentation.isRetransformClassesSupported());
        new AgentBuilder.Default()
                .ignore(nameStartsWith("net.bytebuddy.").or(nameStartsWith("jdk.")).or(isSynthetic()))
                .type(named("dev.deepjava.agent.DemoService"))
                .transform((builder, type, loader, module, protectionDomain) ->
                        builder.visit(Advice.to(TimingAdvice.class).on(named("work"))))
                .with(AgentBuilder.Listener.StreamWriting.toSystemError().withErrorsOnly())
                .installOn(instrumentation);
    }
}
