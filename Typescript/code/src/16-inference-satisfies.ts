/**
 * ============================================================
 * 第 16 课：Checker 的推断信息流与相关性保存
 * ============================================================
 *
 * 运行：npm run lesson:inference
 *
 * TypeScript 推断不是"看右边猜一个类型"这么简单。Checker 同时处理：
 *
 * - 自下而上的候选：字面量、对象成员、返回表达式；
 * - 自上而下的上下文：变量注解、回调参数、satisfies 目标；
 * - 可变性导致的 widening；
 * - 泛型参数多个出现位置贡献的候选与约束；
 * - name/key 与 input/output 之间是否仍保持相关性。
 *
 * 本课用编译期 Expect 和运行时 assert 双重证明；`satisfies`、`as const`、泛型
 * 都不会生成运行时 validator。
 */

import assert from 'node:assert/strict';

// Equal：用"高阶函数类型的等价判定"做最严格的类型相等检查；
// 比单纯的 A extends B 更严格，能在编译期证明 ActualType 与 ExpectedType 完全一致。
type Equal<Left, Right> =
  (<Type>() => Type extends Left ? 1 : 2) extends
  (<Type>() => Type extends Right ? 1 : 2)
    ? true
    : false;
// Expect：要求传入的类型必须正是 true，否则编译期就报错。配合 Equal 写"类型单元测试"。
type Expect<Condition extends true> = Condition;

// ------------------------------------------------------------
// 1. widening 是对未来写入的预测，不是简单看 const/let
// ------------------------------------------------------------
// 这一节对比 4 种声明，说明 widening 不是机械地"看 const/let"，
// 而是 TS 基于未来是否会被改写做出的预测。

// const 原始值：永不被重新赋值，类型直接保留为字面量 'GET'。
const fixedMethod = 'GET';
// let 原始值：会被重新赋值，类型拓宽为 string，以便接受 'POST' 等其它字符串。
let mutableMethod = 'GET';
mutableMethod = 'POST';

// const 对象，但其属性可写：method 仍会拓宽为 string（对象引用不变，属性可能被覆盖）。
const mutableObject = { method: 'GET' };
mutableObject.method = 'POST';

// as const：递归把所有属性/嵌套属性都置为 readonly 字面量，包括嵌套对象 nested。
const readonlyConfig = {
  method: 'GET',
  retries: 2,
  nested: { enabled: true },
} as const;

// 编译期断言：4 种声明各自的推断结果，与下方的运行时 assert 互相印证。
type _FixedPrimitiveKeepsLiteral = Expect<Equal<typeof fixedMethod, 'GET'>>;
type _MutableBindingWidens = Expect<Equal<typeof mutableMethod, string>>;
type _MutablePropertyWidens = Expect<Equal<typeof mutableObject.method, string>>;
type _AsConstRecursesIntoLiteral = Expect<
  Equal<typeof readonlyConfig.nested.enabled, true>
>;

assert.equal(fixedMethod, 'GET');
assert.equal(mutableMethod, 'POST');
// 关键证据：as const 不会调用 Object.freeze，对象在运行时其实可变。
assert.equal(Object.isFrozen(readonlyConfig), false);

// Reflect/外部 JS 可以绕开 readonly；as const 没有调用 Object.freeze。
// 演示：通过 Reflect.set 能改写"类型上 readonly"的属性，运行时不会抛错。
assert.equal(Reflect.set(readonlyConfig, 'retries', 99), true);
assert.equal(Reflect.get(readonlyConfig, 'retries'), 99);

// ------------------------------------------------------------
// 2. annotation、satisfies、assertion 的信息流不同
// ------------------------------------------------------------
// 对比三种"给值一个类型"的方式，看它们分别丢失/保留了什么信息。

// HttpMethod：方法字符串的有限联合，作为后续 Endpoint.method 的契约。
type HttpMethod = 'GET' | 'POST';
// Endpoint：一个 HTTP 端点的形状契约；path 是模板字面量类型，必须以 / 开头。
interface Endpoint {
  readonly method: HttpMethod;
  readonly path: `/${string}`;
  readonly timeoutMs: number;
}

// ① 注解版本：值被向上类型化为 Endpoint，原始字面量信息（method:'GET'）丢失，
// 对外可见的类型是宽泛的 HttpMethod。
const annotated: Endpoint = {
  method: 'GET',
  path: '/users',
  timeoutMs: 1_000,
};

// ② satisfies 版本：先按字面量推断对象（保留 listUsers/createUser 精确键 + method 精确字面量），
// 再用 Endpoint 校验它符合契约——既保留信息又做了类型检查。
const endpoints = {
  listUsers: { method: 'GET', path: '/users', timeoutMs: 1_000 },
  createUser: { method: 'POST', path: '/users', timeoutMs: 2_000 },
} satisfies Record<'listUsers' | 'createUser', Endpoint>;

// 编译期断言：三种方式分别保留了多少信息。
type _AnnotationExposesContract = Expect<
  Equal<typeof annotated.method, HttpMethod>
>;
type _SatisfiesKeepsExactKeys = Expect<
  Equal<keyof typeof endpoints, 'listUsers' | 'createUser'>
>;
type _SatisfiesKeepsUsefulMember = Expect<
  Equal<typeof endpoints.listUsers.method, 'GET'>
>;

// 运行时印证：satisfies 不改值，只校验类型。
assert.equal(endpoints.createUser.method, 'POST');

if (false) {
  const misspelled = {
    listUsers: { method: 'GET', path: '/users', timeoutMs: 1_000 },
    // @ts-expect-error Record 的有限 key 集会捕获拼错的 createUsers。
    createUsers: { method: 'POST', path: '/users', timeoutMs: 2_000 },
  } satisfies Record<'listUsers' | 'createUser', Endpoint>;
  console.log(misspelled);
}

// ③ assertion（as）版本：把"故意写错"的对象强行断言成 Endpoint，类型检查被绕过。
// assertion 只要求"类型足够重叠"（这里通过 as unknown as 完全跳过），证明责任在开发者。
const assertedEndpoint = {
  method: 'DELETE',
  path: 42,
  timeoutMs: 'forever',
} as unknown as Endpoint;
// 运行时证据：path 真实类型是 number，但类型系统已经认为它是 `/${string}`。
assert.equal(typeof assertedEndpoint.path, 'number');

// ------------------------------------------------------------
// 3. excess property check 只检查 fresh literal，不是运行时 sanitizer
// ------------------------------------------------------------
// 验证：excess property check 只在"新鲜对象字面量直接赋值给目标类型"时触发；
// 已存在的 const 对象再赋值，多出来的属性不会被检测到。

// endpointWithExtra 是一个带额外 debug 字段的 as const 对象。
const endpointWithExtra = {
  method: 'GET',
  path: '/users',
  timeoutMs: 1_000,
  debug: true,
} as const;

// 由于 endpointWithExtra 不是"新鲜对象字面量"，赋值给 Endpoint 时不触发 excess property check，
// debug 字段被悄悄带进 acceptedEndpoint。
const acceptedEndpoint: Endpoint = endpointWithExtra;
// 运行时证据：debug 属性确实存在于对象上。
assert.equal('debug' in acceptedEndpoint, true);

if (false) {
  const fresh: Endpoint = {
    method: 'GET',
    path: '/users',
    timeoutMs: 1_000,
    // @ts-expect-error fresh object literal 在目标位置触发 excess-property check。
    debug: true,
  };
  console.log(fresh);
}

// ------------------------------------------------------------
// 4. 上下文类型会流入回调和对象方法参数
// ------------------------------------------------------------
// 验证：satisfies 提供的目标类型会"反向流入"对象方法的参数，无需手写注解。

// TextHandler：一个把 string 映射成 string 的回调契约。
type TextHandler = (input: string) => string;

// textHandlers 的 input 参数没有显式注解，但 satisfies Record<string, TextHandler>
// 把 TextHandler 作为上下文类型反向流入每个方法，使 input 被推断为 string。
const textHandlers = {
  trim(input) {
    return input.trim();
  },
  uppercase(input) {
    return input.toUpperCase();
  },
} satisfies Record<string, TextHandler>;

// input 没有显式注解，来自 satisfies 提供的上下文类型；返回仍保留 string。
assert.equal(textHandlers.trim('  agent  '), 'agent');

// mapOne：泛型把"输入类型 Input"和"回调输出类型 Output"通过 mapper 关联起来。
// 调用时 TS 同时推断 Input（来自 value）和 Output（来自 mapper 的返回表达式）。
function mapOne<Input, Output>(
  value: Input,
  mapper: (value: Input) => Output,
): Output {
  return mapper(value);
}

// 回调 (value) => value.length 的 value 被上下文推断为 Input（'agent'），
// 返回类型推断为 Output=number；因此 inferredLength 是 number。
const inferredLength = mapOne('agent', (value) => value.length);
type _CallbackReturnInfersOutput = Expect<Equal<typeof inferredLength, number>>;
assert.equal(inferredLength, 5);

// ------------------------------------------------------------
// 5. const 类型参数保存调用点元组；普通约束只规定上界
// ------------------------------------------------------------
// 验证：`<const States>` 在函数边界保存调用方传入的精确字面量元组，而不是拓宽成 string[]。

// const 类型参数：states 被推断为 readonly 字面量元组（'idle' | 'running' | ...），
// 而不是 string[]。is 方法用 `value is States[number]` 把运行时检查和类型联合绑定起来。
function defineStates<const States extends readonly string[]>(states: States) {
  return {
    states,
    is(value: string): value is States[number] {
      return (states as readonly string[]).includes(value);
    },
  };
}

// 调用时不写 as const，类型参数也会保留为字面量元组（const 修饰的作用）。
const runStates = defineStates([
  'idle',
  'running',
  'waiting_tool',
  'done',
]);
// RunState：把 states 元组的元素联合提取出来，等于运行时的字面量联合。
type RunState = (typeof runStates.states)[number];
type _ConstGenericKeepsStateUnion = Expect<
  Equal<RunState, 'idle' | 'running' | 'waiting_tool' | 'done'>
>;

// stateFromStorage 类型是 string（来自 JSON/localStorage 等动态来源）。
const stateFromStorage: string = 'waiting_tool';
// runStates.is 是 type guard：返回 true 后会把 string 收窄成 RunState。
assert.equal(runStates.is(stateFromStorage), true);
if (runStates.is(stateFromStorage)) {
  // 收窄后，string 类型的 stateFromStorage 可以直接赋给 RunState 而不报错。
  const narrowed: RunState = stateFromStorage;
  assert.equal(narrowed, 'waiting_tool');
}

// ------------------------------------------------------------
// 6. NoInfer 选择"谁提供候选，谁只负责验证"
// ------------------------------------------------------------
// 验证：NoInfer 让某些参数只消费已推断的 State，不反向扩大 State 的候选集合。

// createMachine：State 由第一个参数 states 推断；initial 标注 NoInfer<State>，
// 表示 initial 只验证"是否在已推断的 State 联合内"，不会把传入值加入候选。
function createMachine<State extends string>(
  states: readonly State[],
  initial: NoInfer<State>,
) {
  return { states, initial };
}

// 第一个参数是 as const 元组，State 被推断为 'idle' | 'running' | 'done'；
// 第二个 'idle' 在该联合内，校验通过。
const machine = createMachine(['idle', 'running', 'done'] as const, 'idle');
type _MachineStateComesFromFirstArgument = Expect<
  Equal<(typeof machine.states)[number], 'idle' | 'running' | 'done'>
>;
assert.equal(machine.initial, 'idle');

// @ts-expect-error cancelled 不能反向扩大第一个参数推断出的 State。
createMachine(['idle', 'running', 'done'] as const, 'cancelled');

// ------------------------------------------------------------
// 7. 相关性必须一直保存到动态容器边界
// ------------------------------------------------------------
// 验证：异构对象（每个 key 对应不同 input/output 形状）在泛型索引时会丢失相关性，
// 用映射类型 + satisfies + 一处断言把相关性恢复回来。

// Operations：每个操作名对应一组 input/output 形状；不同操作的形状互不相同。
interface Operations {
  tokenize: {
    readonly input: { readonly text: string };
    readonly output: { readonly tokens: number };
  };
  embed: {
    readonly input: {
      readonly text: string;
      readonly dimensions: 384 | 768;
    };
    readonly output: { readonly vector: readonly number[] };
  };
}

// OperationImplementations：用映射类型把 Operations 翻译成"每个 Name 对应一个 (input)=>output 函数"。
// 这保证实现表的每个方法签名与 Operations 中的对应形状严格一致。
type OperationImplementations = {
  [Name in keyof Operations]: (
    input: Operations[Name]['input'],
  ) => Operations[Name]['output'];
};

// implementations：两个具体实现。input 参数依然没有显式注解，
// 是 satisfies OperationImplementations 把上下文类型流入进来的。
const implementations = {
  tokenize(input) {
    const normalized = input.text.trim();
    return { tokens: normalized === '' ? 0 : normalized.split(/\s+/u).length };
  },
  embed(input) {
    return {
      vector: Array.from({ length: input.dimensions }, () => 0),
    };
  },
} satisfies OperationImplementations;

// executeOperation：泛型入口。Name 与 input/output 都按 Operations[Name] 关联，
// 但进入 implementations[name] 时 checker 看到的是"函数联合"，相关性在那一行被破坏。
function executeOperation<Name extends keyof Operations>(
  name: Name,
  input: Operations[Name]['input'],
): Operations[Name]['output'] {
  // 泛型索引进入异构对象后，checker 看到的是函数联合，无法证明当前 name 与 input
  // 来自同一分支。实现表由 satisfies 完整检查，因此只在这个封闭边界恢复相关性。
  const implementation = implementations[name] as (
    value: Operations[Name]['input'],
  ) => Operations[Name]['output'];
  return implementation(input);
}

// 调用 executeOperation：每个调用的 name 和 input/output 都受 Operations 关联约束。
const tokenized = executeOperation('tokenize', {
  text: 'type information flows',
});
const embedded = executeOperation('embed', {
  text: 'agent',
  dimensions: 384,
});

// 运行时印证：tokenize 把字符串拆成 3 个 token；embed 用 dimensions=384 生成 384 维向量。
assert.equal(tokenized.tokens, 3);
assert.equal(embedded.vector.length, 384);

if (false) {
  // @ts-expect-error tokenize input 没有 dimensions。
  executeOperation('tokenize', { text: 'hello', dimensions: 384 });

  // @ts-expect-error embed output 与 tokenize output 不会退化成无关联合。
  const wrongOutput: { tokens: number } = executeOperation('embed', {
    text: 'agent',
    dimensions: 384,
  });
  console.log(wrongOutput);
}

console.log('=== 第 16 课：推断信息流 ===');
console.log({
  fixedMethod,
  mutableMethod,
  runtimeRetriesAfterReflect: Reflect.get(readonlyConfig, 'retries'),
  endpointNames: Object.keys(endpoints),
  assertedPathRuntimeType: typeof assertedEndpoint.path,
  excessPropertySurvived: 'debug' in acceptedEndpoint,
  inferredLength,
  states: runStates.states,
  tokenized,
  embeddingLength: embedded.vector.length,
});

export {};
