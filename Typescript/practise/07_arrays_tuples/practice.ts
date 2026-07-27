/**
 * ============================================================
 * 练习 07 · 数组与元组（Arrays & Tuples）
 * ============================================================
 * 学习目标：
 *   - 数组方法 map / filter / reduce 的类型在调用链里如何流动
 *   - readonly number[]：只读数组，函数声明它「不改」你传入的数据
 *   - 元组 [A, B]：固定长度、每位置类型可不同，常用于「返回多个值」
 *
 * 题型：运行时题，实现函数体。
 * 如何自检：`npx tsx 07_arrays_tuples/practice.ts` 看到 ✅ 即通过。
 */

import assert from 'node:assert/strict';

// ------------------------------------------------------------
// 第 1 题：map 的类型流。number[] --map--> string[]。
//   把每个数字转成小写 16 进制字符串：255 → 'ff'，16 → '10'。
//   提示：n.toString(16)。
// ------------------------------------------------------------
function toHex(nums: number[]): string[] {
  return nums.map(n => n.toString(16)); // TODO
}

// ------------------------------------------------------------
// 第 2 题：filter。保留 >= 18 的年龄。
// ------------------------------------------------------------
function adults(ages: number[]): number[] {
  return ages.filter(age => age >= 18); // TODO
}

// ------------------------------------------------------------
// 第 3 题：只读数组。参数是 readonly number[]，承诺不修改它。
//   ⚠️ 如果你在函数里写 nums.push(...) 或 nums.sort()，会编译报错——这正是 readonly 的保护。
// ------------------------------------------------------------
function sumReadOnly(nums: readonly number[]): number {
  return nums.reduce((acc, cur) => acc + cur, 0); // TODO: 用 reduce 求和
}

// ------------------------------------------------------------
// 第 4 题：用元组返回多个值 [最小值, 最大值]。
//   提示：可以用 Math.min(...nums) 和 Math.max(...nums)。
// ------------------------------------------------------------
function minMax(nums: number[]): [number, number] {
  return [Math.min(...nums), Math.max(...nums)]; // TODO
}

// ------------------------------------------------------------
// 第 5 题：链式 map + filter。
//   返回所有【成年(age>=18)】成员的【名字大写】。
// ------------------------------------------------------------
interface Member {
  name: string;
  age: number;
}
function adultNames(members: Member[]): string[] {
  return members
    .filter(member => member.age >= 18)
    .map(member => member.name.toUpperCase()); // TODO
}

// ============================================================
// ★ 自检区（不要修改本区代码）
// ============================================================
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
