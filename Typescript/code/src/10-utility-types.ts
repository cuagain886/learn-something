import assert from 'node:assert/strict';

/**
 * 第 10 课：Utility Types 的真实语义与工程边界
 *
 * 工具类型只是 checker 中的类型变换：多数是浅层的，不会复制、过滤、冻结或验证运行时对象。
 * 本课不只列 API，而是验证它们在 PATCH DTO、白名单、安全边界、overload 和 thenable 中的行为。
 *
 * 运行：npx tsx src/10-utility-types.ts
 */

// ---------------------------------------------------------------------------
// 编译期测试工具：Equal / Expect（沿用第 07 课）
// ---------------------------------------------------------------------------
// 仅用于在文件内写"编译期断言"：`type _X = Expect<Equal<Actual, Expected>>`。
// Actual 与 Expected 不等时 `Condition extends true` 不成立，tsc 直接报错。
type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2)
    ? true
    : false;
// Expect 把条件约束为 true：任何非 true 的类型都无法满足 `extends true`。
type Expect<Condition extends true> = Condition;

// User：贯穿全课的领域模型，preferences 是嵌套对象，后续用来对比浅/深 Readonly。
interface User {
  readonly id: number;
  name: string;
  email: string;
  age: number;
  preferences: {
    theme: 'light' | 'dark';
    flags: string[];
  };
}

// originalUser：运行时使用的具体实例，后续多个 utility 类型视图都指向同一个对象。
const originalUser: User = {
  id: 1,
  name: 'Alice',
  email: 'alice@example.com',
  age: 30,
  preferences: { theme: 'dark', flags: ['streaming'] },
};

// ---------------------------------------------------------------------------
// 1. Partial：PATCH 应先选择允许字段，再变 optional
// ---------------------------------------------------------------------------

// EditableUserFields：先显式列出允许修改的字段，作为白名单（注意不含 id）。
type EditableUserFields = 'name' | 'email' | 'age' | 'preferences';
// UserPatch = Partial<Pick<...>>：先 Pick 出白名单字段，再整体变 optional。
// 比直接 Partial<User> 更安全——id 根本不在 patch 的键集合里。
type UserPatch = Partial<Pick<User, EditableUserFields>>;

// updateUser：用 spread 把 patch 合并到现有 user，未传字段保持原值。
function updateUser(user: User, patch: UserPatch): User {
  return { ...user, ...patch };
}

const updated = updateUser(originalUser, { age: 31 });
assert.equal(updated.age, 31);
// id 不在 EditableUserFields 中，patch 即使想改也无能为力。
assert.equal(updated.id, 1);

if (false) {
  // 直接 Partial<User> 会允许修改 id；Pick 白名单先移除了这个能力。
  // @ts-expect-error -- id 不是可编辑字段。
  updateUser(originalUser, { id: 99 });

  // exactOptionalPropertyTypes 下，“缺少 name”和“显式 name: undefined”不同。
  // @ts-expect-error -- name 的值类型没有 undefined。
  const invalidUndefined: UserPatch = { name: undefined };
  void invalidUndefined;
}

// 即使静态 UserPatch 正确，来自 JSON 的 unknown 仍需要运行时字段白名单/类型验证。

// ---------------------------------------------------------------------------
// 2. Required 不等于 NonNullable
// ---------------------------------------------------------------------------

// Options：debug 是 `boolean?`（隐式 undefined），label 是 `string | undefined?`（显式 undefined）。
interface Options {
  debug?: boolean;
  label?: string | undefined;
}

// Required 只去掉 ? 修饰符，不会动值类型里显式写出的 undefined。
type RequiredOptions = Required<Options>;
// debug：去掉 ? 后是 boolean。
type _DebugRequired = Expect<Equal<RequiredOptions['debug'], boolean>>;
// label：去掉 ? 后仍是 string | undefined（因为值类型原本就包含 undefined）。
type _LabelStillUndefined = Expect<Equal<RequiredOptions['label'], string | undefined>>;

// 因此 label 可以显式赋值为 undefined 而不报错。
const options: RequiredOptions = { debug: true, label: undefined };
assert.equal(options.label, undefined);

// Required 只移除 `?` 修饰符，不会递归删除值类型中显式写出的 undefined。

// ---------------------------------------------------------------------------
// 3. Readonly 是浅静态视图，不是 Object.freeze
// ---------------------------------------------------------------------------

// readonlyUser：Readonly<User> 只是把顶层属性标为只读，运行时对象没被冻结，
// 嵌套对象（preferences.flags）也不是 readonly。
const readonlyUser: Readonly<User> = originalUser;

if (false) {
  // @ts-expect-error -- 顶层属性只读。
  readonlyUser.name = 'Bob';
}

// 顶层不能赋值，但嵌套数组仍可 push——Readonly 是浅层视图。
readonlyUser.preferences.flags.push('tools'); // 嵌套对象类型没有被递归 Readonly
assert.deepEqual(originalUser.preferences.flags, ['streaming', 'tools']);
// 同一对象引用，运行时并未被 Object.freeze。
assert.equal(Object.isFrozen(readonlyUser), false);

// DeepReadonly：手写一个递归版 Readonly。
// 三条分支分别处理：函数（直接返回，避免破坏 callable）、数组（递归元素）、普通对象（递归字段）。
type DeepReadonly<T> =
  T extends (...args: never[]) => unknown
    ? T
    : T extends readonly unknown[]
      ? { readonly [Index in keyof T]: DeepReadonly<T[Index]> }
      : T extends object
        ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : T;

type DeepReadonlyUser = DeepReadonly<User>;
const deepView: DeepReadonlyUser = originalUser;

if (false) {
  // @ts-expect-error -- 自定义 DeepReadonly 递归到了 flags 元素容器。
  deepView.preferences.flags.push('forbidden');
}

// 它仍只是静态视图：同一对象通过 mutable alias `originalUser` 仍能改变。
originalUser.preferences.theme = 'light';
assert.equal(deepView.preferences.theme, 'light');

// ---------------------------------------------------------------------------
// 4. Pick/Omit 不会删除运行时额外字段
// ---------------------------------------------------------------------------

// CreateUserInput：用 Omit 从 User 派生"创建输入"，去掉服务端生成的 id。
type CreateUserInput = Omit<User, 'id'>;

// nextUserId：模拟服务端自增主键。
let nextUserId = 100;

// createUserUnsafe：用 spread 把 input 直接合并进新对象——额外字段会一起带过来。
function createUserUnsafe(input: CreateUserInput): User {
  nextUserId += 1;
  return { id: nextUserId, ...input };
}

// createUserWhitelisted：手工解构只取已知字段，多出来的字段被丢弃。
function createUserWhitelisted(input: CreateUserInput): User {
  nextUserId += 1;
  const { name, email, age, preferences } = input;
  return { id: nextUserId, name, email, age, preferences };
}

// objectWithExtraCapability：恶意/意外带上 isAdmin 的输入。
const objectWithExtraCapability = {
  name: 'Mallory',
  email: 'mallory@example.com',
  age: 28,
  preferences: { theme: 'dark' as const, flags: [] as string[] },
  isAdmin: true,
};

// 变量通过结构类型赋值时允许额外字段；Omit 只改变静态可见 shape。
const createInput: CreateUserInput = objectWithExtraCapability;
const unsafeCreated = createUserUnsafe(createInput);
const safeCreated = createUserWhitelisted(createInput);

// unsafe 版把 isAdmin 带进了新对象；whitelisted 版没有。
assert.equal(Object.hasOwn(unsafeCreated, 'isAdmin'), true);
assert.equal(Object.hasOwn(safeCreated, 'isAdmin'), false);

// 在安全/序列化边界要显式构造白名单对象或使用 runtime schema，不能把 Omit 当 sanitizer。

// ---------------------------------------------------------------------------
// 5. Record：静态完整键集，不会验证 JSON，也不改变 JS key coercion
// ---------------------------------------------------------------------------

// Role：有限的字面量联合。
type Role = 'admin' | 'editor' | 'viewer';
// Permissions：Record 强制要求每个 Role 都有对应值，不能漏键。
type Permissions = Record<Role, boolean>;

const permissions: Permissions = {
  admin: true,
  editor: true,
  viewer: false,
};
assert.deepEqual(Object.keys(permissions), ['admin', 'editor', 'viewer']);

// liedFromJson：JSON.parse 出来是空对象，强转成 Permissions 是"撒谎"——
// 类型系统不会生成缺键检查，运行时 admin 实际是 undefined。
const liedFromJson = JSON.parse('{}') as Permissions;
assert.equal(liedFromJson.admin, undefined); // assertion 没有生成缺键检查

// numericKeys：JS 中数字键会被字符串化；Record<number, string> 的 keyof 实际是 number，
// 但 Object.keys 返回字符串数组。
const numericKeys: Record<number, string> = { 1: 'one', 2: 'two' };
assert.deepEqual(Object.keys(numericKeys), ['1', '2']);
// 数字 1 与字符串 '1' 访问的是同一个属性。
assert.equal(numericKeys[1], numericKeys['1']);

// ---------------------------------------------------------------------------
// 6. Exclude/Extract 是按 assignability 对 union 成员做过滤
// ---------------------------------------------------------------------------

// AgentEvent：可辨识联合，3 个 variant 通过 kind 区分。
type AgentEvent =
  | { readonly kind: 'token'; readonly text: string }
  | { readonly kind: 'tool'; readonly callId: string }
  | { readonly kind: 'done'; readonly usage: number };

// Exclude：从 union 中剔除"可赋值给 { kind: 'done' }"的成员，剩下 token 与 tool。
type NonTerminalEvent = Exclude<AgentEvent, { readonly kind: 'done' }>;
// Extract：只保留"可赋值给 { kind: 'tool' }"的成员。
type ToolEvent = Extract<AgentEvent, { readonly kind: 'tool' }>;

type _ToolEvent = Expect<Equal<
  ToolEvent,
  { readonly kind: 'tool'; readonly callId: string }
>>;
type _NonTerminalKind = Expect<Equal<NonTerminalEvent['kind'], 'token' | 'tool'>>;

// Exclude 不是字符串集合专用，也不是名义相等；它逐成员判断 `member extends U`。

// ---------------------------------------------------------------------------
// 7. NonNullable 只变换类型；运行时仍要检查
// ---------------------------------------------------------------------------

// MaybeMessage：string 与 null/undefined 的联合。
type MaybeMessage = string | null | undefined;
// NonNullable 在类型层剔除 null 与 undefined，得到 string。
type Message = NonNullable<MaybeMessage>;
type _Message = Expect<Equal<Message, string>>;

// requireMessage：类型上的 NonNullable 不会自动验证输入——
// 必须在运行时显式 throw，才能保证返回值真的非空。
function requireMessage(value: MaybeMessage): Message {
  if (value === null || value === undefined) throw new TypeError('message required');
  // 此处 value 被收窄为 string，可以安全返回为 Message。
  return value;
}

assert.equal(requireMessage('ok'), 'ok');
assert.throws(() => requireMessage(null), TypeError);

// ---------------------------------------------------------------------------
// 8. ReturnType/Parameters 与 overload 的“最后签名”
// ---------------------------------------------------------------------------

// parseValue 是一个有 2 个 overload 的函数：
// 字符串入参返回 number，数字入参返回 string。
function parseValue(value: string): number;
function parseValue(value: number): string;
// 实现签名（必须兼容所有 overload）。
function parseValue(value: string | number): string | number {
  return typeof value === 'string' ? Number(value) : String(value);
}

// ReturnType/Parameters 对 overload 函数只看"最后一个签名"，不会做联合推断。
type ParsedReturn = ReturnType<typeof parseValue>;
type ParsedParameters = Parameters<typeof parseValue>;

// 对 overload，条件类型推断使用最后一个可见 overload 签名，不会构造每个重载的相关联合。
// 因此 ReturnType 是 string（第二签名的返回），Parameters 是 [value: number]。
type _ParsedReturn = Expect<Equal<ParsedReturn, string>>;
type _ParsedParameters = Expect<Equal<ParsedParameters, [value: number]>>;

// 运行时按实际入参类型选择 overload，与静态 ReturnType 推断结果不一定一致。
assert.equal(parseValue('42'), 42);
assert.equal(parseValue(42), '42');

// 元组 label `value` 只改善编辑器展示，不参与可赋值性。

// ---------------------------------------------------------------------------
// 9. ConstructorParameters / InstanceType 保持 factory 关系
// ---------------------------------------------------------------------------

// Job：一个普通 class，构造函数接收 (name, priority)。
class Job {
  readonly name: string;
  readonly priority: number;

  constructor(name: string, priority: number) {
    this.name = name;
    this.priority = priority;
  }
}

// JobArgs：构造函数参数 tuple 类型；JobInstance：实例类型。
// 二者保持"由同一个 class 派生"的关联，方便写 factory。
type JobArgs = ConstructorParameters<typeof Job>;
type JobInstance = InstanceType<typeof Job>;

// makeJob：用 JobArgs 作为 rest 参数类型，把任意构造函数变成工厂函数。
function makeJob(...args: JobArgs): JobInstance {
  return new Job(...args);
}

const job = makeJob('index-code', 2);
assert.equal(job instanceof Job, true);
assert.deepEqual({ name: job.name, priority: job.priority }, {
  name: 'index-code',
  priority: 2,
});

// ---------------------------------------------------------------------------
// 10. Awaited 模拟 await：递归吸收 PromiseLike/thenable
// ---------------------------------------------------------------------------

// customThenable：手写一个 PromiseLike<number> 对象（有 then 方法）。
// 不是真正的 Promise，但任何符合 PromiseLike 协议的对象都能被 await。
const customThenable: PromiseLike<number> = {
  then<TResult1 = number, TResult2 = never>(
    onfulfilled?: ((value: number) => TResult1 | PromiseLike<TResult1>) | null,
    _onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const value = onfulfilled === undefined || onfulfilled === null
      ? 42 as TResult1
      : onfulfilled(42);
    return Promise.resolve(value);
  },
};

// Awaited 递归解开 PromiseLike，最终给出内部值的类型。
type ResolvedThenable = Awaited<typeof customThenable>;
type ResolvedNested = Awaited<Promise<Promise<{ readonly ok: true }>>>;
// 嵌套 Promise 被递归展开成最内层类型。
type _ThenableNumber = Expect<Equal<ResolvedThenable, number>>;
type _Nested = Expect<Equal<ResolvedNested, { readonly ok: true }>>;

// 运行时 await 调用 then，得到 42。
const awaited = await customThenable;
assert.equal(awaited, 42);

// ---------------------------------------------------------------------------
// 11. this 参数工具：this 只存在于静态函数签名，不是运行时实参
// ---------------------------------------------------------------------------

// formatWithPrefix：第一个参数 `this: {...}` 是"this 参数"——
// 它只在类型层声明调用时 this 必须是什么形状，运行时不会出现在实参列表里。
function formatWithPrefix(this: { readonly prefix: string }, value: number): string {
  return `${this.prefix}${value}`;
}

// ThisParameterType 取出 this 参数类型；OmitThisParameter 返回"剥离 this 后"的函数类型。
type PrefixContext = ThisParameterType<typeof formatWithPrefix>;
type DetachedFormatter = OmitThisParameter<typeof formatWithPrefix>;
type _Prefix = Expect<Equal<PrefixContext, { readonly prefix: string }>>;

// 用 .bind 把 this 绑定到具体对象，得到一个无 this 参数的新函数，符合 DetachedFormatter。
const detachedFormatter: DetachedFormatter = formatWithPrefix.bind({ prefix: '#' });
assert.equal(detachedFormatter(7), '#7');

// ---------------------------------------------------------------------------
// 12. NoInfer 是推断控制，不改变结果类型
// ---------------------------------------------------------------------------

// createState：State 由 initial 推断；resetValue 标 NoInfer<State>，
// 表示它只能消费已推断出的 State，不能反向贡献候选。
function createState<State>(initial: State, resetValue: NoInfer<State>): {
  readonly initial: State;
  readonly resetValue: State;
} {
  return { initial, resetValue };
}

// initial 推出 'idle'，resetValue 必须能赋给 NoInfer<'idle'>，即只能传 'idle'。
const state = createState({ status: 'idle' as const }, { status: 'idle' });
assert.equal(state.resetValue.status, 'idle');

if (false) {
  // @ts-expect-error -- resetValue 不能把从 initial 推出的 'idle' 扩成 string。
  createState({ status: 'idle' as const }, { status: 'running' });
}

console.log('=== 第 10 课：Utility Types 的真实边界 ===');
console.log({
  updated,
  options,
  readonlyIsFrozen: Object.isFrozen(readonlyUser),
  unsafeExtraField: Object.hasOwn(unsafeCreated, 'isAdmin'),
  safeExtraField: Object.hasOwn(safeCreated, 'isAdmin'),
  permissions,
  numericKeys,
  job,
  awaited,
  formatted: detachedFormatter(7),
});

export {};
