// 应用模块：声明它依赖问候库模块
module com.example.app {
    // requires：编译期与运行期都需要 com.example.greet。
    // 若缺少这个声明，下面 Main 里 import com.example.greet.Greeter 会编译失败 ——
    // 依赖关系被显式化、可校验，这正是模块系统取代脆弱 classpath 的核心好处。
    requires com.example.greet;
}
