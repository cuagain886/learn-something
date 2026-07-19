import {
  type Schema,
  type ValidationIssue,
  toJsonPointer,
} from '../17-schema.js';
import type {
  JsonValue,
  ToolDescriptor,
  ToolExecutionResult,
  ToolFailure,
} from './domain.js';

export interface ToolContext {
  readonly runId: string;
  readonly step: number;
  readonly callId: string;
  readonly signal: AbortSignal;
  readonly grantedPermissions: ReadonlySet<string>;
}

export interface ToolDefinition<Name extends string, Input, Output extends JsonValue> {
  readonly descriptor: ToolDescriptor & { readonly name: Name };
  readonly inputSchema: Schema<Input>;

  invokeRaw(
    raw: unknown,
    context: ToolContext,
  ): Promise<ToolExecutionResult<Output>>;

  invokeParsed(
    input: Input,
    context: ToolContext,
  ): Promise<ToolExecutionResult<Output>>;

  readonly __types?: {
    readonly input: Input;
    readonly output: Output;
  };
}

export type AnyTool = ToolDefinition<string, unknown, JsonValue>;
type ToolName<Tools extends readonly AnyTool[]> =
  Tools[number]['descriptor']['name'];
type ToolByName<
  Tools extends readonly AnyTool[],
  Name extends ToolName<Tools>,
> = Extract<
  Tools[number],
  { readonly descriptor: { readonly name: Name } }
>;
type InputOf<Tool extends AnyTool> = NonNullable<Tool['__types']>['input'];
type OutputOf<Tool extends AnyTool> = NonNullable<Tool['__types']>['output'];

function issue(
  code: ValidationIssue['code'],
  path: readonly (string | number)[],
  message: string,
  received: string,
): ValidationIssue {
  return {
    code,
    path,
    pointer: toJsonPointer(path),
    message,
    received,
  };
}

type JsonValidation =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/**
 * 工具输出在进入模型消息前做 JSON 安全复制：
 *
 * - number 必须 finite；NaN/Infinity 虽满足 TS number，却不是 JSON number；
 * - 只接受 array 和 plain/null-prototype object；
 * - 拒绝循环引用、symbol key、accessor/getter 和稀疏数组；
 * - 通过 defineProperty 写白名单 clone，避免 __proto__ setter。
 */
function validateJsonValue(input: unknown): JsonValidation {
  const active = new WeakSet<object>();

  function visit(
    value: unknown,
    path: readonly (string | number)[],
  ): JsonValidation {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean'
    ) {
      return { ok: true, value };
    }

    if (typeof value === 'number') {
      return Number.isFinite(value)
        ? { ok: true, value }
        : {
            ok: false,
            issues: [issue(
              'not_json_value',
              path,
              'JSON number 必须是有限数字',
              String(value),
            )],
          };
    }

    if (typeof value !== 'object' || value === null) {
      return {
        ok: false,
        issues: [issue(
          'not_json_value',
          path,
          '值不是 JSON 可表达类型',
          typeof value,
        )],
      };
    }

    if (active.has(value)) {
      return {
        ok: false,
        issues: [issue(
          'cyclic_value',
          path,
          'JSON 输出不能包含循环引用',
          'object',
        )],
      };
    }
    active.add(value);

    try {
      if (Array.isArray(value)) {
        const output: JsonValue[] = [];
        const issues: ValidationIssue[] = [];

        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (descriptor === undefined) {
            issues.push(issue(
              'not_json_value',
              [...path, index],
              '拒绝会被 JSON.stringify 隐式变成 null 的稀疏数组槽位',
              'missing',
            ));
            continue;
          }
          if (!('value' in descriptor)) {
            issues.push(issue(
              'accessor_property',
              [...path, index],
              '输出数组不能包含 accessor/getter',
              'accessor',
            ));
            continue;
          }

          const parsed = visit(descriptor.value, [...path, index]);
          if (parsed.ok) output[index] = parsed.value;
          else issues.push(...parsed.issues);
        }

        const extraKeys = Reflect.ownKeys(value).filter((key) => {
          if (key === 'length') return false;
          if (typeof key === 'symbol') return true;
          return !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length;
        });
        for (const key of extraKeys) {
          issues.push(issue(
            'not_json_value',
            [...path, String(key)],
            '数组包含 JSON 会忽略的额外属性或 symbol key',
            typeof key,
          ));
        }

        return issues.length === 0
          ? { ok: true, value: output }
          : { ok: false, issues };
      }

      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        return {
          ok: false,
          issues: [issue(
            'not_json_value',
            path,
            '只接受 plain object 或 null-prototype object',
            'custom prototype',
          )],
        };
      }

      const output: Record<string, JsonValue> = {};
      const issues: ValidationIssue[] = [];
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') {
          issues.push(issue(
            'not_json_value',
            [...path, String(key)],
            'JSON object 不支持 symbol key',
            'symbol',
          ));
          continue;
        }

        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !descriptor.enumerable) continue;
        if (!('value' in descriptor)) {
          issues.push(issue(
            'accessor_property',
            [...path, key],
            '输出对象不能包含 accessor/getter',
            'accessor',
          ));
          continue;
        }

        const parsed = visit(descriptor.value, [...path, key]);
        if (!parsed.ok) {
          issues.push(...parsed.issues);
          continue;
        }
        Object.defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: parsed.value,
        });
      }

      return issues.length === 0
        ? { ok: true, value: output }
        : { ok: false, issues };
    } finally {
      active.delete(value);
    }
  }

  return visit(input, []);
}

function cancelled(signal: AbortSignal): ToolFailure {
  return { code: 'CANCELLED', reason: signal.reason };
}

export function defineTool<
  const Name extends string,
  Input,
  Output extends JsonValue,
>(definition: {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: Schema<Input>;
  readonly requiredPermission?: string;
  readonly execute: (
    input: Input,
    context: ToolContext,
  ) => Promise<Output>;
}): ToolDefinition<Name, Input, Output> {
  function checkAccess(context: ToolContext): ToolFailure | undefined {
    if (context.signal.aborted) return cancelled(context.signal);

    const permission = definition.requiredPermission;
    if (
      permission !== undefined &&
      !context.grantedPermissions.has(permission)
    ) {
      return {
        code: 'FORBIDDEN',
        toolName: definition.name,
        requiredPermission: permission,
      };
    }
    return undefined;
  }

  async function executeParsed(
    input: Input,
    context: ToolContext,
  ): Promise<ToolExecutionResult<Output>> {
    const accessError = checkAccess(context);
    if (accessError !== undefined) return { ok: false, error: accessError };

    try {
      const rawOutput: unknown = await definition.execute(input, context);
      const validated = validateJsonValue(rawOutput);
      if (!validated.ok) {
        return {
          ok: false,
          error: { code: 'INVALID_OUTPUT', issues: validated.issues },
        };
      }
      // Output 的静态契约由 defineTool execute 签名检查；运行时 clone 已证明 JsonValue。
      return { ok: true, value: validated.value as Output };
    } catch (cause: unknown) {
      return context.signal.aborted
        ? { ok: false, error: cancelled(context.signal) }
        : { ok: false, error: { code: 'EXECUTION_FAILED', cause } };
    }
  }

  return {
    descriptor: {
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema.jsonSchema,
      ...(definition.requiredPermission === undefined
        ? {}
        : { requiredPermission: definition.requiredPermission }),
    },
    inputSchema: definition.inputSchema,

    async invokeRaw(raw, context) {
      // 未授权调用不返回字段级解析错误，避免协议探测。
      const accessError = checkAccess(context);
      if (accessError !== undefined) return { ok: false, error: accessError };

      let parsed: ReturnType<Schema<Input>['safeParse']>;
      try {
        parsed = definition.inputSchema.safeParse(raw);
      } catch (cause: unknown) {
        // Schema 抛异常表示工具实现缺陷，不是用户参数错误。
        return { ok: false, error: { code: 'EXECUTION_FAILED', cause } };
      }
      if (!parsed.ok) {
        return {
          ok: false,
          error: { code: 'INVALID_ARGUMENTS', issues: parsed.error },
        };
      }
      return executeParsed(parsed.value, context);
    },

    invokeParsed(input, context) {
      // transform 后领域值不能再次被当作 wire input parse。
      return executeParsed(input, context);
    },
  };
}

type DuplicateNames<
  Tools extends readonly AnyTool[],
  Seen extends string = never,
> = Tools extends readonly [
  infer Head extends AnyTool,
  ...infer Tail extends readonly AnyTool[],
]
  ? Head['descriptor']['name'] extends Seen
    ? Head['descriptor']['name'] | DuplicateNames<Tail, Seen>
    : DuplicateNames<Tail, Seen | Head['descriptor']['name']>
  : never;

type UniqueConstraint<Tools extends readonly AnyTool[]> =
  [DuplicateNames<Tools>] extends [never]
    ? unknown
    : { readonly __duplicateToolNames: DuplicateNames<Tools> };

export class ToolRegistry<const Tools extends readonly AnyTool[]> {
  readonly #byName: ReadonlyMap<string, AnyTool>;

  constructor(readonly tools: Tools) {
    const byName = new Map<string, AnyTool>();
    for (const tool of tools) {
      const name = tool.descriptor.name;
      if (byName.has(name)) throw new Error(`工具名重复: ${name}`);
      byName.set(name, tool);
    }
    this.#byName = byName;
  }

  descriptors(): readonly ToolDescriptor[] {
    return structuredClone(this.tools.map((tool) => tool.descriptor));
  }

  invokeDynamic(
    name: string,
    raw: unknown,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const tool = this.#byName.get(name);
    if (tool === undefined) {
      return Promise.resolve({
        ok: false,
        error: { code: 'UNKNOWN_TOOL', toolName: name },
      });
    }
    return tool.invokeRaw(raw, context);
  }

  invokeKnown<Name extends ToolName<Tools>>(
    name: Name,
    input: InputOf<ToolByName<Tools, Name>>,
    context: ToolContext,
  ): Promise<ToolExecutionResult<OutputOf<ToolByName<Tools, Name>>>> {
    const erased = this.#byName.get(name);
    if (erased === undefined) {
      return Promise.resolve({
        ok: false,
        error: { code: 'UNKNOWN_TOOL', toolName: name },
      });
    }

    // Map 只按 descriptor.name 建立并拒绝重复，故此处可恢复具体 name/input/output。
    const tool = erased as ToolByName<Tools, Name>;
    return tool.invokeParsed(input, context);
  }
}

export function createToolRegistry<const Tools extends readonly AnyTool[]>(
  tools: Tools & UniqueConstraint<Tools>,
): ToolRegistry<Tools> {
  return new ToolRegistry(tools);
}
