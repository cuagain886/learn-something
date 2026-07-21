package dev.deepjava.jvm;

/** JDK 21。观察主动使用、编译期常量、数组类和 Class.forName(false)。 */
public final class ClassInitializationLab {
    static class Parent {
        static final int COMPILE_TIME_CONSTANT = 42;
        static final Integer RUNTIME_CONSTANT = Integer.valueOf(43);
        static int mutable = trace("Parent.<clinit>", 1);
    }

    static class Child extends Parent {
        static int child = trace("Child.<clinit>", 2);
    }

    private static int trace(String message, int value) {
        System.out.println(message);
        return value;
    }

    public static void main(String[] args) throws Exception {
        System.out.println("compile-time constant=" + Child.COMPILE_TIME_CONSTANT);
        Child[] array = new Child[1];
        System.out.println("array class=" + array.getClass().getName());

        String name = ClassInitializationLab.class.getName() + "$Child";
        Class<?> loaded = Class.forName(name, false, ClassInitializationLab.class.getClassLoader());
        System.out.println("loaded without initialization=" + loaded.getName());

        System.out.println("runtime constant=" + Child.RUNTIME_CONSTANT);
        System.out.println("child field=" + Child.child);
    }
}
