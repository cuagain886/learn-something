# 20 · 测试与构建：JUnit 5 + Maven/Gradle

前 19 课用单文件 `java Xxx.java` 即点即跑。真实工程靠**构建工具**（Maven/Gradle）管理依赖、编译、测试、打包。本课介绍标准工程结构与单元测试。

## 标准 Maven 工程目录（约定优于配置）

```
20_testing/
├── pom.xml                              ← Maven 配置（依赖、插件、Java 版本）
└── src/
    ├── main/java/calc/Calculator.java   ← 业务代码
    └── test/java/calc/CalculatorTest.java ← 测试代码（与被测类同包，便于访问）
```

> Gradle 的目录结构相同，只是配置文件换成 `build.gradle(.kts)`。

## 运行测试

```powershell
# Maven
mvn test            # 编译并运行所有测试
mvn clean package   # 清理 + 测试 + 打成 jar

# Gradle
gradle test
```

> 本目录提供了 `pom.xml` 和示例代码/测试。需要本机装有 Maven（`mvn -v` 验证）。
> 没装 Maven 也没关系——重点是看懂 `CalculatorTest.java` 里 JUnit 5 的写法。

## JUnit 5 核心注解与断言

| 注解 | 作用 |
|------|------|
| `@Test` | 标记一个测试方法 |
| `@BeforeEach` / `@AfterEach` | 每个测试前/后执行（准备/清理） |
| `@BeforeAll` / `@AfterAll` | 所有测试前/后执行一次（须 static） |
| `@DisplayName("…")` | 给测试起可读名字 |
| `@ParameterizedTest` + `@ValueSource`/`@CsvSource` | 一个测试跑多组数据 |
| `@Disabled` | 临时跳过 |
| `@Nested` | 嵌套测试类，组织相关用例 |

常用断言（`org.junit.jupiter.api.Assertions`）：

```java
assertEquals(expected, actual);          // 相等
assertTrue(cond);  assertFalse(cond);    // 布尔
assertNull / assertNotNull               // 空判断
assertThrows(Ex.class, () -> ...);       // 断言抛异常
assertAll(() -> ..., () -> ...);         // 一次报告多个断言
assertTimeout(Duration, () -> ...);      // 超时
```

## 测试理念（务必内化）

- **测试金字塔**：大量**单元测试**（快、隔离）+ 适量**集成测试** + 少量**端到端测试**。
  越往上越慢越脆，别倒过来。
- **F.I.R.S.T 原则**：Fast 快、Independent 互相独立、Repeatable 可重复、
  Self-validating 自动判定通过/失败、Timely 及时编写。
- **AAA 结构**：Arrange（准备）→ Act（执行）→ Assert（断言），一个测试只验一件事。
- **测行为，别测实现**：断言"输入→输出"的契约，而非内部私有细节，否则重构即崩。
- 现代生态搭配：**JUnit 5**（框架）+ **AssertJ**（流式断言 `assertThat(x).isEqualTo(y)`）
  + **Mockito**（mock 依赖）。

## 与前面课程的关系

第 5 课我们用注解 + 反射手写过一个"迷你测试框架"——JUnit 正是这个思路的工业级实现：
扫描 `@Test`（第5课）→ 反射实例化与调用（第19课）→ 捕获断言异常判定结果（第4课）。
学完这一课，你应当能把前面所有知识点用测试串起来验证。
