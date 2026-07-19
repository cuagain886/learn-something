/**
 * ============================================================
 * 第 22 课：TypeScript 下面的 JavaScript 运行时对象模型
 * ============================================================
 *
 * TypeScript 类型会被擦除。要精通 TS，必须理解最终执行的 JavaScript：
 *   1. 对象是「自有属性 + [[Prototype]] 链」，不是 Java 对象布局
 *   2. class 方法通常在 prototype 上，字段在每个实例上
 *   3. 普通函数的 this 由调用方式决定，箭头函数捕获词法 this
 *   4. 属性不仅有 value，还有 writable/enumerable/configurable/get/set
 *   5. TS private 主要是编译期约束；#private 是运行时私有槽
 *   6. interface/type 在运行时不存在，外部值仍要验证
 *   7. 展开运算符只是浅复制，不会克隆对象图
 *
 * 运行：npm run lesson:runtime
 */

// ------------------------------------------------------------
// 1. 自有属性与原型链查找
// ------------------------------------------------------------
const baseAgent = {
  category: 'agent',
  describe(this: { category: string }) {
    return `category=${this.category}`;
  },
};

const researcher = Object.create(baseAgent) as typeof baseAgent & {
  name: string;
};
researcher.name = 'researcher';

console.log('原型读取:', researcher.category);
console.log('自有 name:', Object.hasOwn(researcher, 'name'));
console.log('自有 category:', Object.hasOwn(researcher, 'category'));
console.log('原型是否为 baseAgent:', Object.getPrototypeOf(researcher) === baseAgent);

// 赋值会在 researcher 上创建同名自有属性，遮蔽而不是修改原型属性。
researcher.category = 'specialized-agent';
console.log('遮蔽后:', researcher.category, '| 原型仍为:', baseAgent.category);

// delete 只删除自有属性；随后查找再次落到原型链。
// 静态类型把 category 视为必需属性，因此直接 delete 会被 TS 拒绝；
// Reflect.deleteProperty 明确表达这里是在做运行时元对象实验。
Reflect.deleteProperty(researcher, 'category');
console.log('删除遮蔽属性后:', researcher.category);

// ------------------------------------------------------------
// 2. class 是原型机制的语法和语义封装，不是另一套继承系统
// ------------------------------------------------------------
class WorkerAgent {
  // 实例字段：每次 new 都创建一个新函数闭包，并捕获当前实例 this。
  readonly handleWithArrow = (task: string): string => `${this.name}:arrow:${task}`;

  constructor(readonly name: string) {}

  // 方法：函数对象存放在 WorkerAgent.prototype，由所有实例共享。
  handleWithMethod(task: string): string {
    return `${this.name}:method:${task}`;
  }
}

const workerA = new WorkerAgent('A');
const workerB = new WorkerAgent('B');

console.log(
  'prototype 方法共享:',
  workerA.handleWithMethod === workerB.handleWithMethod,
);
console.log(
  '箭头字段每实例创建:',
  workerA.handleWithArrow === workerB.handleWithArrow,
);
console.log(
  '方法是否为自有属性:',
  Object.hasOwn(workerA, 'handleWithMethod'),
  '| 箭头字段是否为自有属性:',
  Object.hasOwn(workerA, 'handleWithArrow'),
);

// ------------------------------------------------------------
// 3. this 取决于调用点；提取普通方法会丢失 receiver
// ------------------------------------------------------------
const detachedMethod = workerA.handleWithMethod;
const detachedArrow = workerA.handleWithArrow;

try {
  // ESM/严格模式下，普通函数裸调用的 this 是 undefined。
  console.log(detachedMethod('task'));
} catch (error: unknown) {
  console.log('普通方法丢失 this:', error instanceof Error ? error.message : error);
}

console.log('箭头字段保留词法 this:', detachedArrow('task'));
console.log('bind 显式绑定 receiver:', detachedMethod.bind(workerA)('task'));

function formatRun(this: { runId: string }, status: string): string {
  return `${this.runId}:${status}`;
}

// `this` 参数只存在于类型系统，不计入运行时参数列表。
console.log('显式 this 参数:', formatRun.call({ runId: 'run_1' }, 'completed'));

// ------------------------------------------------------------
// 4. 属性描述符决定赋值、枚举和删除行为
// ------------------------------------------------------------
const metrics: Record<string, unknown> = {};
let internalTokens = 0;

Object.defineProperty(metrics, 'tokens', {
  get: () => internalTokens,
  set: (value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError('tokens 必须是非负有限数字');
    }
    internalTokens = value;
  },
  enumerable: true,
  configurable: false,
});

Object.defineProperty(metrics, 'internalId', {
  value: 'metric_1',
  writable: false,
  enumerable: false,
  configurable: false,
});

metrics['tokens'] = 42;
console.log('getter/setter:', metrics['tokens']);
console.log('Object.keys 只看可枚举自有属性:', Object.keys(metrics));
console.log('Reflect.ownKeys 包含不可枚举属性:', Reflect.ownKeys(metrics));
console.log('tokens descriptor:', Object.getOwnPropertyDescriptor(metrics, 'tokens'));

// Object.freeze 只影响自有属性描述符，且是浅冻结；不会递归冻结嵌套对象。
const frozen = Object.freeze({ nested: { mutable: true } });
frozen.nested.mutable = false;
console.log('浅冻结后的嵌套值仍可变:', frozen.nested.mutable);

// ------------------------------------------------------------
// 5. TS private 与 JavaScript #private 的运行时差异
// ------------------------------------------------------------
class SecretStore {
  private readonly compileTimePrivate = 'visible through reflection';
  readonly #runtimePrivate = 'hidden private slot';

  reveal(): string {
    return `${this.compileTimePrivate} | ${this.#runtimePrivate}`;
  }
}

const secrets = new SecretStore();
console.log('类内部访问:', secrets.reveal());
console.log('TS private 运行时仍是普通属性:', Reflect.get(secrets, 'compileTimePrivate'));
console.log('#private 不属于普通属性键:', Reflect.get(secrets, '#runtimePrivate'));
console.log('实例自有键:', Reflect.ownKeys(secrets));

// @ts-expect-error private 在编译期阻止普通属性访问
void secrets.compileTimePrivate;
// `secrets.#runtimePrivate` 甚至不能在类体外解析为合法私有访问，因此不写成可执行示例。

// ------------------------------------------------------------
// 6. interface 在运行时不存在：instanceof 只能使用真正的构造器值
// ------------------------------------------------------------
interface HasRunId {
  readonly runId: string;
}

function printRun(value: HasRunId): void {
  console.log('静态 HasRunId:', value.runId);
}

printRun({ runId: 'run_structural' });

const external: unknown = { runId: 'run_external' };
// 不能写 external instanceof HasRunId：interface 编译后没有对应的值。
if (isHasRunId(external)) printRun(external);

function isHasRunId(value: unknown): value is HasRunId {
  return typeof value === 'object'
    && value !== null
    && 'runId' in value
    && typeof value.runId === 'string';
}

// ------------------------------------------------------------
// 7. 对象赋值复制引用；展开运算只是浅复制自有可枚举属性
// ------------------------------------------------------------
const original = {
  config: { timeoutMs: 1_000 },
  tags: ['agent'],
};
const alias = original;
const shallowCopy = { ...original };

alias.config.timeoutMs = 2_000;
shallowCopy.tags.push('typescript');

console.log('引用别名影响原对象:', original.config.timeoutMs);
console.log('浅复制仍共享嵌套数组:', original.tags);
console.log('顶层对象身份不同:', original !== shallowCopy);
console.log('嵌套对象身份相同:', original.config === shallowCopy.config);

// structuredClone 会复制支持的结构，但函数、WeakMap、私有槽等并非都可克隆。
const deepDataCopy = structuredClone(original);
deepDataCopy.config.timeoutMs = 3_000;
console.log('structuredClone 后嵌套身份不同:', original.config !== deepDataCopy.config);

// ------------------------------------------------------------
// 8. 闭包保存词法环境，而不仅是函数代码
// ------------------------------------------------------------
function createSequence(prefix: string): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}_${next}`;
  };
}

const nextRunA = createSequence('runA');
const nextRunB = createSequence('runB');
console.log('独立闭包环境:', nextRunA(), nextRunA(), nextRunB());

console.log('=== 第 22 课完成：静态类型之下仍是动态 JavaScript 对象模型 ===');

export {};
