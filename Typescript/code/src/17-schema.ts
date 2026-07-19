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

export type Result<Value, ErrorValue> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: ErrorValue };

export type PathSegment = string | number;

export type ValidationIssueCode =
  | 'invalid_type'
  | 'invalid_literal'
  | 'missing_key'
  | 'unknown_key'
  | 'too_small'
  | 'too_large'
  | 'invalid_format'
  | 'invalid_union'
  | 'not_json_value'
  | 'cyclic_value'
  | 'accessor_property'
  | 'custom';

export interface ValidationIssue {
  readonly code: ValidationIssueCode;
  readonly path: readonly PathSegment[];
  readonly pointer: string;
  readonly message: string;
  readonly expected?: string;
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

export interface Schema<Output> {
  readonly jsonSchema: JsonSchema;
  safeParse(
    input: unknown,
    path?: readonly PathSegment[],
  ): Result<Output, readonly ValidationIssue[]>;
}

export type Infer<SchemaValue> =
  SchemaValue extends Schema<infer Output> ? Output : never;

export interface OptionalSchema<Output> extends Schema<Output | undefined> {
  readonly optional: true;
  readonly inner: Schema<Output>;
}

export type AnySchema = Schema<unknown>;
export type SchemaShape = Readonly<Record<string, AnySchema>>;

type OptionalKeys<Shape extends SchemaShape> = {
  [Key in keyof Shape]-?: Shape[Key] extends OptionalSchema<unknown>
    ? Key
    : never;
}[keyof Shape];

type RequiredKeys<Shape extends SchemaShape> = Exclude<
  keyof Shape,
  OptionalKeys<Shape>
>;

type OptionalOutput<Value> =
  Value extends OptionalSchema<infer Output> ? Output : never;

export type InferShape<Shape extends SchemaShape> = {
  -readonly [Key in RequiredKeys<Shape>]: Infer<Shape[Key]>;
} & {
  -readonly [Key in OptionalKeys<Shape>]?: OptionalOutput<Shape[Key]>;
};

export type UnknownKeyPolicy = 'strict' | 'strip' | 'passthrough';

function describeReceived(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function toJsonPointer(path: readonly PathSegment[]): string {
  if (path.length === 0) return '';
  return path
    .map((segment) => String(segment).replaceAll('~', '~0').replaceAll('/', '~1'))
    .map((segment) => `/${segment}`)
    .join('');
}

function makeIssue(
  code: ValidationIssueCode,
  path: readonly PathSegment[],
  message: string,
  input: unknown,
  expected?: string,
): ValidationIssue {
  return {
    code,
    path: [...path],
    pointer: toJsonPointer(path),
    message,
    received: describeReceived(input),
    ...(expected === undefined ? {} : { expected }),
  };
}

function success<T>(value: T): Result<T, readonly ValidationIssue[]> {
  return { ok: true, value };
}

function failure(
  issue: ValidationIssue,
): Result<never, readonly ValidationIssue[]> {
  return { ok: false, error: [issue] };
}

export interface StringOptions {
  readonly minLength?: number;
  readonly pattern?: RegExp;
  readonly description?: string;
}

export function string(options: StringOptions = {}): Schema<string> {
  if (
    options.minLength !== undefined &&
    (!Number.isInteger(options.minLength) || options.minLength < 0)
  ) {
    throw new RangeError('string.minLength 必须是非负整数');
  }
  if (options.pattern !== undefined && options.pattern.flags !== '') {
    throw new RangeError(
      '课程 JSON Schema 子集不编码 RegExp flags；请使用无 flags 的 pattern',
    );
  }

  return {
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

export interface BooleanOptions {
  readonly description?: string;
}

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

export interface NumberOptions {
  readonly integer?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly description?: string;
}

export function number(options: NumberOptions = {}): Schema<number> {
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
      type: options.integer === true ? 'integer' : 'number',
      ...(options.description === undefined
        ? {}
        : { description: options.description }),
      ...(options.minimum === undefined ? {} : { minimum: options.minimum }),
      ...(options.maximum === undefined ? {} : { maximum: options.maximum }),
    },
    safeParse(input, path = []) {
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
    jsonSchema: {},
    safeParse(input) {
      return success(input);
    },
  };
}

type Literal = string | number | boolean | null;

export function literal<const Values extends readonly [Literal, ...Literal[]]>(
  ...allowed: Values
): Schema<Values[number]> {
  return {
    jsonSchema: { enum: allowed },
    safeParse(input, path = []) {
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

export interface ArrayOptions {
  readonly minItems?: number;
  readonly description?: string;
}

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

      const output: Element[] = [];
      const issues: ValidationIssue[] = [];
      for (const [index, value] of input.entries()) {
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

export function optional<Output>(inner: Schema<Output>): OptionalSchema<Output> {
  return {
    optional: true,
    inner,
    jsonSchema: inner.jsonSchema,
    safeParse(input, path = []) {
      return input === undefined
        ? success(undefined)
        : inner.safeParse(input, path);
    },
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function isOptionalSchema(schema: AnySchema): schema is OptionalSchema<unknown> {
  return Object.hasOwn(schema, 'optional') &&
    Reflect.get(schema, 'optional') === true;
}

export interface ObjectOptions {
  readonly unknownKeys?: UnknownKeyPolicy;
  readonly description?: string;
}

export function object<const Shape extends SchemaShape>(
  shape: Shape,
  options: ObjectOptions = {},
): Schema<InferShape<Shape>> {
  const unknownKeys = options.unknownKeys ?? 'strict';
  const shapeKeys = Object.keys(shape);
  const required = shapeKeys.filter((key) => {
    const field = shape[key];
    return field !== undefined && !isOptionalSchema(field);
  });

  return {
    jsonSchema: {
      type: 'object',
      properties: Object.fromEntries(
        shapeKeys.map((key) => [key, shape[key]?.jsonSchema ?? {}]),
      ),
      required,
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

      for (const key of shapeKeys) {
        const fieldSchema = shape[key];
        if (fieldSchema === undefined) continue;

        const present = Object.hasOwn(input, key);
        if (!present && isOptionalSchema(fieldSchema)) {
          continue;
        }
        if (!present) {
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

      for (const key of Object.keys(input)) {
        if (Object.hasOwn(shape, key)) continue;

        if (unknownKeys === 'strict') {
          issues.push(makeIssue(
            'unknown_key',
            [...path, key],
            `不允许未知字段 ${key}`,
            input[key],
            'known key',
          ));
        } else if (unknownKeys === 'passthrough') {
          Object.defineProperty(output, key, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: input[key],
          });
        }
      }

      return issues.length === 0
        ? success(output as InferShape<Shape>)
        : { ok: false, error: issues };
    },
  };
}

export function union<
  const Schemas extends readonly [AnySchema, AnySchema, ...AnySchema[]],
>(...schemas: Schemas): Schema<Infer<Schemas[number]>> {
  return {
    jsonSchema: { anyOf: schemas.map((schema) => schema.jsonSchema) },
    safeParse(input, path = []) {
      const branchIssues: ValidationIssue[] = [];
      for (const schema of schemas) {
        const parsed = schema.safeParse(input, path);
        if (parsed.ok) return success(parsed.value as Infer<Schemas[number]>);
        branchIssues.push(...parsed.error);
      }
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

export function refine<Input, Refined extends Input>(
  schema: Schema<Input>,
  predicate: (value: Input) => value is Refined,
  message: string,
): Schema<Refined>;
export function refine<Input>(
  schema: Schema<Input>,
  predicate: (value: Input) => boolean,
  message: string,
): Schema<Input>;
export function refine<Input>(
  schema: Schema<Input>,
  predicate: (value: Input) => boolean,
  message: string,
): Schema<Input> {
  return {
    jsonSchema: schema.jsonSchema,
    safeParse(input, path = []) {
      const parsed = schema.safeParse(input, path);
      if (!parsed.ok) return parsed;
      return predicate(parsed.value)
        ? parsed
        : failure(makeIssue('custom', path, message, input));
    },
  };
}

export function transform<Input, Output>(
  schema: Schema<Input>,
  mapper: (value: Input) => Output,
): Schema<Output> {
  return {
    // JSON Schema 仍描述 wire input；Output 是解析后的领域表示。
    jsonSchema: schema.jsonSchema,
    safeParse(input, path = []) {
      const parsed = schema.safeParse(input, path);
      return parsed.ok ? success(mapper(parsed.value)) : parsed;
    },
  };
}

export class ValidationError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super(
      issues.map((issue) => `${issue.pointer || '/'}: ${issue.message}`).join('; '),
    );
    this.name = 'ValidationError';
  }
}

export function parse<Output>(schema: Schema<Output>, input: unknown): Output {
  const result = schema.safeParse(input);
  if (result.ok) return result.value;
  throw new ValidationError(result.error);
}
