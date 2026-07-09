package com.example.app;

import com.example.greet.Greeter;   // 来自 com.example.greet 模块的导出包，可用
// import com.example.greet.internal.Helper;  // ⚠️ 取消注释会编译失败：internal 未被 exports

public class Main {
    public static void main(String[] args) {
        Greeter greeter = new Greeter();
        System.out.println(greeter.greet("Java Modules"));
    }
}
