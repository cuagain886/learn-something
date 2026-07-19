/**
 * ============================================================
 * 第 16 课：Checker 的推断信息流与相关性保存
 * ============================================================
 *
 * 运行：npm run lesson:inference
 *
 * TypeScript 推断不是“看右边猜一个类型”这么简单。Checker 同时处理：
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

type Equal<Left, Right> =
  (<Type>() => Type extends Left ? 1 : 2) extends
  (<Type>() => Type extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Condition extends true> = Condition;

// ------------------------------------------------------------
// 1. widening 是对未来写入的预测，不是简单看 const/let
// ------------------------------------------------------------

const fixedMethod = 'GET';
let mutableMethod = 'GET';
mutableMethod = 'POST';

const mutableObject = { method: 'GET' };
mutableObject.method = 'POST';

const readonlyConfig = {
  method: 'GET',
  retries: 2,
  nested: { enabled: true },
} as const;

type _FixedPrimitiveKeepsLiteral = Expect<Equal<typeof fixedMethod, 'GET'>>;
type _MutableBindingWidens = Expect<Equal<typeof mutableMethod, string>>;
type _MutablePropertyWidens = Expect<Equal<typeof mutableObject.method, string>>;
type _AsConstRecursesIntoLiteral = Expect<
  Equal<typeof readonlyConfig.nested.enabled, true>
>;

assert.equal(fixedMethod, 'GET');
assert.equal(mutableMethod, 'POST');
assert.equal(Object.isFrozen(readonlyConfig), false);

// Reflect/外部 JS 可以绕开 readonly；as const 没有调用 Object.freeze。
assert.equal(Reflect.set(readonlyConfig, 'retries', 99), true);
assert.equal(Reflect.get(readonlyConfig, 'retries'), 99);

// ------------------------------------------------------------
// 2. annotation、satisfies、assertion 的信息流不同
// ------------------------------------------------------------

type HttpMethod = 'GET' | 'POST';
interface Endpoint {
  readonly method: HttpMethod;
  readonly path: `/${string}`;
  readonly timeoutMs: number;
}

const annotated: Endpoint = {
  method: 'GET',
  path: '/users',
  timeoutMs: 1_000,
};

const endpoints = {
  listUsers: { method: 'GET', path: '/users', timeoutMs: 1_000 },
  createUser: { method: 'POST', path: '/users', timeoutMs: 2_000 },
} satisfies Record<'listUsers' | 'createUser', Endpoint>;

type _AnnotationExposesContract = Expect<
  Equal<typeof annotated.method, HttpMethod>
>;
type _SatisfiesKeepsExactKeys = Expect<
  Equal<keyof typeof endpoints, 'listUsers' | 'createUser'>
>;
type _SatisfiesKeepsUsefulMember = Expect<
  Equal<typeof endpoints.listUsers.method, 'GET'>
>;

assert.equal(endpoints.createUser.method, 'POST');

if (false) {
  const misspelled = {
    listUsers: { method: 'GET', path: '/users', timeoutMs: 1_000 },
    // @ts-expect-error Record 的有限 key 集会捕获拼错的 createUsers。
    createUsers: { method: 'POST', path: '/users', timeoutMs: 2_000 },
  } satisfies Record<'listUsers' | 'createUser', Endpoint>;
  console.log(misspelled);
}

// assertion 只要求类型“足够重叠”，并把证明责任转给开发者；这里故意制造漂移。
const assertedEndpoint = {
  method: 'DELETE',
  path: 42,
  timeoutMs: 'forever',
} as unknown as Endpoint;
assert.equal(typeof assertedEndpoint.path, 'number');

// ------------------------------------------------------------
// 3. excess property check 只检查 fresh literal，不是运行时 sanitizer
// ------------------------------------------------------------

const endpointWithExtra = {
  method: 'GET',
  path: '/users',
  timeoutMs: 1_000,
  debug: true,
} as const;

const acceptedEndpoint: Endpoint = endpointWithExtra;
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

type TextHandler = (input: string) => string;

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

function mapOne<Input, Output>(
  value: Input,
  mapper: (value: Input) => Output,
): Output {
  return mapper(value);
}

const inferredLength = mapOne('agent', (value) => value.length);
type _CallbackReturnInfersOutput = Expect<Equal<typeof inferredLength, number>>;
assert.equal(inferredLength, 5);

// ------------------------------------------------------------
// 5. const 类型参数保存调用点元组；普通约束只规定上界
// ------------------------------------------------------------

function defineStates<const States extends readonly string[]>(states: States) {
  return {
    states,
    is(value: string): value is States[number] {
      return (states as readonly string[]).includes(value);
    },
  };
}

const runStates = defineStates([
  'idle',
  'running',
  'waiting_tool',
  'done',
]);
type RunState = (typeof runStates.states)[number];
type _ConstGenericKeepsStateUnion = Expect<
  Equal<RunState, 'idle' | 'running' | 'waiting_tool' | 'done'>
>;

const stateFromStorage: string = 'waiting_tool';
assert.equal(runStates.is(stateFromStorage), true);
if (runStates.is(stateFromStorage)) {
  const narrowed: RunState = stateFromStorage;
  assert.equal(narrowed, 'waiting_tool');
}

// ------------------------------------------------------------
// 6. NoInfer 选择“谁提供候选，谁只负责验证”
// ------------------------------------------------------------

function createMachine<State extends string>(
  states: readonly State[],
  initial: NoInfer<State>,
) {
  return { states, initial };
}

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

type OperationImplementations = {
  [Name in keyof Operations]: (
    input: Operations[Name]['input'],
  ) => Operations[Name]['output'];
};

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

const tokenized = executeOperation('tokenize', {
  text: 'type information flows',
});
const embedded = executeOperation('embed', {
  text: 'agent',
  dimensions: 384,
});

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
