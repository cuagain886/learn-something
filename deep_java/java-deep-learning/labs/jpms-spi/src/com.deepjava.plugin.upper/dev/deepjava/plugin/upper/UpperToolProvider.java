package dev.deepjava.plugin.upper;

import dev.deepjava.plugin.api.ToolProvider;
import java.util.Locale;

public final class UpperToolProvider implements ToolProvider {
    public UpperToolProvider() { }
    @Override public String id() { return "upper"; }
    @Override public String invoke(String input) { return input.toUpperCase(Locale.ROOT); }
}
