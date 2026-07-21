package dev.deepjava.io;

import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

/** JDK 21. FileChannel positional I/O and transferTo loop with explicit cleanup. */
public final class FileChannelLab {
    private FileChannelLab() { }

    public static void main(String[] args) throws Exception {
        Path directory = Files.createTempDirectory("deep-java-nio-");
        Path source = directory.resolve("source.bin");
        Path target = directory.resolve("target.bin");
        byte[] expected = "header\nstreaming-payload\n".repeat(256).getBytes(StandardCharsets.UTF_8);
        try {
            try (FileChannel output = FileChannel.open(source,
                    StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                ByteBuffer buffer = ByteBuffer.wrap(expected);
                while (buffer.hasRemaining()) output.write(buffer);
                output.force(true);
            }
            try (FileChannel input = FileChannel.open(source, StandardOpenOption.READ);
                 FileChannel output = FileChannel.open(target,
                         StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                long position = 0;
                while (position < input.size()) {
                    long transferred = input.transferTo(position, input.size() - position, output);
                    if (transferred <= 0) throw new AssertionError("transfer made no progress");
                    position += transferred;
                }
            }
            assert java.util.Arrays.equals(expected, Files.readAllBytes(target));
            System.out.println("FileChannel transfer verified, bytes=" + expected.length);
        } finally {
            Files.deleteIfExists(target);
            Files.deleteIfExists(source);
            Files.deleteIfExists(directory);
        }
    }
}
