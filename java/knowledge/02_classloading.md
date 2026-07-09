# 02 · 类加载机制 ⭐⭐⭐

> "一个 .class 文件怎么变成内存里能用的类？"核心一句话：
> **加载 → 链接（验证/准备/解析）→ 初始化，由类加载器按"双亲委派"协作完成。**

---

## 1. 类的生命周期

```
加载 Loading → 链接 Linking → 初始化 Initialization → 使用 Using → 卸载 Unloading
                 ├ 验证 Verification
                 ├ 准备 Preparation
                 └ 解析 Resolution
```

### 1.1 加载 Loading

- 通过类的**全限定名**获取定义此类的二进制字节流（从 .class 文件 / jar / 网络 / 动态生成）。
- 把字节流转成方法区（元空间）的运行时数据结构。
- 在**堆**中生成一个代表该类的 `java.lang.Class` 对象，作为访问类元数据的入口。

### 1.2 链接 Linking

- **验证 Verification**：检查字节码是否合法、安全（魔数 `0xCAFEBABE`、版本号、是否破坏内存安全），防止恶意/损坏的 class 危害 JVM。
- **准备 Preparation**：为**类的静态变量**分配内存并设**零值**（注意：不是代码里写的初值！）。
  ```java
  static int a = 10;   // 准备阶段 a = 0；到初始化阶段才 = 10
  static final int b = 20;  // ⚠️ 常量：准备阶段就直接是 20（编译期确定）
  ```
- **解析 Resolution**：把常量池里的**符号引用**（用名字描述）替换为**直接引用**（指针/偏移量）。

### 1.3 初始化 Initialization

- 执行**类构造器 `<clinit>()`**——由编译器收集所有**静态变量赋值**和**静态代码块**合并而成。
- 此时静态变量才被赋予代码里写的真正初值。
- ⭐ JVM 保证 `<clinit>()` 在**多线程下被正确加锁同步**——这正是"静态内部类单例"线程安全的根基。

> ⚠️ 区分两个构造器：
> - `<clinit>()`：**类**构造器，初始化静态成员，类加载时执行一次。
> - `<init>()`：**实例**构造器，每次 new 对象时执行。

---

## 2. 类初始化的触发时机（"主动引用"）

只有以下情况才会触发类的**初始化**（加载/链接可能更早）：

1. **new** 对象、读写**非常量静态字段**、调用**静态方法**。
2. 反射调用（`Class.forName("X")`，注意默认会初始化）。
3. 初始化子类时，父类先初始化。
4. JVM 启动时的主类（含 main 的类）。

**不会触发初始化的"被动引用"**（高频考点）：

```java
System.out.println(Child.PARENT_STATIC);  // 通过子类访问父类静态字段 → 只初始化父类，不初始化子类
Parent[] arr = new Parent[10];            // 创建数组 → 不初始化 Parent
System.out.println(Const.MAX);            // 引用 static final 常量 → 编译期已内联，不初始化 Const
```

---

## 3. 类加载器与双亲委派 ⭐⭐

### 3.1 三层类加载器

```
Bootstrap ClassLoader（启动类加载器，C++ 实现，是 null）
    │   加载 <JAVA_HOME>/lib 核心类（java.lang.* 等）
    ↓ 父
Platform ClassLoader（平台类加载器，Java 9 前叫 Extension）
    │   加载 JDK 扩展模块
    ↓ 父
Application ClassLoader（应用/系统类加载器）
    │   加载 classpath 上你写的类
    ↓ 父
Custom ClassLoader（自定义，可选）
```

> 注意"父子"是**组合关系（持有 parent 引用）**，不是继承关系。

### 3.2 双亲委派模型（Parents Delegation）

**收到加载请求时，先委派给父加载器；父加载不了，自己才加载。**

```java
// ClassLoader.loadClass 的核心逻辑（简化）
protected Class<?> loadClass(String name) {
    if (已加载) return 缓存;
    try {
        if (parent != null) return parent.loadClass(name);  // ① 先问父亲
        else return findBootstrapClass(name);               // ② 父是 Bootstrap
    } catch (ClassNotFoundException e) { /* 父加载不了，落到下面 */ }
    return findClass(name);                                  // ③ 父不行，自己加载
}
```

**为什么这么设计？**
1. **安全**：核心类（如 `java.lang.String`）总是由 Bootstrap 加载。你写一个假的 `java.lang.String` 放 classpath，也会被委派给 Bootstrap，加载的还是真的——**防止核心 API 被篡改**。
2. **避免重复加载**：同一个类由同一个加载器加载一次，保证唯一性。

### 3.3 类的唯一性

**一个类的"身份" = 全限定名 + 加载它的类加载器。** 同一个 .class 被两个不同加载器加载，得到的是**两个不同的类**，互相 `instanceof` 为 false、强转抛 `ClassCastException`。这是 Tomcat 隔离多个 webapp、热部署的原理。

### 3.4 打破双亲委派

并非铁律，三个经典案例：

1. **SPI 机制（如 JDBC）**：核心接口 `java.sql.Driver` 由 Bootstrap 加载，但实现（MySQL 驱动）在 classpath 上，Bootstrap 加载不了。于是用**线程上下文类加载器（TCCL）**反向委派给应用类加载器去加载实现——打破了"只能往上委派"。
2. **Tomcat**：每个 webapp 一个 `WebAppClassLoader`，**优先自己加载**（先 findClass 再委派），实现应用间类隔离 + 同名不同版本库共存。
3. **OSGi / 热部署**：自定义加载器实现模块化、动态替换。

---

## 4. 经典应用：静态内部类单例（线程安全且懒加载）

```java
public class Singleton {
    private Singleton() {}
    private static class Holder {            // 静态内部类，类加载时不会立即初始化
        static final Singleton INSTANCE = new Singleton();
    }
    public static Singleton getInstance() {
        return Holder.INSTANCE;              // 首次调用才触发 Holder 初始化 → 创建实例
    }
}
```

**为什么线程安全？** 因为 JVM 保证 `<clinit>()`（Holder 的初始化）在多线程下只执行一次且加锁同步（见 §1.3）。既懒加载又免锁，是优雅的单例写法。

---

## 5. 高频面试题 + 标准答案

**Q1：类加载过程分几步？** ⭐
> 加载→链接（验证、准备、解析）→初始化。加载读字节码生成 Class 对象；准备给静态变量分配内存赋零值；初始化执行 `<clinit>` 赋真正初值并跑静态块。

**Q2：什么是双亲委派？为什么需要它？** ⭐⭐
> 类加载请求先逐级委派给父加载器，父加载不了子才自己加载。目的：① 安全，核心类只由 Bootstrap 加载，防止 `java.lang.*` 被伪造替换；② 避免类重复加载，保证唯一性。

**Q3：准备阶段 `static int a = 10` 时 a 等于几？**
> 等于 0。准备阶段只分配内存并赋**零值**，到初始化阶段执行 `<clinit>` 才赋为 10。但 `static final int b = 20`（常量）在准备阶段就是 20。

**Q4：怎么打破双亲委派？举个例子。** ⭐
> 重写 ClassLoader 的 loadClass（而非 findClass）。经典案例：JDBC 用线程上下文类加载器让 Bootstrap 加载的 `Driver` 接口能用到 classpath 上的驱动实现；Tomcat 的 WebAppClassLoader 优先自加载实现 webapp 隔离。

**Q5：两个类相等的条件？**
> 全限定名相同 **且** 由同一个类加载器加载。不同加载器加载同一个 .class 是两个不同的类。

**Q6：`Class.forName` 和 `ClassLoader.loadClass` 区别？**
> forName 默认会**初始化**类（执行静态块），loadClass 只加载不初始化。JDBC 老写法 `Class.forName("com.mysql.Driver")` 就是靠 forName 触发驱动的静态注册块。

---

## 一句话总结

> 类加载 = **加载→验证→准备(零值)→解析→初始化(`<clinit>`赋真值)**；
> **双亲委派**靠"先问父亲"保证核心类不被篡改、类不重复加载；
> 类的身份 = 全限定名 + 类加载器；静态内部类单例的线程安全就源自 JVM 对 `<clinit>` 的加锁。
