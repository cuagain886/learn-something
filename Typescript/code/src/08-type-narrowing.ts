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

// ---------------------------------------------------------------------------
// 编译期测试工具：Equal / Expect（沿用第 07 课）
// ---------------------------------------------------------------------------
// 仅用于在文件内写"编译期断言"：`type _X = Expect<Equal<Actual, Expected>>`。
// Actual 与 Expected 不等时 `Condition extends true` 不成立，tsc 直接报错。
// 利用函数类型在高阶比较时更严格的等价判定，比单纯的 `A extends B` 更可靠。
type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2)
    ? true
    : false;
// Expect 把条件约束为 true：任何非 true 的类型都无法满足 `extends true`。
type Expect<Condition extends true> = Condition;

// ---------------------------------------------------------------------------
// 1. typeof、可达性与 JavaScript 的真实怪癖
// ---------------------------------------------------------------------------

// formatValue：用 typeof 在 `string | number` 联合中分流。
// typeof 返回字符串字面量（'string' / 'number'），TS 据此把 value 收窄到对应成员。
function formatValue(value: string | number): string {
  // 此分支内 value 被收窄为 string，可安全调用字符串方法。
  if (typeof value === 'string') {
    return value.trim().toUpperCase();
  }

  // string 分支已经 return；基于可达性，剩余路径只能是 number。
  return value.toFixed(2);
}

assert.equal(formatValue(' agent '), 'AGENT');
assert.equal(formatValue(3.14159), '3.14');
// ⚠️ JS 怪癖：typeof null === 'object'，不能用 typeof 把 null 与真对象分开。
assert.equal(typeof null, 'object');
// ⚠️ NaN 的类型也是 'number'，做 number 分支时记得 isNaN/Number.isNaN。
assert.equal(typeof Number.NaN, 'number');

// objectKind：演示为什么 typeof 不够用——object 与 null 的 typeof 都返回 'object'。
function objectKind(value: object | null): 'null' | 'object' {
  // `typeof value === 'object'` 不能排除 null，必须先做身份比较。
  if (value === null) return 'null';
  // 此处 value 已收窄为 object（非 null）。
  return 'object';
}

assert.equal(objectKind(null), 'null');
assert.equal(objectKind({}), 'object');

// ---------------------------------------------------------------------------
// 2. truthiness 会同时排除合法的 falsy 业务值
// ---------------------------------------------------------------------------

// displayNameByTruthiness：用 `name ?` 判空，会一次性排除 null/undefined/''/0/NaN 等。
// 对空字符串敏感的领域逻辑，这种收窄会把合法业务值也当成 missing。
function displayNameByTruthiness(name: string | null | undefined): string {
  return name ? name.toUpperCase() : '(missing)';
}

// displayNameExactly：用精确身份比较只排除 null 和 undefined，保留空字符串作为合法输入。
function displayNameExactly(name: string | null | undefined): string {
  if (name === null || name === undefined) return '(missing)';
  // 此处 name 已收窄为 string，可能为 ''。
  return name.toUpperCase();
}

assert.equal(displayNameByTruthiness(''), '(missing)');
assert.equal(displayNameExactly(''), '');

// 对 count、offset、temperature、空字符串等领域值，不要用 truthiness 代替空值判断。

// ---------------------------------------------------------------------------
// 3. 相等收窄：取两个联合的交集
// ---------------------------------------------------------------------------

// commonValue：当 left === right 成立时，TS 取两侧 declared union 的交集作为收窄结果。
// left 是 `string | number`、right 是 `string | boolean`，共同可能的成员只有 string。
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

// Fish：判别字段 kind + 必有 swim 方法（结构上确定存在）。
type Fish = {
  readonly kind: 'fish';
  readonly swim: () => string;
};

// Bird：另一种判别变体，结构上必有 fly。
type Bird = {
  readonly kind: 'bird';
  readonly fly: () => string;
};

// Human：swim/fly 都是 optional，`in` 既证明不了存在、也证明不了类型。
type Human = {
  readonly kind: 'human';
  readonly swim?: () => string;
  readonly fly?: () => string;
};

// move：联合只有 Fish | Bird（无 optional），`in 'swim'` 把分支精确收窄到 Fish。
function move(animal: Fish | Bird): string {
  if ('swim' in animal) return animal.swim();
  // false 分支收窄为 Bird。
  return animal.fly();
}

// describeMovement：Human 的 swim 是 optional，true 分支会同时包含 Fish 与 Human，
// 因此还要用 typeof === 'function' 再次确认 swim 真的存在。
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

// inherited：构造一个 swim 来自原型链、但不是 own property 的对象。
// 说明 `in` 反映的是 JS 原型链查找结果，不等同于"对象拥有这个 own 属性"。
const inherited = Object.assign(
  // 第一步：创建一个原型带 swim 的对象。
  Object.create({ swim: () => 'from prototype' }),
  // 第二步：再覆盖 own 属性 kind。
  { kind: 'fish' as const },
) as Fish;
// in 能查到原型链上的 swim。
assert.equal('swim' in inherited, true);
// 但 hasOwn 显示它不是自身属性。
assert.equal(Object.hasOwn(inherited, 'swim'), false);

// `in` 表示“自身或原型链可查到”，不等于 own-property schema validation。

// ---------------------------------------------------------------------------
// 5. instanceof 依赖运行时 constructor identity
// ---------------------------------------------------------------------------

// NetworkFailure：自定义 Error 子类，扩展了 retryAfterMs 字段。
// instanceof 会沿原型链查 constructor，从而把 error 收窄到这个子类。
class NetworkFailure extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    // 修正 Error 子类的 name，便于日志/分类。
    this.name = 'NetworkFailure';
    this.retryAfterMs = retryAfterMs;
  }
}

// retryDelay：用 instanceof 区分普通 Error 与 NetworkFailure，
// 收窄成功后才能安全读取子类专属字段 retryAfterMs。
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

// isRecord：unknown → Record<PropertyKey, unknown> 的最小谓词。
// 只验证"是对象且非 null"，这是从 unknown 进入对象世界的第一道关卡。
function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

// isFish：在 isRecord 基础上叠加字段存在性 + 类型校验，构成完整的类型谓词。
// 每一层都用前一层收窄后的类型安全地读取下一层字段。
function isFish(value: unknown): value is Fish {
  return isRecord(value)
    && value['kind'] === 'fish'
    && typeof value['swim'] === 'function';
}

// externalPet：来自外部的 unknown，没有任何静态类型保证，必须运行时验证才能使用。
const externalPet: unknown = { kind: 'fish', swim: () => 'validated swim' };
assert.equal(isFish(externalPet), true);
// isFish 返回 true 后，TS 在此分支把 externalPet 收窄为 Fish。
if (isFish(externalPet)) {
  assert.equal(externalPet.swim(), 'validated swim');
}

assert.equal(isFish({ kind: 'fish', swim: 'not a function' }), false);
assert.equal(isFish(null), false);

// ---------------------------------------------------------------------------
// 7. 谓词可以撒谎：`value is T` 不会自动生成或审计验证逻辑
// ---------------------------------------------------------------------------

// lyingFishPredicate：返回值类型声明为 `_value is Fish`，但实现恒为 true。
// TS 不会审计实现，只信任签名——这是一个"撒谎的谓词"。
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

// ToolCall：描述一个工具调用的形状，arguments 故意标为 unknown（外部输入未验证）。
type ToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
};

// assertToolCall：`asserts value is ToolCall` 形式的断言函数。
// 失败必须 throw（否则后续证明不成立）；成功则调用点之后 value 被收窄为 ToolCall。
function assertToolCall(value: unknown): asserts value is ToolCall {
  // 逐字段做存在性 + 类型 + 范围（如非空字符串）校验，任一失败即 throw。
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
// 调用断言函数后，rawToolCall 在后续代码中被收窄为 ToolCall。
assertToolCall(rawToolCall);
assert.equal(rawToolCall.name, 'search');
assert.throws(() => assertToolCall({ id: '', name: 'search' }), TypeError);

// ---------------------------------------------------------------------------
// 9. TS 5.5+ 可从简单回调推断 type predicate
// ---------------------------------------------------------------------------

// maybeNames：含有 undefined 的数组，常见于"可选字段收集"场景。
const maybeNames: Array<string | undefined> = ['Ada', undefined, 'Lin'];
// TS 5.5 起能从 `(name) => name !== undefined` 自动推断出 Array.filter 的谓词类型，
// 不必手写 `(name): name is string =>`。
const names = maybeNames.filter((name) => name !== undefined);
type _InferredFilterPredicate = Expect<Equal<typeof names, string[]>>;
assert.deepEqual(names, ['Ada', 'Lin']);

// 复杂回调、显式 boolean 返回类型、参数突变等可能阻止推断；公共 API 仍应在需要时显式声明谓词。

// ---------------------------------------------------------------------------
// 10. assignment narrowing 与 declared type
// ---------------------------------------------------------------------------

// current 的 declared type 是 string | number，初始值由三元表达式决定（推断为 string | number）。
let current: string | number = Math.random() > -1 ? 'ready' : 0;
// 赋值 42 后，observed type 在此点被收窄为 number。
current = 42;
type _ObservedNumber = Expect<Equal<typeof current, number>>;
assert.equal(current.toFixed(0), '42');

current = 'done'; // 赋值合法性仍相对 declared type `string | number` 检查
// 赋值后 observed type 又变成 string。
assert.equal(current.toUpperCase(), 'DONE');

if (false) {
  // @ts-expect-error -- boolean 不属于 declared union。
  current = true;
}

// ---------------------------------------------------------------------------
// 11. 闭包延迟执行：复制稳定值，不要依赖可变捕获继续保持收窄
// ---------------------------------------------------------------------------

// callbacks：演示"延迟执行的回调里收窄是否仍然有效"。
const callbacks: Array<() => string> = [];
// captured 是可被重新赋值的变量，存在"捕获时与执行时类型可能不同"的问题。
let captured: string | undefined = 'token';

if (captured !== undefined) {
  // 把当前 captured 的值复制到一个 const，从此 callback 总能用这个稳定快照。
  const stable = captured;
  callbacks.push(() => stable.toUpperCase());

  callbacks.push(() => {
    // callback 执行前 captured 可能被重新赋值，checker 不允许沿用旧证明。
    // @ts-expect-error -- captured 可能是 undefined。
    return captured.toUpperCase();
  });
}

// 模拟稍后执行：captured 已变成 undefined，但 stable 不受影响。
captured = undefined;
assert.equal(callbacks[0]?.(), 'TOKEN');

// ---------------------------------------------------------------------------
// 12. 函数调用副作用：TS 不做完整 effect analysis，存在刻意不健全边界
// ---------------------------------------------------------------------------

// Holder：value 字段可能在函数调用后被副作用改写。
type Holder = { value: string | undefined };

// clearHolder：把 holder.value 改成 undefined——这是 checker 看不到的副作用。
function clearHolder(holder: Holder): void {
  holder.value = undefined;
}

const holder: Holder = { value: 'ready' };
if (holder.value !== undefined) {
  assert.equal(holder.value.toUpperCase(), 'READY');
  // 这个函数调用把 value 改成 undefined，但 checker 不会撤销之前的属性收窄。
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

// RunEvent：用 readonly kind 作为判别字段，组合出 4 种事件变体。
// 每个 variant 携带各自专属字段，互不重叠。
type RunEvent =
  | { readonly kind: 'token'; readonly text: string }
  | { readonly kind: 'tool_started'; readonly callId: string; readonly name: string }
  | { readonly kind: 'tool_finished'; readonly callId: string; readonly output: unknown }
  | { readonly kind: 'failed'; readonly error: Error };

// assertNever：接收 never 类型——switch 漏掉一个 variant 时，
// 编译期 never 不被满足会报错，运行时则抛错，是穷尽检查的兜底。
function assertNever(value: never): never {
  throw new Error(`unreachable variant: ${JSON.stringify(value)}`);
}

// summarizeEvent：用 switch + 判别字段把 event 收窄到对应 variant，
// 最后 default 分支用 assertNever(event) 强制穷尽检查。
function summarizeEvent(event: RunEvent): string {
  // TS 能保持从同一 union 解构出的 discriminant 与剩余对象之间的关联。
  const { kind } = event;
  switch (kind) {
    case 'token':
      // 此分支 event 被收窄为 token variant。
      return `token:${event.text}`;
    case 'tool_started':
      return `start:${event.callId}:${event.name}`;
    case 'tool_finished':
      return `finish:${event.callId}:${JSON.stringify(event.output)}`;
    case 'failed':
      return `failed:${event.error.message}`;
    default:
      // 此分支 event 类型已被穷尽为 never；新增 variant 但忘加 case 会在此报错。
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
