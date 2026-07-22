/**
 * ============================================================
 * 练习 09 · 泛型入门（Generics）
 * ============================================================
 * 学习目标：
 *   - 写泛型函数 `<T>(...)`，让同一个函数适配多种类型且【类型不丢失】
 *   - 约束 `T extends ...`：限制 T 必须满足某种结构（如有 length）
 *   - keyof 约束：保证传入的 key 真的是对象的合法键
 *   - 调用处自动推断：通常不用手写 `fn<Type>(...)`，TS 会从实参推出 T
 *
 * 题型：实现函数体（多半只要一两行，重点在【签名】已经写好的泛型上）。
 * 如何自检：`npx tsx 09_generics/practice.ts` 看到 ✅ 即通过。
 */

import assert from 'node:assert/strict';

type Equal<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;
type Expect<T extends true> = T;

// ------------------------------------------------------------
// 第 1 题：最简单的泛型。把单个值包成单元素数组，类型随之保留。
// ------------------------------------------------------------
function wrap<T>(value: T): T[] {
  return []; // TODO: 返回 [value]
}

// ------------------------------------------------------------
// 第 2 题：两个类型参数。把两个值组成元组 [A, B]。
// ------------------------------------------------------------
function pair<A, B>(a: A, b: B): [A, B] {
  return [a, b]; // TODO（已经帮你写好了，体会 A、B 各自独立）
}

// ------------------------------------------------------------
// 第 3 题：约束 extends。要求 T 至少有 length 属性，才能取它的长度。
//   提示：字符串、数组、甚至 { length: 1 } 都满足；number 不满足。
// ------------------------------------------------------------
function lengthOf<T extends { length: number }>(value: T): number {
  return 0; // TODO: 返回 value.length
}

// ------------------------------------------------------------
// 第 4 题：keyof 约束。安全地取对象属性：key 必须是 obj 的合法键。
//   返回类型 T[K] 会随 key 不同而变化 —— 这是泛型的威力。
// ------------------------------------------------------------
function pluck<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key]; // TODO（签名帮你写好，体会 keyof 的保护）
}

// ------------------------------------------------------------
// 体会：调用处 TS 自动推断类型参数，无需手写 wrap<number>(1)。
// （下面两行不要改，它们是类型断言的检查对象）
// ------------------------------------------------------------
const w = wrap(1);
const p = pair(true, 'ok');
type _w = Expect<Equal<typeof w, number[]>>;
type _p = Expect<Equal<typeof p, [boolean, string]>>;

// ============================================================
// ★ 自检区（不要修改本区代码）
// ============================================================
assert.deepEqual(wrap(1), [1]);
assert.deepEqual(wrap('a'), ['a']);
assert.deepEqual(pair(1, 'x'), [1, 'x']);
assert.equal(lengthOf('abc'), 3);
assert.equal(lengthOf([1, 2, 3]), 3);
assert.equal(lengthOf({ length: 9 }), 9);
assert.equal(pluck({ a: 1, b: 'x' }, 'a'), 1);
assert.equal(pluck({ a: 1, b: 'x' }, 'b'), 'x');

console.log('✅ 练习 09 全部通过：泛型函数与约束运用正确。');

export {};
