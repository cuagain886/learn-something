# 03｜Protobuf 线格式逐字节拆解：从 Tag 到嵌套消息

> Protobuf binary 不是“把对象压缩一下”，而是一串 `(tag, value)` 记录。理解 tag、wire type 和字段号，才能解释兼容性、未知字段、负数膨胀、packed repeated，以及为什么 Protobuf 不能独自给 TCP 消息分帧。

## 1. 先看结论：线上没有字段名和类型名

给定：

```proto
message Test {
  int32 value = 1;
}
```

`value = 150` 的完整 Protobuf payload 只有：

```text
08 96 01
```

线上没有：

- `Test`；
- `value`；
- 字符串 `int32`；
- 整条 message 的总长度。

线上只有：

```text
08       96 01
│        └──── value：150 的 Varint
└───────────── tag：field_number=1，wire_type=0
```

接收方必须提前知道 schema，才能把 field 1、wire type 0 解释为 `int32 value`。只拿到字节，最多能做结构级猜测，不能恢复完整 IDL 语义。

---

## 2. Protobuf message 的抽象语法

```text
message := (tag value)*

tag     := varint((field_number << 3) | wire_type)
```

每条字段记录由 tag 开始。tag 低 3 bit 是 wire type，其余高位是 field number：

```text
              高位                         低 3 bit
tag bits = [        field_number        ][wire_type]
```

wire type 不等于业务类型。它只告诉 parser **如何找到当前 value 的边界**：

| ID | 名称 | 读取方式 | 对应类型 |
|---:|---|---|---|
| 0 | VARINT | 读到 continuation bit=0 | int32/64、uint32/64、sint32/64、bool、enum |
| 1 | I64 | 固定读 8 字节 | fixed64、sfixed64、double |
| 2 | LEN | 先读 Varint 长度，再读 N 字节 | string、bytes、submessage、packed repeated |
| 3 | SGROUP | 读到对应 EGROUP | 已废弃 group 起点 |
| 4 | EGROUP | group 终点 | 已废弃 group 终点 |
| 5 | I32 | 固定读 4 字节 | fixed32、sfixed32、float |

wire type 6、7 无效。解析器遇到未知 field number 时，仍能根据 wire type 跳过 value；这正是前向兼容的基础。

### 2.1 为什么低 3 bit 足够

当前只需要表示 0～5 六种 wire type。tag 本身再用 Varint 编码，因此小 field number 的 tag 通常只占 1 字节。

```text
field 1, VARINT: (1 << 3) | 0 = 8   = 0x08
field 4, LEN:    (4 << 3) | 2 = 34  = 0x22
field 5, LEN:    (5 << 3) | 2 = 42  = 0x2A
field 8, VARINT: (8 << 3) | 0 = 64  = 0x40
```

字段号 1～15 与任意合法 wire type 组合后不超过 127，tag 只需一个 Varint 字节。这就是高频字段优先使用 1～15 的空间原因。

### 2.2 field 16 的 tag 为什么变成两字节

```text
field 16, LEN:
(16 << 3) | 2 = 130 = 0b1_0000010
Varint(130) = 82 01
```

```text
82          01
10000010    00000001
│           │
└ 低 7 bit=2└ 高 7 bit=1，结束
```

恢复值：

```text
2 | (1 << 7) = 130
field_number = 130 >> 3 = 16
wire_type    = 130 & 0b111 = 2
```

---

## 3. Varint：每字节 7 bit 数据 + 1 bit continuation

Varint 把整数切成若干个 7-bit 小组，从低位组到高位组发送：

```text
每个字节：
bit 7       bits 6..0
[continue]  [payload]

continue=1 → 后面还有字节
continue=0 → 当前 Varint 结束
```

### 3.1 编码 150

```text
150 / 128 = 1 余 22

低 7 bit：22 = 0x16；后面还有值 → 0x16 | 0x80 = 0x96
高 7 bit：1  = 0x01；最后一组   → 0x01

150 → 96 01
```

位视图：

```text
96          01
10010110    00000001
 0010110      0000001
    22            1

value = 22 | (1 << 7) = 150
```

### 3.2 通用编码伪代码

```text
encode_varint(unsigned n):
  while n >= 0x80:
    emit((n & 0x7f) | 0x80)
    n >>= 7
  emit(n)
```

### 3.3 通用解码伪代码

```text
decode_varint(bytes):
  result = 0
  shift = 0

  for byte in bytes:
    result |= (byte & 0x7f) << shift
    if (byte & 0x80) == 0:
      return result
    shift += 7
    if shift >= 64:
      error("malformed/overflow varint")

  need_more_data
```

生产 parser 还必须限制最大字节数：64-bit Varint 最多 10 字节。否则攻击者可用无限 continuation byte 消耗 CPU 或触发整数溢出。

### 3.4 Varint 的字节数

| 数值范围 | 字节数 |
|---:|---:|
| 0～127 | 1 |
| 128～16,383 | 2 |
| 16,384～2,097,151 | 3 |
| 2²¹～2²⁸-1 | 4 |
| uint32 最大值 | 5 |
| uint64 最大值 | 10 |

Varint 适合大量小正整数；对均匀分布的大 64-bit 数，`fixed64` 可能更稳定、更省 CPU，且固定 8 字节可能比 9～10 字节 Varint 更小。

---

## 4. 为什么负 `int32` 会膨胀到 10 字节

`int32`/`int64` 使用普通 Varint 语义。负 `int32` 会先按带符号值扩展到 64 bit，再作为 Varint 编码。

```proto
message Sample {
  int32 a = 1;
}
```

`a = -1` 的实测结果：

```text
08 ff ff ff ff ff ff ff ff ff 01
│  └──────────────────────────┘
tag          -1 的 10-byte Varint
```

两补码的高位全是 1，普通 Varint 无法把它压成小数值。因此若负数常见，应使用 `sint32`/`sint64`，让 ZigZag 先把靠近 0 的负数映射成小无符号整数。

---

## 5. ZigZag：把符号折叠到最低位

映射规律：

```text
原值:   0  -1   1  -2   2  -3   3 ...
编码:   0   1   2   3   4   5   6 ...
```

公式：

```text
sint32: (n << 1) ^ (n >> 31)
sint64: (n << 1) ^ (n >> 63)
```

数学上的等价理解：

```text
n >= 0 → 2n
n < 0  → 2|n| - 1
```

### 5.1 `-1` 的对比

```text
int32  field 1 = -1
08 ff ff ff ff ff ff ff ff ff 01   # tag 1B + value 10B

sint32 field 2 = -1
10 01                              # tag 1B + ZigZag/Varint 1B
```

### 5.2 `-500` 的逐步计算

```text
ZigZag(-500) = 2*500 - 1 = 999
999 / 128 = 7 余 103

低组 103 | 0x80 = 0xE7
高组 7             = 0x07

Varint(999) = e7 07
```

field 2 的 tag：

```text
(2 << 3) | 0 = 0x10

sint32 delta = 2, value=-500
→ 10 e7 07
```

ZigZag 不等于“所有负数更小”。极端正/负值仍需要接近完整位宽；它优化的是绝对值较小、符号混合的分布。

---

## 6. I32/I64：固定宽度且使用小端序

非 Varint 数值没有 continuation bit：

```text
I32 → 紧跟 4 字节 little-endian
I64 → 紧跟 8 字节 little-endian
```

### 6.1 `fixed32 0x12345678`

```proto
fixed32 mask = 3;
```

tag：

```text
(3 << 3) | 5 = 29 = 0x1D
```

payload 小端排列：

```text
0x12345678 → 78 56 34 12
```

完整字段：

```text
1d 78 56 34 12
│  └─────────┘
│    I32 payload
└──── tag(field=3, wire=5)
```

### 6.2 float/double

- `float`：IEEE 754 binary32 的 4 字节小端表示，wire type 5；
- `double`：IEEE 754 binary64 的 8 字节小端表示，wire type 1。

wire type 只说明读 4/8 字节。没有 schema 时，同一组 I32 字节无法区分 `fixed32`、`sfixed32` 和 `float`。

### 6.3 Varint 还是 fixed

| 数据分布 | 候选类型 |
|---|---|
| 非负且通常很小 | uint32/uint64/int32/int64 Varint |
| 正负且绝对值通常很小 | sint32/sint64 ZigZag + Varint |
| 值通常很大、接近全位宽 | fixed32/fixed64 |
| 位图/哈希片段/固定宽 ID | fixed32/fixed64，语义更明确 |
| 浮点 | float/double |

选型必须看真实分布，不要只记“Varint 更省空间”。

---

## 7. LEN：一个 wire type 承载四类结构

LEN 的通用布局：

```text
[tag][length as Varint][exactly length bytes]
```

它用于：

- UTF-8 string；
- 任意 bytes；
- embedded message；
- packed repeated scalar。

这四类在线上无法只靠 wire type 区分，必须查 schema。

### 7.1 String：长度是 UTF-8 字节数，不是字符数

```proto
string text = 4;
```

`text = "Hi"`：

```text
22 02 48 69
│  │  └───┘
│  │   UTF-8 "Hi"
│  └── length=2
└───── tag=(4<<3)|2=0x22
```

若字符串是中文 `中`，UTF-8 为 `e4 b8 ad`，length 是 3，不是 1。

### 7.2 bytes：可以包含任意八位字节

```proto
bytes raw = 16;
```

`raw = 00 ff`：

```text
82 01 02 00 ff
└──┘ │  └───┘
 tag │  raw bytes
     └ length=2
```

tag 是两字节 Varint `82 01`，解码为 field 16、wire type 2。

---

## 8. Embedded Message：外层 LEN 包住完整内层字段流

```proto
message Child {
  int32 id = 1;
  string name = 2;
}

message Sample {
  Child child = 6;
}
```

令 `child = {id: 7, name: "A"}`。

先编码 Child：

```text
08 07       # field 1, VARINT, id=7
12 01 41    # field 2, LEN=1, name="A"

Child payload 共 5 字节：08 07 12 01 41
```

再放进 Sample field 6：

```text
32 05 08 07 12 01 41
│  │  └────────────┘
│  │    Child payload
│  └──── length=5
└─────── tag=(6<<3)|2=0x32
```

内层 message 没有特殊终止符。外层 length 决定 submessage 的边界，submessage 内部仍是 `(tag,value)*`。

### 8.1 重复出现同一个 message field 会 merge

如果 singular message field 在输入中出现多次，parser 通常按 `MergeFrom` 语义合并：

```text
第一次 child: {id: 7}
第二次 child: {name: "A"}
最终 child:   {id: 7, name: "A"}
```

对 singular scalar/string 则通常 last one wins。这种差异对手工拼接和异常输入分析很重要。

---

## 9. Repeated：unpacked 与 packed

```proto
repeated int32 nums = 5;
```

值为 `[1, 2, 300]`。

### 9.1 Unpacked

每个元素重复写 tag，field 5 的 VARINT tag 为 `0x28`：

```text
28 01 28 02 28 ac 02
└─1─┘ └─2─┘ └──300──┘
```

总计 7 字节。

### 9.2 Packed

packable scalar 在 proto3 中默认 packed。先连接无 tag 的元素值：

```text
1   → 01
2   → 02
300 → ac 02

packed payload = 01 02 ac 02，共 4 字节
```

field 5 改用 LEN wire type：

```text
2a 04 01 02 ac 02
│  │  └─────────┘
│  │   packed elements
│  └── length=4
└───── tag=(5<<3)|2=0x2a
```

总计 6 字节。元素越多，tag 摊销越明显。

### 9.3 Parser 必须同时接受两种表示

现代 parser 对声明为 repeated packable scalar 的字段应接受 packed 和 unpacked，甚至接受多个 packed segment：

```text
2a 02 01 02   2a 02 ac 02
```

解析结果仍是 `[1,2,300]`。因此“语义相同”不代表“字节唯一”。

string、bytes、submessage 本来就各自需要 LEN，不能像数值那样再去掉内部边界做 packed。

---

## 10. Map：语法糖展开为 repeated entry message

```proto
map<string, int32> scores = 7;
```

线上等价于：

```proto
message ScoresEntry {
  string key = 1;
  int32 value = 2;
}

repeated ScoresEntry scores = 7;
```

`{"bob": 2}` 的 entry：

```text
0a 03 62 6f 62   # entry field 1, key="bob"
10 02            # entry field 2, value=2
```

entry 共 7 字节，外层 field 7：

```text
3a 07 0a 03 62 6f 62 10 02
│  │  └──────────────────┘
│  │       entry payload
│  └────── length=7
└───────── tag=(7<<3)|2=0x3a
```

### 10.1 Map 的关键语义

- wire order 不保证，迭代 order 也不保证；
- 重复 key 通常 last key wins；
- 缺失 key/value 使用类型默认值，具体序列化细节有语言差异；
- map entry 的 tag 顺序也不能成为业务协议；
- 若重复 key 和顺序有意义，使用显式 repeated message。

开启 deterministic serialization 后，某个 runtime 会采用稳定策略输出 map，但这种稳定不构成跨语言、跨版本的 canonical format。

---

## 11. Oneof：线上没有 oneof 标记

```proto
oneof choice {
  bool enabled = 8;
  string label = 9;
}
```

编码与普通字段完全相同：

```text
enabled=true → 40 01
label="x"    → 4a 01 78
```

如果恶意或旧 writer 同时发送：

```text
40 01 4a 01 78
```

parser 从前往后处理，后出现的 `label` 会清除 `enabled`，最终 oneof case 为 label。反过来排列则 enabled 获胜。

这说明 oneof 是 schema/API 层约束，不是独立 wire container；把多个原本可同时出现的字段移入 oneof 会造成 last-one-wins 数据丢失。

---

## 12. 完整样本：54 字节逐段拆解

本章使用 Protobuf Python runtime 5.29.5 动态构建 descriptor 并实际编码以下数据：

```proto
message Child {
  int32 id = 1;
  string name = 2;
}

message Sample {
  int32 a = 1;
  sint32 delta = 2;
  fixed32 mask = 3;
  string text = 4;
  repeated int32 nums = 5;
  Child child = 6;
  map<string, int32> scores = 7;
  oneof choice {
    bool enabled = 8;
    string label = 9;
  }
  bytes raw = 16;
}
```

值：

```text
a=150
delta=-500
mask=0x12345678
text="Hi"
nums=[1,2,300]
child={id:7,name:"A"}
scores={"ann":1,"bob":2}
label="x"
raw=00ff
```

确定性编码的实测结果：

```text
08 96 01
10 e7 07
1d 78 56 34 12
22 02 48 69
2a 04 01 02 ac 02
32 05 08 07 12 01 41
3a 07 0a 03 61 6e 6e 10 01
3a 07 0a 03 62 6f 62 10 02
4a 01 78
82 01 02 00 ff
```

逐段表：

| 字节 | field | 解释 |
|---|---:|---|
| `08 96 01` | 1 | tag 08；Varint 150 |
| `10 e7 07` | 2 | tag 10；ZigZag(-500)=999；Varint e7 07 |
| `1d 78 56 34 12` | 3 | tag 1d；fixed32 小端 0x12345678 |
| `22 02 48 69` | 4 | tag 22；LEN 2；UTF-8 `Hi` |
| `2a 04 01 02 ac 02` | 5 | tag 2a；LEN 4；packed `[1,2,300]` |
| `32 05 ...` | 6 | tag 32；LEN 5；嵌套 Child |
| `3a 07 ...` | 7 | 两个 repeated map entry，分别 ann 与 bob |
| `4a 01 78` | 9 | oneof 的 label，LEN 1，`x` |
| `82 01 02 00 ff` | 16 | 两字节 tag；LEN 2；raw bytes |

这里 map 顺序来自本次 runtime 的 deterministic 输出，**不是 Protobuf 跨实现规范顺序**。

---

## 13. Presence 与“没写任何字节”

在 implicit presence 下，默认 scalar 通常不序列化：

```proto
bool enabled = 1;  // false
int32 count = 2;   // 0
string name = 3;   // ""
```

若全是默认值，message 可编码为空字节串：

```text
<empty>
```

parser 读取后 getter 仍返回 false/0/empty string。因此无法区分“发送方没设置”和“明确设置默认值”。

`optional` 或 oneof 提供 explicit presence：即使值是默认值，只要字段被显式设置，就会写 tag/value。例如 oneof 中 `enabled=false` 仍会编码：

```text
40 00
```

这不是因为 false 的数值编码改变，而是 presence discipline 决定是否把字段记录写入 message。

---

## 14. Unknown Fields：parser 如何安全跳过

假设旧 schema 不认识 field 16，但读到：

```text
82 01 02 00 ff
```

解析流程：

1. 解码 tag Varint `82 01` → 130；
2. `field_number = 130 >> 3 = 16`；
3. `wire_type = 130 & 7 = 2`；
4. 读 length Varint `02`；
5. 跳过/保存后续 2 字节 `00 ff`；
6. 从下一字节继续解析。

对各 wire type 的 skip：

```text
0 VARINT → 扫到 continuation=0
1 I64    → 跳 8 bytes
2 LEN    → 读长度 N，跳 N bytes
3 GROUP  → 递归跳到匹配 field number 的 EGROUP
5 I32    → 跳 4 bytes
```

现代 runtime 通常把未知字段原始结构放入 unknown field set，并在 binary 重序列化时保留。这并不代表原始字节顺序一定保留，也不代表转 JSON 后仍保留。

### 14.1 为什么未知 LEN 无法规范化

对于未知 wire type 2，runtime 不知道内容是：

- string；
- bytes；
- embedded message；
- packed scalar。

因此无法可靠进入内部递归排序或规范化。相同 message 语义可能有多个合法字节表示，这也是 Protobuf 不承诺 canonical serialization 的原因之一。

---

## 15. 字段顺序、重复字段与合并语义

### 15.1 字段顺序不影响解析

以下两组对 schema 而言通常等价：

```text
08 01 10 02
10 02 08 01
```

parser 必须接受任意字段顺序。serializer 也不保证按字段号输出，更不能把序列化顺序当签名输入。

### 15.2 Singular scalar：last one wins

```text
08 01 08 02
```

field 1 两次出现，最终 scalar 值通常为 2。

### 15.3 Singular message：merge

message field 多次出现时，子字段合并；相同 scalar 子字段仍由后值覆盖，repeated 子字段则连接。

### 15.4 Repeated：按输入顺序连接

packed、unpacked、多个 packed segment 可以混合出现，解析器按遇到顺序把元素追加到 repeated collection。

这些规则让 parser 能接受多种合法表示，也进一步说明“比较序列化 bytes”不等于“比较 message 语义”。

---

## 16. Deterministic 不等于 Canonical

deterministic serialization 通常只承诺：在特定 binary/runtime/config 下，同一 message 重复编码得到一致字节。它不承诺：

- 不同语言一致；
- 不同 Protobuf 版本一致；
- schema 改动后仍一致；
- unknown fields 顺序一致；
- map 排列跨实现一致；
- 相同语义只有一种合法 byte representation。

因此以下用途有风险：

```text
hash(Serialize(message)) 作为长期业务身份
对 raw bytes 做数字签名后跨语言验证
把 raw bytes 当数据库去重键
用 bytes equality 判断业务对象相等
```

更稳妥的方案：

- 明确定义应用层 canonical representation；
- 只选定稳定字段并按规定顺序编码/哈希；
- 签名结构中包含 schema/version/domain separator；
- 业务幂等使用显式 idempotency key。

---

## 17. Protobuf 不是消息帧协议

Protobuf message 本身没有总长度。两个 message 直接拼接：

```text
message A bytes || message B bytes
```

接收方无法仅靠通用 Protobuf 规则知道 A 在哪里结束，因为 A 的最后一个字段之后没有 terminator。

必须由上层提供 framing，例如：

```text
[message_length][protobuf_message]
```

不同上层协议可选择不同长度格式：

- `writeDelimitedTo/parseDelimitedFrom` 常用 Varint 长度；
- gRPC 使用 1-byte compressed flag + 4-byte big-endian length；
- 自定义 TCP 协议可能使用固定 4 字节长度和 request ID。

### 17.1 不要混淆三层长度

```text
Protobuf LEN field
  → 给 string/bytes/submessage/packed field 定界

gRPC message length
  → 给整条 Protobuf message 定界

HTTP/2 frame length
  → 给一次 HEADERS/DATA 等 frame payload 定界
```

一条 gRPC message 可以跨多个 HTTP/2 DATA frame；一个 DATA frame 也可能包含多条 gRPC message。

---

## 18. Parser 安全边界

线格式紧凑不代表可以信任输入。解析器必须防御：

### 18.1 畸形 Varint

- 超过 10 字节仍全是 continuation；
- 数值移位溢出；
- tag 解码为 field number 0；
- wire type 为 6/7。

### 18.2 恶意 LEN

```text
length = 2GB-1
```

不能在未验证剩余输入和配置上限前直接分配。协议层通常还应设置远小于 Protobuf 理论 2 GiB 的 request/response 最大值。

### 18.3 深度递归

攻击者可构造深层 submessage/group，消耗栈或 CPU。不同 runtime 有 recursion limit；服务应同时限制 message 大小、嵌套深度和解析时间。

### 18.4 字段炸弹

大量极小重复字段、unknown fields 或 map entries 即使总字节不大，也可能产生大量对象和哈希操作。容量模型不能只看 payload bytes。

### 18.5 UTF-8 验证

`string` 要求有效 UTF-8，`bytes` 没有该要求。把 bytes 原地改成 string 即使 wire type 相同，也可能在旧数据上解析失败。

---

## 19. 手工解码算法

```text
parse_message(buffer, schema, end):
  while cursor < end:
    tag = read_varint()
    field_number = tag >> 3
    wire_type = tag & 7

    if field_number == 0:
      error

    field = schema.lookup(field_number)

    if field is unknown:
      skip_or_store_unknown(wire_type)
      continue

    assert wire_type is accepted for field

    switch wire_type:
      VARINT: raw = read_varint(); convert_by_declared_type(raw)
      I64:    raw = read_exactly(8); decode_little_endian_or_double(raw)
      LEN:    n = read_varint(); parse_len_value(field, slice(n))
      I32:    raw = read_exactly(4); decode_little_endian_or_float(raw)
      GROUP:  parse_until_matching_end_group()

    apply_presence_repeated_oneof_merge_rules(field, value)
```

注意 `assert wire_type` 不能简单要求唯一值。声明为 repeated numeric 的字段可能合法地以 VARINT unpacked 或 LEN packed 出现。

---

## 20. 本地验证方法

### 20.1 protoc decode_raw

将十六进制转为二进制后：

```powershell
protoc --decode_raw < sample.bin
```

`--decode_raw` 没有 schema，只能显示 field number 和结构猜测。LEN 内容若恰好也能解析成字段流，工具可能把 bytes 猜成 submessage，因此结果不能当类型证明。

### 20.2 带 schema 解码

```powershell
protoc `
  --proto_path=. `
  --decode=wire.Sample `
  wire.proto < sample.bin
```

### 20.3 Protoscope

官方编码文档使用 Protoscope 表示原始 wire data：

```text
1: 150
2: -500z
3: 0x12345678i32
4: {"Hi"}
5: {1 2 300}
```

它适合把“字段号/类型/值”与十六进制互相转换，但仍需 schema 才能知道业务字段名。

### 20.4 必做实验

1. 分别编码 `int32=-1` 与 `sint32=-1`，比较 11 字节和 2 字节。
2. 把 repeated numeric 切换 packed/unpacked，确认两者都能被同一 parser 读取。
3. 交换字段顺序，确认语义相同而 bytes 不同。
4. 给 singular scalar 手工重复两次，验证 last one wins。
5. 给 singular submessage 拆成两段，验证 merge。
6. 用新 schema 加字段，经过旧 binary parser round-trip，检查 unknown field 保留。
7. 再经过 ProtoJSON round-trip，观察 unknown field 丢失。
8. 拼接两条裸 Protobuf message，证明通用 parser 无法自动找到第一条边界。

---

## 21. 常见误区

1. **“Protobuf 是 TLV，所以每个字段都有 type 和 length。”** tag 有 wire type，但 VARINT/I32/I64 没有显式 length；LEN 也不携带业务类型。
2. **“字段名会被压缩成字段号。”** binary 从一开始就只写号码；不是把名字动态压缩后发送。
3. **“Varint 对所有整数都更小。”** 大整数可能比 fixed 更大，负 int32/int64 通常占 10 字节。
4. **“ZigZag 是压缩算法。”** 它只是有符号到无符号的映射，之后仍由 Varint 编码。
5. **“LEN 就是 string。”** bytes、submessage、packed repeated 都使用 wire type 2。
6. **“一条 repeated 字段只出现一个 tag。”** unpacked 会重复 tag，packed 也可分多个 segment。
7. **“Map 在线上是特殊哈希表。”** 它是 repeated entry submessage。
8. **“Oneof 在线上有 case 字段。”** 没有；普通字段规则加 last-one-wins。
9. **“确定性序列化可以做长期签名。”** deterministic 不等于跨实现 canonical。
10. **“Protobuf 自己知道 message 总长度。”** 不知道，必须由文件格式或 RPC framing 提供。
11. **“未知字段能永远无损保留。”** JSON 转换、逐字段复制和实现差异都可能丢失。
12. **“能 parse 就安全。”** 还要限制长度、深度、对象数量和 CPU。

---

## 22. 高频追问

### Q1：`08 96 01` 怎么解？

`08` 解为 tag 8：field 1、wire type 0。`96 01` 是 Varint：`0x16 | (0x01 << 7) = 150`。若 schema 声明 field 1 为 int32，则值为 150。

### Q2：为什么字段 16 的 LEN tag 是 `82 01`？

`(16<<3)|2=130`。130 的 Varint 低组为 2 且还有高组，所以首字节 `0x82`；高组为 1，第二字节 `0x01`。

### Q3：为什么负 int32 是 10 字节？

普通 int32 负值符号扩展到 64 bit，高位全 1，再按无符号 Varint 编码。小负数应使用 ZigZag 的 sint32/sint64。

### Q4：wire type 能区分 int32、bool 和 enum 吗？

不能，它们都是 VARINT。schema 决定同一 raw integer 的业务解释。

### Q5：为什么 submessage 需要 length？

内层没有 terminator。外层 LEN 让 parser 知道该 submessage 的 byte slice 终点，之后继续解析外层字段。

### Q6：packed repeated 为什么省空间？

它只写一次外层 tag 和总长度，元素内部连续编码，不再为每个元素重复 tag。

### Q7：字段顺序变化为什么仍可解析？

每条记录自带 field number，parser 按号码分派，不依赖 schema 声明顺序或 serializer 输出顺序。

### Q8：相同 message 是否必然得到相同 bytes？

不必然。字段顺序、map 顺序、unknown fields、packed segment 和 runtime 实现都会产生多个合法表示。

### Q9：Protobuf 比 JSON 小的根本原因是什么？

binary 使用字段号代替字段名、Varint 压缩小整数、固定 wire type 省去文本类型标记、packed 摊销 repeated tag，并避免十进制文本解析。但实际差距依字段和值分布而定。

### Q10：为什么 gRPC 还要 5 字节 message header？

Protobuf 只给字段定界，不给整条 message 定界。gRPC 的压缩标志和 4 字节大端长度用于在 HTTP/2 DATA 字节流内切分完整 RPC message。

---

## 23. 本章验收清单

- [ ] 能从任意 tag 算出 field number 和 wire type。
- [ ] 能手算 150、300、999 的 Varint。
- [ ] 能解释 int32=-1 与 sint32=-1 的长度差。
- [ ] 知道 fixed32/fixed64 使用小端序。
- [ ] 能逐字节拆 string、bytes 和 embedded message。
- [ ] 能写出 repeated 的 packed/unpacked 两种表示。
- [ ] 能把 map 展开为 repeated entry message。
- [ ] 能解释 oneof 和重复 singular 字段的 last-one-wins/merge。
- [ ] 能写出 unknown field 的 skip 算法。
- [ ] 不把 deterministic serialization 当 canonical format。
- [ ] 能区分 Protobuf LEN、gRPC message length、HTTP/2 frame length。
- [ ] 能列出 parser 的长度、深度、Varint 与对象数量防线。

---

## 24. 官方资料

- [Protocol Buffers Encoding](https://protobuf.dev/programming-guides/encoding/)：tag、Varint、ZigZag、I32/I64、LEN、packed 和合并规则。
- [Proto Serialization Is Not Canonical](https://protobuf.dev/programming-guides/serialization-not-canonical/)：deterministic 与 canonical 的区别及 unknown field 障碍。
- [Protocol Buffers Techniques](https://protobuf.dev/programming-guides/techniques/)：裸 Protobuf message 不自定界，以及 length prefix 的必要性。
- [Proto3 Language Guide](https://protobuf.dev/programming-guides/proto3/)：presence、unknown fields、oneof、map 和默认值。
- [Field Presence](https://protobuf.dev/programming-guides/field_presence/)：implicit/explicit presence 的 API 与序列化行为。
- [Protoscope](https://github.com/protocolbuffers/protoscope)：官方 wire-format 描述与实验工具。

## 一句话总结

> Protobuf 的紧凑来自“field number + 最少的边界信息”，而不是魔法压缩：parser 依靠 wire type 找到值的终点，依靠 schema 恢复业务类型，依靠上层 framing 找到整条消息的终点；任何把这三类边界混在一起的实现，最终都会在兼容、抓包或安全上出错。

> 下一篇：[04｜gRPC over HTTP/2 协议与状态机](04_gRPC_over_HTTP2协议与状态机.md)。
