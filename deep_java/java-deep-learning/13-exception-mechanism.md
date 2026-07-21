# 13｜异常机制：异常表、栈展开与“结果未知”错误语义

> 优先级：A（Agent 失败语义为 S）｜难度：★★★★｜基线：Java/HotSpot 21｜前置：[05](05-class-file-and-bytecode.md)

## 1. 本章目标

能解释 checked/unchecked/Error 的类型与契约边界，沿 exception table 推导 handler 与栈展开，说明 finally/TWR/suppressed；能区分错误分类、重试性和操作结果，正确传播中断与 cause；能测量异常创建/抛出成本而不把 Fast Throw 当保证。

## 2. Throwable 层次不是业务错误模型

```text
Throwable
 ├─ Error                 VM/链接/资源等严重问题，通常不作为业务恢复分支
 └─ Exception
     ├─ RuntimeException  unchecked
     └─ other Exception   checked
```

checked 只表示 javac 要求 catch 或 `throws`，不表示一定可恢复；unchecked 也不等于程序员 bug。`IOException` 可能不可重试，`IllegalStateException` 可能来自瞬时错误包装。业务必须单独表达：category、retryable、effect status、remote id、deadline、cause。

一般不捕获 `Throwable`：会吞掉 `OutOfMemoryError/StackOverflowError/LinkageError`。边界线程可 catch 用于记录和受控终止，但不承诺进程状态仍可服务。

## 3. `throws` 是编译契约，不是 Class 执行门

方法可抛任何 unchecked Throwable；checked exception 由编译器做静态检查。Class 文件 `Exceptions` 属性记录声明，JVM `athrow` 不检查“是否列在 throws”。因此反射/字节码生成能在没有声明处传播 checked throwable，调用方最终仍按运行异常控制流处理。

API 的 checked choice 是 source compatibility 设计：新增 checked exception 会破坏源码调用方；删除/改层次也可能改变 catch 可达性。跨模块错误常用稳定 exception + error code/result type，避免暴露所有第三方异常。

## 4. `athrow` 与 exception table

执行 `athrow` 时栈顶必须是 Throwable reference；若为 null，JVM 抛 NPE。当前 frame 按抛出 PC 查 `Code.exception_table`：

```text
from <= pc < to && thrown is assignable to catch_type
    → clear operand stack
    → push thrown
    → pc = handler
没有匹配 → abrupt completion，弹 frame，在 caller 抛出点继续查
```

catch 顺序由表顺序/源码可达性约束。`catch_type=0` 表示 catch-all，常用于 finally/monitor cleanup。展开会执行各层生成的 cleanup handler，但不会自动回滚数据库、撤销 HTTP 或杀子进程。

## 5. 栈轨迹为何昂贵

`new Throwable` 默认通过 `fillInStackTrace` 捕获当前栈的 VM 信息，随后 `getStackTrace/printStackTrace` 物化/格式化 StackTraceElement。深栈、高 QPS 用异常做分支会消耗 CPU、分配与日志 I/O；同一异常跨线程复用又会给出错误现场且有并发问题。

优化顺序：

1. 不用异常表示常见 miss/校验分支；
2. 只在边界记录一次，保留 cause 与结构字段；
3. 对可预期高频错误用 result/sealed outcome；
4. 确有证据时才考虑无栈异常，并接受诊断损失。

HotSpot 的 `OmitStackTraceInFastThrow` 可对某些热点隐式异常省略轨迹，是实现 heuristic、异常种类/编译状态相关，不能依赖为 API 行为。诊断时可用 `-XX:-OmitStackTraceInFastThrow`（目标 JVM 支持时）做对照。

## 6. finally 的真实控制流

javac 不再使用旧 `jsr/ret` 子例程，通常复制/重组 finally 代码到正常和异常出口。危险：finally 中 `return/throw` 覆盖原返回或异常：

```java
try { throw new IOException("primary"); }
finally { throw new IllegalStateException("cleanup"); }
// primary 只可能作为手工 cause 保存，否则丢失
```

规则：finally 做有界、幂等 cleanup，不 return；cleanup 失败应按明确优先级保留 primary。

`System.exit`、进程崩溃、kill、硬件故障时 finally 不保证运行，所以持久化一致性需要事务/outbox/recovery，不靠 finally。

## 7. try-with-resources 与 suppressed

TWR 的不变量：资源初始化成功后才进入关闭集合；多个资源逆声明顺序 close；body 为 primary，close failure 进入 primary 的 suppressed；若 body 成功而 close 失败，close failure 成为主异常。

[DesugaringLab.java](examples/compiler/DesugaringLab.java) 中 body 抛 `body:5`，close 抛 `close:agent`，断言：

```text
expected.getMessage() == body:5
expected.getSuppressed()[0].getMessage() == close:agent
```

```powershell
javap -classpath build\classes -c -v -p dev.deepjava.compiler.DesugaringLab
```

观察 nested exception table 与 `Throwable.addSuppressed`。日志只打印 `getMessage` 会丢 suppressed；标准 stack trace 会打印，结构化 error serializer 需显式包含且限制深度/数量防放大。

资源变量从 Java 9 起可用 effectively final 外部变量，但 ownership 仍要清楚：谁创建谁关闭，池化连接的 close 常是归还池而非关物理连接。

## 8. 多 catch、精确 rethrow 与异常透明

multi-catch `catch (A | B e)` 不创建共同包装类型，参数隐式 final-ish 以保持类型安全。编译器可根据 flow 做 more precise rethrow：catch 到较宽类型但只可能来源于若干具体 checked exceptions，`throws` 可保持具体集合。

包装异常应：

```java
throw new ToolExecutionException(toolId, effectStatus, cause);
```

而不是只拼 `cause.getMessage()`。丢 cause 会失去 stack/类型/suppressed；无限包装会让日志巨大，应在架构边界转换一次。

## 9. 中断是取消协议，不是普通失败

阻塞操作抛 `InterruptedException` 时通常清除 interrupt status。若当前层不能完成取消，应恢复标志并退出/传播：

```java
try {
    queue.take();
} catch (InterruptedException cancelled) {
    Thread.currentThread().interrupt();
    throw new AgentCancelledException(cancelled);
}
```

不能无脑把所有 InterruptedException 标 retryable；它通常表示上层不再需要结果。若方法声明允许，直接 `throws InterruptedException` 比包装更透明。取消后还要关闭 HTTP body、释放 permit、终止子进程树，异常本身不完成资源回收。

## 10. 错误分类的三个正交维度

```text
cause category: VALIDATION / AUTH / RATE_LIMIT / TIMEOUT / DEPENDENCY / BUG / RESOURCE
retry decision: NEVER / SAME_REQUEST / AFTER_DELAY / DIFFERENT_ROUTE / MANUAL
effect status: NOT_STARTED / NOT_COMMITTED / COMMITTED / UNKNOWN
```

一个 `SocketTimeoutException` 只描述本地等待超时：请求可能未发送、服务端正在执行、已提交但响应丢失。retry 必须结合 operation idempotency/effect status/reconciliation，而不是 `instanceof IOException`。

模型流已发 token 后失败也不同于首 token 前失败：透明重试会产生重复前缀或第二份副作用。错误携带 `responseStarted/lastSequence/providerRequestId`。

## 11. Spring/HTTP 边界

- Controller advice 把 domain failure 映射 HTTP status 与稳定 machine-readable code；不把 stack trace 发客户端。
- 4xx 并非全不可重试：408/409/429 取决契约；5xx 也非全可重试。
- Spring transaction 默认 rollback 规则与 exception type 相关；catch 后不重新抛可能提交，跨异步线程上下文不自动传播。
- 日志、metric、trace 各记录一次：log 证据，metric 聚合，trace 因果；每层重复打印同 stack 会放大 I/O。

## 12. Agent 工作流的部分失败

并行 tool 调用需要 join policy：ALL（任一失败取消其余）、BEST_EFFORT（收集成功+错误）、QUORUM、deadline best-so-far。不要用第一个 Future 异常直接覆盖已完成副作用。

checkpoint 应存：step 状态、attempt、effect status、idempotency key、remote id、error envelope。恢复时：

- NOT_STARTED 可重试；
- COMMITTED 读取/复用结果；
- UNKNOWN 先 query/reconcile，不能盲重试；
- CANCELLED 不被后台 retry scheduler 复活。

## 13. 性能实验方法

错误基准：在同一方法循环 throw/catch，JIT 可能 Fast Throw/优化，且没 fork/消费。正确 JMH 至少分：

- create only；
- throw/catch new exception；
- preallocated exception（仅用于分解成本，不作为推荐）；
- result code baseline；
- stack depth 参数；
- `-XX:-OmitStackTraceInFastThrow` 对照。

报告 alloc/op、p50/尾部、JDK/flags；不同异常 message/stack depth 不可直接比较。业务决策应先看异常频率：低频真正异常优先可诊断性。

## 14. 常见错误与排障

| 现象 | 根因 | 修复 |
|---|---|---|
| 原始异常丢失 | 包装没传 cause/finally 覆盖 | 保留 cause/suppressed，不在 finally return |
| 任务取消后继续跑 | 吞 InterruptedException | 恢复标志、传播、清理子资源 |
| timeout 重试重复扣款/发信 | 把 timeout 当 NOT_STARTED | idempotency key + effect reconciliation |
| 日志 CPU/磁盘高 | 高频异常与多层 stack logging | 边界一次记录、结构聚合、修正常见控制流 |
| TWR 只看到 close 错 | 手写 cleanup 覆盖 primary | 使用 TWR/正确 suppressed |
| 同错误被标 500 | domain/system/transport 混为一类 | stable error algebra + mapping test |

排障时保存完整 exception chain、suppressed、线程、operation ids 和第一次失败；后续 `NoClassDefFoundError` 可能只是 `<clinit>` 首次异常的结果。

## 15. 源码与字节码关键路径

- `Throwable`：构造、cause、suppressed、stack trace 的 lazy/materialize 边界。
- `FutureTask.report/setException/cancel`：异常怎样进入异步结果。
- `CompletableFuture.encodeThrowable` 等路径需固定 JDK tag，不把私有名当 API。
- `DesugaringLab.useResource` 的 exception table/`addSuppressed` 是 javac 21 证据。

## 16. 实验任务

1. 三资源 TWR：body + 每个 close 都失败，预测 suppressed 顺序再运行。
2. finally return 覆盖异常，反汇编并改成安全 cleanup。
3. 构造 20/200 层 stack 的 JMH，比较 create/throw/log 分量。
4. 模拟远程 effect committed 后响应丢失，证明按 exception type 重试会重复。
5. 中断等待队列/HTTP/子进程，验收线程退出、permit 归还、进程树为空。

## 17. 面试题与检查清单

**Q：checked 与 unchecked 本质区别？** javac catch/throws 约束；运行时都由 Throwable/exception table/athrow 处理，不直接代表可恢复性。

**Q：TWR 两处失败保留谁？** body 为 primary，close 进入 suppressed；body 成功则 close 可成为 primary，资源逆序关闭。

**Q：异常为什么慢？** stack capture/materialization、对象分配、控制流和日志；频率/深度/JIT 决定，不能只说“throw 很慢”。

- [ ] 能沿 exception table 解释栈展开。
- [ ] 包装保留 cause/suppressed 与结构字段。
- [ ] 中断不被吞，取消能回收外部资源。
- [ ] retry decision 与 effect status 分开。
- [ ] 不 catch Throwable 后继续普通服务。

## 18. 延伸阅读

- [JLS 11：Exceptions](https://docs.oracle.com/javase/specs/jls/se21/html/jls-11.html)
- [JVMS 2.10：Exceptions](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-2.html#jvms-2.10)
- [JVMS `athrow`](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-6.html#jvms-6.5.athrow)
- [Throwable API](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Throwable.html)

下一章：[14-collections.md](14-collections.md)
