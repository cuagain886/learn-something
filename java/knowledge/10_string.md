# 10 · String 原理 ⭐⭐

> "`String s = new String("a")` 创建了几个对象？""`==` 和 equals 区别？"——String 是面试常客。
> 核心一句话：**String 不可变；字面量进字符串常量池复用；`+` 拼接会创建新对象，循环拼接要用 StringBuilder。**

---

## 1. String 的不可变性 ⭐

```java
public final class String implements ... {
    private final byte[] value;   // Java 9+ 用 byte[]（之前是 char[]）
    // 没有任何方法修改 value
}
```

- `String` 类是 **final**（不可被继承），内部 `value` 数组是 **private final**，且不对外暴露引用。
- 所有"修改"方法（`substring`、`replace`、`toUpperCase`、`concat`）都**返回新 String**，原对象不变。

**为什么设计成不可变？**
1. **常量池可安全复用**：多个引用共享同一个 String 实例不会互相影响。
2. **线程安全**：不可变对象天生线程安全，可随意共享。
3. **可做 HashMap 的 key**：hashCode 不变，且会缓存（`private int hash`），性能好。
4. **安全**：作为类加载路径、网络地址、参数传递时，不会被中途篡改。

> Java 9 的**紧凑字符串（Compact Strings）**：纯 Latin-1 字符用 1 字节/字符存储（而非之前 char 的 2 字节），省内存。`value` 因此从 `char[]` 改为 `byte[]` + 一个 coder 标记。

---

## 2. 字符串常量池 String Pool ⭐⭐

- 一块特殊存储区，存字符串字面量，**实现复用**。Java 7 起从永久代移到了**堆**中。
- **字面量**自动入池：
  ```java
  String a = "hello";   // "hello" 进常量池
  String b = "hello";   // 复用池中同一个对象
  System.out.println(a == b);   // true！同一引用
  ```
- **new 创建**不复用池对象：
  ```java
  String c = new String("hello");  // 在【堆】上新建一个对象，不等于池中的
  System.out.println(a == c);      // false（引用不同）
  System.out.println(a.equals(c)); // true（内容相同）
  ```

### "new String("a") 创建几个对象"经典题
> **可能 1 个或 2 个**。`"a"` 这个字面量若常量池里还没有，则创建：① 池里一个 + ② 堆里一个 new 的 = **2 个**；若池里已存在 `"a"`，则只在堆里 new **1 个**。

---

## 3. intern() 方法

`s.intern()`：若常量池已有等值字符串，返回**池中引用**；否则把 s 加入池（Java 7+ 是放入引用）并返回。

```java
String s = new String("a") + new String("b");  // 堆上新对象 "ab"，池里此刻没有 "ab"
System.out.println(s == "ab");          // false
System.out.println(s.intern() == "ab"); // true（intern 后池里有了 "ab"，"ab"字面量复用它）
```

> intern 能节省内存（大量重复字符串去重），但池过大也有开销，慎用。

---

## 4. 字符串拼接 ⭐⭐

### 4.1 编译期常量折叠
```java
String s = "a" + "b" + "c";   // 编译器直接优化成 "abc"，无运行期开销
```

### 4.2 运行期 `+` 拼接
```java
String r = a + b;   // a、b 是变量
```
- Java 8：编译成 `new StringBuilder().append(a).append(b).toString()`。
- Java 9+：用 `invokedynamic` + `StringConcatFactory` 动态生成更优代码。
- 无论哪种，**每次 `+` 都产生新的中间对象**。

### 4.3 ⚠️ 循环里拼接的陷阱
```java
// ✗ 灾难：每次循环都 new 一个 StringBuilder 再 toString，O(n²)
String s = "";
for (int i = 0; i < n; i++) s += i;     // 每轮创建临时 StringBuilder + 新 String

// ✓ 正确：循环外建一个 StringBuilder，复用
StringBuilder sb = new StringBuilder();
for (int i = 0; i < n; i++) sb.append(i);
String s = sb.toString();
```

### 4.4 StringBuilder vs StringBuffer
| | StringBuilder | StringBuffer |
|---|---|---|
| 线程安全 | 否 | 是（方法 synchronized） |
| 性能 | 快 | 慢（锁开销） |
| 场景 | 单线程（99% 情况） | 多线程共享（极少见） |

> 几乎总是用 **StringBuilder**；StringBuffer 是历史遗留，多线程拼接通常各线程用自己的局部 StringBuilder 即可。

---

## 5. == vs equals ⭐

- `==`：比较**引用地址**（基本类型比值）。
- `equals`：String 重写为比较**内容**。
- 比较字符串内容**永远用 equals**（或 `Objects.equals` 防 NPE），别用 `==`。
- 想避免 NPE：`"常量".equals(变量)` 或 `Objects.equals(a, b)`。

---

## 6. 高频面试题 + 标准答案

**Q1：String 为什么是不可变的？有什么好处？** ⭐
> 类是 final，value 数组 private final 且不暴露，所有修改方法返回新对象。好处：常量池可安全复用、线程安全、可缓存 hashCode 做 key、传递时不被篡改。

**Q2：`String s = new String("hello")` 创建几个对象？** ⭐
> 1 个或 2 个。字面量 "hello" 若常量池没有则创建（池 1 个 + 堆 new 1 个 = 2 个）；若池里已有则只堆里 new 1 个。

**Q3：`==` 和 equals 区别？字符串怎么比较？**
> == 比引用地址，equals 比内容（String 已重写）。比内容用 equals，且建议 "常量".equals(变量) 或 Objects.equals 防 NPE。

**Q4：String、StringBuilder、StringBuffer 区别？** ⭐
> String 不可变，拼接产生新对象。StringBuilder 可变、非线程安全、快，单线程拼接首选。StringBuffer 可变、方法加 synchronized 线程安全但慢。循环拼接必须用 StringBuilder。

**Q5：循环里用 `+` 拼接字符串有什么问题？**
> 每次 `+` 都隐式新建 StringBuilder 并 toString，产生大量临时对象，整体 O(n²)。应在循环外建一个 StringBuilder 复用 append。

**Q6：intern() 有什么用？**
> 把字符串放入/复用常量池，返回池中引用。可对大量重复字符串去重省内存，但池过大有开销，需权衡。

**Q7：Java 9 对 String 做了什么优化？**
> 紧凑字符串：纯 Latin-1 字符串用 1 字节/字符存储，value 从 char[] 改 byte[] 加 coder 标记，显著省内存。

---

## 一句话总结

> String **不可变（final 类 + final byte[]）**，所以能安全进**常量池复用**、做 key、跨线程共享；
> `==` 比引用、**equals 比内容**；字面量复用池对象、`new` 必建堆对象；
> 拼接用 `+` 会造临时对象，**循环拼接一律 StringBuilder**。
