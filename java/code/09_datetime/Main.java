/*
═══════════════════════════════════════════════════════════════════
 09_datetime —— 现代日期时间 API（java.time，Java 8+）
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. 为什么弃用 Date/Calendar，改用 java.time
  2. 核心类型：LocalDate / LocalTime / LocalDateTime / Instant
  3. 时区：ZonedDateTime / ZoneId / OffsetDateTime
  4. 时间量：Duration（时间）/ Period（日期）、计算与比较
  5. 格式化与解析 DateTimeFormatter

【运行】java 09_datetime/Main.java
*/

import java.time.*;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;

public class Main {
    public static void main(String[] args) {
        // ── 1. 三种"本地"时间（不带时区）──────────────────
        LocalDate today = LocalDate.now();
        LocalTime now = LocalTime.now();
        LocalDateTime dt = LocalDateTime.now();
        System.out.println("日期: " + today + " 时间: " + now);
        // 构造特定日期：注意月份从 1 开始（旧 Calendar 从 0 开始，是经典坑）
        LocalDate birthday = LocalDate.of(1995, 8, 15);
        System.out.println("生日: " + birthday + " 星期: " + birthday.getDayOfWeek());

        // ── 2. 不可变 + 流式计算（每次操作返回新对象）─────
        LocalDate nextWeek = today.plusWeeks(1);
        LocalDate lastMonth = today.minusMonths(1).withDayOfMonth(1); // 上月 1 号
        System.out.println("下周: " + nextWeek + " 上月初: " + lastMonth);

        // ── 3. Instant：机器时间戳（UTC，从 1970 起的精确瞬间）─
        Instant t1 = Instant.now();
        Instant t2 = t1.plusSeconds(90);
        System.out.println("时间戳: " + t1 + " 毫秒: " + t1.toEpochMilli());

        // ── 4. Duration vs Period ──────────────────────────
        // Duration：基于"时间"（秒/纳秒），适合 Instant/LocalTime
        Duration d = Duration.between(t1, t2);
        System.out.println("相差: " + d.toMinutes() + " 分 " + (d.toSeconds() % 60) + " 秒");
        // Period：基于"日历"（年/月/日），适合 LocalDate
        Period age = Period.between(birthday, today);
        System.out.printf("年龄: %d 年 %d 月 %d 天%n",
                age.getYears(), age.getMonths(), age.getDays());
        // 跨度算法用 ChronoUnit 更直接
        long daysAlive = ChronoUnit.DAYS.between(birthday, today);
        System.out.println("活了 " + daysAlive + " 天");

        // ── 5. 时区 ────────────────────────────────────────
        ZoneId shanghai = ZoneId.of("Asia/Shanghai");
        ZoneId newYork = ZoneId.of("America/New_York");
        ZonedDateTime nowSh = ZonedDateTime.now(shanghai);
        ZonedDateTime nowNy = nowSh.withZoneSameInstant(newYork); // 同一瞬间换时区
        System.out.println("上海: " + nowSh.toLocalTime().withNano(0));
        System.out.println("纽约: " + nowNy.toLocalTime().withNano(0) + "（同一时刻）");

        // ── 6. 格式化与解析 ────────────────────────────────
        DateTimeFormatter fmt = DateTimeFormatter.ofPattern("yyyy年MM月dd日 HH:mm:ss");
        String text = dt.format(fmt);
        System.out.println("格式化: " + text);
        LocalDateTime parsed = LocalDateTime.parse("2024-12-25 18:30:00",
                DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"));
        System.out.println("解析回: " + parsed);

        // ── 7. 比较 ────────────────────────────────────────
        System.out.println("生日在今天之前? " + birthday.isBefore(today));
    }
}

/*
【为什么必须用 java.time，别用 Date/Calendar】
  旧 API 的罪状：
  - Date 可变（线程不安全），且大部分方法已废弃
  - Calendar 月份从 0 开始（一月是 0）—— 无数线上 bug 的源头
  - SimpleDateFormat 非线程安全，多线程共享会出错乱
  - 时区处理混乱、API 设计反直觉
  java.time（JSR-310，借鉴 Joda-Time）全部是【不可变 + 线程安全】，设计清晰。

【核心类型怎么选】
  只要日期         → LocalDate          （生日、纪念日）
  只要时间         → LocalTime          （营业时间）
  日期+时间，无时区 → LocalDateTime      （日志时间戳、本地预约）
  精确瞬间(UTC)    → Instant            （事件时间戳、计时、存数据库）
  带时区的日期时间  → ZonedDateTime      （跨时区会议、航班）
  时间间隔(秒)     → Duration           （超时、耗时统计）
  日期间隔(年月日)  → Period             （年龄、订阅周期）

【实践建议】
  - 存储/传输用 Instant（UTC），展示时再转用户时区 ZonedDateTime
  - DateTimeFormatter 是不可变线程安全的，可定义成 static 常量复用
  - 所有 java.time 对象都不可变，"修改"方法（plus/minus/with）都返回新对象
*/
