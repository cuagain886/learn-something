/**
 * ============================================================
 * 练习 10 · 参考答案
 * ============================================================
 * 要点回顾：
 *   - Partial<T> = 全字段可选；常见于「合并更新」的 patch 参数
 *   - Pick / Omit 互为反向：挑 vs 去；注意 Omit 并不在运行时删除属性，只是改变类型
 *   - Record<K, V> 等价于手写 { [k in K]: V }，写映射表最省事
 *   - ReturnType / Parameters 让「类型随实现走」，改函数签名时派生类型自动跟着变
 *   - Readonly<T> 把所有键加 readonly（仍是浅层）
 */

import assert from 'node:assert/strict';

type Equal<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;
type Expect<T extends true> = T;

interface Settings {
  theme: string;
  volume: number;
  muted: boolean;
}
function updateSettings(base: Settings, patch: Partial<Settings>): Settings {
  return { ...base, ...patch };
}
const defaults: Settings = { theme: 'light', volume: 50, muted: false };

type User = { id: number; name: string; email: string; password: string };
type UserPublic = Pick<User, 'id' | 'name'>;
type _q2 = Expect<Equal<UserPublic, { id: number; name: string }>>;

type UserSafe = Omit<User, 'password'>;
type _q3 = Expect<Equal<UserSafe, { id: number; name: string; email: string }>>;

type Grade = 'A' | 'B' | 'C';
type ScoreMap = Record<Grade, number>;
type _q4 = Expect<Equal<ScoreMap, { A: number; B: number; C: number }>>;

function makeGreeting(name: string, times: number): string {
  return name.repeat(times);
}
type GreetingResult = ReturnType<typeof makeGreeting>;
type _q5 = Expect<Equal<GreetingResult, string>>;

type GreetingArgs = Parameters<typeof makeGreeting>;
type _q6 = Expect<Equal<GreetingArgs, [name: string, times: number]>>;

type Mutable = { x: number; y: number };
type Frozen = Readonly<Mutable>;
type _q7 = Expect<Equal<Frozen, { readonly x: number; readonly y: number }>>;

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
