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
// 否则 @component / @tool 写入 context.metadata 时会落到一个未公开的字段上，
// AgentTools[Symbol.metadata] 也就取不到这些 metadata。
if (Symbol.metadata === undefined) {
  Object.defineProperty(Symbol, 'metadata', {
    value: Symbol('Symbol.metadata'),
    configurable: true,
  });
}

// orderLog：把装饰器求值/应用/调用各阶段都记下来，方便用 assert.deepEqual 验证顺序。
const orderLog: string[] = [];

// AnyMethod：统一的“带 this 的方法签名”描述，方便装饰器签名里复用，
// 也保证被包装后的函数与原函数在 this/参数/返回值上保持一致类型。
type AnyMethod<This, Args extends unknown[], Result> = (
  this: This,
  ...args: Args
) => Result;

// traceOrder：一个“工厂型”装饰器 —— 外层 traceOrder(label) 在类求值时被调用，
// 返回真正的 decorator function。
function traceOrder(label: string) {
  // 这一行在“装饰器表达式求值”阶段执行：类定义被解析时立即跑，按从上到下顺序。
  orderLog.push(`factory:${label}`);

  // 返回的才是 decorator：它在“装饰器应用”阶段被调用，从下到上依次包裹方法。
  return function <This, Args extends unknown[], Result>(
    original: AnyMethod<This, Args, Result>,
    context: ClassMethodDecoratorContext<This, AnyMethod<This, Args, Result>>,
  ): AnyMethod<This, Args, Result> {
    // 应用阶段记录：哪个 label、装饰在哪个方法名上。
    // 注意：应用顺序是从下到上 —— 内层先 apply，外层后 apply，形成洋葱式包裹。
    orderLog.push(`apply:${label}:${String(context.name)}`);

    // 返回新函数替换原方法 —— 标准装饰器允许“返回值替代被装饰元素”。
    // 这里 wrapper 记录 enter/exit，从而运行时也能在 orderLog 里看到调用顺序。
    return function (this: This, ...args: Args): Result {
      orderLog.push(`enter:${label}`);
      try {
        // 用 .apply(this, args) 保留原方法的 this 与参数语义。
        return original.apply(this, args);
      } finally {
        orderLog.push(`exit:${label}`);
      }
    };
  };
}

// OrderProbe：被装饰的样例类。两个 @traceOrder 叠加在 execute 上，
// 用来观察“表达式从上到下、应用从下到上”的经典规则。
class OrderProbe {
  // 表达式从上到下：先求值 traceOrder('outer')，再求值 traceOrder('inner')。
  @traceOrder('outer')
  @traceOrder('inner')
  execute(): string {
    // 方法体只在真正调用 execute() 时跑；它位于所有 wrapper 的最里层。
    orderLog.push('body');
    return 'ok';
  }
}

// 类定义阶段就应该完成的顺序：
//   两个 factory 按出现顺序求值，然后两个 apply 从下到上包裹（inner 先 apply）。
assert.deepEqual(orderLog, [
  'factory:outer',
  'factory:inner',
  'apply:inner:execute',
  'apply:outer:execute',
]);

// 真正调用 execute：外层先 enter、内层后 enter；返回时内层先 exit、外层后 exit。
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
// bound 装饰器本身不替换方法 —— 它返回 void。
// 它通过 context.addInitializer 注册一个回调，回调会在每个新实例初始化时执行，
// 在那里把方法读出来、bind(this)、定义为该实例的自有属性。
function bound<This, Args extends unknown[], Result>(
  _original: AnyMethod<This, Args, Result>,
  context: ClassMethodDecoratorContext<This, AnyMethod<This, Args, Result>>,
): void {
  // private 方法的 context.access 行为有边界 —— 这里直接拒绝以暴露问题。
  if (context.private) throw new Error('@bound 不支持 private method');

  // addInitializer 注册的函数在“实例字段初始化期间”同步执行。
  // 这时所有方法装饰器都已经应用完毕，context.access.get 能拿到最终函数。
  context.addInitializer(function (this: This) {
    // access.get 读取的是所有 method decorators 应用完成后的最终函数。
    // 因此即便 bound 与 @timed 叠加，bind 到的也是已被 timed 包裹的最终版本。
    const method = context.access.get(this);
    // 把方法定义为实例自有属性（而非原型上的方法），并预 bind this，
    // 这样“const fn = obj.method; fn(...)”也能保持正确的 this。
    Object.defineProperty(this, context.name, {
      value: method.bind(this),
      writable: true,
      configurable: true,
      enumerable: false,
    });
  });
}

// timed：返回一个 async wrapper，统计原方法（返回 Promise）耗时。
// 注意签名上把 Result 包在 Promise 里，装饰器只能修饰 async 方法。
function timed<This, Args extends unknown[], Result>(
  original: AnyMethod<This, Args, Promise<Result>>,
  context: ClassMethodDecoratorContext<This, AnyMethod<This, Args, Promise<Result>>>,
): AnyMethod<This, Args, Promise<Result>> {
  // 返回的新方法：先记起始时间，await 原方法，finally 里打印耗时。
  return async function (this: This, ...args: Args): Promise<Result> {
    const startedAt = performance.now();
    try {
      // await 让被装饰方法的异步错误也能进入 finally，保证计时总能打印。
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
// 标准装饰器里，字段装饰器第一个参数是 undefined（不是当前值），
// 它只能通过“返回一个 initializer 函数”来介入字段初值的计算。
function normalized(
  // 字段装饰器拿不到字段值：第一个参数固定为 undefined。
  _unused: undefined,
  context: ClassFieldDecoratorContext<unknown, string>,
): (initialValue: string) => string {
  // 返回的 initializer 在实例字段初始化时被调用，拿到原本的初值，返回新值。
  return (initialValue) => {
    // 规范化：去首尾空白 + 多个空白压成单空格。
    const value = initialValue.trim().replace(/\s+/gu, ' ');
    console.log(`initialize field ${String(context.name)} =`, value);
    return value;
  };
}

// clamp：装饰 auto-accessor。accessor 装饰器的 target 提供 get/set，
// 返回值可以包装 init/set（也可以包装 get）来实现自定义语义。
function clamp(min: number, max: number) {
  return function <This>(
    target: ClassAccessorDecoratorTarget<This, number>,
    context: ClassAccessorDecoratorContext<This, number>,
  ): ClassAccessorDecoratorResult<This, number> {
    // normalize：把任意输入夹到 [min, max] 区间，给 init 和 set 共用。
    const normalize = (value: number) => Math.min(max, Math.max(min, value));

    // 返回的对象会与原 target 合并：init 影响初值，set 拦截后续赋值。
    return {
      // init 改写字段初始值：构造实例时这里被调用一次。
      init(initialValue) {
        return normalize(initialValue);
      },
      // set 拦截写入：先 normalize，再委托给原 target.set 真正存储。
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
// 标准装饰器把 metadata 挂在类级（AgentTools[Symbol.metadata] 上），
// 每个成员装饰器 context.metadata 拿到的是同一个对象 —— 因此可以跨成员累积数据。
type ToolMetadata = {
  readonly methodName: PropertyKey;
  readonly toolName: string;
  readonly description: string;
};

// 用 Symbol 做 key：避免与用户写的同名字符串属性冲突，也保持类型上的“私有性”。
const TOOL_METADATA = Symbol('agent.tool.metadata');
const COMPONENT_METADATA = Symbol('agent.component.metadata');

// tool：方法级装饰器，把方法注册为“Agent 可调用的工具”，写入类级 metadata。
function tool(toolName: string, description: string) {
  return function <This, Args extends unknown[], Result>(
    _original: AnyMethod<This, Args, Result>,
    context: ClassMethodDecoratorContext<This, AnyMethod<This, Args, Result>>,
  ): void {
    // 读出已存在的工具列表（可能是上一次 @tool 写入的数组）。
    const existing = context.metadata[TOOL_METADATA];
    // 元数据在类型上只是“可能有任意属性”，因此读取后必须自己守卫/解析结构。
    const tools = Array.isArray(existing)
      ? existing as ToolMetadata[]
      : [];

    // 追加当前方法的注册项，再写回共享 metadata 对象。
    tools.push({
      methodName: context.name,
      toolName,
      description,
    });
    context.metadata[TOOL_METADATA] = tools;
  };
}

// component：类装饰器，把“组件名”写入类级 metadata，并通过 addInitializer 在
// 类完成定义时打印一行（类级 initializer 在类求值末尾、静态字段之后执行）。
function component(name: string) {
  return function (
    _value: Function,
    context: ClassDecoratorContext,
  ): void {
    context.metadata[COMPONENT_METADATA] = name;
    context.addInitializer(() => console.log(`class initialized: ${name}`));
  };
}

// AgentTools：把上面所有装饰器集中演示在一个类上。
// 字段 prompt 用 @normalized 改写初值；accessor temperature 用 @clamp 限幅；
// search 方法叠加 @tool / @bound / @timed —— 多装饰器协作的真实样例。
@component('agent-tools')
class AgentTools {
  // 字段初值会被 normalized 返回的 initializer 改写成“规范化的字符串”。
  @normalized
  prompt = '  learn   TypeScript deeply  ';

  // accessor 字段：auto-accessor 由装饰器包装 init/set，对调用方仍像普通字段。
  @clamp(0, 2)
  accessor temperature = 0.7;

  constructor(readonly prefix: string) {}

  // 顺序（自上而下表达式求值、自下而上应用）：
  //   tool 先被求值 → bound、timed 依次求值；应用顺序是 timed → bound → tool。
  // bound 通过 addInitializer 把最终（已 timed 包装）的方法 bind 到实例。
  @tool('search_docs', '在学习资料中检索')
  @bound
  @timed
  async search(query: string): Promise<string> {
    await Promise.resolve();
    // this.prefix 因为 bound 装饰器，即使把 search 拆离实例也能正确读到。
    return `${this.prefix}:${query}`;
  }
}

// 构造实例：触发字段 initializer、accessor init、bound 的 addInitializer 等。
const tools = new AgentTools('docs');
// 把方法引用“拆离”实例 —— 验证 @bound 的效果：未 bind 的方法 this 会丢失。
const detachedSearch = tools.search;
// 因为 bound，detachedSearch 仍持有 tools 作为 this，因此能正确返回 'docs:...'。
assert.equal(await detachedSearch('decorators'), 'docs:decorators');
// prompt 初值被 normalized 改写：多余空白被折叠。
assert.equal(tools.prompt, 'learn TypeScript deeply');

// accessor 限幅：写入 99 会被 clamp 到 2。
tools.temperature = 99;
assert.equal(tools.temperature, 2);

// 从类本身（而不是实例）读取 metadata：标准装饰器把它挂在静态 [Symbol.metadata] 上。
const metadata = AgentTools[Symbol.metadata];
assert.ok(metadata != null);
// 类装饰器写入的 COMPONENT_METADATA 应该是我们注册的名字。
assert.equal(metadata[COMPONENT_METADATA], 'agent-tools');

// 方法装饰器们累积的 TOOL_METADATA 是一个数组，里面是所有被 @tool 标注的方法。
const registeredTools = metadata[TOOL_METADATA];
assert.ok(Array.isArray(registeredTools));
console.log('Decorator metadata:', registeredTools);

// metadata 的类型只说明“可能有属性”，不会验证具体结构；读取后仍需守卫/解析。
// 标准装饰器也不会自动生成 Java 反射式参数类型信息。

console.log('=== 第 26 课完成：装饰器是运行时代码变换，不是静态注解标签 ===');

export {};
