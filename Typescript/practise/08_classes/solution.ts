/**
 * ============================================================
 * 练习 08 · 参考答案
 * ============================================================
 * 要点回顾：
 *   - 字段必须先声明再用；constructor 里 this.x = x 完成初始化
 *   - 参数属性 `constructor(readonly id: number, name: string, private price)` 自动建字段
 *   - implements 只检查「结构满足」，不提供实现
 *   - get/set 让方法像属性；get-only 可满足接口的可读属性
 *   - static 成员挂在类上，用 ClassName.x 访问，不依赖实例
 */

import assert from 'node:assert/strict';

class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  distanceTo(other: Point): number {
    return Math.hypot(this.x - other.x, this.y - other.y);
  }
}

class Product {
  constructor(
    readonly id: number,
    public name: string,
    private price: number,
  ) {}

  describe(): string {
    return `${this.id}-${this.name}: ${this.price}`;
  }
}

interface HasName {
  name: string;
}
class Player implements HasName {
  private _name: string;
  constructor(initial: string) {
    this._name = initial;
  }
  get name(): string {
    return this._name;
  }
  set name(value: string) {
    if (!value) throw new Error('name 不能为空');
    this._name = value;
  }
}

class Counter {
  static count = 0;
  static increment(): number {
    return ++Counter.count;
  }
  static reset(): void {
    Counter.count = 0;
  }
}

assert.equal(new Point(0, 0).distanceTo(new Point(3, 4)), 5);
assert.equal(new Point(1, 1).distanceTo(new Point(4, 5)), 5);

assert.equal(new Product(1, 'Pen', 5).describe(), '1-Pen: 5');

const player = new Player('Al');
assert.equal(player.name, 'Al');
player.name = 'Bo';
assert.equal(player.name, 'Bo');
assert.throws(() => {
  player.name = '';
}, '空字符串应被 setter 拒绝');

assert.equal(Counter.increment(), 1);
assert.equal(Counter.increment(), 2);
Counter.reset();
assert.equal(Counter.increment(), 1);

console.log('✅ 练习 08 全部通过：类与修饰符运用正确。');

export {};
