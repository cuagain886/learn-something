package dev.deepjava.agent;

import java.time.Duration;
import java.util.HashSet;
import java.util.Set;

public final class AgentStateMachineLab {
    enum State { CREATED, PLANNING, RUNNING, WAITING_TOOL, WAITING_APPROVAL, COMPLETED, FAILED, CANCELLED, TIMED_OUT }
    record Budget(int stepsLeft, int toolsLeft, int tokensLeft, long deadlineNanos) {
        Budget consumeStep(int tokens) {
            if (stepsLeft <= 0 || tokens > tokensLeft || System.nanoTime() >= deadlineNanos) throw new IllegalStateException("budget exhausted");
            return new Budget(stepsLeft - 1, toolsLeft, tokensLeft - tokens, deadlineNanos);
        }
        Budget consumeTool() {
            if (toolsLeft <= 0) throw new IllegalStateException("tool budget exhausted");
            return new Budget(stepsLeft, toolsLeft - 1, tokensLeft, deadlineNanos);
        }
    }
    static final class Run {
        private State state = State.CREATED;
        private long version;
        private Budget budget = new Budget(4, 2, 1000, System.nanoTime() + Duration.ofSeconds(5).toNanos());
        private final Set<String> toolFingerprints = new HashSet<>();

        void transition(State expected, State next) {
            if (state != expected || terminal(state)) throw new IllegalStateException(state + " -> " + next);
            state = next; version++;
        }
        void modelStep(int tokens) { budget = budget.consumeStep(tokens); }
        void requestTool(String name, String canonicalArguments) {
            String fingerprint = name + "\n" + canonicalArguments;
            if (!toolFingerprints.add(fingerprint)) throw new IllegalStateException("repeated tool call");
            budget = budget.consumeTool();
        }
        static boolean terminal(State state) { return switch (state) {
            case COMPLETED, FAILED, CANCELLED, TIMED_OUT -> true; default -> false;
        }; }
    }

    private AgentStateMachineLab() { }
    public static void main(String[] args) {
        Run run = new Run();
        run.transition(State.CREATED, State.PLANNING); run.modelStep(120);
        run.transition(State.PLANNING, State.RUNNING);
        run.requestTool("search", "{\"q\":\"jmm\"}");
        try { run.requestTool("search", "{\"q\":\"jmm\"}"); throw new AssertionError(); }
        catch (IllegalStateException expected) { }
        run.transition(State.RUNNING, State.WAITING_TOOL);
        run.transition(State.WAITING_TOOL, State.RUNNING); run.modelStep(80);
        run.transition(State.RUNNING, State.COMPLETED);
        assert run.version == 5 && run.state == State.COMPLETED;
        System.out.println("agent state, budgets and repeated-tool guard verified");
    }
}
