/**
 * ============================================================
 * 练习 02 · 参考答案
 * ============================================================
 * 核心规律：
 *   - const 字面量 → 最具体的字面量类型（10 / 'hi' / true）
 *   - let / 可变位置 → 拓宽（number / string / boolean）
 *   - 数组 → 元素类型[]（异构 → 联合元素 []），长度不限
 *   - 对象属性 → 拓宽（{ x: number }），即使外层 const
 *   - as const → 全部冻结成只读字面量（对象 readonly，数组变只读元组）
 *   - 函数返回的字面量会拓宽（return n*2 → number，不是具体数字）
 */

type Equal<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;
type Expect<T extends true> = T;

const count = 10;
type _q1 = Expect<Equal<typeof count, 10>>;

let count2 = 10;
type _q2 = Expect<Equal<typeof count2, number>>;

const word = 'hi';
type _q3 = Expect<Equal<typeof word, 'hi'>>;

let word2 = 'hi';
type _q4 = Expect<Equal<typeof word2, string>>;

const arr = [1, 2, 3];
type _q5 = Expect<Equal<typeof arr, number[]>>;

const mixed = [1, 'a', true];
type _q6 = Expect<Equal<typeof mixed, (string | number | boolean)[]>>;

const obj = { x: 1, name: 'Alice' };
type _q7 = Expect<Equal<typeof obj, { x: number; name: string }>>;

const frozen = { x: 1 } as const;
type _q8 = Expect<Equal<typeof frozen, { readonly x: 1 }>>;

const tuple = [1, 'a'] as const;
type _q9 = Expect<Equal<typeof tuple, readonly [1, 'a']>>;

function double(n: number) {
  return n * 2;
}
type _q10 = Expect<Equal<ReturnType<typeof double>, number>>;

console.log('✅ 练习 02 全部通过：推断类型全部预测正确。');

export {};
