# 07 · 生成器与协程 ⭐⭐⭐

> 生成器是 Python 异步编程的基石——从 `yield` 到 `async/await`，理解这条演进路线就理解了 Python 并发的前世今生。

---

## 1. 生成器的底层机制

### 栈帧挂起与恢复

普通函数执行完就销毁栈帧，生成器函数在 `yield` 处**挂起栈帧**：

```python
def gen():
    print("step 1")
    yield 1          # 挂起，保存局部变量和执行位置
    print("step 2")
    yield 2          # 再次挂起
    print("step 3")  # 最后 next() 执行完毕，抛 StopIteration
```

```
生成器对象内部结构：
┌────────────────────────┐
│ gi_frame               │ ← 栈帧（局部变量、执行位置）
│ gi_code                │ ← 字节码对象
│ gi_yieldfrom           │ ← yield from 的子生成器
│ gi_running             │ ← 是否正在执行
└────────────────────────┘
```

`yield` 的字节码是 `YIELD_VALUE`，它将栈帧暂停而非销毁。`next()` 恢复栈帧继续执行。

---

## 2. yield from：委托与双向通道

`yield from` 不只是语法糖——它建立了**调用者和子生成器之间的直接通道**：

```python
def subgen():
    value = yield "请输入"     # 从外部接收 send() 的值
    return f"子生成器结果: {value}"

def delegator():
    result = yield from subgen()  # 自动转发 next/send/throw/close
    print(result)

g = delegator()
print(next(g))           # "请输入"
try:
    g.send("Hello")      # 直接传给 subgen，不经过 delegator
except StopIteration:
    pass
```

### yield from 自动处理的事情

1. 转发 `next()` 和 `send()` 给子生成器
2. 转发 `throw()` 给子生成器
3. 处理子生成器的 `StopIteration`，将 `return` 值作为 `yield from` 表达式的值
4. 转发 `close()` 给子生成器

---

## 3. 从生成器到协程的演进

```
Python 2.5  yield 表达式 + send()      ← 基于生成器的协程
Python 3.3  yield from                  ← 委托子生成器
Python 3.4  asyncio + @asyncio.coroutine ← 事件循环框架
Python 3.5  async def / await           ← 原生协程语法
Python 3.6+ async for / async with      ← 异步迭代/上下文
```

### 基于生成器的协程（旧式）

```python
import asyncio

@asyncio.coroutine
def old_style():
    yield from asyncio.sleep(1)
    return "done"
```

### 原生协程（新式，⭐推荐）

```python
async def new_style():
    await asyncio.sleep(1)
    return "done"
```

---

## 4. asyncio 事件循环

```python
import asyncio

async def fetch_data(url, delay):
    print(f"开始请求 {url}")
    await asyncio.sleep(delay)      # 非阻塞等待（让出控制权）
    print(f"完成请求 {url}")
    return f"data from {url}"

async def main():
    # 并发执行多个协程
    results = await asyncio.gather(
        fetch_data("api/1", 2),
        fetch_data("api/2", 1),
        fetch_data("api/3", 3),
    )
    # 总耗时约 3 秒（不是 6 秒）——并发执行
    print(results)

asyncio.run(main())
```

### 事件循环的工作原理

```
┌────────────────────────────────────────┐
│              事件循环                    │
│                                        │
│  ┌──────────┐  ┌──────────┐           │
│  │ 协程 A    │  │ 协程 B    │  ...     │
│  │ await I/O │  │ await I/O│          │
│  └─────┬────┘  └─────┬────┘          │
│        │             │                │
│  ┌─────▼─────────────▼────────────┐  │
│  │  I/O 多路复用（select/epoll）    │  │
│  │  监控所有等待中的 I/O            │  │
│  └────────────────────────────────┘  │
└────────────────────────────────────────┘

1. 协程遇到 await（I/O 操作）-> 挂起，让出控制权给事件循环
2. 事件循环检查所有等待中的 I/O
3. I/O 就绪 -> 恢复对应的协程继续执行
```

---

## 5. 异步迭代与异步上下文

```python
# 异步迭代器
class AsyncCounter:
    def __init__(self, n):
        self.n = n
        self.i = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.i >= self.n:
            raise StopAsyncIteration
        await asyncio.sleep(0.1)
        self.i += 1
        return self.i

# async for
async def demo():
    async for i in AsyncCounter(5):
        print(i)

# 异步上下文管理器
class AsyncResource:
    async def __aenter__(self):
        print("acquiring")
        return self

    async def __aexit__(self, *args):
        print("releasing")

# async with
async def demo2():
    async with AsyncResource() as r:
        print("using resource")
```

---

## 6. 与 Go 的对比

| 特性 | Python asyncio | Go goroutine |
|------|---------------|-------------|
| 并发模型 | 协作式（单线程事件循环） | 抢占式（M:N 调度） |
| 调度方式 | await 显式让出 | 运行时自动调度 |
| CPU 并行 | ✗（单线程） | ✓（跨多核） |
| 语法标记 | async/await 传染性 | 透明（go 关键字） |
| 阻塞代价 | 阻塞整个事件循环 | 只阻塞当前 goroutine |
| 生态 | 需要异步版库（aiohttp...） | 标准库天然支持 |

---

## 高频面试题

**Q1：生成器和协程的区别？**
A：生成器用 `yield` 产生值（数据生产者）；协程用 `async def` + `await` 实现异步并发。历史上协程从生成器演化而来，但 3.5+ 是独立的概念。

**Q2：`await` 做了什么？**
A：暂停当前协程的执行，将控制权交还给事件循环。等待的操作完成后，事件循环恢复协程继续执行。

**Q3：asyncio 能利用多核吗？**
A：不能。asyncio 是单线程事件循环。要用多核需要结合 multiprocessing 或 `loop.run_in_executor()`。

**Q4：为什么 `async/await` 有"传染性"？**
A：调用 `async def` 函数必须用 `await`，而 `await` 只能在 `async def` 内部使用。这导致调用链上的所有函数都需要变成 `async`。Go 的 goroutine 没有这个问题。

---

## 一句话总结

生成器通过挂起栈帧实现惰性迭代，asyncio 协程基于事件循环实现单线程 I/O 并发；`await` 让出控制权，事件循环在 I/O 就绪时恢复协程。
