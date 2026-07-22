/**
 * ============================================================
 * 练习 05 · 参考答案
 * ============================================================
 * 要点回顾：
 *   - typeof 收窄适合原始类型；判别联合（共同 kind 字段）适合对象，最稳
 *   - switch 每个 case 内部，判别字段被收窄成对应字面量，连带对象类型收窄
 *   - assertNever(default) 是穷尽检查的经典写法：漏处理 → 编译期立刻报错
 */

import assert from 'node:assert/strict';

function describe(x: string | number): string {
  if (typeof x === 'string') {
    return `str:${x.length}`;
  }
  return `num:${x * x}`;
}

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
  switch (pet.kind) {
    case 'cat':
      return pet.meow();
    case 'dog':
      return pet.bark();
  }
}

type Shape =
  | { kind: 'circle'; radius: number }
  | { kind: 'square'; size: number };

function area(s: Shape): number {
  switch (s.kind) {
    case 'circle':
      return Math.PI * s.radius * s.radius;
    case 'square':
      return s.size * s.size;
  }
}

function assertNever(x: never): never {
  throw new Error('未处理的值: ' + x);
}
type Color = 'red' | 'green' | 'blue';

function describeColor(color: Color): string {
  switch (color) {
    case 'red':
      return '赤';
    case 'green':
      return '绿';
    case 'blue':
      return '蓝';
    default:
      return assertNever(color);
  }
}

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
