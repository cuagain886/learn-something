/**
 * ============================================================
 * 练习 11 · 参考答案
 * ============================================================
 * 要点回顾：
 *   - async 函数返回 Promise<T>；await 把 Promise<T> 解包成 T
 *   - Promise.all([pA, pB]) 的返回是 Promise<[A, B]>，元组顺序与类型都保留
 *   - 并行用 Promise.all，串行用多次 await；这里 fetchUser/fetchOrder 互不依赖，适合并行
 *   - catch 的 e 在 strict 下是 unknown，用 instanceof Error 收窄后再访问 message
 */

import assert from 'node:assert/strict';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function fetchUser(): Promise<{ id: number; name: string }> {
  return { id: 1, name: 'Alice' };
}
async function fetchOrder(): Promise<{ id: number; total: number }> {
  return { id: 9, total: 99 };
}

async function delayValue(value: number, ms: number): Promise<number> {
  await delay(ms);
  return value;
}

async function fetchUserAndOrder(): Promise<
  [{ id: number; name: string }, { id: number; total: number }]
> {
  return Promise.all([fetchUser(), fetchOrder()]);
}

async function withFallback<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

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
