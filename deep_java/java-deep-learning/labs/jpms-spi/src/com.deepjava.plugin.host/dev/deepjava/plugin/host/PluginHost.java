package dev.deepjava.plugin.host;

import dev.deepjava.plugin.api.ToolProvider;
import java.util.List;
import java.util.ServiceLoader;

public final class PluginHost {
    private PluginHost() { }

    public static void main(String[] args) {
        List<ToolProvider> providers = ServiceLoader.load(ToolProvider.class).stream()
                .map(ServiceLoader.Provider::get)
                .toList();
        if (providers.size() != 1) throw new AssertionError(providers);
        ToolProvider provider = providers.getFirst();
        if (!provider.id().equals("upper") || !provider.invoke("agent").equals("AGENT")) {
            throw new AssertionError("unexpected provider");
        }
        Module providerModule = provider.getClass().getModule();
        if (providerModule.isExported("dev.deepjava.plugin.upper")) {
            throw new AssertionError("implementation package should not be exported");
        }
        System.out.println("JPMS ServiceLoader verified: " + providerModule.getName());
    }
}
