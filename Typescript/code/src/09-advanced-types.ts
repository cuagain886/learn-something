import assert from 'node:assert/strict';

/**
 * 第 09 课：类型级算法
 *
 * mapped/conditional/infer/template literal type 在 checker 中求值，不生成运行时代码。
 * 本课用编译期 Expect 契约验证结果，并用少量运行时 parser 对比“类型集合”与“外部字符串”。
 *
 * 运行：npx tsx src/09-advanced-types.ts
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

// ---------------------------------------------------------------------------
// 1. keyof：有限对象键与索引签名并不相同
// ---------------------------------------------------------------------------

// Person：一个具体 interface，键集合是有限的 id/name/age。
interface Person {
  readonly id: number;
  name: string;
  age?: number;
}

// keyof 对有限对象取所有键（含 optional 键）的字符串字面量 union。
type PersonKeys = keyof Person;
type _PersonKeys = Expect<Equal<PersonKeys, 'id' | 'name' | 'age'>>;

// StringDictionary：带 string 索引签名，键集合"无限"但被表示为 string | number。
type StringDictionary = { readonly [key: string]: boolean };
type DictionaryKeys = keyof StringDictionary;
type _DictionaryKeys = Expect<Equal<DictionaryKeys, string | number>>;

// JavaScript 中 obj[0] 与 obj['0'] 访问同一普通对象属性，所以 string index signature 的
// keyof 包含 number。symbol 只有显式 symbol index/属性时才进入键集合。

// 合法值：只能赋值 PersonKeys 中存在的字面量。
const personKey: PersonKeys = 'name';
if (false) {
  // @ts-expect-error -- 非法键不属于有限 union。
  const invalidKey: PersonKeys = 'email';
  void invalidKey;
}

// ---------------------------------------------------------------------------
// 2. 类型位置 typeof、字面量拓宽、as const 与 satisfies
// ---------------------------------------------------------------------------

// AgentConfig：定义一组字面量联合约束（mode）和具体值类型（retries）。
type AgentConfig = {
  readonly mode: 'fast' | 'accurate';
  readonly retries: number;
};

// as const + satisfies 组合：satisfies 先校验对象是否兼容 AgentConfig（不通过就报错），
// as const 则保留字面量类型（mode 是 'fast' 而非 string，retries 是 3 而非 number）。
// 这样既保证合规，又保住精确类型。
const defaultConfig = {
  mode: 'fast',
  retries: 3,
} as const satisfies AgentConfig;

// typeof 在"类型位置"取变量的静态类型，配合 indexed access 取出精确字面量。
type DefaultConfig = typeof defaultConfig;
type _ModeLiteral = Expect<Equal<DefaultConfig['mode'], 'fast'>>;
type _RetriesLiteral = Expect<Equal<DefaultConfig['retries'], 3>>;

// `satisfies` 检查兼容性但不把表达式注解成较宽的 AgentConfig；
// `as const` 则控制字面量/readonly 推断。二者均不冻结运行时对象。

assert.deepEqual(defaultConfig, { mode: 'fast', retries: 3 });

// ---------------------------------------------------------------------------
// 3. indexed access：键 union 映射为值 union
// ---------------------------------------------------------------------------

// Person[keyof Person] 取所有键对应值类型的 union——optional 属性会带入 undefined。
type PersonValues = Person[keyof Person];
type _PersonValues = Expect<Equal<PersonValues, number | string | undefined>>;

// 先用 Required 移除 ?，再取值 union，就不再有 undefined。
type RequiredPersonValues = Required<Person>[keyof Person];
type _RequiredValues = Expect<Equal<RequiredPersonValues, number | string>>;

// getProperty：与第 07 课相同的泛型，让"取哪个 key"和"返回值类型"精确联动。
function getProperty<ObjectType, Key extends keyof ObjectType>(
  object: ObjectType,
  key: Key,
): ObjectType[Key] {
  return object[key];
}

// as const 让所有字段值都成为字面量，所以 'name' 这个 key 取出来是 'Ada' 而非 string。
const person = { id: 1, name: 'Ada', age: 36 } as const;
const exactName = getProperty(person, 'name');
type _ExactName = Expect<Equal<typeof exactName, 'Ada'>>;

// ---------------------------------------------------------------------------
// 4. mapped type：映射键、修改修饰符、重映射/过滤键
// ---------------------------------------------------------------------------

// MyPartial：手动实现 Partial——遍历 T 的每个键，把值类型标为 optional。
type MyPartial<T> = {
  [Key in keyof T]?: T[Key];
};

// MutableRequired：同时去掉 readonly 和 ?——`-readonly` 与 `-?` 是修饰符"减法"。
type MutableRequired<T> = {
  -readonly [Key in keyof T]-?: T[Key];
};

// Getters：用 `as` 重映射键名为 `getXxx`，并把值类型变成返回该类型的函数；`-?` 同时去掉 optional。
// `Key extends string` 限定只有字符串键才参与重映射（symbol/number 会被过滤掉）。
type Getters<T> = {
  [Key in keyof T as Key extends string
    ? `get${Capitalize<Key>}`
    : never]-?: () => T[Key];
};

// KeysMatching：先映射成"符合条件的 Key、否则 never"，再用 [keyof T] 索引取出非 never 成员。
// 这是一种"按值类型过滤键"的常用模式。
type KeysMatching<T, Constraint> = {
  [Key in keyof T]-?: T[Key] extends Constraint ? Key : never;
}[keyof T];

// 用上面几个 mapped type 派生 Person 的具体形态。
type PersonPatch = MyPartial<Person>;
type ConcreteMutablePerson = MutableRequired<Person>;
type PersonGetters = Getters<Person>;
// Person 中只有 name 的值类型是 string，因此过滤后只剩 'name'。
type StringPersonKeys = KeysMatching<Person, string>;

type _StringKey = Expect<Equal<StringPersonKeys, 'name'>>;
// ConcreteMutablePerson.age 已去掉 ? 和 readonly，类型是确切的 number。
type _ConcreteAge = Expect<Equal<ConcreteMutablePerson['age'], number>>;

// PersonGetters 把每个字段变成 getXxx() 函数；对象必须提供全部这些方法。
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

// ToArray：裸 T 在 extends 左侧，会触发"对 union 每个成员分别求值"的分发规则。
type ToArray<T> = T extends unknown ? T[] : never;
// ToArrayTogether：用 [T] 把 T 包进 tuple，两侧不再是裸类型参数，从而抑制分发。
type ToArrayTogether<T> = [T] extends [unknown] ? T[] : never;

type Distributed = ToArray<string | number>;
type NonDistributed = ToArrayTogether<string | number>;

// 分发结果：string 与 number 各自变成数组，得到 string[] | number[]。
type _Distributed = Expect<Equal<Distributed, string[] | number[]>>;
// 不分发结果：整个 union 被当成一个类型，得到 Array<string | number>。
type _NonDistributed = Expect<Equal<NonDistributed, Array<string | number>>>;

// 裸类型参数 T 位于 extends 左侧时，对 union 每个成员分别求值；用 tuple 包住两侧可抑制分发。

// OnlyStrings：分发 + never 过滤的经典用法——从 union 中筛出符合约束的成员。
type OnlyStrings<T> = T extends string ? T : never;
type Filtered = OnlyStrings<'a' | 1 | 'b' | false>;
type _Filtered = Expect<Equal<Filtered, 'a' | 'b'>>;

// 分发过程：每个不匹配成员变成 never，最后 union 自动消去 never。

// ---------------------------------------------------------------------------
// 6. infer：从结构位置引入局部类型变量
// ---------------------------------------------------------------------------

// ElementOf：用 infer 给"数组的元素类型"命名——T 匹配 readonly (infer Element)[] 时提取 Element。
type ElementOf<T> = T extends readonly (infer Element)[] ? Element : never;
// FunctionResult：从函数类型中 infer 出返回值类型（参数用 never[] 占位，不关心具体参数）。
type FunctionResult<T> = T extends (...args: never[]) => infer Result ? Result : never;
// DeepAwaited：递归解包 PromiseLike，直到不再是 thenable 为止——模拟 await 的递归语义。
type DeepAwaited<T> = T extends PromiseLike<infer Value> ? DeepAwaited<Value> : T;

type _TupleElement = Expect<Equal<ElementOf<readonly [1, 'x', true]>, 1 | 'x' | true>>;
type _FunctionResult = Expect<Equal<FunctionResult<(input: string) => number>, number>>;
type _Awaited = Expect<Equal<DeepAwaited<Promise<Promise<{ ok: true }>>>, { ok: true }>>;

// infer 不是运行时反射；它只是让条件类型在匹配某个类型结构时给局部片段命名。

// ---------------------------------------------------------------------------
// 7. template literal type：字符串集合的笛卡尔积与解析
// ---------------------------------------------------------------------------

// Locale、Page 是字符串字面量联合；Route 是它们的笛卡尔积。
type Locale = 'zh' | 'en';
type Page = 'agents' | 'runs';
type Route = `/${Locale}/${Page}`;

type _Route = Expect<Equal<
  Route,
  '/zh/agents' | '/zh/runs' | '/en/agents' | '/en/runs'
>>;

// EventPayloads：用对象描述事件名 → 负载形状。
type EventPayloads = {
  token: { readonly text: string };
  tool_started: { readonly callId: string };
};

// EventHandlers：把每个事件名重映射成 onXxx，并把对应负载类型作为参数。
// mapped + 重映射 + template literal + Capitalize 一气呵成。
type EventHandlers<Events> = {
  [Name in keyof Events as Name extends string
    ? `on${Capitalize<Name>}`
    : never]: (payload: Events[Name]) => void;
};

// handlers 必须实现所有 onXxx 方法；payload 类型由 Events[Name] 自动推断。
const handlers: EventHandlers<EventPayloads> = {
  onToken: (payload) => assert.equal(typeof payload.text, 'string'),
  onTool_started: (payload) => assert.equal(typeof payload.callId, 'string'),
};

handlers.onToken({ text: 'hi' });
handlers.onTool_started({ callId: 'c1' });

// ParseRoute：用 template literal + infer 反向解析字符串，把路径切成 language/page。
// 两个 infer 出现在同一个模板里，分别捕获两段。
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

// Split：递归地把字符串按 / 切成元组。
// 每次匹配 `${Head}/${Tail}`，把 Head 放前面，对 Tail 继续递归；不能匹配时返回 [Path] 终止。
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

// locales/pages：用 Set 在运行时持有与类型集合一致的实际值，是类型与运行时同步的"单一事实源"。
const locales = new Set<Locale>(['zh', 'en']);
const pages = new Set<Page>(['agents', 'runs']);

// isRoute：从 string 进入 Route 必须经过运行时校验——类型集合不能验证外部输入。
// 用正则拆出两段，再用 Set.has 校验是否落在允许集合内。
function isRoute(value: string): value is Route {
  const match = /^\/([^/]+)\/([^/]+)$/.exec(value);
  if (match === null) return false;
  const language = match[1];
  const page = match[2];
  return locales.has(language as Locale) && pages.has(page as Page);
}

// routeFromNetwork：来自网络/用户的字符串，静态类型只是 string。
const routeFromNetwork: string = '/en/runs';
assert.equal(isRoute(routeFromNetwork), true);
// 谓词返回 true 后，routeFromNetwork 被收窄为 Route，可安全赋给 Route 类型的变量。
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
