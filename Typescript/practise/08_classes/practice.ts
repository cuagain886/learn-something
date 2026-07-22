/**
 * ============================================================
 * 练习 08 · 类（Classes）
 * ============================================================
 * 学习目标：
 *   - 声明字段、constructor、方法
 *   - 访问修饰符 public / private / protected 与 readonly
 *   - 「参数属性」：在 constructor 参数前加修饰符，自动生成并赋值字段
 *   - implements：让类满足某个接口契约
 *   - getter / setter：用 get/set 把方法当属性访问
 *   - static：属于类本身而非实例的成员
 *
 * 题型：实现类成员（替换 TODO）。部分题修好类型才编译通过。
 * 如何自检：`npx tsx 08_classes/practice.ts` 看到 ✅ 即通过。
 */

import assert from 'node:assert/strict';

// ------------------------------------------------------------
// 第 1 题：字段 + 构造 + 方法。
//   初始化 x/y，并实现欧氏距离 distanceTo。
// ------------------------------------------------------------
class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    // TODO: 给 this.x、this.y 赋值
  }
  distanceTo(other: Point): number {
    return 0; // TODO: 返回 √((x-other.x)² + (y-other.y)²)，可用 Math.hypot
  }
}

// ------------------------------------------------------------
// 第 2 题：参数属性（parameter properties）。
//   只写 constructor，靠参数前的修饰符自动生成字段，不用手写 this.xxx = xxx。
//   要求：id 是 readonly，name 是 public（默认），price 已示范 private。
//   提示：给 id 和 name 这两个参数加上对应的修饰符即可。
//   （describe 用到了 this.id / this.name / this.price，修好修饰符才能编译）
// ------------------------------------------------------------
class Product {
  constructor(
    id: number, // TODO: 加 readonly
    name: string, // TODO: 加 public（或不写）
    private price: number,
  ) {}

  describe(): string {
    return `${this.id}-${this.name}: ${this.price}`;
  }
}

// ------------------------------------------------------------
// 第 3 题：implements + getter/setter。
//   实现 HasName 接口（必须有可读 name）。用 get/set 暴露私有 _name，
//   set 时拒绝空字符串。
// ------------------------------------------------------------
interface HasName {
  name: string;
}
class Player implements HasName {
  private _name: string;
  constructor(initial: string) {
    this._name = initial;
  }
  // TODO: 写 get name() 返回 _name；set name(value: string) 设置，空串抛错
}

// ------------------------------------------------------------
// 第 4 题：static 成员。
// ------------------------------------------------------------
class Counter {
  static count = 0;
  static increment(): number {
    return 0; // TODO: count++ 并返回新值
  }
  static reset(): void {
    // TODO: 把 count 清零
  }
}

// ============================================================
// ★ 自检区（不要修改本区代码）
// ============================================================
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
