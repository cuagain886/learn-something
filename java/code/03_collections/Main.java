/*
═══════════════════════════════════════════════════════════════════
 03_collections —— 集合框架：List / Set / Map / Queue 全家谱
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. 集合框架的继承体系与四大接口：List、Set、Queue、Map
  2. 各实现类的取舍：ArrayList vs LinkedList、HashMap vs TreeMap 等
  3. 排序：Comparable（自然序）vs Comparator（外部序）+ 链式比较器
  4. 不可变集合 List.of / Map.of（Java 9+）与遍历删除陷阱
  5. Java 21 新增的有序集合接口 SequencedCollection

【运行】java 03_collections/Main.java
*/

import java.util.*;

public class Main {
    public static void main(String[] args) {
        // ── 1. List：有序、可重复、带下标 ──────────────────
        List<String> arrayList = new ArrayList<>(List.of("a", "b", "c")); // 随机访问 O(1)
        List<String> linkedList = new LinkedList<>(arrayList);            // 头尾增删 O(1)
        arrayList.add("d");
        System.out.println("ArrayList: " + arrayList);

        // ── 2. Set：去重、无序（HashSet）/有序 ──────────────
        Set<Integer> hashSet = new HashSet<>(List.of(3, 1, 2, 3, 1)); // 自动去重，无序
        Set<Integer> treeSet = new TreeSet<>(hashSet);                // 自动排序
        Set<Integer> linkedHashSet = new LinkedHashSet<>(List.of(3, 1, 2)); // 保留插入序
        System.out.println("HashSet=" + hashSet + " TreeSet=" + treeSet
                + " LinkedHashSet=" + linkedHashSet);

        // ── 3. Map：键值对 ─────────────────────────────────
        Map<String, Integer> map = new HashMap<>();
        // 计数器惯用法：getOrDefault / merge
        for (String w : "the cat the dog the bird".split(" ")) {
            map.merge(w, 1, Integer::sum);   // 不存在则放 1，存在则旧值 + 1
        }
        System.out.println("词频: " + map);
        // computeIfAbsent：分组惯用法
        Map<Integer, List<String>> byLen = new HashMap<>();
        for (String w : List.of("a", "bb", "cc", "ddd")) {
            byLen.computeIfAbsent(w.length(), k -> new ArrayList<>()).add(w);
        }
        System.out.println("按长度分组: " + byLen);

        TreeMap<String, Integer> sorted = new TreeMap<>(map); // 按键排序
        System.out.println("TreeMap(按键排序): " + sorted);

        // ── 4. Queue / Deque：队列与栈 ─────────────────────
        Deque<Integer> stack = new ArrayDeque<>();      // 官方推荐用 Deque 当栈，别用 Stack
        stack.push(1); stack.push(2); stack.push(3);
        System.out.println("栈顶弹出: " + stack.pop()); // 3（后进先出）
        Queue<Integer> queue = new ArrayDeque<>();
        queue.offer(1); queue.offer(2);
        System.out.println("队首出队: " + queue.poll()); // 1（先进先出）
        // 优先队列：每次取出最小（或自定义优先级）
        PriorityQueue<Integer> pq = new PriorityQueue<>(List.of(5, 1, 3));
        System.out.println("优先队列取最小: " + pq.poll()); // 1

        // ── 5. 排序：Comparable vs Comparator ──────────────
        List<Person> people = new ArrayList<>(List.of(
                new Person("Bob", 30), new Person("Alice", 30), new Person("Carol", 25)));
        people.sort(null);                                    // 用 Comparable 自然序(按年龄)
        System.out.println("自然序(年龄): " + people);
        // 链式比较器：先按年龄，再按姓名；可 reversed()
        people.sort(Comparator.comparingInt(Person::age)
                              .thenComparing(Person::name));
        System.out.println("年龄+姓名: " + people);

        // ── 6. 不可变集合 + 遍历删除陷阱 ───────────────────
        List<Integer> immutable = List.of(1, 2, 3);    // Java 9+，不可变
        try { immutable.add(4); }
        catch (UnsupportedOperationException e) { System.out.println("不可变集合不能加元素"); }

        // ⚠️ 遍历中直接 remove 会 ConcurrentModificationException
        List<Integer> nums = new ArrayList<>(List.of(1, 2, 3, 4, 5));
        // 错误写法：for (int n : nums) if (n%2==0) nums.remove(...);  → CME
        nums.removeIf(n -> n % 2 == 0);                 // 正确：用 removeIf
        System.out.println("removeIf 删偶数后: " + nums);
        // 或用 Iterator.remove()
        Iterator<Integer> it = nums.iterator();
        while (it.hasNext()) { if (it.next() == 3) it.remove(); }
        System.out.println("Iterator 删 3 后: " + nums);

        // ── 7. Java 21：SequencedCollection 统一首尾操作 ────
        List<Integer> seq = new ArrayList<>(List.of(1, 2, 3));
        seq.addFirst(0);          // Java 21 新方法
        seq.addLast(4);
        System.out.println("首=" + seq.getFirst() + " 尾=" + seq.getLast()
                + " 反转=" + seq.reversed());
    }
}

record Person(String name, int age) implements Comparable<Person> {
    @Override public int compareTo(Person o) { return Integer.compare(this.age, o.age); }
    @Override public String toString() { return name + "(" + age + ")"; }
}

/*
【实现类选型决策表】
  需求                                 → 首选
  ─────────────────────────────────────────────────
  有序列表，频繁随机访问/尾部增删      → ArrayList
  频繁在头部/中间插入删除              → LinkedList（实际很少需要）
  去重，不在乎顺序                     → HashSet
  去重 + 保留插入顺序                  → LinkedHashSet
  去重 + 自动排序                      → TreeSet
  键值映射，最常用                     → HashMap
  键值映射 + 保留插入顺序              → LinkedHashMap（也常用作 LRU 缓存基础）
  键值映射 + 按键排序/范围查询         → TreeMap
  先进先出队列 / 后进先出栈            → ArrayDeque
  按优先级取元素                       → PriorityQueue（堆）
  并发场景                             → ConcurrentHashMap / CopyOnWriteArrayList（见第12课）

【复杂度速记】
  ArrayList:  get O(1)  add尾 O(1)均摊  add中 O(n)  contains O(n)
  LinkedList: get O(n)  add头尾 O(1)    contains O(n)
  HashMap:    get/put 平均 O(1)，最坏 O(log n)（红黑树化，见 knowledge/06）
  TreeMap:    get/put O(log n)，但有序

【高频陷阱】
  - HashMap 的键必须正确重写 equals + hashCode（见 knowledge/06）
  - 遍历集合时结构性修改 → ConcurrentModificationException（用 removeIf / Iterator.remove）
  - List.of(...) / Map.of(...) 返回【不可变】集合，且不允许 null 元素
  - Arrays.asList(arr) 返回的是定长视图，不能 add/remove
*/
