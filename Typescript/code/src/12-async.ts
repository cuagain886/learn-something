/**
 * ============================================================
 * 第 12 课：异步编程（Promise / async-await）
 * ============================================================
 * 本节学什么：
 *   1. Promise<T> 的类型
 *   2. async / await 语法
 *   3. 错误处理（try/catch）与类型
 *   4. 并发：Promise.all / Promise.allSettled / Promise.race
 *   5. Awaited<T> 与异步函数的返回类型推断
 *
 * 运行：  npx tsx src/12-async.ts
 *
 * 给会其他语言的你：
 *   - JS 是单线程 + 事件循环，耗时操作（网络、定时器）用「异步」避免阻塞。
 *   - Promise<T> 表示「一个将来会得到 T 类型结果的承诺」，类似其它语言的 Future/Task。
 *   - async 函数总是返回 Promise；await 会「等待」一个 Promise 完成并取出其结果。
 */

// 一个工具：等待若干毫秒（用 Promise 包裹 setTimeout）。
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------
// 1 & 2. 返回 Promise 的异步函数 + async/await
// ------------------------------------------------------------
interface Post {
  id: number;
  title: string;
}

// 标注返回类型为 Promise<Post>：表示「异步地」给出一个 Post。
async function fetchPost(id: number): Promise<Post> {
  await delay(50); // 模拟网络延迟
  return { id, title: `文章 #${id}` };
}

// ------------------------------------------------------------
// 3. 错误处理：用 try/catch 捕获被 reject 的 Promise
// ------------------------------------------------------------
async function fetchPostSafe(id: number): Promise<Post | null> {
  try {
    if (id < 0) {
      throw new Error('id 不能为负数');
    }
    return await fetchPost(id);
  } catch (err) {
    // 注意：catch 到的 err 类型是 unknown（strict 下），需先收窄再使用。
    if (err instanceof Error) {
      console.log('捕获到错误:', err.message);
    }
    return null;
  }
}

// ------------------------------------------------------------
// 4. 并发处理
// ------------------------------------------------------------
async function demoConcurrency() {
  // Promise.all：全部成功才成功；返回结果数组，类型为 Post[]。
  // 任意一个失败，整体立刻 reject。
  const posts = await Promise.all([fetchPost(1), fetchPost(2), fetchPost(3)]);
  console.log('Promise.all 结果:', posts.map((p) => p.title));

  // Promise.allSettled：等所有 promise 都「落定」，无论成功失败都不抛错。
  // 返回的每一项是 { status: 'fulfilled', value } 或 { status: 'rejected', reason }。
  const settled = await Promise.allSettled([
    fetchPost(10),
    Promise.reject(new Error('坏了')),
  ]);
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      console.log(`allSettled[${i}] 成功:`, r.value.title);
    } else {
      console.log(`allSettled[${i}] 失败:`, (r.reason as Error).message);
    }
  });

  // Promise.race：谁先落定就用谁的结果（这里用来做「超时」）。
  const winner = await Promise.race([
    fetchPost(99),
    delay(1000).then(() => ({ id: -1, title: '超时' }) as Post),
  ]);
  console.log('Promise.race 胜出:', winner.title);
}

// ------------------------------------------------------------
// 5. Awaited<T>：从 Promise 类型里取出最终结果类型
// ------------------------------------------------------------
type FetchReturn = Awaited<ReturnType<typeof fetchPost>>; // Post

// ------------------------------------------------------------
// 顶层执行：用一个自调用 async 函数串起整个演示
// ------------------------------------------------------------
async function main() {
  console.log('=== 第 12 课：异步编程 ===');
  const post = await fetchPost(1);
  console.log('fetchPost(1) =', post);

  const ok = await fetchPostSafe(5);
  const bad = await fetchPostSafe(-1); // 会触发并捕获错误
  console.log('fetchPostSafe 正常 =', ok, '| 异常 =', bad);

  await demoConcurrency();
}

// 启动。catch 兜底，避免「未处理的 Promise 拒绝」警告。
main().catch((e) => console.error(e));

// 让本文件成为独立模块：每个 .ts 文件都有独立作用域，避免与其它课程文件的同名声明在全局冲突。
export {};
