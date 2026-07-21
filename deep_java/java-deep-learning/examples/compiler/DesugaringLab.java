package dev.deepjava.compiler;

import java.io.IOException;
import java.util.function.IntUnaryOperator;

/**
 * JDK 21。把 record、enum、lambda、匿名类、泛型桥接与 try-with-resources 放在同一观察样本中。
 */
public final class DesugaringLab {
    record Request(long id, String payload) {
        Request {
            if (id <= 0 || payload == null) {
                throw new IllegalArgumentException("invalid request");
            }
        }
    }

    enum State { CREATED, RUNNING, DONE }

    interface Mapper<T> {
        T map(T input);
    }

    static final class StringMapper implements Mapper<String> {
        @Override
        public String map(String input) {
            return input.strip();
        }
    }

    static final class TracedResource implements AutoCloseable {
        private final String name;

        TracedResource(String name) {
            this.name = name;
        }

        int read() {
            return name.length();
        }

        @Override
        public void close() throws IOException {
            throw new IOException("close:" + name);
        }
    }

    static int useResource() throws IOException {
        try (TracedResource resource = new TracedResource("agent")) {
            int ignored = resource.read();
            throw new IOException("body:" + ignored);
        }
    }

    static IntUnaryOperator lambda(int delta) {
        return value -> value + delta;
    }

    static IntUnaryOperator anonymous(int delta) {
        return new IntUnaryOperator() {
            @Override
            public int applyAsInt(int value) {
                return value + delta;
            }
        };
    }

    static int stateCode(State state) {
        return switch (state) {
            case CREATED -> 10;
            case RUNNING -> 20;
            case DONE -> 30;
        };
    }

    public static void main(String[] args) {
        Request request = new Request(7, " task ");
        assert request.id() == 7;
        assert new StringMapper().map(request.payload()).equals("task");
        assert lambda(2).applyAsInt(3) == 5;
        assert anonymous(2).applyAsInt(3) == 5;
        assert stateCode(State.RUNNING) == 20;
        try {
            useResource();
            throw new AssertionError("exception expected");
        } catch (IOException expected) {
            assert expected.getMessage().startsWith("body:");
            assert expected.getSuppressed().length == 1;
            assert expected.getSuppressed()[0].getMessage().equals("close:agent");
        }
        System.out.println("desugaring samples verified");
    }
}
