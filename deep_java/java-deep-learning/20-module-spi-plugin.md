# 20. JPMS、SPI 与插件架构：可读性、类型隔离和生命周期

> 优先级：A｜难度：★★★★★｜基线：Java 21｜前置：[06 类加载](06-class-loading.md)、[19 反射与增强](19-reflection-proxy-bytecode.md)

## 1. 本章目标

完成后应能区分 ClassLoader namespace 与 JPMS module graph；能写 `requires/exports/opens/uses/provides` 并解释每条的运行时后果；能设计 Tool/Model Provider 插件的共享 API、依赖隔离、版本校验、卸载和安全边界；能诊断 `ClassNotFoundException`、`NoClassDefFoundError`、`IllegalAccessError` 与“同名类不可转换”。

## 2. JPMS 增加了哪一层

Java 9 前，classpath 大体是一个扁平可见空间：JAR 声明依赖但 JVM 不据此构建可靠图，public 类型通常对同 loader 可见代码开放。JPMS 把一组 packages 组织成 named module，并在解析阶段构造 module graph。

访问一个 public 类型至少同时满足：

```text
目标类已由某 ClassLoader 定义
AND 调用者 module reads 目标 module
AND 目标 package exports 给调用者
AND Java 成员访问规则允许
```

反射访问非 public 成员通常再要求 package opens 给调用者。ClassLoader 决定“哪个 Class”；JPMS 决定这些 Class 所属模块之间“谁可读/哪些包可访问”。二者互补，不是 module 取代 loader。

## 3. module-info 的核心指令

```java
module com.example.host {
    requires com.example.api;
    requires transitive com.example.model;
    requires static org.example.annotations;
    exports com.example.host.publicapi;
    opens com.example.host.dto to com.fasterxml.jackson.databind;
    uses com.example.api.ToolProvider;
}
```

- `requires` 建可读边；并不把依赖 module 的所有包公开。
- `requires transitive` 让读取本模块的下游也读取指定依赖，适合公共 API 签名暴露的模型，不应滥用。
- `requires static` 编译期需要、运行时可缺省；代码路径若真正执行仍可能 linkage failure。
- `exports p` 允许其他模块正常访问 p 的 public 类型；可限定 `to` 目标模块。
- `opens p` 允许深反射，不等于正常编译访问；`open module` 打开全部包，封装面过大。
- `uses S` 声明本模块用 ServiceLoader 查找服务 S。
- `provides S with P` 注册本模块内 provider；实现包通常不 export。

`module-info.java` 编译成 `module-info.class`，属于 Class File 的 Module 属性。不要在 JDK 21 实验里只看源码；可用 `java --describe-module`、`jar --describe-module` 和 `javap -v module-info.class` 核验。

## 4. 可读性不等于可访问性

调用方 `requires target` 只使 target readable。若 target 未 `exports internal.pkg`，调用方不能正常链接其 public class。反过来，exports 没有读取边也不够。

qualified exports/opens 能缩小受信任框架集合，但模块名变更会破坏授权；`ALL-UNNAMED` 常由启动参数使用，表示给 classpath 上所有未命名模块开口，范围远大于单个框架。

反射异常的处理顺序：

1. 打印 caller/target `Class.getModule()` 与 loader；
2. `caller.canRead(target)`；
3. `target.isExported(package, caller)` / `isOpen`；
4. 检查普通成员可见性与 Lookup；
5. 最后才考虑 `--add-reads/--add-exports/--add-opens` 临时验证。

启动参数是迁移/运维控制，不应让库在 README 中无限追加而不修 module descriptor。

## 5. named、unnamed 与 automatic module

classpath 中代码属于 unnamed module：读取所有 observable modules，并对其他代码导出/打开自身包的传统视图，但 named module 是否读取它并非任意。module path 上无 `module-info` 的普通 JAR 可成为 automatic module：名称来自 `Automatic-Module-Name` 或文件名推导，读取其他模块并导出自身所有包。

automatic module 适合迁移，不适合稳定 API 依赖文件名推导：版本号、连字符变化会改 module name。库发布者可先设置稳定 `Automatic-Module-Name`，最终提供 descriptor；消费者仍需验证 split package 和传递依赖。

JPMS 不允许同一 resolved layer 中两个 named modules 含同 package 的 split package。classpath 时代把同包分散在多个 JAR 的做法会阻碍模块化。shading/relocation 能消除冲突，但许可证、资源名、反射字符串和 ServiceLoader 文件也要一起处理。

## 6. ServiceLoader 的服务模型

服务接口由稳定 API 模块导出；host 声明 `uses`；provider 模块 `requires api` 并 `provides`，但 host 不应直接 `requires provider`。这样 provider 可替换，模块解析器仍能根据 service binding 把它纳入图。

```text
api module:      exports ToolProvider
host module:     requires api; uses ToolProvider
provider module: requires api; provides ToolProvider with UpperProvider
```

`ServiceLoader` 默认惰性发现/实例化；迭代可能抛 `ServiceConfigurationError`，不能把第三方构造异常当“无 provider”。`stream()` 可先看 `Provider.type()` 再选择并实例化，但读取 type 也会加载/链接相关类。

classpath provider 使用 `META-INF/services/<binary-service-name>`，每行 provider binary name；打 fat JAR 时必须合并而不是让后一个文件覆盖前一个。named module provider 用 `provides`，不靠该资源文件作为主声明。

## 7. 可运行的具名模块 SPI

[jpms-spi](labs/jpms-spi) 包含三个真实模块：

```powershell
cd labs\jpms-spi
.\run.ps1
```

脚本用 `javac --module-source-path` 编译，再以 module path 启动 host。2026-07-20、JDK 21.0.8 实测输出：

```text
JPMS ServiceLoader verified: com.deepjava.plugin.upper
```

host 通过 `ServiceLoader` 得到 `ToolProvider`，调用 `upper` 得 `AGENT`，并断言 provider 实现包未 export。删除 host 的 `uses`，或 provider 的 `provides`，重新编译/运行可观察模块描述符如何阻止隐式偶合。

## 8. SPI 与 ClassLoader 的关系

`ServiceLoader.load(service)` 的具体 loader 选择和调用上下文有关；传统框架常用 Thread Context ClassLoader（TCCL）让父加载的框架发现子 loader 中实现。TCCL 是反向可见性补丁，也是泄漏源：线程池线程若长期持插件 loader 作为 context loader，插件无法卸载。

更可控的插件 host 应显式：

```java
ServiceLoader<ToolProvider> providers = ServiceLoader.load(ToolProvider.class, pluginLoader);
```

或在自定义 ModuleLayer 中 `ServiceLoader.load(layer, service)`。运行插件回调前暂设 TCCL 时，finally 恢复原值；异步任务不能让插件上下文逃逸到公共池。

API type 必须由 host 与 plugin 共同看到同一个定义。若 plugin child-first 地再次加载 `ToolProvider`，实现类虽“implements 同名接口”，仍不能 cast 到 host 接口。父优先至少覆盖 Java/JDK 和共享 API 包；插件私有依赖再 child-first/独立查找。

## 9. ModuleLayer 与插件域

boot layer 包含启动模块。运行时可用 `ModuleFinder` 找插件模块、`Configuration.resolve` 解析图，再 `ModuleLayer.defineModulesWithOneLoader` 或自定义 loader mapping 创建 child layer。

一个 loader 承载 layer 简单但插件互相可见/共享依赖；每模块一个 loader 隔离更强但跨模块类型、资源和启动成本更复杂。真正插件系统常按“插件集合/版本域”建 layer，而不是每个小 provider 单独一层。

ModuleLayer 没有 `close()`。卸载仍依赖：停止所有插件线程/任务 → 注销回调、MBean、driver、日志 appender → 关闭 URLClassLoader/资源 → 清除 host cache/TCCL → 丢弃 layer、loader、Class 的强引用 → 等 GC。模块图只改善封装，不自动管理生命周期。

## 10. 版本冲突与依赖隔离

常见策略：

- **共享依赖**：host 统一版本，内存少、类型一致，但插件受 host 升级约束。
- **插件私有依赖**：每插件 loader 内带版本，隔离冲突，但跨边界只能传 API/JDK 类型或序列化数据。
- **shading**：重定位 package，解决部分 binary-name 冲突；资源/反射/native 仍需验证。
- **进程隔离**：冲突和崩溃边界最强，通过协议通信，代价是 IPC/部署。

API 兼容不只看 semantic version。删除抽象方法显然破坏二进制；给接口增加 abstract 方法会让旧 provider 在调用时失败；增加 default method 较兼容但可能产生默认方法冲突；record/序列化 schema 也需版本协商。

host 加载前应读插件 descriptor：plugin id/version、API range、JDK range、capabilities、依赖和校验摘要。先拒绝不兼容，再执行 provider 构造器；不要让 linkage error 发生到真实请求中。

## 11. 插件生命周期状态机

```text
DISCOVERED → VERIFIED → LOADED → STARTING → ACTIVE
                    \→ REJECTED       ↓
                              QUIESCING → STOPPED → UNLOADED
                                      \→ FAILED
```

关键不变量：只有 ACTIVE 可接新调用；QUIESCING 停止 admission 并等待/取消 in-flight；STOP 必须有 deadline；FAILED provider 不反复在热路径构造；卸载后注册表先发布无该插件的新 snapshot，再回收 loader。

热升级不要原地替换类：加载新版本到新 loader/layer，健康检查，原子切换 routing，排空旧版本，再卸载。旧任务的对象不能传入新版本；持久状态用明确 schema 迁移。

## 12. JPMS 不是安全沙箱

exports/opens 控制 Java 层封装，不限制 CPU、内存、文件、网络、进程或 native code。Security Manager 已走向移除，不能把不可信 Tool 放进同 JVM 后仅靠 module descriptor 宣称安全。

风险级别：

- 受信任内部 provider：同 JVM + 最小 exports/opens + 签名/制品治理；
- 半可信第三方：独立进程、最小环境变量、受限工作目录、网络 allowlist、资源/时间上限；
- 用户任意代码：容器/VM/sandbox，限制进程树、syscall、文件、egress 和凭据，输出有界。

Java Agent 还能重定义别的模块，拥有比普通插件更强能力；必须由部署者显式授权，不让 provider 自行 attach。

## 13. Agent provider 架构

可定义小而稳定的 ports：

- `ToolProvider`：返回 metadata/schema，创建有生命周期的 Tool；
- `ModelProvider`：声明模型、流式/取消能力与限流维度；
- `RetrieverProvider`：索引版本、租户隔离和证据返回契约；
- `MemoryProvider`：读写一致性、删除/TTL 能力；
- `SandboxProvider`：资源 policy、进程句柄和审计事件。

边界对象不携带框架实现类；用 JDK 类型或 API module record，并给事件/schema version。provider 不能获得整个 application context；注入最小 capability（HTTP allowlisted client、metrics facade、workspace handle），便于审计和测试。

对流式返回，插件卸载要能取消 publisher/subscription；host 必须包一层，防止 provider 在 terminal signal 后继续发送。跨 loader exception 只暴露 API 定义错误码，内部异常转为结构化 failure 和脱敏诊断。

## 14. 故障定位矩阵

| 现象 | 常见层 | 检查 |
|---|---|---|
| `ClassNotFoundException` | 显式/反射加载没找到 | loader 搜索路径、binary name、TCCL |
| `NoClassDefFoundError` | 已解析引用在运行时缺定义/初始化失败 | cause、首次初始化日志、依赖 JAR |
| `IllegalAccessError` | linkage 时 JPMS/成员访问失败 | reads/exports 与运行时模块版本 |
| `InaccessibleObjectException` | 深反射未 open | caller/target module、opens |
| `ServiceConfigurationError` | provider 声明/构造/类型错误 | descriptor、public provider factory/ctor、cause |
| `X cannot be cast to X` | 同名类由不同 loader 定义 | 两侧 ClassLoader、API 是否重复打包 |
| 插件无法卸载 | 强引用/线程/native 注册 | heap path to GC root、TCCL、Thread、MBean |

记录 `class.getName()` 不够，日志至少带 module name/version 与 loader identity；但不要把 loader `toString` 当稳定 ID，host 应分配 plugin instance id。

## 15. 常见误区与面试追问

1. **requires 会开放依赖所有包**：readability 与 exports 分开。
2. **exports 等于 opens**：前者正常 public 访问，后者深反射。
3. **automatic module 已完全模块化**：它导出全部包，是迁移桥梁。
4. **ServiceLoader 会自动处理插件卸载**：它会缓存 provider/迭代状态，生命周期仍由 host 管。
5. **同名类就是同类型**：defining loader 是类型身份的一部分。
6. **ModuleLayer.close 可卸载**：没有此 API；靠解除所有强引用和资源。
7. **JPMS 能运行不可信代码**：它不是 OS 资源/权限沙箱。

**Q：为什么 provider 实现包通常不 export？** ServiceLoader 根据 `provides` 实例化，host 只依赖服务接口；隐藏实现能防止消费者静态偶合。

**Q：什么时候用进程隔离？** 插件不可信、有 native/依赖冲突、可能崩溃/泄漏，或需强资源/网络边界时。同 JVM loader 只提供命名与可见性隔离。

- [ ] 能逐条解释 module descriptor。
- [ ] 能区分 reads、exports、opens 和普通 access。
- [ ] 能运行 `uses/provides` 服务实验。
- [ ] 能设计共享 API 的 loader 委派。
- [ ] 能写热升级与排空状态机。
- [ ] 能用 heap root/TCCL 排查卸载失败。

## 16. 延伸阅读

- [Java 21 Module System 工具与规范入口](https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html#standard-options-for-java)
- [ServiceLoader API, Java 21](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ServiceLoader.html)
- [ModuleLayer API, Java 21](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/ModuleLayer.html)
- [JAR 文件规范：Modular JAR](https://docs.oracle.com/en/java/javase/21/docs/specs/jar/jar.html#modular-jar-files)

下一章：[21 Java I/O、NIO 与网络](21-java-io-nio-network.md)。
