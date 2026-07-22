/**
 * ============================================================
 * 练习 03 · 参考答案
 * ============================================================
 * 要点回顾：
 *   - 参数类型写在变量名后：`a: number`；返回类型在括号后：`): number`
 *   - 默认参数 `greeting = 'Hello'` 同时具备「可选」语义，不必再加 ?
 *   - rest 参数 `...nums: number[]` 收集所有剩余实参成数组
 *   - 函数类型表达式：`(a: number, b: number) => number`（注意是箭头 =>）
 *   - 重载 = 多个签名 + 一个实现；实现里要用 typeof 收窄分支
 *   - void 回调：声明 () => void 表示「我不关心返回值」
 */

import assert from 'node:assert/strict';

type Equal<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;
type Expect<T extends true> = T;

function add(a: number, b: number): number {
  return a + b;
}

function greet(name: string, greeting = 'Hello'): string {
  return `${greeting}, ${name}!`;
}

function sum(...nums: number[]): number {
  return nums.reduce((acc, n) => acc + n, 0);
}

type Comparator = (a: number, b: number) => number;
type _q4 = Expect<Equal<Comparator, (a: number, b: number) => number>>;

function format(input: number): string;
function format(input: string): string;
function format(input: number | string): string {
  if (typeof input === 'number') {
    return `Number: ${input}`;
  }
  return `String: ${input}`;
}

function repeat(n: number, action: () => void): void {
  for (let i = 0; i < n; i++) {
    action();
  }
}

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
assert.equal(called, 3);

console.log('✅ 练习 03 全部通过：函数体实现正确，类型断言成立。');

export {};
