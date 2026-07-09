# 03 · JavaScript 事件循环（Event Loop）⭐⭐⭐

> 理解事件循环是理解 JavaScript 异步行为的钥匙。每一个被 `setTimeout(fn, 0)` 骗过的人，都该读这篇文章。

---

## 1. 为什么 JS 需要事件循环？

JavaScript 是**单线程**语言（一份代码、一个调用栈）。如果 JS 没有异步机制：

```javascript
// 假设 JS 是同步的...
const data = fetchSync('https://api.example.com/data'); // 假设阻塞 2 秒
console.log(data);  // 程序在这 2 秒内完全卡死，UI 无法响应
```

用户点击按钮 → 无响应；页面动画 → 卡住。单线程 + 同步 = 灾难。

**解决方案**：JS 引擎把 I/O 操作交给浏览器（Web API），自己继续执行下面的代码。等 I/O 完成了，再把回调放进任务队列排队执行。

---

## 2. 事件循环的四大组件

```
┌─────────────────────────────────────────────┐
│              JavaScript Engine              │
│  ┌──────────┐    ┌──────────────────┐      │
│  │ Call     │ ←  │   Memory Heap    │      │
│  │ Stack    │    │  (变量存储)      │      │
│  └────┬─────┘    └──────────────────┘      │
│       │                                     │
└───────┼─────────────────────────────────────┘
        │
   ┌────▼──────────────────────────────────┐
   │           Event Loop                  │
   │  ┌────────────────────────────────┐   │
   │  │  Microtask Queue (微任务队列)   │   │  ← Promise.then/catch/finally
   │  │  [then1] [then2] [then3]       │   │     MutationObserver
   │  └────────────────────────────────┘   │     queueMicrotask()
   │  ┌────────────────────────────────┐   │
   │  │  Macrotask Queue (宏任务队列)   │   │  ← setTimeout/setInterval
   │  │  [timer1] [click] [fetch_done] │   │     I/O, UI rendering
   │  └────────────────────────────────┘   │     setImmediate (Node.js)
   └───────────────────────────────────────┘
```

| 组件 | 说明 | 类比（Java） |
|------|------|-------------|
| **Call Stack** | 当前正在执行的函数栈 | 当前线程的调用栈 |
| **Web APIs** | 浏览器提供的异步能力（定时器、网络、DOM） | JVM 的 I/O 线程池 |
| **Macrotask Queue** | 宏任务队列，每次事件循环取一个 | 主线程任务队列 |
| **Microtask Queue** | 微任务队列，每次事件循环清空全部 | 高优先级任务队列 |

---

## 3. 事件循环的执行流程（最重要的部分）

```
1. 从宏任务队列取一个任务
2. 执行这个任务（调用栈）
3. 执行所有微任务（微任务队列清空）
4. 如果时间允许，渲染更新（UI render）
5. 回到步骤 1
```

**关键规则**：
- **一个事件循环只取一个宏任务**
- **但会清空所有微任务**（微任务中产生的微任务也会在同一轮执行）
- 浏览器渲染发生在微任务清空和下一个宏任务之间

---

## 4. 经典面试题——你能答对吗？

```javascript
console.log('1');

setTimeout(() => console.log('2'), 0);

Promise.resolve()
    .then(() => console.log('3'))
    .then(() => console.log('4'));

console.log('5');

// 输出顺序：1 → 5 → 3 → 4 → 2
```

**解析**：

```
1. console.log('1')          → 同步代码，直接输出 1
2. setTimeout(fn, 0)         → 把 fn 放入宏任务队列
3. Promise.resolve().then()  → 把 then 回调放入微任务队列
4. console.log('5')          → 同步代码，直接输出 5
   --- 同步代码执行完毕，调用栈清空 ---
5. 检查微任务队列 →
   执行 then → 输出 3
   第一个 then 返回的 Promise resolve → 第二个 then 入微任务队列
   清空微任务队列 → 输出 4
   --- 微任务队列清空 ---
6. 从宏任务队列取一个任务 →
   执行 setTimeout 的回调 → 输出 2
```

---

## 5. 宏任务 vs 微任务

| | 宏任务（Macrotask） | 微任务（Microtask） |
|---|---|---|
| **来源** | setTimeout, setInterval, I/O, UI event, postMessage, setImmediate(Node) | Promise.then/catch/finally, MutationObserver, queueMicrotask |
| **执行频率** | 每轮一个 | 每轮全部（直到队列空） |
| **用途** | 延迟执行、节流 | 尽快执行但不阻塞渲染 |

**微任务的实际应用**：

```javascript
// Vue 的 nextTick 就是利用微任务实现的
// React 的批量更新也利用微任务
// 原则：当前宏任务执行完 → 立刻在下一个宏任务之前执行微任务
```

---

## 6. requestAnimationFrame（rAF）

rAF 既不是宏任务也不是微任务。它在**浏览器渲染之前**执行：

```
宏任务 → 微任务 → requestAnimationFrame → 渲染 → 下一个宏任务
```

```javascript
setTimeout(() => {
    console.log('setTimeout');    // 宏任务
    requestAnimationFrame(() => {
        console.log('rAF');       // 渲染前
    });
}, 0);

Promise.resolve().then(() => {
    console.log('Promise');       // 微任务
});

// 输出顺序：Promise → setTimeout → rAF
```

**最佳实践**：动画永远用 `requestAnimationFrame`，不用 `setTimeout` 或 `setInterval`。

---

## 7. Node.js 的事件循环（与浏览器不同的地方）

Node.js 的事件循环有 6 个阶段：

```
   ┌───────────────────────────┐
┌─>│           timers          │   setTimeout / setInterval 回调
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
│  │     pending callbacks     │   延迟到下一轮的 I/O 回调
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
│  │       idle, prepare       │   内部使用
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
│  │           poll            │   获取新的 I/O 事件（阻塞）
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
│  │           check           │   setImmediate 回调
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
└──┤      close callbacks      │   socket.on('close', ...)
   └───────────────────────────┘
```

`process.nextTick()` 和微任务在每个阶段转换时执行（优先级高于微任务）。

---

## 8. 常见坑与最佳实践

### ⚠️ 坑 1：`setTimeout(fn, 0)` 的最小延迟是 4ms

嵌套超过 5 层后，浏览器会将最小延迟强制设为 4ms。如果确实需要 0ms 延迟，用 `Promise.resolve().then(fn)`（微任务）。

### ⚠️ 坑 2：长时间运行的微任务会阻塞渲染

```javascript
// ❌ 这个会永远阻塞渲染！
function loop() {
    Promise.resolve().then(loop);
}
loop();  // 微任务永不结束，宏任务永远得不到执行，页面卡死
```

### ⚠️ 坑 3：不要在循环中使用 await（应并行执行）

```javascript
// ❌ 串行执行（慢）
for (const url of urls) {
    const data = await fetch(url);  // 每个等前一个完成
}

// ✅ 并行执行（快）
const results = await Promise.all(urls.map(url => fetch(url)));
```

---

## 一句话总结

事件循环的核心是**一个循环 + 两种队列**：每轮取一个宏任务，清空所有微任务。理解这个顺序，就理解了 JS 异步行为 90% 的"意外"。
