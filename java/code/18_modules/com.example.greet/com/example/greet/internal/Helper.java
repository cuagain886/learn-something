package com.example.greet.internal;

// 这个包没有被 module-info.java 导出（exports）。
// 因此尽管 Helper 是 public，外部模块也【无法】访问它 —— 强封装的体现。
// 它只能被本模块内部（如 Greeter）使用。
public class Helper {
    public static String shout(String s) {
        return s.toUpperCase();
    }
}
