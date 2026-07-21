package dev.deepjava.language;

import java.util.ArrayList;
import java.util.ConcurrentModificationException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** JDK 21。验证 mutable key、backed subList、fail-fast 与 CHM 原子更新边界。 */
public final class CollectionsMechanicsLab {
    static final class MutableKey {
        private int id;
        MutableKey(int id) { this.id = id; }
        @Override public boolean equals(Object other) {
            return other instanceof MutableKey key && id == key.id;
        }
        @Override public int hashCode() { return Integer.hashCode(id); }
    }

    private CollectionsMechanicsLab() { }

    public static void main(String[] args) {
        Map<MutableKey, String> map = new HashMap<>();
        MutableKey key = new MutableKey(1);
        map.put(key, "value");
        key.id = 2;
        assert map.get(key) == null : "key now searches a different bin";
        assert map.size() == 1 : "entry is retained but no longer found by the mutated key";

        List<String> parent = new ArrayList<>(List.of("a", "b", "c"));
        List<String> view = parent.subList(1, 3);
        view.set(0, "B");
        assert parent.equals(List.of("a", "B", "c"));
        parent.add("d");
        try {
            view.size();
            throw new AssertionError("structural parent change should invalidate this view");
        } catch (ConcurrentModificationException expected) {
            // Fail-fast is a best-effort bug detector, not a synchronization guarantee.
        }

        ConcurrentHashMap<String, Integer> counts = new ConcurrentHashMap<>();
        counts.compute("tool", (ignored, old) -> old == null ? 1 : old + 1);
        assert counts.get("tool") == 1;
        System.out.println("collection invariants verified");
    }
}
