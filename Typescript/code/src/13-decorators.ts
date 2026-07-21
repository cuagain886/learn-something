import assert from 'node:assert/strict';

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

// Method：把“带 this 类型的函数”完整描述出来。
// `this: This` 是显式 this 参数，让装饰后的函数仍能保持原方法的 this 类型关系；
// ...args: Args 用 rest 元组保留“位置 + 类型”的精确签名（而不是 any[]）。
type Method<This, Args extends unknown[], Return> = (
  this: This,
  ...args: Args
) => Return;

// 收集方法装饰器在调用时记录的事件，便于在断言里验证调用顺序与参数。
const methodLog: string[] = [];

// ------------------------------------------------------------
// 1. 保持完整调用关系的泛型方法装饰器
// ------------------------------------------------------------
// 标准方法装饰器签名：(original, context) => replacement | void。
// 把装饰器写成泛型 <This, Args, Return> 才能让“替换函数”严格保留原方法的调用契约。

function logged<This, Args extends unknown[], Return>(
  original: Method<This, Args, Return>,
  // context 携带 kind/name/static/private/access/addInitializer 等元信息。
  context: ClassMethodDecoratorContext<This, Method<This, Args, Return>>,
): Method<This, Args, Return> {
  // context.name 可能是 symbol | string | undefined；转成字符串便于日志拼接。
  const name = String(context.name);

  // 返回的 replacement 必须与 original 同形：this: This + ...args: Args + Return。
  // 用 .call(this, ...) 转发，保证原方法里的 this 仍是调用方实例。
  return function (this: This, ...args: Args): Return {
    methodLog.push(`${name}:before:${JSON.stringify(args)}`);
    try {
      return original.call(this, ...args);
    } finally {
      methodLog.push(`${name}:after`); // finally 保证即便抛错也记录 after
    }
  };
}

/**
 * 专用装饰器比 `(...args: any[]) => any` 更有价值：它明确要求第一个参数为 number，
 * 同时保留剩余参数和返回类型。把 any 写进公共装饰器会切断调用方的推断链。
 */
// minimum 是工厂：先调用 minimum(0) 拿到真正的装饰器。工厂让我们能参数化阈值。
function minimum(minimumValue: number) {
  // 这里才是装饰器本体：<This, Rest, Return> 保留调用关系。
  // 第一个参数固定为 number（值校验的对象），剩余 ...rest 用元组 Rest 保留。
  return function <This, Rest extends unknown[], Return>(
    original: Method<This, [value: number, ...rest: Rest], Return>,
    context: ClassMethodDecoratorContext<
      This,
      Method<This, [value: number, ...rest: Rest], Return>
    >,
  ): Method<This, [value: number, ...rest: Rest], Return> {
    // 运行时验证 context.kind：防御性地确认这是用在方法上，而非字段/类。
    assert.equal(context.kind, 'method');

    // replacement 用 Math.max 把传入值钳到下限，其余参数原样转发。
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
// 标准字段装饰器：第一参数是 undefined（字段当前还没有初值），
// 返回值是一个“初值转换器”，每个实例初始化字段时各调用一次（不是类定义时一次）。

function uppercase<This>(
  // _unused 是字段“当前值”——在标准装饰器里它永远是 undefined（字段尚未赋初值）。
  _unused: undefined,
  context: ClassFieldDecoratorContext<This, string>,
  // 返回类型必须是 (initialValue: string) => string：每个实例初始化时各跑一次。
): (this: This, initialValue: string) => string {
  assert.equal(context.kind, 'field');

  // 这里返回的函数会在每个实例初始化该字段时被调用一次（不是类定义时一次）。
  return function (this: This, initialValue: string): string {
    return initialValue.toUpperCase();
  };
}

// ------------------------------------------------------------
// 3. addInitializer 在实例字段初始化前绑定方法
// ------------------------------------------------------------
// 标准装饰器允许通过 context.addInitializer 注册“初始化回调”；
// 实例方法装饰器的 addInitializer 回调会在“实例字段被赋值之前”运行，
// 此时 this 已绑定到新实例，所以可以安全地重写方法。

function bound<This, Args extends unknown[], Return>(
  // bound 不替换方法，只用 addInitializer 注册回调，所以返回 void。
  _original: Method<This, Args, Return>,
  context: ClassMethodDecoratorContext<This, Method<This, Args, Return>>,
): void {
  // 私有方法无法用普通 access.get 拿到，先拒绝。
  if (context.private) {
    throw new TypeError(`@bound 不支持私有成员 ${String(context.name)}`);
  }
  // 静态方法的 this 是构造函数本身，不是实例，绑定的语义不对。
  if (context.static) {
    throw new TypeError(`@bound 只用于实例方法 ${String(context.name)}`);
  }

  // 关键：addInitializer 注册的回调在“实例字段初始化前”运行，this 已就绪。
  // 此时把原型上的方法读出、bind(this)、用同名自有属性覆盖到实例上。
  context.addInitializer(function (this: This): void {
    const current = context.access.get(this); // 从原型上读出原方法
    Object.defineProperty(this as object, context.name, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: current.bind(this), // 绑定 this，确保 detached 调用仍指向当前实例
    });
  });
}

// ------------------------------------------------------------
// 4. 类装饰器的“运行时增强、静态不增宽”边界
// ------------------------------------------------------------
// 类装饰器可以返回一个新的构造器来增强运行时行为；
// 但它无法改写原 class 声明暴露给 TS 的实例类型——新增字段在类型层不可见。

// Timestamped：我们希望“被装饰的类”在运行时多出 createdAt 字段。
// 但 TS 不会因此把 Calculator 的实例类型加上 createdAt，所以需要显式接口或断言。
interface Timestamped {
  readonly createdAt: string;
}

// TS 的 mixin 构造规则要求“单个 any[] rest 参数”。这里的 any 只用于把原构造参数
// 原样转发给 super，不读取也不改写参数；公共实例关系仍由 Target 保存。
type MixinConstructor = new (...args: any[]) => object;

// 类装饰器签名：(Original, context) => Replacement | void。
// Target extends MixinConstructor 保证它能被 new(...args) 调用。
function withTimestamp<Target extends MixinConstructor>(
  Original: Target,
  context: ClassDecoratorContext<Target>,
): Target {
  // 验证 context.kind 是 'class'：防御性确认装饰位置。
  assert.equal(context.kind, 'class');

  // 返回一个继承自 Original 的子类，额外添加 createdAt 字段。
  // 构造函数把参数原样转发给 super(...)。
  const Replacement = class extends Original implements Timestamped {
    constructor(...args: any[]) {
      super(...args);
    }

    // 实例字段：每个新对象都生成自己的时间戳。
    readonly createdAt = new Date().toISOString();
  };

  // 标准类装饰器必须返回可替换原构造器的值。这里的断言刻意把“新增字段”隐藏起来，
  // 因为装饰器语法不会改写 class declaration 暴露给调用方的实例类型。
  // as Target 把“运行时多了一个字段”的类型差异抹掉，强制维持原契约。
  return Replacement as Target;
}

// 一个被多种装饰器同时装饰的具体类，验证它们能否协作。
@withTimestamp
class Calculator {
  constructor(readonly scale: number) {}

  // 字段装饰器：label 的初值 'calc' 会被 uppercase 转换成 'CALC'。
  @uppercase
  label = 'calc';

  // 方法装饰器：add 调用前后向 methodLog 推入 before/after 记录。
  @logged
  add(left: number, right: number): number {
    return (left + right) * this.scale;
  }

  // 工厂装饰器：minimum(0) 先求值返回装饰器，再用它装饰 setLevel。
  // 装饰后调用 setLevel(-5) 会被钳为 0。
  @minimum(0)
  setLevel(level: number): number {
    return level;
  }

  // @bound 在实例初始化时把 greet 重写为同名自有属性，并 bind(this)。
  @bound
  greet(prefix: string): string {
    return `${prefix} from ${this.label}`;
  }
}

const calculator = new Calculator(1);
// 类型仍是 number：logged 保留了原方法的返回类型关系。
const sum: number = calculator.add(2, 3);
assert.equal(sum, 5);
// logged 在调用前后各推入一条日志。
assert.deepEqual(methodLog, ['add:before:[2,3]', 'add:after']);
// uppercase 把 'calc' 转成 'CALC'。
assert.equal(calculator.label, 'CALC');
// minimum(0) 把 -5 钳为 0。
assert.equal(calculator.setLevel(-5), 0);

// detached：从实例上取出 greet；因为 @bound 已把它绑到实例，调用时无需再 .bind。
const detached = calculator.greet;
assert.equal(detached('hello'), 'hello from CALC');
// @bound 把 greet 写成 calculator 自己的属性（不再是原型上的）。
assert.equal(Object.hasOwn(calculator, 'greet'), true);

// @withTimestamp 返回的是 `class extends Original`：公开的 Calculator.prototype
// 是替换子类的空原型，原方法保留在它的父原型。@bound 又在实例上创建同名绑定方法。
// 即：装饰后的 Calculator.prototype 上没有 greet，它在父原型上。
assert.equal(
  Object.prototype.hasOwnProperty.call(Calculator.prototype, 'greet'),
  false,
);
// 沿原型链向上一层，就能找到原始的 greet。
const originalCalculatorPrototype: unknown = Object.getPrototypeOf(
  Calculator.prototype,
);
assert.equal(
  typeof originalCalculatorPrototype === 'object' &&
    originalCalculatorPrototype !== null &&
    Object.prototype.hasOwnProperty.call(originalCalculatorPrototype, 'greet'),
  true,
);

// 运行时通过 Reflect 取出 createdAt：它确实存在于实例上（运行时多了字段），
// 但 TS 的静态类型并不知道这件事，所以这里只能用 unknown 接住。
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
// 装饰器工厂按“自上而下”求值（每次 @factory() 都会立刻执行 factory()）；
// 但工厂返回的“装饰器本体”按“自下而上”应用到成员上（离方法体最近的先应用）。

const decoratorOrder: string[] = [];

// traced 是工厂：调用 traced('outer') 立刻推入 'evaluate:outer' 并返回装饰器；
// 返回的装饰器在被应用时推入 'apply:outer'，在方法被调用时推入 'call:outer:*'。
function traced(label: string) {
  decoratorOrder.push(`evaluate:${label}`); // 工厂求值阶段

  return function <This, Args extends unknown[], Return>(
    original: Method<This, Args, Return>,
    _context: ClassMethodDecoratorContext<This, Method<This, Args, Return>>,
  ): Method<This, Args, Return> {
    decoratorOrder.push(`apply:${label}`); // 装饰器应用阶段

    // 返回的 wrapper 在方法被调用时记录 before/after。
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
  // 两个工厂装饰器叠用：求值顺序自上而下（outer 先），应用顺序自下而上（inner 先）。
  @traced('outer')
  @traced('inner')
  run(): 'body' {
    decoratorOrder.push('call:body');
    return 'body';
  }
}

// 类定义阶段：先 evaluate:outer、evaluate:inner（自上而下），再 apply:inner、apply:outer（自下而上）。
assert.deepEqual(decoratorOrder, [
  'evaluate:outer',
  'evaluate:inner',
  'apply:inner',
  'apply:outer',
]);

// 调用 run() 时，调用链是外层 wrapper → 内层 wrapper → 真正的方法体，像洋葱一样层层包覆。
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
