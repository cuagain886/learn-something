package dev.deepjava.runtime;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;
import java.lang.invoke.VarHandle;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;

/** JDK 21. Reflection metadata, MethodHandle, VarHandle and JDK proxy in one verifiable lab. */
public final class ReflectionProxyLab {
    @Retention(RetentionPolicy.RUNTIME)
    @Target(ElementType.METHOD)
    @interface Audited { String value(); }

    interface Greeting {
        @Audited("greet")
        String greet(String name);
        default String kind() { return "default"; }
    }

    static final class GreetingTarget implements Greeting {
        @Override public String greet(String name) { return "hello " + name; }
    }

    static final class State {
        volatile int version;
    }

    private ReflectionProxyLab() { }

    public static void main(String[] args) throws Throwable {
        Greeting target = new GreetingTarget();
        Method method = Greeting.class.getMethod("greet", String.class);
        Audited audited = method.getAnnotation(Audited.class);
        assert audited != null && audited.value().equals("greet");
        assert method.invoke(target, "reflection").equals("hello reflection");

        MethodHandle handle = MethodHandles.lookup().findVirtual(
                Greeting.class, "greet", MethodType.methodType(String.class, String.class));
        String handled = (String) handle.invokeExact((Greeting) target, "handle");
        assert handled.equals("hello handle");

        Greeting proxy = (Greeting) Proxy.newProxyInstance(
                Greeting.class.getClassLoader(), new Class<?>[]{Greeting.class},
                (instance, invoked, arguments) -> {
                    long started = System.nanoTime();
                    try {
                        return invoked.invoke(target, arguments);
                    } finally {
                        assert System.nanoTime() >= started;
                    }
                });
        assert proxy.greet("proxy").equals("hello proxy");
        assert proxy.kind().equals("default");
        assert Proxy.isProxyClass(proxy.getClass());

        VarHandle version = MethodHandles.lookup().findVarHandle(State.class, "version", int.class);
        State state = new State();
        assert version.compareAndSet(state, 0, 1);
        assert (int) version.getVolatile(state) == 1;
        System.out.println("reflection, method/var handles and JDK proxy verified: " + proxy.getClass().getName());
    }
}
