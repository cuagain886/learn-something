/**
 * 第 17 课的可复用 Schema 内核。
 *
 * 目标不是复制成熟验证库，而是把它们最重要的三层关系做成透明实现：
 *
 *   Schema 值 ──运行时──> unknown -> Result<Output, Issues>
 *      │
 *      ├──类型空间──> Infer<Schema> 得到静态 Output
 *      └──协议空间──> JSON Schema 子集，供模型/HTTP 边界描述输入
 *
 * JSON Schema 描述“接受什么输入”，Output 还可能经过 refine/transform 变成品牌类型
 * 或领域对象；两者不能简单认为是同一个东西。
 */

// Result：本文件所有校验函数的统一返回类型。
//   ok=true 时携带 value，ok=false 时携带 error；readonly 字段强制调用方走分支，避免误用。
export type Result<Value, ErrorValue> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: ErrorValue };

// PathSegment：JSON Pointer 的一段，要么是对象 key（string），要么是数组下标（number）。
export type PathSegment = string | number;

// ValidationIssueCode：所有可识别的失败原因枚举。
//   把错误“分类”，上层就能针对不同 code 做不同处理（例如缺失 key 与类型错误策略不同）。
export type ValidationIssueCode =
  | 'invalid_type'      // 值的运行时类型与期望不符
  | 'invalid_literal'   // 字面量不匹配
  | 'missing_key'       // 对象缺少必填字段
  | 'unknown_key'       // 出现 strict 模式不允许的未知字段
  | 'too_small'         // 数值/字符串/数组长度低于下界
  | 'too_large'         // 数值高于上界
  | 'invalid_format'    // 字符串不匹配正则
  | 'invalid_union'     // union 的所有分支都不匹配
  | 'not_json_value'    // 出现无法 JSON 化的值（Symbol/函数等）
  | 'cyclic_value'      // 出现循环引用
  | 'accessor_property' // 出现访问器属性，无法安全读取
  | 'custom';           // refine 自定义校验失败

// ValidationIssue：一条结构化错误记录。
// 刻意不携带 original value：避免把可能含 secret 的外部输入写进日志。
export interface ValidationIssue {
  readonly code: ValidationIssueCode;
  readonly path: readonly PathSegment[];
  readonly pointer: string;       // 由 path 拼成的 JSON Pointer，便于人和工具定位
  readonly message: string;
  readonly expected?: string;     // 期望的类型/范围，给上层做断言用
  /** 只记录安全的类型摘要，不把可能含 secret 的原值塞进日志错误。 */
  readonly received: string;
}

/** 足以表达本课程工具输入的 JSON Schema 子集。 */
export interface JsonSchema {
  readonly type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly minLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly anyOf?: readonly JsonSchema[];
}

// Schema：整个库的核心接口。
//   - jsonSchema：把约束投影给模型/HTTP 边界（协议空间）；
//   - safeParse：运行时把 unknown 收窄为 Output 或返回一组 issue（运行时空间）。
// 类型参数 Output 是这个 schema 解析成功后的精确静态类型。
export interface Schema<Output> {
  readonly jsonSchema: JsonSchema;
  safeParse(
    input: unknown,
    path?: readonly PathSegment[],
  ): Result<Output, readonly ValidationIssue[]>;
}

// Infer：从“一个 Schema 值”反向推断出它的 Output 静态类型。
// 这样调用方无需手写 interface，避免“interface 与 schema 实现漂移”。
export type Infer<SchemaValue> =
  SchemaValue extends Schema<infer Output> ? Output : never;

// OptionalSchema：optional() 包装后的 schema 带有特殊标记，
// 让 object() 知道这个 key 允许缺失，并参与 InferShape 的可选键计算。
// 内层 Output 通过 | undefined 表达“可以拿不到值”。
export interface OptionalSchema<Output> extends Schema<Output | undefined> {
  readonly optional: true;
  readonly inner: Schema<Output>;
}

export type AnySchema = Schema<unknown>;
// SchemaShape：object() 接受的“字段名 → schema”映射类型。
export type SchemaShape = Readonly<Record<string, AnySchema>>;

// OptionalKeys：从 Shape 中筛出所有 OptionalSchema 对应的 key，组成联合类型。
// 写法是“对每个 key 做条件判断 + 索引取值”，是 TS 中常见的“按键过滤 keys”惯用法。
type OptionalKeys<Shape extends SchemaShape> = {
  [Key in keyof Shape]-?: Shape[Key] extends OptionalSchema<unknown>
    ? Key
    : never;
}[keyof Shape];

// RequiredKeys：OptionalKeys 的补集，即“必填键”的联合。
type RequiredKeys<Shape extends SchemaShape> = Exclude<
  keyof Shape,
  OptionalKeys<Shape>
>;

// OptionalOutput：从 OptionalSchema 里取出真正的内层 Output（去掉 undefined 包装）。
type OptionalOutput<Value> =
  Value extends OptionalSchema<infer Output> ? Output : never;

// InferShape：根据 Shape 计算出对应的对象静态类型。
//   必填键 → 直接出现；
//   可选键 → 用 ? 标记，值类型为 OptionalOutput（不含 undefined，因为 ? 已经表达了缺失语义）。
// -readonly 让实现里可以把它当作可写 Record 填充，对外仍按目标类型返回。
export type InferShape<Shape extends SchemaShape> = {
  -readonly [Key in RequiredKeys<Shape>]: Infer<Shape[Key]>;
} & {
  -readonly [Key in OptionalKeys<Shape>]?: OptionalOutput<Shape[Key]>;
};

// UnknownKeyPolicy：对象遇到未知 key 时的三种信任策略。
//   strict     → 报错（白名单，最安全）；
//   strip      → 丢弃未知字段（默认行为，把外部数据裁剪到已知形状）；
//   passthrough → 原样保留（适合做最小约束的 envelope）。
export type UnknownKeyPolicy = 'strict' | 'strip' | 'passthrough';

// describeReceived：给一个运行时值生成安全的“类型摘要”字符串，
// 用于 ValidationIssue.received，避免把原始值塞进日志。
function describeReceived(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// toJsonPointer：把 path 段数组拼成 RFC 6901 风格的 JSON Pointer 字符串。
// 转义规则：~ → ~0，/ → ~1（顺序不能颠倒，否则会把转义后的 ~1 再次误转）。
export function toJsonPointer(path: readonly PathSegment[]): string {
  if (path.length === 0) return '';
  return path
    .map((segment) => String(segment).replaceAll('~', '~0').replaceAll('/', '~1'))
    .map((segment) => `/${segment}`)
    .join('');
}

// makeIssue：组装一条 ValidationIssue 的工厂函数，
// 统一收敛 path 拷贝、pointer 拼接、received 摘要等构造细节。
function makeIssue(
  code: ValidationIssueCode,
  path: readonly PathSegment[],
  message: string,
  input: unknown,
  expected?: string,
): ValidationIssue {
  return {
    code,
    path: [...path],               // 拷贝一份，避免外部后续修改影响这条 issue
    pointer: toJsonPointer(path),
    message,
    received: describeReceived(input),
    // expected 是可选字段：只在传了的时候才出现，避免每个 issue 都多一个 undefined。
    ...(expected === undefined ? {} : { expected }),
  };
}

// success / failure：Result 的两个构造助手，调用处读起来更直白。
function success<T>(value: T): Result<T, readonly ValidationIssue[]> {
  return { ok: true, value };
}

function failure(
  issue: ValidationIssue,
): Result<never, readonly ValidationIssue[]> {
  return { ok: false, error: [issue] };
}

// StringOptions：string() schema 接受的约束选项。
export interface StringOptions {
  readonly minLength?: number;
  readonly pattern?: RegExp;
  readonly description?: string;
}

// string：构造一个字符串 schema，支持 minLength 与 pattern 两种约束。
// 同时把同样的约束投影到 JSON Schema，让模型/HTTP 边界也能看到。
export function string(options: StringOptions = {}): Schema<string> {
  // 构造期就拒绝非法选项：minLength 必须是非负整数，而不是等 safeParse 才暴露问题。
  if (
    options.minLength !== undefined &&
    (!Number.isInteger(options.minLength) || options.minLength < 0)
  ) {
    throw new RangeError('string.minLength 必须是非负整数');
  }
  // JSON Schema 子集不编码 flags，强制要求 pattern 不带 flags（保持 wire 协议中立）。
  if (options.pattern !== undefined && options.pattern.flags !== '') {
    throw new RangeError(
      '课程 JSON Schema 子集不编码 RegExp flags；请使用无 flags 的 pattern',
    );
  }

  return {
    // 条件展开：只有选项真的存在时才把对应键写进 jsonSchema，保持投影最小。
    jsonSchema: {
      type: 'string',
      ...(options.description === undefined
        ? {}
        : { description: options.description }),
      ...(options.minLength === undefined ? {} : { minLength: options.minLength }),
      ...(options.pattern === undefined ? {} : { pattern: options.pattern.source }),
    },
    safeParse(input, path = []) {
      if (typeof input !== 'string') {
        return failure(makeIssue(
          'invalid_type',
          path,
          '期望字符串',
          input,
          'string',
        ));
      }
      if (
        options.minLength !== undefined &&
        input.length < options.minLength
      ) {
        return failure(makeIssue(
          'too_small',
          path,
          `字符串长度不能小于 ${options.minLength}`,
          input,
          `length >= ${options.minLength}`,
        ));
      }
      if (options.pattern !== undefined && !options.pattern.test(input)) {
        return failure(makeIssue(
          'invalid_format',
          path,
          `字符串不匹配 ${options.pattern}`,
          input,
          options.pattern.source,
        ));
      }
      return success(input);
    },
  };
}

// BooleanOptions：boolean() schema 目前仅接受 description（保留扩展位）。
export interface BooleanOptions {
  readonly description?: string;
}

// boolean：构造一个布尔 schema。无其它约束，只做类型检查。
export function boolean(options: BooleanOptions = {}): Schema<boolean> {
  return {
    jsonSchema: {
      type: 'boolean',
      ...(options.description === undefined
        ? {}
        : { description: options.description }),
    },
    safeParse(input, path = []) {
      return typeof input === 'boolean'
        ? success(input)
        : failure(makeIssue(
            'invalid_type',
            path,
            '期望布尔值',
            input,
            'boolean',
          ));
    },
  };
}

// NumberOptions：number() schema 接受的约束选项。
export interface NumberOptions {
  readonly integer?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly description?: string;
}

// number：构造一个数字 schema，支持 integer / minimum / maximum 约束。
export function number(options: NumberOptions = {}): Schema<number> {
  // 拒绝 NaN/Infinity 作为边界，也拒绝 minimum > maximum 的非法范围。
  if (
    options.minimum !== undefined &&
    !Number.isFinite(options.minimum)
  ) {
    throw new RangeError('number.minimum 必须是有限数字');
  }
  if (
    options.maximum !== undefined &&
    !Number.isFinite(options.maximum)
  ) {
    throw new RangeError('number.maximum 必须是有限数字');
  }
  if (
    options.minimum !== undefined &&
    options.maximum !== undefined &&
    options.minimum > options.maximum
  ) {
    throw new RangeError('number.minimum 不能大于 maximum');
  }

  return {
    jsonSchema: {
      // integer 在 JSON Schema 里是单独的 type 取值，不是单独的约束字段。
      type: options.integer === true ? 'integer' : 'number',
      ...(options.description === undefined
        ? {}
        : { description: options.description }),
      ...(options.minimum === undefined ? {} : { minimum: options.minimum }),
      ...(options.maximum === undefined ? {} : { maximum: options.maximum }),
    },
    safeParse(input, path = []) {
      // 显式拒绝 NaN/Infinity：typeof NaN === 'number' 会骗过类型检查，但它们不是合法的 wire number。
      if (typeof input !== 'number' || !Number.isFinite(input)) {
        return failure(makeIssue(
          'invalid_type',
          path,
          '期望有限数字',
          input,
          options.integer === true ? 'finite integer' : 'finite number',
        ));
      }
      if (options.integer === true && !Number.isInteger(input)) {
        return failure(makeIssue(
          'invalid_type',
          path,
          '期望整数',
          input,
          'integer',
        ));
      }
      if (options.minimum !== undefined && input < options.minimum) {
        return failure(makeIssue(
          'too_small',
          path,
          `数字不能小于 ${options.minimum}`,
          input,
          `>= ${options.minimum}`,
        ));
      }
      if (options.maximum !== undefined && input > options.maximum) {
        return failure(makeIssue(
          'too_large',
          path,
          `数字不能大于 ${options.maximum}`,
          input,
          `<= ${options.maximum}`,
        ));
      }
      return success(input);
    },
  };
}

/**
 * 显式接受任意输入。它适合“envelope 中暂不解释的 payload”，但不能直接作为
 * 权限敏感工具的完整输入 Schema；JSON Schema 的空对象同样表示不施加约束。
 */
export function unknownValue(): Schema<unknown> {
  return {
    // 空 jsonSchema 表示“无约束”，与 JSON Schema 规范一致。
    jsonSchema: {},
    safeParse(input) {
      return success(input);
    },
  };
}

// Literal：literal schema 可接受的值类型联合。
type Literal = string | number | boolean | null;

// literal：构造一个“取值必须是这几个字面量之一”的 schema。
// const 类型参数让调用点的字面量数组保留为字面量元组联合（而非宽泛的 Literal[]）。
export function literal<const Values extends readonly [Literal, ...Literal[]]>(
  ...allowed: Values
): Schema<Values[number]> {
  return {
    // JSON Schema 里 literal 用 enum 表达。
    jsonSchema: { enum: allowed },
    safeParse(input, path = []) {
      // Object.is 比 === 更严格：能区分 NaN 与 NaN、+0 与 -0。
      return allowed.some((value) => Object.is(value, input))
        ? success(input as Values[number])
        : failure(makeIssue(
            'invalid_literal',
            path,
            `期望 ${allowed.map(String).join(' | ')}`,
            input,
            allowed.map(String).join(' | '),
          ));
    },
  };
}

// ArrayOptions：array() schema 接受的约束选项。
export interface ArrayOptions {
  readonly minItems?: number;
  readonly description?: string;
}

// array：构造一个数组 schema，每个元素交给内层 element schema 校验。
export function array<Element>(
  element: Schema<Element>,
  options: ArrayOptions = {},
): Schema<Element[]> {
  if (
    options.minItems !== undefined &&
    (!Number.isInteger(options.minItems) || options.minItems < 0)
  ) {
    throw new RangeError('array.minItems 必须是非负整数');
  }

  return {
    jsonSchema: {
      type: 'array',
      items: element.jsonSchema,
      ...(options.minItems === undefined ? {} : { minItems: options.minItems }),
      ...(options.description === undefined
        ? {}
        : { description: options.description }),
    },
    safeParse(input, path = []) {
      if (!Array.isArray(input)) {
        return failure(makeIssue(
          'invalid_type',
          path,
          '期望数组',
          input,
          'array',
        ));
      }
      if (options.minItems !== undefined && input.length < options.minItems) {
        return failure(makeIssue(
          'too_small',
          path,
          `数组长度不能小于 ${options.minItems}`,
          input,
          `items >= ${options.minItems}`,
        ));
      }

      // 关键设计：逐元素校验时“成功就收集，失败也继续”，
      // 这样一次解析可以暴露所有元素的错误，而不是只报第一个就停。
      const output: Element[] = [];
      const issues: ValidationIssue[] = [];
      for (const [index, value] of input.entries()) {
        // 子节点 path 追加当前下标，错误指针才会精确到 /scores/0 这种位置。
        const parsed = element.safeParse(value, [...path, index]);
        if (parsed.ok) output.push(parsed.value);
        else issues.push(...parsed.error);
      }
      return issues.length === 0
        ? success(output)
        : { ok: false, error: issues };
    },
  };
}

// optional：把任意 schema 包装成“可以缺失”的 schema。
// 返回 OptionalSchema，让 object() 在 InferShape 里把它识别为可选键。
export function optional<Output>(inner: Schema<Output>): OptionalSchema<Output> {
  return {
    optional: true,
    inner,
    // jsonSchema 沿用内层 schema，optional 信息只影响 object 的 required 计算。
    jsonSchema: inner.jsonSchema,
    safeParse(input, path = []) {
      // undefined 直接视为“缺失”，不再走内层校验。
      return input === undefined
        ? success(undefined)
        : inner.safeParse(input, path);
    },
  };
}

// isRecord：把“非 null 的普通对象”从 unknown 中识别出来，排掉数组和 null。
function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

// isOptionalSchema：运行时判断一个 schema 是不是 OptionalSchema。
// 不能用 instanceof（schema 是普通对象字面量），改用 hasOwn + Reflect.get 读 optional 标记。
function isOptionalSchema(schema: AnySchema): schema is OptionalSchema<unknown> {
  return Object.hasOwn(schema, 'optional') &&
    Reflect.get(schema, 'optional') === true;
}

// ObjectOptions：object() 接受的选项，控制未知键策略与 description。
export interface ObjectOptions {
  readonly unknownKeys?: UnknownKeyPolicy;
  readonly description?: string;
}

// object：本库最重要的组合子，根据 shape 构造对象 schema。
// 类型参数 Shape 用 const 保留字面量键名，从而 InferShape 能精确推导每个字段的 Output。
export function object<const Shape extends SchemaShape>(
  shape: Shape,
  options: ObjectOptions = {},
): Schema<InferShape<Shape>> {
  // 默认 strict：出现未知字段直接报错，最安全。
  const unknownKeys = options.unknownKeys ?? 'strict';
  const shapeKeys = Object.keys(shape);
  // 在构造期就预计算出 required 列表，避免每次 safeParse 都重算。
  const required = shapeKeys.filter((key) => {
    const field = shape[key];
    return field !== undefined && !isOptionalSchema(field);
  });

  return {
    jsonSchema: {
      type: 'object',
      // 用 shape[key]?.jsonSchema ?? {} 兜底，避免 undefined 字段导致 fromEntries 崩溃。
      properties: Object.fromEntries(
        shapeKeys.map((key) => [key, shape[key]?.jsonSchema ?? {}]),
      ),
      required,
      // additionalProperties 是 unknownKeys 策略在 JSON Schema 上的投影：
      // 只有 passthrough 时为 true（允许未知字段）。
      additionalProperties: unknownKeys === 'passthrough',
      ...(options.description === undefined
        ? {}
        : { description: options.description }),
    },
    safeParse(input, path = []) {
      if (!isRecord(input)) {
        return failure(makeIssue(
          'invalid_type',
          path,
          '期望非数组对象',
          input,
          'object',
        ));
      }

      const output: Record<string, unknown> = {};
      const issues: ValidationIssue[] = [];

      // 第一遍：遍历 schema 声明的字段，逐个校验。
      for (const key of shapeKeys) {
        const fieldSchema = shape[key];
        if (fieldSchema === undefined) continue;

        // 关键：用 Object.hasOwn 判断“自身是否拥有该 key”，
        // 原型链上的属性不能冒充必填字段（防止原型污染攻击）。
        const present = Object.hasOwn(input, key);
        if (!present && isOptionalSchema(fieldSchema)) {
          // 可选字段缺失 → 直接跳过，不出现在输出对象上。
          continue;
        }
        if (!present) {
          // 必填字段缺失 → 记录 missing_key，但继续其它字段，累计错误。
          issues.push(makeIssue(
            'missing_key',
            [...path, key],
            `缺少必填字段 ${key}`,
            undefined,
            'present key',
          ));
          continue;
        }

        const parsed = fieldSchema.safeParse(input[key], [...path, key]);
        if (parsed.ok) {
          // 用 defineProperty 写入而非 output[key] = ...：
          // 即使 key 恰好是 '__proto__'，也不会触发原型链 setter，避免污染。
          // defineProperty 不会触发 Object.prototype.__proto__ setter。
          Object.defineProperty(output, key, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: parsed.value,
          });
        } else {
          issues.push(...parsed.error);
        }
      }

      // 第二遍：遍历输入里出现、但 schema 没声明的字段，按 unknownKeys 策略处理。
      for (const key of Object.keys(input)) {
        if (Object.hasOwn(shape, key)) continue;

        if (unknownKeys === 'strict') {
          // strict：未知字段记为 unknown_key 错误。
          issues.push(makeIssue(
            'unknown_key',
            [...path, key],
            `不允许未知字段 ${key}`,
            input[key],
            'known key',
          ));
        } else if (unknownKeys === 'passthrough') {
          // passthrough：原样保留到输出（同样用 defineProperty 防污染）。
          Object.defineProperty(output, key, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: input[key],
          });
        }
        // strip：什么都不做，等价于“丢弃未知字段”。
      }

      return issues.length === 0
        ? success(output as InferShape<Shape>)
        : { ok: false, error: issues };
    },
  };
}

// union：构造一个“取值必须匹配若干 schema 之一”的 schema。
// 类型参数要求至少两个分支，避免出现无意义的单分支 union。
export function union<
  const Schemas extends readonly [AnySchema, AnySchema, ...AnySchema[]],
>(...schemas: Schemas): Schema<Infer<Schemas[number]>> {
  return {
    // JSON Schema 用 anyOf 表达 union（而不是 oneOf，anyOf 在不同 draft 间更通用）。
    jsonSchema: { anyOf: schemas.map((schema) => schema.jsonSchema) },
    safeParse(input, path = []) {
      const branchIssues: ValidationIssue[] = [];
      // 顺序尝试每个分支，命中即返回。
      for (const schema of schemas) {
        const parsed = schema.safeParse(input, path);
        if (parsed.ok) return success(parsed.value as Infer<Schemas[number]>);
        branchIssues.push(...parsed.error);
      }
      // 全部失败：返回一个总览 invalid_union issue + 所有分支的子 issue，便于排查。
      return {
        ok: false,
        error: [
          makeIssue(
            'invalid_union',
            path,
            `输入不匹配 ${schemas.length} 个 union 分支中的任何一个`,
            input,
            `${schemas.length} union branches`,
          ),
          ...branchIssues,
        ],
      };
    },
  };
}

// refine 重载签名 1：通过 type predicate 把类型收窄为更窄的子类型（例如品牌类型）。
export function refine<Input, Refined extends Input>(
  schema: Schema<Input>,
  predicate: (value: Input) => value is Refined,
  message: string,
): Schema<Refined>;
// 重载签名 2：predicate 只返回 boolean，类型保持不变。
export function refine<Input>(
  schema: Schema<Input>,
  predicate: (value: Input) => boolean,
  message: string,
): Schema<Input>;
// refine 实现：先跑内层 schema，再叠加一个领域谓词。
//   不改变 jsonSchema：JSON Schema 表达不了任意谓词，只能描述 wire input。
export function refine<Input>(
  schema: Schema<Input>,
  predicate: (value: Input) => boolean,
  message: string,
): Schema<Input> {
  return {
    jsonSchema: schema.jsonSchema,
    safeParse(input, path = []) {
      const parsed = schema.safeParse(input, path);
      // 内层失败直接透传，不再跑谓词（避免在脏数据上跑业务逻辑）。
      if (!parsed.ok) return parsed;
      return predicate(parsed.value)
        ? parsed
        : failure(makeIssue('custom', path, message, input));
    },
  };
}

// transform：在 schema 解析成功后，把值映射成另一种 Output（如 trim、品牌化、构造领域对象）。
//   关键设计：jsonSchema 仍描述 wire input，Output 类型变了但协议不变。
export function transform<Input, Output>(
  schema: Schema<Input>,
  mapper: (value: Input) => Output,
): Schema<Output> {
  return {
    // JSON Schema 仍描述 wire input；Output 是解析后的领域表示。
    jsonSchema: schema.jsonSchema,
    safeParse(input, path = []) {
      const parsed = schema.safeParse(input, path);
      // 只有解析成功才执行 mapper；失败透传。
      return parsed.ok ? success(mapper(parsed.value)) : parsed;
    },
  };
}

// ValidationError：把 issues 聚合成一个 Error，便于在“需要 throw”的调用栈中使用。
// message 是按 pointer 拼接的人类可读字符串；结构化信息仍保留在 issues 上供程序读取。
export class ValidationError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super(
      issues.map((issue) => `${issue.pointer || '/'}: ${issue.message}`).join('; '),
    );
    this.name = 'ValidationError';
  }
}

// parse：safeParse 的“throw 版本”。成功直接返回值，失败抛 ValidationError。
//   适合“我就是要拿值，否则让上层 catch 统一处理”的场景。
export function parse<Output>(schema: Schema<Output>, input: unknown): Output {
  const result = schema.safeParse(input);
  if (result.ok) return result.value;
  throw new ValidationError(result.error);
}
