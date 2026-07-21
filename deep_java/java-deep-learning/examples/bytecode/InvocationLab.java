package dev.deepjava.bytecode;

import java.util.function.IntUnaryOperator;

/** JDK 21。使用 javap -c -v -p 观察五种 invoke 指令、switch 与 monitor。 */
public class InvocationLab {
    interface Operation {
        int apply(int value);
    }

    static class Parent {
        int virtualCall(int value) {
            return value + 1;
        }
    }

    static final class Child extends Parent implements Operation {
        @Override
        int virtualCall(int value) {
            return super.virtualCall(value) * 2;
        }

        @Override
        public int apply(int value) {
            return virtualCall(value);
        }
    }

    private static int privateStatic(int value) {
        return value - 1;
    }

    static int callVirtual(Parent target, int value) {
        return target.virtualCall(value);
    }

    static int callInterface(Operation target, int value) {
        return target.apply(value);
    }

    static IntUnaryOperator callDynamic(int captured) {
        return value -> privateStatic(value) + captured;
    }

    static int denseSwitch(int value) {
        return switch (value) {
            case 1 -> 10;
            case 2 -> 20;
            case 3 -> 30;
            default -> -1;
        };
    }

    static int sparseSwitch(int value) {
        return switch (value) {
            case -100 -> 1;
            case 7 -> 2;
            case 10_000 -> 3;
            default -> -1;
        };
    }

    static int guardedIncrement(Object monitor, int[] cell) {
        synchronized (monitor) {
            return ++cell[0];
        }
    }

    public static void main(String[] args) {
        Child child = new Child();
        assert callVirtual(child, 2) == 6;
        assert callInterface(child, 2) == 6;
        assert callDynamic(4).applyAsInt(3) == 6;
        assert denseSwitch(2) == 20;
        assert sparseSwitch(10_000) == 3;
        assert guardedIncrement(new Object(), new int[1]) == 1;
        System.out.println("invocation bytecode sample verified");
    }
}
