/*
═══════════════════════════════════════════════════════════════════
 19_reflection_proxy —— 反射与动态代理：框架的底层魔法
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. Class 对象：获取方式与运行期类型信息
  2. 反射：读写字段、调用方法、创建实例（绕过编译期约束）
  3. 动态代理 Proxy：运行期"凭空造出"接口实现，拦截方法调用
  4. 这些是 Spring/MyBatis/JUnit/Mock 框架的共同地基

【运行】java 19_reflection_proxy/Main.java
*/

import java.lang.reflect.*;

public class Main {
    public static void main(String[] args) throws Exception {
        // ── 1. 获取 Class 对象的三种方式 ───────────────────
        Class<?> c1 = String.class;                 // ① 类字面量
        Class<?> c2 = "hello".getClass();           // ② 实例.getClass()
        Class<?> c3 = Class.forName("java.lang.String"); // ③ 全限定名(动态加载)
        System.out.println("三者同一个 Class? " + (c1 == c2 && c2 == c3));
        System.out.println("类名: " + c1.getName() + "，简名: " + c1.getSimpleName());

        // ── 2. 反射创建实例 + 调用方法 ─────────────────────
        Class<?> clazz = Account.class;
        // 通过构造器反射创建对象（即使构造器是 private 也能撬开）
        Constructor<?> ctor = clazz.getDeclaredConstructor(String.class, double.class);
        ctor.setAccessible(true);                   // private 构造器：先关闭访问检查
        Object acc = ctor.newInstance("Alice", 100.0);
        // 反射调用方法
        Method deposit = clazz.getDeclaredMethod("deposit", double.class);
        deposit.invoke(acc, 50.0);
        Method getBalance = clazz.getDeclaredMethod("getBalance");
        System.out.println("反射调用后余额: " + getBalance.invoke(acc));

        // ── 3. ⚠️ 反射读写私有字段（破坏封装，谨慎）────────
        Field balanceField = clazz.getDeclaredField("balance");
        balanceField.setAccessible(true);          // 关闭访问检查（私有也能改）
        balanceField.set(acc, 9999.0);             // 直接篡改私有字段
        System.out.println("篡改私有字段后: " + getBalance.invoke(acc));
        // → 这就是为什么"private 不是安全边界"；也是测试框架能注入私有依赖的原理

        // ── 4. 遍历类的结构（IDE/序列化/ORM 都靠这个）──────
        System.out.println("--- Account 的方法 ---");
        for (Method m : clazz.getDeclaredMethods()) {
            System.out.println("  " + Modifier.toString(m.getModifiers())
                    + " " + m.getReturnType().getSimpleName() + " " + m.getName());
        }

        // ── 5. ⭐ 动态代理：运行期生成接口实现，拦截调用 ───
        // 目标：给任意 Service 调用自动加"日志 + 计时"，无需改原代码（AOP 雏形）
        UserService real = new UserServiceImpl();
        UserService proxy = (UserService) Proxy.newProxyInstance(
                real.getClass().getClassLoader(),
                new Class<?>[]{ UserService.class },     // 代理实现哪些接口
                new LoggingHandler(real));               // 所有方法调用都进这个 handler
        // 看起来在直接调用，实际经过了代理的拦截
        System.out.println("代理调用结果: " + proxy.findName(42));
        proxy.deleteUser(42);
    }
}

class Account {
    private final String owner;
    private double balance;
    private Account(String owner, double balance) { this.owner = owner; this.balance = balance; }
    public void deposit(double amount) { balance += amount; }
    public double getBalance() { return balance; }
}

// 被代理的接口
interface UserService {
    String findName(int id);
    void deleteUser(int id);
}

class UserServiceImpl implements UserService {
    @Override public String findName(int id) { return "User-" + id; }
    @Override public void deleteUser(int id) { System.out.println("  [真实逻辑] 删除用户 " + id); }
}

// InvocationHandler：动态代理的核心，所有被代理方法的调用都汇聚到 invoke
class LoggingHandler implements InvocationHandler {
    private final Object target;        // 真实对象
    LoggingHandler(Object target) { this.target = target; }

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
        long start = System.nanoTime();
        System.out.println("→ 调用 " + method.getName()
                + (args == null ? "()" : " " + java.util.Arrays.toString(args)));
        Object result = method.invoke(target, args);    // 转发给真实对象
        System.out.printf("← %s 返回，耗时 %d ns%n", method.getName(), System.nanoTime() - start);
        return result;
    }
}

/*
【反射是什么】
  正常代码是"编译期就确定调用谁"；反射让你在【运行期】根据字符串/Class
  动态地检查类结构、创建对象、调用方法、读写字段 —— 把"类"当数据来操作。

【反射的代价与风险】
  - 慢：比直接调用慢（有访问检查、无法内联优化），热点路径慎用
  - 不安全：setAccessible(true) 能突破 private，破坏封装
  - 不类型安全：错误推迟到运行期（invoke 参数错了运行才炸）
  - 模块系统（第18课）下，跨模块反射需要 opens 授权
  所以：业务代码很少直接写反射；它主要是【框架】用来实现通用机制。

【动态代理 = 反射 + 接口】
  Proxy.newProxyInstance 在运行期合成一个实现了指定接口的类，
  把对接口任意方法的调用都路由到你的 InvocationHandler.invoke。
  于是可以统一插入横切逻辑（日志、事务、权限、缓存、计时）而不改业务代码。
  ⚠️ JDK 动态代理只能代理【接口】；要代理普通类用 CGLIB/ByteBuddy（字节码生成）。

【它们撑起了哪些框架】
  Spring：@Autowired 依赖注入、@Transactional 事务、AOP 切面 —— 反射+动态代理
  MyBatis：你只写 Mapper 接口，运行期动态代理生成实现去执行 SQL
  JUnit：扫描 @Test 注解（第5课）反射调用测试方法
  Jackson/Gson：反射读写字段做序列化
  Mockito：动态生成 mock 对象
  理解这一课，很多框架的"黑魔法"就不再神秘。
*/
