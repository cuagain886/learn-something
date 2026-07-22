/**
 * ============================================================
 * 练习 09 · 参考答案
 * ============================================================
 * 要点回顾：
 *   - <T> 是类型变量；函数体里 T 可以像普通类型一样用
 *   - 约束 `T extends { length: number }` 表示「T 至少要有 length」，
 *     这样函数体里 value.length 才合法；不满足约束的实参（如 number）会被拒绝
 *   - `K extends keyof T` 把 K 限定在对象的真实键里，杜绝拼错键名
 *   - 返回类型 T[K] 是【索引访问类型】，会随具体 key 变化，精度高
 *   - 调用处一般不用手写类型参数，TS 从实参自动推断
 */

import assert from 'node:assert/strict';

type Equal<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;
type Expect<T extends true> = T;

function wrap<T>(value: T): T[] {
  return [value];
}

function pair<A, B>(a: A, b: B): [A, B] {
  return [a, b];
}

function lengthOf<T extends { length: number }>(value: T): number {
  return value.length;
}

function pluck<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}

const w = wrap(1);
const p = pair(true, 'ok');
type _w = Expect<Equal<typeof w, number[]>>;
type _p = Expect<Equal<typeof p, [boolean, string]>>;

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
