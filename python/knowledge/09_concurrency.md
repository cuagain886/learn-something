# 09 · 并发编程 ⭐⭐⭐

> Python 有三种并发模型：**多线程、多进程、异步协程**。选对模型是关键——用错了不仅没加速，还可能更慢。

---

## 1. 三种并发模型对比

| 模型 | 适用场景 | GIL 影响 | 通信方式 | 开销 |
|------|---------|---------|---------|------|
| threading（多线程） | I/O 密集 | 受限 | 共享内存 | 低 |
| multiprocessing（多进程） | CPU 密集 | 无影响 | 管道/队列 | 高 |
| asyncio（协程） | 高并发 I/O | 不涉及 | 无需通信 | 极低 |

### 选择指南

```
任务类型是什么？
├── CPU 密集型（计算、加密、压缩）
│   └── multiprocessing（或 C 扩展）
├── I/O 密集型（网络请求、文件、数据库）
│   ├── 少量并发（<100）→ threading
│   └── 大量并发（>100）→ asyncio
└── 混合型
    └── multiprocessing + 每个进程内用 asyncio/threading
```

---

## 2. threading 多线程

```python
import threading
import time

def worker(name, delay):
    print(f"  {name} 开始")
    time.sleep(delay)     # I/O 等待期间释放 GIL
    print(f"  {name} 完成")

# 创建并启动线程
threads = []
for i in range(3):
    t = threading.Thread(target=worker, args=(f"线程{i}", 1))
    threads.append(t)
    t.start()

for t in threads:
    t.join()     # 等待所有线程完成
```

### 线程同步

```python
# Lock：互斥锁
lock = threading.Lock()
counter = 0

def increment():
    global counter
    with lock:         # 自动获取和释放锁
        counter += 1   # 临界区

# RLock：可重入锁（同一线程可多次获取）
rlock = threading.RLock()

# Condition：条件变量
cond = threading.Condition()

# Event：事件标志
event = threading.Event()

# Semaphore：信号量
sem = threading.Semaphore(3)   # 最多 3 个线程同时执行
```

### concurrent.futures（⭐推荐的高级接口）

```python
from concurrent.futures import ThreadPoolExecutor, as_completed

def fetch(url):
    import urllib.request
    return urllib.request.urlopen(url).read()

with ThreadPoolExecutor(max_workers=5) as executor:
    futures = {executor.submit(fetch, url): url for url in urls}
    for future in as_completed(futures):
        url = futures[future]
        data = future.result()
        print(f"{url}: {len(data)} bytes")
```

---

## 3. multiprocessing 多进程

```python
from multiprocessing import Process, Pool, Queue
import os

def cpu_task(n):
    return sum(i * i for i in range(n))

# 进程池（最常用）
with Pool(4) as pool:
    results = pool.map(cpu_task, [10**6] * 4)  # 4 个进程并行
    print(f"结果: {results}")

# ProcessPoolExecutor（concurrent.futures 接口）
from concurrent.futures import ProcessPoolExecutor

with ProcessPoolExecutor(max_workers=4) as executor:
    results = list(executor.map(cpu_task, [10**6] * 4))
```

### 进程间通信

```python
# Queue：进程安全队列
queue = Queue()
queue.put("data")
data = queue.get()

# Pipe：双向管道
from multiprocessing import Pipe
parent_conn, child_conn = Pipe()
parent_conn.send("hello")
print(child_conn.recv())

# 共享内存
from multiprocessing import Value, Array
counter = Value('i', 0)    # 共享整数
array = Array('d', [0.0] * 10)  # 共享数组
```

---

## 4. asyncio 异步编程

```python
import asyncio

async def fetch(url, delay):
    print(f"  请求 {url}")
    await asyncio.sleep(delay)
    return f"data from {url}"

async def main():
    # 方式 1：gather 并发
    results = await asyncio.gather(
        fetch("api/1", 1),
        fetch("api/2", 2),
        fetch("api/3", 1),
    )
    print(results)   # 总耗时约 2 秒

    # 方式 2：create_task 更灵活
    task1 = asyncio.create_task(fetch("api/a", 1))
    task2 = asyncio.create_task(fetch("api/b", 2))
    r1 = await task1
    r2 = await task2

    # 方式 3：TaskGroup（Python 3.11+，更安全的错误处理）
    async with asyncio.TaskGroup() as tg:
        t1 = tg.create_task(fetch("api/x", 1))
        t2 = tg.create_task(fetch("api/y", 1))
    print(t1.result(), t2.result())

asyncio.run(main())
```

### asyncio 常用模式

```python
# 限制并发数
sem = asyncio.Semaphore(10)

async def limited_fetch(url):
    async with sem:    # 最多 10 个并发
        return await fetch(url, 1)

# 超时控制
async def with_timeout():
    try:
        result = await asyncio.wait_for(fetch("api/slow", 10), timeout=3)
    except asyncio.TimeoutError:
        print("超时！")

# 队列
async def producer(queue):
    for i in range(5):
        await queue.put(i)
    await queue.put(None)  # 结束信号

async def consumer(queue):
    while True:
        item = await queue.get()
        if item is None:
            break
        print(f"消费: {item}")
```

---

## 5. 常见并发陷阱

### 陷阱 1：GIL 下的"线程安全假象"

```python
# ⚠️ 即使有 GIL，以下代码也不是线程安全的！
counter = 0
def increment():
    global counter
    counter += 1    # 不是原子操作！
    # 字节码：LOAD_GLOBAL -> LOAD_CONST -> BINARY_ADD -> STORE_GLOBAL
    # GIL 可能在任意两条字节码之间释放
```

### 陷阱 2：asyncio 中使用阻塞调用

```python
async def bad():
    time.sleep(5)       # ⚠️ 阻塞整个事件循环！
    # 应该用 await asyncio.sleep(5)
    # 或 await loop.run_in_executor(None, time.sleep, 5)
```

### 陷阱 3：多进程中的共享状态

```python
# ⚠️ 多进程中全局变量是各进程的副本，不共享
count = 0
def increment():
    global count
    count += 1       # 只修改了子进程的副本
# 主进程中 count 仍然是 0
```

---

## 高频面试题

**Q1：Python 多线程能利用多核吗？**
A：CPython 不能（因为 GIL）。但 I/O 密集型任务中多线程仍有效，因为 GIL 在 I/O 等待时释放。

**Q2：threading vs asyncio 怎么选？**
A：少量并发（几十个）用 threading 简单直接；大量并发（数百上千）用 asyncio，开销更低且没有线程安全问题。

**Q3：concurrent.futures 的好处？**
A：统一了线程池和进程池的接口（ThreadPoolExecutor / ProcessPoolExecutor），切换只需改一行代码。

**Q4：asyncio.gather 和 asyncio.TaskGroup 的区别？**
A：`gather` 在一个任务失败时其他任务继续运行；`TaskGroup`（3.11+）在一个任务失败时自动取消其余任务，更安全。

---

## 一句话总结

I/O 密集用 threading/asyncio，CPU 密集用 multiprocessing；asyncio 适合高并发 I/O（单线程事件循环），threading 适合简单场景，multiprocessing 才能真正并行计算。
