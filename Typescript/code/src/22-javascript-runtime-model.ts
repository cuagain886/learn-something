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
// baseAgent 将作为另一个对象的原型：它的属性不会出现在实例的「自有属性」里，
// 但通过 [[Prototype]] 链向上查找时仍可读取。
const baseAgent = {
  category: 'agent',
  // 方法里的 this 在 TS 层用 this 参数标注为「必须具备 category 字段」，
  // 运行时 this 由调用点决定（researcher.describe() 会把 this 绑到 researcher）。
  describe(this: { category: string }) {
    return `category=${this.category}`;
  },
};

// Object.create 显式建立 [[Prototype]] 链：researcher 的原型就是 baseAgent。
// 类型断言把 researcher 收紧为「baseAgent 的形状 + 自有 name 字段」。
const researcher = Object.create(baseAgent) as typeof baseAgent & {
  name: string;
};
// 直接给 researcher.name 赋值，会创建 researcher 自己的「自有属性 name」。
researcher.name = 'researcher';

// category 不在 researcher 自有属性里，读取时沿原型链找到 baseAgent.category。
console.log('原型读取:', researcher.category);
// Object.hasOwn 只检查对象自身的属性，不查原型链。
console.log('自有 name:', Object.hasOwn(researcher, 'name'));
console.log('自有 category:', Object.hasOwn(researcher, 'category'));
// Object.getPrototypeOf 返回内部的 [[Prototype]]，与 Object.create 时传入的对象是同一个。
console.log('原型是否为 baseAgent:', Object.getPrototypeOf(researcher) === baseAgent);

// 赋值会在 researcher 上创建同名自有属性，遮蔽而不是修改原型属性。
// 注意：赋值只创建自有属性，baseAgent.category 不变（证明「读走原型、写在自身」）。
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
  // 字段初始化器等价于「在 constructor 里 this.handleWithArrow = ...」，
  // 因此箭头字段是每个实例上的「自有属性」，不是 prototype 方法。
  readonly handleWithArrow = (task: string): string => `${this.name}:arrow:${task}`;

  // constructor 参数属性 `readonly name` 等价于在 constructor 里声明并赋值 this.name。
  constructor(readonly name: string) {}

  // 方法：函数对象存放在 WorkerAgent.prototype，由所有实例共享。
  // 体现在「实例.handleWithMethod 不在自有属性上，而在原型链上」。
  handleWithMethod(task: string): string {
    return `${this.name}:method:${task}`;
  }
}

const workerA = new WorkerAgent('A');
const workerB = new WorkerAgent('B');

// 两个实例的 handleWithMethod 引用的是同一个 prototype 函数对象。
console.log(
  'prototype 方法共享:',
  workerA.handleWithMethod === workerB.handleWithMethod,
);
// 箭头字段是「字段初始化器」创建的每实例闭包，引用各不相同。
console.log(
  '箭头字段每实例创建:',
  workerA.handleWithArrow === workerB.handleWithArrow,
);
// 印证上面的判断：handleWithMethod 不在实例自有属性上；箭头字段在。
console.log(
  '方法是否为自有属性:',
  Object.hasOwn(workerA, 'handleWithMethod'),
  '| 箭头字段是否为自有属性:',
  Object.hasOwn(workerA, 'handleWithArrow'),
);

// ------------------------------------------------------------
// 3. this 取决于调用点；提取普通方法会丢失 receiver
// ------------------------------------------------------------
// 把方法「拆下来」单独引用：此时普通方法的 this 不再绑定到 workerA。
const detachedMethod = workerA.handleWithMethod;
// 箭头字段在创建时通过闭包捕获了词法 this，所以即使拆下来 this 也不丢。
const detachedArrow = workerA.handleWithArrow;

try {
  // ESM/严格模式下，普通函数裸调用的 this 是 undefined。
  // 这一行会抛出 Cannot read properties of undefined (reading 'name')。
  console.log(detachedMethod('task'));
} catch (error: unknown) {
  console.log('普通方法丢失 this:', error instanceof Error ? error.message : error);
}

// 箭头函数根本没有自己的 this，外层 this 是定义时的实例 this，因此总能访问 name。
console.log('箭头字段保留词法 this:', detachedArrow('task'));
// bind 在调用前显式锁定 receiver，把 detachedMethod 重新钉在 workerA 上。
console.log('bind 显式绑定 receiver:', detachedMethod.bind(workerA)('task'));

// 普通函数声明，this 参数仅作为 TS 类型层面的约束，编译后被擦除。
function formatRun(this: { runId: string }, status: string): string {
  return `${this.runId}:${status}`;
}

// `this` 参数只存在于类型系统，不计入运行时参数列表。
// 因此运行时 formatRun 实际只接收一个 status 参数，必须用 call/apply 显式提供 this。
console.log('显式 this 参数:', formatRun.call({ runId: 'run_1' }, 'completed'));

// ------------------------------------------------------------
// 4. 属性描述符决定赋值、枚举和删除行为
// ------------------------------------------------------------
const metrics: Record<string, unknown> = {};
// 把「真实存储」放在闭包变量里，对外只暴露 getter/setter，从而可以做校验。
let internalTokens = 0;

// accessor 描述符：用 get/set 替换 value/writable，赋值时走 setter 校验。
Object.defineProperty(metrics, 'tokens', {
  get: () => internalTokens,
  set: (value: unknown) => {
    // 校验：必须是有限非负数字，否则抛 TypeError 阻止赋值。
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError('tokens 必须是非负有限数字');
    }
    internalTokens = value;
  },
  enumerable: true,
  // configurable: false 表示该属性不能被重新 defineProperty 或 delete。
  configurable: false,
});

// 数据描述符：直接给值；writable:false 表示只读；enumerable:false 表示不出现在 keys 中。
Object.defineProperty(metrics, 'internalId', {
  value: 'metric_1',
  writable: false,
  enumerable: false,
  configurable: false,
});

// 走 setter 路径，写入 internalTokens 而非新建一个数据属性。
metrics['tokens'] = 42;
console.log('getter/setter:', metrics['tokens']);
// Object.keys 只列出「可枚举 + 自有」属性，因此看不到 internalId。
console.log('Object.keys 只看可枚举自有属性:', Object.keys(metrics));
// Reflect.ownKeys 包含字符串键与 Symbol 键、可枚举与不可枚举，是完整的自有属性清单。
console.log('Reflect.ownKeys 包含不可枚举属性:', Reflect.ownKeys(metrics));
// 取出 tokens 的描述符，可以看到 get/set 而不是 value/writable。
console.log('tokens descriptor:', Object.getOwnPropertyDescriptor(metrics, 'tokens'));

// Object.freeze 只影响自有属性描述符，且是浅冻结；不会递归冻结嵌套对象。
const frozen = Object.freeze({ nested: { mutable: true } });
// frozen.nested 仍指向同一对象，修改 nested.mutable 不会报错。
frozen.nested.mutable = false;
console.log('浅冻结后的嵌套值仍可变:', frozen.nested.mutable);

// ------------------------------------------------------------
// 5. TS private 与 JavaScript #private 的运行时差异
// ------------------------------------------------------------
class SecretStore {
  // TS 的 private 只在编译期阻止类外访问；运行时它是普通的字符串键自有属性。
  private readonly compileTimePrivate = 'visible through reflection';
  // #private 是规范层面的私有槽，类外既不能用 .compileTimePrivate 风格访问，
  // 也不会出现在普通的 Reflect.get/ownKeys 中（通过特殊槽位存储）。
  readonly #runtimePrivate = 'hidden private slot';

  reveal(): string {
    // 类内部两种私有都可直接引用。
    return `${this.compileTimePrivate} | ${this.#runtimePrivate}`;
  }
}

const secrets = new SecretStore();
console.log('类内部访问:', secrets.reveal());
// 运行时通过 Reflect.get 可以读到 TS private 字段——证明它在运行时只是普通属性。
console.log('TS private 运行时仍是普通属性:', Reflect.get(secrets, 'compileTimePrivate'));
// 字符串 '#runtimePrivate' 不是真正的私有槽访问，结果只能是 undefined。
console.log('#private 不属于普通属性键:', Reflect.get(secrets, '#runtimePrivate'));
// ownKeys 也看不到真正的 #runtimePrivate——它通过内部私有槽位存储。
console.log('实例自有键:', Reflect.ownKeys(secrets));

// @ts-expect-error private 在编译期阻止普通属性访问
void secrets.compileTimePrivate;
// `secrets.#runtimePrivate` 甚至不能在类体外解析为合法私有访问，因此不写成可执行示例。

// ------------------------------------------------------------
// 6. interface 在运行时不存在：instanceof 只能使用真正的构造器值
// ------------------------------------------------------------
// interface 仅存在于编译期；emit 后没有任何对应的 JavaScript 值。
interface HasRunId {
  readonly runId: string;
}

// 函数签名用 HasRunId 表达结构要求，编译期做形状检查，运行时函数体不依赖该类型。
function printRun(value: HasRunId): void {
  console.log('静态 HasRunId:', value.runId);
}

// 结构匹配即可，无需实现某个具体接口或继承某个类（鸭子类型）。
printRun({ runId: 'run_structural' });

// unknown 模拟「从外部边界（API/文件/postMessage）拿到的数据」，TS 无法信任。
const external: unknown = { runId: 'run_external' };
// 不能写 external instanceof HasRunId：interface 编译后没有对应的值。
// 必须用一个返回类型守卫的函数把 unknown 收窄成 HasRunId。
if (isHasRunId(external)) printRun(external);

// 类型守卫函数：返回 `value is HasRunId` 后，TS 在 if 块内把 external 当作 HasRunId。
// 运行时通过逐字段的存在性 + 类型检查来「证明」结构匹配，这是 interface 的运行时替代品。
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
// 赋值只是复制引用，alias 和 original 指向完全相同的对象。
const alias = original;
// 展开运算只复制 original 的「自有可枚举属性」的引用，对嵌套对象仍是引用共享。
const shallowCopy = { ...original };

// 通过 alias 修改嵌套字段，原对象也可见——同一个 config 对象。
alias.config.timeoutMs = 2_000;
// 通过 shallowCopy.tags.push 修改数组，原对象的 tags 也被改动——同一个数组。
shallowCopy.tags.push('typescript');

console.log('引用别名影响原对象:', original.config.timeoutMs);
console.log('浅复制仍共享嵌套数组:', original.tags);
// 顶层对象身份不同：shallowCopy 是新的对象引用。
console.log('顶层对象身份不同:', original !== shallowCopy);
// 嵌套对象身份相同：浅复制没有递归克隆。
console.log('嵌套对象身份相同:', original.config === shallowCopy.config);

// structuredClone 会复制支持的结构，但函数、WeakMap、私有槽等并非都可克隆。
// 这里没有函数/错误等不可克隆成员，因此可以做深拷贝。
const deepDataCopy = structuredClone(original);
// 深拷贝后嵌套对象也是全新引用，互不影响。
deepDataCopy.config.timeoutMs = 3_000;
console.log('structuredClone 后嵌套身份不同:', original.config !== deepDataCopy.config);

// ------------------------------------------------------------
// 8. 闭包保存词法环境，而不仅是函数代码
// ------------------------------------------------------------
// createSequence 每次调用都创建独立的词法环境（其中 next 和 prefix 是私有状态）。
function createSequence(prefix: string): () => string {
  let next = 0;
  // 返回的箭头函数捕获了外层的 next 和 prefix，形成闭包。
  return () => {
    next += 1;
    return `${prefix}_${next}`;
  };
}

// 两次调用各自创建独立闭包：nextRunA 和 nextRunB 维护各自的 next 计数。
const nextRunA = createSequence('runA');
const nextRunB = createSequence('runB');
console.log('独立闭包环境:', nextRunA(), nextRunA(), nextRunB());

console.log('=== 第 22 课完成：静态类型之下仍是动态 JavaScript 对象模型 ===');

export {};
