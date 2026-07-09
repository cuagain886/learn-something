// 模块描述符：放在模块根目录，声明这个模块的"对外契约"
module com.example.greet {
    // 只导出 com.example.greet 包 —— 它的 public 类型才对外可见。
    // 注意：com.example.greet.internal 没有被导出，
    //       所以外部模块（即使用反射）也访问不到 internal.Helper —— 这就是强封装。
    exports com.example.greet;
}
