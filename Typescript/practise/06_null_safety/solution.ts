/**
 * ============================================================
 * 练习 06 · 参考答案
 * ============================================================
 * 要点回顾：
 *   - a?.b?.c 链式可选：任一环是 null/undefined 就整体得 undefined，不报错
 *   - ?? 只补 null/undefined；|| 会把 0 / '' / false 也当假值替换 —— 选错会出 bug
 *   - x! 是「相信我，不是空」的逃逸口，运行时不做任何检查，少用
 *   - noUncheckedIndexedAccess 下，arr[i] 一定是 T | undefined，必须处理
 */

import assert from 'node:assert/strict';

interface Address {
  city?: string;
}
interface Profile {
  address?: Address;
}
interface Account {
  profile?: Profile;
}

function getCity(user: Account): string | undefined {
  return user.profile?.address?.city;
}

function withDefault(
  value: string | number | null | undefined,
  fallback: string,
): string | number {
  return value ?? fallback;
}

interface ServerConfig {
  port?: number;
}
function portNumber(config: ServerConfig): number {
  return config.port!;
}

function firstOrZero(arr: number[]): number {
  return arr[0] ?? 0;
}

assert.equal(getCity({}), undefined);
assert.equal(getCity({ profile: {} }), undefined);
assert.equal(getCity({ profile: { address: {} } }), undefined);
assert.equal(getCity({ profile: { address: { city: '上海' } } }), '上海');

assert.equal(withDefault(null, 'x'), 'x');
assert.equal(withDefault(undefined, 'x'), 'x');
assert.equal(withDefault(0, 'x'), 0, '⚠️ 0 用 ?? 会保留，用 || 会被替换');
assert.equal(withDefault('', 'x'), '', '⚠️ 空串用 ?? 会保留');
assert.equal(withDefault('hi', 'x'), 'hi');

assert.equal(portNumber({ port: 3000 }), 3000);

assert.equal(firstOrZero([1, 2]), 1);
assert.equal(firstOrZero([]), 0);

console.log('✅ 练习 06 全部通过：可选链、空值合并、非空断言运用正确。');

export {};
