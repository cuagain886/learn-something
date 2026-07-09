package com.example.greet;

import com.example.greet.internal.Helper;   // 同模块内可自由访问 internal 包

// 这个类在被导出的包里 → 是模块对外的公开 API
public class Greeter {
    public String greet(String name) {
        // 内部调用未导出的 Helper：实现细节被模块封装，外部看不见也用不到
        return "Hello from module, " + name + "!\n内部 Helper 经由公开 API 间接工作："
                + Helper.shout(name);
    }
}
