/**
 * ============================================================
 * 练习 04 · 参考答案
 * ============================================================
 * 要点回顾：
 *   - 可选属性 `email?: string` 表示「可能没有」
 *   - 只读属性 `readonly createdAt: Date` 只能在创建时赋值
 *   - `interface B extends A` 继承 A 的全部成员
 *   - 索引签名 `[key: string]: number` 让对象能当字典；⚠️ 它会约束【所有】属性
 *   - 调用签名：`interface Fn { (x: T): U }` 描述函数，等价于 `(x: T) => U`
 *   - readonly 是浅层的：只锁外层引用，内部可变对象照样能改
 */

import assert from 'node:assert/strict';

type Equal<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;
type Expect<T extends true> = T;

interface User {
  id: number;
  name: string;
  email?: string;
  readonly createdAt: Date;
}
type _q1 = Expect<
  Equal<User, { id: number; name: string; email?: string; readonly createdAt: Date }>
>;

const alice: User = { id: 1, name: 'Alice', createdAt: new Date(0) };
const bob: User = { id: 2, name: 'Bob', email: 'bob@x.com', createdAt: new Date(0) };

interface Admin extends User {
  role: 'admin' | 'super' | 'viewer';
}
type _q2 = Expect<
  Equal<
    Admin,
    { id: number; name: string; email?: string; readonly createdAt: Date; role: 'admin' | 'super' | 'viewer' }
  >
>;

interface Counts {
  [key: string]: number;
}
type _q3 = Expect<Equal<Counts, { [key: string]: number }>>;

const counts: Counts = { a: 1, b: 2 };

interface SearchFn {
  (query: string): string[];
}
type _q4 = Expect<Equal<SearchFn, (query: string) => string[]>>;

interface Box {
  readonly items: string[];
}
const box: Box = { items: ['a'] };
box.items.push('b');

assert.equal(alice.name, 'Alice');
assert.equal(alice.email, undefined);
assert.equal(bob.email, 'bob@x.com');
assert.equal(counts.a, 1);

const search: SearchFn = (q) => [q, q.toUpperCase()];
assert.deepEqual(search('hi'), ['hi', 'HI']);

assert.deepEqual(box.items, ['a', 'b']);

console.log('✅ 练习 04 全部通过：接口定义正确，陷阱也已理解。');

export {};
