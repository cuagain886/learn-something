/**
 * ============================================================
 * 练习 02 · 类型推断（Type Inference）
 * ============================================================
 * 学习目标：
 *   - 理解 TS 在「你不写注解」时会推断出什么类型
 *   - 掌握最常踩的坑：const vs let 的「拓宽（widening）」、数组与对象如何拓宽
 *   - 认识 `as const`：把可变推断「冻结」成只读字面量
 *
 * 题型：每个声明都已写好，请你【预测】TS 推断出的类型，填进 Equal<typeof x, ___>。
 *   我把第二个参数留成了 `unknown`（占位），它一定通不过断言。
 *   你要把 `unknown` 换成你预测的正确类型，让断言成立。
 *
 *   例如：
 *     const n = 10;
 *     type _t = Expect<Equal<typeof n, unknown>>;  // ← 把 unknown 换成 10
 *
 * 如何自检（类型题）：每个 `_qN` 行不再报错即做对。
 */

type Equal<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;
type Expect<T extends true> = T;

// ------------------------------------------------------------
// 第 1 题：const 修饰的字面量，推断成「最具体」的字面量类型。
//   提示：const count = 10 —— 10 这个值永远不变，所以类型是…？
// ------------------------------------------------------------
const count = 10;
type _q1 = Expect<Equal<typeof count, unknown>>;

// 第 2 题：换成 let，值以后可能变，类型会被「拓宽」。
let count2 = 10;
type _q2 = Expect<Equal<typeof count2, unknown>>;

// 第 3、4 题：字符串同理。
const word = 'hi';
type _q3 = Expect<Equal<typeof word, unknown>>;

let word2 = 'hi';
type _q4 = Expect<Equal<typeof word2, unknown>>;

// ------------------------------------------------------------
// 第 5 题：数组元素会被拓宽成「元素类型的数组」，而不是元组。
//   提示：[1, 2, 3] 以后还能 push，所以长度不限 → 类型是？
// ------------------------------------------------------------
const arr = [1, 2, 3];
type _q5 = Expect<Equal<typeof arr, unknown>>;

// 第 6 题：异构数组 → 元素类型取联合。
const mixed = [1, 'a', true];
type _q6 = Expect<Equal<typeof mixed, unknown>>;

// ------------------------------------------------------------
// 第 7 题：对象字面量的【属性】会被拓宽（即使外层是 const）。
//   提示：obj.x 以后还能被赋值成别的数字，所以 x 的类型是？
// ------------------------------------------------------------
const obj = { x: 1, name: 'Alice' };
type _q7 = Expect<Equal<typeof obj, unknown>>;

// 第 8 题：`as const` 把整个对象「冻结」成只读字面量。
const frozen = { x: 1 } as const;
type _q8 = Expect<Equal<typeof frozen, unknown>>;

// 第 9 题：`as const` 作用在数组上 → 得到只读元组（不再是数组）。
const tuple = [1, 'a'] as const;
type _q9 = Expect<Equal<typeof tuple, unknown>>;

// ------------------------------------------------------------
// 第 10 题：函数返回类型也会推断，但字面量会拓宽。
//   提示：n * 2 的结果是数字，但函数返回类型是 number 还是具体值？
//   （ReturnType<typeof double> 取出它的返回类型）
// ------------------------------------------------------------
function double(n: number) {
  return n * 2;
}
type _q10 = Expect<Equal<ReturnType<typeof double>, unknown>>;

// 做完后：运行 `npm run check`，所有 _qN 行不报错即完成。
// 对照答案：见同目录 solution.ts

export {};
