package dev.deepjava.cache;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

/** Deterministic stale cache-aside race and a version-tombstone repair. */
public final class CacheRaceLab {
    record Value(long version, String data) { }
    record Entry(long watermark, Value value) { }

    static final class VersionedCache {
        private final Map<String, Entry> entries = new HashMap<>();
        synchronized void invalidate(String key, long committedVersion) {
            entries.compute(key, (ignored, current) ->
                    current != null && current.watermark() > committedVersion
                            ? current : new Entry(committedVersion, null));
        }
        synchronized void putLoaded(String key, Value loaded) {
            entries.compute(key, (ignored, current) ->
                    current == null || loaded.version() >= current.watermark()
                            ? new Entry(loaded.version(), loaded) : current);
        }
        synchronized Optional<Value> get(String key) {
            Entry entry = entries.get(key);
            return entry == null || entry.value() == null ? Optional.empty() : Optional.of(entry.value());
        }
    }

    private CacheRaceLab() { }

    public static void main(String[] args) {
        String key = "agent:7";
        Value version1 = new Value(1, "old");
        Value version2 = new Value(2, "new");

        Map<String, Value> naive = new HashMap<>();
        Value readerLoadedBeforeWriter = version1;
        naive.remove(key);                 // writer commits v2 then invalidates
        naive.put(key, readerLoadedBeforeWriter); // delayed reader resurrects v1
        assert naive.get(key).equals(version1);

        VersionedCache guarded = new VersionedCache();
        guarded.invalidate(key, version2.version());
        guarded.putLoaded(key, readerLoadedBeforeWriter);
        assert guarded.get(key).isEmpty(); // tombstone refuses stale fill
        guarded.putLoaded(key, version2);
        assert guarded.get(key).orElseThrow().equals(version2);
        System.out.println("cache-aside stale fill reproduced and fenced by version watermark");
    }
}
