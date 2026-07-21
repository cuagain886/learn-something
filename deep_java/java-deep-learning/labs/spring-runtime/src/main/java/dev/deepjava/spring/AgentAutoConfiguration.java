package dev.deepjava.spring;

import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;

@AutoConfiguration
@EnableConfigurationProperties(AgentProperties.class)
@ConditionalOnProperty(prefix = "deepjava.agent", name = "enabled", matchIfMissing = true)
public class AgentAutoConfiguration {
    @Bean
    @ConditionalOnMissingBean(AgentClient.class)
    AgentClient agentClient(AgentProperties properties) { return () -> "auto:" + properties.getProvider(); }
}
