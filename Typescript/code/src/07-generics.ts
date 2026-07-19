import assert from 'node:assert/strict';

/**
 * 第 07 课：泛型不是“给 any 换个名字”，而是表达类型之间的关系
 *
 * 重点：
 *   1. 泛型量化与联合类型的区别；
 *   2. 推断如何保留字面量、如何受多个候选影响；
 *   3. constraint 只限定能力，不抹掉调用者的具体类型；
 *   4. readonly、const type parameter、NoInfer 如何控制信息流；
 *   5. 泛型类只有实例侧使用类类型参数，运行时没有 T。
 *
 * 运行：npx tsx src/07-generics.ts
 */

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Condition extends true> = Condition;

// ---------------------------------------------------------------------------
// 1. any、unknown 与泛型关系
// ---------------------------------------------------------------------------

function identityAny(value: any): any {
  return value;
}

function identityUnknown(value: unknown): unknown {
  return value;
}

function identity<T>(value: T): T {
  return value;
}

const contaminated = identityAny('hello');
contaminated.notARealMethod?.(); // any 让错误继续传播，编译器不再保护

const safeBoundary = identityUnknown('hello');
// @ts-expect-error -- unknown 必须先收窄。
void safeBoundary.toUpperCase();

const literal = identity('hello');
type _IdentityKeepsLiteral = Expect<Equal<typeof literal, 'hello'>>;
assert.equal(literal.toUpperCase(), 'HELLO');

// 泛型的关键不是“能接受多种类型”，而是同一个 T 同时出现在输入和输出，
// 把调用点的精确信息从一端传到另一端。

// ---------------------------------------------------------------------------
// 2. 泛型与联合：每次调用一个 T vs 实现只知道一个固定联合
// ---------------------------------------------------------------------------

function duplicate<T>(value: T): readonly [T, T] {
  return [value, value];
}

function duplicateUnion(value: string | number): readonly [string | number, string | number] {
  return [value, value];
}

const genericPair = duplicate('agent');
const unionPair = duplicateUnion('agent');

// T 在可变/复用位置可能按推断规则拓宽为 string；即便如此，两个槽仍保持同一个 T，
// 比固定 union 的每个槽都是 string|number 更精确。第 6 节再用 const T 保留字面量。
type _GenericPair = Expect<Equal<typeof genericPair, readonly [string, string]>>;
type _UnionPair = Expect<Equal<
  typeof unionPair,
  readonly [string | number, string | number]
>>;

assert.deepEqual(genericPair, ['agent', 'agent']);
assert.deepEqual(unionPair, ['agent', 'agent']);

// ---------------------------------------------------------------------------
// 3. readonly 输入与空数组语义
// ---------------------------------------------------------------------------

function first<T>(values: readonly T[]): T | undefined {
  return values[0];
}

type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

function firstNonEmpty<T>(values: NonEmptyReadonlyArray<T>): T {
  return values[0];
}

assert.equal(first([]), undefined);
assert.equal(first([10, 20] as const), 10);
assert.equal(firstNonEmpty(['a', 'b']), 'a');

if (false) {
  // @ts-expect-error -- 普通空数组不能证明至少有一个元素。
  firstNonEmpty([]);
}

function mapArray<Input, Output>(
  values: readonly Input[],
  transform: (value: Input, index: number) => Output,
): Output[] {
  return values.map(transform);
}

const lengths = mapArray(['TS', 'Agent'] as const, (value) => value.length);
assert.deepEqual(lengths, [2, 5]);

// readonly 参数让 mutable 与 readonly tuple 都能作为输入，同时声明函数不修改调用方数组。

// ---------------------------------------------------------------------------
// 4. constraint 限定最低能力，同时保留 T 的额外字段
// ---------------------------------------------------------------------------

type HasLength = { readonly length: number };

function inspectLength<T extends HasLength>(value: T): {
  readonly original: T;
  readonly length: number;
} {
  return { original: value, length: value.length };
}

const inspected = inspectLength({ length: 3, unit: 'tokens' as const });
type _ConstraintPreservesExtra = Expect<Equal<typeof inspected.original.unit, 'tokens'>>;
assert.equal(inspected.original.unit, 'tokens');

if (false) {
  // @ts-expect-error -- number 不满足最低结构能力。
  inspectLength(123);
}

// constraint 不是把 T 变成 HasLength；返回仍是调用者的完整具体类型。

// ---------------------------------------------------------------------------
// 5. 一个类型参数约束另一个：keyof 与精确返回关联
// ---------------------------------------------------------------------------

function getProperty<ObjectType, Key extends keyof ObjectType>(
  object: ObjectType,
  key: Key,
): ObjectType[Key] {
  return object[key];
}

const agent = {
  id: 'run_1',
  maxSteps: 8,
  streaming: true,
} as const;

const maxSteps = getProperty(agent, 'maxSteps');
type _IndexedResult = Expect<Equal<typeof maxSteps, 8>>;
assert.equal(maxSteps, 8);

if (false) {
  // @ts-expect-error -- email 不属于 agent 的 key union。
  getProperty(agent, 'email');
}

// ---------------------------------------------------------------------------
// 6. const type parameter：在函数边界保留 tuple/字面量信息
// ---------------------------------------------------------------------------

function defineRoute<const Segments extends readonly string[]>(
  ...segments: Segments
): Segments {
  return segments;
}

const route = defineRoute('agents', ':id', 'events');
type _RouteTuple = Expect<Equal<typeof route, readonly ['agents', ':id', 'events']>>;
assert.deepEqual(route, ['agents', ':id', 'events']);

// `as const` 由调用方控制；const type parameter 让 API 作者声明“请优先保留字面量候选”。

// ---------------------------------------------------------------------------
// 7. NoInfer：一个参数消费既有推断，不反向扩大候选集合
// ---------------------------------------------------------------------------

function chooseDefault<Color extends string>(
  choices: readonly Color[],
  defaultColor: NoInfer<Color>,
): Color {
  return choices.includes(defaultColor) ? defaultColor : choices[0] as Color;
}

const color = chooseDefault(['red', 'green'] as const, 'red');
assert.equal(color, 'red');

if (false) {
  // 没有 NoInfer 时，'blue' 可能参与推断并把 Color 扩大；这里它只能消费 choices 的结果。
  // @ts-expect-error -- 'blue' 不在 'red' | 'green' 中。
  chooseDefault(['red', 'green'] as const, 'blue');
}

// ---------------------------------------------------------------------------
// 8. 默认类型参数：没有推断候选时才兜底
// ---------------------------------------------------------------------------

interface Container<T = string> {
  readonly value: T;
}

const defaultContainer: Container = { value: 'text' };
const numberContainer: Container<number> = { value: 42 };

function emptyContainer<T = string>(): { value: T | undefined } {
  return { value: undefined };
}

const empty = emptyContainer();
type _DefaultUsedWithoutCandidate = Expect<Equal<typeof empty.value, string | undefined>>;

// 默认类型不是“推断失败就不报错”：显式参数/实参产生候选时，以候选为准。

// ---------------------------------------------------------------------------
// 9. 泛型类：T 属于实例侧，static 侧只有一份
// ---------------------------------------------------------------------------

class Stack<T> {
  readonly #items: T[] = [];

  push(value: T): void {
    this.#items.push(value);
  }

  pop(): T | undefined {
    return this.#items.pop();
  }

  get size(): number {
    return this.#items.length;
  }

  // @ts-expect-error -- 所有 Stack<T> 共享同一个 constructor/static 侧，不能引用实例侧 T。
  static invalidValue: T;
}

const stack = new Stack<number>();
stack.push(1);
stack.push(2);
assert.equal(stack.pop(), 2);
assert.equal(stack.size, 1);

// 运行时只有 Stack 构造函数，`new Stack<number>() instanceof Stack<string>` 这种问题没有意义；
// `<number>`/`<string>` 在 emit 后都消失。
assert.equal(stack instanceof Stack, true);

// ---------------------------------------------------------------------------
// 10. 构造签名：泛型 factory 要描述 static/constructor 侧
// ---------------------------------------------------------------------------

type Constructor<Instance, Args extends readonly unknown[]> =
  new (...args: Args) => Instance;

function construct<Instance, Args extends readonly unknown[]>(
  ctor: Constructor<Instance, Args>,
  ...args: Args
): Instance {
  return new ctor(...args);
}

class ToolWorker {
  readonly name: string;
  readonly concurrency: number;

  constructor(name: string, concurrency: number) {
    this.name = name;
    this.concurrency = concurrency;
  }
}

const worker = construct(ToolWorker, 'search', 4);
assert.equal(worker.name, 'search');
assert.equal(worker.concurrency, 4);
assert.equal(worker instanceof ToolWorker, true);

if (false) {
  // @ts-expect-error -- constructor 参数 tuple 保持了位置和类型关系。
  construct(ToolWorker, 4, 'search');
}

// ---------------------------------------------------------------------------
// 11. 由使用位置自然产生的协变/逆变
// ---------------------------------------------------------------------------

type Animal = { readonly name: string };
type Dog = Animal & { readonly bark: () => string };

type Producer<T> = { readonly produce: () => T };
type Consumer<T> = { readonly consume: (value: T) => void };

const dogProducer: Producer<Dog> = {
  produce: () => ({ name: 'Rex', bark: () => 'woof' }),
};
const animalProducer: Producer<Animal> = dogProducer; // 输出位置协变
assert.equal(animalProducer.produce().name, 'Rex');

const consumedNames: string[] = [];
const animalConsumer: Consumer<Animal> = {
  consume: (value) => consumedNames.push(value.name),
};
const dogConsumer: Consumer<Dog> = animalConsumer; // 输入位置逆变
dogConsumer.consume({ name: 'Milo', bark: () => 'woof' });
assert.deepEqual(consumedNames, ['Milo']);

if (false) {
  const unsafe: Consumer<Animal> = {
    // @ts-expect-error -- 只能消费 Dog 的函数不能承诺消费任意 Animal。
    consume: (dog: Dog) => void dog.bark(),
  };
  void unsafe;
}

console.log('=== 第 07 课：泛型关系与推断 ===');
console.log({
  literal,
  genericPair,
  unionPair,
  lengths,
  inspected,
  maxSteps,
  route,
  color,
  defaultContainer,
  numberContainer,
  stackSize: stack.size,
  worker,
});

export {};
