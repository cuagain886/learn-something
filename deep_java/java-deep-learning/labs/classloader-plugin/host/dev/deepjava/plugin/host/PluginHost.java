package dev.deepjava.plugin.host;

import dev.deepjava.plugin.api.Plugin;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.ServiceLoader;

public final class PluginHost {
    record Loaded(String result, Class<?> implementation, ClassLoader loader) { }

    private PluginHost() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 2) {
            throw new IllegalArgumentException("expected plugin-v1.jar plugin-v2.jar");
        }
        List<Loaded> observations = new ArrayList<>();
        for (String argument : args) {
            URL jar = Path.of(argument).toAbsolutePath().toUri().toURL();
            try (URLClassLoader loader = new URLClassLoader(
                    new URL[] { jar }, PluginHost.class.getClassLoader())) {
                Plugin plugin = ServiceLoader.load(Plugin.class, loader).findFirst()
                        .orElseThrow(() -> new IllegalStateException("no Plugin in " + jar));
                Loaded loaded = new Loaded(plugin.execute("task"), plugin.getClass(), loader);
                observations.add(loaded);
                System.out.printf("%s -> %s, implementationLoader=%s, apiLoader=%s%n",
                        plugin.id(), loaded.result(), loaded.loader(), Plugin.class.getClassLoader());
            }
        }
        if (observations.get(0).implementation() == observations.get(1).implementation()) {
            throw new AssertionError("same binary name from different defining loaders must be distinct classes");
        }
        if (!observations.get(0).result().equals("v1:TASK")
                || !observations.get(1).result().equals("v2:[task]")) {
            throw new AssertionError(observations.toString());
        }
        System.out.println("two dependency versions isolated; shared API identity preserved");
    }
}
