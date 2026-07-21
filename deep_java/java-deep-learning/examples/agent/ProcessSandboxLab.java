package dev.deepjava.agent;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/** Process lifecycle mechanics only; this is not an OS security sandbox. */
public final class ProcessSandboxLab {
    private static final int MAX_OUTPUT = 16 * 1024;
    private ProcessSandboxLab() { }

    public static void main(String[] args) throws Exception {
        if (args.length == 1 && args[0].equals("child")) {
            System.out.print("o".repeat(4096));
            System.err.print("e".repeat(4096));
            return;
        }
        Path java = Path.of(System.getProperty("java.home"), "bin", isWindows() ? "java.exe" : "java");
        List<String> command = List.of(java.toString(), "-cp", System.getProperty("java.class.path"),
                ProcessSandboxLab.class.getName(), "child");
        Process process = new ProcessBuilder(command).redirectInput(ProcessBuilder.Redirect.PIPE).start();
        try (ExecutorService drains = Executors.newVirtualThreadPerTaskExecutor()) {
            Future<byte[]> stdout = drains.submit(() -> readLimited(process.getInputStream()));
            Future<byte[]> stderr = drains.submit(() -> readLimited(process.getErrorStream()));
            if (!process.waitFor(Duration.ofSeconds(2).toMillis(), TimeUnit.MILLISECONDS)) {
                terminateTree(process, Duration.ofMillis(200));
                throw new AssertionError("child timed out");
            }
            assert process.exitValue() == 0;
            assert stdout.get().length == 4096 && stderr.get().length == 4096;
        } finally {
            if (process.isAlive()) terminateTree(process, Duration.ofMillis(200));
        }
        System.out.println("ProcessBuilder argument list, dual-stream drain and bounded lifecycle verified");
    }

    private static byte[] readLimited(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[1024];
        for (int read; (read = input.read(buffer)) >= 0;) {
            if (output.size() + read > MAX_OUTPUT) throw new IllegalStateException("output limit exceeded");
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }
    private static void terminateTree(Process process, Duration grace) throws InterruptedException {
        process.descendants().forEach(ProcessHandle::destroy);
        process.destroy();
        if (!process.waitFor(grace.toMillis(), TimeUnit.MILLISECONDS)) {
            process.descendants().forEach(ProcessHandle::destroyForcibly);
            process.destroyForcibly();
            process.waitFor(grace.toMillis(), TimeUnit.MILLISECONDS);
        }
    }
    private static boolean isWindows() { return System.getProperty("os.name").toLowerCase().contains("win"); }
}
