package dev.deepjava.plugin.api;

public interface ToolProvider {
    String id();
    String invoke(String input);
}
