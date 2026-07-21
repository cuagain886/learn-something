package dev.deepjava.plugin.lib;

public final class VersionedFormatter {
    private VersionedFormatter() { }
    public static String format(String input) { return "v2:[" + input.toLowerCase() + "]"; }
}
