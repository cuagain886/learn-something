package dev.deepjava.plugin.impl;

import dev.deepjava.plugin.api.Plugin;
import dev.deepjava.plugin.lib.VersionedFormatter;

public final class GreetingPlugin implements Plugin {
    @Override public String id() { return "plugin-v2"; }
    @Override public String execute(String input) { return VersionedFormatter.format(input); }
}
