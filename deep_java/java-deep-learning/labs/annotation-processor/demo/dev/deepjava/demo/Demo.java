package dev.deepjava.demo;

import dev.deepjava.processor.GenerateGreeting;

@GenerateGreeting("hello from a generated type")
public final class Demo {
    public static void main(String[] args) {
        String message = DemoGreeting.message();
        if (!message.equals("hello from a generated type")) {
            throw new AssertionError(message);
        }
        System.out.println(message);
    }
}
