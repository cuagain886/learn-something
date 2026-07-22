/**
 * ============================================================
 * 练习 04 · 对象与接口（Interfaces）
 * ============================================================
 * 学习目标：
 *   - 用 interface 描述对象结构
 *   - 可选属性 `prop?: T`、只读属性 `readonly prop: T`
 *   - 接口扩展 `interface B extends A`
 *   - 索引签名 `[key: string]: T`：把对象当字典用
 *   - 调用签名（call signature）：用 interface 描述一个函数的形状
 *
 * 题型：每个 interface 都被我清空成 `{}`，你要按括号里的【要求】补全成员。
 *      自检既有类型断言（Expect），也有运行时 assert。
 *
 * 如何自检：运行 `npx tsx 04_interfaces/practice.ts`；
 *   类型题用 `npm run check` 看 _qN 行是否还报错。
 */

import assert from 'node:assert/strict';

type Equal<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;
type Expect<T extends true> = T;

// ------------------------------------------------------------
// 第 1 题：基本接口。
//   要求 User 拥有：id: number；name: string；email 可选 string；createdAt 只读 Date。
// ------------------------------------------------------------
interface User {
  // TODO
}
type _q1 = Expect<
  Equal<User, { id: number; name: string; email?: string; readonly createdAt: Date }>
>;

const alice: User = { id: 1, name: 'Alice', createdAt: new Date(0) };
const bob: User = { id: 2, name: 'Bob', email: 'bob@x.com', createdAt: new Date(0) };

// ------------------------------------------------------------
// 第 2 题：接口扩展。Admin 继承 User 的所有字段，再加一个 role。
//   要求 role: 'admin' | 'super' | 'viewer'
// ------------------------------------------------------------
interface Admin {
  // TODO: 用 extends User 扩展，并加上 role
}
type _q2 = Expect<
  Equal<Admin, { id: number; name: string; email?: string; readonly createdAt: Date; role: 'admin' | 'super' | 'viewer' }>
>;

// ------------------------------------------------------------
// 第 3 题：索引签名。把对象当「键→值」字典用。
//   要求 Counts：任意 string 键都映射到 number。
// ------------------------------------------------------------
interface Counts {
  // TODO: [key: string]: number
}
type _q3 = Expect<Equal<Counts, { [key: string]: number }>>;

const counts: Counts = { a: 1, b: 2 };

// ------------------------------------------------------------
// 第 4 题：调用签名。用 interface 描述「接收 query 字符串、返回 string[]」的函数。
//   提示：写成 `interface SearchFn { (query: string): string[] }`
// ------------------------------------------------------------
interface SearchFn {
  // TODO
}
type _q4 = Expect<Equal<SearchFn, (query: string) => string[]>>;

// ------------------------------------------------------------
// ⚠️ 第 5 题（认识陷阱，非填空）：readonly 是【浅层】的。
//   box.items 不能整体替换，但 box.items 内部的数组仍可 push —— readonly 只锁一层。
// ------------------------------------------------------------
interface Box {
  readonly items: string[];
}
const box: Box = { items: ['a'] };
// box.items = [];        // 取消注释会报错：items 只读
box.items.push('b');      // ⚠️ 但这能通过！数组本身没被冻结

// ============================================================
// ★ 自检区（不要修改本区代码）
// ============================================================
assert.equal(alice.name, 'Alice');
assert.equal(alice.email, undefined);
assert.equal(bob.email, 'bob@x.com');
assert.equal(counts.a, 1);

const search: SearchFn = (q) => [q, q.toUpperCase()];
assert.deepEqual(search('hi'), ['hi', 'HI']);

assert.deepEqual(box.items, ['a', 'b'], 'readonly 浅层：内部数组仍被修改了');

console.log('✅ 练习 04 全部通过：接口定义正确，陷阱也已理解。');

export {};
