/*
═══════════════════════════════════════════════════════════════════
 07_stream —— Stream API：声明式数据处理流水线
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. 流的三段式：创建 → 中间操作(惰性) → 终端操作(触发)
  2. 常用中间操作 filter/map/flatMap/sorted/distinct/limit/peek
  3. 终端操作 collect / Collectors（分组、连接、统计）、reduce、count
  4. ⚠️ 流的惰性求值、只能消费一次、并行流陷阱

【运行】java 07_stream/Main.java
*/

import java.util.*;
import java.util.stream.*;

public class Main {
    record Employee(String name, String dept, int salary) {}

    public static void main(String[] args) {
        List<Employee> employees = List.of(
                new Employee("Alice", "Eng", 30000),
                new Employee("Bob", "Eng", 25000),
                new Employee("Carol", "Sales", 20000),
                new Employee("Dave", "Sales", 28000),
                new Employee("Eve", "HR", 22000));

        // ── 1. 流水线：filter → map → collect ──────────────
        List<String> highPaidEng = employees.stream()           // 创建流
                .filter(e -> e.dept().equals("Eng"))            // 中间：筛选
                .filter(e -> e.salary() > 26000)               // 中间：可叠加
                .map(Employee::name)                            // 中间：转换
                .toList();                                       // 终端：Java 16+ 收集
        System.out.println("高薪工程师: " + highPaidEng);

        // ── 2. 数值流：避免装箱，提供 sum/average/统计 ─────
        IntSummaryStatistics stats = employees.stream()
                .mapToInt(Employee::salary)        // → IntStream（原始类型流）
                .summaryStatistics();
        System.out.printf("薪资 总和=%d 平均=%.0f 最高=%d 最低=%d%n",
                stats.getSum(), stats.getAverage(), stats.getMax(), stats.getMin());

        // ── 3. Collectors：分组是最常用的"杀手锏" ──────────
        // 按部门分组
        Map<String, List<Employee>> byDept = employees.stream()
                .collect(Collectors.groupingBy(Employee::dept));
        System.out.println("分组人数: " + byDept.entrySet().stream()
                .collect(Collectors.toMap(Map.Entry::getKey, e -> e.getValue().size())));

        // 分组 + 下游聚合：每个部门的平均薪资
        Map<String, Double> avgByDept = employees.stream()
                .collect(Collectors.groupingBy(Employee::dept,
                        Collectors.averagingInt(Employee::salary)));
        System.out.println("部门平均薪资: " + avgByDept);

        // 连接成字符串
        String names = employees.stream().map(Employee::name)
                .collect(Collectors.joining(", ", "[", "]"));
        System.out.println("所有名字: " + names);

        // 分区（按 boolean 一分为二）
        Map<Boolean, List<Employee>> partition = employees.stream()
                .collect(Collectors.partitioningBy(e -> e.salary() >= 25000));
        System.out.println("高薪人数: " + partition.get(true).size()
                + "，低薪人数: " + partition.get(false).size());

        // ── 4. reduce：自定义聚合 ──────────────────────────
        int total = employees.stream().map(Employee::salary).reduce(0, Integer::sum);
        System.out.println("薪资总额(reduce): " + total);
        Optional<Employee> richest = employees.stream()
                .max(Comparator.comparingInt(Employee::salary));
        richest.ifPresent(e -> System.out.println("最高薪: " + e.name()));

        // ── 5. flatMap：摊平嵌套结构 ───────────────────────
        List<List<Integer>> nested = List.of(List.of(1, 2), List.of(3, 4), List.of(5));
        List<Integer> flat = nested.stream()
                .flatMap(List::stream)        // 把每个子列表的流"摊平"合并
                .toList();
        System.out.println("摊平: " + flat);

        // ── 6. 流的创建方式 & 惰性求值演示 ─────────────────
        // 惰性：中间操作不执行，直到遇到终端操作才"拉动"整条流水线
        System.out.println("--- 惰性求值（注意 peek 何时打印）---");
        Optional<Integer> firstBig = Stream.of(1, 2, 3, 4, 5, 6)
                .peek(n -> System.out.println("  经过 filter 前: " + n))
                .filter(n -> n > 3)
                .findFirst();        // 短路：找到 4 就停，5、6 根本不处理
        System.out.println("第一个 >3 的: " + firstBig.get());

        // 无限流 + limit
        List<Integer> firstFive = Stream.iterate(1, n -> n * 2).limit(5).toList();
        System.out.println("2 的幂前 5 个: " + firstFive);

        // ── 7. ⚠️ 常见陷阱 ─────────────────────────────────
        Stream<Integer> s = Stream.of(1, 2, 3);
        s.forEach(x -> {});         // 消费掉
        try { s.count(); }          // ⚠️ 流只能消费一次！
        catch (IllegalStateException e) { System.out.println("流不能重复消费: " + e.getMessage()); }
    }
}

/*
【Stream 三段式心智模型】
  数据源.stream()              ← 创建（集合/数组/Stream.of/iterate/generate/IntStream.range）
    .中间操作().中间操作()...   ← 惰性：返回新流，不立即执行；可链式
    .终端操作()                 ← 触发：真正遍历，产出结果或副作用，流即关闭

  中间操作：filter map flatMap mapToInt sorted distinct limit skip peek
  终端操作：forEach toList collect reduce count min max anyMatch findFirst sum

【惰性 + 短路（重要）】
  - 整条流水线在终端操作时"一次遍历"完成，不是每个中间操作各遍历一遍
  - findFirst/anyMatch/limit 是【短路】操作，满足即停，能处理无限流

【性能与陷阱】
  - 数值用 IntStream/LongStream/DoubleStream，避免 Integer 装箱拆箱
  - 流【只能消费一次】，消费后再用抛 IllegalStateException
  - 别在 Lambda 里改外部状态（forEach 里 list.add 在并行流下会出错）
  - parallel() 不是银弹：数据量小、有顺序依赖、IO 密集时反而更慢；
    且共享可变状态会出错。CPU 密集 + 大数据量 + 无状态才考虑并行流。
  - 简单循环未必要写成流——可读性优先，别为了"函数式"而函数式
*/
