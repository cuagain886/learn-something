package dev.deepjava.plugin.api;

public interface Plugin {
    String id();
    String execute(String input);
}
