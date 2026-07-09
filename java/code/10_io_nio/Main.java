/*
═══════════════════════════════════════════════════════════════════
 10_io_nio —— I/O 与 NIO.2 文件操作
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. 字节流 vs 字符流；缓冲流为什么必要
  2. try-with-resources 保证流被关闭
  3. NIO.2（java.nio.file）：Path / Files —— 现代文件操作首选
  4. 一行读写整个文件、按行流式读取大文件

【运行】java 10_io_nio/Main.java
（会在系统临时目录创建/删除演示文件，运行后自动清理）
*/

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.List;
import java.util.stream.Stream;

public class Main {
    public static void main(String[] args) throws IOException {
        // 在临时目录里玩，避免污染工作区
        Path dir = Files.createTempDirectory("java_io_demo");
        Path file = dir.resolve("note.txt");

        // ── 1. NIO.2 一行搞定：写整个文件 ──────────────────
        // 老式 FileWriter + BufferedWriter 要好几行，Files 一行搞定
        Files.writeString(file, "第一行\n第二行\n第三行\n", StandardCharsets.UTF_8);
        System.out.println("已写入: " + file);

        // ── 2. 一行读整个文件 ──────────────────────────────
        String content = Files.readString(file, StandardCharsets.UTF_8);
        System.out.println("整体读取:\n" + content.stripTrailing());

        // 读成 List<String>（按行）
        List<String> lines = Files.readAllLines(file);
        System.out.println("行数: " + lines.size() + "，首行: " + lines.get(0));

        // ── 3. 大文件：流式按行处理（不把整个文件读进内存）──
        try (Stream<String> stream = Files.lines(file)) {   // try-with-resources 关闭流
            long count = stream.filter(l -> l.contains("行")).count();
            System.out.println("含'行'的行数: " + count);
        }

        // ── 4. 传统字节流 + 缓冲（理解底层）────────────────
        Path binFile = dir.resolve("data.bin");
        // BufferedOutputStream 减少系统调用次数（缓冲是性能关键）
        try (var out = new BufferedOutputStream(Files.newOutputStream(binFile))) {
            for (int i = 0; i < 5; i++) out.write(i);
        } // 离开 try 自动 flush + close
        try (var in = new BufferedInputStream(Files.newInputStream(binFile))) {
            int b, sum = 0;
            while ((b = in.read()) != -1) sum += b;       // -1 表示流结束
            System.out.println("字节和: " + sum);
        }

        // ── 5. 字符流 + 缓冲（处理文本，处理编码）──────────
        Path textFile = dir.resolve("buffered.txt");
        try (var w = new BufferedWriter(new OutputStreamWriter(
                Files.newOutputStream(textFile), StandardCharsets.UTF_8))) {
            w.write("缓冲字符写入");
            w.newLine();
        }

        // ── 6. Path 与 Files 的常用元操作 ──────────────────
        System.out.println("--- 文件元信息 ---");
        System.out.println("存在? " + Files.exists(file));
        System.out.println("大小: " + Files.size(file) + " 字节");
        System.out.println("文件名: " + file.getFileName());
        System.out.println("父目录: " + file.getParent());
        System.out.println("绝对路径: " + file.toAbsolutePath());

        // 复制、移动
        Path copy = dir.resolve("note_copy.txt");
        Files.copy(file, copy, StandardCopyOption.REPLACE_EXISTING);
        System.out.println("复制完成: " + Files.exists(copy));

        // 遍历目录
        System.out.println("--- 目录内容 ---");
        try (Stream<Path> entries = Files.list(dir)) {
            entries.forEach(p -> System.out.println("  " + p.getFileName()));
        }

        // ── 7. 清理（递归删除临时目录）─────────────────────
        try (Stream<Path> walk = Files.walk(dir)) {
            walk.sorted((a, b) -> b.compareTo(a))   // 逆序：先删文件再删目录
                .forEach(p -> { try { Files.delete(p); } catch (IOException ignored) {} });
        }
        System.out.println("清理完成，临时目录还在? " + Files.exists(dir));
    }
}

/*
【I/O 体系两条主线】
  字节流 InputStream / OutputStream —— 处理二进制（图片、音视频、任意字节）
  字符流 Reader / Writer            —— 处理文本（自动按字符集编解码）
  桥接：InputStreamReader / OutputStreamWriter（字节流 ↔ 字符流，指定编码）

【为什么要缓冲流 BufferedXxx？】
  不带缓冲：每次 read()/write() 都是一次系统调用 → 极慢
  带缓冲：先攒在内存数组里，攒够一批再一次性读写 → 快几个数量级
  规则：包一层 BufferedInputStream/BufferedReader 几乎总是值得的。

【NIO.2（Java 7+）vs 传统 IO —— 现代代码该用哪个】
  - 普通文件读写：直接用 Files.readString / writeString / lines（最简洁）
  - Path 取代 File：API 更丰富、异常信息更清晰、跨平台路径处理更好
  - Files.lines() 返回流式按行读取，适合超大文件，记得 try-with-resources 关闭
  - 字符集永远显式指定 StandardCharsets.UTF_8，别依赖平台默认编码

【铁律】
  任何流/Reader/Writer 都要关闭，永远用 try-with-resources，
  不要手写 finally close（容易漏、容易吞异常，见第4课）。
*/
