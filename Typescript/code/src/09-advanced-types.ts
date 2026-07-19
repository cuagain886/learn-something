import assert from 'node:assert/strict';

/**
 * 第 09 课：类型级算法
 *
 * mapped/conditional/infer/template literal type 在 checker 中求值，不生成运行时代码。
 * 本课用编译期 Expect 契约验证结果，并用少量运行时 parser 对比“类型集合”与“外部字符串”。
 *
 * 运行：npx tsx src/09-advanced-types.ts
 */

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Condition extends true> = Condition;

// ---------------------------------------------------------------------------
// 1. keyof：有限对象键与索引签名并不相同
// ---------------------------------------------------------------------------

interface Person {
  readonly id: number;
  name: string;
  age?: number;
}

type PersonKeys = keyof Person;
type _PersonKeys = Expect<Equal<PersonKeys, 'id' | 'name' | 'age'>>;

type StringDictionary = { readonly [key: string]: boolean };
type DictionaryKeys = keyof StringDictionary;
type _DictionaryKeys = Expect<Equal<DictionaryKeys, string | number>>;

// JavaScript 中 obj[0] 与 obj['0'] 访问同一普通对象属性，所以 string index signature 的
// keyof 包含 number。symbol 只有显式 symbol index/属性时才进入键集合。

const personKey: PersonKeys = 'name';
if (false) {
  // @ts-expect-error -- 非法键不属于有限 union。
  const invalidKey: PersonKeys = 'email';
  void invalidKey;
}

// ---------------------------------------------------------------------------
// 2. 类型位置 typeof、字面量拓宽、as const 与 satisfies
// ---------------------------------------------------------------------------

type AgentConfig = {
  readonly mode: 'fast' | 'accurate';
  readonly retries: number;
};

const defaultConfig = {
  mode: 'fast',
  retries: 3,
} as const satisfies AgentConfig;

type DefaultConfig = typeof defaultConfig;
type _ModeLiteral = Expect<Equal<DefaultConfig['mode'], 'fast'>>;
type _RetriesLiteral = Expect<Equal<DefaultConfig['retries'], 3>>;

// `satisfies` 检查兼容性但不把表达式注解成较宽的 AgentConfig；
// `as const` 则控制字面量/readonly 推断。二者均不冻结运行时对象。

assert.deepEqual(defaultConfig, { mode: 'fast', retries: 3 });

// ---------------------------------------------------------------------------
// 3. indexed access：键 union 映射为值 union
// ---------------------------------------------------------------------------

type PersonValues = Person[keyof Person];
type _PersonValues = Expect<Equal<PersonValues, number | string | undefined>>;

type RequiredPersonValues = Required<Person>[keyof Person];
type _RequiredValues = Expect<Equal<RequiredPersonValues, number | string>>;

function getProperty<ObjectType, Key extends keyof ObjectType>(
  object: ObjectType,
  key: Key,
): ObjectType[Key] {
  return object[key];
}

const person = { id: 1, name: 'Ada', age: 36 } as const;
const exactName = getProperty(person, 'name');
type _ExactName = Expect<Equal<typeof exactName, 'Ada'>>;

// ---------------------------------------------------------------------------
// 4. mapped type：映射键、修改修饰符、重映射/过滤键
// ---------------------------------------------------------------------------

type MyPartial<T> = {
  [Key in keyof T]?: T[Key];
};

type MutableRequired<T> = {
  -readonly [Key in keyof T]-?: T[Key];
};

type Getters<T> = {
  [Key in keyof T as Key extends string
    ? `get${Capitalize<Key>}`
    : never]-?: () => T[Key];
};

type KeysMatching<T, Constraint> = {
  [Key in keyof T]-?: T[Key] extends Constraint ? Key : never;
}[keyof T];

type PersonPatch = MyPartial<Person>;
type ConcreteMutablePerson = MutableRequired<Person>;
type PersonGetters = Getters<Person>;
type StringPersonKeys = KeysMatching<Person, string>;

type _StringKey = Expect<Equal<StringPersonKeys, 'name'>>;
type _ConcreteAge = Expect<Equal<ConcreteMutablePerson['age'], number>>;

const getters: PersonGetters = {
  getId: () => 1,
  getName: () => 'Ada',
  getAge: () => 36,
};
assert.equal(getters.getName(), 'Ada');

// `never` 作为 remapped key 会删除该属性；作为 union 成员也会被吸收。

// ---------------------------------------------------------------------------
// 5. conditional type 的分发规则
// ---------------------------------------------------------------------------

type ToArray<T> = T extends unknown ? T[] : never;
type ToArrayTogether<T> = [T] extends [unknown] ? T[] : never;

type Distributed = ToArray<string | number>;
type NonDistributed = ToArrayTogether<string | number>;

type _Distributed = Expect<Equal<Distributed, string[] | number[]>>;
type _NonDistributed = Expect<Equal<NonDistributed, Array<string | number>>>;

// 裸类型参数 T 位于 extends 左侧时，对 union 每个成员分别求值；用 tuple 包住两侧可抑制分发。

type OnlyStrings<T> = T extends string ? T : never;
type Filtered = OnlyStrings<'a' | 1 | 'b' | false>;
type _Filtered = Expect<Equal<Filtered, 'a' | 'b'>>;

// 分发过程：每个不匹配成员变成 never，最后 union 自动消去 never。

// ---------------------------------------------------------------------------
// 6. infer：从结构位置引入局部类型变量
// ---------------------------------------------------------------------------

type ElementOf<T> = T extends readonly (infer Element)[] ? Element : never;
type FunctionResult<T> = T extends (...args: never[]) => infer Result ? Result : never;
type DeepAwaited<T> = T extends PromiseLike<infer Value> ? DeepAwaited<Value> : T;

type _TupleElement = Expect<Equal<ElementOf<readonly [1, 'x', true]>, 1 | 'x' | true>>;
type _FunctionResult = Expect<Equal<FunctionResult<(input: string) => number>, number>>;
type _Awaited = Expect<Equal<DeepAwaited<Promise<Promise<{ ok: true }>>>, { ok: true }>>;

// infer 不是运行时反射；它只是让条件类型在匹配某个类型结构时给局部片段命名。

// ---------------------------------------------------------------------------
// 7. template literal type：字符串集合的笛卡尔积与解析
// ---------------------------------------------------------------------------

type Locale = 'zh' | 'en';
type Page = 'agents' | 'runs';
type Route = `/${Locale}/${Page}`;

type _Route = Expect<Equal<
  Route,
  '/zh/agents' | '/zh/runs' | '/en/agents' | '/en/runs'
>>;

type EventPayloads = {
  token: { readonly text: string };
  tool_started: { readonly callId: string };
};

type EventHandlers<Events> = {
  [Name in keyof Events as Name extends string
    ? `on${Capitalize<Name>}`
    : never]: (payload: Events[Name]) => void;
};

const handlers: EventHandlers<EventPayloads> = {
  onToken: (payload) => assert.equal(typeof payload.text, 'string'),
  onTool_started: (payload) => assert.equal(typeof payload.callId, 'string'),
};

handlers.onToken({ text: 'hi' });
handlers.onTool_started({ callId: 'c1' });

type ParseRoute<Path extends string> =
  Path extends `/${infer Language}/${infer PageName}`
    ? { readonly language: Language; readonly page: PageName }
    : never;

type ParsedRoute = ParseRoute<'/zh/agents'>;
type _ParsedRoute = Expect<Equal<
  ParsedRoute,
  { readonly language: 'zh'; readonly page: 'agents' }
>>;

// ---------------------------------------------------------------------------
// 8. 递归类型算法与深度成本
// ---------------------------------------------------------------------------

type Split<Path extends string> =
  Path extends `${infer Head}/${infer Tail}`
    ? readonly [Head, ...Split<Tail>]
    : readonly [Path];

type Segments = Split<'agents/run/events'>;
type _Segments = Expect<Equal<Segments, readonly ['agents', 'run', 'events']>>;

// 递归、分发和 template union 交叉相乘会增加 checker 实例化成本。
// 真实库应限制递归深度/输入宽度，并用 --extendedDiagnostics 测量，而不是无限追求“类型体操”。

// ---------------------------------------------------------------------------
// 9. 类型集合不会验证外部字符串：配套 runtime parser
// ---------------------------------------------------------------------------

const locales = new Set<Locale>(['zh', 'en']);
const pages = new Set<Page>(['agents', 'runs']);

function isRoute(value: string): value is Route {
  const match = /^\/([^/]+)\/([^/]+)$/.exec(value);
  if (match === null) return false;
  const language = match[1];
  const page = match[2];
  return locales.has(language as Locale) && pages.has(page as Page);
}

const routeFromNetwork: string = '/en/runs';
assert.equal(isRoute(routeFromNetwork), true);
if (isRoute(routeFromNetwork)) {
  const checkedRoute: Route = routeFromNetwork;
  assert.equal(checkedRoute, '/en/runs');
}

assert.equal(isRoute('/fr/admin'), false);

if (false) {
  // @ts-expect-error -- 静态字面量不属于 Route 集合。
  const invalidRoute: Route = '/fr/admin';
  void invalidRoute;
}

console.log('=== 第 09 课：类型级算法 ===');
console.log({
  personKey,
  defaultConfig,
  exactName,
  patchExample: { name: 'Lin' } satisfies PersonPatch,
  getters: {
    id: getters.getId(),
    name: getters.getName(),
    age: getters.getAge(),
  },
  routeFromNetwork,
  routeValid: isRoute(routeFromNetwork),
});

export {};
