import assert from 'node:assert/strict';

/**
 * 第 10 课：Utility Types 的真实语义与工程边界
 *
 * 工具类型只是 checker 中的类型变换：多数是浅层的，不会复制、过滤、冻结或验证运行时对象。
 * 本课不只列 API，而是验证它们在 PATCH DTO、白名单、安全边界、overload 和 thenable 中的行为。
 *
 * 运行：npx tsx src/10-utility-types.ts
 */

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Condition extends true> = Condition;

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

type EditableUserFields = 'name' | 'email' | 'age' | 'preferences';
type UserPatch = Partial<Pick<User, EditableUserFields>>;

function updateUser(user: User, patch: UserPatch): User {
  return { ...user, ...patch };
}

const updated = updateUser(originalUser, { age: 31 });
assert.equal(updated.age, 31);
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

interface Options {
  debug?: boolean;
  label?: string | undefined;
}

type RequiredOptions = Required<Options>;
type _DebugRequired = Expect<Equal<RequiredOptions['debug'], boolean>>;
type _LabelStillUndefined = Expect<Equal<RequiredOptions['label'], string | undefined>>;

const options: RequiredOptions = { debug: true, label: undefined };
assert.equal(options.label, undefined);

// Required 只移除 `?` 修饰符，不会递归删除值类型中显式写出的 undefined。

// ---------------------------------------------------------------------------
// 3. Readonly 是浅静态视图，不是 Object.freeze
// ---------------------------------------------------------------------------

const readonlyUser: Readonly<User> = originalUser;

if (false) {
  // @ts-expect-error -- 顶层属性只读。
  readonlyUser.name = 'Bob';
}

readonlyUser.preferences.flags.push('tools'); // 嵌套对象类型没有被递归 Readonly
assert.deepEqual(originalUser.preferences.flags, ['streaming', 'tools']);
assert.equal(Object.isFrozen(readonlyUser), false);

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

type CreateUserInput = Omit<User, 'id'>;

let nextUserId = 100;

function createUserUnsafe(input: CreateUserInput): User {
  nextUserId += 1;
  return { id: nextUserId, ...input };
}

function createUserWhitelisted(input: CreateUserInput): User {
  nextUserId += 1;
  const { name, email, age, preferences } = input;
  return { id: nextUserId, name, email, age, preferences };
}

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

assert.equal(Object.hasOwn(unsafeCreated, 'isAdmin'), true);
assert.equal(Object.hasOwn(safeCreated, 'isAdmin'), false);

// 在安全/序列化边界要显式构造白名单对象或使用 runtime schema，不能把 Omit 当 sanitizer。

// ---------------------------------------------------------------------------
// 5. Record：静态完整键集，不会验证 JSON，也不改变 JS key coercion
// ---------------------------------------------------------------------------

type Role = 'admin' | 'editor' | 'viewer';
type Permissions = Record<Role, boolean>;

const permissions: Permissions = {
  admin: true,
  editor: true,
  viewer: false,
};
assert.deepEqual(Object.keys(permissions), ['admin', 'editor', 'viewer']);

const liedFromJson = JSON.parse('{}') as Permissions;
assert.equal(liedFromJson.admin, undefined); // assertion 没有生成缺键检查

const numericKeys: Record<number, string> = { 1: 'one', 2: 'two' };
assert.deepEqual(Object.keys(numericKeys), ['1', '2']);
assert.equal(numericKeys[1], numericKeys['1']);

// ---------------------------------------------------------------------------
// 6. Exclude/Extract 是按 assignability 对 union 成员做过滤
// ---------------------------------------------------------------------------

type AgentEvent =
  | { readonly kind: 'token'; readonly text: string }
  | { readonly kind: 'tool'; readonly callId: string }
  | { readonly kind: 'done'; readonly usage: number };

type NonTerminalEvent = Exclude<AgentEvent, { readonly kind: 'done' }>;
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

type MaybeMessage = string | null | undefined;
type Message = NonNullable<MaybeMessage>;
type _Message = Expect<Equal<Message, string>>;

function requireMessage(value: MaybeMessage): Message {
  if (value === null || value === undefined) throw new TypeError('message required');
  return value;
}

assert.equal(requireMessage('ok'), 'ok');
assert.throws(() => requireMessage(null), TypeError);

// ---------------------------------------------------------------------------
// 8. ReturnType/Parameters 与 overload 的“最后签名”
// ---------------------------------------------------------------------------

function parseValue(value: string): number;
function parseValue(value: number): string;
function parseValue(value: string | number): string | number {
  return typeof value === 'string' ? Number(value) : String(value);
}

type ParsedReturn = ReturnType<typeof parseValue>;
type ParsedParameters = Parameters<typeof parseValue>;

// 对 overload，条件类型推断使用最后一个可见 overload 签名，不会构造每个重载的相关联合。
type _ParsedReturn = Expect<Equal<ParsedReturn, string>>;
type _ParsedParameters = Expect<Equal<ParsedParameters, [value: number]>>;

assert.equal(parseValue('42'), 42);
assert.equal(parseValue(42), '42');

// 元组 label `value` 只改善编辑器展示，不参与可赋值性。

// ---------------------------------------------------------------------------
// 9. ConstructorParameters / InstanceType 保持 factory 关系
// ---------------------------------------------------------------------------

class Job {
  readonly name: string;
  readonly priority: number;

  constructor(name: string, priority: number) {
    this.name = name;
    this.priority = priority;
  }
}

type JobArgs = ConstructorParameters<typeof Job>;
type JobInstance = InstanceType<typeof Job>;

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

type ResolvedThenable = Awaited<typeof customThenable>;
type ResolvedNested = Awaited<Promise<Promise<{ readonly ok: true }>>>;
type _ThenableNumber = Expect<Equal<ResolvedThenable, number>>;
type _Nested = Expect<Equal<ResolvedNested, { readonly ok: true }>>;

const awaited = await customThenable;
assert.equal(awaited, 42);

// ---------------------------------------------------------------------------
// 11. this 参数工具：this 只存在于静态函数签名，不是运行时实参
// ---------------------------------------------------------------------------

function formatWithPrefix(this: { readonly prefix: string }, value: number): string {
  return `${this.prefix}${value}`;
}

type PrefixContext = ThisParameterType<typeof formatWithPrefix>;
type DetachedFormatter = OmitThisParameter<typeof formatWithPrefix>;
type _Prefix = Expect<Equal<PrefixContext, { readonly prefix: string }>>;

const detachedFormatter: DetachedFormatter = formatWithPrefix.bind({ prefix: '#' });
assert.equal(detachedFormatter(7), '#7');

// ---------------------------------------------------------------------------
// 12. NoInfer 是推断控制，不改变结果类型
// ---------------------------------------------------------------------------

function createState<State>(initial: State, resetValue: NoInfer<State>): {
  readonly initial: State;
  readonly resetValue: State;
} {
  return { initial, resetValue };
}

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
