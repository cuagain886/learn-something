/**
 * ============================================================
 * 第 04 课：接口（Interfaces）
 * ============================================================
 * 本节学什么：
 *   1. 用 interface 描述对象的「形状」
 *   2. 可选属性 ? / 只读属性 readonly
 *   3. 索引签名（动态键）
 *   4. 函数接口、可调用 / 可构造签名
 *   5. 接口继承（extends）
 *   6. 声明合并（同名 interface 自动合并）
 *
 * 运行：  npx tsx src/04-interfaces.ts
 *
 * 关键概念：结构化类型（Structural Typing / "鸭子类型"）
 *   TS 判断「兼容」看的是「结构是否匹配」，而不是「名字是否相同」。
 *   只要一个对象具备接口要求的全部属性，它就算实现了该接口。
 */

import assert from 'node:assert/strict';

// ------------------------------------------------------------
// 1. 基本接口
// ------------------------------------------------------------
interface User {
  id: number;
  name: string;
  email: string;
}

// 任何「形状匹配」的对象都可以赋给 User，不需要显式声明 implements。
const user: User = {
  id: 1,
  name: 'Alice',
  email: 'alice@example.com',
};

// ------------------------------------------------------------
// 2. 可选属性与只读属性
// ------------------------------------------------------------
interface Product {
  readonly id: number; // readonly：初始化后不可修改
  name: string;
  description?: string; // ? ：可选，可以不提供
}

const product: Product = { id: 100, name: 'Keyboard' }; // 不写 description 也合法
// product.id = 200; // ❌ readonly 不可修改
product.name = 'Mechanical Keyboard'; // ✅ 普通属性可改

// readonly 是静态、浅层约束，不会冻结运行时对象。
const productAlias = product as { id: number; name: string };
productAlias.id = 101;
assert.equal(product.id, 101, 'readonly 不等于 Object.freeze，也不阻止可变别名');

// ------------------------------------------------------------
// 3. 索引签名（Index Signature）
// ------------------------------------------------------------
// 当属性名不固定（动态的键）时，用索引签名描述「键和值的类型」。
interface StringDictionary {
  [key: string]: string; // 任意 string 键，值都是 string
}
const colors: StringDictionary = {
  red: '#ff0000',
  green: '#00ff00',
};
// 开启 noPropertyAccessFromIndexSignature 后，只由索引签名提供的动态键必须用 []。
// 这样一眼就能区分「接口明确声明的属性」与「运行时才确定的属性」。
colors['blue'] = '#0000ff'; // ✅ 可以动态添加

// ------------------------------------------------------------
// 4. 函数接口 / 可调用签名 / 可构造签名
// ------------------------------------------------------------

// 用接口描述「一个函数」：
interface SearchFn {
  (source: string, keyword: string): boolean;
}
const search: SearchFn = (src, kw) => src.includes(kw);

// 接口里同时有「调用签名」和「普通属性」（函数也是对象，可挂属性）：
interface Counter {
  (start: number): string; // 可像函数一样被调用
  interval: number; // 同时拥有属性
  reset(): void; // 和方法
}

function createCounter(): Counter {
  let current = 0;
  const callable = ((start: number) => {
    current = start;
    return String(current);
  }) as Counter;
  callable.interval = 100;
  callable.reset = () => {
    current = 0;
  };
  return callable;
}

const callableCounter = createCounter();
assert.equal(callableCounter(5), '5');
callableCounter.reset();

// 可构造签名：描述「可以被 new 调用」的东西（即构造函数 / 类）。
interface PointConstructor {
  new (x: number, y: number): { x: number; y: number };
}

class RuntimePoint {
  constructor(
    readonly x: number,
    readonly y: number,
  ) {}
}
const pointConstructor: PointConstructor = RuntimePoint;
const runtimePoint = new pointConstructor(3, 4);

// ------------------------------------------------------------
// 5. 接口继承（extends）
// ------------------------------------------------------------
interface Animal {
  name: string;
}
interface Dog extends Animal {
  // 继承了 name，再补充自己的属性
  breed: string;
}
// 还可以一次继承多个接口：interface X extends A, B { ... }

const dog: Dog = { name: 'Rex', breed: 'Husky' };

// ------------------------------------------------------------
// 6. 声明合并（Declaration Merging）
// ------------------------------------------------------------
// 同名 interface 会自动「合并」成一个。这是 interface 独有的能力，
// 常用于给第三方库的类型「打补丁」扩展属性。
interface Box {
  width: number;
}
interface Box {
  height: number;
}
// 此时 Box 等价于 { width: number; height: number }
const box: Box = { width: 10, height: 20 };

// ------------------------------------------------------------
// 7. 结构兼容、fresh object 与 satisfies
// ------------------------------------------------------------

interface Named {
  name: string;
}

const richValue = { name: 'agent', version: 1 };
const named: Named = richValue; // 来源有额外属性仍然兼容

// @ts-expect-error 新鲜对象字面量触发 excess property check，通常能抓住拼写/多余字段
const directNamed: Named = { name: 'agent', version: 1 };
void directNamed;

const checkedNamed = {
  name: 'agent',
} satisfies Named;
type CheckedName = typeof checkedNamed.name; // string：属性仍可变，因此发生拓宽

// 可选属性“缺失”与“存在但 undefined”在 exactOptionalPropertyTypes 下不同。
interface Patch {
  displayName?: string;
}
const emptyPatch: Patch = {};
// @ts-expect-error 未显式允许 undefined 时，不能写成存在但值为 undefined
const ambiguousPatch: Patch = { displayName: undefined };
void ambiguousPatch;

console.log('=== 第 04 课：接口 ===');
console.log({ user, product, colors });
console.log('search("hello","ell") =', search('hello', 'ell'));
console.log({ dog, box, callableCounter, runtimePoint, named, checkedNamed, emptyPatch });

// 让本文件成为独立模块：每个 .ts 文件都有独立作用域，避免与其它课程文件的同名声明在全局冲突。
export {};
