/**
 * ============================================================
 * 练习 05 · 联合类型与类型收窄（Union & Narrowing）
 * ============================================================
 * 学习目标：
 *   - 联合类型 A | B：一个值可能是多种类型之一
 *   - 用 typeof 在分支里把类型「收窄」到具体的一种
 *   - 判别联合（discriminated union）：用共同字段（如 kind）做收窄，最常用最稳
 *   - 穷尽检查：配合 never 保证「所有情况都处理了」，漏一个就编译报错
 *
 * 题型：运行时题，实现函数体；用 typeof / 判别字段收窄分支。
 * 如何自检：`npx tsx 05_union_narrowing/practice.ts` 看到 ✅ 即通过。
 */

import assert from 'node:assert/strict';

// ------------------------------------------------------------
// 第 1 题：typeof 收窄。
//   x 是 string | number。string 返回 "str:<长度>"；number 返回 "num:<平方>"。
//   提示：用 `if (typeof x === 'string')` 分支。
// ------------------------------------------------------------
function describe(x: string | number): string {
  return ''; // TODO
}

// ------------------------------------------------------------
// 第 2 题：判别联合（discriminated union）。
//   Cat 和 Dog 都有共同的 kind 字段（字符串字面量），TS 能据此收窄。
//   要求：kind === 'cat' 时返回 meow() 的结果；'dog' 时返回 bark() 的结果。
// ------------------------------------------------------------
interface Cat {
  kind: 'cat';
  meow: () => string;
}
interface Dog {
  kind: 'dog';
  bark: () => string;
}
type Pet = Cat | Dog;

function speak(pet: Pet): string {
  return ''; // TODO
}

// ------------------------------------------------------------
// 第 3 题：判别联合算面积。
//   circle 用 radius：π × r²；square 用 size：size × size。
//   提示：Math.PI 就是 π。
// ------------------------------------------------------------
type Shape =
  | { kind: 'circle'; radius: number }
  | { kind: 'square'; size: number };

function area(s: Shape): number {
  return 0; // TODO
}

// ------------------------------------------------------------
// 第 4 题：穷尽检查（exhaustiveness）。
//   assertNever 已给出。你在 describeColor 里用 switch 处理三种颜色，
//   并在 default 分支 `return assertNever(color)`。
//   作用：处理完 red/green/blue 后，color 被收窄成 never；
//   将来 Color 新增颜色而你忘了加 case，这里就会【编译报错】，提前暴露遗漏。
// ------------------------------------------------------------
function assertNever(x: never): never {
  throw new Error('未处理的值: ' + x);
}
type Color = 'red' | 'green' | 'blue';

function describeColor(color: Color): string {
  return ''; // TODO: switch 处理三种，default 用 assertNever
}

// ============================================================
// ★ 自检区（不要修改本区代码）
// ============================================================
assert.equal(describe('hi'), 'str:2');
assert.equal(describe(3), 'num:9');

assert.equal(speak({ kind: 'cat', meow: () => 'meow' }), 'meow');
assert.equal(speak({ kind: 'dog', bark: () => 'woof' }), 'woof');

assert.equal(area({ kind: 'circle', radius: 2 }), Math.PI * 4);
assert.equal(area({ kind: 'square', size: 3 }), 9);

assert.equal(describeColor('red'), '赤');
assert.equal(describeColor('green'), '绿');
assert.equal(describeColor('blue'), '蓝');

console.log('✅ 练习 05 全部通过：收窄与穷尽检查运用正确。');

export {};
