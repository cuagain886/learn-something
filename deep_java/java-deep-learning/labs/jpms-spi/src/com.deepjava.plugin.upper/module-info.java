module com.deepjava.plugin.upper {
    requires com.deepjava.plugin.api;
    provides dev.deepjava.plugin.api.ToolProvider
            with dev.deepjava.plugin.upper.UpperToolProvider;
}
