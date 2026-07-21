package dev.deepjava.agent;

import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CoderResult;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** Incremental UTF-8 + SSE event parser. Network chunks are deliberately unrelated to characters/events. */
public final class SseParserLab {
    record Event(String id, String type, String data) { }
    static final class Parser {
        private static final int MAX_EVENT_CHARS = 1024;
        private final java.nio.charset.CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder();
        private ByteBuffer bytes = ByteBuffer.allocate(32);
        private final StringBuilder text = new StringBuilder();
        private String id = "", type = "message";
        private final List<String> data = new ArrayList<>();

        List<Event> feed(byte[] chunk, boolean end) throws CharacterCodingException {
            if (chunk.length > bytes.remaining()) {
                ByteBuffer larger = ByteBuffer.allocate(Math.max(bytes.capacity() * 2, bytes.position() + chunk.length));
                bytes.flip(); larger.put(bytes); bytes = larger;
            }
            bytes.put(chunk).flip();
            CharBuffer chars = CharBuffer.allocate(64);
            while (true) {
                CoderResult result = decoder.decode(bytes, chars, end);
                chars.flip(); text.append(chars); chars.clear();
                if (result.isError()) result.throwException();
                if (result.isUnderflow()) break;
            }
            bytes.compact();
            if (end) {
                CoderResult flushed = decoder.flush(chars);
                if (flushed.isError()) flushed.throwException();
                chars.flip(); text.append(chars);
            }
            return parseCompleteLines(end);
        }

        private List<Event> parseCompleteLines(boolean end) {
            List<Event> events = new ArrayList<>();
            int newline;
            while ((newline = text.indexOf("\n")) >= 0) {
                String line = text.substring(0, newline);
                text.delete(0, newline + 1);
                if (line.endsWith("\r")) line = line.substring(0, line.length() - 1);
                if (line.isEmpty()) {
                    if (!data.isEmpty()) events.add(emit());
                } else if (!line.startsWith(":")) {
                    int colon = line.indexOf(':');
                    String field = colon < 0 ? line : line.substring(0, colon);
                    String value = colon < 0 ? "" : line.substring(colon + 1).stripLeading();
                    switch (field) {
                        case "id" -> id = value;
                        case "event" -> type = value;
                        case "data" -> data.add(value);
                        default -> { }
                    }
                }
                if (text.length() + data.stream().mapToInt(String::length).sum() > MAX_EVENT_CHARS) {
                    throw new IllegalStateException("SSE event exceeds limit");
                }
            }
            if (end && (!text.isEmpty() || !data.isEmpty())) throw new IllegalStateException("truncated SSE event");
            return events;
        }

        private Event emit() {
            Event event = new Event(id, type, String.join("\n", data));
            type = "message"; data.clear();
            return event;
        }
    }

    private SseParserLab() { }
    public static void main(String[] args) throws Exception {
        byte[] wire = "id: 7\nevent: delta\ndata: 模\ndata: 型\n\n".getBytes(StandardCharsets.UTF_8);
        Parser parser = new Parser();
        List<Event> events = new ArrayList<>();
        for (int offset = 0; offset < wire.length;) {
            int count = Math.min((offset % 4) + 1, wire.length - offset);
            events.addAll(parser.feed(java.util.Arrays.copyOfRange(wire, offset, offset + count), offset + count == wire.length));
            offset += count;
        }
        assert events.equals(List.of(new Event("7", "delta", "模\n型"))) : events;
        System.out.println("incremental UTF-8 SSE parsing verified");
    }
}
