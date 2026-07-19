/**
 * ============================================================
 * 第 26 课：标准装饰器底层 —— 求值顺序、替换、initializer 与 metadata
 * ============================================================
 *
 * 注意：本课使用 TypeScript 5+ 标准装饰器，不开启 experimentalDecorators。
 * 它和旧版 Stage 2/legacy 装饰器的参数、metadata 与 emit 完全不同。
 *
 * 本课验证：
 *   1. 同一元素的装饰器表达式从上到下求值，函数从下到上应用
 *   2. 方法装饰器接收函数值，可返回替换函数形成 wrapper 链
 *   3. addInitializer 在每个实例初始化期间执行，可实现自动 bind
 *   4. 字段装饰器返回 initializer，不能直接拿到实例字段值
 *   5. auto-accessor 装饰器可包装 get/set/init
 *   6. context.metadata 是类级共享 metadata 对象，需要 Symbol.metadata 运行时支持
 *
 * 运行：npm run lesson:decorators-deep
 */

import assert from 'node:assert/strict';

// Node 24 当前没有原生 Symbol.metadata。lib 声明只让 Checker 知道 API，
// 运行时仍需 polyfill；必须在任何 decorated class 求值之前安装。
if (Symbol.metadata === undefined) {
  Object.defineProperty(Symbol, 'metadata', {
    value: Symbol('Symbol.metadata'),
    configurable: true,
  });
}

const orderLog: string[] = [];

type AnyMethod<This, Args extends unknown[], Result> = (
  this: This,
  ...args: Args
) => Result;

function traceOrder(label: string) {
  orderLog.push(`factory:${label}`);

  return function <This, Args extends unknown[], Result>(
    original: AnyMethod<This, Args, Result>,
    context: ClassMethodDecoratorContext<This, AnyMethod<This, Args, Result>>,
  ): AnyMethod<This, Args, Result> {
    orderLog.push(`apply:${label}:${String(context.name)}`);

    return function (this: This, ...args: Args): Result {
      orderLog.push(`enter:${label}`);
      try {
        return original.apply(this, args);
      } finally {
        orderLog.push(`exit:${label}`);
      }
    };
  };
}

class OrderProbe {
  @traceOrder('outer')
  @traceOrder('inner')
  execute(): string {
    orderLog.push('body');
    return 'ok';
  }
}

assert.deepEqual(orderLog, [
  'factory:outer',
  'factory:inner',
  'apply:inner:execute',
  'apply:outer:execute',
]);

assert.equal(new OrderProbe().execute(), 'ok');
assert.deepEqual(orderLog.slice(-5), [
  'enter:outer',
  'enter:inner',
  'body',
  'exit:inner',
  'exit:outer',
]);
console.log('装饰器顺序:', orderLog);

// ------------------------------------------------------------
// addInitializer：在实例创建时把最终方法绑定为自有属性
// ------------------------------------------------------------
function bound<This, Args extends unknown[], Result>(
  _original: AnyMethod<This, Args, Result>,
  context: ClassMethodDecoratorContext<This, AnyMethod<This, Args, Result>>,
): void {
  if (context.private) throw new Error('@bound 不支持 private method');

  context.addInitializer(function (this: This) {
    // access.get 读取的是所有 method decorators 应用完成后的最终函数。
    const method = context.access.get(this);
    Object.defineProperty(this, context.name, {
      value: method.bind(this),
      writable: true,
      configurable: true,
      enumerable: false,
    });
  });
}

function timed<This, Args extends unknown[], Result>(
  original: AnyMethod<This, Args, Promise<Result>>,
  context: ClassMethodDecoratorContext<This, AnyMethod<This, Args, Promise<Result>>>,
): AnyMethod<This, Args, Promise<Result>> {
  return async function (this: This, ...args: Args): Promise<Result> {
    const startedAt = performance.now();
    try {
      return await original.apply(this, args);
    } finally {
      const elapsed = performance.now() - startedAt;
      console.log(`method ${String(context.name)}: ${elapsed.toFixed(2)}ms`);
    }
  };
}

// ------------------------------------------------------------
// 字段与 accessor：两者拿到的装饰器 target 不同
// ------------------------------------------------------------
function normalized(
  _unused: undefined,
  context: ClassFieldDecoratorContext<unknown, string>,
): (initialValue: string) => string {
  return (initialValue) => {
    const value = initialValue.trim().replace(/\s+/gu, ' ');
    console.log(`initialize field ${String(context.name)} =`, value);
    return value;
  };
}

function clamp(min: number, max: number) {
  return function <This>(
    target: ClassAccessorDecoratorTarget<This, number>,
    context: ClassAccessorDecoratorContext<This, number>,
  ): ClassAccessorDecoratorResult<This, number> {
    const normalize = (value: number) => Math.min(max, Math.max(min, value));

    return {
      init(initialValue) {
        return normalize(initialValue);
      },
      set(value) {
        console.log(`set accessor ${String(context.name)} =`, value);
        target.set.call(this, normalize(value));
      },
    };
  };
}

// ------------------------------------------------------------
// Metadata：同一个 decorated class 的各成员共享 context.metadata 对象
// ------------------------------------------------------------
type ToolMetadata = {
  readonly methodName: PropertyKey;
  readonly toolName: string;
  readonly description: string;
};

const TOOL_METADATA = Symbol('agent.tool.metadata');
const COMPONENT_METADATA = Symbol('agent.component.metadata');

function tool(toolName: string, description: string) {
  return function <This, Args extends unknown[], Result>(
    _original: AnyMethod<This, Args, Result>,
    context: ClassMethodDecoratorContext<This, AnyMethod<This, Args, Result>>,
  ): void {
    const existing = context.metadata[TOOL_METADATA];
    const tools = Array.isArray(existing)
      ? existing as ToolMetadata[]
      : [];

    tools.push({
      methodName: context.name,
      toolName,
      description,
    });
    context.metadata[TOOL_METADATA] = tools;
  };
}

function component(name: string) {
  return function (
    _value: Function,
    context: ClassDecoratorContext,
  ): void {
    context.metadata[COMPONENT_METADATA] = name;
    context.addInitializer(() => console.log(`class initialized: ${name}`));
  };
}

@component('agent-tools')
class AgentTools {
  @normalized
  prompt = '  learn   TypeScript deeply  ';

  @clamp(0, 2)
  accessor temperature = 0.7;

  constructor(readonly prefix: string) {}

  @tool('search_docs', '在学习资料中检索')
  @bound
  @timed
  async search(query: string): Promise<string> {
    await Promise.resolve();
    return `${this.prefix}:${query}`;
  }
}

const tools = new AgentTools('docs');
const detachedSearch = tools.search;
assert.equal(await detachedSearch('decorators'), 'docs:decorators');
assert.equal(tools.prompt, 'learn TypeScript deeply');

tools.temperature = 99;
assert.equal(tools.temperature, 2);

const metadata = AgentTools[Symbol.metadata];
assert.ok(metadata != null);
assert.equal(metadata[COMPONENT_METADATA], 'agent-tools');

const registeredTools = metadata[TOOL_METADATA];
assert.ok(Array.isArray(registeredTools));
console.log('Decorator metadata:', registeredTools);

// metadata 的类型只说明“可能有属性”，不会验证具体结构；读取后仍需守卫/解析。
// 标准装饰器也不会自动生成 Java 反射式参数类型信息。

console.log('=== 第 26 课完成：装饰器是运行时代码变换，不是静态注解标签 ===');

export {};
