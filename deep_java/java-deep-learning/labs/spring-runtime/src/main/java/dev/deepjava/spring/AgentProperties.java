package dev.deepjava.spring;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("deepjava.agent")
public class AgentProperties {
    private boolean enabled = true;
    private String provider = "local";

    public boolean isEnabled() { return enabled; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }
    public String getProvider() { return provider; }
    public void setProvider(String provider) { this.provider = provider; }
}
