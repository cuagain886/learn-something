package dev.deepjava.spring;

import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.context.metrics.buffering.BufferingApplicationStartup;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.context.ConfigurableApplicationContext;

public final class BootStartupLab {
    @SpringBootConfiguration(proxyBeanMethods = false)
    @EnableAutoConfiguration
    static class Application { }

    private BootStartupLab() { }

    public static void main(String[] args) {
        BufferingApplicationStartup startup = new BufferingApplicationStartup(2_048);
        SpringApplication application = new SpringApplication(Application.class);
        application.setWebApplicationType(WebApplicationType.NONE);
        application.setApplicationStartup(startup);
        application.setDefaultProperties(Map.of(
                "spring.main.banner-mode", "off",
                "logging.level.root", "WARN",
                "deepjava.agent.provider", "startup"));
        long started = System.nanoTime();
        try (ConfigurableApplicationContext context = application.run()) {
            assert context.getBean(AgentClient.class).source().equals("auto:startup");
            int events = startup.getBufferedTimeline().getEvents().size();
            assert events > 0;
            System.out.println("Boot startup verified, elapsedMillis="
                    + (System.nanoTime() - started) / 1_000_000 + ", startupEvents=" + events);
        }
    }
}
