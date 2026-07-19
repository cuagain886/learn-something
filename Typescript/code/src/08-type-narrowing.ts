import assert from 'node:assert/strict';

/**
 * 第 08 课：控制流收窄是一种局部证明
 *
 * checker 沿控制流图追踪 typeof、相等、可达性、赋值、判别字段和谓词，
 * 在某个程序点把 declared type 暂时细化为 observed type。需要牢记：
 *   - 收窄只在静态控制流里成立，不会自动验证外部 unknown；
 *   - predicate/assertion function 是开发者提交的证明，checker 不审计实现；
 *   - 闭包、别名突变和函数副作用是收窄最容易失效或不健全的边界。
 *
 * 运行：npx tsx src/08-type-narrowing.ts
 */

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Condition extends true> = Condition;

// ---------------------------------------------------------------------------
// 1. typeof、可达性与 JavaScript 的真实怪癖
// ---------------------------------------------------------------------------

function formatValue(value: string | number): string {
  if (typeof value === 'string') {
    return value.trim().toUpperCase();
  }

  // string 分支已经 return；基于可达性，剩余路径只能是 number。
  return value.toFixed(2);
}

assert.equal(formatValue(' agent '), 'AGENT');
assert.equal(formatValue(3.14159), '3.14');
assert.equal(typeof null, 'object');
assert.equal(typeof Number.NaN, 'number');

function objectKind(value: object | null): 'null' | 'object' {
  // `typeof value === 'object'` 不能排除 null，必须先做身份比较。
  if (value === null) return 'null';
  return 'object';
}

assert.equal(objectKind(null), 'null');
assert.equal(objectKind({}), 'object');

// ---------------------------------------------------------------------------
// 2. truthiness 会同时排除合法的 falsy 业务值
// ---------------------------------------------------------------------------

function displayNameByTruthiness(name: string | null | undefined): string {
  return name ? name.toUpperCase() : '(missing)';
}

function displayNameExactly(name: string | null | undefined): string {
  if (name === null || name === undefined) return '(missing)';
  return name.toUpperCase();
}

assert.equal(displayNameByTruthiness(''), '(missing)');
assert.equal(displayNameExactly(''), '');

// 对 count、offset、temperature、空字符串等领域值，不要用 truthiness 代替空值判断。

// ---------------------------------------------------------------------------
// 3. 相等收窄：取两个联合的交集
// ---------------------------------------------------------------------------

function commonValue(
  left: string | number,
  right: string | boolean,
): string | undefined {
  if (left === right) {
    // 两边共同可能的类型只有 string。
    type _Common = Expect<Equal<typeof left, string>>;
    return left;
  }
  return undefined;
}

assert.equal(commonValue('same', 'same'), 'same');
assert.equal(commonValue(1, true), undefined);

// ---------------------------------------------------------------------------
// 4. `in` 查询原型链；optional property 会出现在 true/false 两边
// ---------------------------------------------------------------------------

type Fish = {
  readonly kind: 'fish';
  readonly swim: () => string;
};

type Bird = {
  readonly kind: 'bird';
  readonly fly: () => string;
};

type Human = {
  readonly kind: 'human';
  readonly swim?: () => string;
  readonly fly?: () => string;
};

function move(animal: Fish | Bird): string {
  if ('swim' in animal) return animal.swim();
  return animal.fly();
}

function describeMovement(animal: Fish | Bird | Human): string {
  if ('swim' in animal) {
    // true 分支可能是 Fish，也可能是“存在 optional swim”的 Human。
    return typeof animal.swim === 'function' ? animal.swim() : 'human cannot swim now';
  }

  if ('fly' in animal && typeof animal.fly === 'function') return animal.fly();
  return 'no movement capability';
}

assert.equal(move({ kind: 'fish', swim: () => 'swimming' }), 'swimming');
assert.equal(describeMovement({ kind: 'human' }), 'no movement capability');

const inherited = Object.assign(
  Object.create({ swim: () => 'from prototype' }),
  { kind: 'fish' as const },
) as Fish;
assert.equal('swim' in inherited, true);
assert.equal(Object.hasOwn(inherited, 'swim'), false);

// `in` 表示“自身或原型链可查到”，不等于 own-property schema validation。

// ---------------------------------------------------------------------------
// 5. instanceof 依赖运行时 constructor identity
// ---------------------------------------------------------------------------

class NetworkFailure extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'NetworkFailure';
    this.retryAfterMs = retryAfterMs;
  }
}

function retryDelay(error: Error | NetworkFailure): number | undefined {
  return error instanceof NetworkFailure ? error.retryAfterMs : undefined;
}

assert.equal(retryDelay(new NetworkFailure('busy', 100)), 100);
assert.equal(retryDelay(new Error('bug')), undefined);

// interface/type 已擦除，不能 instanceof；跨 VM/Worker/重复包副本时，自定义 constructor
// identity 也可能不同。跨线程/网络协议应使用经过验证的判别字段。

// ---------------------------------------------------------------------------
// 6. 从 unknown 写真正的运行时谓词
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFish(value: unknown): value is Fish {
  return isRecord(value)
    && value['kind'] === 'fish'
    && typeof value['swim'] === 'function';
}

const externalPet: unknown = { kind: 'fish', swim: () => 'validated swim' };
assert.equal(isFish(externalPet), true);
if (isFish(externalPet)) {
  assert.equal(externalPet.swim(), 'validated swim');
}

assert.equal(isFish({ kind: 'fish', swim: 'not a function' }), false);
assert.equal(isFish(null), false);

// ---------------------------------------------------------------------------
// 7. 谓词可以撒谎：`value is T` 不会自动生成或审计验证逻辑
// ---------------------------------------------------------------------------

function lyingFishPredicate(_value: unknown): _value is Fish {
  return true;
}

const suspicious: unknown = { kind: 'not-fish' };
if (lyingFishPredicate(suspicious)) {
  // checker 现在相信 suspicious.swim 是函数；运行时事实并未改变。
  assert.equal(typeof suspicious.swim, 'undefined');
  // suspicious.swim() 会在运行时抛 TypeError，故意不调用。
}

// 谓词的正确性属于测试/代码审查责任。边界 validator 应做字段、类型、范围和组合验证。

// ---------------------------------------------------------------------------
// 8. assertion function：失败路径必须 throw，成功路径建立证明
// ---------------------------------------------------------------------------

type ToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
};

function assertToolCall(value: unknown): asserts value is ToolCall {
  if (
    !isRecord(value)
    || typeof value['id'] !== 'string'
    || value['id'].length === 0
    || typeof value['name'] !== 'string'
    || value['name'].length === 0
    || !Object.hasOwn(value, 'arguments')
  ) {
    throw new TypeError('invalid tool call');
  }
}

const rawToolCall: unknown = { id: 'call_1', name: 'search', arguments: { q: 'TS' } };
assertToolCall(rawToolCall);
assert.equal(rawToolCall.name, 'search');
assert.throws(() => assertToolCall({ id: '', name: 'search' }), TypeError);

// ---------------------------------------------------------------------------
// 9. TS 5.5+ 可从简单回调推断 type predicate
// ---------------------------------------------------------------------------

const maybeNames: Array<string | undefined> = ['Ada', undefined, 'Lin'];
const names = maybeNames.filter((name) => name !== undefined);
type _InferredFilterPredicate = Expect<Equal<typeof names, string[]>>;
assert.deepEqual(names, ['Ada', 'Lin']);

// 复杂回调、显式 boolean 返回类型、参数突变等可能阻止推断；公共 API 仍应在需要时显式声明谓词。

// ---------------------------------------------------------------------------
// 10. assignment narrowing 与 declared type
// ---------------------------------------------------------------------------

let current: string | number = Math.random() > -1 ? 'ready' : 0;
current = 42;
type _ObservedNumber = Expect<Equal<typeof current, number>>;
assert.equal(current.toFixed(0), '42');

current = 'done'; // 赋值合法性仍相对 declared type `string | number` 检查
assert.equal(current.toUpperCase(), 'DONE');

if (false) {
  // @ts-expect-error -- boolean 不属于 declared union。
  current = true;
}

// ---------------------------------------------------------------------------
// 11. 闭包延迟执行：复制稳定值，不要依赖可变捕获继续保持收窄
// ---------------------------------------------------------------------------

const callbacks: Array<() => string> = [];
let captured: string | undefined = 'token';

if (captured !== undefined) {
  const stable = captured;
  callbacks.push(() => stable.toUpperCase());

  callbacks.push(() => {
    // callback 执行前 captured 可能被重新赋值，checker 不允许沿用旧证明。
    // @ts-expect-error -- captured 可能是 undefined。
    return captured.toUpperCase();
  });
}

captured = undefined;
assert.equal(callbacks[0]?.(), 'TOKEN');

// ---------------------------------------------------------------------------
// 12. 函数调用副作用：TS 不做完整 effect analysis，存在刻意不健全边界
// ---------------------------------------------------------------------------

type Holder = { value: string | undefined };

function clearHolder(holder: Holder): void {
  holder.value = undefined;
}

const holder: Holder = { value: 'ready' };
if (holder.value !== undefined) {
  assert.equal(holder.value.toUpperCase(), 'READY');
  clearHolder(holder);

  // TypeScript 通常不会因任意函数调用而撤销属性收窄，否则大量代码会不可用。
  // 这里赋值在静态上仍被当作 string，但运行时已是 undefined：这是有意的不健全性。
  const staticallyString: string = holder.value;
  assert.equal(staticallyString, undefined);
}

// 防御方式：在调用前复制 primitive 稳定值、避免共享可变别名，或让 API 返回新状态。

// ---------------------------------------------------------------------------
// 13. 可辨识联合与穷尽检查：Agent 状态机的核心模式
// ---------------------------------------------------------------------------

type RunEvent =
  | { readonly kind: 'token'; readonly text: string }
  | { readonly kind: 'tool_started'; readonly callId: string; readonly name: string }
  | { readonly kind: 'tool_finished'; readonly callId: string; readonly output: unknown }
  | { readonly kind: 'failed'; readonly error: Error };

function assertNever(value: never): never {
  throw new Error(`unreachable variant: ${JSON.stringify(value)}`);
}

function summarizeEvent(event: RunEvent): string {
  // TS 能保持从同一 union 解构出的 discriminant 与剩余对象之间的关联。
  const { kind } = event;
  switch (kind) {
    case 'token':
      return `token:${event.text}`;
    case 'tool_started':
      return `start:${event.callId}:${event.name}`;
    case 'tool_finished':
      return `finish:${event.callId}:${JSON.stringify(event.output)}`;
    case 'failed':
      return `failed:${event.error.message}`;
    default:
      return assertNever(event);
  }
}

assert.equal(summarizeEvent({ kind: 'token', text: 'hi' }), 'token:hi');
assert.equal(
  summarizeEvent({ kind: 'tool_started', callId: 'c1', name: 'search' }),
  'start:c1:search',
);

console.log('=== 第 08 课：控制流证明与不健全边界 ===');
console.log({
  formatted: [formatValue(' ts '), formatValue(3.5)],
  emptyStringTruthiness: displayNameByTruthiness(''),
  emptyStringExact: displayNameExactly(''),
  inferredNames: names,
  holderAfterMutation: holder,
  event: summarizeEvent({ kind: 'token', text: 'stream' }),
});

export {};
