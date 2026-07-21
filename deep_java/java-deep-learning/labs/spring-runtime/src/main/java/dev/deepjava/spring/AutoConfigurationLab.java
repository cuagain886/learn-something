package dev.deepjava.spring;

import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.condition.ConditionEvaluationReport;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

public final class AutoConfigurationLab {
    private AutoConfigurationLab() { }

    public static void main(String[] args) {
        AtomicInteger runs = new AtomicInteger();
        ApplicationContextRunner runner = new ApplicationContextRunner()
                .withConfiguration(AutoConfigurations.of(AgentAutoConfiguration.class));
        runner.run(context -> {
            assert context.getStartupFailure() == null : context.getStartupFailure();
            assert context.getBean(AgentClient.class).source().equals("auto:local");
            ConditionEvaluationReport report = ConditionEvaluationReport.get(context.getBeanFactory());
            assert report.getConditionAndOutcomesBySource().keySet().stream()
                    .anyMatch(name -> name.contains("AgentAutoConfiguration"));
            runs.incrementAndGet();
        });
        runner.withPropertyValues("deepjava.agent.provider=remote").run(context -> {
            assert context.getStartupFailure() == null : context.getStartupFailure();
            assert context.getBean(AgentClient.class).source().equals("auto:remote");
            runs.incrementAndGet();
        });
        runner.withBean(AgentClient.class, () -> () -> "user").run(context -> {
            assert context.getStartupFailure() == null : context.getStartupFailure();
            assert context.getBeansOfType(AgentClient.class).size() == 1;
            assert context.getBean(AgentClient.class).source().equals("user");
            runs.incrementAndGet();
        });
        runner.withPropertyValues("deepjava.agent.enabled=false").run(context -> {
            assert context.getStartupFailure() == null : context.getStartupFailure();
            assert context.getBeansOfType(AgentClient.class).isEmpty();
            runs.incrementAndGet();
        });
        assert runs.get() == 4;
        System.out.println("Boot conditional auto-configuration and backoff verified");
    }
}
