package dev.deepjava.agent;

import java.lang.reflect.Method;
import net.bytebuddy.ByteBuddy;
import net.bytebuddy.implementation.MethodDelegation;
import net.bytebuddy.implementation.bind.annotation.AllArguments;
import net.bytebuddy.implementation.bind.annotation.Origin;
import net.bytebuddy.implementation.bind.annotation.RuntimeType;
import net.bytebuddy.implementation.bind.annotation.SuperCall;
import java.util.concurrent.Callable;
import static net.bytebuddy.matcher.ElementMatchers.named;

public final class ByteBuddyProxyLab {
    public static final class Interceptor {
        @RuntimeType
        public static Object intercept(@Origin Method method,
                                       @AllArguments Object[] arguments,
                                       @SuperCall Callable<?> original) throws Exception {
            Object result = original.call();
            return method.getName() + ":" + result + ":args=" + arguments.length;
        }
    }

    private ByteBuddyProxyLab() { }

    public static void main(String[] args) throws Exception {
        Class<? extends DemoService> proxyType = new ByteBuddy()
                .subclass(DemoService.class)
                .method(named("work"))
                .intercept(MethodDelegation.to(Interceptor.class))
                .make()
                .load(ByteBuddyProxyLab.class.getClassLoader())
                .getLoaded();
        DemoService proxy = proxyType.getDeclaredConstructor().newInstance();
        assert proxy.work("proxy").equals("work:PROXY:args=1");
        System.out.println("Byte Buddy subclass proxy verified: " + proxyType.getName());
    }
}
