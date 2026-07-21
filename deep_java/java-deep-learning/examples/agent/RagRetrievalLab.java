package dev.deepjava.agent;

import java.util.Comparator;
import java.util.List;
import java.util.Set;

/** Small exact-search oracle: permission filter must happen before top-k, then hybrid score and rerank. */
public final class RagRetrievalLab {
    record Chunk(String id, String tenant, Set<String> acl, String text, double[] vector) { }
    record Hit(Chunk chunk, double score) { }

    private RagRetrievalLab() { }

    public static void main(String[] args) {
        List<Chunk> index = List.of(
                new Chunk("secret", "t1", Set.of("admin"), "agent billing secret", new double[]{1, 0}),
                new Chunk("public", "t1", Set.of("reader"), "agent retry budget", new double[]{0.8, 0.2}),
                new Chunk("other", "t2", Set.of("reader"), "agent retry budget", new double[]{1, 0}));
        double[] query = {1, 0};
        Set<String> terms = Set.of("retry", "budget");
        List<Hit> hits = index.stream()
                .filter(c -> c.tenant().equals("t1") && c.acl().contains("reader"))
                .map(c -> new Hit(c, 0.7 * cosine(query, c.vector()) + 0.3 * lexical(terms, c.text())))
                .sorted(Comparator.comparingDouble(Hit::score).reversed())
                .limit(2)
                .toList();
        assert hits.size() == 1 && hits.getFirst().chunk().id().equals("public") : hits;
        System.out.println("permission-first hybrid retrieval verified: " + hits);
    }

    static double cosine(double[] left, double[] right) {
        double dot = 0, l2 = 0, r2 = 0;
        for (int i = 0; i < left.length; i++) { dot += left[i] * right[i]; l2 += left[i] * left[i]; r2 += right[i] * right[i]; }
        return dot / (Math.sqrt(l2) * Math.sqrt(r2));
    }
    static double lexical(Set<String> terms, String text) {
        long matched = terms.stream().filter(text::contains).count();
        return (double) matched / terms.size();
    }
}
