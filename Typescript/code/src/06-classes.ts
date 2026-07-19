import assert from 'node:assert/strict';

/**
 * 第 06 课：Class 的两层模型
 *
 * Java 开发者最容易把 TypeScript class 直接等同于 Java class。真正需要同时理解：
 *   1. 静态层：public/private/protected/readonly/abstract/implements；
 *   2. 运行时层：构造函数对象、prototype、own property、accessor 与 #private brand；
 *   3. emit 层：parameter property 等 TS 语法会生成 JS，interface/abstract 检查会擦除；
 *   4. 初始化层：super、基类字段、基类构造器、派生字段的真实顺序。
 *
 * 运行：npx tsx src/06-classes.ts
 */

// ---------------------------------------------------------------------------
// 1. 字段、软 private、readonly 与运行时不变量
// ---------------------------------------------------------------------------

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} 必须是正有限数`);
  }
}

class Account {
  static #nextId = 1;
  static readonly currency = 'CNY';

  readonly id: number;
  readonly metadata: { tags: string[] };
  private balance: number;

  constructor(
    public owner: string,
    initialBalance: number,
  ) {
    if (!Number.isFinite(initialBalance) || initialBalance < 0) {
      throw new RangeError('initialBalance 必须是非负有限数');
    }

    this.id = Account.#nextId;
    Account.#nextId += 1;
    this.balance = initialBalance;
    this.metadata = { tags: [] };
  }

  deposit(amount: number): void {
    assertPositiveFinite(amount, 'amount');
    this.balance += amount;
  }

  get snapshot(): Readonly<{ owner: string; balance: number; currency: string }> {
    return {
      owner: this.owner,
      balance: this.balance,
      currency: Account.currency,
    };
  }

  sameBalance(other: Account): boolean {
    // 和 Java 一样，TS 允许同一个 class 的实例互相访问 private。
    return this.balance === other.balance;
  }
}

const account = new Account('Alice', 100);
account.deposit(50);
assert.deepEqual(account.snapshot, {
  owner: 'Alice',
  balance: 150,
  currency: 'CNY',
});

// readonly 只禁止 metadata 属性被重新赋值；嵌套数组仍可变。
account.metadata.tags.push('vip');
assert.deepEqual(account.metadata.tags, ['vip']);

// @ts-expect-error -- 点语法受 TS soft-private 检查保护。
void account.balance;

// TS private 通常 emit 成普通 JS 属性。官方特意允许 bracket escape，便于测试，
// 但这也证明它不是安全边界；恶意/纯 JS 调用者仍可读取。
assert.equal(account['balance'], 150);
assert.equal(Object.hasOwn(account, 'balance'), true);

assert.throws(() => account.deposit(Number.NaN), RangeError);
assert.throws(() => new Account('invalid', -1), RangeError);

// ---------------------------------------------------------------------------
// 2. JavaScript #private：运行时 brand，而不是字符串属性
// ---------------------------------------------------------------------------

class Vault {
  #secret: string;

  constructor(secret: string) {
    this.#secret = secret;
  }

  reveal(): string {
    return this.#secret;
  }

  static hasVaultBrand(value: object): value is Vault {
    return #secret in value;
  }
}

const vault = new Vault('agent-token');
assert.equal(vault.reveal(), 'agent-token');
assert.equal(Vault.hasVaultBrand(vault), true);
assert.equal(Vault.hasVaultBrand({}), false);
assert.equal(Object.hasOwn(vault, '#secret'), false);
assert.equal((vault as unknown as Record<string, unknown>)['#secret'], undefined);

// `vault.#secret` 在 class 外甚至不能形成合法的 private-name 访问；
// 与 TS private 不同，不能靠 bracket 写出同一个 #brand。

// ---------------------------------------------------------------------------
// 3. Parameter property 会生成运行时代码
// ---------------------------------------------------------------------------

class Point {
  constructor(
    public x: number,
    public y: number,
  ) {}

  distanceToOrigin(): number {
    return Math.hypot(this.x, this.y);
  }
}

const point = new Point(3, 4);
assert.equal(point.distanceToOrigin(), 5);
assert.deepEqual(Object.keys(point), ['x', 'y']);

// `public x` 参数属性不是纯类型标注：tsc 会生成 this.x = x 一类初始化。
// 因此 Node 原生 type stripping 的 erasable-only 模式不接受 parameter property；
// 需要原生运行 .ts 时应显式声明字段并在 constructor 赋值。

// ---------------------------------------------------------------------------
// 4. 实例侧、静态侧与 implements
// ---------------------------------------------------------------------------

interface ClockInstance {
  tick(): string;
}

interface ClockConstructor {
  readonly version: string;
  new (zone: string): ClockInstance;
}

class SystemClock implements ClockInstance {
  static readonly version = '1.0';

  readonly zone: string;

  constructor(zone: string) {
    this.zone = zone;
  }

  tick(): string {
    return `tick@${this.zone}`;
  }
}

function createClock(ctor: ClockConstructor, zone: string): ClockInstance {
  assert.match(ctor.version, /^\d+\.\d+$/);
  return new ctor(zone);
}

const clock = createClock(SystemClock, 'Asia/Shanghai');
assert.equal(clock.tick(), 'tick@Asia/Shanghai');

// `implements ClockInstance` 只检查实例侧；constructor 和 static version 由
// ClockConstructor 在 createClock 参数处另行检查。implements 不生成 runtime marker。
assert.equal('ClockInstance' in globalThis, false);
assert.equal(SystemClock.prototype instanceof Object, true);

// ---------------------------------------------------------------------------
// 5. 方法、箭头字段和 accessor 分别放在哪里
// ---------------------------------------------------------------------------

class Handler {
  count = 0;

  increment(): number {
    this.count += 1;
    return this.count;
  }

  incrementBound = (): number => {
    this.count += 1;
    return this.count;
  };

  get doubled(): number {
    return this.count * 2;
  }
}

const handlerA = new Handler();
const handlerB = new Handler();

assert.equal(Object.hasOwn(handlerA, 'increment'), false);
assert.equal(Object.hasOwn(handlerA, 'incrementBound'), true);
assert.equal(handlerA.increment === handlerB.increment, true); // prototype 共享一份函数
assert.equal(handlerA.incrementBound === handlerB.incrementBound, false); // 每实例创建闭包

const incrementDescriptor = Object.getOwnPropertyDescriptor(
  Handler.prototype,
  'increment',
);
const accessorDescriptor = Object.getOwnPropertyDescriptor(
  Handler.prototype,
  'doubled',
);
assert.equal(typeof incrementDescriptor?.value, 'function');
assert.equal(typeof accessorDescriptor?.get, 'function');
assert.equal(accessorDescriptor?.enumerable, false);

const detachedBound = handlerA.incrementBound;
assert.equal(detachedBound(), 1);

const detachedMethod = handlerA.increment;
assert.throws(() => detachedMethod(), TypeError); // 普通方法的 this 由调用点决定
assert.equal(detachedMethod.call(handlerA), 2);

// ---------------------------------------------------------------------------
// 6. 继承、override 与初始化顺序
// ---------------------------------------------------------------------------

class BaseProbe {
  readonly observedDuringBaseConstruction: string | undefined;

  constructor() {
    // 虚调用会分派到派生 override；此时派生字段尚未初始化。
    this.observedDuringBaseConstruction = this.phase();
  }

  protected phase(): string | undefined {
    return 'base';
  }
}

class DerivedProbe extends BaseProbe {
  phaseLabel = 'derived';

  protected override phase(): string | undefined {
    return this.phaseLabel;
  }

  currentPhase(): string {
    return this.phaseLabel;
  }
}

const probe = new DerivedProbe();
assert.equal(probe.observedDuringBaseConstruction, undefined);
assert.equal(probe.currentPhase(), 'derived');

class BaseField {
  value = 'base-field';

  constructor() {
    this.value = 'base-constructor';
  }
}

class DerivedField extends BaseField {
  override value = 'derived-field';
}

// target >= ES2022/useDefineForClassFields 时，派生字段在 super() 完成后初始化，
// 因而覆盖基类构造器写入的同名属性。
assert.equal(new DerivedField().value, 'derived-field');

// ---------------------------------------------------------------------------
// 7. abstract 是静态约束；运行时仍是普通构造函数对象
// ---------------------------------------------------------------------------

abstract class Shape {
  abstract area(): number;

  describe(): string {
    return `area=${this.area().toFixed(2)}`;
  }
}

class Circle extends Shape {
  readonly radius: number;

  constructor(radius: number) {
    super();
    assertPositiveFinite(radius, 'radius');
    this.radius = radius;
  }

  override area(): number {
    return Math.PI * this.radius ** 2;
  }
}

if (false) {
  // @ts-expect-error -- abstract 阻止 TS 调用者直接实例化。
  new Shape();
}

const circle = new Circle(2);
assert.match(circle.describe(), /^area=12\.57/);
assert.equal(typeof Shape, 'function'); // abstract 标记不作为 runtime metadata 存在

// ---------------------------------------------------------------------------
// 8. structural typing 遇到 private/protected 来源时出现名义性
// ---------------------------------------------------------------------------

class TenantToken {
  private readonly nominalBrand = undefined;

  constructor(readonly value: string) {}
}

class RunToken {
  private readonly nominalBrand = undefined;

  constructor(readonly value: string) {}
}

const tenantToken = new TenantToken('same-shape');
assert.equal(tenantToken.value, 'same-shape');

if (false) {
  // 两个类 public shape 相同，但 private 成员不是来自同一声明。
  // @ts-expect-error -- private origin 让它们不再结构兼容。
  const wrong: TenantToken = new RunToken('run');
  void wrong;
}

console.log('=== 第 06 课：Class 的静态层与运行时层 ===');
console.log({
  account: account.snapshot,
  accountOwnKeys: Object.keys(account),
  vaultOwnKeys: Object.keys(vault),
  point,
  clock: clock.tick(),
  prototypeMethodShared: handlerA.increment === handlerB.increment,
  derivedObservedDuringBase: probe.observedDuringBaseConstruction,
  circle: circle.describe(),
});

export {};
