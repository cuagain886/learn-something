package dev.deepjava.layout;

import org.openjdk.jol.info.ClassLayout;
import org.openjdk.jol.vm.VM;

/** JDK 21 + JOL 0.17。输出只描述当前进程配置，不能当成所有 JVM 的固定布局。 */
public final class LayoutLab {
    static final class Empty { }

    static final class MixedFields {
        byte tag;
        long sequence;
        Object payload;
        int retries;
        boolean completed;
    }

    private LayoutLab() {
    }

    public static void main(String[] args) {
        System.out.println(VM.current().details());
        print("empty object", new Empty());
        print("mixed fields", new MixedFields());
        print("int[3]", new int[3]);
        print("Object[3]", new Object[3]);
        Object monitor = new Object();
        print("monitor before synchronized", monitor);
        synchronized (monitor) {
            print("monitor while synchronized", monitor);
        }
        int identityHash = System.identityHashCode(monitor);
        System.out.println("identityHash=0x" + Integer.toHexString(identityHash));
        print("monitor after identity hash", monitor);
    }

    private static void print(String title, Object value) {
        System.out.println("=== " + title + " ===");
        System.out.println(ClassLayout.parseInstance(value).toPrintable());
    }
}
