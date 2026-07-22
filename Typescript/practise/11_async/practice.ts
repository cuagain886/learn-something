/**
 * ============================================================
 * 练习 11 · Promise 与 async / await
 * ============================================================
 * 学习目标：
 *   - 给 async 函数标注返回类型 Promise<T>
 *   - 用 await 取出 Promise 里的值
 *   - Promise.all 并行：返回类型是【元组】，顺序和类型都保留
 *   - catch 的错误是 unknown：⚠️ 不能直接当 Error，要先收窄
 *
 * 题型：实现 async 函数体。用顶层 await 做自检。
 * 如何自检：`npx tsx 11_async/practice.ts` 看到 ✅ 即通过。
 */

import assert from 'node:assert/strict';

// ===== 辅助函数（已给出，不要改）=====
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function fetchUser(): Promise<{ id: number; name: string }> {
  return { id: 1, name: 'Alice' };
}
async function fetchOrder(): Promise<{ id: number; total: number }> {
  return { id: 9, total: 99 };
}

// ------------------------------------------------------------
// 第 1 题：async + await。等待 ms 后返回 value。
//   提示：先 `await delay(ms)`，再 return value。
// ------------------------------------------------------------
async function delayValue(value: number, ms: number): Promise<number> {
  return 0; // TODO: 先 `await delay(ms)`，再 `return value`
}

// ------------------------------------------------------------
// 第 2 题：Promise.all 并行。同时取 user 和 order，返回元组 [user, order]。
//   提示：return Promise.all([fetchUser(), fetchOrder()])
//   体会：返回类型自动推断为 Promise<[{id,name}, {id,total}]>，顺序/类型都准。
// ------------------------------------------------------------
async function fetchUserAndOrder(): Promise<
  [{ id: number; name: string }, { id: number; total: number }]
> {
  return [await fetchUser(), await fetchOrder()]; // TODO: 改成 Promise.all 并行
}

// ------------------------------------------------------------
// 第 3 题：错误兜底。p 成功就返回其值，失败就返回 fallback。
//   提示：try { return await p } catch { return fallback }
// ------------------------------------------------------------
async function withFallback<T>(p: Promise<T>, fallback: T): Promise<T> {
  return fallback; // TODO
}

// ------------------------------------------------------------
// 第 4 题：⚠️ catch 的 e 是 unknown。想读 message 必须先收窄。
//   要求：是 Error 就返回 message；否则 String(e)。
// ------------------------------------------------------------
function errMsg(e: unknown): string {
  return ''; // TODO: e instanceof Error ? e.message : String(e)
}

// ============================================================
// ★ 自检区（不要修改本区代码）
// ============================================================
assert.equal(await delayValue(42, 1), 42);

const [user, order] = await fetchUserAndOrder();
assert.equal(user.name, 'Alice');
assert.equal(order.total, 99);

assert.equal(await withFallback(Promise.resolve('ok'), 'fb'), 'ok');
assert.equal(await withFallback(Promise.reject(new Error('x')), 'fb'), 'fb');

assert.equal(errMsg(new Error('boom')), 'boom');
assert.equal(errMsg('plain string'), 'plain string');
assert.equal(errMsg(42), '42');

console.log('✅ 练习 11 全部通过：Promise 与 async/await 运用正确。');

export {};
