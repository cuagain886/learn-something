package dev.deepjava.io;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.channels.WritableByteChannel;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** JDK 21. Length-field framing, fragmented input and partial non-blocking-style writes. */
public final class NioProtocolLab {
    private NioProtocolLab() { }

    static final class Decoder {
        private static final int MAX_FRAME = 1_024;
        private ByteBuffer cumulation = ByteBuffer.allocate(16).order(ByteOrder.BIG_ENDIAN);

        List<String> feed(byte[] fragment) {
            ensureWritable(fragment.length);
            cumulation.put(fragment).flip();
            List<String> decoded = new ArrayList<>();
            while (cumulation.remaining() >= Integer.BYTES) {
                cumulation.mark();
                int length = cumulation.getInt();
                if (length < 0 || length > MAX_FRAME) throw new IllegalArgumentException("invalid frame: " + length);
                if (cumulation.remaining() < length) {
                    cumulation.reset();
                    break;
                }
                byte[] payload = new byte[length];
                cumulation.get(payload);
                decoded.add(new String(payload, StandardCharsets.UTF_8));
            }
            cumulation.compact();
            return decoded;
        }

        private void ensureWritable(int incoming) {
            if (incoming <= cumulation.remaining()) return;
            int used = cumulation.position();
            int capacity = cumulation.capacity();
            while (capacity - used < incoming) capacity = Math.multiplyExact(capacity, 2);
            ByteBuffer replacement = ByteBuffer.allocate(capacity).order(ByteOrder.BIG_ENDIAN);
            cumulation.flip();
            replacement.put(cumulation);
            cumulation = replacement;
        }
    }

    static final class PartialChannel implements WritableByteChannel {
        private final int limitPerWrite;
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        private boolean open = true;

        PartialChannel(int limitPerWrite) { this.limitPerWrite = limitPerWrite; }
        @Override public int write(ByteBuffer src) {
            int count = Math.min(limitPerWrite, src.remaining());
            byte[] chunk = new byte[count];
            src.get(chunk);
            bytes.writeBytes(chunk);
            return count;
        }
        @Override public boolean isOpen() { return open; }
        @Override public void close() { open = false; }
        byte[] toByteArray() { return bytes.toByteArray(); }
    }

    public static void main(String[] args) throws IOException {
        byte[] first = frame("模型");
        byte[] second = frame("tool-output");
        byte[] wire = ByteBuffer.allocate(first.length + second.length).put(first).put(second).array();

        Decoder decoder = new Decoder();
        List<String> messages = new ArrayList<>();
        int[] fragments = {1, 2, 5, 3, wire.length};
        int offset = 0;
        for (int requested : fragments) {
            if (offset == wire.length) break;
            int count = Math.min(requested, wire.length - offset);
            byte[] part = new byte[count];
            System.arraycopy(wire, offset, part, 0, count);
            messages.addAll(decoder.feed(part));
            offset += count;
        }
        assert messages.equals(List.of("模型", "tool-output")) : messages;

        PartialChannel slow = new PartialChannel(3);
        ByteBuffer outbound = ByteBuffer.wrap(wire);
        int writes = 0;
        while (outbound.hasRemaining()) {
            int count = slow.write(outbound);
            if (count == 0) throw new AssertionError("would register OP_WRITE instead of spinning");
            writes++;
        }
        assert writes > 1;
        assert java.util.Arrays.equals(wire, slow.toByteArray());
        System.out.println("fragmented framing and partial writes verified, writeCalls=" + writes);
    }

    private static byte[] frame(String value) {
        byte[] payload = value.getBytes(StandardCharsets.UTF_8);
        return ByteBuffer.allocate(Integer.BYTES + payload.length)
                .order(ByteOrder.BIG_ENDIAN).putInt(payload.length).put(payload).array();
    }
}
