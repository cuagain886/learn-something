/**
 * ============================================================
 * 练习 07 · 参考答案
 * ============================================================
 * 要点回顾：
 *   - map(f) 的返回类型由 f 的返回值决定：number[] 经 (n)=>string 变成 string[]
 *   - readonly T[] 只允许读取方法（map/filter/reduce），禁止 push/sort/splice
 *   - 元组 [A, B] 表达「恰好两个、顺序有意义」，适合多值返回
 *   - 链式调用 .filter(...).map(...) 时类型逐级推导
 */

import assert from 'node:assert/strict';

function toHex(nums: number[]): string[] {
  return nums.map((n) => n.toString(16));
}

function adults(ages: number[]): number[] {
  return ages.filter((age) => age >= 18);
}

function sumReadOnly(nums: readonly number[]): number {
  return nums.reduce((acc, n) => acc + n, 0);
}

function minMax(nums: number[]): [number, number] {
  return [Math.min(...nums), Math.max(...nums)];
}

interface Member {
  name: string;
  age: number;
}
function adultNames(members: Member[]): string[] {
  return members.filter((m) => m.age >= 18).map((m) => m.name.toUpperCase());
}

assert.deepEqual(toHex([255, 16, 0]), ['ff', '10', '0']);
assert.deepEqual(adults([20, 15, 18, 9]), [20, 18]);
assert.equal(sumReadOnly([1, 2, 3, 4]), 10);
assert.deepEqual(minMax([3, 1, 4, 1, 5, 9, 2, 6]), [1, 9]);
assert.deepEqual(
  adultNames([
    { name: 'al', age: 20 },
    { name: 'bo', age: 10 },
    { name: 'cy', age: 30 },
  ]),
  ['AL', 'CY'],
);

console.log('✅ 练习 07 全部通过：数组方法与元组运用正确。');

export {};
