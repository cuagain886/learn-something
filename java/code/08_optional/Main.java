/*
═══════════════════════════════════════════════════════════════════
 08_optional —— Optional：用类型表达"可能没有值"，消灭 NPE
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. Optional 的创建：of / ofNullable / empty
  2. 安全取值：orElse / orElseGet / orElseThrow / ifPresent
  3. 链式处理：map / flatMap / filter
  4. ⚠️ 反模式：别拿 Optional 当字段、参数、集合元素

【运行】java 08_optional/Main.java
*/

import java.util.*;

public class Main {
    record Address(String city) {}
    record User(String name, Address address) {   // address 可能为 null
        Optional<Address> addressOpt() { return Optional.ofNullable(address); }
    }

    public static void main(String[] args) {
        // ── 1. 创建 Optional ───────────────────────────────
        Optional<String> a = Optional.of("hello");     // 值非 null，否则 NPE
        Optional<String> b = Optional.ofNullable(null); // 允许 null → empty
        Optional<String> c = Optional.empty();
        System.out.println(a + " " + b + " " + c);

        // ── 2. 安全取值 ────────────────────────────────────
        System.out.println("orElse: " + b.orElse("默认值"));        // 空时给固定默认
        System.out.println("orElseGet: " + b.orElseGet(() -> "懒计算默认")); // 空时才计算
        // orElse 的参数总会被求值；orElseGet 的 Supplier 仅在空时调用 → 默认值贵就用 orElseGet
        try {
            b.orElseThrow(() -> new NoSuchElementException("必须有值"));
        } catch (NoSuchElementException e) {
            System.out.println("orElseThrow: " + e.getMessage());
        }
        a.ifPresent(v -> System.out.println("ifPresent: " + v));
        b.ifPresentOrElse(                                     // Java 9+
                v -> System.out.println("有: " + v),
                () -> System.out.println("ifPresentOrElse: 空"));

        // ── 3. 链式：map / flatMap / filter ────────────────
        User u1 = new User("Alice", new Address("北京"));
        User u2 = new User("Bob", null);

        // 旧式防 NPE：层层 if != null（啰嗦易错）
        // 优雅写法：一条链路安全穿透 null
        String city1 = getCityOrUnknown(u1);
        String city2 = getCityOrUnknown(u2);
        System.out.println("u1 城市: " + city1 + "，u2 城市: " + city2);

        // map vs flatMap：当映射函数本身返回 Optional，用 flatMap 避免 Optional<Optional<>>
        Optional<String> upper = a.map(String::toUpperCase);            // map 自动包一层
        System.out.println("map: " + upper.get());

        // filter：不满足条件就变 empty
        Optional<Integer> num = Optional.of(7);
        System.out.println("filter 偶数: " + num.filter(n -> n % 2 == 0)); // Optional.empty

        // ── 4. 与 Stream 结合 ──────────────────────────────
        List<User> users = List.of(u1, u2, new User("Carol", new Address("上海")));
        List<String> cities = users.stream()
                .map(User::addressOpt)          // Stream<Optional<Address>>
                .flatMap(Optional::stream)      // Java 9+：空的被丢弃，有的摊平
                .map(Address::city)
                .toList();
        System.out.println("所有有效城市: " + cities);
    }

    // 一条链路：user → address → city，任一环为空都安全返回"未知"
    static String getCityOrUnknown(User u) {
        return Optional.ofNullable(u)
                .flatMap(User::addressOpt)   // address 可能空 → flatMap
                .map(Address::city)          // city 是普通值 → map
                .orElse("未知");
    }
}

/*
【为什么用 Optional？】
  让"可能没有值"出现在【类型签名】里，调用方被编译器提醒去处理空，
  而不是运行期才 NPE。它是一种"把 null 显式化"的契约。

【正确用法 vs 反模式（Effective Java 第55条）】
  ✓ 作为方法【返回值】，表达"可能查不到"：Optional<User> findById(id)
  ✓ 用 orElseGet/orElseThrow/map/flatMap 链式处理
  ✗ 不要用作【字段】或【方法参数】（增加复杂度，且 Optional 不可序列化）
  ✗ 不要在【集合元素】里放 Optional（用空集合代替 Optional<List>）
  ✗ 不要 opt.get() 不先判断（和直接 NPE 没区别，还更啰嗦）
  ✗ 返回 Optional 的方法不要返回 null（自相矛盾，要返回 Optional.empty()）
  ✗ 装箱原始类型用 OptionalInt/OptionalLong/OptionalDouble，避免 Optional<Integer>

【orElse vs orElseGet（高频考点）】
  orElse(expensive())      —— expensive() 【总会】执行，哪怕有值（浪费）
  orElseGet(() -> expensive()) —— 仅在【空时】才执行
  默认值的构造有副作用或开销时，必须用 orElseGet。
*/
