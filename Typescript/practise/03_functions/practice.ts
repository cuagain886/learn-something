/**
 * ============================================================
 * 练习 03 · 函数类型（Functions）
 * ============================================================
 * 学习目标：
 *   - 写函数的参数类型与返回类型
 *   - 可选参数、默认值、rest（剩余）参数
 *   - 用「函数类型表达式」描述一个回调，如 (a, b) => number
 *   - 函数重载：同一个函数名，按入参类型给出不同返回
 *   - void 回调：不关心返回值的回调
 *
 * 题型：多数题已给出【函数签名】，你只写【函数体】（替换 return 后的占位值）；
 *      第 4 题要你写一个【类型】。
 *
 * 如何自检（运行时题）：改完后运行 `npx tsx 03_functions/practice.ts`，
 *   看到最后一行 ✅ 即通过；某个 assert 抛错就说明那题还没写对。
 */

import assert from 'node:assert/strict';

// 测试小工具（类型断言）
type Equal<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;
type Expect<T extends true> = T;

// ------------------------------------------------------------
// 第 1 题：基本参数与返回类型。返回 a + b。
// ------------------------------------------------------------
function add(a: number, b: number): number {
  return a+b; // TODO
}

// 第 2 题：默认参数。greeting 不传时默认 'Hello'，返回 `${greeting}, ${name}!`。
function greet(name: string, greeting = 'Hello'): string {
  return `${greeting}, ${name}`; // TODO
}

// 第 3 题：rest 参数。把所有传入的数字累加。
//   调用形如 sum(1, 2, 3, 4) → 10。
function sum(...nums: number[]): number {
  return nums.reduce((acc, cur) => acc + cur, 0); // TODO
}

// ------------------------------------------------------------
// 第 4 题（类型题）：写出一个「比较器」类型。
//   它是一个函数：接收两个 number (a, b)，返回 number（负/零/正表示顺序）。
//   把 unknown 换成正确的类型。
// ------------------------------------------------------------
type Comparator = (a: number, b: number) => number; // TODO: 写出函数类型表达式
type _q4 = Expect<Equal<Comparator, (a: number, b: number) => number>>;

// ------------------------------------------------------------
// 第 5 题：函数重载。下面两个【重载签名】已给出（不用改），你写【实现体】。
//   要求：number → "Number: 42"；string → "String: hi"。
//   提示：实现里用 typeof input 收窄。
// ------------------------------------------------------------
function format(input: number): string;
function format(input: string): string;
function format(input: number | string): string {
  if (typeof input === 'number') {
    return `Number: ${input}`;
  }
  return `String: ${input}`;
}

// 第 6 题：void 回调。循环 n 次调用 action()。
function repeat(n: number, action: () => void): void {
  for (let i = 0; i < n; i++) {
    action();
  }
  // TODO: 用 for 循环调用 action 共 n 次
}

// ============================================================
// ★ 自检区（不要修改本区代码）
// ============================================================
let called = 0;
repeat(3, () => {
  called++;
});

assert.equal(add(2, 3), 5);
assert.equal(add(-1, 1), 0);
assert.equal(greet('World'), 'Hello, World!');
assert.equal(greet('World', 'Hi'), 'Hi, World!');
assert.equal(sum(1, 2, 3, 4), 10);
assert.equal(sum(), 0);
assert.equal(format(42), 'Number: 42');
assert.equal(format('hi'), 'String: hi');
assert.equal(called, 3, 'repeat 应该把 action 调用 3 次');

console.log('✅ 练习 03 全部通过：函数体实现正确，类型断言成立。');

export {};
