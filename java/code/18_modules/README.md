# 18 · 模块系统 JPMS（Java Platform Module System，Java 9+）

模块是比"包"更大的封装单位。本课用两个模块演示：`com.example.greet`（库）被 `com.example.app`（应用）依赖。

## 目录结构

```
18_modules/
├── com.example.greet/                  ← 模块 1：问候库
│   ├── module-info.java                ← 模块描述符：导出了什么
│   └── com/example/greet/
│       ├── Greeter.java                ← exported（对外公开）
│       └── internal/Helper.java        ← 未 export（强封装，外部访问不到）
└── com.example.app/                    ← 模块 2：应用
    ├── module-info.java                ← 声明 requires com.example.greet
    └── com/example/app/Main.java
```

## 编译与运行（在本目录 `18_modules/` 下执行）

```powershell
# 1) 编译两个模块到 out/（--module-source-path 指明多模块源码布局）
javac -d out --module-source-path "." `
  $(Get-ChildItem -Recurse -Filter *.java | ForEach-Object { $_.FullName })

# 等价的 bash 写法：
#   javac -d out --module-source-path . $(find . -name "*.java")

# 2) 以模块方式运行（-p 模块路径，-m 模块/主类）
java -p out -m com.example.app/com.example.app.Main
```

预期输出：
```
Hello from module, Java Modules!
内部 Helper 经由公开 API 间接工作：HELPER
```

## 核心概念

### `module-info.java` 指令

| 指令 | 含义 |
|------|------|
| `module 名字 { }` | 声明一个模块（名字通常用反向域名，与目录同名） |
| `requires X;` | 依赖模块 X（编译期 + 运行期都需要） |
| `requires transitive X;` | 依赖 X，且把 X 也"传递"给依赖我的人 |
| `exports p;` | 公开包 p，其他模块可访问其 public 类型 |
| `exports p to M;` | 只对模块 M 公开（限定导出） |
| `opens p;` | 允许对包 p 做**深度反射**（框架如 Spring/Jackson 需要） |
| `uses / provides ... with` | 服务接口的 SPI 装配 |

### 强封装（Strong Encapsulation）—— 模块化最大的价值

- **没有 `exports` 的包，外部模块根本访问不到**，连反射都不行（除非 `opens`）。
  这比 `public/private` 更强：以前 `public` 类哪怕在"内部包"里也能被任何人调用，
  模块系统终于能真正隐藏实现细节（本例的 `internal.Helper` 就对外不可见）。
- `requires` 让依赖关系**显式化、可校验**：缺依赖在启动期（甚至编译期）就报错，
  而不是运行到一半 `NoClassDefFoundError`。

### 为什么引入模块系统

1. **可靠配置**：用 `requires` 取代脆弱易错的 classpath，依赖缺失尽早暴露
2. **强封装**：隐藏内部实现包，只暴露稳定 API，杜绝外部依赖你的内部类
3. **可伸缩平台**：JDK 自身被拆成约几十个模块（`java.base`、`java.sql`…），
   可用 `jlink` 裁剪出只含所需模块的最小运行时镜像（利于容器/嵌入式）

### 实践现状（要诚实告诉你）

- 模块系统对**应用开发者**不是必需品：大量项目仍跑在 classpath 上，照常工作。
- 它对**库/框架作者**和**需要精简运行时**（jlink、GraalVM、容器镜像）的场景价值最大。
- 面试常考"模块系统解决什么问题""exports vs opens 区别"，理解概念即可，
  不必强行在每个项目里启用。
