/**
 * ============================================================
 * 第 13 课：类型安全的标准装饰器
 * ============================================================
 *
 * 运行：npx tsx src/13-decorators.ts
 *
 * 这是 TC39 标准装饰器语义，不是 `experimentalDecorators` 的旧式三参数 API。
 * 装饰器在类定义阶段运行，是会被 emit 到 JavaScript 的元编程；它不是类型注解。
 *
 * 本课集中验证：
 *
 * 1. 泛型方法装饰器必须保持 this、参数元组和返回值之间的关系；
 * 2. 工厂从上到下求值，装饰器从下到上应用；
 * 3. `addInitializer` 的实例初始化时机与 this 绑定；
 * 4. 字段装饰器返回的是初值转换器，不是属性描述符；
 * 5. 类装饰器新增的运行时字段不会自动扩宽原 class 的静态实例类型。
 *
 * 第 26 课继续深入 accessor、metadata、emit helper 和完整初始化顺序。
 */

import assert from 'node:assert/strict';

type Method<This, Args extends unknown[], Return> = (
  this: This,
  ...args: Args
) => Return;

const methodLog: string[] = [];

// ------------------------------------------------------------
// 1. 保持完整调用关系的泛型方法装饰器
// ------------------------------------------------------------

function logged<This, Args extends unknown[], Return>(
  original: Method<This, Args, Return>,
  context: ClassMethodDecoratorContext<This, Method<This, Args, Return>>,
): Method<This, Args, Return> {
  const name = String(context.name);

  return function (this: This, ...args: Args): Return {
    methodLog.push(`${name}:before:${JSON.stringify(args)}`);
    try {
      return original.call(this, ...args);
    } finally {
      methodLog.push(`${name}:after`);
    }
  };
}

/**
 * 专用装饰器比 `(...args: any[]) => any` 更有价值：它明确要求第一个参数为 number，
 * 同时保留剩余参数和返回类型。把 any 写进公共装饰器会切断调用方的推断链。
 */
function minimum(minimumValue: number) {
  return function <This, Rest extends unknown[], Return>(
    original: Method<This, [value: number, ...rest: Rest], Return>,
    context: ClassMethodDecoratorContext<
      This,
      Method<This, [value: number, ...rest: Rest], Return>
    >,
  ): Method<This, [value: number, ...rest: Rest], Return> {
    assert.equal(context.kind, 'method');

    return function (
      this: This,
      value: number,
      ...rest: Rest
    ): Return {
      return original.call(this, Math.max(value, minimumValue), ...rest);
    };
  };
}

// ------------------------------------------------------------
// 2. 字段装饰器返回“每个实例各调用一次”的初值转换器
// ------------------------------------------------------------

function uppercase<This>(
  _unused: undefined,
  context: ClassFieldDecoratorContext<This, string>,
): (this: This, initialValue: string) => string {
  assert.equal(context.kind, 'field');

  return function (this: This, initialValue: string): string {
    return initialValue.toUpperCase();
  };
}

// ------------------------------------------------------------
// 3. addInitializer 在实例字段初始化前绑定方法
// ------------------------------------------------------------

function bound<This, Args extends unknown[], Return>(
  _original: Method<This, Args, Return>,
  context: ClassMethodDecoratorContext<This, Method<This, Args, Return>>,
): void {
  if (context.private) {
    throw new TypeError(`@bound 不支持私有成员 ${String(context.name)}`);
  }
  if (context.static) {
    throw new TypeError(`@bound 只用于实例方法 ${String(context.name)}`);
  }

  context.addInitializer(function (this: This): void {
    const current = context.access.get(this);
    Object.defineProperty(this as object, context.name, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: current.bind(this),
    });
  });
}

// ------------------------------------------------------------
// 4. 类装饰器的“运行时增强、静态不增宽”边界
// ------------------------------------------------------------

interface Timestamped {
  readonly createdAt: string;
}

// TS 的 mixin 构造规则要求“单个 any[] rest 参数”。这里的 any 只用于把原构造参数
// 原样转发给 super，不读取也不改写参数；公共实例关系仍由 Target 保存。
type MixinConstructor = new (...args: any[]) => object;

function withTimestamp<Target extends MixinConstructor>(
  Original: Target,
  context: ClassDecoratorContext<Target>,
): Target {
  assert.equal(context.kind, 'class');

  const Replacement = class extends Original implements Timestamped {
    constructor(...args: any[]) {
      super(...args);
    }

    readonly createdAt = new Date().toISOString();
  };

  // 标准类装饰器必须返回可替换原构造器的值。这里的断言刻意把“新增字段”隐藏起来，
  // 因为装饰器语法不会改写 class declaration 暴露给调用方的实例类型。
  return Replacement as Target;
}

@withTimestamp
class Calculator {
  constructor(readonly scale: number) {}

  @uppercase
  label = 'calc';

  @logged
  add(left: number, right: number): number {
    return (left + right) * this.scale;
  }

  @minimum(0)
  setLevel(level: number): number {
    return level;
  }

  @bound
  greet(prefix: string): string {
    return `${prefix} from ${this.label}`;
  }
}

const calculator = new Calculator(1);
const sum: number = calculator.add(2, 3);
assert.equal(sum, 5);
assert.deepEqual(methodLog, ['add:before:[2,3]', 'add:after']);
assert.equal(calculator.label, 'CALC');
assert.equal(calculator.setLevel(-5), 0);

const detached = calculator.greet;
assert.equal(detached('hello'), 'hello from CALC');
assert.equal(Object.hasOwn(calculator, 'greet'), true);

// @withTimestamp 返回的是 `class extends Original`：公开的 Calculator.prototype
// 是替换子类的空原型，原方法保留在它的父原型。@bound 又在实例上创建同名绑定方法。
assert.equal(
  Object.prototype.hasOwnProperty.call(Calculator.prototype, 'greet'),
  false,
);
const originalCalculatorPrototype: unknown = Object.getPrototypeOf(
  Calculator.prototype,
);
assert.equal(
  typeof originalCalculatorPrototype === 'object' &&
    originalCalculatorPrototype !== null &&
    Object.prototype.hasOwnProperty.call(originalCalculatorPrototype, 'greet'),
  true,
);

const runtimeTimestamp: unknown = Reflect.get(calculator, 'createdAt');
assert.equal(typeof runtimeTimestamp, 'string');

if (false) {
  // @ts-expect-error logged 保持 number 返回关系，没有把它退化成 any。
  const wrongResult: string = calculator.add(1, 2);

  // @ts-expect-error 类装饰器新增值不会自动出现在 Calculator 的静态实例类型中。
  console.log(calculator.createdAt);

  // @ts-expect-error 类装饰器替换构造器后仍保持原构造参数契约。
  new Calculator();

  console.log(wrongResult);
}

// ------------------------------------------------------------
// 5. 求值顺序与应用顺序不是一回事
// ------------------------------------------------------------

const decoratorOrder: string[] = [];

function traced(label: string) {
  decoratorOrder.push(`evaluate:${label}`);

  return function <This, Args extends unknown[], Return>(
    original: Method<This, Args, Return>,
    _context: ClassMethodDecoratorContext<This, Method<This, Args, Return>>,
  ): Method<This, Args, Return> {
    decoratorOrder.push(`apply:${label}`);

    return function (this: This, ...args: Args): Return {
      decoratorOrder.push(`call:${label}:before`);
      try {
        return original.call(this, ...args);
      } finally {
        decoratorOrder.push(`call:${label}:after`);
      }
    };
  };
}

class OrderProbe {
  @traced('outer')
  @traced('inner')
  run(): 'body' {
    decoratorOrder.push('call:body');
    return 'body';
  }
}

assert.deepEqual(decoratorOrder, [
  'evaluate:outer',
  'evaluate:inner',
  'apply:inner',
  'apply:outer',
]);

assert.equal(new OrderProbe().run(), 'body');
assert.deepEqual(decoratorOrder, [
  'evaluate:outer',
  'evaluate:inner',
  'apply:inner',
  'apply:outer',
  'call:outer:before',
  'call:inner:before',
  'call:body',
  'call:inner:after',
  'call:outer:after',
]);

console.log('=== 第 13 课：类型安全标准装饰器 ===');
console.log({
  label: calculator.label,
  sum,
  level: calculator.setLevel(-5),
  detached: detached('hi'),
  runtimeTimestamp,
  methodLog,
  decoratorOrder,
});

export {};
