/**
 * ============================================================
 * 练习 06 · 空值安全（Null Safety）
 * ============================================================
 * 学习目标：
 *   - 可选属性 `prop?: T` 让属性的类型变成 `T | undefined`
 *   - 可选链 `?.`：安全地深入可能为空的对象，任一层空了就短路成 undefined
 *   - 空值合并 `??`：仅当左侧是 null / undefined 时才用右侧（⚠️ 与 || 不同！）
 *   - 非空断言 `!`：告诉编译器「这里肯定不是空」，⚠️ 只是关检查，运行时仍可能炸
 *   - 数组下标越界：本项目开了 noUncheckedIndexedAccess，arr[i] 类型是 `T | undefined`
 *
 * 题型：运行时题，实现函数体，用上对应的空值操作符。
 * 如何自检：`npx tsx 06_null_safety/practice.ts` 看到 ✅ 即通过。
 */

import assert from 'node:assert/strict';

// ------------------------------------------------------------
// 第 1 题：可选链 ?。
//   user 可能没有 profile，profile 可能没有 address，address 可能没有 city。
//   用 ?. 一路安全地取，任一层缺失都得到 undefined。
// ------------------------------------------------------------
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
  return user?.profile?.address?.city; // TODO: 用 user.profile?.address?.city
}

// ------------------------------------------------------------
// 第 2 题：空值合并 ??。
//   仅当 value 是 null / undefined 时返回 fallback；否则返回 value 本身。
//   ⚠️ 注意：0、''、false 用 ?? 都会【保留】，而用 || 会被当成 falsy 替换掉。
// ------------------------------------------------------------
function withDefault(
  value: string | number | null | undefined,
  fallback: string,
): string | number {
  return value ?? fallback; // TODO: 用 value ?? fallback
}

// ------------------------------------------------------------
// 第 3 题：非空断言 !。
//   config.port 类型是 number | undefined。本题【假设一定有值】，
//   用 `config.port!` 把它断言成 number。
//   ⚠️ 真实代码里要慎用：如果运行时真的是 undefined，程序照样崩。
// ------------------------------------------------------------
interface ServerConfig {
  port?: number;
}
function portNumber(config: ServerConfig): number {
  return config.port!; // TODO: 用 config.port!
}

// ------------------------------------------------------------
// 第 4 题：数组下标可能越界。
//   因为开了 noUncheckedIndexedAccess，arr[0] 的类型是 number | undefined。
//   要求：取第一个元素，若为空（空数组）则返回 0。
// ------------------------------------------------------------
function firstOrZero(arr: number[]): number {
  return arr[0] ?? 0; // TODO: 取 arr[0]，用 ?? 处理 undefined
}

// ============================================================
// ★ 自检区（不要修改本区代码）
// ============================================================
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
