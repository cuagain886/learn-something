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

// ---------------------------------------------------------------------------
// 编译期测试工具：Equal / Expect
// ---------------------------------------------------------------------------
// 下面这两个工具类型本身不参与运行时，只用于在文件里写“编译期断言”：
//   type _X = Expect<Equal<ActualType, ExpectedType>>
// 如果 ActualType 和 ExpectedType 不相等，`Condition extends true` 不成立，
// tsc 会在这一行直接报错。这样我们就能像写单元测试一样验证“类型推断的结果”。
// 其原理是利用“函数类型在比较时的更高阶等价判定”，比单纯 `A extends B ? ...` 更严格。
type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2)
    ? true
    : false;
// Expect 接收一个必须为 true 的条件；任何非 true 的类型都无法满足 `extends true`。
type Expect<Condition extends true> = Condition;

// ---------------------------------------------------------------------------
// 1. any、unknown 与泛型关系
// ---------------------------------------------------------------------------
// 这一节对比三种“能接受任意值”的签名，看出泛型真正的价值不是“宽松”，而是“保留关系”。

// ① any 版本：参数和返回值都是 any。
//    它能接受任意输入并原样返回，但返回值也被污染成 any —— 编译器彻底放弃检查。
function identityAny(value: any): any {
  return value;
}

// ② unknown 版本：unknown 是“安全的顶类型”，可以接受任意值，
//    但调用方在使用返回值前必须先把它收窄成具体类型（否则连方法都调不了）。
function identityUnknown(value: unknown): unknown {
  return value;
}

// ③ 泛型版本：类型参数 T 同时出现在“参数”和“返回值”两个位置。
//    这建立了一种约束：输出类型 = 输入类型。调用点传 'hello'，T 被推断为字面量 'hello'，
//    返回值的类型也就精确地是 'hello'，而不是被拓宽成 string 或退化成 any。
function identity<T>(value: T): T {
  return value;
}

// any 的危害：contaminated 类型是 any，下面这行不会报错，但运行时根本不存在这个方法。
const contaminated = identityAny('hello');
contaminated.notARealMethod?.(); // any 让错误继续传播，编译器不再保护

// unknown 的边界：safeBoundary 类型是 unknown，直接调用方法会被拒绝。
const safeBoundary = identityUnknown('hello');
// @ts-expect-error -- unknown 必须先收窄。
void safeBoundary.toUpperCase();

// 泛型的回报：literal 的类型被精确推断为 'hello'，可以安全调用字符串方法。
const literal = identity('hello');
// 编译期断言：typeof literal 必须正好是字面量 'hello'，而不是 string。
type _IdentityKeepsLiteral = Expect<Equal<typeof literal, 'hello'>>;
assert.equal(literal.toUpperCase(), 'HELLO');

// 泛型的关键不是“能接受多种类型”，而是同一个 T 同时出现在输入和输出，
// 把调用点的精确信息从一端传到另一端。

// ---------------------------------------------------------------------------
// 2. 泛型与联合：每次调用一个 T vs 实现只知道一个固定联合
// ---------------------------------------------------------------------------
// 对比“泛型函数”和“把参数写成固定联合的函数”，看两者返回类型精度有何不同。

// 泛型 duplicate：返回 readonly [T, T]，两个槽都是“这次调用时的同一个 T”。
function duplicate<T>(value: T): readonly [T, T] {
  return [value, value];
}

// 联合版 duplicateUnion：参数类型固定为 string | number，
// 因此返回类型的每个槽都是 string | number（丢了“两个槽其实是同一个具体类型”的信息）。
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
// 用类型表达“数组是否可能为空”，以及用 readonly 表达“我不修改你的数组”。

// 普通版：传入 readonly T[]，首元素可能是 undefined（空数组时）。
function first<T>(values: readonly T[]): T | undefined {
  return values[0];
}

// NonEmptyReadonlyArray：至少有一个 T 元素的只读数组（元组 + rest）。
// 第一个槽是确定的 T，后面是零或多个 T。这从类型层面排除了“空数组”。
type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

// 非空版：参数类型保证至少有一个元素，因此返回值直接是 T（不再有 undefined）。
function firstNonEmpty<T>(values: NonEmptyReadonlyArray<T>): T {
  return values[0];
}

assert.equal(first([]), undefined); // 空数组 → undefined
assert.equal(first([10, 20] as const), 10);
assert.equal(firstNonEmpty(['a', 'b']), 'a'); // 类型已保证非空，返回 'a'

if (false) {
  // @ts-expect-error -- 普通空数组不能证明至少有一个元素。
  firstNonEmpty([]);
}

// mapArray：泛型把“输入元素类型 Input”和“变换输出类型 Output”解耦，
// transform 的参数自动收窄成 Input，返回值类型成为新数组的元素类型。
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
// `T extends HasLength` 只是声明“T 至少要有 length 属性”，并不把 T 变成 HasLength。

// HasLength：一个最小的结构能力契约——只要有 readonly length: number 就算合格。
type HasLength = { readonly length: number };

// constraint `T extends HasLength`：要求 T 必须具备 length 属性（最低能力），
// 但 T 本身保留调用者传入的完整类型（包括额外字段）。
function inspectLength<T extends HasLength>(value: T): {
  readonly original: T;
  readonly length: number;
} {
  // 返回值里 original 的类型仍是完整的 T，而不是被截断成 HasLength。
  return { original: value, length: value.length };
}

// 传入一个带额外字段 unit 的对象，constraint 只检查 length 是否存在。
const inspected = inspectLength({ length: 3, unit: 'tokens' as const });
// 断言：original.unit 的类型仍精确保留为字面量 'tokens'，没有被擦除成 string。
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
// 让“key 参数”和“返回值类型”联动：取哪个 key，返回值就是那个 key 对应的值类型。

// 两个类型参数：ObjectType 是对象类型，Key 被约束为 keyof ObjectType（只能是真实存在的键）。
// 返回值类型 ObjectType[Key] 会随 Key 的不同而精确变化。
function getProperty<ObjectType, Key extends keyof ObjectType>(
  object: ObjectType,
  key: Key,
): ObjectType[Key] {
  return object[key];
}

// as const 让对象的所有值都成为字面量类型（id 是字面量、maxSteps 是 8 而非 number）。
const agent = {
  id: 'run_1',
  maxSteps: 8,
  streaming: true,
} as const;

// 取 'maxSteps'：返回值类型精确为字面量 8，而不是宽泛的 number。
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
// `<const T>` 让函数作者声明“请优先保留字面量候选”，调用方不必每次都写 as const。

// const 修饰类型参数 Segments：rest 参数会被推断为 readonly 字面量元组，
// 而不是被拓宽成 string[]。
function defineRoute<const Segments extends readonly string[]>(
  ...segments: Segments
): Segments {
  return segments;
}

// 无需 as const，route 的类型就是精确的 readonly ['agents', ':id', 'events']。
const route = defineRoute('agents', ':id', 'events');
type _RouteTuple = Expect<Equal<typeof route, readonly ['agents', ':id', 'events']>>;
assert.deepEqual(route, ['agents', ':id', 'events']);

// `as const` 由调用方控制；const type parameter 让 API 作者声明“请优先保留字面量候选”。

// ---------------------------------------------------------------------------
// 7. NoInfer：一个参数消费既有推断，不反向扩大候选集合
// ---------------------------------------------------------------------------
// 某些参数只应“使用”已推断出的类型，不应自己反过来给推断贡献新候选。

// choices 是推断来源（决定 Color 的候选集合）；defaultColor 标注 NoInfer<Color>，
// 表示它只能消费 choices 推断出的 Color，不能把传入的值加入候选、从而扩大 Color。
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
// `<T = string>` 表示：当调用方既没显式传 T、也无法从实参推断出 T 时，才用 string 兜底。

// 接口类型参数带默认值：不写 T 时 T = string。
interface Container<T = string> {
  readonly value: T;
}

// 不提供类型参数 → 使用默认 string。
const defaultContainer: Container = { value: 'text' };
// 显式提供 → 用提供的 number，覆盖默认。
const numberContainer: Container<number> = { value: 42 };

// 函数类型参数同样可以带默认值。
function emptyContainer<T = string>(): { value: T | undefined } {
  return { value: undefined };
}

// 调用时没有实参可推断 T，于是使用默认 string，value 类型为 string | undefined。
const empty = emptyContainer();
type _DefaultUsedWithoutCandidate = Expect<Equal<typeof empty.value, string | undefined>>;

// 默认类型不是“推断失败就不报错”：显式参数/实参产生候选时，以候选为准。

// ---------------------------------------------------------------------------
// 9. 泛型类：T 属于实例侧，static 侧只有一份
// ---------------------------------------------------------------------------
// 类的类型参数 T 只在“实例侧”有效；所有实例共享同一份 static 侧，static 里不能引用 T。

class Stack<T> {
  // #items 是私有字段，每个实例持有自己的 T[]。
  readonly #items: T[] = [];

  // push 参数类型是 T：只能压入与栈实例相同的元素类型。
  push(value: T): void {
    this.#items.push(value);
  }

  // pop 返回 T | undefined：空栈时返回 undefined。
  pop(): T | undefined {
    return this.#items.pop();
  }

  // getter：暴露只读的当前长度。
  get size(): number {
    return this.#items.length;
  }

  // @ts-expect-error -- 所有 Stack<T> 共享同一个 constructor/static 侧，不能引用实例侧 T。
  static invalidValue: T;
}

// 创建一个“装 number”的栈：此时实例侧的 T = number。
const stack = new Stack<number>();
stack.push(1);
stack.push(2);
assert.equal(stack.pop(), 2); // LIFO：后进先出
assert.equal(stack.size, 1);

// 运行时只有 Stack 构造函数，`new Stack<number>() instanceof Stack<string>` 这种问题没有意义；
// `<number>`/`<string>` 在 emit 后都消失。
assert.equal(stack instanceof Stack, true);

// ---------------------------------------------------------------------------
// 10. 构造签名：泛型 factory 要描述 static/constructor 侧
// ---------------------------------------------------------------------------
// 泛型工厂函数需要描述“可被 new 的东西”，这要用构造签名 `new (...) => Instance`。

// Constructor：描述一个构造函数——能用给定参数 tuple Args new 出 Instance 实例。
type Constructor<Instance, Args extends readonly unknown[]> =
  new (...args: Args) => Instance;

// construct 是一个泛型工厂：传入构造函数和它的参数，返回 new 出来的实例。
// Args 是参数 tuple，保持了“位置 + 类型”的精确关系。
function construct<Instance, Args extends readonly unknown[]>(
  ctor: Constructor<Instance, Args>,
  ...args: Args
): Instance {
  return new ctor(...args);
}

// 一个普通的具体类，构造函数接收 (name, concurrency)。
class ToolWorker {
  readonly name: string;
  readonly concurrency: number;

  constructor(name: string, concurrency: number) {
    this.name = name;
    this.concurrency = concurrency;
  }
}

// 把类本身作为构造函数传入，参数顺序/类型由 Args 推断并校验。
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
// TS 不需要你标注 in/out；协变/逆变由 T 出现在“输出”还是“输入”位置自然决定。

type Animal = { readonly name: string };
type Dog = Animal & { readonly bark: () => string };

// Producer<T>：T 出现在“输出”位置（produce 返回 T）→ 协变。
type Producer<T> = { readonly produce: () => T };
// Consumer<T>：T 出现在“输入”位置（consume 接收 T）→ 逆变。
type Consumer<T> = { readonly consume: (value: T) => void };

const dogProducer: Producer<Dog> = {
  produce: () => ({ name: 'Rex', bark: () => 'woof' }),
};
// 协变：能产出 Dog 的，也能当成“能产出 Animal”的来用（Dog 是 Animal 的子类型）。
const animalProducer: Producer<Animal> = dogProducer; // 输出位置协变
assert.equal(animalProducer.produce().name, 'Rex');

const consumedNames: string[] = [];
const animalConsumer: Consumer<Animal> = {
  consume: (value) => consumedNames.push(value.name),
};
// 逆变：能消费任意 Animal 的，也能当成“能消费 Dog”的来用。
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
