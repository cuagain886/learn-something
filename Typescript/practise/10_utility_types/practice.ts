/**
 * ============================================================
 * 练习 10 · 工具类型（Utility Types）
 * ============================================================
 * 学习目标：
 *   - Partial<T>：所有字段变可选 —— 适合「部分更新 / PATCH」
 *   - Pick<T, K>：从 T 里挑出指定的键
 *   - Omit<T, K>：从 T 里去掉指定的键
 *   - Record<K, V>：构造「键集合 K → 值类型 V」的映射表
 *   - ReturnType<F> / Parameters<F>：从已有函数派生返回类型 / 参数元组
 *   - Readonly<T>：所有字段变只读
 *
 * 题型：把每个 `unknown` 占位换成用工具类型表达的正确类型。
 *      第 1 题还带运行时 assert：把 patch 参数改成 Partial 后，下面的调用才编译通过。
 * 如何自检：`npx tsx 10_utility_types/practice.ts` 看到 ✅；类型题看 `npm run check`。
 */

import assert from 'node:assert/strict';

type Equal<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;
type Expect<T extends true> = T;

// ------------------------------------------------------------
// 第 1 题：Partial。patch 是「部分更新」，字段都可选。
//   把 patch 的类型从 Settings 改成 Partial<Settings>，下面的调用才能通过。
// ------------------------------------------------------------
interface Settings {
  theme: string;
  volume: number;
  muted: boolean;
}
function updateSettings(base: Settings, patch: Settings): Settings {
  return { ...base, ...patch };
}
const defaults: Settings = { theme: 'light', volume: 50, muted: false };

// 第 2 题：Pick。挑出 User 的 id 和 name 作为公开视图。
type User = { id: number; name: string; email: string; password: string };
type UserPublic = unknown; // TODO: Pick<User, 'id' | 'name'>
type _q2 = Expect<Equal<UserPublic, { id: number; name: string }>>;

// 第 3 题：Omit。去掉 password。
type UserSafe = unknown; // TODO: Omit<User, 'password'>
type _q3 = Expect<Equal<UserSafe, { id: number; name: string; email: string }>>;

// ------------------------------------------------------------
// 第 4 题：Record。构造 等级 → 分数 的映射表。
// ------------------------------------------------------------
type Grade = 'A' | 'B' | 'C';
type ScoreMap = unknown; // TODO: Record<Grade, number>
type _q4 = Expect<Equal<ScoreMap, { A: number; B: number; C: number }>>;

// 第 5、6 题：ReturnType / Parameters。从已有函数派生类型。
function makeGreeting(name: string, times: number): string {
  return name.repeat(times);
}
type GreetingResult = unknown; // TODO: ReturnType<typeof makeGreeting>
type _q5 = Expect<Equal<GreetingResult, string>>;

type GreetingArgs = unknown; // TODO: Parameters<typeof makeGreeting>
type _q6 = Expect<Equal<GreetingArgs, [name: string, times: number]>>;

// 第 7 题：Readonly。所有字段变只读。
type Mutable = { x: number; y: number };
type Frozen = unknown; // TODO: Readonly<Mutable>
type _q7 = Expect<Equal<Frozen, { readonly x: number; readonly y: number }>>;

// ============================================================
// ★ 自检区（不要修改本区代码）
// ============================================================
assert.deepEqual(updateSettings(defaults, { theme: 'dark' }), {
  theme: 'dark',
  volume: 50,
  muted: false,
});
assert.deepEqual(updateSettings(defaults, { volume: 100, muted: true }), {
  theme: 'light',
  volume: 100,
  muted: true,
});

const scores: ScoreMap = { A: 90, B: 80, C: 70 };
assert.equal(scores.B, 80);

console.log('✅ 练习 10 全部通过：工具类型运用正确。');

export {};
