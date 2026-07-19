# 08 · 运行时边界与领域建模 ⭐⭐⭐

> 类型只约束编译器看得到的代码。网络、文件、环境变量、数据库和异常都来自类型系统之外，必须重新建立证据。

---

## 1. `JSON.parse` 后写类型注解不等于验证

```typescript
type User = { id: string; age: number };

const user = JSON.parse(text) as User;
// 没有任何字段检查；age 可能是字符串，user 甚至可能是 null
```

正确的数据流应是：

```text
外部字节/JSON → unknown → 结构验证 → 领域类型 → 业务逻辑
```

先让不可信值保持 `unknown`：

```typescript
const raw: unknown = JSON.parse(text);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function parseUser(value: unknown): User {
    if (!isRecord(value)) throw new Error("user must be an object");
    if (typeof value.id !== "string") throw new Error("user.id must be string");
    if (typeof value.age !== "number" || !Number.isFinite(value.age)) {
        throw new Error("user.age must be a finite number");
    }
    return { id: value.id, age: value.age };
}
```

类型谓词适合“是/否”判断；需要错误路径、默认值、转换或错误聚合时，解析函数或 schema 库更合适。

---

## 2. 验证类型和领域类型不要混为一谈

“是字符串”不代表“是合法用户 ID”：“是数字”也不代表“是合理年龄”。验证至少有三层：

1. **语法层**：值是不是对象、字符串、数字。
2. **结构层**：必要字段、数组元素、嵌套对象是否存在且类型正确。
3. **语义层**：ID 格式、数值范围、跨字段不变量是否成立。

```typescript
declare const userIdBrand: unique symbol;
type UserId = string & { readonly [userIdBrand]: true };

function parseUserId(value: unknown): UserId {
    if (typeof value !== "string" || !/^usr_[a-z0-9]+$/.test(value)) {
        throw new Error("invalid user id");
    }
    return value as UserId; // 断言集中在完成运行时证明之后
}
```

品牌类型不能替代验证；它只是让验证结果在程序内部不再和普通字符串混用。

---

## 3. 用可辨识联合建模状态，而不是布尔组合

```typescript
type BadState<T> = {
    loading: boolean;
    data?: T;
    error?: Error;
};
```

这个模型允许 `loading: true` 同时存在 `data` 和 `error`，制造大量非法状态。改为状态机：

```typescript
type AsyncState<T> =
    | { status: "idle" }
    | { status: "loading"; requestId: string }
    | { status: "success"; data: T }
    | { status: "failure"; error: AppError };
```

让每个分支只携带该状态合法的数据。渲染与业务分支会自然收窄，新增状态时穷尽检查能指出所有遗漏。

---

## 4. 让非法状态不可表示

典型订单若写成一堆可选字段：

```typescript
type Order = {
    paidAt?: Date;
    cancelledAt?: Date;
    shippedAt?: Date;
};
```

类型允许“既取消又发货”。更准确的模型：

```typescript
type Order =
    | { status: "created" }
    | { status: "paid"; paidAt: Date }
    | { status: "cancelled"; cancelledAt: Date; reason: string }
    | { status: "shipped"; paidAt: Date; shippedAt: Date; trackingNo: string };
```

但静态模型仍不能表达所有跨时间规则，例如 `shippedAt >= paidAt`。这类不变量需要构造函数或领域服务在运行时保证。

---

## 5. 构造函数是建立不变量的边界

```typescript
type Percentage = number & { readonly __brand: "Percentage" };

function percentage(value: number): Percentage {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
        throw new RangeError("percentage must be between 0 and 100");
    }
    return value as Percentage;
}
```

对外不要暴露“任何 number 都能成为 Percentage”的断言入口。品牌类型的价值依赖于构造路径受控；如果到处 `as Percentage`，品牌只剩装饰。

---

## 6. 错误也是领域数据

`catch` 变量在严格配置中应按 `unknown` 处理，因为 JavaScript 可以抛出任何值：

```typescript
try {
    await execute();
} catch (error: unknown) {
    if (error instanceof Error) {
        console.error(error.message);
    } else {
        console.error("non-Error thrown", error);
    }
}
```

对于预期失败，用结果类型往往比抛异常更明确：

```typescript
type Result<T, E> =
    | { ok: true; value: T }
    | { ok: false; error: E };

type LoginError =
    | { code: "INVALID_CREDENTIALS" }
    | { code: "LOCKED"; retryAt: Date }
    | { code: "NETWORK"; cause: unknown };
```

选择规则：

- 调用方被期望处理的业务失败：`Result` 或可辨识联合。
- 违反编程前提、资源耗尽、不可恢复失败：异常。
- 不要把所有异常强断言成某个 HTTP 客户端错误。

---

## 7. 输入 DTO、领域对象、输出 DTO 应分层

```typescript
type UserResponseDto = {
    id: string;
    created_at: string;
};

type User = {
    id: UserId;
    createdAt: Date;
};

function toUser(dto: UserResponseDto): User {
    const createdAt = new Date(dto.created_at);
    if (Number.isNaN(createdAt.getTime())) throw new Error("invalid created_at");
    return { id: parseUserId(dto.id), createdAt };
}
```

不要让后端传输格式渗透到整个前端，也不要假设 `Date` 能直接通过 JSON 往返。边界映射层承担命名转换、日期解析、版本兼容和默认值策略。

---

## 8. 可选、可空、缺失表达不同业务语义

```typescript
type ProfilePatch = {
    displayName?: string;       // 缺失：不修改
    avatarUrl?: string | null;  // null：明确删除头像
};
```

必须结合序列化行为设计：

- `JSON.stringify` 会忽略对象属性中的 `undefined`。
- `null` 会被保留。
- 表单空字符串通常需要在边界转成 `null` 或视为校验错误。

因此 `?`、`| undefined`、`| null` 不是个人风格，它们是协议设计。

---

## 9. 版本化外部协议

```typescript
type EventV1 = { version: 1; userId: string };
type EventV2 = { version: 2; actor: { id: string }; occurredAt: string };
type WireEvent = EventV1 | EventV2;

function normalizeEvent(raw: WireEvent): EventV2 {
    switch (raw.version) {
        case 1:
            return {
                version: 2,
                actor: { id: raw.userId },
                occurredAt: new Date(0).toISOString(),
            };
        case 2:
            return raw;
    }
}
```

业务核心只处理规范化后的最新模型；兼容旧版本的复杂度停留在入口。版本字段同时是运行时路由依据和编译期判别字段。

---

## 10. Schema 值同时服务三种契约，但三者不等价

一个适合 Agent 工具边界的 Schema 值通常承担三项职责：

```text
Schema value
  ├─ safeParse(unknown) -> 运行时 Output / ValidationIssue[]
  ├─ Infer<typeof schema> -> TypeScript 静态 Output
  └─ jsonSchema -> 模型或远端消费者看到的 wire input 描述
```

必须强调：JSON Schema 描述**输入线格式**，`Infer` 得到的可能是 transform/refine 后的领域输出。例如输入是 ISO 字符串，输出可以是 `Date`；输入是普通 string，输出可以是 `UserId` 品牌。模型侧 schema 不知道 TypeScript 的 unique-symbol brand，也不会执行 trim、数据库查询或跨字段业务校验。

因此服务端 parser 始终是最终权威；把 JSON Schema 发给模型只能提升生成正确率，不能取消 unknown 边界。

### unknown key policy 是授权面的一部分

| 策略 | 行为 | 常见用途 |
|---|---|---|
| `strict` | 未声明字段直接报错 | Agent 工具参数、写 API、权限敏感入口 |
| `strip` | 只构造白名单字段 | DTO 归一化、兼容旧客户端 |
| `passthrough` | 保留未知字段 | 明确需要扩展字段的代理层 |

`Omit<Input, "isAdmin">` 只改变静态视图，不会删除运行时对象里的 `isAdmin`。真正的白名单输出必须由 parser 新建对象。对动态键写入还应避免触发 `Object.prototype.__proto__` setter，可用 `Object.defineProperty` 或 null-prototype 字典，并在边界测试 prototype-pollution payload。

### 缺失必须用 own property 判断

```typescript
Object.hasOwn(input, key)
```

`key in input` 会沿原型链查找；攻击者或错误 fixture 可以让继承属性冒充必填字段。optional schema 也应在对象组合器层决定“键可以缺失”，而不是无条件把缺失字段写成 `undefined`，否则会破坏 `exactOptionalPropertyTypes` 所表达的协议差异。

### ValidationIssue 是可观测协议，不应泄漏原始数据

错误至少需要稳定 code、结构化 path 和可读 message。路径使用 JSON Pointer 等标准形式后，可直接映射到表单字段、tool argument 和日志聚合键。错误对象默认只记录 `string/array/object/null` 等安全摘要；密码、token、完整 prompt 和个人数据不应因为验证失败被复制进日志。

可运行实现与攻击性 fixture 见：

- [Schema 内核](../code/src/17-schema.ts)
- [unknown、strict/strip、品牌与 JSON Schema 实验](../code/src/17-runtime-validation.ts)

---

## 11. 边界设计检查清单

- `JSON.parse`、环境变量、存储读取结果先视为 `unknown`。
- 验证包含语法、结构、语义三层，而非只检查 `typeof`。
- 品牌值只能通过验证后的构造函数产生。
- 用可辨识联合消除布尔组合造成的非法状态。
- 区分传输 DTO、领域模型和输出 DTO。
- 明确缺失、`undefined`、`null`、空字符串的协议语义。
- 预期业务失败进入返回类型；未知异常保留 `unknown` 原因链。
- 多版本协议在边界归一化，核心逻辑只接收一种模型。

---

## 一句话总结

TypeScript 的安全边界止于编译器可见代码。真正可靠的系统会从 `unknown` 开始验证，在构造时建立领域不变量，并用可辨识联合让非法状态尽量无法表达。
