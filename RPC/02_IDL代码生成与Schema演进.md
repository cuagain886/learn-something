# 02｜IDL、代码生成与 Schema 演进：契约如何跨版本继续成立

> IDL 不是“方便生成几个类”的语法糖。它同时决定线上字段身份、方法路由、生成 API、反射元数据和兼容性边界。一次错误的字段复用，可能让旧数据在多年后被静默解释成另一种含义。

## 1. IDL 是可执行契约，不是接口注释

以 Protobuf/gRPC 为例：

```proto
syntax = "proto3";

package order.v1;

service OrderService {
  rpc CreateOrder(CreateOrderRequest) returns (CreateOrderResponse);
}

message CreateOrderRequest {
  string idempotency_key = 1;
  string customer_id = 2;
  repeated Item items = 3;
}
```

这段 IDL 至少参与六件事：

1. **线上身份**：字段号 `1/2/3` 进入 Protobuf 二进制 tag；字段名通常不进入二进制。
2. **方法路由**：gRPC 默认路径由包名、服务名和方法名组成，例如 `/order.v1.OrderService/CreateOrder`。
3. **静态 API**：为 Java、Go、Python、TypeScript 等生成 message、builder、client stub 和 server interface。
4. **运行时解析**：生成代码调用 Protobuf runtime 编解码字段，处理未知字段和默认值。
5. **动态反射**：descriptor 描述 message、field、enum、service 和 method，可用于 reflection、网关和通用客户端。
6. **兼容性检查**：CI 对比当前 schema 与基线，识别字段号复用、类型变化和方法删除。

因此 Schema 演进不是编辑文本，而是在同时修改：

```text
wire contract
  + generated source API
  + runtime behavior
  + stored data interpretation
  + network method identity
  + deployment order
```

---

## 2. 从 `.proto` 到一次调用：编译器流水线

### 2.1 前端：解析和符号解析

```text
.proto source
  → lexer/parser
  → AST
  → import resolution
  → package/type/name binding
  → semantic validation
```

编译器要验证：

- 字段号在 message 内唯一且不落入禁止区间；
- 类型引用能在当前文件、package 或 import 中解析；
- enum、oneof、map、service method 的语法和约束有效；
- reserved name/number 没有被再次使用；
- import 图不存在无法处理的定义问题。

### 2.2 中间表示：Descriptor

Protobuf 自己用 `descriptor.proto` 描述 IDL。一个 `.proto` 可转为 `FileDescriptorProto`，多个文件组成 `FileDescriptorSet`：

```text
FileDescriptorSet
└── FileDescriptorProto
    ├── package / dependency / options
    ├── DescriptorProto             # message
    │   ├── FieldDescriptorProto
    │   ├── OneofDescriptorProto
    │   └── nested_type / enum_type
    ├── EnumDescriptorProto
    └── ServiceDescriptorProto
        └── MethodDescriptorProto
```

descriptor 是机器可读契约，价值远大于“反射”：

- codegen plugin 的稳定输入；
- schema registry 中的版本制品；
- `grpcurl`/server reflection 动态发现服务；
- 网关根据 method descriptor 做 JSON↔Protobuf 转换；
- CI 对 descriptor graph 做 breaking-change 检查；
- 测试工具动态构造 message，而不依赖业务生成类。

原始 Protobuf payload 不自描述。只拿到 `08 96 01`，没有对应 descriptor，就只能知道 field 1 是 VARINT，不能知道它叫 `value`、声明为 `int32` 还是 enum，也不知道属于哪个 message。

### 2.3 后端：插件生成代码

```text
protoc
  ├── built-in generator → message types
  └── protoc-gen-grpc-*   → client/server RPC glue
```

典型生成物分两层：

```text
Message code
  field accessors、presence、builder、parse、serialize、descriptor

RPC code
  method descriptor、client stub、server base/interface、dispatch table
```

stub 不包含完整网络实现。它通常把 method descriptor、request object、deadline/context 交给 gRPC runtime；runtime 再负责连接、HTTP/2 stream、metadata、重试和状态。

### 2.4 生成代码与 runtime 也有版本契约

```text
schema source version
  ≠ protoc/compiler version
  ≠ generated-code version
  ≠ protobuf runtime version
  ≠ gRPC runtime version
```

线格式兼容不代表任意版本的生成代码都能和任意 runtime 混用。较新的生成代码可能调用旧 runtime 不存在的 API，旧生成代码也可能依赖已移除行为。Protobuf 官方的 cross-version runtime guarantee 对不同语言并不完全相同：C++、Rust 更严格，Java 等语言有受限兼容窗口。

因此构建系统应：

- 锁定 compiler/plugin/runtime 版本；
- 在同一工具链中生成所有语言制品；
- 不手改生成代码；
- 升级工具链时跑跨版本互操作测试；
- 不把“当前能启动”当成受支持组合。

---

## 3. 兼容性不是一个布尔值

### 3.1 三种方向

假设 V1 与 V2 两版 schema：

| 名称 | 要验证的读取方向 | RPC 中的典型场景 |
|---|---|---|
| backward compatibility | V2 reader 能读 V1 writer 的数据 | 新服务端读取旧客户端请求；新消费者读取历史数据 |
| forward compatibility | V1 reader 能读 V2 writer 的数据 | 旧服务端读取新客户端请求；旧消费者读取新生产者数据 |
| full compatibility | 两个方向都成立 | 滚动发布期间新旧版本任意组合通信 |

术语在不同 registry 产品里偶尔有口径差异，评审时最好直接写“V2 reader ← V1 writer”，不要只写 backward。

### 3.2 四个兼容层次

```text
wire-compatible
  字节能否解析，是否会被错误解释或丢失

source-compatible
  使用旧生成 API 的业务源码能否重新编译

behavior-compatible
  解析后的默认值、校验、状态码和业务含义是否仍一致

operationally-compatible
  网关、JSON、反射、存储、日志、指标和发布顺序是否仍可工作
```

例：给 enum 添加值在 proto3 binary 上通常 wire-safe，但旧 Java/Kotlin 业务代码的 exhaustive switch 可能编译失败或走未知分支，所以不一定 source/behavior-safe。

### 3.3 滚动发布要检查四象限

```text
old client → old server
old client → new server
new client → old server
new client → new server
```

如果经过网关、消息队列或持久化，还要增加：

```text
new producer → old intermediary → new consumer
old stored bytes → new reader
new stored bytes → old rollback reader
binary → JSON → binary
```

“单元测试中新 client 调新 server 成功”只覆盖一个象限。

---

## 4. Protobuf 的字段身份：号码比名字重要

Protobuf binary 中字段 tag 为：

```text
tag = (field_number << 3) | wire_type
```

例如：

```proto
string customer_id = 2;
```

线上只携带 field number 2、wire type LEN 和实际值。`customer_id` 这个源代码名字不参与二进制解析。

由此得到三条不变量：

1. 已发布字段的号码不能改变；改号等价于删除旧字段并增加新字段。
2. 删除字段后号码不能复用；旧数据和延迟消息仍可能携带原号码。
3. 改名通常 binary-safe，但会破坏生成 API、JSON/TextFormat 和依赖字段名的系统。

### 4.1 为什么复用字段号会静默腐化数据

V1：

```proto
string email = 5;
```

错误的 V3：

```proto
string internal_note = 5;
```

一条 V1 历史消息中的 field 5 在 V3 看来完全合法，且 wire type 同为 LEN。解析不会报错，旧 email 会被静默当成 internal note，可能引发隐私泄漏或业务污染。

正确删除：

```proto
message User {
  reserved 5;
  reserved "email";
}
```

保留 number 防止二进制身份复用；保留 name 防止 JSON/TextFormat 名称复用。`reserved` 主要是编译期护栏，不会从历史字节中删除字段。

---

## 5. 未知字段是前向兼容的关键，但不是万能保险

V2 新增：

```proto
string promotion_code = 4;
```

V2 client 发给 V1 server 时，V1 parser 不认识 field 4，会将其作为 unknown field。现代 proto3 binary runtime 通常在 message 内保留 unknown fields，重新序列化时再写回。

```text
V2 bytes(field 1,2,4)
  → V1 parse(known 1,2 + unknown 4)
  → V1 binary reserialize
  → V2 parse(field 4 仍在)
```

### 5.1 未知字段可能在哪些地方丢失

- 转为 ProtoJSON 再转回 binary；
- 业务创建一个新对象，逐字段复制已知字段；
- mapper/DTO 层只映射 V1 定义；
- 某些旧 runtime 或第三方实现未保留 unknown set；
- 中间服务先解码、修改，再输出另一种 schema。

所以“旧服务能解析新字段”不等于“旧服务能透明转发新字段”。需要 round-trip 测试：

```text
new encode → old parse → old mutate → old encode → new parse
```

### 5.2 未知字段只保存字节，不保存业务语义

旧服务虽然不破坏 field 4，但也不会：

- 校验 promotion code；
- 用它计算价格；
- 将它写入独立数据库列；
- 对它做鉴权或脱敏。

因此新增字段通常 wire-safe，却可能 behavior-unsafe。新客户端若要求旧服务端必须理解该字段，就不能直接在混部阶段发送它。

---

## 6. 增加字段：默认值和 presence 决定行为

### 6.1 最常见的安全扩展

```proto
message CreateOrderRequest {
  string idempotency_key = 1;
  string customer_id = 2;
  repeated Item items = 3;
  optional string promotion_code = 4;
}
```

旧 writer 不发送 field 4，新 reader 必须对“不存在”有定义。推荐让新增字段在缺失时保持旧行为，而不是改变旧请求含义。

### 6.2 implicit presence 的陷阱

proto3 scalar 若没有 `optional`，常使用 implicit presence：

```proto
bool send_email = 5;
```

解析后无法区分：

```text
发送方没有提供 send_email
发送方明确提供 send_email = false
```

二者都读为 `false`，默认值通常也不会编码到线上。这对 PATCH/部分更新尤其危险：

```text
未提供 false → 不修改？
明确提供 false → 关闭功能？
```

解决方式：

- 使用 `optional bool send_email = 5` 获得显式 presence；
- 或使用 wrapper/message；
- PATCH API 配合 `FieldMask` 明确哪些字段要更新。

Protobuf 官方目前推荐新 proto3 scalar 优先采用 explicit presence，以便与 Editions 和 proto2 语义衔接。

### 6.3 默认值不是“线上填充”

读取缺失字段时，生成 API 返回类型默认值：数字 0、bool false、string 空串、enum 第一个值。但这不表示发送方写过该值。

因此 enum 应保留无业务含义的 0：

```proto
enum OrderStatus {
  ORDER_STATUS_UNSPECIFIED = 0;
  ORDER_STATUS_PENDING = 1;
  ORDER_STATUS_PAID = 2;
}
```

不要让 0 直接代表 `PAID` 之类有效状态，否则旧 writer 缺失字段会在新 reader 中被误认为真实业务状态。

---

## 7. Protobuf 变更分类

### 7.1 通常 binary wire-safe

| 变更 | 为什么可解析 | 仍需检查 |
|---|---|---|
| 增加新字段号 | 旧 reader 作为 unknown field | 旧服务是否必须理解；默认行为 |
| 删除字段并 reserve | 新 reader 忽略旧号码 | 旧 writer 是否仍依赖；历史数据 |
| 增加 enum value | 数值在线上仍是 Varint | 旧语言的 unknown enum 行为、switch |
| 字段改名但号码/类型不变 | 二进制不含字段名 | 源码、JSON、TextFormat、反射消费者 |
| 增加新 RPC method | 旧客户端不会调用 | 服务发现、权限、网关是否暴露 |

### 7.2 明确 wire-unsafe

| 变更 | 破坏原因 |
|---|---|
| 修改已有字段号 | reader 将它当成另一个字段或未知字段 |
| 复用已删除字段号 | 历史字节被解释成新含义 |
| 在不兼容 wire type 间改类型 | parser 可能跳过、误读或失败 |
| 将多个现有字段直接移入已有 oneof | 解析顺序可能清除先前字段，数据丢失 |
| 修改 RPC input/output message 为不兼容类型 | client/server 生成契约和 payload 解释不再一致 |
| 改 unary/streaming cardinality | 调用状态机与线上消息序列改变 |

### 7.3 “能解析但可能丢数据”的条件兼容

官方文档将一些变化归为 wire-compatible 而非无条件 wire-safe：

- `int32` ↔ `int64` 等 Varint 类型：超范围值会截断；
- `sint32` ↔ `sint64`：范围内可兼容，但与普通 int Varint 的 ZigZag 解释不同；
- `string` ↔ `bytes`：只有 bytes 始终为合法 UTF-8 时才安全；
- `fixed32` ↔ `sfixed32`、`fixed64` ↔ `sfixed64`：位宽相同，数值解释需审查；
- `enum` ↔ 整数：线上可读，生成 API 和未知值行为不同；
- `map<K,V>` ↔ 对应的 repeated entry message：线上布局兼容，但 map reader 会重排并丢弃重复 key；
- singular ↔ repeated 的部分 LEN 类型：解析规则可能取最后值或合并，不等于业务等价。

原则：**不要因为 wire type 相同就原地改语义。** 更稳妥的是增加新字段、双写/回填、迁移读路径，再删除旧字段。

---

## 8. Enum 演进：新增值也可能击穿旧代码

### 8.1 开放与封闭 enum

不同语法版本和语言对未知 enum value 的表示曾有差异：

- open enum 倾向于把未知整数保留在字段中；
- closed enum 可能把未知整数放入 unknown field set；
- 生成语言可能提供 `UNRECOGNIZED`、原始数值访问或不同 fallback。

所以旧消费者必须有 unknown 分支：

```text
switch status:
  PENDING → ...
  PAID    → ...
  default → 记录原始值，采取安全退化策略
```

“永远不会出现未知枚举”与可演进协议矛盾。

### 8.2 删除 enum value

删除后应同时 reserve 数值和名字：

```proto
enum OrderStatus {
  reserved 3;
  reserved "ORDER_STATUS_CANCELLED_LEGACY";

  ORDER_STATUS_UNSPECIFIED = 0;
  ORDER_STATUS_PENDING = 1;
  ORDER_STATUS_PAID = 2;
}
```

数据库和历史消息仍可能含数值 3。新 reader 必须决定：保留为 unknown、映射为兼容状态、拒绝，还是走迁移逻辑。

---

## 9. oneof、repeated 与 map 的演进陷阱

### 9.1 oneof 的最后值获胜

```proto
oneof destination {
  string email = 4;
  string phone = 5;
}
```

线上若同时出现 field 4 和 5，解析器按出现顺序保留最后一个 oneof member。把两个原本可以同时存在的字段直接移入 oneof，会让旧 writer 发送的两个值在新 reader 中丢掉一个。

另外，新版本删除某个 oneof member 后，旧数据中的该字段变成 unknown；API 返回 `NOT_SET` 时，新代码无法区分“发送方没设 oneof”和“发送方设了我不认识的新/旧 member”。

### 9.2 repeated 改 singular

旧 writer 可能发送多个值，新 singular reader 对 primitive 往往取最后一个，对 message 可能合并。即使不报解析错误，选择“最后一个”的语义未必正确。

### 9.3 map 不是普通字典的稳定序列

Protobuf map 在线上等价于 repeated entry message。不要依赖：

- 序列化顺序；
- 重复 key 被保留；
- map 与 repeated entries 往返后字节完全一致。

如果重复 key 或顺序有业务意义，就不应该使用 map。

---

## 10. ProtoJSON 是另一套兼容边界

Protobuf binary 的 tag 用字段号；ProtoJSON 使用字段名/`json_name`，且通常不保留 unknown field。

| 变化 | Binary | ProtoJSON |
|---|---|---|
| 字段改名、号码不变 | 通常可读 | 旧 JSON 字段名可能无法解析 |
| 增加字段 | 旧 binary reader 可保留 unknown | JSON parser 默认可能拒绝 unknown，或选择忽略并丢失 |
| 删除字段并 reserve number | 防 binary 复用 | 仍要考虑旧字段名和存量 JSON |
| int64 | 精确 Varint | 常映射为 JSON string，通用客户端处理不同 |
| bytes | 原始字节 | Base64 string |
| enum | 数值可保留 | 常用名字，重命名会改变文本 |

如果链路经过 REST gateway：

```text
Protobuf → ProtoJSON → JavaScript object → ProtoJSON → Protobuf
```

就必须按 JSON 规则评审，不能只跑 binary breaking checker。尤其不要把 JSON 当作保留未知字段的透明中转格式。

---

## 11. RPC Service 的演进不仅是 message 演进

### 11.1 方法全名是网络路由身份

gRPC 默认 path：

```text
/{fully-qualified-service-name}/{method-name}
```

修改 package、service 或 method 名称会改变 path。即使 request/response 字节完全兼容，旧客户端仍可能得到 `UNIMPLEMENTED`。

安全重命名通常采用：

1. 增加新 service/method；
2. 服务端同时注册旧名和新名，内部委托同一实现；
3. 迁移客户端与网关；
4. 观测旧方法调用归零；
5. 经过最长离线客户端/回滚窗口后再移除旧名。

### 11.2 增加方法不代表所有基础设施自动支持

还需检查：

- API gateway 路由是否由静态配置生成；
- ACL 是否按 method full name 授权；
- 限流规则是否有默认安全值；
- reflection 是否在生产启用；
- 客户端拿到的新 stub 是否与服务端发布顺序匹配。

### 11.3 改变错误与校验也可能破坏旧客户端

以下都可能 binary-safe 但 behavior-breaking：

- 原本允许空字段，新服务开始返回 `INVALID_ARGUMENT`；
- 原本同步完成，改为只返回异步 operation；
- 原本 `NOT_FOUND`，改为 `PERMISSION_DENIED`；
- 新增 enum 状态但旧客户端将未知状态当失败；
- 扩大数值范围，旧客户端反序列化后业务层溢出。

契约测试必须断言业务语义和状态码，而不只是“能 parse”。

---

## 12. Expand → Migrate → Contract：通用迁移法

原地修改字段会让新旧版本在滚动期互相猜测。更稳健的模式是：

```text
EXPAND
  增加新字段/新方法；服务端同时理解新旧表示

MIGRATE
  先升级 reader，再逐步升级 writer；双读/双写并观测旧用法

CONTRACT
  停止写旧字段；等待存量与回滚窗口；删除并 reserve
```

### 12.1 新增“必填”业务字段

需求：新增 `currency`，未来必须存在。

错误做法：新增字段后服务端立即拒绝所有缺失 currency 的旧客户端。

正确顺序：

1. 新 reader 上线：缺失时按旧系统唯一合法币种推导，或记录 metrics；
2. 新 writer 上线：开始显式发送 currency；
3. 观测缺失率降到 0，并覆盖离线客户端、重试队列和历史任务；
4. 再启用严格校验；
5. 若无法可靠推导，创建 `v2` 方法而不是偷偷改变 v1 语义。

IDL 的 `optional` 描述线格式 presence；“业务必填”是验证规则，两者不要混为一谈。

### 12.2 改字段类型

需求：`int32 amount_cents = 6` 改为支持高精度金额。

推荐：

```proto
int32 amount_cents_legacy = 6 [deprecated = true];
Money amount = 9;
```

迁移期：

- reader 优先读 `amount`，否则转换 legacy；
- writer 逐步双写，并验证两者一致；
- 指标确认 legacy-only 流量归零；
- 停止双写并 reserve 6，但仍保留历史数据读取策略。

不要把 field 6 原地改成 `Money`：wire type 和语义同时改变。

### 12.3 拆分一个字段

`full_name` 拆为 `given_name`/`family_name` 不是无损转换。正确策略取决于数据语义：

- 新字段可选，服务端仍保留旧字段作为原始展示名；
- 明确新旧字段冲突时谁优先；
- 不假设能从所有文化的 full name 正确拆分；
- 若无法定义确定迁移，就保持两种表示或新建版本化 message。

---

## 13. Thrift：字段 ID 同样是线上身份

Thrift IDL：

```thrift
struct CreateOrderRequest {
  1: required string idempotency_key
  2: required string customer_id
  3: optional string promotion_code
}
```

Thrift Protocol 编码字段时使用 field ID 和 type code，字段名通常不参与二进制匹配。其演进原则与 Protobuf 相似：

- 不修改/复用已发布 field ID；
- 新字段优先 `optional`；
- reader 跳过未知 field ID；
- 改名可能 wire-safe，但生成 API/source 不安全；
- 类型变化要结合具体 Protocol 的 type code 判断，不能只看语言类型可转换。

### 13.1 `required` 为什么限制 soft versioning

Thrift 官方 IDL 文档明确指出：required 字段在读取时必须存在。新版本新增 required 字段时，旧 writer 不会发送，新的 reader 会失败；删除或改 optional 也会让版本组合复杂。

```text
V1 writer（没有 field 4）
  → V2 reader（要求 required field 4）
  → read failure
```

演进型公共契约通常避免新增 required；使用 optional + 业务层分阶段校验。Thrift 未显式标记 required/optional 的 default requiredness 在不同语言/实现中还有历史细节，不应拿它当严格业务必填保证。

### 13.2 Default 值也有 writer/reader差异

字段默认值是否实际写入字节会影响以后修改 default 的行为。若 writer 已把 default 值写进消息，reader 看到的是线上值；若字段没写，reader 使用自己 schema/生成代码中的 default。跨语言时必须实际测试，不要靠一种 SDK 推导所有实现。

---

## 14. Avro：Writer Schema 与 Reader Schema 同时参与解析

Avro 与 Protobuf/Thrift 的关键差异：binary 数据本身不带 field ID，reader 需要知道 writer schema，再与自己的 reader schema 做 resolution。

```text
bytes + writer schema + reader schema
  → schema resolution
  → reader object
```

Avro RPC 通过 handshake 确保双方拥有对方 protocol，缓存命中时不必每次传完整 schema。

### 14.1 Record 字段解析

Avro 按字段名匹配：

- writer 有、reader 没有：reader 忽略；
- reader 有、writer 没有：reader 字段必须有 default，否则报错；
- 同名字段：递归做 schema resolution；
- rename：reader 可用 alias 映射 writer 旧名。

### 14.2 Avro default 的常见误解

Avro field default 主要用于 **reader 在 writer 数据中找不到该字段时补值**。它不意味着 writer 可以在编码记录时随意省略字段；即使值等于 default，Avro 仍会编码该字段。

新增字段示例：

```json
{
  "name": "currency",
  "type": "string",
  "default": "CNY"
}
```

这使新 reader 能读取旧 writer 数据。反方向是否兼容，还要检查旧 reader 如何忽略新 writer 字段。

### 14.3 类型提升不是任意转换

Avro resolution 明确允许部分 writer→reader promotion，例如：

```text
int  → long / float / double
long → float / double
float → double
string ↔ bytes（按规范 resolution）
```

方向很重要：reader 用更宽类型接收 writer 较窄类型通常可行，反向可能溢出或不匹配。

### 14.4 Union 顺序具有语义

reader union 会选择第一个能匹配 writer schema 的分支；default 也与 union 分支规则相关。重排 union 不能只按“集合成员没变”判断，必须测试真实 resolution 和 JSON 表示。

---

## 15. 三种系统的演进模型对照

| 维度 | Protobuf | Thrift | Avro |
|---|---|---|---|
| 字段线上身份 | field number + wire type | field ID + type code | writer/reader schema 中的字段名与顺序规则 |
| 原始 binary 是否自描述 | 否 | 否 | 否，但系统要求 reader 获得 writer schema |
| 未知字段 | 通常保留在 unknown set | reader 跳过，保留能力依对象/实现 | writer-only 字段由 reader resolution 忽略 |
| 新 reader 读旧数据 | 新字段按 presence/default 处理 | optional 最容易兼容 | reader 新字段需 default |
| rename | binary 通常安全，JSON/source 风险 | binary 通常安全，source 风险 | 使用 alias 显式映射 |
| 删除后防复用 | reserve number/name | 团队规范保留 ID，IDL 能力依版本/工具 | schema history/registry 与 aliases |
| 动态处理 | descriptor/DynamicMessage | 依实现和元数据 | schema 天生参与读取，generic API 成熟 |

结论不是谁“最兼容”，而是谁把兼容信息放在哪：tag、IDL 历史还是 writer/reader schema resolution。

---

## 16. Schema Registry、CI 与制品治理

### 16.1 单一事实来源

推荐仓库结构：

```text
api/
├── buf.yaml / build config
├── order/v1/order.proto
├── order/v2/order.proto
└── breaking-policy
```

发布流水线：

```text
lint
  → compile all imports
  → breaking check against main/released descriptor
  → generate language SDKs
  → cross-version contract tests
  → publish immutable descriptor + SDK artifact
```

不要让每个服务仓库复制一份 proto 后独立修改；这会产生多个“同名 schema 真相”。

### 16.2 Breaking checker 能做什么

工具可检测：

- 字段号删除/复用；
- 类型、cardinality、oneof 变化；
- enum value 删除；
- service/method 删除或签名改变；
- package/file 移动导致的语言 API 变化。

但静态 checker 通常无法证明：

- 新字段缺失时业务默认是否正确；
- 状态码变化是否破坏客户端；
- 数值范围是否超出旧代码；
- 新 enum value 是否有安全 fallback；
- JSON 网关是否保留字段；
- 发布顺序和存量离线任务是否安全。

所以 breaking check 是下限，不是完整契约测试。

### 16.3 Descriptor 应作为版本制品保存

保存 release 对应 `FileDescriptorSet` 可以：

- 精确比较发布时契约，而不是依赖当前源码；
- 重放历史 payload；
- 构造 old/new DynamicMessage 互操作测试；
- 为审计回答“某日线上服务理解哪个字段”；
- 生成文档、mock 和网关配置。

制品应不可变并关联 git commit、protoc/plugin/runtime 版本。

---

## 17. 跨版本测试矩阵

### 17.1 最小矩阵

```text
V1 encode → V1 decode
V1 encode → V2 decode
V2 encode → V1 decode
V2 encode → V2 decode
```

### 17.2 中间节点 round-trip

```text
V2 encode
  → V1 parse
  → 修改一个已知字段
  → V1 serialize
  → V2 parse
  → 断言 V2-only unknown fields 仍存在
```

### 17.3 RPC 滚动组合

```text
V1 client stub → V2 server implementation
V2 client stub → V1 server implementation
V2 client 使用新字段 → V1 server 的降级行为
V1 client 收到 V2 新 enum value
```

### 17.4 JSON/存储路径

```text
V2 binary → JSON gateway → V2 binary
V1 stored bytes → V2 reader
V2 stored bytes → V1 rollback reader
```

每个测试不仅断言 parse 成功，还要断言：presence、unknown fields、默认值、业务校验、enum fallback 和重新序列化结果。

---

## 18. `CreateOrder` 演进案例

### V1

```proto
message CreateOrderRequest {
  string idempotency_key = 1;
  string customer_id = 2;
  repeated Item items = 3;
}
```

### V2：增加优惠码

```proto
optional string promotion_code = 4;
```

约束：旧服务端忽略该字段，因此 V2 客户端在确认服务端支持前不能假设优惠已应用。响应应明确返回 pricing 结果，而不是仅靠“请求里带了字段”判断。

### V3：增加币种

```proto
string currency = 5;
```

若旧业务只有 CNY，可先让新 reader 对缺失值解释为 CNY，再升级 writer；若多币种请求落到旧服务会产生严重错误，应新增能力协商、路由到支持实例，或发布 `order.v2`，不能依靠 unknown-field 兼容。

### V4：弃用 customer_id

新增结构化 buyer：

```proto
string customer_id = 2 [deprecated = true];
Buyer buyer = 6;
```

迁移规则：

1. reader 同时接受，若两者都有则验证指向同一主体；
2. 新 writer 双写一段时间；
3. 观测只有 field 2 的请求归零；
4. 停止写 field 2；
5. 经过回滚、消息保留和离线客户端窗口后：

```proto
reserved 2;
reserved "customer_id";
```

注意：删除 IDL 字段不会清理数据库、历史消息和离线 payload，它只改变新生成代码的理解方式。

---

## 19. 常见反模式

1. **字段删除后复用号码**：让历史数据被静默解释成新含义。
2. **只看 binary compatibility**：忽略 JSON 网关、生成源码和业务默认。
3. **新增字段后立即强校验**：滚动期旧 writer 全部失败。
4. **把 `optional` 当业务可选**：IDL presence 与业务 required 是两个维度。
5. **enum switch 没有 unknown 分支**：新增值击穿旧客户端。
6. **用字段改名完成概念迁移**：binary 没坏，但代码、JSON 和观测全部断裂。
7. **原地改变金额/时间类型**：同 field number 承载新语义，历史数据无法区分。
8. **逐字段复制 message**：无意丢失 unknown fields，破坏透明中转。
9. **修改生成代码**：下次生成覆盖，并让实际契约无法复现。
10. **只保留 `.proto` 不保留工具链版本**：无法重建完全相同的 SDK 制品。
11. **单测只跑 new↔new**：遗漏滚动发布的关键象限。
12. **把 schema registry 当文档站**：没有 CI 门禁和不可变版本，无法阻止破坏性发布。

---

## 20. 高频追问

### Q1：Protobuf 为什么能增加字段而不破坏旧 reader？

每个字段带 field number 和 wire type，旧 reader 能跳过不认识的 tag，并通常把它保存在 unknown field set。但旧业务不会理解新字段，且 JSON/逐字段复制可能丢失它，所以这里只能先推出 binary parse 兼容。

### Q2：字段改名安全吗？

对 Protobuf binary 通常安全，因为线上使用号码；对生成源码、ProtoJSON、TextFormat、反射和字段名驱动的映射可能不安全。需要逐层判断。

### Q3：为什么字段号删除后永远不能复用？

历史数据库、消息队列、备份、离线客户端和迟到请求可能长期携带旧号码。复用会让这些字节成为合法的新字段，往往静默污染而不是报错。

### Q4：新增 optional 字段就一定兼容吗？

只说明缺失字段可在线格式中表达。若新客户端要求服务端理解它，旧服务忽略后仍会行为不兼容；若默认值改变旧请求含义，新 reader 也可能破坏旧 writer。

### Q5：`optional bool` 比普通 `bool` 多解决了什么？

它区分“未提供”和“明确提供 false”。这对部分更新、继承默认配置和渐进发布非常重要。

### Q6：为什么新 enum value 是 wire-safe 却可能 source-breaking？

线上只是新整数，旧 parser 通常能保留；但旧语言的 exhaustive switch、封闭 enum 表示或业务 fallback 可能无法处理未知值。

### Q7：Protobuf 和 Avro 演进的根本差异是什么？

Protobuf 把字段身份编码为 tag，reader 用自身 schema 解释并保存 unknown tag；Avro 读取时同时使用 writer schema 与 reader schema，通过字段名、default、alias 和 promotion 做 resolution。

### Q8：Breaking checker 通过就能发布吗？

不能。它主要检测结构变化，无法证明新默认值、校验、状态码、数值范围、JSON 中转和滚动顺序在业务上安全。

### Q9：怎样安全修改 RPC 方法名？

并行暴露新旧方法，迁移客户端和网关，观测旧调用归零，等待离线/回滚窗口后移除旧方法。直接改名会改变 gRPC path。

### Q10：为什么生成代码和 runtime 版本也属于契约？

生成代码调用 runtime API 并依赖其内部表示。线格式稳定不保证不受支持的 gencode/runtime 组合能加载或正确运行。

---

## 21. 本章验收清单

- [ ] 能画出 source → AST → descriptor → plugin → gencode → runtime 流水线。
- [ ] 能区分 wire、source、behavior、operational compatibility。
- [ ] 能逐一验证 old/new client/server 四象限。
- [ ] 能解释字段号码、名字和 wire type 的不同作用。
- [ ] 知道 unknown fields 在 binary round-trip 与 JSON 中转中的差异。
- [ ] 能用 explicit presence 设计 PATCH/部分更新。
- [ ] 能判断 enum、oneof、map、repeated 的演进风险。
- [ ] 能执行 expand → migrate → contract，而不是原地换类型。
- [ ] 能说明 Thrift required 为什么阻碍 soft versioning。
- [ ] 能说明 Avro writer/reader schema resolution 和 default 的真实用途。
- [ ] 能设计 schema CI、descriptor 制品和跨版本测试矩阵。

---

## 22. 官方资料

- [Protobuf Proto3 Language Guide](https://protobuf.dev/programming-guides/proto3/)：字段号、reserved、unknown fields、message 更新和条件兼容变化。
- [Protobuf Encoding](https://protobuf.dev/programming-guides/encoding/)：field number、wire type 和 tag 的二进制身份。
- [Protobuf Field Presence](https://protobuf.dev/programming-guides/field_presence/)：implicit/explicit presence、默认值与 FieldMask 问题。
- [ProtoJSON Format](https://protobuf.dev/programming-guides/json/)：JSON 映射及其不同于 binary 的兼容边界。
- [Protobuf Techniques — Self-describing Messages](https://protobuf.dev/programming-guides/techniques/)：`FileDescriptorSet` 和 DynamicMessage。
- [Protobuf Cross-Version Runtime Guarantee](https://protobuf.dev/support/cross-version-runtime-guarantee/)：gencode 与 runtime 的受支持版本组合。
- [Apache Thrift IDL](https://thrift.apache.org/docs/idl)：field ID、required/optional/default requiredness 与版本兼容。
- [Apache Avro 1.12.0 Specification](https://avro.apache.org/docs/1.12.0/specification/)：writer/reader schema resolution、default、alias、promotion 和 RPC handshake。
- [Buf Breaking Change Detection](https://buf.build/docs/breaking/)：基于 Protobuf schema 的自动兼容性门禁。

## 一句话总结

> Schema 演进的目标不是“新代码能读新数据”，而是在新旧 writer、reader、网关、存储和回滚版本同时存在时，每个字段仍保持唯一身份、缺失值仍保持旧语义、未知值不会被误判，并且发布过程有证据证明所有旧路径已经安全退出。

> 下一篇：[03｜Protobuf 线格式逐字节拆解](03_Protobuf线格式逐字节拆解.md)。
