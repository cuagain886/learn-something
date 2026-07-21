package dev.deepjava.plugin.lib;

public final class VersionedFormatter {
    private VersionedFormatter() { }
    public static String format(String input) { return "v1:" + input.toUpperCase(); }
}
