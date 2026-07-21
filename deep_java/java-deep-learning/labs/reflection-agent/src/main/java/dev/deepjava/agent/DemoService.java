package dev.deepjava.agent;

public class DemoService {
    public String work(String input) {
        if (input.isBlank()) throw new IllegalArgumentException("blank input");
        return input.toUpperCase(java.util.Locale.ROOT);
    }
}
